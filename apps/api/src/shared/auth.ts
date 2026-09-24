import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Db } from "./db.js";
import { forbidden, unauthorized } from "./errors.js";

export type Principal =
  | { kind: "platform" }
  | { kind: "admin"; tenantId: string }
  | { kind: "agent" | "widget"; tenantId: string; agentId: string };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Formato: ak_<prefijo>_<secreto>. Solo se guarda el hash; el prefijo permite buscarla sin escanear. */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomBytes(6).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  const key = `ak_${prefix}_${secret}`;
  return { key, prefix, hash: sha256(key) };
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  const x = req.headers["x-api-key"];
  return typeof x === "string" ? x : undefined;
}

export async function authenticate(db: Db, platformToken: string, token: string | undefined): Promise<Principal> {
  if (!token) throw unauthorized("falta la API key (Authorization: Bearer ...)");
  if (safeEqual(token, platformToken)) return { kind: "platform" };
  const m = /^ak_([0-9a-f]{12})_/.exec(token);
  if (!m) throw unauthorized("API key inválida");
  // Resolver una key a su tenant cruza tenants por definición -> pool admin.
  const { rows } = await db.admin.query(
    "SELECT tenant_id, agent_id, kind, hash FROM api_keys WHERE prefix = $1 AND revoked_at IS NULL",
    [m[1]],
  );
  const row = rows[0];
  if (!row || !safeEqual(row.hash, sha256(token))) throw unauthorized("API key inválida");
  if (row.kind === "admin") return { kind: "admin", tenantId: row.tenant_id };
  return { kind: row.kind, tenantId: row.tenant_id, agentId: row.agent_id };
}

/** El principal puede administrar el tenant (plataforma o admin del propio tenant). */
export function assertTenantAdmin(p: Principal, tenantId: string): void {
  if (p.kind === "platform") return;
  if (p.kind === "admin" && p.tenantId === tenantId) return;
  throw forbidden("se requiere una API key de administración de este tenant");
}

/** El principal puede hablar con este agente. */
export function assertCanChat(p: Principal, tenantId: string, agentId: string): void {
  if (p.kind === "platform") return;
  if (p.kind === "admin" && p.tenantId === tenantId) return;
  if ((p.kind === "agent" || p.kind === "widget") && p.tenantId === tenantId && p.agentId === agentId) return;
  throw forbidden("esta API key no da acceso a este agente");
}
