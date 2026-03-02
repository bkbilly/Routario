"""
Location Share Routes
Allows authenticated users to generate temporary, token-based links
to share a single device's live location with anyone (no login required).
"""
import secrets
from datetime import datetime, timedelta
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Depends, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy import select, delete

from core.database import get_db
from core.auth import get_current_user, verify_device_access
from models import User, LocationShare, Device, DeviceState
from models.schemas import DeviceStateResponse

router = APIRouter(prefix="/api/share", tags=["share"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class ShareCreateRequest(BaseModel):
    device_id: int
    duration_minutes: int  # 15, 60, 240, 1440, or custom


class ShareCreateResponse(BaseModel):
    token: str
    url: str
    expires_at: datetime
    device_name: str

class ShareListItem(BaseModel):
    token: str
    url: str
    expires_at: datetime
    created_at: datetime

class ShareRenewRequest(BaseModel):
    duration_minutes: int


# ── Create share token (authenticated) ───────────────────────────────────────

@router.post("", response_model=ShareCreateResponse)
async def create_share(
    payload: ShareCreateRequest,
    current_user: User = Depends(get_current_user),
):
    """Generate a unique share token for a device. User must have access to the device."""
    # Verify device access
    db = get_db()
    if not current_user.is_admin:
        user_devices = await db.get_user_devices(current_user.id)
        if not any(d.id == payload.device_id for d in user_devices):
            raise HTTPException(status_code=403, detail="You do not have access to this device")

    # Validate duration (1 min to 7 days)
    if payload.duration_minutes < 1 or payload.duration_minutes > 10080:
        raise HTTPException(status_code=400, detail="Duration must be between 1 and 10080 minutes")

    async with db.get_session() as session:
        # Get device name
        device_result = await session.execute(
            select(Device).where(Device.id == payload.device_id)
        )
        device = device_result.scalar_one_or_none()
        if not device:
            raise HTTPException(status_code=404, detail="Device not found")

        # Generate a secure random token
        token = secrets.token_urlsafe(32)
        expires_at = datetime.utcnow() + timedelta(minutes=payload.duration_minutes)

        share = LocationShare(
            token=token,
            device_id=payload.device_id,
            created_by=current_user.id,
            expires_at=expires_at,
            is_active=True,
        )
        session.add(share)
        await session.flush()

    return ShareCreateResponse(
        token=token,
        url=f"/share/{token}",
        expires_at=expires_at,
        device_name=device.name,
    )


# ── Revoke a share token (authenticated) ─────────────────────────────────────

@router.delete("/{token}")
async def revoke_share(token: str, current_user: User = Depends(get_current_user)):
    """Revoke a share token early. Only the creator or an admin can revoke."""
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(LocationShare).where(LocationShare.token == token)
        )
        share = result.scalar_one_or_none()
        if not share:
            raise HTTPException(status_code=404, detail="Share not found")
        if share.created_by != current_user.id and not current_user.is_admin:
            raise HTTPException(status_code=403, detail="Not allowed")
        share.is_active = False
        await session.flush()
    return {"status": "revoked"}

# ── List active shares for a device (authenticated) ──────────────────────────

@router.get("", response_model=List[ShareListItem])
async def list_shares(
    device_id: int = Query(...),
    current_user: User = Depends(get_current_user),
):
    """List all active, non-expired share links for a device."""
    db = get_db()
    async with db.get_session() as session:
        if not current_user.is_admin:
            user_devices = await db.get_user_devices(current_user.id)
            if not any(d.id == device_id for d in user_devices):
                raise HTTPException(status_code=403, detail="Access denied")

        result = await session.execute(
            select(LocationShare).where(
                LocationShare.device_id == device_id,
                LocationShare.created_by == current_user.id,
                LocationShare.is_active == True,
                LocationShare.expires_at > datetime.utcnow(),
            )
        )
        shares = result.scalars().all()

    return [
        ShareListItem(
            token=s.token,
            url=f"/share/{s.token}",
            expires_at=s.expires_at,
            created_at=s.created_at,
        )
        for s in shares
    ]


# ── Renew a share token (authenticated) ──────────────────────────────────────

@router.patch("/{token}/renew")
async def renew_share(
    token: str,
    payload: ShareRenewRequest,
    current_user: User = Depends(get_current_user),
):
    """Extend the expiry of a share link from now."""
    if payload.duration_minutes < 1 or payload.duration_minutes > 10080:
        raise HTTPException(status_code=400, detail="Invalid duration")

    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(LocationShare).where(LocationShare.token == token)
        )
        share = result.scalar_one_or_none()
        if not share:
            raise HTTPException(status_code=404, detail="Share not found")
        if share.created_by != current_user.id and not current_user.is_admin:
            raise HTTPException(status_code=403, detail="Not allowed")

        share.expires_at = datetime.utcnow() + timedelta(minutes=payload.duration_minutes)
        share.is_active = True
        await session.flush()

    return {"status": "renewed", "expires_at": share.expires_at}


# ── Public API: get position via token (no auth) ──────────────────────────────

@router.get("/{token}/position")
async def get_shared_position(token: str):
    """
    Public endpoint. Returns the live position of the shared device.
    No authentication required — validated only by the token + expiry.
    """
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(LocationShare).where(LocationShare.token == token)
        )
        share = result.scalar_one_or_none()

        if not share:
            raise HTTPException(status_code=404, detail="Invalid share link")
        if not share.is_active:
            raise HTTPException(status_code=410, detail="This share link has been revoked")
        if datetime.utcnow() > share.expires_at:
            raise HTTPException(status_code=410, detail="This share link has expired")

        # Get device info + state
        device_result = await session.execute(
            select(Device).where(Device.id == share.device_id)
        )
        device = device_result.scalar_one_or_none()

        state_result = await session.execute(
            select(DeviceState).where(DeviceState.device_id == share.device_id)
        )
        state = state_result.scalar_one_or_none()

        if not device or not state:
            raise HTTPException(status_code=404, detail="Device data unavailable")

        return {
            "device_name": device.name,
            "vehicle_type": device.vehicle_type,
            "latitude": state.last_latitude,
            "longitude": state.last_longitude,
            "speed": state.last_speed,
            "course": state.last_course,
            "ignition_on": state.ignition_on,
            "is_moving": state.is_moving,
            "last_update": state.last_update,
            "expires_at": share.expires_at,
        }


# ── Public share page (no auth, serves HTML) ─────────────────────────────────

# Separate router for the public HTML page (no /api prefix)
page_router = APIRouter(tags=["share-page"])

@page_router.get("/share/{token}", response_class=HTMLResponse)
async def share_page(token: str):
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(LocationShare).where(LocationShare.token == token)
        )
        share = result.scalar_one_or_none()
        if not share or not share.is_active or datetime.utcnow() > share.expires_at:
            return HTMLResponse(content=_expired_html(), status_code=410)

    with open("web/share.html", "r") as f:
        html = f.read()
    return HTMLResponse(content=html)


def _expired_html() -> str:
    return """<!DOCTYPE html>
<html>
<head><title>Link Expired</title>
<style>
  body { font-family: sans-serif; background: #0a0e1a; color: #e5e7eb;
         display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .box { text-align: center; }
  .icon { font-size: 4rem; margin-bottom: 1rem; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  p { color: #9ca3af; }
</style>
</head>
<body>
  <div class="box">
    <div class="icon">🔗</div>
    <h1>This link has expired or been revoked</h1>
    <p>Ask the sender to generate a new share link.</p>
  </div>
</body>
</html>"""
