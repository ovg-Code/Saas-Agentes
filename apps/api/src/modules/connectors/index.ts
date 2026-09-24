import { type ConnectorCatalog, type DeploymentConnector, importOpenApi, OpenApiError } from "@agentes/agent-spec";
import type pg from "pg";
import { parse as parseYaml } from "yaml";
import { badRequest } from "../../shared/errors.js";

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
): Promise<ConnectorCatalog> {
  if (spec !== undefined) {
    if (connector.type !== "openapi") throw badRequest(`el conector ${connector.id} no es openapi`);
    let imported;
    try {
      imported = importOpenApi(parseSpec(spec));
    } catch (e) {
      if (e instanceof OpenApiError) throw badRequest(`conector ${connector.id}: ${e.message}`);
      throw e;
    }
    const catalog: ConnectorCatalog = {
      id: connector.id,
      type: "openapi",
      base_url: imported.base_url,
      operations: imported.operations,
    };
    await c.query(
      `INSERT INTO connectors (tenant_id, slug, type, source, catalog) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, slug) DO UPDATE SET type = EXCLUDED.type, source = EXCLUDED.source,
         catalog = EXCLUDED.catalog, updated_at = now()`,
      [tenantId, connector.id, connector.type, connector.spec ?? null, JSON.stringify(catalog)],
    );
    return catalog;
  }
  const { rows } = await c.query("SELECT catalog FROM connectors WHERE slug = $1", [connector.id]);
  if (rows[0]) return rows[0].catalog as ConnectorCatalog;
  if (connector.type === "mcp") {
    // Catálogo MCP vacío: se rellenará con tools/list (hoy lo aporta el despliegue en connector_catalogs).
    return { id: connector.id, type: "mcp", url: connector.url, operations: [], mcp_tools: [] };
  }
  throw badRequest(`el conector ${connector.id} no tiene spec y no se había importado antes`);
}
