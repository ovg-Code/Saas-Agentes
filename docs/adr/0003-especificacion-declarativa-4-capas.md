# ADR 0003 — Especificación declarativa en 4 capas y release inmutable

- Estado: aceptada (2026-09-24)

## Decisión
Plantilla (nosotros) → Conector (catálogo o generado desde OpenAPI) → Despliegue (cliente, sin código) →
**Release** (resuelto, inmutable, identificado por hash). El runtime solo ejecuta releases.

- Formato propio en JSON Schema (`packages/agent-spec/schema`), neutral de proveedor y alineado con Open Agent
  Spec / ADK Agent Config (plantilla + instancia).
- Las plantillas declaran **capacidades abstractas** (`crm.crear_ticket`), nunca sistemas concretos.
- Los overrides del cliente solo pueden endurecer (autonomía ≤ máximo, `locked`, guardrails).
- Render de variables sin lógica (`{{var}}`): las plantillas son datos auditables, no programas.

## Consecuencias
- Integrar el CRM propio de un cliente = importar su OpenAPI y mapear operaciones.
- Despliegues idempotentes, auditables y con rollback trivial.
- Test de contrato TS↔Python en CI (fixture generado por el paquete TS y validado por Pydantic).
