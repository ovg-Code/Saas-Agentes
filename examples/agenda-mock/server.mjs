// Agenda ficticia de un cliente, sin dependencias:
//   POST /mcp         servidor MCP (Streamable HTTP, JSON-RPC) con tools de calendario
//   POST /pagos/senal API REST (OpenAPI en /openapi.yaml) para cobrar señales
//   GET  /_debug      estado interno para tests
// Uso: AGENDA_TOKEN=agenda-demo-token PORT=9091 node server.mjs
// Con REQUIRE_SESSION=1 se comporta como un servidor MCP antiguo que exige initialize + Mcp-Session-Id.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 9091);
const TOKEN = process.env.AGENDA_TOKEN ?? "agenda-demo-token";
const REQUIRE_SESSION = process.env.REQUIRE_SESSION === "1";
const HOURS = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "16:00", "16:30", "17:00", "17:30"];

const citas = [];
const cobros = [];
const sessions = new Set();
const idem = new Map();

const TOOLS = [
  {
    name: "consultar_disponibilidad",
    description: "Devuelve los huecos libres de un día.",
    inputSchema: {
      type: "object",
      properties: {
        fecha: { type: "string", description: "Día en formato YYYY-MM-DD" },
        servicio: { type: "string", description: "Servicio (opcional)" },
      },
      required: ["fecha"],
    },
  },
  {
    name: "crear_cita",
    description: "Reserva una cita en un hueco libre.",
    inputSchema: {
      type: "object",
      properties: {
        fecha: { type: "string", description: "YYYY-MM-DD" },
        hora: { type: "string", description: "HH:MM" },
        servicio: { type: "string" },
        nombre_cliente: { type: "string" },
        telefono: { type: "string" },
      },
      required: ["fecha", "hora", "servicio", "nombre_cliente"],
    },
  },
  {
    name: "buscar_citas",
    description: "Busca citas futuras por teléfono o nombre del cliente.",
    inputSchema: { type: "object", properties: { telefono: { type: "string" }, nombre: { type: "string" } } },
  },
  {
    name: "cancelar_cita",
    description: "Cancela una cita por su identificador.",
    inputSchema: { type: "object", properties: { id_cita: { type: "string" } }, required: ["id_cita"] },
  },
];

const text = (value, isError = false) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(typeof value === "object" ? { structuredContent: value } : {}),
  ...(isError ? { isError: true } : {}),
});

function callTool(name, args) {
  switch (name) {
    case "consultar_disponibilidad": {
      const taken = new Set(citas.filter((c) => c.fecha === args.fecha && c.estado === "confirmada").map((c) => c.hora));
      return text({ fecha: args.fecha, huecos: HOURS.filter((h) => !taken.has(h)) });
    }
    case "crear_cita": {
      if (!HOURS.includes(args.hora)) return text(`La hora ${args.hora} está fuera del horario.`, true);
      if (citas.some((c) => c.fecha === args.fecha && c.hora === args.hora && c.estado === "confirmada")) {
        return text(`El hueco ${args.fecha} ${args.hora} ya está ocupado.`, true);
      }
      const cita = { id: `C-${citas.length + 1}`, estado: "confirmada", ...args };
      citas.push(cita);
      return text(cita);
    }
    case "buscar_citas":
      return text(citas.filter((c) => (args.telefono && c.telefono === args.telefono) || (args.nombre && c.nombre_cliente?.includes(args.nombre))));
    case "cancelar_cita": {
      const cita = citas.find((c) => c.id === args.id_cita);
      if (!cita) return text(`No existe la cita ${args.id_cita}.`, true);
      cita.estado = "cancelada";
      return text(cita);
    }
    default:
      return null;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

async function readJson(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : {};
}

function handleRpc(msg, req, res) {
  const reply = (result) => send(res, 200, { jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => send(res, 200, { jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });

  if (msg.method === "initialize") {
    const sid = randomUUID();
    sessions.add(sid);
    res.setHeader("mcp-session-id", sid);
    return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "agenda-mock", version: "1.0.0" } });
  }
  if (msg.id === undefined) return send(res, 202);
  if (REQUIRE_SESSION && !sessions.has(req.headers["mcp-session-id"])) {
    return send(res, 400, { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Bad Request: no valid session ID; initialize first" } });
  }
  if (msg.method === "tools/list") return reply({ tools: TOOLS });
  if (msg.method === "tools/call") {
    const key = req.headers["idempotency-key"];
    if (key && idem.has(key)) return reply(idem.get(key));
    const result = callTool(msg.params?.name, msg.params?.arguments ?? {});
    if (!result) return fail(-32602, `tool desconocida: ${msg.params?.name}`);
    if (key) idem.set(key, result);
    return reply(result);
  }
  if (msg.method === "ping") return reply({});
  return fail(-32601, `método no soportado: ${msg.method}`);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/openapi.yaml") {
    res.writeHead(200, { "content-type": "application/yaml" });
    return res.end(readFileSync(new URL("./openapi.yaml", import.meta.url)));
  }
  if (url.pathname === "/_debug") return send(res, 200, { citas, cobros });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: "token inválido" });

  if (req.method === "POST" && url.pathname === "/mcp") return handleRpc(await readJson(req), req, res);
  if (req.method === "POST" && url.pathname === "/pagos/senal") {
    const key = req.headers["idempotency-key"];
    if (key && idem.has(key)) return send(res, 200, idem.get(key)); // un reintento no cobra dos veces
    const body = await readJson(req);
    const cita = citas.find((c) => c.id === body.id_cita);
    if (!cita) return send(res, 404, { error: "cita no encontrada" });
    const cobro = { id: `P-${cobros.length + 1}`, ...body, estado: "cobrado" };
    cobros.push(cobro);
    if (key) idem.set(key, cobro);
    return send(res, 200, cobro);
  }
  send(res, 404, { error: "no encontrado" });
});

server.listen(PORT, () => console.log(`Agenda mock en http://localhost:${PORT} (MCP en /mcp, token ${TOKEN})`));
