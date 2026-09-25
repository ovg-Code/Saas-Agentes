# ADR 0009 — Conexiones OAuth por tenant con apps de plataforma y bóveda propia

- Estado: aceptada (2026-09-25)

## Contexto
Los sistemas más pedidos (Google Calendar, Microsoft 365, HubSpot, Salesforce, Gmail) no dan API keys fijas:
el cliente tiene que autorizar con su cuenta y los access tokens caducan (~1 h). Sin esto, el "despliegue
rápido" se atasca en cada cliente real.

## Decisión
- **Apps OAuth de plataforma** (una por proveedor, `config/oauth-providers.yaml`, credenciales por entorno
  `OAUTH_<ID>_CLIENT_ID/_SECRET`). El cliente solo pulsa un enlace y acepta.
- **Flujo**: authorization code + **PKCE S256** + `state` aleatorio (32 bytes) de **un solo uso** con caducidad de
  30 min. El enlace `/v1/oauth/start/<state>` es compartible: no da acceso a la plataforma.
- **Despliegue**: si falta una conexión, `POST /v1/deploy` responde 409 con los enlaces (`pending_connections`).
  Autorizar y redesplegar.
- **Tokens** en la bóveda existente (AES-256-GCM), `kind=oauth`, con caducidad y proveedor en claro para
  operar; el refresh token nunca sale del módulo `oauth`.
- **Renovación** en un único sitio (`OAuthService.resolveSecret`), con `SELECT … FOR UPDATE` sobre la
  credencial: turnos concurrentes renuevan una sola vez; se respeta la rotación de refresh tokens.
- **Revocación**: `invalid_grant` → `needs_reconnect`, auditoría `connection.revoked`, error 424 claro al
  runtime (el agente dice que no pudo acceder) y el siguiente despliegue vuelve a generar el enlace.

## Alternativas
- **Nango / Auth0 Token Vault / Arcade**: resuelven lo mismo con cientos de proveedores preconfigurados. La
  interfaz (`resolveSecret(tenant, nombre)`) está pensada para poder delegar en ellos cuando el catálogo crezca.
- **App OAuth del propio cliente (BYO client_id)**: necesario para algunos clientes enterprise; siguiente paso.

## Consecuencias
- Hay que registrar y verificar las apps en Google/Microsoft (verificación de Google para scopes sensibles).
- La renovación ocurre en el plano de control: el runtime sigue sin ver nunca refresh tokens.
