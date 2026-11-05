"""
Push Notification Service (Web Push / VAPID)
"""
import json
import logging
import math
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import Integer, DateTime, ForeignKey, Text, delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Mapped, mapped_column

from core.db_types import JsonType
from core.config import get_settings
from models.models import Base, Company, User

logger = logging.getLogger(__name__)


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"

    id:           Mapped[int]           = mapped_column(Integer, primary_key=True)
    user_id:      Mapped[int]           = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    endpoint:     Mapped[Optional[str]] = mapped_column(Text, nullable=True, index=True)
    subscription: Mapped[dict]          = mapped_column(JsonType, nullable=False)
    created_at:   Mapped[datetime]      = mapped_column(DateTime, default=datetime.utcnow)
    updated_at:   Mapped[datetime]      = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


def generate_vapid_keypair() -> tuple[str, str]:
    """
    Generate a cryptographically secure ECDSA P-256 keypair formatted for Web Push (VAPID).
    Returns (public_key_b64, private_key_b64).
    """
    import base64
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization

    private_key = ec.generate_private_key(ec.SECP256R1())
    scalar = private_key.private_numbers().private_value
    priv_bytes = scalar.to_bytes(32, "big")
    priv_b64 = base64.urlsafe_b64encode(priv_bytes).decode("ascii").rstrip("=")

    pub_bytes = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    pub_b64 = base64.urlsafe_b64encode(pub_bytes).decode("ascii").rstrip("=")

    return pub_b64, priv_b64


class PushNotificationService:

    def __init__(self):
        pass

    @property
    def _private_key(self) -> str:
        key = getattr(get_settings(), "vapid_private_key", "")
        return key.strip() if key else ""

    @property
    def _public_key(self) -> str:
        key = getattr(get_settings(), "vapid_public_key", "")
        return key.strip() if key else ""

    @property
    def _mailto(self) -> str:
        mailto = getattr(get_settings(), "vapid_mailto", "")
        if mailto and mailto.strip():
            return mailto.strip()
        return "mailto:admin@example.com"

    @property
    def _enabled(self) -> bool:
        return bool(self._private_key and self._public_key)

    async def notify_user_direct(
        self,
        db_service,
        user_id: int,
        title: str,
        message: str,
        alert_id: Optional[int] = None,
        latitude: Optional[float] = None,
        longitude: Optional[float] = None,
    ) -> bool:
        if not self._enabled:
            return False
        subs = await self._get_subscriptions(db_service, user_id)
        if not subs:
            return False
        icon, badge = await self._get_branding_urls(db_service, user_id)
        any_success = False
        for sub_id, subscription in subs:
            ok, _ = await self._send(
                subscription=subscription,
                alert_type="notification",
                message=message,
                severity="info",
                device_name=None,
                alert_id=alert_id,
                icon=icon,
                badge=badge,
                user_id=user_id,
                db_service=db_service,
                title_override=title,
                latitude=latitude,
                longitude=longitude,
                sub_id=sub_id,
            )
            if ok:
                any_success = True
        return any_success

    async def notify_user(
        self,
        db_service,
        user_id: int,
        alert_type: str,
        message: str,
        severity: str = "info",
        device_name: Optional[str] = None,
        alert_id: Optional[int] = None,
        latitude: Optional[float] = None,
        longitude: Optional[float] = None,
    ) -> tuple[bool, Optional[str]]:
        if not self._enabled:
            return False, "Push notifications disabled: VAPID keys not configured on server"
        subs = await self._get_subscriptions(db_service, user_id)
        if not subs:
            return False, f"No active browser subscription found for user {user_id}"
        icon, badge = await self._get_branding_urls(db_service, user_id)
        any_success = False
        last_error = None
        for sub_id, subscription in subs:
            ok, err = await self._send(
                subscription=subscription,
                alert_type=alert_type,
                message=message,
                severity=severity,
                device_name=device_name,
                alert_id=alert_id,
                icon=icon,
                badge=badge,
                user_id=user_id,
                db_service=db_service,
                latitude=latitude,
                longitude=longitude,
                sub_id=sub_id,
            )
            if ok:
                any_success = True
            else:
                last_error = err

        if any_success:
            return True, None
        return False, last_error or "Push delivery failed to all devices"

    async def save_subscription(self, db_service, user_id: int, subscription: dict):
        """
        Upsert a push subscription per (user_id, endpoint).
        Allows a user to have active push subscriptions across multiple devices
        (e.g., mobile phone PWA and desktop browser).
        """
        endpoint = str(subscription.get("endpoint") or "").strip()
        now = datetime.utcnow()

        async with db_service.get_session() as session:
            # Check for existing subscription matching user_id and endpoint
            query = select(PushSubscription).where(PushSubscription.user_id == user_id)
            if endpoint:
                query = query.where(PushSubscription.endpoint == endpoint)
            res = await session.execute(query)
            existing = res.scalars().first()

            if existing:
                existing.subscription = subscription
                existing.endpoint = endpoint or existing.endpoint
                existing.updated_at = now
            else:
                session.add(PushSubscription(
                    user_id=user_id,
                    endpoint=endpoint or None,
                    subscription=subscription,
                    created_at=now,
                    updated_at=now,
                ))

    async def remove_subscription(self, db_service, user_id: int, endpoint: Optional[str] = None):
        async with db_service.get_session() as session:
            stmt = delete(PushSubscription).where(PushSubscription.user_id == user_id)
            if endpoint:
                stmt = stmt.where(PushSubscription.endpoint == endpoint)
            await session.execute(stmt)

    async def remove_subscription_by_id(self, db_service, sub_id: int):
        async with db_service.get_session() as session:
            await session.execute(
                delete(PushSubscription).where(PushSubscription.id == sub_id)
            )

    async def _get_subscriptions(self, db_service, user_id: int) -> list[tuple[int, dict]]:
        async with db_service.get_session() as session:
            result = await session.execute(
                select(PushSubscription).where(PushSubscription.user_id == user_id)
            )
            rows = result.scalars().all()
            return [(r.id, r.subscription) for r in rows if r.subscription]

    async def _get_subscription(self, db_service, user_id: int) -> Optional[dict]:
        subs = await self._get_subscriptions(db_service, user_id)
        return subs[0][1] if subs else None

    async def _get_branding_urls(self, db_service, user_id: int) -> tuple[str, str]:
        icon = "/icons/icon-192.png"
        badge = "/icons/badge-96.png"
        async with db_service.get_session() as session:
            user = await session.get(User, user_id)
            if not user or not user.company_id:
                return icon, badge
            company = await session.get(Company, user.company_id)
            if not company:
                return icon, badge
            version = company.branding_version or 1
            if company.icon_filename:
                icon = f"/branding/company/{company.id}/icon-192.png?v={version}"
            if company.badge_filename:
                badge = f"/branding/company/{company.id}/badge-96.png?v={version}"
        return icon, badge

    async def _send(
        self,
        subscription: dict,
        alert_type: str,
        message: str,
        severity: str,
        device_name: Optional[str],
        alert_id: Optional[int],
        icon: str = "/icons/icon-192.png",
        badge: str = "/icons/badge-96.png",
        user_id: Optional[int] = None,
        db_service: Any = None,
        title_override: Optional[str] = None,
        latitude: Optional[float] = None,
        longitude: Optional[float] = None,
        sub_id: Optional[int] = None,
        ttl_seconds: int = 86400,
    ) -> tuple[bool, Optional[str]]:
        try:
            from pywebpush import webpush, WebPushException
        except ImportError:
            logger.error("[Push] pywebpush not installed")
            return False, "pywebpush library not installed on server"

        if title_override:
            title = title_override
        else:
            emoji = {"critical": "🚨", "high": "⚠️", "warning": "⚠️", "info": "ℹ️"}.get(severity, "🔔")
            title = f"{emoji} {device_name + ': ' if device_name else ''}{alert_type.replace('_', ' ').title()}"

        push_token = None
        if user_id:
            try:
                from core.auth import create_access_token
                from datetime import timedelta
                push_token = create_access_token({"sub": str(user_id)}, expires_delta=timedelta(days=7))
            except Exception:
                pass

        has_coords = (
            latitude is not None
            and longitude is not None
            and not (isinstance(latitude, float) and (math.isnan(latitude) or math.isinf(latitude)))
            and not (isinstance(longitude, float) and (math.isnan(longitude) or math.isinf(longitude)))
        )

        payload = json.dumps({
            "title":           title,
            "body":            message,
            "severity":        severity,
            "tag":             f"gps-alert-{alert_type}",
            "icon":            icon,
            "badge":           badge,
            "has_coordinates": has_coords,
            "data":     {
                "url":             "/gps-dashboard.html",
                "alert_id":        alert_id,
                "token":           push_token,
                "latitude":        latitude if has_coords else None,
                "longitude":       longitude if has_coords else None,
                "has_coordinates": has_coords,
            },
        })

        user_str = f"user {user_id}" if user_id else "unknown user"
        urgency = "high" if severity in ("critical", "high") else "normal"
        try:
            webpush(
                subscription_info=subscription,
                data=payload,
                vapid_private_key=self._private_key,
                vapid_claims={"sub": self._mailto},
                ttl=ttl_seconds,
                headers={
                    "Urgency": urgency,
                    "TTL": str(ttl_seconds),
                },
            )
            return True, None
        except Exception as ex:
            resp = getattr(ex, "response", None)
            status_code = getattr(resp, "status_code", None)
            is_expired = (
                (status_code in (404, 410))
                or ("410" in str(ex))
                or ("404" in str(ex))
                or ("unsubscribed or expired" in str(ex).lower())
            )
            if is_expired:
                logger.info("[Push] Subscription for %s (sub_id=%s) expired (%s)", user_str, sub_id, status_code or 410)
                if db_service:
                    try:
                        if sub_id:
                            await self.remove_subscription_by_id(db_service, sub_id)
                        elif user_id:
                            endpoint = subscription.get("endpoint")
                            await self.remove_subscription(db_service, user_id, endpoint=endpoint)
                    except Exception as clean_ex:
                        logger.warning("[Push] Failed to auto-remove expired subscription for %s: %s", user_str, clean_ex)
                return False, "Browser subscription expired or unsubscribed"
            else:
                logger.error("[Push] Send failed for %s: %s", user_str, ex)
                err_text = str(ex)
                if resp is not None and hasattr(resp, "text"):
                    try:
                        err_text = f"{resp.status_code}: {resp.text}"
                    except Exception:
                        pass
                return False, f"Push delivery failed: {err_text}"


_push_service: Optional[PushNotificationService] = None


def get_push_service() -> PushNotificationService:
    global _push_service
    if _push_service is None:
        _push_service = PushNotificationService()
    return _push_service
