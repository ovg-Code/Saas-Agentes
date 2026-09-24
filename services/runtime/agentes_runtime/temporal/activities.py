"""Actividades de Temporal: los únicos puntos con IO (LLM, tools, notificaciones)."""

from __future__ import annotations

from typing import Awaitable, Callable

import httpx
from temporalio import activity

from ..engine import LlmRequest, LlmResponse, ToolInvocation, ToolOutcome
from .workflows import Notification


class Activities:
    def __init__(self, llm: Callable[[LlmRequest], Awaitable[LlmResponse]],
                 tools: Callable[[ToolInvocation], Awaitable[ToolOutcome]],
                 control_plane_url: str, internal_token: str):
        self._llm = llm
        self._tools = tools
        self._cp = control_plane_url
        self._token = internal_token

    @activity.defn(name="llm_call")
    async def llm_call(self, request: LlmRequest) -> LlmResponse:
        return await self._llm(request)

    @activity.defn(name="tool_call")
    async def tool_call(self, invocation: ToolInvocation) -> ToolOutcome:
        return await self._tools(invocation)

    @activity.defn(name="notify_control_plane")
    async def notify_control_plane(self, notification: Notification) -> None:
        async with httpx.AsyncClient(base_url=self._cp, timeout=10, headers={"X-Internal-Token": self._token}) as c:
            r = await c.post("/internal/conversations/events", json=notification.model_dump(mode="json"))
            r.raise_for_status()
