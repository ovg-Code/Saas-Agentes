import type { FastifyInstance } from "fastify";
import { safeEqual } from "../../shared/auth.js";
import type { Db } from "../../shared/db.js";
import { unauthorized } from "../../shared/errors.js";
import type { ConversationService, TurnResult } from "../conversations/index.js";
import type { OAuthService } from "../oauth/index.js";
import { Vault } from "../vault/index.js";

/**
 * Endpoints que solo llama el runtime (red interna + token compartido).
 * En producción: red privada/mTLS; el token es una segunda barrera.
 */
export function registerInternalRoutes(
  app: FastifyInstance,
  deps: { db: Db; vault: Vault; oauth: OAuthService; conversations: ConversationService; internalToken: string },
) {
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/internal/")) return;
    const token = req.headers["x-internal-token"];
    if (typeof token !== "string" || !safeEqual(token, deps.internalToken)) throw unauthorized("token interno inválido");
  });

  app.post<{ Body: { tenant_id: string; ref: string } }>("/internal/credentials/resolve", async (req) => {
    const { tenantSlug, name } = Vault.parseRef(req.body.ref);
    // La referencia debe pertenecer al tenant que la pide (RLS + comprobación explícita del slug).
    await deps.db.withTenant(req.body.tenant_id, async (c) => {
      const { rows } = await c.query("SELECT slug FROM tenants WHERE id = $1", [req.body.tenant_id]);
      if (rows[0]?.slug !== tenantSlug) throw unauthorized("la credencial no pertenece a este tenant");
    });
    // Secreto estático o access token OAuth vigente (renovado aquí si estaba a punto de caducar).
    const secret = await deps.oauth.resolveSecret(req.body.tenant_id, name);
    return { secret };
  });

  app.post<{ Body: { tenant_id: string; conversation_id: string; result: TurnResult } }>(
    "/internal/conversations/events",
    async (req) => {
      await deps.conversations.applyExternalResult(req.body.tenant_id, req.body.conversation_id, req.body.result);
      return { ok: true };
    },
  );
}
