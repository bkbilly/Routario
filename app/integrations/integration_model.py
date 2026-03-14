"""
app/models/integration.py

DB model for storing per-user, per-provider credentials.
One IntegrationAccount can be shared across many Devices.
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Dict, Optional

from sqlalchemy import Integer, String, Boolean, DateTime, ForeignKey, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from models.models import Base


class IntegrationAccount(Base):
    """
    Stores credentials for one (user, provider) combination.

    credentials is stored as a JSON blob. In production you should
    encrypt this column at rest — the engine reads it via
    get_decrypted_credentials() which is the right place to add
    envelope encryption later.

    account_label is a human-readable name shown in the UI, e.g.
    "Fleet account" or the username itself.
    """
    __tablename__ = "integration_accounts"
    __table_args__ = (
        UniqueConstraint("user_id", "provider_id", "account_label",
                         name="uq_integration_user_provider_label"),
    )

    id:            Mapped[int]      = mapped_column(Integer, primary_key=True)
    user_id:       Mapped[int]      = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider_id:   Mapped[str]      = mapped_column(String(50), nullable=False)
    account_label: Mapped[str]      = mapped_column(String(200), nullable=False)
    # JSON blob — keys depend on the provider's FIELDS definition
    credentials:   Mapped[dict]     = mapped_column(JSONB, nullable=False, default={})
    is_active:     Mapped[bool]     = mapped_column(Boolean, default=True)
    last_auth_at:  Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_error:    Mapped[Optional[str]]      = mapped_column(Text, nullable=True)
    created_at:    Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    def get_decrypted_credentials(self) -> dict:
        """
        Return credentials ready to pass to authenticate().
        Add envelope decryption here when you need it.
        """
        return dict(self.credentials)
