"""
Push Notification Service (Web Push / VAPID)
"""
import json
import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import Integer, DateTime, ForeignKey, delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Mapped, mapped_column

from core.db_types import JsonType
from core.config import get_settings
from models.models import Base

logger = logging.getLogger(__name__)


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"

    id:           Mapped[int]      = mapped_column(Integer, primary_key=True)
    user_id:      Mapped[int]      = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False
    )
    subscription: Mapped[dict]     = mapped_column(JsonType, nullable=False)
    created_at:   Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at:   Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class PushNotificationService:

    def __init__(self):
        settings = get_settings()
        self._private_key = getattr(settings, "vapid_private_key", "")
        self._public_key  = getattr(settings, "vapid_public_key",  "")
        self._mailto      = getattr(settings, "vapid_mailto", "mailto:admin@example.com")
        if not self._private_key:
            logger.warning("[Push] VAPID keys not configured — push notifications disabled")

    @property
    def _enabled(self) -> bool:
        return bool(self._private_key and self._public_key)

    async def notify_user(
        self,
        db_service,
        user_id: int,
        alert_type: str,
        message: str,
        severity: str = "info",
        device_name: Optional[str] = None,
        alert_id: Optional[int] = None,
    ) -> bool:
        if not self._enabled:
            return False
        subscription = await self._get_subscription(db_service, user_id)
        if not subscription:
            return False
        return await self._send(
            subscription=subscription,
            alert_type=alert_type,
            message=message,
            severity=severity,
            device_name=device_name,
            alert_id=alert_id,
        )

    async def save_subscription(self, db_service, user_id: int, subscription: dict):
        """
        Upsert a push subscription.  Uses dialect-specific INSERT … ON CONFLICT
        for PostgreSQL and SQLite; falls back to delete-then-insert for others
        (e.g. MySQL which uses INSERT … ON DUPLICATE KEY UPDATE via its own
        dialect but that requires importing aiomysql dialect explicitly).
        """
        from core.database import _is_postgres, _is_sqlite

        db_url = db_service._db_url

        async with db_service.get_session() as session:
            if _is_postgres(db_url):
                stmt = (
                    pg_insert(PushSubscription)
                    .values(user_id=user_id, subscription=subscription, updated_at=datetime.utcnow())
                    .on_conflict_do_update(
                        index_elements=["user_id"],
                        set_={"subscription": subscription, "updated_at": datetime.utcnow()},
                    )
                )
                await session.execute(stmt)
            elif _is_sqlite(db_url):
                stmt = (
                    sqlite_insert(PushSubscription)
                    .values(user_id=user_id, subscription=subscription, updated_at=datetime.utcnow())
                    .on_conflict_do_update(
                        index_elements=["user_id"],
                        set_={"subscription": subscription, "updated_at": datetime.utcnow()},
                    )
                )
                await session.execute(stmt)
            else:
                # Generic fallback
                await session.execute(
                    delete(PushSubscription).where(PushSubscription.user_id == user_id)
                )
                session.add(PushSubscription(
                    user_id=user_id,
                    subscription=subscription,
                    updated_at=datetime.utcnow(),
                ))

    async def remove_subscription(self, db_service, user_id: int):
        async with db_service.get_session() as session:
            await session.execute(
                delete(PushSubscription).where(PushSubscription.user_id == user_id)
            )

    async def _get_subscription(self, db_service, user_id: int) -> Optional[dict]:
        async with db_service.get_session() as session:
            result = await session.execute(
                select(PushSubscription).where(PushSubscription.user_id == user_id)
            )
            row = result.scalar_one_or_none()
            return row.subscription if row else None

    async def _send(self, subscription, alert_type, message, severity,
                    device_name, alert_id) -> bool:
        try:
            from pywebpush import webpush, WebPushException
        except ImportError:
            logger.error("[Push] pywebpush not installed")
            return False

        emoji = {"critical": "🚨", "high": "⚠️", "warning": "⚠️", "info": "ℹ️"}.get(severity, "🔔")
        title = f"{emoji} {device_name + ': ' if device_name else ''}{alert_type.replace('_', ' ').title()}"

        payload = json.dumps({
            "title":    title,
            "body":     message,
            "severity": severity,
            "tag":      f"gps-alert-{alert_type}",
            "icon":     "/icons/icon-192.png",
            "badge":    "/icons/icon-192.png",
            "data":     {"url": "/gps-dashboard.html", "alert_id": alert_id},
        })

        try:
            webpush(
                subscription_info=subscription,
                data=payload,
                vapid_private_key=self._private_key,
                vapid_claims={"sub": self._mailto},
            )
            return True
        except Exception as ex:
            resp = getattr(ex, "response", None)
            if resp and resp.status_code in (404, 410):
                logger.info("[Push] Subscription expired (%s)", resp.status_code)
            else:
                logger.error("[Push] Send failed: %s", ex)
            return False


_push_service: Optional[PushNotificationService] = None


def get_push_service() -> PushNotificationService:
    global _push_service
    if _push_service is None:
        _push_service = PushNotificationService()
    return _push_service
