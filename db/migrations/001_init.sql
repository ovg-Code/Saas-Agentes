-- 001_init: esquema multi-tenant con Row Level Security.
--
-- Roles:
--   agentes      -> propietario del esquema (migraciones y operaciones de plataforma entre tenants)
--   agentes_app  -> rol con el que corren API y runtime. NO es propietario y NO tiene BYPASSRLS:
--                   solo ve las filas del tenant fijado con SET LOCAL app.tenant_id.
-- Además se usa FORCE ROW LEVEL SECURITY para que ni siquiera el propietario se salte las
-- políticas por accidente cuando no es superusuario.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentes_app') THEN
    CREATE ROLE agentes_app LOGIN PASSWORD 'agentes_app' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- ------------------------------------------------------------------ tenants y agentes

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  -- virtual key del gateway LLM (presupuesto por tenant). Se cifra igual que las credenciales.
  llm_key_ref text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug              text NOT NULL,
  name              text NOT NULL,
  active_release_id text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

-- Capa 4: releases inmutables. `deployment` guarda la capa 3 tal cual llegó (auditoría/rollback).
CREATE TABLE releases (
  id               text PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id         uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  template_id      text NOT NULL,
  template_version text NOT NULL,
  deployment       jsonb NOT NULL,
  release          jsonb NOT NULL,
  eval_report      jsonb,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX releases_agent ON releases (agent_id, created_at DESC);

ALTER TABLE agents ADD CONSTRAINT agents_active_release_fk
  FOREIGN KEY (active_release_id) REFERENCES releases(id) DEFERRABLE INITIALLY DEFERRED;

-- Capa 2: conectores importados (catálogo de operaciones OpenAPI / tools MCP).
CREATE TABLE connectors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug        text NOT NULL,
  type        text NOT NULL CHECK (type IN ('openapi', 'mcp')),
  source      text,
  catalog     jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

-- Bóveda mínima: AES-256-GCM con clave maestra fuera de la BD. Sustituible por Vault/Nango/KMS
-- sin tocar el resto (el release solo guarda referencias vault://tenant/nombre).
CREATE TABLE credentials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  ciphertext  bytea NOT NULL,
  iv          bytea NOT NULL,
  tag         bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  rotated_at  timestamptz,
  UNIQUE (tenant_id, name)
);

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id    uuid REFERENCES agents(id) ON DELETE CASCADE,
  prefix      text NOT NULL UNIQUE,
  hash        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('admin', 'agent', 'widget')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

-- ------------------------------------------------------------------ conversaciones

CREATE TABLE conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id      uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  release_id    text NOT NULL REFERENCES releases(id),
  channel       text NOT NULL,
  external_user text,
  status        text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'awaiting_approval', 'handoff', 'closed')),
  -- modo directo: el estado del motor vive aquí. Modo temporal: vive en el workflow.
  state         jsonb,
  input_tokens  bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_agent ON conversations (agent_id, updated_at DESC);

CREATE TABLE messages (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('customer', 'agent', 'human', 'system')),
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation ON messages (conversation_id, id);

CREATE TABLE approvals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tool_use_id     text NOT NULL,
  tool            text NOT NULL,
  capability      text NOT NULL,
  tier            text NOT NULL,
  input           jsonb,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  decided_by      text,
  decided_at      timestamptz,
  -- true cuando la decisión ya se entregó al motor (evita que dos decisiones simultáneas reanuden dos veces)
  consumed        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, tool_use_id)
);
CREATE INDEX approvals_pending ON approvals (tenant_id, status) WHERE status = 'pending';

-- Auditoría append-only: qué hizo cada agente, con qué release, quién aprobó.
CREATE TABLE audit_log (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ts              timestamptz NOT NULL DEFAULT now(),
  actor           text NOT NULL,
  action          text NOT NULL,
  conversation_id uuid,
  release_id      text,
  data            jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_tenant_ts ON audit_log (tenant_id, ts DESC);

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log es append-only';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- ------------------------------------------------------------------ conocimiento (RAG)

CREATE TABLE knowledge_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source      text NOT NULL,
  title       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, source)
);

CREATE TABLE knowledge_chunks (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  content     text NOT NULL,
  embedding   vector(1024) NOT NULL
);
CREATE INDEX knowledge_chunks_agent ON knowledge_chunks (tenant_id, agent_id);
CREATE INDEX knowledge_chunks_hnsw ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

-- ------------------------------------------------------------------ RLS

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agents', 'releases', 'connectors', 'credentials', 'api_keys', 'conversations',
                           'messages', 'approvals', 'audit_log', 'knowledge_documents', 'knowledge_chunks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) '
                   'WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = current_tenant());

GRANT USAGE ON SCHEMA public TO agentes_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agentes_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agentes_app;
REVOKE UPDATE, DELETE ON audit_log FROM agentes_app;
REVOKE INSERT, UPDATE, DELETE ON tenants FROM agentes_app;

CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
