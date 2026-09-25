import semver from "semver";
import { BUILTIN_CAPABILITIES, isBuiltin } from "./builtins.js";
import { canonicalJson, sha256 } from "./hash.js";
import { findOperation } from "./openapi.js";
import { autonomyRank, effectiveApproval, mergeApproval } from "./policy.js";
import { render, RenderError } from "./render.js";
import type {
  AgentTemplate,
  CapabilitySpec,
  ChannelKind,
  ConnectorCatalog,
  Deployment,
  Release,
  ReleaseConnector,
  ReleaseTool,
} from "./types.js";
import { type Issue, SpecError, validateParams } from "./validate.js";

export interface ResolveInput {
  template: AgentTemplate;
  deployment: Deployment;
  /** Catálogos de los conectores del despliegue, ya importados (OpenAPI parseado / tools MCP listadas). */
  catalogs: Record<string, ConnectorCatalog>;
  /** Nombre de credencial en el despliegue -> referencia en la bóveda. */
  credentialRefs: Record<string, string>;
}

const DEFAULT_MODEL = { alias: "agente-default", max_tokens: 4096 };
const DEFAULT_CHANNELS: ChannelKind[] = ["widget", "api", "mcp"];

export function parseTemplateRef(ref: string): { id: string; range: string } {
  const at = ref.indexOf("@");
  return { id: ref.slice(0, at), range: ref.slice(at + 1) };
}

export function toolName(capability: string): string {
  return capability.replace(/\./g, "__");
}

/**
 * Capa 1 + Capa 2 + Capa 3 -> Capa 4 (release inmutable).
 *
 * Función pura: no hace IO. Acumula TODOS los problemas antes de fallar, para que quien
 * despliega vea de una vez qué falta (parámetros, bindings, credenciales...).
 */
export function resolveRelease({ template, deployment, catalogs, credentialRefs }: ResolveInput): Release {
  const issues: Issue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  // --- plantilla y versión ---
  const ref = parseTemplateRef(deployment.template);
  if (ref.id !== template.id) add("/template", `el despliegue pide '${ref.id}' pero se resolvió '${template.id}'`);
  if (!semver.satisfies(template.version, ref.range)) {
    add("/template", `la versión ${template.version} no cumple el rango '${ref.range}'`);
  }

  // --- parámetros (con defaults) ---
  const { value: params, issues: paramIssues } = validateParams(template.parameters, deployment.params);
  issues.push(...paramIssues);

  // --- autonomía, limitada por la plantilla ---
  const autonomy = deployment.autonomy ?? template.autonomy.default;
  if (autonomyRank(autonomy) > autonomyRank(template.autonomy.max)) {
    add("/autonomy", `la plantilla permite como máximo ${template.autonomy.max}; se pidió ${autonomy}`);
  }

  // --- capacidades -> tools ---
  const declared: Record<string, CapabilitySpec & { required: boolean }> = {};
  for (const [name, spec] of Object.entries(template.capabilities.required ?? {})) declared[name] = { ...spec, required: true };
  for (const [name, spec] of Object.entries(template.capabilities.optional ?? {})) declared[name] = { ...spec, required: false };

  const bindings = deployment.bindings ?? {};
  for (const cap of Object.keys(bindings)) {
    if (!declared[cap]) add(`/bindings/${cap}`, "la plantilla no declara esta capacidad");
  }
  for (const cap of Object.keys(deployment.overrides?.capabilities ?? {})) {
    if (!declared[cap]) add(`/overrides/capabilities/${cap}`, "la plantilla no declara esta capacidad");
  }

  const depConnectors = new Map((deployment.connectors ?? []).map((c) => [c.id, c]));
  const usedConnectors = new Set<string>();
  const tools: ReleaseTool[] = [];

  for (const [cap, spec] of Object.entries(declared)) {
    const binding = bindings[cap] ?? (isBuiltin(cap) ? { connector: "builtin" } : undefined);
    if (!binding) {
      if (spec.required) add(`/bindings/${cap}`, "capacidad obligatoria sin conector asignado");
      continue;
    }

    const merged = mergeApproval(spec.approval ?? "policy", spec.locked ?? false, deployment.overrides?.capabilities?.[cap]?.approval);
    if (merged.rejected) add(`/overrides/capabilities/${cap}`, merged.rejected);
    const base = {
      name: toolName(cap),
      capability: cap,
      tier: spec.tier,
      approval: effectiveApproval(spec.tier, merged.value, autonomy),
    };

    if (binding.connector === "builtin") {
      const builtin = BUILTIN_CAPABILITIES[cap];
      if (!builtin) {
        add(`/bindings/${cap}`, "no existe una implementación builtin para esta capacidad");
        continue;
      }
      tools.push({ ...base, description: spec.description, input_schema: builtin.input_schema, binding: { kind: "builtin", name: cap } });
      continue;
    }

    const connector = depConnectors.get(binding.connector);
    const catalog = catalogs[binding.connector];
    if (!connector || !catalog) {
      add(`/bindings/${cap}`, `conector '${binding.connector}' no definido o no importado`);
      continue;
    }
    usedConnectors.add(connector.id);
    if (!binding.operation) {
      add(`/bindings/${cap}`, "falta 'operation'");
      continue;
    }

    if (connector.type === "openapi") {
      const op = findOperation(catalog.operations, binding.operation);
      if (!op) {
        add(`/bindings/${cap}`, `operación '${binding.operation}' no existe en '${connector.id}'`);
        continue;
      }
      tools.push({
        ...base,
        description: `${spec.description}\n(Sistema: ${connector.id} — ${op.summary})`,
        input_schema: op.input_schema,
        binding: { kind: "http", connector: connector.id, method: op.method, path: op.path, params: op.params, has_body: op.has_body },
      });
    } else {
      const mcpTool = catalog.mcp_tools?.find((t) => t.name === binding.operation);
      if (!mcpTool) {
        add(`/bindings/${cap}`, `tool MCP '${binding.operation}' no existe en '${connector.id}'`);
        continue;
      }
      tools.push({
        ...base,
        description: `${spec.description}\n(Sistema: ${connector.id} — ${mcpTool.description ?? mcpTool.name})`,
        input_schema: mcpTool.input_schema,
        binding: { kind: "mcp", connector: connector.id, tool: mcpTool.name },
      });
    }
  }

  // --- conectores (sin secretos: solo referencias a la bóveda) ---
  const connectors: Record<string, ReleaseConnector> = {};
  for (const id of usedConnectors) {
    const c = depConnectors.get(id)!;
    const auth = c.auth ?? { type: "none" as const };
    let credential_ref: string | undefined;
    if (auth.type !== "none") {
      if (!auth.credential) add(`/connectors/${id}/auth`, "falta 'credential'");
      else if (!credentialRefs[auth.credential]) add(`/connectors/${id}/auth`, `credencial '${auth.credential}' no disponible en la bóveda`);
      else credential_ref = credentialRefs[auth.credential];
    }
    connectors[id] = {
      type: c.type,
      ...(c.type === "openapi" ? { base_url: c.base_url ?? catalogs[id]?.base_url } : { url: c.url }),
      auth: { type: auth.type, ...(auth.header ? { header: auth.header } : {}), ...(credential_ref ? { credential_ref } : {}) },
    };
    if (c.type === "openapi" && !connectors[id]!.base_url) add(`/connectors/${id}`, "falta base_url (y el OpenAPI no declara servers)");
  }

  // --- guardrails: el cliente solo puede endurecer ---
  const tg = template.guardrails ?? {};
  const og = deployment.overrides?.guardrails ?? {};
  const maxSteps = tg.max_steps_per_turn ?? 8;
  if (og.max_steps_per_turn !== undefined && og.max_steps_per_turn > maxSteps) {
    add("/overrides/guardrails/max_steps_per_turn", `no puede superar ${maxSteps}`);
  }
  if (tg.untrusted_input !== false && og.untrusted_input === false) {
    add("/overrides/guardrails/untrusted_input", "la plantilla exige tratar la entrada como no confiable");
  }
  const guardrails: Release["guardrails"] = {
    max_steps_per_turn: Math.min(og.max_steps_per_turn ?? maxSteps, maxSteps),
    blocked_topics: [...new Set([...(tg.blocked_topics ?? []), ...(og.blocked_topics ?? [])])],
    untrusted_input: tg.untrusted_input ?? true,
  };
  const cost = og.max_cost_usd_per_conversation ?? tg.max_cost_usd_per_conversation;
  if (cost !== undefined) guardrails.max_cost_usd_per_conversation = cost;

  // --- canales ---
  const allowedChannels = template.channels ?? DEFAULT_CHANNELS;
  const channels = deployment.channels ?? allowedChannels.filter((c) => DEFAULT_CHANNELS.includes(c));
  for (const ch of channels) if (!allowedChannels.includes(ch)) add("/channels", `la plantilla no soporta el canal '${ch}'`);

  // --- configuración de canales (solo referencias a la bóveda) ---
  const channelSettings: Release["channel_settings"] = {};
  if (channels.includes("whatsapp")) {
    const wa = deployment.channel_settings?.whatsapp;
    if (!wa) {
      add("/channel_settings/whatsapp", "el canal whatsapp necesita phone_number_id y credenciales");
    } else {
      const refOf = (field: keyof typeof wa.credentials) => {
        const name = wa.credentials[field];
        const ref = credentialRefs[name];
        if (!ref) add(`/channel_settings/whatsapp/credentials/${field}`, `credencial '${name}' no disponible en la bóveda`);
        return ref ?? "";
      };
      channelSettings.whatsapp = {
        phone_number_id: wa.phone_number_id,
        access_token_ref: refOf("access_token"),
        app_secret_ref: refOf("app_secret"),
        verify_token_ref: refOf("verify_token"),
        ...(wa.reengagement_template ? { reengagement_template: wa.reengagement_template } : {}),
      };
    }
  }

  // --- conocimiento ---
  const knowledgeSources = (deployment.knowledge ?? []).map((k) => k.source);
  if (template.knowledge?.required && knowledgeSources.length === 0) {
    add("/knowledge", `la plantilla necesita conocimiento: ${template.knowledge.description ?? "sube al menos un documento"}`);
  }

  // --- webhooks ---
  const webhooks = (deployment.webhooks ?? []).map((w) => {
    if (w.secret && !credentialRefs[w.secret]) add("/webhooks", `credencial '${w.secret}' no disponible en la bóveda`);
    return { url: w.url, events: w.events, ...(w.secret && credentialRefs[w.secret] ? { secret_ref: credentialRefs[w.secret] } : {}) };
  });

  // --- render de instrucciones/procedimientos (solo si los parámetros son válidos) ---
  let instructions = "";
  let procedures: Release["procedures"] = [];
  if (paramIssues.length === 0) {
    const renderSafe = (text: string, path: string) => {
      try {
        return render(text, params);
      } catch (e) {
        if (e instanceof RenderError) add(path, e.message);
        else throw e;
        return "";
      }
    };
    instructions = renderSafe(template.instructions, "/instructions");
    procedures = (template.procedures ?? []).map((p, i) => ({
      id: p.id,
      title: p.title ?? p.id,
      when: renderSafe(p.when, `/procedures/${i}/when`),
      content: renderSafe(p.content ?? "", `/procedures/${i}/content`),
    }));
  }

  if (issues.length > 0) throw new SpecError("despliegue", issues);

  const body: Omit<Release, "id"> = {
    schema_version: 1,
    tenant: { slug: deployment.tenant.slug, ...(deployment.tenant.name ? { name: deployment.tenant.name } : {}) },
    agent: { slug: deployment.agent.slug, name: deployment.agent.name ?? template.name },
    template: { id: template.id, version: template.version },
    autonomy,
    model: { ...DEFAULT_MODEL, ...template.model, ...deployment.overrides?.model },
    instructions,
    procedures,
    tools: tools.sort((a, b) => a.name.localeCompare(b.name)),
    connectors,
    guardrails,
    channels,
    params,
    knowledge_sources: knowledgeSources,
    webhooks,
    ...(Object.keys(channelSettings).length ? { channel_settings: channelSettings } : {}),
  };
  return { id: `rel_${sha256(canonicalJson(body)).slice(0, 16)}`, ...body };
}
