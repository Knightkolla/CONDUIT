"""
Application configuration loaded from environment variables.

Uses pydantic BaseSettings for validation and .env file support.
All values can be overridden via environment variables or a .env file
placed in the server/ directory.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings


_ENV_FILE = Path(__file__).resolve().parent / ".env"


class Settings(BaseSettings):
    """Central configuration for the LLM-to-API Bridge server."""

    # ── LLM / calibration ────────────────────────────────────────────
    llm_api_key: str = ""
    llm_base_url: str = "https://api.openai.com/v1"
    llm_model: str = "gpt-4o-mini"

    # ── Request handling ─────────────────────────────────────────────
    request_timeout: int = 120  # seconds

    # ── Server binding ───────────────────────────────────────────────
    host: str = "0.0.0.0"
    port: int = 8000

    model_config = {
        "env_file": str(_ENV_FILE),
        "env_file_encoding": "utf-8",
        "case_sensitive": False,
    }


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a cached singleton of the application settings."""
    return Settings()
