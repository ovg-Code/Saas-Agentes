"""Canje de referencias de la bóveda por secretos, SOLO en el momento de ejecutar una tool.

El secreto nunca entra en el contexto del modelo, ni en el release, ni en los logs:
se usa para construir la cabecera HTTP y se descarta.
"""

from __future__ import annotations

from typing import Protocol

import httpx


class CredentialResolver(Protocol):
    async def resolve(self, tenant_id: str, ref: str) -> str: ...


class ControlPlaneCredentials:
    def __init__(self, base_url: str, internal_token: str):
        self._client = httpx.AsyncClient(base_url=base_url, timeout=10,
                                         headers={"X-Internal-Token": internal_token})

    async def resolve(self, tenant_id: str, ref: str) -> str:
        r = await self._client.post("/internal/credentials/resolve", json={"tenant_id": tenant_id, "ref": ref})
        r.raise_for_status()
        return r.json()["secret"]


class StaticCredentials:
    """Para tests."""

    def __init__(self, secrets: dict[str, str]):
        self._secrets = secrets

    async def resolve(self, tenant_id: str, ref: str) -> str:
        return self._secrets[ref]
