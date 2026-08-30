"""
OpenID Connect single sign-on routes.

This first implementation is intentionally conservative: SSO authenticates
existing Routario users by verified email and does not auto-create accounts.
"""
from datetime import datetime, timedelta
from html import escape
import json
from typing import Any, Optional
from urllib.parse import urlencode

import httpx
import jwt
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from core.audit import write_audit_log
from core.config import get_settings
from core.database import get_db
from core.permissions import ALL_PERMISSIONS, valid_permissions
from models import User

router = APIRouter(prefix="/api/sso", tags=["sso"])
SSO_STATE_COOKIE = "routario_sso_state"


def _enabled_config() -> dict[str, Any]:
    settings = get_settings()
    missing = [
        name for name, value in {
            "SSO_ISSUER_URL": settings.sso_issuer_url,
            "SSO_CLIENT_ID": settings.sso_client_id,
            "SSO_CLIENT_SECRET": settings.sso_client_secret,
        }.items()
        if not value
    ]
    if not settings.sso_enabled or missing:
        raise HTTPException(status_code=404, detail="SSO is not configured")
    return {
        "issuer": settings.sso_issuer_url.rstrip("/"),
        "client_id": settings.sso_client_id,
        "client_secret": settings.sso_client_secret,
        "scopes": settings.sso_scopes or "openid email profile",
    }


def _redirect_uri(request: Request) -> str:
    settings = get_settings()
    if settings.sso_redirect_uri:
        return settings.sso_redirect_uri
    return str(request.url_for("sso_callback"))


def _state_token(request: Request) -> str:
    settings = get_settings()
    return jwt.encode(
        {
            "kind": "sso",
            "exp": datetime.utcnow() + timedelta(minutes=10),
            "redirect_uri": _redirect_uri(request),
        },
        settings.secret_key,
        algorithm=settings.algorithm,
    )


def _read_state(token: str) -> dict[str, Any]:
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    except Exception as exc:
        raise HTTPException(status_code=400, detail="SSO login expired or invalid") from exc
    if payload.get("kind") != "sso":
        raise HTTPException(status_code=400, detail="Invalid SSO login state")
    return payload


async def _discovery(issuer: str) -> dict[str, Any]:
    url = f"{issuer}/.well-known/openid-configuration"
    async with httpx.AsyncClient(timeout=10) as client:
        res = await client.get(url)
        res.raise_for_status()
        return res.json()


def _token_response(user: User) -> dict[str, Any]:
    settings = get_settings()
    token = jwt.encode(
        {
            "sub": str(user.id),
            "name": user.username,
            "is_admin": user.is_admin,
        },
        settings.secret_key,
        algorithm=settings.algorithm,
    )
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
        "permissions": ALL_PERMISSIONS if user.is_admin else valid_permissions(user.permissions or []),
    }


def _allowed_domain(email: str) -> bool:
    settings = get_settings()
    domains = [d.strip().lower().lstrip("@") for d in (settings.sso_allowed_domains or "").split(",") if d.strip()]
    if not domains:
        return True
    domain = email.rsplit("@", 1)[-1].lower() if "@" in email else ""
    return domain in domains


async def _exchange_code(discovery: dict[str, Any], code: str, redirect_uri: str, cfg: dict[str, Any]) -> dict[str, Any]:
    token_endpoint = discovery.get("token_endpoint")
    if not token_endpoint:
        raise HTTPException(status_code=502, detail="SSO provider has no token endpoint")
    async with httpx.AsyncClient(timeout=15) as client:
        res = await client.post(
            token_endpoint,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": cfg["client_id"],
                "client_secret": cfg["client_secret"],
            },
            headers={"Accept": "application/json"},
        )
        if res.status_code >= 400:
            raise HTTPException(status_code=400, detail="SSO token exchange failed")
        return res.json()


async def _userinfo(discovery: dict[str, Any], access_token: str) -> dict[str, Any]:
    userinfo_endpoint = discovery.get("userinfo_endpoint")
    if not userinfo_endpoint:
        raise HTTPException(status_code=502, detail="SSO provider has no userinfo endpoint")
    async with httpx.AsyncClient(timeout=15) as client:
        res = await client.get(
            userinfo_endpoint,
            headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
        )
        if res.status_code >= 400:
            raise HTTPException(status_code=400, detail="SSO user lookup failed")
        return res.json()


def _callback_html(data: dict[str, Any]) -> HTMLResponse:
    items = {
        "auth_token": data["access_token"],
        "user_id": data["user_id"],
        "username": data["username"],
        "is_admin": data["is_admin"],
        "is_company_admin": data.get("is_company_admin") or False,
        "company_id": data.get("company_id") or "",
        "units": data.get("units") or "metric",
        "currency": data.get("currency") or "EUR",
        "theme": data.get("theme") or "dark",
        "sidebar_compact": data.get("sidebar_compact") or False,
        "permissions": data.get("permissions") or [],
    }
    script_data = json.dumps(items)
    response = HTMLResponse(f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Signing in...</title></head>
<body>
<script>
const data = {script_data};
for (const [key, value] of Object.entries(data)) {{
  localStorage.setItem(key, key === 'permissions' ? JSON.stringify(value || []) : String(value));
}}
if (String(data.company_id || '') !== localStorage.getItem('company_login_slug_company_id')) {{
  localStorage.removeItem('company_login_slug');
  localStorage.removeItem('company_login_slug_company_id');
}}
window.location.replace('/gps-dashboard.html');
</script>
</body></html>""")
    response.delete_cookie(SSO_STATE_COOKIE, path="/")
    return response


def _error_html(message: str) -> HTMLResponse:
    safe = escape(message)
    response = HTMLResponse(f"""<!doctype html>
<html><head><meta charset="utf-8"><title>SSO failed</title></head>
<body>
<script>
localStorage.setItem('login_error', {json.dumps(safe)});
window.location.replace('/login.html');
</script>
</body></html>""", status_code=400)
    response.delete_cookie(SSO_STATE_COOKIE, path="/")
    return response


@router.get("/config")
async def sso_config():
    settings = get_settings()
    configured = bool(
        settings.sso_enabled
        and settings.sso_issuer_url
        and settings.sso_client_id
        and settings.sso_client_secret
    )
    return {
        "enabled": configured,
        "provider_name": settings.sso_provider_name or "SSO",
    }


@router.get("/login")
async def sso_login(request: Request):
    cfg = _enabled_config()
    discovery = await _discovery(cfg["issuer"])
    authorization_endpoint = discovery.get("authorization_endpoint")
    if not authorization_endpoint:
        raise HTTPException(status_code=502, detail="SSO provider has no authorization endpoint")
    state = _state_token(request)
    params = {
        "client_id": cfg["client_id"],
        "redirect_uri": _redirect_uri(request),
        "response_type": "code",
        "scope": cfg["scopes"],
        "state": state,
    }
    separator = "&" if "?" in authorization_endpoint else "?"
    response = RedirectResponse(f"{authorization_endpoint}{separator}{urlencode(params)}")
    response.set_cookie(
        SSO_STATE_COOKIE,
        state,
        max_age=600,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
        path="/",
    )
    return response


@router.get("/callback", name="sso_callback")
async def sso_callback(
    request: Request,
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
):
    if error:
        return _error_html(f"SSO provider rejected the login: {error}")
    if not code or not state:
        return _error_html("SSO login did not return a code")
    if request.cookies.get(SSO_STATE_COOKIE) != state:
        return _error_html("SSO login state did not match")

    try:
        cfg = _enabled_config()
        state_data = _read_state(state)
        discovery = await _discovery(cfg["issuer"])
        token_data = await _exchange_code(discovery, code, state_data["redirect_uri"], cfg)
        access_token = token_data.get("access_token")
        if not access_token:
            return _error_html("SSO provider did not return an access token")

        profile = await _userinfo(discovery, access_token)
        email = (profile.get("email") or "").strip().lower()
        if not email:
            return _error_html("SSO account does not expose an email address")
        email_verified = profile.get("email_verified", profile.get("verified_email"))
        if get_settings().sso_require_verified_email and email_verified is not True:
            return _error_html("SSO email address is not verified")
        if not _allowed_domain(email):
            return _error_html("This email domain is not allowed for SSO")

        db = get_db()
        user = await db.get_user_by_email(email)
        if not user:
            await write_audit_log("auth.sso_user_missing", request=request, metadata={"email": email})
            return _error_html("No Routario user exists for this SSO email address")

        async with db.get_session() as session:
            fresh = await session.get(User, user.id)
            if fresh:
                fresh.last_login = datetime.utcnow()

        await write_audit_log("auth.sso_login", actor=user, request=request, metadata={"email": email})
        return _callback_html(_token_response(user))
    except HTTPException as exc:
        return _error_html(str(exc.detail))
    except Exception:
        return _error_html("SSO login failed")
