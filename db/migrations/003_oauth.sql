-- 003_oauth: conexiones autorizadas por el cliente (OAuth2) junto a los secretos estáticos.

ALTER TABLE credentials
  ADD COLUMN kind text NOT NULL DEFAULT 'secret' CHECK (kind IN ('secret', 'oauth')),
  ADD COLUMN provider text,
  ADD COLUMN scopes text[],
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN needs_reconnect boolean NOT NULL DEFAULT false;

-- Solicitudes de autorización en curso: state aleatorio de un solo uso + verificador PKCE.
-- El callback llega sin autenticar: se busca por id (32 bytes aleatorios) con el pool admin.
CREATE TABLE oauth_states (
  id            text PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  credential    text NOT NULL,
  provider      text NOT NULL,
  scopes        text[] NOT NULL,
  code_verifier text NOT NULL,
  created_by    text,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oauth_states USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
GRANT SELECT, INSERT, UPDATE ON oauth_states TO agentes_app;
