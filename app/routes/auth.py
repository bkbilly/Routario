"""
Auth Routes
Handles login and token issuance.
"""
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request
import jwt

from core.audit import write_audit_log
from core.database import get_db
from core.config import get_settings
from core.mfa import hash_recovery_code, verify_totp
from models import User
from models.schemas import UserLogin, Token

router = APIRouter(prefix="/api", tags=["auth"])


@router.post("/login", response_model=Token)
async def login(form_data: UserLogin, request: Request):
    db = get_db()
    user = await db.authenticate_user(form_data.username, form_data.password)
    if not user:
        await write_audit_log("auth.login_failed", request=request, metadata={"username": form_data.username})
        raise HTTPException(status_code=400, detail="Incorrect username or password")

    if user.mfa_enabled:
        if not form_data.mfa_code:
            return {
                "access_token": "",
                "token_type": "bearer",
                "user_id": user.id,
                "username": user.username,
                "is_admin": user.is_admin,
                "mfa_required": True,
                "is_company_admin": getattr(user, "is_company_admin", False) or False,
                "company_id": getattr(user, "company_id", None),
                "units": getattr(user, "units", "metric") or "metric",
                "currency": getattr(user, "currency", "EUR") or "EUR",
                "permissions": [],
            }

        valid_mfa = False
        code = form_data.mfa_code.strip()
        if user.mfa_secret and verify_totp(user.mfa_secret, code):
            valid_mfa = True
        else:
            hashed = hash_recovery_code(code)
            recovery_codes = user.mfa_recovery_codes or []
            if hashed in recovery_codes:
                valid_mfa = True
                async with db.get_session() as session:
                    fresh = await session.get(User, user.id)
                    if fresh:
                        fresh.mfa_recovery_codes = [c for c in (fresh.mfa_recovery_codes or []) if c != hashed]

        if not valid_mfa:
            await write_audit_log("auth.mfa_failed", actor=user, request=request)
            raise HTTPException(status_code=400, detail="Invalid MFA code")

    settings = get_settings()
    token_data = {
        "sub": str(user.id),
        "name": user.username,
        "is_admin": user.is_admin,
    }
    token = jwt.encode(token_data, settings.secret_key, algorithm=settings.algorithm)

    async with db.get_session() as session:
        fresh = await session.get(User, user.id)
        if fresh:
            fresh.last_login = datetime.utcnow()

    from core.permissions import ALL_PERMISSIONS, valid_permissions
    await write_audit_log("auth.login", actor=user, request=request)
    return {
        "access_token": token,
        "token_type": "bearer",
        "user_id": user.id,
        "username": user.username,
        "is_admin": user.is_admin,
        "mfa_required": False,
        "is_company_admin": getattr(user, "is_company_admin", False) or False,
        "company_id": getattr(user, "company_id", None),
        "units": getattr(user, "units", "metric") or "metric",
        "currency": getattr(user, "currency", "EUR") or "EUR",
        "permissions": ALL_PERMISSIONS if user.is_admin else valid_permissions(user.permissions or []),
    }
