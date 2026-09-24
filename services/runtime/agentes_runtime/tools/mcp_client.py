"""Cliente MCP mínimo sobre Streamable HTTP (JSON-RPC 2.0).

Intenta primero el modo sin estado (spec 2026-07-28: sin handshake) y, si el servidor exige
sesión (servidores con specs anteriores), hace `initialize` y reintenta con Mcp-Session-Id.
"""

from __future__ import annotations

import json
from itertools import count
from typing import Any

import httpx

PROTOCOL_VERSION = "2025-06-18"
_ids = count(1)


class McpError(Exception):
    pass


def _parse(response: httpx.Response) -> dict[str, Any]:
    if response.headers.get("content-type", "").startswith("text/event-stream"):
        for line in response.text.splitlines():
            if line.startswith("data:"):
                msg = json.loads(line[5:].strip())
                if "result" in msg or "error" in msg:
                    return msg
        raise McpError("respuesta SSE sin resultado")
    return response.json()


class McpClient:
    def __init__(self, url: str, headers: dict[str, str], timeout: float = 20.0,
                 transport: httpx.AsyncBaseTransport | None = None):
        self._url = url
        self._headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json",
                         "MCP-Protocol-Version": PROTOCOL_VERSION, **headers}
        self._timeout = timeout
        self._transport = transport

    async def _rpc(self, client: httpx.AsyncClient, method: str, params: dict[str, Any],
                   headers: dict[str, str]) -> httpx.Response:
        body = {"jsonrpc": "2.0", "id": next(_ids), "method": method, "params": params}
        return await client.post(self._url, json=body, headers={**headers, "Mcp-Method": method})

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout, transport=self._transport) as client:
            headers = dict(self._headers)
            r = await self._rpc(client, "tools/call", {"name": name, "arguments": arguments}, {**headers, "Mcp-Name": name})
            needs_session = r.status_code in (400, 404) and any(w in r.text.lower() for w in ("session", "initializ"))
            if needs_session:
                init = await self._rpc(client, "initialize", {
                    "protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                    "clientInfo": {"name": "agentes-runtime", "version": "0.1.0"}}, headers)
                init.raise_for_status()
                if sid := init.headers.get("mcp-session-id"):
                    headers["Mcp-Session-Id"] = sid
                await client.post(self._url, json={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers=headers)
                r = await self._rpc(client, "tools/call", {"name": name, "arguments": arguments}, {**headers, "Mcp-Name": name})
            r.raise_for_status()
            msg = _parse(r)
            if "error" in msg:
                raise McpError(msg["error"].get("message", "error MCP"))
            return msg["result"]
