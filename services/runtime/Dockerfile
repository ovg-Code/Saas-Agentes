# Runtime de agentes (API interna + worker de Temporal). Contexto de build: raíz del repo.
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PATH="/app/.venv/bin:$PATH"
COPY services/runtime/pyproject.toml services/runtime/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY services/runtime/agentes_runtime agentes_runtime
RUN uv sync --frozen --no-dev
RUN useradd -r agentes
USER agentes
EXPOSE 8090
CMD ["python", "-m", "agentes_runtime.api"]
