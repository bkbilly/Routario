"""
DB model for storing per-user, per-provider integration credentials.
"""
from __future__ import annotations

from datetime import datetime
from typing import Dict, Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from core.db_types import JsonType
from models.models import Base


class IntegrationAccount(Base):
    __tablename__ = "integration_accounts"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "provider_id", "account_label",
            name="uq_integration_user_provider_label",
        ),
    )

    id:            Mapped[int]            = mapped_column(Integer, primary_key=True)
    user_id:       Mapped[int]            = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider_id:   Mapped[str]            = mapped_column(String(50),  nullable=False)
    account_label: Mapped[str]            = mapped_column(String(200), nullable=False)
    credentials:   Mapped[dict]           = mapped_column(JsonType, nullable=False, default={})
    state:         Mapped[dict]           = mapped_column(JsonType, nullable=False, default=dict)
    is_active:     Mapped[bool]           = mapped_column(Boolean, default=True)
    last_auth_at:  Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_error:    Mapped[Optional[str]]  = mapped_column(Text, nullable=True)
    created_at:    Mapped[datetime]       = mapped_column(DateTime, default=datetime.utcnow)

    def get_decrypted_credentials(self) -> dict:
        return dict(self.credentials)
