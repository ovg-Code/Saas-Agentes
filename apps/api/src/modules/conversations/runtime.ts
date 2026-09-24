import type { Release } from "@agentes/agent-spec";
import { Client, Connection, WithStartWorkflowOperation } from "@temporalio/client";

// Tipos de E/S del motor (espejo de services/runtime/agentes_runtime/engine.py).
export type TurnInput =
  | { kind: "user_message"; text: string }
  | { kind: "approval_decision"; decisions: Record<string, boolean>; decided_by: string; note?: string }
  | { kind: "human_reply"; text: string; resume_bot: boolean };

export interface PendingCall {
  tool_use_id: string;
  tool: string;
  capability: string;
  tier: string;
  input: unknown;
  reason: string;
}

export interface TurnResult {
  status: "completed" | "awaiting_approval" | "handoff" | "error";
  reply: string;
  approvals_requested: PendingCall[];
  handoff: Record<string, unknown> | null;
  tools_executed: string[];
  events: { type: string; data: Record<string, unknown> }[];
}

export interface TurnContext {
  tenant_id: string;
  agent_id: string;
  conversation_id: string;
  /** Momento del turno (ISO UTC). En Temporal lo sustituye `workflow.now()` en cada turno. */
  now?: string;
}

export interface EngineState {
  status: string;
  input_tokens?: number;
  output_tokens?: number;
  [k: string]: unknown;
}

export interface RuntimeGateway {
  readonly mode: "direct" | "temporal";
  /** Ejecuta un turno. En modo directo el estado viaja en la petición; en temporal vive en el workflow (state=null). */
  turn(p: { release: Release; context: TurnContext; state: EngineState | null; input: TurnInput }): Promise<{
    state: EngineState | null;
    result: TurnResult;
  }>;
  ingest(p: { tenant_id: string; agent_id: string; source: string; title: string; text: string }): Promise<{ chunks: number }>;
}

export class DirectRuntime implements RuntimeGateway {
  readonly mode = "direct" as const;
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken: string,
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": this.internalToken },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`runtime ${path} -> HTTP ${r.status}: ${(await r.text()).slice(0, 500)}`);
    return (await r.json()) as T;
  }

  async turn(p: Parameters<RuntimeGateway["turn"]>[0]) {
    const body = { release: p.release, context: p.context, input: p.input, ...(p.state ? { state: p.state } : {}) };
    return this.post<{ state: EngineState; result: TurnResult }>("/internal/turn", body);
  }

  ingest(p: Parameters<RuntimeGateway["ingest"]>[0]) {
    return this.post<{ chunks: number }>("/internal/knowledge/ingest", p);
  }
}

/** Una conversación = un workflow durable `conv:<id>`; cada entrada es un Update (update-with-start). */
export class TemporalRuntime implements RuntimeGateway {
  readonly mode = "temporal" as const;
  private client?: Promise<Client>;

  constructor(
    private readonly opts: { address: string; namespace: string; taskQueue: string },
    private readonly direct: DirectRuntime,
  ) {}

  private getClient(): Promise<Client> {
    this.client ??= Connection.connect({ address: this.opts.address }).then(
      (connection) => new Client({ connection, namespace: this.opts.namespace }),
    );
    return this.client;
  }

  async turn(p: Parameters<RuntimeGateway["turn"]>[0]) {
    const client = await this.getClient();
    const start = new WithStartWorkflowOperation("ConversationWorkflow", {
      workflowId: `conv:${p.context.conversation_id}`,
      taskQueue: this.opts.taskQueue,
      args: [{ release: p.release, context: p.context }],
      workflowIdConflictPolicy: "USE_EXISTING",
    });
    const result = (await client.workflow.executeUpdateWithStart("turn", {
      args: [{ input: p.input }],
      startWorkflowOperation: start,
    })) as TurnResult;
    return { state: null, result };
  }

  ingest(p: Parameters<RuntimeGateway["ingest"]>[0]) {
    return this.direct.ingest(p);
  }
}
