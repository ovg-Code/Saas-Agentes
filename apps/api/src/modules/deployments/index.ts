import {
  type ConnectorCatalog,
  parseTemplateRef,
  type Release,
  resolveRelease,
  SpecError,
  validateDeployment,
} from "@agentes/agent-spec";
import type pg from "pg";
import { assertTenantAdmin, generateApiKey, type Principal } from "../../shared/auth.js";
import type { Db } from "../../shared/db.js";
import { badRequest, forbidden, notFound } from "../../shared/errors.js";
import { audit } from "../audit/index.js";
import { upsertConnector } from "../connectors/index.js";
import type { RuntimeGateway } from "../conversations/runtime.js";
import type { TemplateCatalog } from "../templates/index.js";
import { Vault } from "../vault/index.js";

export interface DeployRequest {
  /** Capa 3 (cliente.yaml ya parseado). */
  deployment: unknown;
  /** Specs OpenAPI por id de conector (contenido, no rutas: la CLI las lee de disco/URL). */
  connector_specs?: Record<string, unknown>;
  /** Secretos para las credenciales `from_env` (la CLI los lee del entorno). Se cifran y no se devuelven nunca. */
  secrets?: Record<string, string>;
  /** Documentos de conocimiento ya leídos. */
  knowledge?: { source: string; title?: string; text: string }[];
  /** Valida y devuelve el release sin publicar nada. */
  dry_run?: boolean;
}

export interface DeployResponse {
  tenant: { id: string; slug: string; created: boolean };
  agent: { id: string; slug: string; name: string };
  release: { id: string; template: string; changed: boolean; autonomy: string };
  tools: { name: string; tier: string; approval: string; binding: string }[];
  knowledge: { source: string; chunks: number | null; error?: string }[];
  keys: { admin?: string; agent?: string; widget?: string };
  endpoints: { chat: string; mcp: string; widget_snippet: string; console: string };
  dry_run: boolean;
  preview?: Release;
}

class DryRun extends Error {
  constructor(public readonly release: Release) {
    super("dry-run");
  }
}

/**
 * Despliegue en un paso: valida la capa 3, importa conectores, guarda secretos en la bóveda,
 * resuelve el release (capa 4), lo publica, ingesta el conocimiento y emite API keys.
 * Es idempotente: redesplegar el mismo YAML no crea un release nuevo (mismo hash).
 */
export class DeploymentService {
  constructor(
    private readonly db: Db,
    private readonly templates: TemplateCatalog,
    private readonly vault: Vault,
    private readonly runtime: RuntimeGateway,
    private readonly publicBaseUrl: string,
  ) {}

  async deploy(principal: Principal, req: DeployRequest): Promise<DeployResponse> {
    let deployment;
    try {
      deployment = validateDeployment(req.deployment);
    } catch (e) {
      if (e instanceof SpecError) throw badRequest(e.message, e.issues);
      throw e;
    }
    const ref = parseTemplateRef(deployment.template);
    const { template } = this.templates.resolve(ref.id, ref.range);
    const tenant = await this.ensureTenant(principal, deployment.tenant.slug, deployment.tenant.name);
    assertTenantAdmin(principal, tenant.id);

    const keys: DeployResponse["keys"] = {};
    let agent: { id: string; slug: string; name: string };
    let release: Release;
    let changed = false;
    try {
      ({ agent, release, changed } = await this.db.withTenant(tenant.id, async (c) => {
        const agentRow = await c.query(
          `INSERT INTO agents (tenant_id, slug, name) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, slug) DO UPDATE SET name = EXCLUDED.name RETURNING id, slug, name, active_release_id`,
          [tenant.id, deployment.agent.slug, deployment.agent.name ?? template.name],
        );
        const a = agentRow.rows[0];

        // Secretos -> bóveda. Las credenciales `vault:` deben existir ya.
        for (const [name, src] of Object.entries(deployment.credentials ?? {})) {
          if (src.from_env) {
            const secret = req.secrets?.[name];
            if (secret) await this.vault.put(c, tenant.id, name, secret);
          }
        }
        const stored = new Set(await this.vault.names(c));
        const credentialRefs: Record<string, string> = {};
        for (const [name, src] of Object.entries(deployment.credentials ?? {})) {
          const vaultName = src.vault ?? name;
          if (stored.has(vaultName)) credentialRefs[name] = Vault.ref(tenant.slug, vaultName);
        }

        // Conectores (capa 2)
        const catalogs: Record<string, ConnectorCatalog> = {};
        for (const conn of deployment.connectors ?? []) {
          catalogs[conn.id] = await upsertConnector(c, tenant.id, conn, req.connector_specs?.[conn.id]);
        }

        // Capa 4
        let rel: Release;
        try {
          rel = resolveRelease({ template, deployment, catalogs, credentialRefs });
        } catch (e) {
          if (e instanceof SpecError) throw badRequest(e.message, e.issues);
          throw e;
        }
        if (req.dry_run) throw new DryRun(rel);

        const isNew = a.active_release_id !== rel.id;
        await c.query(
          `INSERT INTO releases (id, tenant_id, agent_id, template_id, template_version, deployment, release, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
          [rel.id, tenant.id, a.id, template.id, template.version, JSON.stringify(deployment), JSON.stringify(rel), principal.kind],
        );
        await c.query("UPDATE agents SET active_release_id = $2 WHERE id = $1", [a.id, rel.id]);
        if (isNew) {
          await audit(c, tenant.id, [{
            actor: principal.kind,
            action: "release.published",
            releaseId: rel.id,
            data: { agent: a.slug, template: `${template.id}@${template.version}`, previous: a.active_release_id },
          }]);
        }

        // API keys: se emiten una sola vez (solo se guarda el hash).
        if (tenant.created) keys.admin = await this.issueKey(c, tenant.id, null, "admin");
        const existing = await c.query("SELECT kind FROM api_keys WHERE agent_id = $1 AND revoked_at IS NULL", [a.id]);
        const kinds = new Set(existing.rows.map((r) => r.kind));
        if (!kinds.has("agent")) keys.agent = await this.issueKey(c, tenant.id, a.id, "agent");
        if (!kinds.has("widget")) keys.widget = await this.issueKey(c, tenant.id, a.id, "widget");

        return { agent: { id: a.id, slug: a.slug, name: a.name }, release: rel, changed: isNew };
      }));
    } catch (e) {
      if (e instanceof DryRun) {
        return this.response(tenant, { id: "(dry-run)", slug: deployment.agent.slug, name: e.release.agent.name }, e.release, false, [], {}, true);
      }
      throw e;
    }

    // Conocimiento: fuera de la transacción (llama al runtime). Idempotente por source.
    const knowledge: DeployResponse["knowledge"] = [];
    for (const doc of req.knowledge ?? []) {
      try {
        const r = await this.runtime.ingest({
          tenant_id: tenant.id,
          agent_id: agent.id,
          source: doc.source,
          title: doc.title ?? doc.source,
          text: doc.text,
        });
        knowledge.push({ source: doc.source, chunks: r.chunks });
      } catch (e) {
        knowledge.push({ source: doc.source, chunks: null, error: (e as Error).message });
      }
    }
    return this.response(tenant, agent, release, changed, knowledge, keys, false);
  }

  async listAgents(principal: Principal, tenantId: string) {
    assertTenantAdmin(principal, tenantId);
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query(
        `SELECT a.id, a.slug, a.name, a.active_release_id, r.template_id, r.template_version, r.created_at AS published_at
         FROM agents a LEFT JOIN releases r ON r.id = a.active_release_id ORDER BY a.slug`,
      );
      return rows;
    });
  }

  async listReleases(principal: Principal, tenantId: string, agentId: string) {
    assertTenantAdmin(principal, tenantId);
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query(
        `SELECT r.id, r.template_id, r.template_version, r.created_by, r.created_at, (a.active_release_id = r.id) AS active
         FROM releases r JOIN agents a ON a.id = r.agent_id WHERE r.agent_id = $1 ORDER BY r.created_at DESC`,
        [agentId],
      );
      return rows;
    });
  }

  /** Rollback = volver a activar un release anterior (inmutable). Las conversaciones en curso siguen en el suyo. */
  async activate(principal: Principal, tenantId: string, agentId: string, releaseId: string) {
    assertTenantAdmin(principal, tenantId);
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query("SELECT id FROM releases WHERE id = $1 AND agent_id = $2", [releaseId, agentId]);
      if (!rows[0]) throw notFound("release no encontrado para este agente");
      await c.query("UPDATE agents SET active_release_id = $2 WHERE id = $1", [agentId, releaseId]);
      await audit(c, tenantId, [{ actor: principal.kind, action: "release.activated", releaseId, data: { agent_id: agentId } }]);
      return { agent_id: agentId, active_release_id: releaseId };
    });
  }

  private async ensureTenant(principal: Principal, slug: string, name?: string) {
    const found = await this.db.admin.query("SELECT id, slug FROM tenants WHERE slug = $1", [slug]);
    if (found.rows[0]) return { id: found.rows[0].id as string, slug, created: false };
    if (principal.kind !== "platform") throw forbidden("solo la plataforma puede dar de alta tenants nuevos");
    const ins = await this.db.admin.query("INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id", [slug, name ?? slug]);
    return { id: ins.rows[0].id as string, slug, created: true };
  }

  private async issueKey(c: pg.PoolClient, tenantId: string, agentId: string | null, kind: "admin" | "agent" | "widget") {
    const { key, prefix, hash } = generateApiKey();
    await c.query("INSERT INTO api_keys (tenant_id, agent_id, prefix, hash, kind) VALUES ($1, $2, $3, $4, $5)", [tenantId, agentId, prefix, hash, kind]);
    return key;
  }

  private response(
    tenant: { id: string; slug: string; created: boolean },
    agent: { id: string; slug: string; name: string },
    release: Release,
    changed: boolean,
    knowledge: DeployResponse["knowledge"],
    keys: DeployResponse["keys"],
    dryRun: boolean,
  ): DeployResponse {
    const base = this.publicBaseUrl;
    return {
      tenant,
      agent,
      release: { id: release.id, template: `${release.template.id}@${release.template.version}`, changed, autonomy: release.autonomy },
      tools: release.tools.map((t) => ({
        name: t.name,
        tier: t.tier,
        approval: t.approval,
        binding: t.binding.kind === "http" ? `${t.binding.connector}: ${t.binding.method} ${t.binding.path}` : t.binding.kind === "mcp" ? `${t.binding.connector}: ${t.binding.tool}` : "plataforma",
      })),
      knowledge,
      keys,
      endpoints: {
        chat: `${base}/v1/agents/${agent.id}/chat`,
        mcp: `${base}/v1/agents/${agent.id}/mcp`,
        widget_snippet: `<script src="${base}/widget.js" data-agent="${agent.id}" data-key="${keys.widget ?? "<WIDGET_KEY>"}" async></script>`,
        console: `${base}/console`,
      },
      dry_run: dryRun,
      ...(dryRun ? { preview: release } : {}),
    };
  }
}

