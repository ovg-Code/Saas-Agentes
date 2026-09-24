"""El mismo motor corriendo dentro de un workflow durable de Temporal (servidor de test con time-skipping)."""

import uuid
from datetime import timedelta

import pytest
from temporalio import activity
from temporalio.client import WithStartWorkflowOperation
from temporalio.common import WorkflowIDConflictPolicy
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from agentes_runtime.engine import ApprovalDecision, TurnResult, UserMessage
from agentes_runtime.temporal.activities import Activities
from agentes_runtime.temporal.workflows import ConversationWorkflow, Notification, StartConversation, TurnRequest


@pytest.fixture
async def env():
    try:
        e = await WorkflowEnvironment.start_time_skipping(data_converter=pydantic_data_converter)
    except Exception as exc:  # sin red para descargar el servidor de test
        pytest.skip(f"no se pudo arrancar el servidor de test de Temporal: {exc}")
    async with e:
        yield e


async def test_conversacion_durable_con_aprobacion_y_expiracion(env, release, context, effects, crm):
    notified: list[Notification] = []
    acts = Activities(effects.llm_fn, effects.tool_fn, "http://unused", "x")

    async def fake_notify(n: Notification) -> None:
        notified.append(n)

    queue = f"q-{uuid.uuid4()}"
    notify = activity.defn(name="notify_control_plane")(fake_notify)
    async with Worker(env.client, task_queue=queue, workflows=[ConversationWorkflow],
                      activities=[acts.llm_call, acts.tool_call, notify]):
        wid = f"conv:{uuid.uuid4()}"
        start = StartConversation(release=release, context=context)

        async def send(inp) -> TurnResult:
            op = WithStartWorkflowOperation(ConversationWorkflow.run, start, id=wid, task_queue=queue,
                                            id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING)
            return await env.client.execute_update_with_start_workflow(
                ConversationWorkflow.turn, TurnRequest(input=inp), start_workflow_operation=op)

        r1 = await send(UserMessage(text="¿Plazo de devolución?"))
        assert r1.status == "completed" and r1.tools_executed == ["conocimiento__buscar"]

        # Reembolso -> queda esperando aprobación dentro del workflow
        r2 = await send(UserMessage(text="Reembolsadme el pedido 1001"))
        assert r2.status == "awaiting_approval"
        tid = r2.approvals_requested[0].tool_use_id
        r3 = await send(ApprovalDecision(decisions={tid: True}))
        assert r3.tools_executed == ["pedidos__reembolsar"]

        # Otra aprobación que nadie revisa: el workflow la expira a las 24h (tiempo simulado) y avisa
        r4 = await send(UserMessage(text="Reembolsadme el pedido 1002"))
        assert r4.status == "awaiting_approval"
        await env.sleep(timedelta(hours=25))
        handle = env.client.get_workflow_handle(wid)
        state = await handle.query(ConversationWorkflow.get_state)
        assert state.status == "idle"
        assert notified and notified[0].result.events[0].data["approved"] is False
        assert [r.url.path for r in crm.requests].count("/pedidos/1002/reembolso") == 0
