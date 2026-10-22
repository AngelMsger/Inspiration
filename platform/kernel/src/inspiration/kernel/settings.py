"""Deployment settings, read from INSPIRATION_* environment variables.

The defaults match infra/compose.yaml, so a developer machine needs no configuration.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="INSPIRATION_", env_file=".env", extra="ignore")

    database_url: str = "postgresql://inspiration:inspiration@localhost:5432/inspiration"
    valkey_url: str = "redis://localhost:6379/0"
    spicedb_endpoint: str = "localhost:50051"
    spicedb_key: SecretStr = SecretStr("inspiration-dev-key")
    spicedb_insecure: bool = True
    blob_dir: Path = Path(".data/blobs")
    gateway_config: Path | None = Field(default=None, description="YAML file with model providers, routes and budgets")
    stream_prefix: str = "insp"


@lru_cache
def get_settings() -> Settings:
    return Settings()
