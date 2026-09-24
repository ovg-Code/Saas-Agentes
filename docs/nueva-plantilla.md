# Cómo crear una plantilla nueva

Una plantilla es un directorio en `templates/<id>/` con tres cosas: `template.yaml`, sus procedimientos
(`procedures/*.md`) y sus evals (`evals/golden.yaml`). **No se escribe código**: el runtime ya sabe ejecutar
cualquier plantilla válida.

## 1. Piensa en capacidades, no en sistemas

Pregunta: *¿qué necesita HACER el agente?*, no *¿con qué software?*. Ejemplo para **agendar citas**:

| Capacidad | Tier | Por qué |
|---|---|---|
| `calendario.disponibilidad` | read | consultar huecos |
| `calendario.crear_cita` | write | reservar (se puede cancelar) |
| `calendario.cancelar_cita` | write | |
| `pagos.cobrar_senal` | financial, `approval: always`, `locked: true` | mueve dinero |
| `conocimiento.buscar`, `humano.escalar` | builtin | los aporta la plataforma |

Cada cliente enlazará `calendario.*` con SU sistema (Google Calendar vía MCP, Calendly, su ERP vía OpenAPI…).

## 2. `template.yaml`

```yaml
id: agendar-citas
version: 1.0.0
name: Asistente de citas
parameters:                     # JSON Schema: genera el formulario de onboarding
  type: object
  required: [empresa, duracion_minutos]
  properties:
    empresa: { type: string, title: Nombre del negocio }
    duracion_minutos: { type: integer, title: Duración de la cita, default: 30 }
    antelacion_min_horas: { type: integer, default: 2 }
instructions: |
  Eres el asistente de citas de {{empresa}}. Las citas duran {{duracion_minutos}} minutos
  y se reservan con al menos {{antelacion_min_horas}} horas de antelación...
procedures:
  - { id: reservar, when: El cliente quiere una cita, file: procedures/reservar.md }
capabilities:
  required:
    calendario.disponibilidad: { description: Consultar huecos libres, tier: read }
    calendario.crear_cita: { description: Reservar una cita, tier: write }
  optional:
    pagos.cobrar_senal: { description: Cobrar la señal, tier: financial, approval: always, locked: true }
autonomy: { default: L3, max: L4 }
channels: [widget, api, mcp, whatsapp]
evals: evals/golden.yaml
```

Reglas: el esquema completo está en `packages/agent-spec/schema/template.schema.json`. Las variables `{{x}}` deben
existir en `parameters` (si no, el despliegue falla con un error claro).

## 3. Procedimientos (`procedures/*.md`)

Pasos concretos, en lenguaje natural, referenciando las tools por su nombre (`calendario__crear_cita`: el punto
se convierte en doble guion bajo). Son el equivalente a los SOPs/Procedures de Decagon, Fin o Agentforce.

## 4. Evals (`evals/golden.yaml`)

Conversaciones de ejemplo con lo que DEBE pasar (tools ejecutadas o no, estado, textos). Mínimo: el camino feliz,
el escalado a humano y "lo que nunca debe hacer sin aprobación".

## 5. Validar

```bash
pnpm --filter @agentes/agent-spec test     # valida TODAS las plantillas del catálogo
agentes deploy examples/clientes/<cliente-de-prueba>.yaml --dry-run
agentes eval --agent <id> --template templates/agendar-citas
```

## 6. Publicar una versión nueva

Sube `version` (semver). Los clientes con `@^1.0` la recibirán al redesplegar; antes, corre sus evals.
Cambios que rompen (renombrar parámetros o capacidades) → versión mayor (`2.0.0`).
