import type { Principal } from "../../shared/auth.js";
import type { ConversationService } from "../conversations/index.js";

/**
 * Cada agente es también un SERVIDOR MCP: el Claude/ChatGPT/IDE/CRM del cliente puede usarlo como tool.
 * Implementación sin estado (encaja con la spec MCP 2026-07-28 y funciona con clientes anteriores:
 * responde a `initialize` pero no exige sesión).
 */
const SUPPORTED_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];

interface JsonRpc {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const ok = (id: JsonRpc["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const err = (id: JsonRpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function handleMcp(
  conversations: ConversationService,
  principal: Principal,
  agent: { id: string; name: string },
  msg: JsonRpc,
): Promise<object | null> {
  if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") return err(null, -32600, "petición JSON-RPC inválida");
  if (msg.id === undefined) return null; // notificación (p.ej. notifications/initialized)

  switch (msg.method) {
    case "initialize": {
      const requested = String(msg.params?.protocolVersion ?? "");
      return ok(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `agente-${agent.name}`, version: "1.0.0" },
        instructions: `Agente "${agent.name}". Usa la tool 'preguntar' para enviarle mensajes; reutiliza conversation_id para continuar.`,
      });
    }
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, {
        tools: [
          {
            name: "preguntar",
            title: `Preguntar a ${agent.name}`,
            description: `Envía un mensaje al agente "${agent.name}" y devuelve su respuesta. Puede consultar los sistemas de la empresa y pedir aprobación humana para acciones sensibles.`,
            inputSchema: {
              type: "object",
              properties: {
                message: { type: "string", description: "Mensaje para el agente" },
                conversation_id: { type: "string", description: "Para continuar una conversación previa" },
              },
              required: ["message"],
            },
          },
        ],
      });
    case "tools/call": {
      const name = msg.params?.name;
      const args = (msg.params?.arguments ?? {}) as { message?: string; conversation_id?: string };
      if (name !== "preguntar") return err(msg.id, -32602, `tool desconocida: ${String(name)}`);
      if (!args.message) return ok(msg.id, { isError: true, content: [{ type: "text", text: "Falta 'message'." }] });
      try {
        const r = await conversations.sendMessage(principal, agent.id, {
          message: args.message,
          ...(args.conversation_id ? { conversation_id: args.conversation_id } : {}),
          channel: "mcp",
        });
        const note =
          r.status === "awaiting_approval" ? "\n\n(Acción pendiente de aprobación humana.)" : r.status === "handoff" ? "\n\n(Conversación transferida a una persona.)" : "";
        return ok(msg.id, {
          content: [{ type: "text", text: `${r.reply}${note}` }],
          structuredContent: { conversation_id: r.conversation_id, status: r.status, approvals: r.approvals.length },
        });
      } catch (e) {
        return ok(msg.id, { isError: true, content: [{ type: "text", text: (e as Error).message }] });
      }
    }
    default:
      return err(msg.id, -32601, `método no soportado: ${msg.method}`);
  }
}
