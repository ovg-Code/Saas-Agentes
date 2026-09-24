"""Construcción de dependencias a partir de la configuración (un único sitio)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable

from .engine import LlmRequest, LlmResponse, ToolInvocation, ToolOutcome
from .llm import FakeLlm, GatewayLlm
from .rag import Embedder, GatewayEmbedder, HashingEmbedder, KnowledgeBase
from .settings import Settings
from .tools.credentials import ControlPlaneCredentials
from .tools.executor import ToolExecutor


@dataclass
class DirectEffects:
    """Effects del motor en modo directo: simples llamadas async."""

    llm_fn: Callable[[LlmRequest], Awaitable[LlmResponse]]
    tool_fn: Callable[[ToolInvocation], Awaitable[ToolOutcome]]

    async def llm(self, request: LlmRequest) -> LlmResponse:
        return await self.llm_fn(request)

    async def tool(self, invocation: ToolInvocation) -> ToolOutcome:
        return await self.tool_fn(invocation)


def make_llm(s: Settings) -> Callable[[LlmRequest], Awaitable[LlmResponse]]:
    return FakeLlm() if s.llm_provider == "fake" else GatewayLlm(s.llm_base_url, s.llm_api_key)


def make_embedder(s: Settings) -> Embedder:
    if s.embeddings_provider == "gateway" and s.llm_base_url:
        return GatewayEmbedder(s.llm_base_url, s.llm_api_key, s.embeddings_model, s.embeddings_dim)
    return HashingEmbedder(s.embeddings_dim)


def make_executor(s: Settings, knowledge: KnowledgeBase | None) -> ToolExecutor:
    return ToolExecutor(knowledge, ControlPlaneCredentials(s.control_plane_url, s.internal_token), s.http_tool_timeout_s)
