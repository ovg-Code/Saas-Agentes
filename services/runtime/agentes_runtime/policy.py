"""Política de ejecución de tools (defensa en profundidad).

El plano de control ya congela en el release la decisión `approval` de cada tool
(autonomía x tier x overrides). El runtime la vuelve a comprobar aquí por si un release
llegara manipulado o corrupto: nunca se ejecuta algo financiero/irreversible sin aprobación
si el nivel de autonomía no lo permite, digan lo que digan los datos.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

import jsonschema

from .release import AutonomyLevel, Release, ReleaseTool, Tier

TIERS: tuple[Tier, ...] = ("read", "write", "irreversible", "financial")
# Tier más alto que se puede ejecutar sin aprobación en cada nivel (debe coincidir con policy.ts).
AUTO_UP_TO: dict[AutonomyLevel, Tier | None] = {
    "L1": None,
    "L2": "read",
    "L3": "write",
    "L4": "irreversible",
    "L5": "financial",
}


def autonomy_allows(tier: Tier, autonomy: AutonomyLevel) -> bool:
    limit = AUTO_UP_TO[autonomy]
    return limit is not None and TIERS.index(tier) <= TIERS.index(limit)


@dataclass(frozen=True)
class Decision:
    action: Literal["execute", "ask", "reject"]
    reason: str = ""


def decide(release: Release, tool_name: str, tool_input: Any) -> tuple[ReleaseTool | None, Decision]:
    tool = release.tool(tool_name)
    if tool is None:
        return None, Decision("reject", f"la tool '{tool_name}' no existe en este agente")

    try:
        jsonschema.validate(tool_input, tool.input_schema)
    except jsonschema.ValidationError as e:
        return tool, Decision("reject", f"argumentos inválidos: {e.message}")

    if tool.approval == "ask":
        return tool, Decision("ask", "requiere aprobación humana según la política del agente")
    # Defensa en profundidad: 'auto' en algo que la autonomía no permite -> se pide aprobación.
    # Excepción: read/write marcados como approval=never en la plantilla (p.ej. escalar a humano).
    if tool.tier in ("irreversible", "financial") and not autonomy_allows(tool.tier, release.autonomy):
        return tool, Decision("ask", "tier superior a lo que permite el nivel de autonomía")
    return tool, Decision("execute")
