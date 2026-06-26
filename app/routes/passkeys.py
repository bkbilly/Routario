"""
Passkey / WebAuthn routes.

These endpoints add passwordless authentication while still issuing the same
JWT used by the existing username/password login flow.
"""
import base64
from datetime import datetime, timedelta
from typing import Any, Optional
from urllib.parse import urlparse

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func, select
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from core.audit import write_audit_log
from core.auth import get_current_user
from core.config import get_settings
from core.database import get_db
from core.permissions import ALL_PERMISSIONS, valid_permissions
from models import User, UserPasskey

router = APIRouter(prefix="/api/passkeys", tags=["passkeys"])


class PasskeyOptionsRequest(BaseModel):
    username: Optional[str] = None


class PasskeyVerifyRequest(BaseModel):
    state: str
    credential: dict[str, Any]
    name: Optional[str] = None


class PasskeyUpdateRequest(BaseModel):
    name: str


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64url(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def _origin(request: Request) -> str:
    settings = get_settings()
    if settings.passkey_origin:
        return settings.passkey_origin.rstrip("/")
    return f"{request.url.scheme}://{request.url.netloc}"


def _rp_id(request: Request) -> str:
    settings = get_settings()
    if settings.passkey_rp_id:
        return settings.passkey_rp_id
    return urlparse(_origin(request)).hostname or request.url.hostname or "localhost"


def _state_token(payload: dict[str, Any]) -> str:
    settings = get_settings()
    data = {
        **payload,
        "exp": datetime.utcnow() + timedelta(minutes=5),
    }
    return jwt.encode(data, settings.secret_key, algorithm=settings.algorithm)


def _read_state(token: str, expected_kind: str) -> dict[str, Any]:
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Passkey challenge expired or invalid") from exc
    if payload.get("kind") != expected_kind:
        raise HTTPException(status_code=400, detail="Invalid passkey challenge")
    return payload


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
        "permissions": ALL_PERMISSIONS if user.is_admin else valid_permissions(user.permissions or []),
    }


async def _get_manageable_user(target_user_id: int, current_user: User) -> User:
    db = get_db()
    target = await db.get_user(target_user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target.id == current_user.id:
        return target
    if not current_user.is_admin and "manage_users" not in (current_user.permissions or []):
        raise HTTPException(status_code=403, detail="Permission required: manage_users")
    if current_user.is_company_admin and target.company_id != current_user.company_id:
        raise HTTPException(status_code=403, detail="User does not belong to your company")
    if not current_user.is_admin and not current_user.is_company_admin:
        raise HTTPException(status_code=403, detail="Permission required: manage_users")
    return target


def _passkey_response(item: UserPasskey) -> dict[str, Any]:
    return {
        "id": item.id,
        "user_id": item.user_id,
        "name": item.name or "Passkey",
        "created_at": item.created_at,
        "last_used_at": item.last_used_at,
    }


@router.get("")
async def list_passkeys(current_user: User = Depends(get_current_user)):
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(UserPasskey)
            .where(UserPasskey.user_id == current_user.id)
            .order_by(UserPasskey.created_at.desc())
        )
        return [_passkey_response(item) for item in result.scalars().all()]


@router.get("/users/{user_id}")
async def list_user_passkeys(user_id: int, current_user: User = Depends(get_current_user)):
    target = await _get_manageable_user(user_id, current_user)
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(UserPasskey)
            .where(UserPasskey.user_id == target.id)
            .order_by(UserPasskey.created_at.desc())
        )
        return [_passkey_response(item) for item in result.scalars().all()]


@router.patch("/{passkey_id}")
async def update_passkey(
    passkey_id: int,
    payload: PasskeyUpdateRequest,
    current_user: User = Depends(get_current_user),
):
    db = get_db()
    async with db.get_session() as session:
        item = await session.get(UserPasskey, passkey_id)
        if not item or item.user_id != current_user.id:
            raise HTTPException(status_code=404, detail="Passkey not found")
        item.name = payload.name.strip()[:120] or None
        await session.flush()
        await session.refresh(item)
        return _passkey_response(item)


@router.patch("/users/{user_id}/{passkey_id}")
async def update_user_passkey(
    user_id: int,
    passkey_id: int,
    payload: PasskeyUpdateRequest,
    current_user: User = Depends(get_current_user),
):
    target = await _get_manageable_user(user_id, current_user)
    db = get_db()
    async with db.get_session() as session:
        item = await session.get(UserPasskey, passkey_id)
        if not item or item.user_id != target.id:
            raise HTTPException(status_code=404, detail="Passkey not found")
        item.name = payload.name.strip()[:120] or None
        await session.flush()
        await session.refresh(item)
        return _passkey_response(item)


@router.delete("/{passkey_id}")
async def delete_passkey(passkey_id: int, current_user: User = Depends(get_current_user)):
    db = get_db()
    async with db.get_session() as session:
        item = await session.get(UserPasskey, passkey_id)
        if not item or item.user_id != current_user.id:
            raise HTTPException(status_code=404, detail="Passkey not found")
        await session.delete(item)
    await write_audit_log("passkey.deleted", actor=current_user, target_type="passkey", target_id=str(passkey_id))
    return {"status": "deleted"}


@router.delete("/users/{user_id}/{passkey_id}")
async def delete_user_passkey(user_id: int, passkey_id: int, current_user: User = Depends(get_current_user)):
    target = await _get_manageable_user(user_id, current_user)
    db = get_db()
    async with db.get_session() as session:
        item = await session.get(UserPasskey, passkey_id)
        if not item or item.user_id != target.id:
            raise HTTPException(status_code=404, detail="Passkey not found")
        await session.delete(item)
    await write_audit_log("passkey.deleted", actor=current_user, target_type="passkey", target_id=str(passkey_id))
    return {"status": "deleted"}


@router.post("/register/options")
async def register_options(request: Request, current_user: User = Depends(get_current_user)):
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(UserPasskey).where(UserPasskey.user_id == current_user.id)
        )
        existing = [
            PublicKeyCredentialDescriptor(id=_unb64url(item.credential_id))
            for item in result.scalars().all()
        ]

    options = generate_registration_options(
        rp_id=_rp_id(request),
        rp_name=get_settings().passkey_rp_name,
        user_id=str(current_user.id).encode(),
        user_name=current_user.email or current_user.username,
        user_display_name=current_user.username,
        exclude_credentials=existing,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
    )
    return {
        "state": _state_token({
            "kind": "passkey_register",
            "challenge": _b64url(options.challenge),
            "user_id": current_user.id,
        }),
        "options": options_to_json(options),
    }


@router.post("/register/verify")
async def register_verify(
    payload: PasskeyVerifyRequest,
    request: Request,
    current_user: User = Depends(get_current_user),
):
    state = _read_state(payload.state, "passkey_register")
    if int(state.get("user_id", 0)) != current_user.id:
        raise HTTPException(status_code=400, detail="Passkey challenge does not match this user")

    try:
        verified = verify_registration_response(
            credential=payload.credential,
            expected_challenge=_unb64url(state["challenge"]),
            expected_origin=_origin(request),
            expected_rp_id=_rp_id(request),
            require_user_verification=True,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Passkey registration failed") from exc

    db = get_db()
    async with db.get_session() as session:
        exists = await session.execute(
            select(UserPasskey).where(UserPasskey.credential_id == _b64url(verified.credential_id))
        )
        if exists.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="This passkey is already registered")
        passkey = UserPasskey(
            user_id=current_user.id,
            credential_id=_b64url(verified.credential_id),
            public_key=_b64url(verified.credential_public_key),
            sign_count=verified.sign_count,
            name=(payload.name or "").strip() or None,
        )
        session.add(passkey)
        await session.flush()
        await session.refresh(passkey)

    await write_audit_log("passkey.registered", actor=current_user, request=request, target_type="passkey", target_id=str(passkey.id))
    return {"id": passkey.id, "name": passkey.name or "Passkey"}


@router.post("/login/options")
async def login_options(payload: PasskeyOptionsRequest, request: Request):
    allow_credentials = []
    user_id = None
    identifier = (payload.username or "").strip().lower()
    if identifier:
        db = get_db()
        async with db.get_session() as session:
            result = await session.execute(
                select(User).where(
                    (func.lower(User.username) == identifier) |
                    (func.lower(User.email) == identifier)
                )
            )
            user = result.scalar_one_or_none()
            if user:
                user_id = user.id
                cred_result = await session.execute(
                    select(UserPasskey).where(UserPasskey.user_id == user.id)
                )
                allow_credentials = [
                    PublicKeyCredentialDescriptor(id=_unb64url(item.credential_id))
                    for item in cred_result.scalars().all()
                ]

    options = generate_authentication_options(
        rp_id=_rp_id(request),
        allow_credentials=allow_credentials or None,
        user_verification=UserVerificationRequirement.REQUIRED,
    )
    return {
        "state": _state_token({
            "kind": "passkey_login",
            "challenge": _b64url(options.challenge),
            "user_id": user_id,
        }),
        "options": options_to_json(options),
    }


@router.post("/login/verify")
async def login_verify(payload: PasskeyVerifyRequest, request: Request):
    state = _read_state(payload.state, "passkey_login")
    credential_id = payload.credential.get("id") or payload.credential.get("rawId")
    if not credential_id:
        raise HTTPException(status_code=400, detail="Missing passkey credential")

    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(UserPasskey).where(UserPasskey.credential_id == credential_id)
        )
        passkey = result.scalar_one_or_none()
        if not passkey:
            raise HTTPException(status_code=400, detail="Passkey is not registered")
        if state.get("user_id") and int(state["user_id"]) != passkey.user_id:
            raise HTTPException(status_code=400, detail="Passkey does not belong to this user")
        user = await session.get(User, passkey.user_id)
        if not user:
            raise HTTPException(status_code=400, detail="Passkey user not found")

        try:
            verified = verify_authentication_response(
                credential=payload.credential,
                expected_challenge=_unb64url(state["challenge"]),
                expected_origin=_origin(request),
                expected_rp_id=_rp_id(request),
                credential_public_key=_unb64url(passkey.public_key),
                credential_current_sign_count=passkey.sign_count,
                require_user_verification=True,
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Passkey verification failed") from exc

        passkey.sign_count = verified.new_sign_count
        passkey.last_used_at = datetime.utcnow()
        user.last_login = datetime.utcnow()
        await session.flush()
        response = _token_response(user)

    await write_audit_log("auth.passkey_login", actor=user, request=request)
    return response
