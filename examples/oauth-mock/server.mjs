// Proveedor OAuth2 simulado, sin dependencias. Imita lo que importa de Google/Microsoft:
//   GET  /authorize   consentimiento automático -> redirige a redirect_uri con ?code&state
//   POST /token       authorization_code (con PKCE S256) y refresh_token (con rotación)
//   POST /introspect  ¿es válido este access token? (lo usa la agenda simulada)
//   POST /_revoke     simula que el usuario retira el permiso (los refresh dejan de valer)
//   GET  /_debug      contadores para tests
// Uso: OAUTH_CLIENT_ID=agentes OAUTH_CLIENT_SECRET=secreto ACCESS_TTL=3600 PORT=9093 node server.mjs
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 9093);
const CLIENT_ID = process.env.OAUTH_CLIENT_ID ?? "agentes-dev";
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET ?? "agentes-dev-secret";
const ACCESS_TTL = Number(process.env.ACCESS_TTL ?? 3600);

const codes = new Map(); // code -> {challenge, redirect_uri, scope}
const access = new Map(); // token -> {exp, scope}
const refresh = new Map(); // token -> {scope}
const stats = { authorizations: 0, exchanges: 0, refreshes: 0, rejected_refreshes: 0 };
const rnd = () => randomBytes(24).toString("base64url");

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function form(req) {
  let raw = "";
  for await (const c of req) raw += c;
  return Object.fromEntries(new URLSearchParams(raw));
}

function issue(scope) {
  const at = rnd();
  const rt = rnd();
  access.set(at, { exp: Date.now() + ACCESS_TTL * 1000, scope });
  refresh.set(rt, { scope });
  return { access_token: at, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: rt, scope };
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/_debug") return json(res, 200, stats);
  if (url.pathname === "/_revoke") {
    refresh.clear();
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/authorize") {
    const q = url.searchParams;
    if (q.get("client_id") !== CLIENT_ID) return json(res, 400, { error: "invalid_client" });
    if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return json(res, 400, { error: "invalid_request", error_description: "PKCE obligatorio" });
    const code = rnd();
    codes.set(code, { challenge: q.get("code_challenge"), redirect_uri: q.get("redirect_uri"), scope: q.get("scope") ?? "" });
    stats.authorizations++;
    const back = new URL(q.get("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", q.get("state") ?? "");
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }

  if (req.method === "POST" && url.pathname === "/token") {
    const f = await form(req);
    if (f.client_id !== CLIENT_ID || f.client_secret !== CLIENT_SECRET) return json(res, 401, { error: "invalid_client" });
    if (f.grant_type === "authorization_code") {
      const c = codes.get(f.code);
      codes.delete(f.code); // un solo uso
      if (!c || c.redirect_uri !== f.redirect_uri) return json(res, 400, { error: "invalid_grant" });
      const challenge = createHash("sha256").update(f.code_verifier ?? "").digest("base64url");
      if (challenge !== c.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE no coincide" });
      stats.exchanges++;
      return json(res, 200, issue(c.scope));
    }
    if (f.grant_type === "refresh_token") {
      const r = refresh.get(f.refresh_token);
      if (!r) {
        stats.rejected_refreshes++;
        return json(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      }
      refresh.delete(f.refresh_token); // rotación
      stats.refreshes++;
      return json(res, 200, issue(r.scope));
    }
    return json(res, 400, { error: "unsupported_grant_type" });
  }

  if (req.method === "POST" && url.pathname === "/introspect") {
    const f = await form(req);
    const t = access.get(f.token);
    return json(res, 200, t && t.exp > Date.now() ? { active: true, scope: t.scope, exp: Math.floor(t.exp / 1000) } : { active: false });
  }
  json(res, 404, { error: "not_found" });
}).listen(PORT, () => console.log(`Proveedor OAuth simulado en http://localhost:${PORT} (client_id ${CLIENT_ID}, TTL ${ACCESS_TTL}s)`));
