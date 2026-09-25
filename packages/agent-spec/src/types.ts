// Tipos de las 4 capas de parametrización. Reflejan los JSON Schema de ../schema/,
// que son la fuente de verdad (el runtime Python tiene su espejo en Pydantic).

export type AutonomyLevel = "L1" | "L2" | "L3" | "L4" | "L5";
export type Tier = "read" | "write" | "irreversible" | "financial";
export type ApprovalSetting = "policy" | "always" | "never";
export type EffectiveApproval = "auto" | "ask";
export type ChannelKind = "widget" | "api" | "mcp" | "whatsapp" | "email" | "voice";

// ---------- Capa 1: plantilla ----------

export interface CapabilitySpec {
  description: string;
  tier: Tier;
  approval?: ApprovalSetting;
  locked?: boolean;
}

export interface ProcedureSpec {
  id: string;
  title?: string;
  when: string;
  file?: string;
  content?: string;
}

export interface Guardrails {
  max_steps_per_turn?: number;
  blocked_topics?: string[];
  untrusted_input?: boolean;
  max_cost_usd_per_conversation?: number;
}

export interface AgentTemplate {
  id: string;
  version: string;
  name: string;
  description?: string;
  category?: string;
  parameters: {
    type: "object";
    properties: Record<string, JsonSchema>;
    required?: string[];
  };
  instructions: string;
  procedures?: ProcedureSpec[];
  capabilities: {
    required?: Record<string, CapabilitySpec>;
    optional?: Record<string, CapabilitySpec>;
  };
  autonomy: { default: AutonomyLevel; max: AutonomyLevel };
  model?: { alias?: string; max_tokens?: number };
  guardrails?: Guardrails;
  channels?: ChannelKind[];
  knowledge?: { required?: boolean; description?: string };
  evals?: string;
}

// ---------- Capa 2: conectores ----------

export interface HttpOperation {
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  input_schema: JsonSchema;
  params: { name: string; in: "path" | "query" | "header"; required: boolean }[];
  has_body: boolean;
}

/** Catálogo de operaciones que ofrece un conector ya importado (OpenAPI -> operaciones). */
export interface ConnectorCatalog {
  id: string;
  type: "openapi" | "mcp";
  base_url?: string;
  url?: string;
  operations: HttpOperation[];
  /** Solo type=mcp: tools descubiertas con tools/list al conectar. */
  mcp_tools?: { name: string; description?: string; input_schema: JsonSchema }[];
}

// ---------- Capa 3: despliegue del cliente ----------

export interface ConnectorAuth {
  type: "none" | "api_key" | "bearer" | "basic";
  header?: string;
  credential?: string;
}

export interface DeploymentConnector {
  id: string;
  type: "openapi" | "mcp";
  spec?: string;
  url?: string;
  base_url?: string;
  auth?: ConnectorAuth;
}

export interface Deployment {
  tenant: { slug: string; name?: string };
  agent: { slug: string; name?: string };
  template: string;
  params?: Record<string, unknown>;
  connectors?: DeploymentConnector[];
  bindings?: Record<string, { connector: string; operation?: string }>;
  credentials?: Record<string, { from_env?: string; vault?: string }>;
  knowledge?: { source: string; title?: string }[];
  channels?: ChannelKind[];
  autonomy?: AutonomyLevel;
  overrides?: {
    capabilities?: Record<string, { approval?: ApprovalSetting }>;
    model?: { alias?: string; max_tokens?: number };
    guardrails?: Guardrails;
  };
  webhooks?: { url: string; events: string[]; secret?: string }[];
  channel_settings?: {
    whatsapp?: {
      phone_number_id: string;
      credentials: { access_token: string; app_secret: string; verify_token: string };
      reengagement_template?: { name: string; language: string };
    };
  };
}

export interface WhatsAppSettings {
  phone_number_id: string;
  access_token_ref: string;
  app_secret_ref: string;
  verify_token_ref: string;
  reengagement_template?: { name: string; language: string };
}

// ---------- Capa 4: release ----------

export type ToolBinding =
  | { kind: "builtin"; name: string }
  | {
      kind: "http";
      connector: string;
      method: HttpOperation["method"];
      path: string;
      params: HttpOperation["params"];
      has_body: boolean;
    }
  | { kind: "mcp"; connector: string; tool: string };

export interface ReleaseTool {
  name: string;
  capability: string;
  description: string;
  tier: Tier;
  approval: EffectiveApproval;
  input_schema: JsonSchema;
  binding: ToolBinding;
}

export interface ReleaseConnector {
  type: "openapi" | "mcp";
  base_url?: string;
  url?: string;
  auth: { type: ConnectorAuth["type"]; header?: string; credential_ref?: string };
}

export interface Release {
  schema_version: 1;
  id: string;
  tenant: { slug: string; name?: string };
  agent: { slug: string; name: string };
  template: { id: string; version: string };
  autonomy: AutonomyLevel;
  model: { alias: string; max_tokens: number };
  instructions: string;
  procedures: { id: string; title: string; when: string; content: string }[];
  tools: ReleaseTool[];
  connectors: Record<string, ReleaseConnector>;
  guardrails: Required<Pick<Guardrails, "max_steps_per_turn" | "blocked_topics" | "untrusted_input">> &
    Pick<Guardrails, "max_cost_usd_per_conversation">;
  channels: ChannelKind[];
  params: Record<string, unknown>;
  knowledge_sources: string[];
  webhooks: { url: string; events: string[]; secret_ref?: string }[];
  channel_settings?: { whatsapp?: WhatsAppSettings };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonSchema = Record<string, any>;
