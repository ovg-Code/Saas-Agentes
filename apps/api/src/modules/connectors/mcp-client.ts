import type { ConnectorAuth, JsonSchema } from "@agentes/agent-spec";

/**
 * Cliente MCP mínimo para DESCUBRIR las tools de un servidor al desplegar (tools/list).
 * Streamable HTTP + JSON-RPC. Primero sin estado (spec 2026-07-28); si el servidor exige sesión
 * (specs anteriores), hace initialize y reintenta con Mcp-Session-Id. Acepta respuestas JSON o SSE.
 * La ejecución de tools la hace el runtime (services/runtime/agentes_runtime/tools/mcp_client.py).
 */
export interface McpTool {
  name: string;
  description?: string;
  input_schema: JsonSchema;
}

export class McpDiscoveryError extends Error {}

const PROTOCOL_VERSION = "2025-06-18";
let nextId = 1;

export function authHeaders(auth: ConnectorAuth | undefined, secret: string | undefined): Record<string, string> {
  if (!auth || auth.type === "none" || !secret) return {};
  if (auth.type === "api_key") return { [auth.header ?? "X-API-Key"]: secret };
  if (auth.type === "bearer") return { authorization: `Bearer ${secret}` };
  return { authorization: `Basic ${Buffer.from(secret).toString("base64")}` };
}

async function parse(r: Response): Promise<{ result?: Record<string, unknown>; error?: { message?: string } }> {
  const text = await r.text();
  if ((r.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const msg = JSON.parse(line.slice(5).trim());
      if ("result" in msg || "error" in msg) return msg;
    }
    throw new McpDiscoveryError("respuesta SSE sin resultado");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new McpDiscoveryError(`respuesta no JSON (HTTP ${r.status}): ${text.slice(0, 200)}`);
  }
}

export async function listMcpTools(url: string, extraHeaders: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<McpTool[]> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": PROTOCOL_VERSION,
    ...extraHeaders,
  };
  const rpc = (method: string, params: Record<string, unknown> | undefined, h = headers) =>
    fetchImpl(url, {
      method: "POST",
      headers: { ...h, "mcp-method": method },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });

  const tools: McpTool[] = [];
  let cursor: string | undefined;
  let initialized = false;
  do {
    let r = await rpc("tools/list", cursor ? { cursor } : undefined);
    if (!initialized && (r.status === 400 || r.status === 404)) {
      const body = await r.clone().text();
      if (/session|initializ/i.test(body)) {
        const init = await rpc("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "agentes-control-plane", version: "0.1.0" },
        });
        if (!init.ok) throw new McpDiscoveryError(`initialize falló: HTTP ${init.status}`);
        const sid = init.headers.get("mcp-session-id");
        if (sid) headers["mcp-session-id"] = sid;
        await fetchImpl(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
        initialized = true;
        r = await rpc("tools/list", cursor ? { cursor } : undefined);
      }
    }
    if (r.status === 401 || r.status === 403) throw new McpDiscoveryError(`el servidor MCP rechazó las credenciales (HTTP ${r.status})`);
    if (!r.ok) throw new McpDiscoveryError(`HTTP ${r.status}`);
    const msg = await parse(r);
    if (msg.error) throw new McpDiscoveryError(msg.error.message ?? "error MCP");
    const page = (msg.result?.tools ?? []) as { name: string; description?: string; inputSchema?: JsonSchema }[];
    for (const t of page) tools.push({ name: t.name, description: t.description, input_schema: t.inputSchema ?? { type: "object", properties: {} } });
    cursor = msg.result?.nextCursor as string | undefined;
  } while (cursor);
  return tools;
}
