"""
Logbook Model
"""
from datetime import datetime
from typing import List, Optional

from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column

from core.db_types import JsonType
from models.models import Base


class LogbookEntry(Base):
    __tablename__ = "logbook_entries"

    id:          Mapped[int]           = mapped_column(Integer, primary_key=True)
    device_id:   Mapped[int]           = mapped_column(
        Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True
    )
    description: Mapped[str]           = mapped_column(Text, nullable=False)
    odometer:    Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    date:        Mapped[datetime]       = mapped_column(DateTime, nullable=False)
    price:       Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    currency:    Mapped[str]             = mapped_column(String(3), default="EUR", nullable=False)
    exchange_rate: Mapped[float]          = mapped_column(Float, default=1.0, nullable=False)
    documents:   Mapped[List]           = mapped_column(JsonType, default=list, nullable=False)
    created_by:  Mapped[int]            = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at:  Mapped[datetime]       = mapped_column(DateTime, default=datetime.utcnow)
