-- 002_canales: soporte de canales asíncronos (WhatsApp y, más adelante, email).

-- Última vez que escribió el cliente final: define la ventana de 24 h de WhatsApp.
ALTER TABLE conversations ADD COLUMN last_customer_at timestamptz;
CREATE INDEX conversations_external ON conversations (agent_id, channel, external_user) WHERE status <> 'closed';

-- Deduplicación de mensajes entrantes: Meta reintenta webhooks; un mismo mensaje no genera dos turnos.
CREATE TABLE channel_inbound (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel      text NOT NULL,
  external_id  text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel, external_id)
);
ALTER TABLE channel_inbound ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_inbound FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON channel_inbound USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
GRANT SELECT, INSERT ON channel_inbound TO agentes_app;
GRANT USAGE, SELECT ON SEQUENCE channel_inbound_id_seq TO agentes_app;
