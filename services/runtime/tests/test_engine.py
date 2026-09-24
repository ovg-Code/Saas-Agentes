from agentes_runtime.compiler import build_system_prompt
from agentes_runtime.engine import ApprovalDecision, ConversationState, Engine, HumanReply, UserMessage


async def turn(release, context, effects, state, inp):
    return await Engine(release, context, effects).run(state, inp)


def test_system_prompt_incluye_cliente_procedimientos_y_reglas(release):
    prompt = build_system_prompt(release)
    assert "Ferretería López" in prompt
    assert "### Estado de un pedido o ticket" in prompt
    assert "Reglas de plataforma" in prompt
    assert "{{" not in prompt


async def test_faq_usa_la_base_de_conocimiento(release, context, effects):
    state, result = await turn(release, context, effects, ConversationState(), UserMessage(text="¿Plazo de devolución?"))
    assert result.status == "completed"
    assert result.tools_executed == ["conocimiento__buscar"]
    assert "30 días" in result.reply
    assert state.status == "idle"
    assert [m["role"] for m in state.messages] == ["user", "assistant", "user", "assistant"]


async def test_consulta_pedido_en_el_crm_del_cliente(release, context, effects, crm):
    _, result = await turn(release, context, effects, ConversationState(), UserMessage(text="¿Dónde está mi pedido 1001?"))
    assert result.tools_executed == ["pedidos__consultar"]
    assert "en reparto" in result.reply
    req = crm.requests[-1]
    assert req.url.path == "/pedidos/1001" and req.headers["x-api-key"] == "crm-demo-key"
    # el secreto no aparece en lo que ve el modelo ni en los eventos de auditoría
    assert "crm-demo-key" not in result.model_dump_json()


async def test_reembolso_espera_aprobacion_y_se_ejecuta_al_aprobar(release, context, effects, crm):
    state, r1 = await turn(release, context, effects, ConversationState(), UserMessage(text="Reembolsadme el pedido 1001"))
    assert r1.status == "awaiting_approval"
    assert state.status == "awaiting_approval"
    assert [p.tool for p in r1.approvals_requested] == ["pedidos__reembolsar"]
    assert not crm.requests, "nada se ejecuta antes de aprobar"

    tool_use_id = r1.approvals_requested[0].tool_use_id
    state, r2 = await turn(release, context, effects, state, ApprovalDecision(decisions={tool_use_id: True}, decided_by="ana@tienda"))
    assert r2.status == "completed"
    assert r2.tools_executed == ["pedidos__reembolsar"]
    req = crm.requests[-1]
    assert req.method == "POST" and req.url.path == "/pedidos/1001/reembolso"
    assert len(req.headers["idempotency-key"]) == 32
    assert any(e.type == "approval.decided" and e.data["approved"] for e in r2.events)


async def test_reembolso_rechazado_no_se_ejecuta(release, context, effects, crm):
    state, r1 = await turn(release, context, effects, ConversationState(), UserMessage(text="Reembolsadme el pedido 1001"))
    tid = r1.approvals_requested[0].tool_use_id
    state, r2 = await turn(release, context, effects, state, ApprovalDecision(decisions={tid: False}, note="fuera de plazo"))
    assert r2.tools_executed == []
    assert "fuera de plazo" in r2.reply
    assert not crm.requests


async def test_si_el_cliente_sigue_escribiendo_se_cancela_lo_pendiente(release, context, effects, crm):
    state, _ = await turn(release, context, effects, ConversationState(), UserMessage(text="Reembolsadme el pedido 1001"))
    state, r2 = await turn(release, context, effects, state, UserMessage(text="Olvídalo, ¿cuál es el horario?"))
    assert state.status == "idle" and r2.status == "completed"
    assert not crm.requests
    # el historial sigue siendo válido para la API: cada tool_use tiene su tool_result
    uses = {b["id"] for m in state.messages for b in m["content"] if b.get("type") == "tool_use"}
    results = {b["tool_use_id"] for m in state.messages for b in m["content"] if b.get("type") == "tool_result"}
    assert uses == results


async def test_escalado_a_humano_pausa_al_agente(release, context, effects):
    state, r1 = await turn(release, context, effects, ConversationState(), UserMessage(text="Quiero hablar con una persona"))
    assert r1.status == "handoff" and state.status == "handoff"
    assert r1.handoff["motivo"]
    # mientras lo atiende una persona, el agente no contesta
    state, r2 = await turn(release, context, effects, state, UserMessage(text="¿Hola?"))
    assert r2.status == "handoff" and r2.reply == "" and r2.tools_executed == []
    # la persona responde y devuelve la conversación al agente
    state, r3 = await turn(release, context, effects, state, HumanReply(text="Ya está resuelto", resume_bot=True))
    assert state.status == "idle"
    _, r4 = await turn(release, context, effects, state, UserMessage(text="¿Plazo de devolución?"))
    assert r4.status == "completed" and r4.tools_executed == ["conocimiento__buscar"]


async def test_limite_de_pasos(release, context, effects):
    class Loopy:
        async def llm(self, req):
            from agentes_runtime.engine import LlmResponse
            n = len(req.messages)
            return LlmResponse(content=[{"type": "tool_use", "id": f"t{n}", "name": "conocimiento__buscar",
                                         "input": {"consulta": "x"}}], stop_reason="tool_use")

        async def tool(self, inv):
            return await effects.tool(inv)

    _, result = await Engine(release, context, Loopy()).run(ConversationState(), UserMessage(text="hola"))
    assert len(result.tools_executed) == release.guardrails.max_steps_per_turn
    assert any(e.type == "guardrail.step_limit" for e in result.events)
