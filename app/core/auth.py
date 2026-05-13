"""
Authentication & Authorization
JWT token validation and role-based access Depends() factories.
"""
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
import jwt

from core.config import get_settings
from core.database import get_db
from models import User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/login")


async def get_current_user(token: str = Depends(oauth2_scheme)) -> User:
    """Validate JWT and return the current User object."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        settings = get_settings()
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        user_id: int = int(payload["sub"])
    except Exception:
        raise credentials_exception

    db = get_db()
    user = await db.get_user(user_id)
    if not user:
        raise credentials_exception
    return user


async def require_admin(current_user: User = Depends(get_current_user)) -> User:
    """Require super admin. Returns the user if allowed."""
    if not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return current_user


async def require_company_admin(current_user: User = Depends(get_current_user)) -> User:
    """Require super admin or company admin."""
    if not current_user.is_admin and not current_user.is_company_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Company admin access required",
        )
    return current_user


async def require_self_or_admin(
    user_id: int,
    current_user: User = Depends(get_current_user),
) -> User:
    """
    Allow the caller if they ARE the target user, a super admin,
    or a company admin managing a user in their own company.
    """
    if current_user.id == user_id or current_user.is_admin:
        return current_user
    if current_user.is_company_admin and current_user.company_id is not None:
        db = get_db()
        target = await db.get_user(user_id)
        if target and target.company_id == current_user.company_id:
            return current_user
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="You do not have permission to access this resource",
    )


async def verify_device_access(
    device_id: int,
    current_user: User = Depends(get_current_user),
) -> User:
    """
    Verify the current user has access to a given device.
    Super admins always pass. Company admins pass for their company's devices.
    Regular users must have the device explicitly assigned.
    """
    if current_user.is_admin:
        return current_user

    db = get_db()

    if current_user.is_company_admin and current_user.company_id is not None:
        device = await db.get_device_by_id(device_id)
        if device and device.company_id == current_user.company_id:
            return current_user

    user_devices = await db.get_user_devices(current_user.id)
    if not any(d.id == device_id for d in user_devices):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to this device",
        )
    return current_user
