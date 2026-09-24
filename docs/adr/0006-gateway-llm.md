# ADR 0006 — Gateway LLM (LiteLLM) y alias de modelo

- Estado: aceptada (2026-09-24)

## Decisión
- Todas las llamadas al LLM pasan por LiteLLM. El runtime usa el SDK oficial de Anthropic contra la API
  Messages que LiteLLM expone para cualquier proveedor.
- Plantillas y releases solo referencian **alias** (`agente-default`, `agente-rapido`). Por defecto
  `agente-default` = `claude-opus-5`, con fallback configurable a otro proveedor.
- Virtual key por tenant con presupuesto y rate limit; trazas a Langfuse.

## Consecuencias
Cambiar de modelo/proveedor para uno o todos los clientes es configuración. Coste por tenant medible.
