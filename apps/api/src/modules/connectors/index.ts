import { type ConnectorCatalog, type DeploymentConnector, importOpenApi, OpenApiError } from "@agentes/agent-spec";
import type pg from "pg";
import { parse as parseYaml } from "yaml";
import { badRequest } from "../../shared/errors.js";
import { authHeaders, listMcpTools, McpDiscoveryError } from "./mcp-client.js";

export { authHeaders, listMcpTools, type McpTool } from "./mcp-client.js";

/**
 * Capa 2: conectores. Un conector OpenAPI se "importa" (spec -> catálogo de operaciones) y se guarda
 * por tenant. Los despliegues posteriores reutilizan el catálogo si no se envía una spec nueva.
 */
export function parseSpec(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return parseYaml(raw) as Record<string, unknown>;
    } catch {
      throw badRequest("la spec OpenAPI no es YAML/JSON válido");
    }
  }
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  throw badRequest("spec OpenAPI vacía");
}

export async function upsertConnector(
  c: pg.PoolClient,
  tenantId: string,
  connector: DeploymentConnector,
  spec: unknown | undefined,
  secret?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectorCatalog> {
  let catalog: ConnectorCatalog | undefined;

  if (connector.type === "mcp") {
    // MCP: se descubren las tools (tools/list) en cada despliegue, así el catálogo refleja el servidor actual.
    if (!connector.url) throw badRequest(`el conector ${connector.id} (mcp) necesita 'url'`);
    try {
      const tools = await listMcpTools(connector.url, authHeaders(connector.auth, secret), fetchImpl);
      catalog = { id: connector.id, type: "mcp", url: connector.url, operations: [], mcp_tools: tools };
    } catch (e) {
      const reason = e instanceof McpDiscoveryError ? e.message : (e as Error).message;
      throw badRequest(`conector ${connector.id}: no se pudieron listar las tools MCP en ${connector.url} (${reason})`);
    }
  } else if (spec !== undefined) {
    let imported;
    try {
      imported = importOpenApi(parseSpec(spec));
    } catch (e) {
      if (e instanceof OpenApiError) throw badRequest(`conector ${connector.id}: ${e.message}`);
      throw e;
    }
    catalog = { id: connector.id, type: "openapi", base_url: imported.base_url, operations: imported.operations };
  }

  if (catalog) {
    await c.query(
      `INSERT INTO connectors (tenant_id, slug, type, source, catalog) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, slug) DO UPDATE SET type = EXCLUDED.type, source = EXCLUDED.source,
         catalog = EXCLUDED.catalog, updated_at = now()`,
      [tenantId, connector.id, connector.type, connector.spec ?? connector.url ?? null, JSON.stringify(catalog)],
    );
    return catalog;
  }
  const { rows } = await c.query("SELECT catalog FROM connectors WHERE slug = $1", [connector.id]);
  if (rows[0]) return rows[0].catalog as ConnectorCatalog;
  throw badRequest(`el conector ${connector.id} no tiene spec y no se había importado antes`);
}
