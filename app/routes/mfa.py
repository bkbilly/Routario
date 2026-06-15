from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core.audit import write_audit_log
from core.auth import get_current_user
from core.database import get_db
from core.mfa import (
    generate_recovery_codes,
    generate_totp_secret,
    hash_recovery_code,
    provisioning_uri,
    verify_totp,
)
from models import User

router = APIRouter(prefix="/api/mfa", tags=["mfa"])


class MfaVerifyRequest(BaseModel):
    code: str


class MfaOptionalVerifyRequest(BaseModel):
    code: str | None = None


def _require_mfa_permission(user: User) -> None:
    if not user.is_admin and "manage_mfa" not in (user.permissions or []):
        raise HTTPException(status_code=403, detail="Permission required: manage_mfa")


async def _get_manageable_user(target_user_id: int, current_user: User) -> User:
    _require_mfa_permission(current_user)
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


@router.post("/setup")
async def setup_mfa(current_user: User = Depends(get_current_user)):
    _require_mfa_permission(current_user)
    if current_user.mfa_enabled:
        raise HTTPException(status_code=400, detail="MFA is already enabled")
    secret = generate_totp_secret()
    recovery_codes = generate_recovery_codes()
    db = get_db()
    async with db.get_session() as session:
        user = await session.get(User, current_user.id)
        user.mfa_secret = secret
        user.mfa_recovery_codes = [hash_recovery_code(c) for c in recovery_codes]
    await write_audit_log("mfa.setup_started", actor=current_user, target_type="user", target_id=current_user.id)
    return {
        "secret": secret,
        "provisioning_uri": provisioning_uri(secret, current_user.username),
        "recovery_codes": recovery_codes,
    }


@router.post("/enable")
async def enable_mfa(data: MfaVerifyRequest, current_user: User = Depends(get_current_user)):
    _require_mfa_permission(current_user)
    if current_user.mfa_enabled:
        return {"status": "enabled"}
    if not current_user.mfa_secret or not verify_totp(current_user.mfa_secret, data.code):
        raise HTTPException(status_code=400, detail="Invalid MFA code")
    db = get_db()
    async with db.get_session() as session:
        user = await session.get(User, current_user.id)
        user.mfa_enabled = True
    await write_audit_log("mfa.enabled", actor=current_user, target_type="user", target_id=current_user.id)
    return {"status": "enabled"}


@router.post("/disable")
async def disable_mfa(data: MfaVerifyRequest, current_user: User = Depends(get_current_user)):
    _require_mfa_permission(current_user)
    valid = False
    if current_user.mfa_secret and verify_totp(current_user.mfa_secret, data.code):
        valid = True
    elif hash_recovery_code(data.code) in (current_user.mfa_recovery_codes or []):
        valid = True
    if not valid:
        raise HTTPException(status_code=400, detail="Invalid MFA code")
    db = get_db()
    async with db.get_session() as session:
        user = await session.get(User, current_user.id)
        user.mfa_enabled = False
        user.mfa_secret = None
        user.mfa_recovery_codes = []
    await write_audit_log("mfa.disabled", actor=current_user, target_type="user", target_id=current_user.id)
    return {"status": "disabled"}


@router.get("/status")
async def mfa_status(current_user: User = Depends(get_current_user)):
    _require_mfa_permission(current_user)
    return {"enabled": bool(current_user.mfa_enabled)}


@router.get("/users/{user_id}/status")
async def user_mfa_status(user_id: int, current_user: User = Depends(get_current_user)):
    target = await _get_manageable_user(user_id, current_user)
    return {"user_id": target.id, "enabled": bool(target.mfa_enabled)}


@router.post("/users/{user_id}/setup")
async def setup_user_mfa(user_id: int, current_user: User = Depends(get_current_user)):
    target = await _get_manageable_user(user_id, current_user)
    if target.mfa_enabled:
        raise HTTPException(status_code=400, detail="MFA is already enabled")
    secret = generate_totp_secret()
    recovery_codes = generate_recovery_codes()
    db = get_db()
    async with db.get_session() as session:
        user = await session.get(User, target.id)
        user.mfa_secret = secret
        user.mfa_recovery_codes = [hash_recovery_code(c) for c in recovery_codes]
    await write_audit_log("mfa.setup_started", actor=current_user, target_type="user", target_id=target.id)
    return {
        "secret": secret,
        "provisioning_uri": provisioning_uri(secret, target.username),
        "recovery_codes": recovery_codes,
    }


@router.post("/users/{user_id}/enable")
async def enable_user_mfa(user_id: int, data: MfaVerifyRequest, current_user: User = Depends(get_current_user)):
    target = await _get_manageable_user(user_id, current_user)
    if target.mfa_enabled:
        return {"status": "enabled"}
    if not target.mfa_secret or not verify_totp(target.mfa_secret, data.code):
        raise HTTPException(status_code=400, detail="Invalid MFA code")
    db = get_db()
    async with db.get_session() as session:
        user = await session.get(User, target.id)
        user.mfa_enabled = True
    await write_audit_log("mfa.enabled", actor=current_user, target_type="user", target_id=target.id)
    return {"status": "enabled"}


@router.post("/users/{user_id}/disable")
async def disable_user_mfa(user_id: int, data: MfaOptionalVerifyRequest, current_user: User = Depends(get_current_user)):
    target = await _get_manageable_user(user_id, current_user)
    if target.id == current_user.id:
        code = (data.code or "").strip()
        valid = False
        if target.mfa_secret and verify_totp(target.mfa_secret, code):
            valid = True
        elif hash_recovery_code(code) in (target.mfa_recovery_codes or []):
            valid = True
        if not valid:
            raise HTTPException(status_code=400, detail="Invalid MFA code")
    db = get_db()
    async with db.get_session() as session:
        user = await session.get(User, target.id)
        user.mfa_enabled = False
        user.mfa_secret = None
        user.mfa_recovery_codes = []
    await write_audit_log("mfa.disabled", actor=current_user, target_type="user", target_id=target.id)
    return {"status": "disabled"}
