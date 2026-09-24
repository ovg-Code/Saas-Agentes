from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from agentes_runtime.engine import TurnContext
from agentes_runtime.llm import FakeLlm
from agentes_runtime.release import Release
from agentes_runtime.tools.credentials import StaticCredentials
from agentes_runtime.tools.executor import ToolExecutor
from agentes_runtime.wiring import DirectEffects

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "packages/agent-spec/fixtures/release.ferreteria-lopez.json"


@pytest.fixture
def release_json() -> dict:
    return json.loads(FIXTURE.read_text())


@pytest.fixture
def release(release_json) -> Release:
    return Release.model_validate(release_json)


@pytest.fixture
def context() -> TurnContext:
    return TurnContext(tenant_id="00000000-0000-0000-0000-000000000001", agent_id="00000000-0000-0000-0000-0000000000a1",
                       conversation_id="conv-1")


class FakeKnowledge:
    async def search(self, tenant_id, agent_id, query, k=4):
        return [{"title": "FAQ", "score": 0.9, "source": "faq.md",
                 "content": "Puedes devolver cualquier producto sin usar en un plazo de 30 días."}]


class CrmMock:
    """Imita al CRM de examples/crm-mock y registra las peticiones."""

    def __init__(self):
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.headers.get("x-api-key") != "crm-demo-key":
            return httpx.Response(401, json={"error": "API key inválida"})
        if request.url.path == "/pedidos/1001" and request.method == "GET":
            return httpx.Response(200, json={"numero": "1001", "estado": "en reparto"})
        if request.url.path.startswith("/pedidos/") and request.method == "GET":
            return httpx.Response(404, json={"error": "pedido no encontrado"})
        if request.url.path.endswith("/reembolso"):
            return httpx.Response(200, json={"id": "r1", **json.loads(request.content)})
        if request.url.path == "/tickets":
            return httpx.Response(201, json={"id": "T-1", **json.loads(request.content)})
        return httpx.Response(404)


@pytest.fixture
def crm() -> CrmMock:
    return CrmMock()


@pytest.fixture
def effects(crm) -> DirectEffects:
    executor = ToolExecutor(FakeKnowledge(), StaticCredentials({"vault://ferreteria-lopez/crm-lopez-key": "crm-demo-key"}),
                            transport=httpx.MockTransport(crm))
    return DirectEffects(FakeLlm(), executor)
