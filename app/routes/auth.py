"""
Auth Routes
Handles login, passwordless magic links, and token issuance.
"""
from datetime import datetime, timedelta
import logging
import secrets
from typing import Dict, Any

from fastapi import APIRouter, HTTPException, Request, status
import jwt
from sqlalchemy import select, func

from core.audit import write_audit_log
from core.database import get_db
from core.config import get_settings
from core.email import send_email_async
from core.mfa import hash_recovery_code, verify_totp
from models import User
from models.schemas import UserLogin, Token, MagicLinkRequest, MagicLinkVerify

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["auth"])


def _build_user_token_response(user: User, token: str) -> Dict[str, Any]:
    from core.permissions import ALL_PERMISSIONS, valid_permissions
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
        "theme": getattr(user, "theme", "dark") or "dark",
        "sidebar_compact": getattr(user, "sidebar_compact", False) or False,
        "time_format": getattr(user, "time_format", "auto") or "auto",
        "date_format": getattr(user, "date_format", "auto") or "auto",
        "permissions": ALL_PERMISSIONS if user.is_admin else valid_permissions(user.permissions or []),
    }


def _build_mfa_prompt_response(user: User) -> Dict[str, Any]:
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
        "theme": getattr(user, "theme", "dark") or "dark",
        "sidebar_compact": getattr(user, "sidebar_compact", False) or False,
        "time_format": getattr(user, "time_format", "auto") or "auto",
        "date_format": getattr(user, "date_format", "auto") or "auto",
        "permissions": [],
    }


@router.get("/auth-methods", response_model=Dict[str, Any])
async def get_auth_methods():
    """Returns available authentication methods based on server configuration."""
    settings = get_settings()
    smtp_enabled = bool(getattr(settings, "smtp_enabled", False))
    return {
        "email_magic_link": smtp_enabled,
        "passkeys": True,
    }


@router.post("/auth/magic-link/request")
async def request_magic_link(form_data: MagicLinkRequest, request: Request):
    """Sends a one-time passwordless sign-in link via SMTP email if enabled."""
    settings = get_settings()
    smtp_enabled = bool(getattr(settings, "smtp_enabled", False))
    if not smtp_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email sign-in is not enabled on this server.",
        )

    email_clean = (form_data.email or "").strip().lower()
    if not email_clean or "@" not in email_clean:
        raise HTTPException(status_code=400, detail="Please enter a valid email address.")

    db = get_db()
    user = await db.get_user_by_email(email_clean)

    if user:
        token_data = {
            "sub": str(user.id),
            "email": user.email,
            "type": "magic_link",
            "jti": secrets.token_hex(16),
            "exp": datetime.utcnow() + timedelta(minutes=15),
        }
        token = jwt.encode(token_data, settings.secret_key, algorithm=settings.algorithm)

        forwarded_proto = request.headers.get("x-forwarded-proto", request.url.scheme)
        forwarded_host = request.headers.get("x-forwarded-host", request.headers.get("host", request.url.netloc))
        base_url = f"{forwarded_proto}://{forwarded_host}"
        login_url = f"{base_url}/login?magic_token={token}"

        subject = "Sign in to Routario"
        body_text = (
            f"Hello {user.username},\n\n"
            f"Click the link below to sign in to your Routario account (link valid for 15 minutes):\n\n"
            f"{login_url}\n\n"
            f"If you did not request this link, you can safely ignore this email.\n"
        )
        body_html = f"""
        <div style="font-family:'Outfit','Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#131825;color:#e5e7eb;border-radius:16px;border:1px solid #2a3447;">
            <div style="text-align:center;margin-bottom:24px;">
                <h2 style="color:#ffffff;margin:0;font-size:24px;font-weight:700;letter-spacing:-0.02em;">Routario</h2>
                <p style="color:#9ca3af;font-size:13px;margin-top:4px;">GPS Fleet & Telematics Platform</p>
            </div>
            <div style="background:#1a2035;padding:28px 24px;border-radius:12px;border:1px solid #2a3447;text-align:center;">
                <h3 style="color:#ffffff;margin-top:0;font-size:18px;font-weight:600;">Sign in to your account</h3>
                <p style="color:#9ca3af;font-size:14px;line-height:1.5;">Hello <strong style="color:#ffffff;">{user.username}</strong>, click the button below to sign in instantly. This link is valid for 15 minutes.</p>
                <div style="margin:28px 0;">
                    <a href="{login_url}" style="background:linear-gradient(135deg,#3b82f6,#8b5cf6);color:#ffffff;padding:12px 32px;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;display:inline-block;box-shadow:0 4px 12px rgba(59,130,246,0.3);">Sign In to Routario</a>
                </div>
                <p style="color:#6b7280;font-size:12px;margin-bottom:0;">If the button doesn't work, copy and paste this link in your browser:<br><a href="{login_url}" style="color:#3b82f6;word-break:break-all;font-size:11px;">{login_url}</a></p>
            </div>
            <p style="color:#6b7280;font-size:12px;text-align:center;margin-top:20px;">If you didn't request this link, you can safely ignore this email.</p>
        </div>
        """
        await send_email_async([user.email], subject, body_text, body_html)
        await write_audit_log("auth.magic_link_requested", actor=user, request=request, metadata={"email": user.email})
    else:
        await write_audit_log("auth.magic_link_requested_unknown", request=request, metadata={"email": email_clean})

    return {"message": "If an account exists with this email address, a sign-in link has been sent to your inbox."}


@router.post("/auth/magic-link/verify", response_model=Token)
async def verify_magic_link(form_data: MagicLinkVerify, request: Request):
    """Verifies a magic link token and authenticates the user."""
    settings = get_settings()
    try:
        payload = jwt.decode(form_data.token, settings.secret_key, algorithms=[settings.algorithm])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=400, detail="This sign-in link has expired. Please request a new one.")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=400, detail="Invalid sign-in link.")

    if payload.get("type") != "magic_link":
        raise HTTPException(status_code=400, detail="Invalid token type.")

    user_id = int(payload.get("sub", 0))
    token_email = (payload.get("email") or "").lower()

    db = get_db()
    user = await db.get_user(user_id)
    if not user or user.email.lower() != token_email:
        raise HTTPException(status_code=400, detail="User account not found or email has changed.")

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

    await write_audit_log("auth.magic_link_login", actor=user, request=request)
    return _build_user_token_response(user, token)


@router.post("/login", response_model=Token)
async def login(form_data: UserLogin, request: Request):
    db = get_db()
    user = await db.authenticate_user(form_data.username, form_data.password)
    if not user:
        await write_audit_log("auth.login_failed", request=request, metadata={"username": form_data.username})
        raise HTTPException(status_code=400, detail="Incorrect username or password")

    if user.mfa_enabled:
        if not form_data.mfa_code:
            return _build_mfa_prompt_response(user)

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

    await write_audit_log("auth.login", actor=user, request=request)
    return _build_user_token_response(user, token)

