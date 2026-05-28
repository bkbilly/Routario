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
from sqlalchemy import select, delete

from core.database import get_db
from core.config import get_settings
from core.auth import get_current_user, require_admin, require_company_admin, require_self_or_admin, require_permission
from core.permissions import cap_permissions, ALL_PERMISSIONS
from models import User, user_device_association
from models.schemas import UserCreate, UserUpdate, UserResponse, DeviceResponse
from sqlalchemy import and_

router = APIRouter(prefix="/api/users", tags=["users"])


def _check_manage_users(caller: User):
    """Raise 403 if caller lacks manage_users permission (super admin bypasses)."""
    if not caller.is_admin and "manage_users" not in (caller.permissions or []):
        raise HTTPException(status_code=403, detail="Permission required: manage_users")


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
    return await db.create_user(user_data)


@router.get("/{user_id}/devices", response_model=List[DeviceResponse])
async def get_user_devices(user_id: int, caller: User = Depends(require_company_admin)):
    """Get devices assigned to a specific user. Admin or company admin."""
    _check_manage_users(caller)
    db = get_db()
    return await db.get_user_devices(user_id)


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
    if not caller.is_admin and user_data.is_admin is not None:
        raise HTTPException(status_code=403, detail="Only admins can change admin status")

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
    user = await db.update_user(user_id, user_data)
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
    return {
        "access_token":     token,
        "token_type":       "bearer",
        "user_id":          target.id,
        "username":         target.username,
        "is_admin":         target.is_admin,
        "is_company_admin": getattr(target, "is_company_admin", False) or False,
        "company_id":       getattr(target, "company_id", None),
        "permissions":      ALL_PERMISSIONS if target.is_admin else (target.permissions or []),
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
