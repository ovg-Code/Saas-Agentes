import type pg from "pg";

export interface AuditEntry {
  actor: string;
  action: string;
  conversationId?: string;
  releaseId?: string;
  data?: unknown;
}

/** Auditoría append-only (la BD impide UPDATE/DELETE). `c` con tenant fijado. */
export async function audit(c: pg.PoolClient, tenantId: string, entries: AuditEntry[]): Promise<void> {
  for (const e of entries) {
    await c.query(
      "INSERT INTO audit_log (tenant_id, actor, action, conversation_id, release_id, data) VALUES ($1, $2, $3, $4, $5, $6)",
      [tenantId, e.actor, e.action, e.conversationId ?? null, e.releaseId ?? null, JSON.stringify(e.data ?? {})],
    );
  }
}
