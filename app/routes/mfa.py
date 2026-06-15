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


def _require_mfa_permission(user: User) -> None:
    if not user.is_admin and "manage_mfa" not in (user.permissions or []):
        raise HTTPException(status_code=403, detail="Permission required: manage_mfa")


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
