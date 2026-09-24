import type { HttpOperation, JsonSchema } from "./types.js";

/**
 * Importador OpenAPI 3.x -> operaciones ejecutables por el agente.
 *
 * Es la pieza que permite enchufar el agente a un CRM/ERP PROPIO del cliente sin escribir
 * un conector: se lee su spec, se aplanan parámetros (path/query/header) + body en un único
 * input_schema (lo que ve el LLM), y se guarda cómo reconstruir la petición HTTP.
 */

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

export class OpenApiError extends Error {}

function resolveRef(doc: Doc, ref: string): JsonSchema {
  if (!ref.startsWith("#/")) throw new OpenApiError(`solo se soportan $ref locales: ${ref}`);
  let cur: unknown = doc;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    cur = (cur as Record<string, unknown>)?.[key];
    if (cur === undefined) throw new OpenApiError(`$ref no encontrado: ${ref}`);
  }
  return cur as JsonSchema;
}

/** Sustituye $ref locales (con protección frente a ciclos) y elimina claves que los LLM no necesitan. */
function deref(doc: Doc, node: unknown, seen: Set<string> = new Set()): unknown {
  if (Array.isArray(node)) return node.map((n) => deref(doc, n, seen));
  if (node === null || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string") {
    if (seen.has(obj.$ref)) return { type: "object", description: `(referencia recursiva a ${obj.$ref})` };
    const next = new Set(seen).add(obj.$ref);
    return deref(doc, resolveRef(doc, obj.$ref), next);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "example" || k === "examples" || k === "xml" || k === "externalDocs") continue;
    out[k] = deref(doc, v, seen);
  }
  // OpenAPI 3.0 `nullable` -> JSON Schema
  if (out.nullable === true && typeof out.type === "string") {
    out.type = [out.type, "null"];
    delete out.nullable;
  }
  return out;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/\{([^}]+)\}/g, "by_$1")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function importOpenApi(doc: Doc): { base_url?: string; title: string; operations: HttpOperation[] } {
  if (typeof doc.openapi !== "string" || !doc.openapi.startsWith("3.")) {
    throw new OpenApiError("se requiere un documento OpenAPI 3.x");
  }
  const operations: HttpOperation[] = [];
  for (const [path, item] of Object.entries<Doc>(doc.paths ?? {})) {
    const shared: Doc[] = item.parameters ?? [];
    for (const method of METHODS) {
      const op: Doc | undefined = item[method];
      if (!op) continue;

      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      const params: HttpOperation["params"] = [];

      for (const rawParam of [...shared, ...(op.parameters ?? [])]) {
        const p = deref(doc, rawParam) as Doc;
        if (p.in === "cookie") continue;
        params.push({ name: p.name, in: p.in, required: Boolean(p.required) || p.in === "path" });
        properties[p.name] = { ...(p.schema ?? { type: "string" }), ...(p.description ? { description: p.description } : {}) };
        if (p.required || p.in === "path") required.push(p.name);
      }

      let hasBody = false;
      const body = op.requestBody ? (deref(doc, op.requestBody) as Doc) : undefined;
      const jsonBody = body?.content?.["application/json"]?.schema;
      if (jsonBody) {
        hasBody = true;
        properties.body = { ...(jsonBody as JsonSchema), description: body?.description ?? "Cuerpo JSON de la petición" };
        if (body?.required) required.push("body");
      }

      const operationId: string = op.operationId ?? `${method}_${slug(path)}`;
      operations.push({
        operationId,
        method: method.toUpperCase() as HttpOperation["method"],
        path,
        summary: [op.summary, op.description].filter(Boolean).join(" — ") || `${method.toUpperCase()} ${path}`,
        input_schema: { type: "object", properties, required, additionalProperties: false },
        params,
        has_body: hasBody,
      });
    }
  }
  return { base_url: doc.servers?.[0]?.url, title: doc.info?.title ?? "API", operations };
}

/** Busca una operación por operationId o por "METHOD /ruta". */
export function findOperation(operations: HttpOperation[], ref: string): HttpOperation | undefined {
  const m = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/i.exec(ref.trim());
  if (m) return operations.find((o) => o.method === m[1]!.toUpperCase() && o.path === m[2]);
  return operations.find((o) => o.operationId === ref);
}
