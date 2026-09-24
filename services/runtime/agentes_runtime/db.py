"""Acceso a Postgres con aislamiento por tenant (RLS).

Toda consulta de datos de tenant pasa por `tenant_tx`, que fija `app.tenant_id` con SET LOCAL
dentro de la transacción. Las políticas RLS (db/migrations) filtran por ese valor, así que un
bug en una consulta no puede filtrar datos de otro cliente.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool

_pool: AsyncConnectionPool | None = None


async def get_pool(dsn: str) -> AsyncConnectionPool:
    global _pool
    if _pool is None:
        _pool = AsyncConnectionPool(dsn, min_size=1, max_size=10, open=False)
        await _pool.open()
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


@asynccontextmanager
async def tenant_tx(pool: AsyncConnectionPool, tenant_id: str) -> AsyncIterator[AsyncConnection]:
    async with pool.connection() as conn, conn.transaction():
        await conn.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
        yield conn
