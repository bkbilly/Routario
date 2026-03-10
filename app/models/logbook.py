"""
Logbook Model — app/models/logbook.py
One entry per maintenance/service event linked to a Device.
"""
from datetime import datetime
from typing import List, Optional

from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from models.models import Base


class LogbookEntry(Base):
    """Service / maintenance log entry for a GPS device / vehicle."""
    __tablename__ = "logbook_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True
    )
    description: Mapped[str] = mapped_column(Text, nullable=False)
    odometer: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    date: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    # List of relative URL paths to uploaded documents
    documents: Mapped[List] = mapped_column(JSONB, default=list, nullable=False)
    created_by: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
