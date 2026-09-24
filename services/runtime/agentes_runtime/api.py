"""API interna del runtime (solo la llama el plano de control; no se expone a internet).

Modo directo: el plano de control envía {release, estado, entrada} y recibe {estado, resultado}.
El runtime no guarda estado de conversación: es cómputo puro y escala horizontalmente.
"""

from __future__ import annotations

import hmac
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .db import close_pool, get_pool
from .engine import ApprovalDecision, ConversationState, Engine, HumanReply, TurnContext, TurnResult, UserMessage
from .rag import KnowledgeBase
from .release import Release
from .settings import get_settings
from .wiring import DirectEffects, make_embedder, make_executor, make_llm

settings = get_settings()
state: dict = {}


@asynccontextmanager
async def lifespan(_: FastAPI):
    pool = await get_pool(settings.database_url)
    knowledge = KnowledgeBase(pool, make_embedder(settings))
    state["knowledge"] = knowledge
    state["effects"] = DirectEffects(make_llm(settings), make_executor(settings, knowledge))
    yield
    await close_pool()


app = FastAPI(title="agentes-runtime (interno)", lifespan=lifespan)


def require_internal(x_internal_token: Annotated[str | None, Header()] = None) -> None:
    if not x_internal_token or not hmac.compare_digest(x_internal_token, settings.internal_token):
        raise HTTPException(401, "token interno inválido")


class TurnRequest(BaseModel):
    release: Release
    context: TurnContext
    state: ConversationState = Field(default_factory=ConversationState)
    input: Annotated[UserMessage | ApprovalDecision | HumanReply, Field(discriminator="kind")]


class TurnResponse(BaseModel):
    state: ConversationState
    result: TurnResult


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "llm_provider": settings.llm_provider}


@app.post("/internal/turn", dependencies=[Depends(require_internal)])
async def turn(req: TurnRequest) -> TurnResponse:
    engine = Engine(req.release, req.context, state["effects"])
    new_state, result = await engine.run(req.state, req.input)
    return TurnResponse(state=new_state, result=result)


class IngestRequest(BaseModel):
    tenant_id: str
    agent_id: str
    source: str
    title: str
    text: str


@app.post("/internal/knowledge/ingest", dependencies=[Depends(require_internal)])
async def ingest(req: IngestRequest) -> dict:
    n = await state["knowledge"].ingest(req.tenant_id, req.agent_id, req.source, req.title, req.text)
    return {"chunks": n}


class SearchRequest(BaseModel):
    tenant_id: str
    agent_id: str
    query: str
    k: int = 4


@app.post("/internal/knowledge/search", dependencies=[Depends(require_internal)])
async def search(req: SearchRequest) -> dict:
    return {"results": await state["knowledge"].search(req.tenant_id, req.agent_id, req.query, req.k)}


def main() -> None:
    import uvicorn

    uvicorn.run("agentes_runtime.api:app", host="0.0.0.0", port=settings.port)


if __name__ == "__main__":
    main()
