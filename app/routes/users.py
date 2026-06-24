"""
User Routes
CRUD operations for user accounts.

Access rules:
  GET  /api/users          → company admin + manage_users
  POST /api/users          → company admin + manage_users
  GET  /api/users/{id}     → self or admin
  PUT  /api/users/{id}     → self or admin (manage_users required when editing others)
  DELETE /api/users/{id}   → company admin + manage_users
  POST /api/users/{id}/devices     → company admin + manage_users
  POST /api/users/{id}/impersonate → company admin + manage_users
"""
from typing import List

import jwt
from fastapi import APIRouter, HTTPException, Query, Depends
from pydantic import BaseModel
from sqlalchemy import select, delete, update, func
from sqlalchemy.exc import IntegrityError

from core.database import get_db
from core.config import get_settings
from core.auth import get_current_user, require_admin, require_company_admin, require_self_or_admin, require_permission
from core.permissions import cap_permissions, ALL_PERMISSIONS
from notifications import get_channel
from models import User, Driver, user_device_association
from models.schemas import UserCreate, UserUpdate, UserResponse, DeviceResponse
from sqlalchemy import and_

router = APIRouter(prefix="/api/users", tags=["users"])


def _check_manage_users(caller: User):
    """Raise 403 if caller lacks manage_users permission (super admin bypasses)."""
    if not caller.is_admin and "manage_users" not in (caller.permissions or []):
        raise HTTPException(status_code=403, detail="Permission required: manage_users")


def _user_integrity_detail(exc: IntegrityError) -> str:
    msg = str(exc.orig).lower() if getattr(exc, "orig", None) else str(exc).lower()
    if "users.email" in msg or "email" in msg:
        return "Email already exists"
    if "users.username" in msg or "username" in msg:
        return "Username already exists"
    return "User already exists"


class NotificationTestRequest(BaseModel):
    name: str
    url: str


async def _ensure_unique_user_identity(username: str | None = None, email: str | None = None, exclude_user_id: int | None = None):
    db = get_db()
    async with db.get_session() as session:
        if username:
            q = select(User).where(func.lower(User.username) == username.strip().lower())
            if exclude_user_id is not None:
                q = q.where(User.id != exclude_user_id)
            if (await session.execute(q)).scalar_one_or_none():
                raise HTTPException(status_code=400, detail="Username already exists")

        if email:
            q = select(User).where(func.lower(User.email) == email.strip().lower())
            if exclude_user_id is not None:
                q = q.where(User.id != exclude_user_id)
            if (await session.execute(q)).scalar_one_or_none():
                raise HTTPException(status_code=400, detail="Email already exists")


@router.get("", response_model=List[UserResponse])
async def get_all_users(caller: User = Depends(require_company_admin)):
    """Return all users. Super admin sees all; company admin sees own company."""
    _check_manage_users(caller)
    db = get_db()
    async with db.get_session() as session:
        if caller.is_admin:
            result = await session.execute(select(User))
        else:
            result = await session.execute(select(User).where(User.company_id == caller.company_id))
        return result.scalars().all()


@router.post("", response_model=UserResponse)
async def create_user(user_data: UserCreate, caller: User = Depends(require_company_admin)):
    """Create a new user. Permissions are capped to the creator's own permissions."""
    _check_manage_users(caller)
    if not caller.is_admin:
        user_data.company_id = caller.company_id
        user_data.is_admin = False

    # Inherit caller's permissions if none specified; cap to what caller can grant
    if user_data.permissions is None:
        user_data.permissions = list(caller.permissions or []) if not caller.is_admin else []
    else:
        user_data.permissions = cap_permissions(user_data.permissions, caller)

    db = get_db()
    await _ensure_unique_user_identity(username=user_data.username, email=user_data.email)
    try:
        return await db.create_user(user_data)
    except IntegrityError as exc:
        raise HTTPException(status_code=400, detail=_user_integrity_detail(exc)) from exc


@router.get("/{user_id}/devices", response_model=List[DeviceResponse])
async def get_user_devices(user_id: int, caller: User = Depends(require_company_admin)):
    """Get devices assigned to a specific user. Admin or company admin."""
    _check_manage_users(caller)
    db = get_db()
    return await db.get_user_devices(user_id)


@router.post("/{user_id}/notifications/test")
async def test_user_notification_channel(
    user_id: int,
    payload: NotificationTestRequest,
    caller: User = Depends(require_self_or_admin),
):
    """Send a test message through one of the user's saved notification channels."""
    if caller.id != user_id:
        _check_manage_users(caller)

    db = get_db()
    user = await db.get_user(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    channels = user.notification_channels or []
    saved = next(
        (
            channel for channel in channels
            if channel.get("name") == payload.name and channel.get("url") == payload.url
        ),
        None,
    )
    if not saved:
        raise HTTPException(status_code=404, detail="Notification channel not found")

    sender = get_channel(saved["url"])
    if sender is None:
        raise HTTPException(status_code=400, detail="Unsupported notification channel")

    ok = await sender.send(
        saved["url"],
        "Routario test notification",
        "This is a test notification from Routario.",
    )
    if not ok:
        raise HTTPException(status_code=502, detail="Failed to send test notification")
    return {"status": "sent"}


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(user_id: int, caller: User = Depends(require_self_or_admin)):
    db = get_db()
    user = await db.get_user(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.put("/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: int,
    user_data: UserUpdate,
    caller: User = Depends(require_self_or_admin),
):
    """Update user details. Permissions are capped to the editor's own permissions."""
    if not caller.is_admin and user_data.is_admin:
        raise HTTPException(status_code=403, detail="Only admins can grant super admin status")

    # Editing another user requires manage_users
    if caller.id != user_id:
        _check_manage_users(caller)

    # Cap permissions to what caller can grant; preserve permissions caller can't see
    if user_data.permissions is not None and not caller.is_admin:
        db = get_db()
        target = await db.get_user(user_id)
        if target:
            caller_perms = set(caller.permissions or [])
            existing_perms = set(target.permissions or [])
            # Permissions the caller can't manage are preserved unchanged
            unmanageable = existing_perms - caller_perms
            granted = {p for p in user_data.permissions if p in caller_perms}
            user_data.permissions = list(unmanageable | granted)
        else:
            user_data.permissions = cap_permissions(user_data.permissions, caller)

    db = get_db()
    await _ensure_unique_user_identity(email=user_data.email, exclude_user_id=user_id)
    try:
        user = await db.update_user(user_id, user_data)
    except IntegrityError as exc:
        raise HTTPException(status_code=400, detail=_user_integrity_detail(exc)) from exc
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.delete("/{user_id}")
async def delete_user(user_id: int, caller: User = Depends(require_company_admin)):
    """Delete a user. Company admin can delete users in their company."""
    _check_manage_users(caller)
    if caller.id == user_id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    if not caller.is_admin:
        db = get_db()
        target = await db.get_user(user_id)
        if not target or target.company_id != caller.company_id:
            raise HTTPException(status_code=403, detail="Cannot delete a user outside your company")
    db = get_db()
    async with db.get_session() as session:
        # Convert any linked driver to a standalone driver before deleting the user
        await session.execute(
            update(Driver).where(Driver.user_id == user_id).values(user_id=None)
        )
        result = await session.execute(delete(User).where(User.id == user_id))
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="User not found")
    return {"status": "deleted"}


@router.post("/{user_id}/impersonate")
async def impersonate_user(user_id: int, admin: User = Depends(require_company_admin)):
    """Issue a token for another user. Super admin can impersonate anyone; company admin can impersonate regular users in their company."""
    _check_manage_users(admin)
    if admin.id == user_id:
        raise HTTPException(status_code=400, detail="Cannot impersonate yourself")
    db = get_db()
    target = await db.get_user(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if not admin.is_admin:
        if target.company_id != admin.company_id:
            raise HTTPException(status_code=403, detail="Cannot impersonate a user outside your company")
        if target.is_admin:
            raise HTTPException(status_code=403, detail="Cannot impersonate a super admin")

    settings = get_settings()
    token = jwt.encode(
        {"sub": str(target.id), "name": target.username, "is_admin": target.is_admin},
        settings.secret_key,
        algorithm=settings.algorithm,
    )
    from core.permissions import ALL_PERMISSIONS
    import json as _json
    raw_perms = target.permissions or []
    if isinstance(raw_perms, str):
        try:
            raw_perms = _json.loads(raw_perms)
        except Exception:
            raw_perms = []
    return {
        "access_token":     token,
        "token_type":       "bearer",
        "user_id":          target.id,
        "username":         target.username,
        "is_admin":         target.is_admin,
        "is_company_admin": getattr(target, "is_company_admin", False) or False,
        "company_id":       getattr(target, "company_id", None),
        "permissions":      ALL_PERMISSIONS if target.is_admin else raw_perms,
    }


@router.post("/{user_id}/devices")
async def assign_device(
    user_id: int,
    device_id: int = Query(...),
    action: str = Query("add"),
    admin: User = Depends(require_company_admin),
):
    """Assign or remove a device from a user. Admin or company admin."""
    _check_manage_users(admin)
    db = get_db()
    async with db.get_session() as session:
        if action == "add":
            exists = await session.execute(
                user_device_association.select().where(
                    and_(
                        user_device_association.c.user_id == user_id,
                        user_device_association.c.device_id == device_id,
                    )
                )
            )
            if not exists.scalar_one_or_none():
                await session.execute(
                    user_device_association.insert().values(
                        user_id=user_id, device_id=device_id, access_level="user"
                    )
                )
        elif action == "remove":
            await session.execute(
                user_device_association.delete().where(
                    and_(
                        user_device_association.c.user_id == user_id,
                        user_device_association.c.device_id == device_id,
                    )
                )
            )
    return {"status": "success"}
