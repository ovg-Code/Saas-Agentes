import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type pg from "pg";
import { parse as parseYaml } from "yaml";
import type { Db } from "../../shared/db.js";
import { badRequest, conflict, HttpError, notFound } from "../../shared/errors.js";
import { audit } from "../audit/index.js";
import type { Vault } from "../vault/index.js";

/**
 * Conexiones OAuth2 por tenant: el cliente AUTORIZA con su cuenta (Google, Microsoft, HubSpot...) y la
 * plataforma guarda y renueva los tokens. Fuera de este módulo nadie ve un refresh token: se pide
 * `resolveSecret()` y se obtiene un access token vigente.
 *
 *  connect  -> enlace compartible /v1/oauth/start/<state> (sin API key: el state es el secreto, 1 uso, 30 min)
 *  start    -> redirección al proveedor con PKCE S256
 *  callback -> canje del código, tokens cifrados en la bóveda (kind=oauth)
 *  resolve  -> renovación automática con bloqueo de fila (dos turnos simultáneos no renuevan dos veces)
 */

export interface OAuthProvider {
  id: string;
  name: string;
  authorize_url: string;
  token_url: string;
  default_scopes: string[];
  authorize_params?: Record<string, string>;
  client_id?: string;
  client_secret?: string;
}

interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at: number | null; // epoch ms
  provider: string;
  scopes: string[];
}

const STATE_TTL_MS = 30 * 60 * 1000;
const REFRESH_MARGIN_MS = 60 * 1000;

function expandEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => env[name] ?? def ?? "");
}

export function loadProviders(file: string, env: NodeJS.ProcessEnv = process.env): Record<string, OAuthProvider> {
  if (!existsSync(file)) return {};
  const doc = parseYaml(expandEnv(readFileSync(file, "utf8"), env)) as { providers?: Record<string, Omit<OAuthProvider, "id">> };
  const out: Record<string, OAuthProvider> = {};
  for (const [id, p] of Object.entries(doc.providers ?? {})) {
    const key = id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    out[id] = { ...p, id, client_id: env[`OAUTH_${key}_CLIENT_ID`], client_secret: env[`OAUTH_${key}_CLIENT_SECRET`] };
  }
  return out;
}

export class OAuthReconnectRequired extends HttpError {
  constructor(credential: string, provider: string) {
    super(424, `la conexión '${credential}' con ${provider} fue revocada o caducó: el cliente debe volver a autorizar`);
  }
}

export class OAuthService {
  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
    private readonly providers: Record<string, OAuthProvider>,
    private readonly publicBaseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private redirectUri(): string {
    return `${this.publicBaseUrl}/v1/oauth/callback`;
  }

  private provider(id: string): OAuthProvider {
    const p = this.providers[id];
    if (!p) throw badRequest(`proveedor OAuth desconocido: '${id}'`);
    if (!p.client_id || !p.client_secret) {
      const key = id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
      throw badRequest(`el proveedor '${id}' no está configurado en la plataforma (faltan OAUTH_${key}_CLIENT_ID/_CLIENT_SECRET)`);
    }
    return p;
  }

  listProviders() {
    return Object.values(this.providers).map((p) => ({ id: p.id, name: p.name, configured: Boolean(p.client_id && p.client_secret) }));
  }

  /** Crea un enlace de conexión compartible. `c` con el tenant fijado. */
  async createConnectLink(c: pg.PoolClient, tenantId: string, credential: string, providerId: string, scopes?: string[], by?: string) {
    const p = this.provider(providerId);
    const id = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);
    await c.query(
      `INSERT INTO oauth_states (id, tenant_id, credential, provider, scopes, code_verifier, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, tenantId, credential, p.id, scopes?.length ? scopes : p.default_scopes, verifier, by ?? null, expiresAt],
    );
    return { credential, provider: p.id, connect_url: `${this.publicBaseUrl}/v1/oauth/start/${id}`, expires_at: expiresAt.toISOString() };
  }

  /** URL del proveedor a la que redirigir al cliente. El state se busca con el pool admin (llega sin autenticar). */
  async startUrl(stateId: string): Promise<string> {
    const st = await this.state(stateId);
    const p = this.provider(st.provider);
    const u = new URL(p.authorize_url);
    const params: Record<string, string> = {
      response_type: "code",
      client_id: p.client_id!,
      redirect_uri: this.redirectUri(),
      scope: (st.scopes as string[]).join(" "),
      state: stateId,
      code_challenge: createHash("sha256").update(st.code_verifier).digest("base64url"),
      code_challenge_method: "S256",
      ...p.authorize_params,
    };
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  /** Canjea el código y guarda los tokens cifrados. Devuelve qué se conectó (para la página de confirmación). */
  async callback(stateId: string, code: string): Promise<{ credential: string; provider: string }> {
    // Consumir el state de forma atómica: un state no se puede usar dos veces.
    const used = await this.db.admin.query(
      "UPDATE oauth_states SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now() RETURNING *",
      [stateId],
    );
    const st = used.rows[0];
    if (!st) throw badRequest("el enlace de conexión no es válido, ya se usó o caducó: pide uno nuevo");
    const p = this.provider(st.provider);
    const tokens = await this.tokenRequest(p, {
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri(),
      code_verifier: st.code_verifier,
    });
    if (!tokens.ok) throw badRequest(`${p.name} rechazó la autorización: ${tokens.error}`);
    const set = this.toTokenSet(tokens.body, p.id, st.scopes);
    await this.db.withTenant(st.tenant_id, async (c) => {
      await this.store(c, st.tenant_id, st.credential, set);
      await audit(c, st.tenant_id, [{ actor: `oauth:${p.id}`, action: "connection.authorized", data: { credential: st.credential, provider: p.id, scopes: set.scopes } }]);
    });
    return { credential: st.credential, provider: p.name };
  }

  /**
   * Secreto utilizable para una credencial: el secreto estático, o un access token OAuth VIGENTE
   * (renovado aquí si caduca en < 60 s). Transacción propia: el bloqueo de fila evita renovaciones dobles
   * y la marca de "reconectar" se guarda aunque la renovación falle.
   */
  async resolveSecret(tenantId: string, name: string): Promise<string> {
    let revoked: { provider: string } | null = null;
    const secret = await this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query("SELECT kind, provider, expires_at, needs_reconnect FROM credentials WHERE name = $1 FOR UPDATE", [name]);
      const row = rows[0];
      if (!row) throw notFound(`credencial '${name}' no encontrada`);
      if (row.kind !== "oauth") return this.vault.get(c, tenantId, name);
      if (row.needs_reconnect) {
        revoked = { provider: row.provider };
        return null;
      }
      const set = JSON.parse(await this.vault.get(c, tenantId, name)) as TokenSet;
      if (set.expires_at === null || set.expires_at - Date.now() > REFRESH_MARGIN_MS) return set.access_token;

      const p = this.provider(set.provider);
      if (!set.refresh_token) {
        revoked = { provider: p.name };
      } else {
        const r = await this.tokenRequest(p, { grant_type: "refresh_token", refresh_token: set.refresh_token });
        if (r.ok) {
          const fresh = this.toTokenSet(r.body, p.id, set.scopes, set.refresh_token);
          await this.store(c, tenantId, name, fresh);
          await audit(c, tenantId, [{ actor: `oauth:${p.id}`, action: "connection.refreshed", data: { credential: name } }]);
          return fresh.access_token;
        }
        if (r.status >= 500 || r.status === 0) throw new HttpError(503, `${p.name} no responde al renovar la conexión: ${r.error}`);
        revoked = { provider: p.name };
      }
      await c.query("UPDATE credentials SET needs_reconnect = true WHERE name = $1", [name]);
      await audit(c, tenantId, [{ actor: `oauth:${set.provider}`, action: "connection.revoked", data: { credential: name } }]);
      return null;
    });
    if (revoked) throw new OAuthReconnectRequired(name, (revoked as { provider: string }).provider);
    return secret!;
  }

  async listConnections(c: pg.PoolClient) {
    const { rows } = await c.query(
      "SELECT name, kind, provider, scopes, expires_at, needs_reconnect, created_at, rotated_at FROM credentials ORDER BY name",
    );
    return rows;
  }

  // ------------------------------------------------------------------ internos

  private async state(stateId: string) {
    const { rows } = await this.db.admin.query("SELECT * FROM oauth_states WHERE id = $1 AND used_at IS NULL AND expires_at > now()", [stateId]);
    if (!rows[0]) throw conflict("el enlace de conexión no es válido, ya se usó o caducó: pide uno nuevo");
    return rows[0];
  }

  private async store(c: pg.PoolClient, tenantId: string, name: string, set: TokenSet) {
    await this.vault.put(c, tenantId, name, JSON.stringify(set), {
      kind: "oauth",
      provider: set.provider,
      scopes: set.scopes,
      expiresAt: set.expires_at ? new Date(set.expires_at) : null,
    });
  }

  private toTokenSet(body: Record<string, unknown>, provider: string, scopes: string[], previousRefresh?: string): TokenSet {
    const expiresIn = Number(body.expires_in ?? 0);
    return {
      access_token: String(body.access_token),
      // Algunos proveedores rotan el refresh token y otros no lo devuelven al renovar.
      refresh_token: (body.refresh_token as string | undefined) ?? previousRefresh,
      expires_at: expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
      provider,
      scopes: typeof body.scope === "string" && body.scope ? body.scope.split(/[ ,]+/) : scopes,
    };
  }

  private async tokenRequest(p: OAuthProvider, params: Record<string, string>) {
    try {
      const r = await this.fetchImpl(p.token_url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ ...params, client_id: p.client_id!, client_secret: p.client_secret! }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok || !body.access_token) {
        return { ok: false as const, status: r.status, error: String(body.error_description ?? body.error ?? `HTTP ${r.status}`) };
      }
      return { ok: true as const, status: r.status, body };
    } catch (e) {
      return { ok: false as const, status: 0, error: (e as Error).message };
    }
  }
}

export function connectedPage(title: string, message: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9;color:#1a1d21}
@media(prefers-color-scheme:dark){body{background:#14161a;color:#e8eaed}}main{max-width:420px;padding:24px;text-align:center}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`;
}
