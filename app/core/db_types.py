"""
core/db_types.py

Provides database-agnostic column type helpers.
Import JsonColumn / LargeJsonColumn from here instead of using
sqlalchemy.dialects.postgresql.JSONB directly.
"""
from __future__ import annotations

import os

from sqlalchemy import JSON, Text


def _is_postgres() -> bool:
    url = os.getenv("DATABASE_URL", "")
    return "postgresql" in url or "asyncpg" in url


def JsonColumn():
    """JSONB on PostgreSQL, JSON on everything else."""
    if _is_postgres():
        try:
            from sqlalchemy.dialects.postgresql import JSONB
            return JSONB
        except ImportError:
            pass
    return JSON


# Pre-built instances for use in mapped_column(...)
JsonType = JsonColumn()
