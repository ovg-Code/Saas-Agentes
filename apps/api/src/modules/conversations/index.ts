import type { Release } from "@agentes/agent-spec";
import type pg from "pg";
import { assertCanChat, assertTenantAdmin, type Principal } from "../../shared/auth.js";
import type { Db } from "../../shared/db.js";
import { badRequest, conflict, notFound } from "../../shared/errors.js";
import { audit } from "../audit/index.js";
import { type WebhookDispatcher, type WebhookEvent } from "../channels/webhooks.js";
import { Vault } from "../vault/index.js";
import type { EngineState, RuntimeGateway, TurnInput, TurnResult } from "./runtime.js";

export * from "./runtime.js";

interface ConversationRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  release_id: string;
  status: string;
  state: EngineState | null;
  release: Release;
}

export interface ChatResponse {
  conversation_id: string;
  status: TurnResult["status"];
  reply: string;
  approvals: { id: string; tool: string; capability: string; tier: string; input: unknown }[];
  handoff: Record<string, unknown> | null;
  tools_executed: string[];
}

const STATUS: Record<TurnResult["status"], string> = {
  completed: "idle",
  awaiting_approval: "awaiting_approval",
  handoff: "handoff",
  error: "idle",
};

const WEBHOOK_EVENTS = new Set<string>(["tool.executed", "approval.requested", "handoff.requested"]);

/**
 * Orquesta una conversación desde el plano de control: carga el release activo, llama al runtime
 * (directo o Temporal) y persiste mensajes, aprobaciones, auditoría y webhooks. El runtime no toca
 * estas tablas: el plano de control es el dueño de los datos de negocio.
 */
export class ConversationService {
  constructor(
    private readonly db: Db,
    private readonly runtime: RuntimeGateway,
    private readonly vault: Vault,
    private readonly webhooks: WebhookDispatcher,
  ) {}

  // ------------------------------------------------------------------ entradas

  async sendMessage(
    principal: Principal,
    agentId: string,
    body: { conversation_id?: string; message: string; user?: string; channel?: string },
  ): Promise<ChatResponse> {
    if (!body.message?.trim()) throw badRequest("'message' es obligatorio");
    if (body.message.length > 8000) throw badRequest("mensaje demasiado largo (máx. 8000 caracteres)");
    const tenantId = await this.tenantOfAgent(principal, agentId);
    assertCanChat(principal, tenantId, agentId);

    const conv = await this.db.withTenant(tenantId, async (c) => {
      if (body.conversation_id) {
        const existing = await this.load(c, body.conversation_id);
        if (existing.agent_id !== agentId) throw notFound("conversación no encontrada");
        return existing;
      }
      const { rows } = await c.query(
        "SELECT active_release_id FROM agents WHERE id = $1",
        [agentId],
      );
      if (!rows[0]?.active_release_id) throw conflict("el agente no tiene ningún release publicado");
      const channel = body.channel ?? (principal.kind === "widget" ? "widget" : "api");
      const ins = await c.query(
        `INSERT INTO conversations (tenant_id, agent_id, release_id, channel, external_user)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [tenantId, agentId, rows[0].active_release_id, channel, body.user ?? null],
      );
      return this.load(c, ins.rows[0].id);
    });

    await this.db.withTenant(tenantId, (c) =>
      c.query("INSERT INTO messages (tenant_id, conversation_id, role, content) VALUES ($1, $2, 'customer', $3)", [
        tenantId,
        conv.id,
        body.message,
      ]),
    );
    return this.turn(conv, { kind: "user_message", text: body.message }, principalLabel(principal));
  }

  /** Decide una aprobación. Si la conversación tiene varias pendientes del mismo paso, espera a todas. */
  async decideApproval(principal: Principal, approvalId: string, approve: boolean, by: string, note?: string) {
    const tenantId = await this.tenantOfApproval(principal, approvalId);
    assertTenantAdmin(principal, tenantId);

    const batch = await this.db.withTenant(tenantId, async (c) => {
      const upd = await c.query(
        `UPDATE approvals SET status = $2, decided_by = $3, decided_at = now()
         WHERE id = $1 AND status = 'pending' RETURNING conversation_id`,
        [approvalId, approve ? "approved" : "rejected", by],
      );
      if (!upd.rows[0]) throw conflict("la aprobación no existe o ya fue decidida");
      const convId = upd.rows[0].conversation_id as string;
      await audit(c, tenantId, [
        { actor: by, action: approve ? "approval.approved" : "approval.rejected", conversationId: convId, data: { approval_id: approvalId, note } },
      ]);
      // Serializa decisiones concurrentes de la misma conversación: solo quien decide la última las "consume".
      await c.query("SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE", [convId]);
      const { rows } = await c.query(
        "SELECT tool_use_id, status FROM approvals WHERE conversation_id = $1 AND NOT consumed AND status IN ('pending', 'approved', 'rejected')",
        [convId],
      );
      const waiting = rows.filter((r) => r.status === "pending").length;
      if (waiting === 0) {
        await c.query("UPDATE approvals SET consumed = true WHERE conversation_id = $1 AND NOT consumed", [convId]);
      }
      return { convId, rows, waiting };
    });

    if (batch.waiting > 0) {
      return { conversation_id: batch.convId, status: "awaiting_approval" as const, waiting_for: batch.waiting };
    }
    const conv = await this.db.withTenant(tenantId, (c) => this.load(c, batch.convId));
    if (conv.status !== "awaiting_approval") throw conflict("la conversación ya no espera aprobaciones");
    const decisions = Object.fromEntries(batch.rows.map((r) => [r.tool_use_id, r.status === "approved"]));
    return this.turn(conv, { kind: "approval_decision", decisions, decided_by: by, ...(note ? { note } : {}) }, by);
  }

  async humanReply(principal: Principal, conversationId: string, text: string, resumeBot: boolean, by: string) {
    const tenantId = await this.tenantOfConversation(principal, conversationId);
    assertTenantAdmin(principal, tenantId);
    const conv = await this.db.withTenant(tenantId, (c) => this.load(c, conversationId));
    await this.db.withTenant(tenantId, (c) =>
      c.query("INSERT INTO messages (tenant_id, conversation_id, role, content) VALUES ($1, $2, 'human', $3)", [tenantId, conv.id, text]),
    );
    return this.turn(conv, { kind: "human_reply", text, resume_bot: resumeBot }, by);
  }

  /** Resultado producido por el runtime sin petición del plano de control (p.ej. aprobación expirada en Temporal). */
  async applyExternalResult(tenantId: string, conversationId: string, result: TurnResult): Promise<void> {
    const conv = await this.db.withTenant(tenantId, (c) => this.load(c, conversationId));
    await this.persist(conv, null, result, "sistema");
  }

  // ------------------------------------------------------------------ consultas (admin)

  async get(principal: Principal, conversationId: string) {
    const tenantId = await this.tenantOfConversation(principal, conversationId);
    assertTenantAdmin(principal, tenantId);
    return this.db.withTenant(tenantId, async (c) => {
      const conv = await c.query(
        "SELECT id, agent_id, release_id, channel, external_user, status, input_tokens, output_tokens, created_at, updated_at FROM conversations WHERE id = $1",
        [conversationId],
      );
      const msgs = await c.query("SELECT role, content, created_at FROM messages WHERE conversation_id = $1 ORDER BY id", [conversationId]);
      const appr = await c.query(
        "SELECT id, tool, capability, tier, input, status, decided_by, created_at FROM approvals WHERE conversation_id = $1 ORDER BY created_at",
        [conversationId],
      );
      return { ...conv.rows[0], messages: msgs.rows, approvals: appr.rows };
    });
  }

  async agentInfo(tenantId: string, agentId: string): Promise<{ id: string; name: string }> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query("SELECT id, name FROM agents WHERE id = $1", [agentId]);
      if (!rows[0]) throw notFound("agente no encontrado");
      return rows[0];
    });
  }

  async list(principal: Principal, tenantId: string, agentId?: string) {
    assertTenantAdmin(principal, tenantId);
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query(
        `SELECT cv.id, ag.slug AS agent, cv.channel, cv.external_user, cv.status, cv.updated_at,
           (SELECT content FROM messages m WHERE m.conversation_id = cv.id ORDER BY m.id DESC LIMIT 1) AS last_message
         FROM conversations cv JOIN agents ag ON ag.id = cv.agent_id
         WHERE ($1::uuid IS NULL OR cv.agent_id = $1) ORDER BY cv.updated_at DESC LIMIT 100`,
        [agentId ?? null],
      );
      return rows;
    });
  }

  async listApprovals(principal: Principal, tenantId: string, status = "pending") {
    assertTenantAdmin(principal, tenantId);
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query(
        `SELECT a.id, a.conversation_id, a.tool, a.capability, a.tier, a.input, a.status, a.created_at, ag.slug AS agent
         FROM approvals a JOIN conversations cv ON cv.id = a.conversation_id JOIN agents ag ON ag.id = cv.agent_id
         WHERE a.status = $1 ORDER BY a.created_at`,
        [status],
      );
      return rows;
    });
  }

  // ------------------------------------------------------------------ núcleo

  private async turn(conv: ConversationRow, input: TurnInput, actor: string): Promise<ChatResponse> {
    const { state, result } = await this.runtime.turn({
      release: conv.release,
      context: { tenant_id: conv.tenant_id, agent_id: conv.agent_id, conversation_id: conv.id },
      state: this.runtime.mode === "direct" ? conv.state : null,
      input,
    });
    return this.persist(conv, state, result, actor);
  }

  private async persist(conv: ConversationRow, state: EngineState | null, result: TurnResult, actor: string): Promise<ChatResponse> {
    const tenantId = conv.tenant_id;
    const agentActor = `agente:${conv.release.agent.slug}`;
    const approvals: ChatResponse["approvals"] = [];
    const webhookQueue: [WebhookEvent, Record<string, unknown>][] = [];

    await this.db.withTenant(tenantId, async (c) => {
      let tokensIn = 0;
      let tokensOut = 0;
      for (const e of result.events) {
        if (e.type !== "llm.call") continue;
        tokensIn += Number(e.data.input_tokens ?? 0);
        tokensOut += Number(e.data.output_tokens ?? 0);
      }
      await c.query(
        `UPDATE conversations SET status = $2, state = COALESCE($3, state), input_tokens = input_tokens + $4,
           output_tokens = output_tokens + $5, updated_at = now() WHERE id = $1`,
        [conv.id, STATUS[result.status], state ? JSON.stringify(state) : null, tokensIn, tokensOut],
      );
      if (result.reply) {
        await c.query("INSERT INTO messages (tenant_id, conversation_id, role, content) VALUES ($1, $2, 'agent', $3)", [tenantId, conv.id, result.reply]);
        webhookQueue.push(["message.created", { conversation_id: conv.id, role: "agent", content: result.reply }]);
      }
      for (const p of result.approvals_requested) {
        const { rows } = await c.query(
          `INSERT INTO approvals (tenant_id, conversation_id, tool_use_id, tool, capability, tier, input)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (conversation_id, tool_use_id) DO UPDATE SET status = 'pending' RETURNING id`,
          [tenantId, conv.id, p.tool_use_id, p.tool, p.capability, p.tier, JSON.stringify(p.input)],
        );
        approvals.push({ id: rows[0].id, tool: p.tool, capability: p.capability, tier: p.tier, input: p.input });
      }
      for (const e of result.events) {
        if (e.type === "approval.decided" && e.data.by === "sistema") {
          const status = String(e.data.note ?? "").includes("expir") ? "expired" : "cancelled";
          await c.query(
            "UPDATE approvals SET status = $3, decided_by = 'sistema', decided_at = now(), consumed = true WHERE conversation_id = $1 AND tool_use_id = $2 AND status = 'pending'",
            [conv.id, e.data.tool_use_id, status],
          );
        }
        if (WEBHOOK_EVENTS.has(e.type)) webhookQueue.push([e.type as WebhookEvent, { conversation_id: conv.id, ...e.data }]);
      }
      await audit(
        c,
        tenantId,
        result.events.map((e) => ({
          actor: e.type.startsWith("approval.decided") || e.type === "human.replied" ? actor : agentActor,
          action: e.type,
          conversationId: conv.id,
          releaseId: conv.release_id,
          data: e.data,
        })),
      );
    });

    if (conv.release.webhooks.length && webhookQueue.length) {
      const secrets = await this.webhookSecrets(conv);
      for (const [event, payload] of webhookQueue) this.webhooks.dispatch(conv.release, event, payload, secrets);
    }

    return {
      conversation_id: conv.id,
      status: result.status,
      reply: result.reply,
      approvals,
      handoff: result.handoff,
      tools_executed: result.tools_executed,
    };
  }

  private async webhookSecrets(conv: ConversationRow): Promise<Record<string, string>> {
    const refs = conv.release.webhooks.map((w) => w.secret_ref).filter((r): r is string => Boolean(r));
    if (!refs.length) return {};
    return this.db.withTenant(conv.tenant_id, async (c) => {
      const out: Record<string, string> = {};
      for (const ref of refs) out[ref] = await this.vault.get(c, conv.tenant_id, Vault.parseRef(ref).name);
      return out;
    });
  }

  private async load(c: pg.PoolClient, id: string): Promise<ConversationRow> {
    const { rows } = await c.query(
      `SELECT cv.id, cv.tenant_id, cv.agent_id, cv.release_id, cv.status, cv.state, r.release
       FROM conversations cv JOIN releases r ON r.id = cv.release_id WHERE cv.id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound("conversación no encontrada");
    return rows[0] as ConversationRow;
  }

  // Resolución de tenant a partir de ids. Para la plataforma se busca con el pool admin;
  // para el resto el tenant ya viene en la API key y RLS garantiza que no se vea nada ajeno.
  private async tenantOf(principal: Principal, sql: string, id: string, what: string): Promise<string> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound(`${what} no encontrado`);
    if (principal.kind !== "platform") {
      const found = await this.db.withTenant(principal.tenantId, (c) => c.query(sql, [id]));
      if (!found.rows[0]) throw notFound(`${what} no encontrado`);
      return principal.tenantId;
    }
    const { rows } = await this.db.admin.query(sql, [id]);
    if (!rows[0]) throw notFound(`${what} no encontrado`);
    return rows[0].tenant_id;
  }

  tenantOfAgent = (p: Principal, id: string) => this.tenantOf(p, "SELECT tenant_id FROM agents WHERE id = $1", id, "agente");
  private tenantOfApproval = (p: Principal, id: string) => this.tenantOf(p, "SELECT tenant_id FROM approvals WHERE id = $1", id, "aprobación");
  private tenantOfConversation = (p: Principal, id: string) =>
    this.tenantOf(p, "SELECT tenant_id FROM conversations WHERE id = $1", id, "conversación");
}

function principalLabel(p: Principal): string {
  return p.kind === "platform" ? "plataforma" : `${p.kind}:${p.tenantId.slice(0, 8)}`;
}
