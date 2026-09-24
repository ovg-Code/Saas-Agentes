"""Worker de Temporal: `python -m agentes_runtime.temporal.worker`."""

from __future__ import annotations

import asyncio
import logging

from temporalio.client import Client
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Worker

from ..db import get_pool
from ..rag import KnowledgeBase
from ..settings import get_settings
from ..wiring import make_embedder, make_executor, make_llm
from .activities import Activities
from .workflows import ConversationWorkflow


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    s = get_settings()
    pool = await get_pool(s.database_url)
    knowledge = KnowledgeBase(pool, make_embedder(s))
    acts = Activities(make_llm(s), make_executor(s, knowledge), s.control_plane_url, s.internal_token)
    client = await Client.connect(s.temporal_address, namespace=s.temporal_namespace, data_converter=pydantic_data_converter)
    worker = Worker(client, task_queue=s.temporal_task_queue, workflows=[ConversationWorkflow],
                    activities=[acts.llm_call, acts.tool_call, acts.notify_control_plane])
    logging.info("worker escuchando en la cola %s", s.temporal_task_queue)
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
