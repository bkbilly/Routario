"""
User Routes
CRUD operations for user accounts.

Access rules:
  GET  /api/users          → admin only
  POST /api/users          → admin only (create new user)
  GET  /api/users/{id}     → self or admin
  PUT  /api/users/{id}     → self or admin (admin can also toggle is_admin)
  DELETE /api/users/{id}   → admin only
  POST /api/users/{id}/devices     → admin only
  POST /api/users/{id}/impersonate → admin only
"""
from typing import List

import jwt
from fastapi import APIRouter, HTTPException, Query, Depends
from sqlalchemy import select, delete

from core.database import get_db
from core.config import get_settings
from core.auth import get_current_user, require_admin, require_company_admin, require_self_or_admin
from models import User, user_device_association
from models.schemas import UserCreate, UserUpdate, UserResponse, DeviceResponse
from sqlalchemy import and_

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("", response_model=List[UserResponse])
async def get_all_users(caller: User = Depends(require_company_admin)):
    """Return all users. Super admin sees all; company admin sees own company."""
    db = get_db()
    async with db.get_session() as session:
        if caller.is_admin:
            result = await session.execute(select(User))
        else:
            result = await session.execute(select(User).where(User.company_id == caller.company_id))
        return result.scalars().all()


@router.post("", response_model=UserResponse)
async def create_user(user_data: UserCreate, caller: User = Depends(require_company_admin)):
    """Create a new user. Company admin auto-assigns to their company."""
    if not caller.is_admin:
        user_data.company_id = caller.company_id
        user_data.is_admin = False  # company admins cannot create super admins
    db = get_db()
    return await db.create_user(user_data)

@router.get("/{user_id}/devices", response_model=List[DeviceResponse])
async def get_user_devices(user_id: int, caller: User = Depends(require_company_admin)):
    """Get devices assigned to a specific user. Admin or company admin."""
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
    """Update user details. Non-admins cannot change their own is_admin flag."""
    # Prevent privilege escalation by non-admins
    if not caller.is_admin and user_data.is_admin is not None:
        raise HTTPException(status_code=403, detail="Only admins can change admin status")

    db = get_db()
    user = await db.update_user(user_id, user_data)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.delete("/{user_id}")
async def delete_user(user_id: int, caller: User = Depends(require_company_admin)):
    """Delete a user. Company admin can delete users in their company."""
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
async def impersonate_user(user_id: int, admin: User = Depends(require_admin)):
    """Issue a token for another user. Admin only."""
    if admin.id == user_id:
        raise HTTPException(status_code=400, detail="Cannot impersonate yourself")
    db = get_db()
    target = await db.get_user(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    settings = get_settings()
    token = jwt.encode(
        {"sub": str(target.id), "name": target.username, "is_admin": target.is_admin},
        settings.secret_key,
        algorithm=settings.algorithm,
    )
    return {
        "access_token":     token,
        "token_type":       "bearer",
        "user_id":          target.id,
        "username":         target.username,
        "is_admin":         target.is_admin,
        "is_company_admin": getattr(target, "is_company_admin", False) or False,
        "company_id":       getattr(target, "company_id", None),
    }


@router.post("/{user_id}/devices")
async def assign_device(
    user_id: int,
    device_id: int = Query(...),
    action: str = Query("add"),
    admin: User = Depends(require_company_admin),
):
    """Assign or remove a device from a user. Admin or company admin."""
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
