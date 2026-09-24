"""Espejo Pydantic de packages/agent-spec/schema/release.schema.json.

El release es el ÚNICO contrato entre el plano de control (TS) y el runtime. El test
tests/test_contract.py valida el fixture que genera el paquete TS contra estos modelos.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field

AutonomyLevel = Literal["L1", "L2", "L3", "L4", "L5"]
Tier = Literal["read", "write", "irreversible", "financial"]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class BuiltinBinding(_Model):
    kind: Literal["builtin"]
    name: str


class HttpParam(_Model):
    name: str
    in_: Literal["path", "query", "header"] = Field(alias="in")
    required: bool = False

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class HttpBinding(_Model):
    kind: Literal["http"]
    connector: str
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"]
    path: str
    params: list[HttpParam]
    has_body: bool


class McpBinding(_Model):
    kind: Literal["mcp"]
    connector: str
    tool: str


Binding = Annotated[Union[BuiltinBinding, HttpBinding, McpBinding], Field(discriminator="kind")]


class ReleaseTool(_Model):
    name: str
    capability: str
    description: str
    tier: Tier
    approval: Literal["auto", "ask"]
    input_schema: dict[str, Any]
    binding: Binding


class ConnectorAuth(_Model):
    type: Literal["none", "api_key", "bearer", "basic"]
    header: str | None = None
    credential_ref: str | None = None


class ReleaseConnector(_Model):
    type: Literal["openapi", "mcp"]
    base_url: str | None = None
    url: str | None = None
    auth: ConnectorAuth


class Guardrails(_Model):
    max_steps_per_turn: int
    blocked_topics: list[str]
    untrusted_input: bool
    max_cost_usd_per_conversation: float | None = None


class Procedure(_Model):
    id: str
    title: str
    when: str
    content: str


class Named(_Model):
    slug: str
    name: str | None = None


class TemplateRef(_Model):
    id: str
    version: str


class ModelConfig(_Model):
    alias: str
    max_tokens: int


class Webhook(_Model):
    url: str
    events: list[str]
    secret_ref: str | None = None


class Release(_Model):
    schema_version: Literal[1]
    id: str
    tenant: Named
    agent: Named
    template: TemplateRef
    autonomy: AutonomyLevel
    model: ModelConfig
    instructions: str
    procedures: list[Procedure]
    tools: list[ReleaseTool]
    connectors: dict[str, ReleaseConnector]
    guardrails: Guardrails
    channels: list[str]
    params: dict[str, Any]
    knowledge_sources: list[str] = []
    webhooks: list[Webhook] = []

    def tool(self, name: str) -> ReleaseTool | None:
        return next((t for t in self.tools if t.name == name), None)
