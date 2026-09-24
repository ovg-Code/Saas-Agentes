# ADR 0005 — Multi-tenancy con Postgres + RLS forzada y bóveda por tenant

- Estado: aceptada (2026-09-24)

## Decisión
- Una base de datos compartida, `tenant_id` en todas las tablas, **RLS con FORCE** y tenant fijado por
  transacción (`SET LOCAL app.tenant_id`). Rol de aplicación no propietario y sin BYPASSRLS.
- Pool admin separado, usado solo en operaciones de plataforma explícitas.
- pgvector en la misma base (con RLS) para el conocimiento.
- Credenciales cifradas (AES-256-GCM, clave maestra fuera de la BD); solo circulan referencias `vault://`.
- Tenants que lo exijan: despliegue dedicado u on-prem con el mismo chart (aislamiento físico).

## Consecuencias
Un bug en una consulta no puede filtrar datos de otro cliente (verificado por tests).
