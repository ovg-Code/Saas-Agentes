// Simulador de la Graph API de WhatsApp Cloud (solo lo que usa la plataforma), sin dependencias.
//   POST /:phoneNumberId/messages   registra el envío (texto o plantilla) y responde como Meta
//   GET  /_debug                    mensajes enviados, para tests
//   POST /_reset                    limpia
// Uso: WA_ACCESS_TOKEN=wa-demo-token PORT=9092 node server.mjs
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 9092);
const TOKEN = process.env.WA_ACCESS_TOKEN ?? "wa-demo-token";
let sent = [];

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/_debug") return send(res, 200, { sent });
  if (url.pathname === "/_reset") {
    sent = [];
    return send(res, 200, { ok: true });
  }
  const m = /^\/([^/]+)\/messages$/.exec(url.pathname);
  if (req.method !== "POST" || !m) return send(res, 404, { error: { message: "Unsupported request" } });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(res, 401, { error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190 } });
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (body.messaging_product !== "whatsapp" || !body.to) return send(res, 400, { error: { message: "(#100) Invalid parameter" } });
  const id = `wamid.out.${sent.length + 1}`;
  sent.push({ id, phone_number_id: m[1], ...body });
  send(res, 200, { messaging_product: "whatsapp", contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id }] });
}).listen(PORT, () => console.log(`Simulador WhatsApp Graph API en http://localhost:${PORT}`));
