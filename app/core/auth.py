"""
Authentication & Authorization
JWT token validation and role-based access Depends() factories.
"""
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import jwt

from core.api_keys import authenticate_api_key
from core.config import get_settings
from core.database import get_db
from core.audit import request_ip
from models import User

bearer_scheme = HTTPBearer(
    scheme_name="Routario API Key",
    description=(
        "Paste a Routario API key created in User Settings -> API Keys, "
        "for example `rt_...`. JWT bearer tokens from `/api/login` are also accepted. "
        "Do not include the `Bearer` prefix; Swagger adds it automatically."
    ),
    auto_error=False,
)


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> User:
    """Validate JWT and return the current User object."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if not credentials:
        raise credentials_exception
    token = credentials.credentials

    api_user, api_key = await authenticate_api_key(token, request_ip(request))
    if api_user and api_key:
        request.state.api_key = api_key
        await get_db().touch_user_activity(api_user.id, interval_minutes=15)
        return api_user

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
    await db.touch_user_activity(user.id, interval_minutes=15)
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


def require_permission(perm: str):
    """Return a FastAPI Depends factory that enforces a named permission.
    Super admins bypass all permission checks."""
    async def checker(current_user: User = Depends(get_current_user)) -> User:
        if current_user.is_admin:
            return current_user
        if perm not in (current_user.permissions or []):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permission required: {perm}",
            )
        return current_user
    return checker


def require_api_scope(scope: str):
    """Require a scope when authenticated with an API key; JWT users pass through."""
    async def checker(request: Request, current_user: User = Depends(get_current_user)) -> User:
        api_key = getattr(request.state, "api_key", None)
        if api_key and scope not in (api_key.scopes or []):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"API key scope required: {scope}",
            )
        return current_user
    return checker


def require_api_scope_or_permission(scope: str, perm: str):
    """Require API-key scope for API keys, or a user permission for JWT users."""
    async def checker(request: Request, current_user: User = Depends(get_current_user)) -> User:
        api_key = getattr(request.state, "api_key", None)
        if api_key:
            if scope not in (api_key.scopes or []):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail=f"API key scope required: {scope}",
                )
            return current_user
        if current_user.is_admin or perm in (current_user.permissions or []):
            return current_user
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Permission required: {perm}",
        )
    return checker
