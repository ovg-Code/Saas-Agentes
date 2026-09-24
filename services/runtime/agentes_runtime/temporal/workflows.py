"""Workflow durable de una conversación (Temporal).

Una conversación = un workflow con id `conv:<conversation_id>`. Cada entrada (mensaje del
cliente, decisión de aprobación, respuesta humana) es un Update que ejecuta el motor y devuelve
el resultado. Cada llamada al LLM y cada tool son actividades: si el worker muere a mitad de un
turno, Temporal reanuda exactamente donde iba, sin repetir escrituras ya hechas.

Además el workflow puede ESPERAR días de forma barata: una aprobación pendiente que nadie
revisa expira sola (se rechaza y se notifica al plano de control).
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Annotated, Union

from pydantic import BaseModel, Field
from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from ..engine import (
        ApprovalDecision,
        ConversationState,
        Engine,
        HumanReply,
        LlmRequest,
        LlmResponse,
        ToolInvocation,
        ToolOutcome,
        TurnContext,
        TurnResult,
        UserMessage,
    )
    from ..release import Release

APPROVAL_TIMEOUT = timedelta(hours=24)
IDLE_TIMEOUT = timedelta(days=7)

LLM_RETRY = RetryPolicy(initial_interval=timedelta(seconds=2), maximum_attempts=4,
                        non_retryable_error_types=["BadRequestError", "AuthenticationError", "PermissionDeniedError"])
TOOL_RETRY = RetryPolicy(initial_interval=timedelta(seconds=2), maximum_attempts=3)


class StartConversation(BaseModel):
    release: Release
    context: TurnContext
    state: ConversationState = Field(default_factory=ConversationState)


class TurnRequest(BaseModel):
    input: Annotated[Union[UserMessage, ApprovalDecision, HumanReply], Field(discriminator="kind")]


class Notification(BaseModel):
    conversation_id: str
    tenant_id: str
    result: TurnResult


class _TemporalEffects:
    async def llm(self, request: LlmRequest) -> LlmResponse:
        return await workflow.execute_activity(
            "llm_call", request, result_type=LlmResponse,
            start_to_close_timeout=timedelta(minutes=3), retry_policy=LLM_RETRY)

    async def tool(self, invocation: ToolInvocation) -> ToolOutcome:
        return await workflow.execute_activity(
            "tool_call", invocation, result_type=ToolOutcome,
            start_to_close_timeout=timedelta(minutes=2), retry_policy=TOOL_RETRY)


@workflow.defn(name="ConversationWorkflow")
class ConversationWorkflow:
    @workflow.init
    def __init__(self, start: StartConversation) -> None:
        self.release = start.release
        self.context = start.context
        self.state = start.state
        self.turns = 0
        self.closed = False
        self.lock = asyncio.Lock()

    @workflow.run
    async def run(self, start: StartConversation) -> ConversationState:
        while not self.closed:
            if self.state.status == "awaiting_approval":
                await self._wait_for_approval()
                continue
            seen = self.turns
            try:
                await workflow.wait_condition(
                    lambda: self.closed or self.turns != seen or self.state.status == "awaiting_approval",
                    timeout=IDLE_TIMEOUT)
            except asyncio.TimeoutError:
                self.closed = True
            if not self.closed and workflow.info().is_continue_as_new_suggested():
                await workflow.wait_condition(workflow.all_handlers_finished)
                workflow.continue_as_new(StartConversation(release=self.release, context=self.context, state=self.state))
        await workflow.wait_condition(workflow.all_handlers_finished)
        return self.state

    async def _wait_for_approval(self) -> None:
        try:
            await workflow.wait_condition(lambda: self.closed or self.state.status != "awaiting_approval",
                                          timeout=APPROVAL_TIMEOUT)
        except asyncio.TimeoutError:
            async with self.lock:
                if self.state.status != "awaiting_approval":
                    return
                expired = ApprovalDecision(decisions={p.tool_use_id: False for p in self.state.pending},
                                           decided_by="sistema", note="expiró el plazo de aprobación")
                result = await self._run(expired)
            await workflow.execute_activity(
                "notify_control_plane",
                Notification(conversation_id=self.context.conversation_id, tenant_id=self.context.tenant_id, result=result),
                start_to_close_timeout=timedelta(seconds=30), retry_policy=RetryPolicy(maximum_attempts=10))

    async def _run(self, turn_input: UserMessage | ApprovalDecision | HumanReply) -> TurnResult:
        context = self.context.model_copy(update={"now": workflow.now().isoformat()})
        engine = Engine(self.release, context, _TemporalEffects())
        self.state, result = await engine.run(self.state, turn_input)
        return result

    @workflow.update(name="turn")
    async def turn(self, request: TurnRequest) -> TurnResult:
        async with self.lock:
            self.turns += 1
            return await self._run(request.input)

    @workflow.signal(name="close")
    def close(self) -> None:
        self.closed = True

    @workflow.query(name="state")
    def get_state(self) -> ConversationState:
        return self.state
