"""Arranca un servidor de desarrollo de Temporal en localhost:7233 (UI en :8233) sin Docker.

Uso: cd services/runtime && uv run python ../../scripts/temporal-dev.py
(En docker-compose se usa la imagen oficial; esto es para desarrollo rápido y CI.)
"""

import asyncio

from temporalio.testing import WorkflowEnvironment


async def main() -> None:
    env = await WorkflowEnvironment.start_local(port=7233, ui=True, ui_port=8233)
    print("Temporal dev server en localhost:7233 (UI http://localhost:8233)", flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        await env.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
