"""Ejecución de tools: builtin (plataforma), HTTP (conectores OpenAPI) y MCP.

Lo que devuelve una tool es texto para el modelo. Se trunca para no reventar el contexto
y se marca `ok=False` si falla, para que el modelo no invente un resultado.
"""

from __future__ import annotations

import base64
import json
from typing import Any
from urllib.parse import quote

import httpx

from ..engine import ToolInvocation, ToolOutcome
from ..rag import KnowledgeBase
from ..release import HttpBinding, McpBinding, ReleaseConnector
from .credentials import CredentialResolver
from .mcp_client import McpClient, McpError

MAX_RESULT_CHARS = 8000


def _truncate(text: str) -> str:
    return text if len(text) <= MAX_RESULT_CHARS else text[:MAX_RESULT_CHARS] + "\n…(resultado truncado)"


class ToolExecutor:
    def __init__(self, knowledge: KnowledgeBase | None, credentials: CredentialResolver, http_timeout_s: float = 20.0,
                 transport: httpx.AsyncBaseTransport | None = None):
        self.knowledge = knowledge
        self.credentials = credentials
        self.http_timeout_s = http_timeout_s
        self._transport = transport

    async def __call__(self, inv: ToolInvocation) -> ToolOutcome:
        tool = inv.release.tool(inv.tool)
        if tool is None:
            return ToolOutcome(ok=False, content=f"tool desconocida: {inv.tool}")
        try:
            b = tool.binding
            if b.kind == "builtin":
                return await self._builtin(b.name, inv)
            if b.kind == "http":
                return await self._http(b, inv.release.connectors[b.connector], inv)
            return await self._mcp(b, inv.release.connectors[b.connector], inv)
        except (httpx.HTTPError, McpError) as e:
            return ToolOutcome(ok=False, content=f"Error de conexión con el sistema: {type(e).__name__}: {e}")

    # ------------------------------------------------------------------ builtin

    async def _builtin(self, name: str, inv: ToolInvocation) -> ToolOutcome:
        args = inv.input or {}
        if name == "conocimiento.buscar":
            if self.knowledge is None:
                return ToolOutcome(ok=False, content="La base de conocimiento no está disponible.")
            hits = await self.knowledge.search(inv.context.tenant_id, inv.context.agent_id, args["consulta"],
                                               int(args.get("max_resultados", 4)))
            if not hits:
                return ToolOutcome(ok=True, content="Sin resultados en la base de conocimiento.")
            return ToolOutcome(ok=True, content="\n\n---\n\n".join(
                f"[{h['title']}] (relevancia {h['score']})\n{h['content']}" for h in hits))
        if name == "humano.escalar":
            handoff = {"motivo": args.get("motivo"), "resumen": args.get("resumen"), "prioridad": args.get("prioridad", "normal")}
            return ToolOutcome(ok=True, handoff=handoff,
                               content="Conversación transferida a una persona del equipo. Despídete indicando que te relevan.")
        return ToolOutcome(ok=False, content=f"builtin no implementada: {name}")

    # ------------------------------------------------------------------ auth

    async def _auth_headers(self, connector: ReleaseConnector, tenant_id: str) -> dict[str, str]:
        auth = connector.auth
        if auth.type == "none" or not auth.credential_ref:
            return {}
        secret = await self.credentials.resolve(tenant_id, auth.credential_ref)
        if auth.type == "api_key":
            return {auth.header or "X-API-Key": secret}
        if auth.type in ("bearer", "oauth2"):
            # oauth2: el plano de control devuelve siempre un access token vigente (lo renueva si caducó).
            return {"Authorization": f"Bearer {secret}"}
        return {"Authorization": "Basic " + base64.b64encode(secret.encode()).decode()}

    # ------------------------------------------------------------------ http

    async def _http(self, b: HttpBinding, connector: ReleaseConnector, inv: ToolInvocation) -> ToolOutcome:
        args: dict[str, Any] = dict(inv.input or {})
        path = b.path
        query: dict[str, Any] = {}
        headers = await self._auth_headers(connector, inv.context.tenant_id)
        for p in b.params:
            if p.name not in args:
                continue
            value = args.pop(p.name)
            if p.in_ == "path":
                path = path.replace("{" + p.name + "}", quote(str(value), safe=""))
            elif p.in_ == "query":
                query[p.name] = value
            else:
                headers[p.name] = str(value)
        if b.method != "GET":
            # El sistema destino puede deduplicar reintentos (activities de Temporal, timeouts...).
            headers["Idempotency-Key"] = inv.idempotency_key
        body = args.pop("body", None) if b.has_body else None

        async with httpx.AsyncClient(base_url=connector.base_url or "", timeout=self.http_timeout_s,
                                     transport=self._transport) as client:
            r = await client.request(b.method, path, params=query, headers=headers,
                                     json=body if b.has_body else None)
        text = r.text
        try:
            text = json.dumps(r.json(), ensure_ascii=False)
        except ValueError:
            pass
        if r.status_code >= 400:
            return ToolOutcome(ok=False, content=_truncate(f"HTTP {r.status_code}: {text}"))
        return ToolOutcome(ok=True, content=_truncate(text))

    # ------------------------------------------------------------------ mcp

    async def _mcp(self, b: McpBinding, connector: ReleaseConnector, inv: ToolInvocation) -> ToolOutcome:
        headers = await self._auth_headers(connector, inv.context.tenant_id)
        client = McpClient(connector.url or "", headers, timeout=self.http_timeout_s, transport=self._transport)
        result = await client.call_tool(b.tool, inv.input or {})
        texts = [c.get("text", "") for c in result.get("content", []) if c.get("type") == "text"]
        if not texts and "structuredContent" in result:
            texts = [json.dumps(result["structuredContent"], ensure_ascii=False)]
        return ToolOutcome(ok=not result.get("isError", False), content=_truncate("\n".join(texts)))
