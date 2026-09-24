# ADR 0001 — Monolito modular en el plano de control + servicios separados donde escala distinto

- Estado: aceptada (2026-09-24)

## Contexto
Queremos desplegar clientes muy rápido y la plataforma puede construirse con calma. Se planteó usar microservicios desde el inicio.

## Decisión
- El **plano de control** (tenants, plantillas, despliegues/releases, conversaciones, aprobaciones, bóveda,
  auditoría, canales) va en **un solo servicio**, dividido en módulos con fronteras estrictas (`apps/api/src/modules/*`).
- Nacen como **procesos separados** las piezas que escalan o fallan de forma distinta: runtime (Python), worker
  de Temporal, gateway LLM, servidores MCP de conectores, Temporal y Postgres.
- Las fronteras se comprueban en CI con `dependency-cruiser` (`.dependency-cruiser.cjs`): solo la API pública
  (`index.ts`) entre módulos, sin ciclos, `shared/` sin dependencias de módulos.

## Consecuencias
- Publicar un release es una transacción ACID (sin sagas).
- La instalación on-prem son 5-6 contenedores.
- Extraer un módulo a servicio = mover la carpeta y sustituir la llamada in-process por HTTP/cola en su `index.ts`.
- Se revisará cuando un módulo tenga un perfil de carga propio (candidatos: `channels` con WhatsApp de alto
  volumen, e ingesta de conocimiento).
