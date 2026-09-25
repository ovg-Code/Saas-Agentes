import { createHmac, timingSafeEqual } from "node:crypto";
import type { Release, WhatsAppSettings } from "@agentes/agent-spec";
import type { FastifyInstance } from "fastify";
import type { Principal } from "../../shared/auth.js";
import type { Db } from "../../shared/db.js";
import { audit } from "../audit/index.js";
import { Vault } from "../vault/index.js";

/**
 * Canal WhatsApp (Cloud API de Meta).
 *
 *  Entrada:  GET/POST /v1/channels/whatsapp/:agentId/webhook  (una URL por agente)
 *            - verificación del webhook (hub.challenge) con el verify token del cliente
 *            - firma X-Hub-Signature-256 sobre el cuerpo crudo con su app secret
 *            - 200 inmediato y proceso asíncrono (Meta reintenta si tardamos)
 *            - deduplicación por id de mensaje (wamid)
 *  Salida:   implementa el puerto ChannelSender de conversations (estructuralmente, sin importarlo):
 *            texto dentro de la ventana de 24 h; fuera, plantilla aprobada o no se envía.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT = 4096;
const NON_TEXT_REPLY = "Por ahora solo puedo leer mensajes de texto. ¿Me lo puedes escribir?";

/** Lo que el canal necesita de las conversaciones (puerto: evita depender del módulo concreto). */
export interface InboundChatPort {
  sendMessage(
    principal: Principal,
    agentId: string,
    body: { message: string; user?: string; channel?: string },
  ): Promise<unknown>;
}

export interface WhatsAppOutbound {
  tenantId: string;
  conversationId: string;
  to: string;
  text: string;
  release: Release;
  lastCustomerAt: Date | null;
}

interface WebhookPayload {
  object?: string;
  entry?: {
    changes?: {
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
        messages?: { from: string; id: string; type: string; text?: { body?: string } }[];
        statuses?: { id: string; status: string; recipient_id?: string; errors?: unknown[] }[];
      };
    }[];
  }[];
}

export class WhatsAppChannel {
  readonly channels = ["whatsapp"] as const;
  /** Procesos asíncronos en curso (los tests pueden esperarlos con `idle()`). */
  private readonly inflight = new Set<Promise<void>>();
  private chat?: InboundChatPort;

  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
    private readonly apiBase: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log: (msg: string, err?: unknown) => void = () => {},
  ) {}

  /** Se conecta después de construir ConversationService (que a su vez usa este canal para enviar). */
  attach(chat: InboundChatPort): void {
    this.chat = chat;
  }

  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  // ------------------------------------------------------------------ salida

  async send(msg: WhatsAppOutbound): Promise<{ status: "sent" | "template_sent" | "outside_window" | "failed"; detail?: string }> {
    const settings = msg.release.channel_settings?.whatsapp;
    if (!settings) return { status: "failed", detail: "el release no tiene configuración de WhatsApp" };
    const token = await this.secret(msg.tenantId, settings.access_token_ref);

    const insideWindow = msg.lastCustomerAt !== null && Date.now() - new Date(msg.lastCustomerAt).getTime() < WINDOW_MS;
    if (!insideWindow) {
      // Fuera de la ventana de 24 h Meta solo admite plantillas aprobadas.
      if (!settings.reengagement_template) return { status: "outside_window", detail: "sin plantilla de reenganche configurada" };
      const t = settings.reengagement_template;
      await this.post(settings, token, { to: msg.to, type: "template", template: { name: t.name, language: { code: t.language } } });
      return { status: "template_sent", detail: t.name };
    }
    for (const chunk of splitText(msg.text)) {
      await this.post(settings, token, { to: msg.to, type: "text", text: { preview_url: false, body: chunk } });
    }
    return { status: "sent" };
  }

  private async post(settings: WhatsAppSettings, token: string, payload: Record<string, unknown>, attempt = 1): Promise<void> {
    const r = await this.fetchImpl(`${this.apiBase}/${settings.phone_number_id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
      signal: AbortSignal.timeout(10_000),
    }).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message }) as unknown as Response);
    if (r.ok) return;
    if ((r.status === 0 || r.status >= 500 || r.status === 429) && attempt < 3) {
      await new Promise((res) => setTimeout(res, 300 * attempt));
      return this.post(settings, token, payload, attempt + 1);
    }
    throw new Error(`Graph API HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }

  // ------------------------------------------------------------------ entrada

  registerRoutes(app: FastifyInstance): void {
    // Encapsulado: el parser que conserva el cuerpo crudo (necesario para la firma) solo afecta a estas rutas.
    void app.register(async (scope) => {
      scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

      scope.get<{ Params: { agentId: string }; Querystring: Record<string, string> }>(
        "/v1/channels/whatsapp/:agentId/webhook",
        async (req, reply) => {
          const agent = await this.agent(req.params.agentId);
          if (!agent) return reply.status(404).send({ error: "agente sin canal WhatsApp" });
          const expected = await this.secret(agent.tenantId, agent.settings.verify_token_ref);
          const q = req.query;
          if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] && safeEqual(q["hub.verify_token"], expected)) {
            return reply.type("text/plain").send(q["hub.challenge"] ?? "");
          }
          return reply.status(403).send({ error: "verify token inválido" });
        },
      );

      scope.post<{ Params: { agentId: string }; Body: Buffer }>("/v1/channels/whatsapp/:agentId/webhook", async (req, reply) => {
        const agent = await this.agent(req.params.agentId);
        if (!agent) return reply.status(404).send({ error: "agente sin canal WhatsApp" });
        const appSecret = await this.secret(agent.tenantId, agent.settings.app_secret_ref);
        const signature = String(req.headers["x-hub-signature-256"] ?? "");
        const expected = `sha256=${createHmac("sha256", appSecret).update(req.body).digest("hex")}`;
        if (!safeEqual(signature, expected)) return reply.status(401).send({ error: "firma inválida" });

        let payload: WebhookPayload;
        try {
          payload = JSON.parse(req.body.toString("utf8"));
        } catch {
          return reply.status(400).send({ error: "JSON inválido" });
        }
        const job = this.process(req.params.agentId, agent, payload)
          .catch((e) => this.log("error procesando webhook de WhatsApp", e))
          .finally(() => this.inflight.delete(job));
        this.inflight.add(job);
        return reply.status(200).send({ ok: true });
      });
    });
  }

  private async process(agentId: string, agent: { tenantId: string; settings: WhatsAppSettings; release: Release }, payload: WebhookPayload) {
    if (!this.chat) throw new Error("canal WhatsApp sin conectar a las conversaciones");
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (change.field !== "messages" || !value) continue;
        if (value.metadata?.phone_number_id && value.metadata.phone_number_id !== agent.settings.phone_number_id) continue;

        for (const st of value.statuses ?? []) {
          await this.db.withTenant(agent.tenantId, (c) =>
            audit(c, agent.tenantId, [{ actor: "canal:whatsapp", action: "channel.status", data: { message_id: st.id, status: st.status, errors: st.errors } }]),
          );
        }
        for (const m of value.messages ?? []) {
          // Deduplicación: Meta reintenta; el mismo wamid nunca genera dos turnos.
          const fresh = await this.db.withTenant(agent.tenantId, (c) =>
            c.query(
              "INSERT INTO channel_inbound (tenant_id, channel, external_id) VALUES ($1, 'whatsapp', $2) ON CONFLICT DO NOTHING RETURNING id",
              [agent.tenantId, m.id],
            ),
          );
          if (!fresh.rows[0]) continue;

          if (m.type !== "text" || !m.text?.body) {
            await this.send({ tenantId: agent.tenantId, conversationId: "", to: m.from, text: NON_TEXT_REPLY, release: agent.release, lastCustomerAt: new Date() });
            continue;
          }
          // La respuesta del agente sale por ConversationService -> puerto ChannelSender -> this.send().
          await this.chat.sendMessage({ kind: "platform" }, agentId, { message: m.text.body, user: m.from, channel: "whatsapp" });
        }
      }
    }
  }

  /** Agente + configuración de WhatsApp de su release activo (búsqueda entre tenants: pool admin). */
  private async agent(agentId: string): Promise<{ tenantId: string; settings: WhatsAppSettings; release: Release } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(agentId)) return null;
    const { rows } = await this.db.admin.query(
      "SELECT a.tenant_id, r.release FROM agents a JOIN releases r ON r.id = a.active_release_id WHERE a.id = $1",
      [agentId],
    );
    const release = rows[0]?.release as Release | undefined;
    const settings = release?.channel_settings?.whatsapp;
    if (!release || !settings || !release.channels.includes("whatsapp")) return null;
    return { tenantId: rows[0].tenant_id, settings, release };
  }

  private secret(tenantId: string, ref: string): Promise<string> {
    return this.db.withTenant(tenantId, (c) => this.vault.get(c, tenantId, Vault.parseRef(ref).name));
  }
}

export function splitText(text: string, max = MAX_TEXT): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = Math.max(rest.lastIndexOf("\n", max), rest.lastIndexOf(" ", max));
    const at = cut > max / 2 ? cut : max;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
