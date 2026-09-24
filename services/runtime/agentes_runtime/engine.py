"""Loop agéntico.

Diseño clave: el motor es DETERMINISTA y no hace IO por sí mismo. Todo efecto externo
(llamar al LLM, ejecutar una tool) pasa por `Effects`. Así el mismo código corre:
  - en modo directo (Effects = llamadas normales, estado persistido por el plano de control)
  - dentro de un workflow de Temporal (Effects = actividades durables con reintentos)

Una conversación es una máquina de estados: idle -> (awaiting_approval | handoff) -> idle.
"""

from __future__ import annotations

import hashlib
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from typing import Any, Literal, Protocol, Union

from pydantic import BaseModel, Field

from .compiler import build_system_prompt, build_tools
from .policy import decide
from .release import Release

# ---------------------------------------------------------------- modelos de E/S


class TurnContext(BaseModel):
    tenant_id: str
    agent_id: str
    conversation_id: str
    # Momento del turno (ISO 8601, UTC). Lo fija quien invoca: la API en modo directo,
    # `workflow.now()` en Temporal (determinista). Sin esto el agente no sabe qué es "mañana".
    now: str | None = None


class UserMessage(BaseModel):
    kind: Literal["user_message"] = "user_message"
    text: str


class ApprovalDecision(BaseModel):
    kind: Literal["approval_decision"] = "approval_decision"
    # tool_use_id -> aprobado
    decisions: dict[str, bool]
    decided_by: str = "humano"
    note: str | None = None


class HumanReply(BaseModel):
    """Mensaje de una persona del equipo durante un handoff."""

    kind: Literal["human_reply"] = "human_reply"
    text: str
    resume_bot: bool = False


TurnInput = Union[UserMessage, ApprovalDecision, HumanReply]


class PendingCall(BaseModel):
    tool_use_id: str
    tool: str
    capability: str
    tier: str
    input: Any
    reason: str


class ConversationState(BaseModel):
    status: Literal["idle", "awaiting_approval", "handoff"] = "idle"
    messages: list[dict[str, Any]] = Field(default_factory=list)
    pending: list[PendingCall] = Field(default_factory=list)
    # tool_results ya calculados del mismo mensaje del asistente que tiene llamadas pendientes
    partial_results: list[dict[str, Any]] = Field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0


class Event(BaseModel):
    type: str
    data: dict[str, Any] = Field(default_factory=dict)


class TurnResult(BaseModel):
    status: Literal["completed", "awaiting_approval", "handoff", "error"]
    reply: str = ""
    approvals_requested: list[PendingCall] = Field(default_factory=list)
    handoff: dict[str, Any] | None = None
    tools_executed: list[str] = Field(default_factory=list)
    events: list[Event] = Field(default_factory=list)


class LlmRequest(BaseModel):
    model: str
    max_tokens: int
    system: str
    tools: list[dict[str, Any]]
    messages: list[dict[str, Any]]
    tenant_id: str


class LlmResponse(BaseModel):
    content: list[dict[str, Any]]
    stop_reason: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    model: str | None = None


class ToolInvocation(BaseModel):
    release: Release
    context: TurnContext
    tool: str
    tool_use_id: str
    input: Any
    idempotency_key: str


class ToolOutcome(BaseModel):
    ok: bool
    content: str
    # Señales especiales que devuelven las tools builtin
    handoff: dict[str, Any] | None = None


class Effects(Protocol):
    async def llm(self, request: LlmRequest) -> LlmResponse: ...
    async def tool(self, invocation: ToolInvocation) -> ToolOutcome: ...


# ---------------------------------------------------------------- utilidades

HANDOFF_DEFAULT_REPLY = "Te paso con una persona del equipo, que continuará esta conversación en cuanto esté disponible."
STEP_LIMIT_REPLY = "No he podido completar tu solicitud ahora mismo. ¿Quieres que te pase con una persona del equipo?"


WEEKDAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]


def describe_now(now_iso: str, params: dict[str, Any]) -> str:
    """'ahora es martes 2026-09-29 10:30 (Europe/Madrid)'. Usa el parámetro convencional `zona_horaria` si existe."""
    now = datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
    tz_name = params.get("zona_horaria") if isinstance(params.get("zona_horaria"), str) else None
    label = "UTC"
    if tz_name:
        try:
            now = now.astimezone(ZoneInfo(tz_name))
            label = tz_name
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return f"ahora es {WEEKDAYS[now.weekday()]} {now:%Y-%m-%d %H:%M} ({label})"


def idempotency_key(conversation_id: str, tool_use_id: str) -> str:
    """Estable entre reintentos: el sistema destino puede deduplicar escrituras."""
    return hashlib.sha256(f"{conversation_id}:{tool_use_id}".encode()).hexdigest()[:32]


def _append(state: ConversationState, role: str, blocks: list[dict[str, Any]]) -> None:
    """Añade un mensaje fusionándolo con el anterior si es del mismo rol (la API exige alternancia)."""
    if state.messages and state.messages[-1]["role"] == role:
        state.messages[-1]["content"].extend(blocks)
    else:
        state.messages.append({"role": role, "content": list(blocks)})


def _text_of(blocks: list[dict[str, Any]]) -> str:
    return "\n".join(b["text"] for b in blocks if b.get("type") == "text" and b.get("text")).strip()


def _tool_result(tool_use_id: str, content: str, is_error: bool = False) -> dict[str, Any]:
    block: dict[str, Any] = {"type": "tool_result", "tool_use_id": tool_use_id, "content": content}
    if is_error:
        block["is_error"] = True
    return block


# ---------------------------------------------------------------- motor


class Engine:
    def __init__(self, release: Release, context: TurnContext, effects: Effects):
        self.release = release
        self.context = context
        self.effects = effects
        self._system = build_system_prompt(release)
        self._tools = build_tools(release)

    async def run(self, state: ConversationState, turn_input: TurnInput) -> tuple[ConversationState, TurnResult]:
        state = state.model_copy(deep=True)
        result = TurnResult(status="completed")

        if isinstance(turn_input, HumanReply):
            _append(state, "assistant", [{"type": "text", "text": f"[Persona del equipo] {turn_input.text}"}])
            result.events.append(Event(type="human.replied", data={"resume_bot": turn_input.resume_bot}))
            if turn_input.resume_bot:
                state.status = "idle"
            result.status = "completed" if state.status == "idle" else "handoff"
            return state, result

        if isinstance(turn_input, ApprovalDecision):
            if state.status != "awaiting_approval":
                result.status = "error"
                result.reply = "No hay acciones pendientes de aprobación."
                return state, result
            await self._resolve_pending(state, turn_input, result)
        else:  # UserMessage
            if state.status == "awaiting_approval":
                # El cliente siguió escribiendo: las acciones pendientes se cancelan.
                cancelled = ApprovalDecision(decisions={p.tool_use_id: False for p in state.pending}, decided_by="sistema",
                                             note="cancelada porque el cliente continuó la conversación")
                await self._resolve_pending(state, cancelled, result)
            _append(state, "user", [*self._context_blocks(), {"type": "text", "text": turn_input.text}])
            if state.status == "handoff":
                # Lo atiende una persona: el agente no responde.
                result.status = "handoff"
                return state, result

        await self._loop(state, result)
        return state, result

    def _context_blocks(self) -> list[dict[str, Any]]:
        """Contexto temporal como bloque aparte del mensaje (no en el system prompt: rompería el prompt caching)."""
        if not self.context.now:
            return []
        return [{"type": "text", "text": f"[Contexto de plataforma: {describe_now(self.context.now, self.release.params)}]"}]

    async def _resolve_pending(self, state: ConversationState, decision: ApprovalDecision, result: TurnResult) -> None:
        results = list(state.partial_results)
        for p in state.pending:
            approved = decision.decisions.get(p.tool_use_id, False)
            result.events.append(Event(type="approval.decided", data={
                "tool_use_id": p.tool_use_id, "tool": p.tool, "approved": approved, "by": decision.decided_by, "note": decision.note}))
            if approved:
                results.append(await self._execute(p.tool, p.tool_use_id, p.input, result))
            else:
                reason = decision.note or "rechazada por una persona del equipo"
                results.append(_tool_result(p.tool_use_id, f"Acción NO ejecutada: {reason}.", is_error=True))
        _append(state, "user", results)
        state.pending, state.partial_results, state.status = [], [], "idle"

    async def _execute(self, tool_name: str, tool_use_id: str, tool_input: Any, result: TurnResult) -> dict[str, Any]:
        outcome = await self.effects.tool(ToolInvocation(
            release=self.release, context=self.context, tool=tool_name, tool_use_id=tool_use_id, input=tool_input,
            idempotency_key=idempotency_key(self.context.conversation_id, tool_use_id)))
        tool = self.release.tool(tool_name)
        result.tools_executed.append(tool_name)
        result.events.append(Event(type="tool.executed", data={
            "tool": tool_name, "capability": tool.capability if tool else None, "tool_use_id": tool_use_id,
            "input": tool_input, "ok": outcome.ok, "output_preview": outcome.content[:500]}))
        if outcome.handoff is not None:
            result.handoff = outcome.handoff
            result.events.append(Event(type="handoff.requested", data=outcome.handoff))
        return _tool_result(tool_use_id, outcome.content, is_error=not outcome.ok)

    async def _loop(self, state: ConversationState, result: TurnResult) -> None:
        for _ in range(self.release.guardrails.max_steps_per_turn):
            response = await self.effects.llm(LlmRequest(
                model=self.release.model.alias, max_tokens=self.release.model.max_tokens, system=self._system,
                tools=self._tools, messages=state.messages, tenant_id=self.context.tenant_id))
            state.input_tokens += response.input_tokens
            state.output_tokens += response.output_tokens
            result.events.append(Event(type="llm.call", data={
                "model": response.model or self.release.model.alias, "stop_reason": response.stop_reason,
                "input_tokens": response.input_tokens, "output_tokens": response.output_tokens}))
            _append(state, "assistant", response.content)

            tool_uses = [b for b in response.content if b.get("type") == "tool_use"]
            if not tool_uses:
                result.reply = _text_of(response.content)
                if response.stop_reason == "refusal" and not result.reply:
                    result.reply = "Lo siento, no puedo ayudar con esa solicitud."
                break

            results: list[dict[str, Any]] = []
            pending: list[PendingCall] = []
            for tu in tool_uses:
                tool, decision = decide(self.release, tu["name"], tu.get("input"))
                if decision.action == "reject":
                    result.events.append(Event(type="tool.rejected", data={"tool": tu["name"], "reason": decision.reason}))
                    results.append(_tool_result(tu["id"], f"Error: {decision.reason}", is_error=True))
                elif decision.action == "ask":
                    assert tool is not None
                    pending.append(PendingCall(tool_use_id=tu["id"], tool=tool.name, capability=tool.capability,
                                               tier=tool.tier, input=tu.get("input"), reason=decision.reason))
                else:
                    results.append(await self._execute(tu["name"], tu["id"], tu.get("input"), result))

            if pending:
                state.status, state.pending, state.partial_results = "awaiting_approval", pending, results
                result.status = "awaiting_approval"
                result.approvals_requested = pending
                for p in pending:
                    result.events.append(Event(type="approval.requested", data=p.model_dump()))
                result.reply = _text_of(response.content) or (
                    "He preparado la acción que necesitas; una persona del equipo tiene que aprobarla antes de ejecutarla. "
                    "Te avisaremos en cuanto esté revisada.")
                return

            _append(state, "user", results)
        else:
            result.reply = STEP_LIMIT_REPLY
            result.events.append(Event(type="guardrail.step_limit", data={"max": self.release.guardrails.max_steps_per_turn}))

        if result.handoff is not None:
            state.status = "handoff"
            result.status = "handoff"
            result.reply = result.reply or HANDOFF_DEFAULT_REPLY
