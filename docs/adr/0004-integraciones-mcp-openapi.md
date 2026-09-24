# ADR 0004 — Integraciones: OpenAPI y MCP de salida; API, widget y MCP de entrada

- Estado: aceptada (2026-09-24)

## Decisión
- **Salida** (el agente actúa en sistemas del cliente): conectores **OpenAPI** importados automáticamente y
  servidores **MCP** remotos (spec 2026-07-28, sin estado, con fallback a sesión para servidores anteriores).
- **Entrada** (el cliente usa el agente): API REST, widget web de una línea y **cada agente como servidor MCP**
  (tool `preguntar`), para que el Claude/ChatGPT/IDE/CRM del cliente lo use como herramienta. Webhooks salientes
  firmados (HMAC) para que sus sistemas reaccionen.
- A2A queda para cuando haya demanda de agentes de terceros delegando en los nuestros.

## Consecuencias
El agente se "enchufa" donde está el cliente en lugar de obligarle a usar nuestra UI.
