"""
Push Notification API Routes
File location: app/routes/push.py   (create this new file)

Then register in app/main.py:
    from routes.push import router as push_router
    app.include_router(push_router)
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from core.auth import get_current_user, require_company_admin
from core.database import get_db
from core.push_notifications import get_push_service
from models import User
from models.schemas import AlertCreate

router = APIRouter(prefix="/api/users", tags=["push-notifications"])


# ── Pydantic schema for the subscription object sent by the browser ──

class PushKeys(BaseModel):
    p256dh: str
    auth: str

class PushSubscriptionPayload(BaseModel):
    endpoint: str
    keys: PushKeys
    expirationTime: Optional[int] = None

class AdminNotifyPayload(BaseModel):
    title: str
    message: str


# ── Routes ────────────────────────────────────────────────────────

@router.post("/{user_id}/push-subscription")
async def save_push_subscription(
    user_id: int,
    payload: PushSubscriptionPayload,
    current_user: User = Depends(get_current_user),
):
    """
    Called by pwa.js after the user grants notification permission.
    Saves the browser's push subscription to the DB.
    User can only register their own subscription.
    """
    if current_user.id != user_id and not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Forbidden")
    db = get_db()
    push = get_push_service()
    await push.save_subscription(db, user_id, payload.dict())
    return {"status": "subscribed"}


@router.delete("/{user_id}/push-subscription")
async def remove_push_subscription(
    user_id: int,
    current_user: User = Depends(get_current_user),
):
    """Called by pwa.js when the user disables notifications."""
    if current_user.id != user_id and not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Forbidden")
    db = get_db()
    push = get_push_service()
    await push.remove_subscription(db, user_id)
    return {"status": "unsubscribed"}


@router.post("/{user_id}/notify")
async def admin_notify_user(
    user_id: int,
    payload: AdminNotifyPayload,
    current_user: User = Depends(require_company_admin),
):
    """Send a manual notification to a user. Accessible by super admins and company admins."""
    db = get_db()

    # Company admins can only notify users in their own company
    if not current_user.is_admin:
        target = await db.get_user(user_id)
        if not target or target.company_id != current_user.company_id:
            raise HTTPException(status_code=403, detail="Forbidden")

    # Save as an alert record so it appears in the Alerts panel
    alert = await db.create_alert(AlertCreate(
        user_id=user_id,
        device_id=None,
        alert_type="notification",
        severity="warning",
        message=payload.message,
        alert_metadata={"title": payload.title, "sender": current_user.username},
    ))

    # Real-time WebSocket delivery
    from main import ws_manager
    await ws_manager.broadcast_alert(alert)

    # Push notification (best-effort — no error if user has no subscription)
    push = get_push_service()
    push_delivered = await push.notify_user_direct(db, user_id, payload.title, payload.message)

    return {"status": "sent", "push_delivered": push_delivered}

