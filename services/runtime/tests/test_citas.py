"""Plantilla agendar-citas: tools MCP (agenda) + HTTP (pagos) en el mismo agente, y la hora del turno."""

import json

import httpx
import pytest

from agentes_runtime.engine import ApprovalDecision, ConversationState, Engine, TurnContext, UserMessage, describe_now
from agentes_runtime.llm import FakeLlm
from agentes_runtime.release import Release
from agentes_runtime.tools.credentials import StaticCredentials
from agentes_runtime.tools.executor import ToolExecutor
from agentes_runtime.wiring import DirectEffects

from .conftest import ROOT, FakeKnowledge

TOKEN = "agenda-demo-token"


class AgendaMock:
    """Servidor MCP de agenda + API de pagos, como examples/agenda-mock/server.mjs."""

    def __init__(self, require_session: bool = False, sse: bool = False):
        self.citas: list[dict] = []
        self.cobros: list[dict] = []
        self.require_session = require_session
        self.sse = sse
        self.requests: list[httpx.Request] = []

    def _reply(self, msg_id, result) -> httpx.Response:
        body = {"jsonrpc": "2.0", "id": msg_id, "result": result}
        if self.sse:
            return httpx.Response(200, text=f"event: message\ndata: {json.dumps(body)}\n\n",
                                  headers={"content-type": "text/event-stream"})
        return httpx.Response(200, json=body)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.headers.get("authorization") != f"Bearer {TOKEN}":
            return httpx.Response(401, json={"error": "token inválido"})
        body = json.loads(request.content or b"{}")
        if request.url.path == "/pagos/senal":
            cobro = {"id": f"P-{len(self.cobros) + 1}", **body}
            self.cobros.append(cobro)
            return httpx.Response(200, json=cobro)
        if body.get("method") == "initialize":
            r = self._reply(body["id"], {"protocolVersion": "2025-06-18", "capabilities": {}})
            r.headers["mcp-session-id"] = "s1"
            return r
        if "id" not in body:
            return httpx.Response(202)
        if self.require_session and request.headers.get("mcp-session-id") != "s1":
            return httpx.Response(400, json={"jsonrpc": "2.0", "id": body["id"],
                                             "error": {"code": -32000, "message": "no valid session ID"}})
        args = body["params"]["arguments"]
        name = body["params"]["name"]
        if name == "consultar_disponibilidad":
            return self._reply(body["id"], {"content": [{"type": "text", "text": json.dumps({"huecos": ["10:00", "11:30"]})}]})
        if name == "crear_cita":
            if any(c["fecha"] == args["fecha"] and c["hora"] == args["hora"] for c in self.citas):
                return self._reply(body["id"], {"isError": True, "content": [{"type": "text", "text": "hueco ocupado"}]})
            cita = {"id": f"C-{len(self.citas) + 1}", **args}
            self.citas.append(cita)
            return self._reply(body["id"], {"content": [{"type": "text", "text": json.dumps(cita)}]})
        return self._reply(body["id"], {"content": [{"type": "text", "text": "ok"}]})


@pytest.fixture
def release_citas() -> Release:
    return Release.model_validate_json((ROOT / "packages/agent-spec/fixtures/release.clinica-sonrisas.json").read_text())


@pytest.fixture
def ctx() -> TurnContext:
    # martes 29/09/2026 08:30 UTC = 10:30 en Madrid
    return TurnContext(tenant_id="t", agent_id="a", conversation_id="conv-citas", now="2026-09-29T08:30:00+00:00")


def effects_for(agenda: AgendaMock) -> DirectEffects:
    creds = StaticCredentials({"vault://clinica-sonrisas/agenda-token": TOKEN})
    return DirectEffects(FakeLlm(), ToolExecutor(FakeKnowledge(), creds, transport=httpx.MockTransport(agenda)))


def test_la_hora_se_muestra_en_la_zona_del_negocio():
    assert describe_now("2026-09-29T08:30:00Z", {"zona_horaria": "Europe/Madrid"}) == "ahora es martes 2026-09-29 10:30 (Europe/Madrid)"
    assert describe_now("2026-09-29T08:30:00Z", {}) == "ahora es martes 2026-09-29 08:30 (UTC)"
    assert describe_now("2026-09-29T08:30:00Z", {"zona_horaria": "No/Existe"}).endswith("(UTC)")


async def test_el_contexto_temporal_llega_al_modelo_sin_tocar_el_system_prompt(release_citas, ctx):
    seen = {}

    class Spy:
        async def llm(self, req):
            seen["system"], seen["messages"] = req.system, req.messages
            from agentes_runtime.engine import LlmResponse
            return LlmResponse(content=[{"type": "text", "text": "hola"}])

        async def tool(self, inv):
            raise AssertionError

    await Engine(release_citas, ctx, Spy()).run(ConversationState(), UserMessage(text="hola"))
    first = seen["messages"][0]["content"]
    assert first[0]["text"] == "[Contexto de plataforma: ahora es martes 2026-09-29 10:30 (Europe/Madrid)]"
    assert first[1]["text"] == "hola"
    assert "2026-09-29" not in seen["system"]  # system estable -> prompt caching


@pytest.mark.parametrize("require_session,sse", [(False, False), (True, False), (False, True)])
async def test_reserva_por_mcp(release_citas, ctx, require_session, sse):
    agenda = AgendaMock(require_session=require_session, sse=sse)
    _, r = await Engine(release_citas, ctx, effects_for(agenda)).run(
        ConversationState(), UserMessage(text="Quiero reservar mañana a las 10:00, soy Laura Gómez"))
    assert r.tools_executed == ["calendario__crear_cita"]
    # "mañana" se resuelve con la fecha del contexto (martes 29 -> miércoles 30)
    assert agenda.citas == [{"id": "C-1", "fecha": "2026-09-30", "hora": "10:00", "servicio": "revisión", "nombre_cliente": "Laura Gómez"}]
    call = next(q for q in agenda.requests if b"tools/call" in q.content)
    assert call.headers["mcp-method"] == "tools/call" and call.headers["mcp-name"] == "crear_cita"
    assert "C-1" in r.reply


async def test_hueco_ocupado_no_se_inventa(release_citas, ctx):
    agenda = AgendaMock()
    agenda.citas.append({"id": "C-1", "fecha": "2026-09-30", "hora": "10:00"})
    _, r = await Engine(release_citas, ctx, effects_for(agenda)).run(
        ConversationState(), UserMessage(text="Quiero reservar mañana a las 10:00"))
    executed = [e for e in r.events if e.type == "tool.executed"]
    assert executed[0].data["ok"] is False and "ocupado" in r.reply


async def test_la_senal_espera_aprobacion_y_se_cobra_por_http(release_citas, ctx):
    agenda = AgendaMock()
    eff = effects_for(agenda)
    state, r1 = await Engine(release_citas, ctx, eff).run(ConversationState(), UserMessage(text="Cobradme la señal de la cita C-1"))
    assert r1.status == "awaiting_approval" and agenda.cobros == []
    tid = r1.approvals_requested[0].tool_use_id
    _, r2 = await Engine(release_citas, ctx, eff).run(state, ApprovalDecision(decisions={tid: True}))
    assert r2.tools_executed == ["pagos__cobrar_senal"]
    assert agenda.cobros == [{"id": "P-1", "id_cita": "C-1", "importe": 20}]
    pay = next(q for q in agenda.requests if q.url.path == "/pagos/senal")
    assert pay.headers["authorization"] == f"Bearer {TOKEN}" and pay.headers["idempotency-key"]


@pytest.mark.parametrize("text,expected", [("a las 16:30", "16:30"), ("a las 9", "09:00"), ("a las 10h15", "10:15")])
async def test_fake_llm_entiende_horas(release_citas, ctx, text, expected):
    agenda = AgendaMock()
    await Engine(release_citas, ctx, effects_for(agenda)).run(ConversationState(), UserMessage(text=f"Quiero reservar mañana {text}"))
    assert agenda.citas[0]["hora"] == expected
