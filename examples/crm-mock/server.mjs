// CRM ficticio "propio de un cliente": API REST + OpenAPI, sin dependencias.
// Uso: CRM_API_KEY=secreto PORT=9090 node server.mjs
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 9090);
const API_KEY = process.env.CRM_API_KEY ?? "crm-demo-key";

const clientes = [
  { id: "c1", nombre: "Ana Pérez", email: "ana@example.com", telefono: "+34600111222" },
  { id: "c2", nombre: "Luis García", email: "luis@example.com", telefono: "+34600333444" },
];
const pedidos = {
  "1001": { numero: "1001", cliente: "c1", estado: "en reparto", entrega_estimada: "mañana", total: 59.9 },
  "1002": { numero: "1002", cliente: "c2", estado: "entregado", entrega_estimada: null, total: 120 },
};
const tickets = [];
const reembolsos = [];
const idempotency = new Map();

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/openapi.yaml") {
    res.writeHead(200, { "content-type": "application/yaml" });
    return res.end(readFileSync(new URL("./openapi.yaml", import.meta.url)));
  }
  if (url.pathname === "/_debug") return send(res, 200, { tickets, reembolsos });
  if (req.headers["x-api-key"] !== API_KEY) return send(res, 401, { error: "API key inválida" });

  // Idempotencia: el runtime envía Idempotency-Key en escrituras; un reintento no duplica.
  const idem = req.headers["idempotency-key"];
  if (req.method !== "GET" && idem && idempotency.has(idem)) return send(res, 200, idempotency.get(idem));
  const remember = (status, body) => {
    if (req.method !== "GET" && idem) idempotency.set(idem, body);
    send(res, status, body);
  };

  if (req.method === "GET" && url.pathname === "/clientes") {
    const email = url.searchParams.get("email");
    const tel = url.searchParams.get("telefono");
    return send(res, 200, clientes.filter((c) => (email && c.email === email) || (tel && c.telefono === tel)));
  }
  let m = /^\/pedidos\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && m) {
    const p = pedidos[decodeURIComponent(m[1])];
    return p ? send(res, 200, p) : send(res, 404, { error: "pedido no encontrado" });
  }
  m = /^\/pedidos\/([^/]+)\/reembolso$/.exec(url.pathname);
  if (req.method === "POST" && m) {
    const body = await readBody(req);
    const r = { id: `r${reembolsos.length + 1}`, pedido: m[1], ...body };
    reembolsos.push(r);
    return remember(200, r);
  }
  if (req.method === "POST" && url.pathname === "/tickets") {
    const body = await readBody(req);
    if (!body.asunto || !body.descripcion) return send(res, 400, { error: "asunto y descripcion son obligatorios" });
    const t = { id: `T-${tickets.length + 1}`, estado: "abierto", ...body };
    tickets.push(t);
    return remember(201, t);
  }
  send(res, 404, { error: "no encontrado" });
});

server.listen(PORT, () => console.log(`CRM mock en http://localhost:${PORT} (API key: ${API_KEY})`));
