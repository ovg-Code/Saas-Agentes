# ADR 0002 — Ejecución durable con Temporal y motor propio determinista

- Estado: aceptada (2026-09-24)

## Contexto
Los agentes esperan aprobaciones humanas (horas o días), llaman a sistemas externos que fallan y, en fases
posteriores, correrán procesos largos (conciliaciones, agentes autónomos). El stack es híbrido (TS + Python).

## Decisión
- **Temporal** como motor durable: SDKs maduros en TS (cliente, en el plano de control) y Python (worker).
  Una conversación = un workflow `conv:<id>`; cada entrada es un *Update* (`update-with-start`); cada llamada al
  LLM y cada tool es una actividad con reintentos.
- **Motor agéntico propio** y determinista (`engine.py`) con efectos inyectables, en vez de adoptar un framework:
  el mismo código corre en modo directo (desarrollo) y dentro del workflow. Controlamos políticas, aprobaciones y
  el contrato de release sin depender de la evolución de un framework.

## Alternativas
- DBOS (solo Postgres, más simple) — buena opción si el equipo es muy pequeño; menos maduro en TS↔Python.
- Restate — ligero, pero menor adopción.
- LangGraph/Pydantic AI — válidos, pero añaden abstracciones que no necesitamos y acoplan el formato de estado.

## Consecuencias
- Esperas de días sin coste, reanudación exacta tras caídas, expiración de aprobaciones con timers durables.
- Coste operativo de Temporal (mitigado con Temporal Cloud o `auto-setup` en compose).
- Pendiente: mover webhooks salientes a actividades para entrega at-least-once de horas.
