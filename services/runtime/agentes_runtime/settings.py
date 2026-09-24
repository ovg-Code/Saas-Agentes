from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    llm_provider: str = "gateway"  # gateway | fake
    llm_base_url: str | None = "http://localhost:4000"
    llm_api_key: str = "sk-litellm-master"

    embeddings_provider: str = "fake"  # gateway | fake
    embeddings_model: str = "embeddings-default"
    embeddings_dim: int = 1024

    database_url: str = "postgres://agentes_app:agentes_app@localhost:5432/agentes"

    control_plane_url: str = "http://localhost:8080"
    internal_token: str = "dev-internal-token"

    temporal_address: str = "localhost:7233"
    temporal_namespace: str = "default"
    temporal_task_queue: str = "agentes-runtime"

    http_tool_timeout_s: float = 20.0
    port: int = 8090


@lru_cache
def get_settings() -> Settings:
    return Settings()
