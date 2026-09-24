# Desarrollo local

Requisitos: Node 22 + pnpm 10, Python 3.11+ con `uv`, Postgres 16 con pgvector (o Docker).

## Opción A — todo con Docker

```bash
cp .env.example .env    # rellena VAULT_MASTER_KEY (openssl rand -base64 32), PLATFORM_ADMIN_TOKEN y ANTHROPIC_API_KEY
docker compose -f infra/docker-compose.yml --env-file .env up -d --build
# API http://localhost:8080 · consola /console · Temporal UI http://localhost:8233 · Langfuse http://localhost:3000
```

## Opción B — procesos locales (más rápido para iterar)

```bash
pnpm install && pnpm --filter @agentes/agent-spec build
(cd services/runtime && uv sync)

# Base de datos (Postgres con pgvector ya corriendo)
DATABASE_ADMIN_URL=postgres://agentes:agentes@localhost:5432/agentes pnpm --filter @agentes/api migrate

# Runtime (LLM_PROVIDER=fake = sin coste; gateway = LiteLLM)
(cd services/runtime && LLM_PROVIDER=fake uv run python -m agentes_runtime.api)

# API
VAULT_MASTER_KEY=$(openssl rand -base64 32) PLATFORM_ADMIN_TOKEN=dev pnpm dev:api

# Desplegar el cliente de ejemplo (con el CRM mock arrancado: node examples/crm-mock/server.mjs)
AGENTES_TOKEN=dev CRM_LOPEZ_API_KEY=crm-demo-key pnpm agentes deploy examples/clientes/ferreteria-lopez.yaml
```

Modo durable: `cd services/runtime && uv run python ../../scripts/temporal-dev.py` (Temporal local sin Docker),
`uv run python -m agentes_runtime.temporal.worker` y la API con `RUNTIME_MODE=temporal`.

## Tests

```bash
pnpm typecheck && pnpm lint:deps                                   # tipos + fronteras del monolito modular
pnpm --filter @agentes/agent-spec test                             # plantillas, resolución, OpenAPI, política
TEST_DATABASE_ADMIN_URL=postgres://agentes@localhost:5432/agentes pnpm --filter @agentes/api test
cd services/runtime && TEST_DATABASE_URL=postgres://agentes_app:agentes_app@localhost:5432/agentes \
  TEST_DATABASE_ADMIN_URL=postgres://agentes@localhost:5432/agentes uv run pytest   # incl. Temporal y RLS
./scripts/e2e.sh                     # despliegue rápido de punta a punta (RUNTIME_MODE=temporal para modo durable)
```
