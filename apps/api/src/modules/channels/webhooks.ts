import { createHmac } from "node:crypto";
import type { Release } from "@agentes/agent-spec";

export type WebhookEvent = "message.created" | "tool.executed" | "approval.requested" | "handoff.requested";

/**
 * Webhooks salientes: el sistema del cliente (su CRM, su helpdesk, Slack...) reacciona a lo que hace el agente.
 * Firma HMAC-SHA256 en X-Agentes-Signature si el webhook tiene secreto.
 *
 * Entrega best-effort con reintentos cortos. Para garantías fuertes (at-least-once con reintentos de horas)
 * esto pasa a ser una actividad de Temporal — ver docs/adr/0002.
 */
export class WebhookDispatcher {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  dispatch(
    release: Release,
    event: WebhookEvent,
    payload: Record<string, unknown>,
    secrets: Record<string, string>,
  ): void {
    for (const hook of release.webhooks) {
      if (!hook.events.includes(event)) continue;
      const body = JSON.stringify({ event, agent: release.agent.slug, tenant: release.tenant.slug, ts: new Date().toISOString(), ...payload });
      const headers: Record<string, string> = { "content-type": "application/json", "x-agentes-event": event };
      const secret = hook.secret_ref ? secrets[hook.secret_ref] : undefined;
      if (secret) headers["x-agentes-signature"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      void this.send(hook.url, headers, body);
    }
  }

  private async send(url: string, headers: Record<string, string>, body: string, attempt = 1): Promise<void> {
    try {
      const r = await this.fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.timeout(5000) });
      if (r.status >= 500 && attempt < 3) throw new Error(`HTTP ${r.status}`);
    } catch {
      if (attempt < 3) {
        await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
        return this.send(url, headers, body, attempt + 1);
      }
    }
  }
}
