from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import desc, select

from core.api_keys import generate_api_key, hash_api_key
from core.audit import write_audit_log
from core.auth import get_current_user
from core.database import get_db
from models import ApiKey, User

router = APIRouter(prefix="/api/api-keys", tags=["api-keys"])

DEFAULT_SCOPES = [
    "devices:read",
    "positions:read",
    "reports:read",
]
ALL_SCOPES = [
    "devices:read",
    "devices:write",
    "positions:read",
    "commands:send",
    "reports:read",
    "routes:read",
    "routes:write",
    "billing:read",
]


class ApiKeyCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    scopes: list[str] = Field(default_factory=lambda: DEFAULT_SCOPES.copy())
    expires_at: Optional[datetime] = None
    user_id: Optional[int] = None


class ApiKeyUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    scopes: Optional[list[str]] = None
    is_active: Optional[bool] = None
    expires_at: Optional[datetime] = None


def _serialize(key: ApiKey) -> dict:
    return {
        "id": key.id,
        "name": key.name,
        "user_id": key.user_id,
        "company_id": key.company_id,
        "key_prefix": key.key_prefix,
        "scopes": key.scopes or [],
        "is_active": key.is_active,
        "expires_at": key.expires_at,
        "last_used_at": key.last_used_at,
        "last_used_ip": key.last_used_ip,
        "created_at": key.created_at,
        "revoked_at": key.revoked_at,
    }


def _validate_scopes(scopes: list[str]) -> list[str]:
    invalid = [s for s in scopes if s not in ALL_SCOPES]
    if invalid:
        raise HTTPException(status_code=400, detail=f"Invalid scopes: {', '.join(invalid)}")
    return sorted(set(scopes))


def _require_api_key_permission(user: User) -> None:
    if not user.is_admin and "manage_api_keys" not in (user.permissions or []):
        raise HTTPException(status_code=403, detail="Permission required: manage_api_keys")


@router.get("/scopes")
async def list_api_key_scopes(current_user: User = Depends(get_current_user)):
    _require_api_key_permission(current_user)
    return {"scopes": ALL_SCOPES}


@router.get("")
async def list_api_keys(current_user: User = Depends(get_current_user)):
    _require_api_key_permission(current_user)
    db = get_db()
    async with db.get_session() as session:
        q = select(ApiKey).order_by(desc(ApiKey.created_at))
        if current_user.is_admin:
            pass
        elif current_user.is_company_admin:
            q = q.where(ApiKey.company_id == current_user.company_id)
        else:
            q = q.where(ApiKey.user_id == current_user.id)
        result = await session.execute(q)
        return [_serialize(k) for k in result.scalars().all()]


@router.post("")
async def create_api_key(data: ApiKeyCreate, request: Request, current_user: User = Depends(get_current_user)):
    _require_api_key_permission(current_user)
    scopes = _validate_scopes(data.scopes)
    db = get_db()
    target_user_id = (
        (data.user_id or current_user.id)
        if (current_user.is_admin or current_user.is_company_admin)
        else current_user.id
    )
    async with db.get_session() as session:
        target = await session.get(User, target_user_id)
        if not target:
            raise HTTPException(status_code=404, detail="User not found")
        if current_user.is_company_admin and not current_user.is_admin and target.company_id != current_user.company_id:
            raise HTTPException(status_code=403, detail="Cannot create API keys for another company")
        if not current_user.is_admin and not current_user.is_company_admin and target.id != current_user.id:
            raise HTTPException(status_code=403, detail="Cannot create API keys for another user")
        raw_key = generate_api_key()
        key = ApiKey(
            user_id=target.id,
            company_id=target.company_id,
            name=data.name,
            key_prefix=raw_key[:12],
            key_hash=hash_api_key(raw_key),
            scopes=scopes,
            expires_at=data.expires_at,
        )
        session.add(key)
        await session.flush()
        await session.refresh(key)
        payload = _serialize(key)
    await write_audit_log(
        "api_key.created",
        actor=current_user,
        company_id=payload["company_id"],
        target_type="api_key",
        target_id=payload["id"],
        request=request,
        metadata={"name": data.name, "scopes": scopes},
    )
    payload["key"] = raw_key
    return payload


@router.put("/{key_id}")
async def update_api_key(key_id: int, data: ApiKeyUpdate, request: Request, current_user: User = Depends(get_current_user)):
    _require_api_key_permission(current_user)
    db = get_db()
    async with db.get_session() as session:
        key = await session.get(ApiKey, key_id)
        if not key:
            raise HTTPException(status_code=404, detail="API key not found")
        if current_user.is_admin:
            pass
        elif current_user.is_company_admin and key.company_id == current_user.company_id:
            pass
        elif key.user_id == current_user.id:
            pass
        else:
            raise HTTPException(status_code=403, detail="Forbidden")
        if data.name is not None:
            key.name = data.name
        if data.scopes is not None:
            key.scopes = _validate_scopes(data.scopes)
        if data.is_active is not None:
            key.is_active = data.is_active
            if not data.is_active and key.revoked_at is None:
                key.revoked_at = datetime.utcnow()
        if "expires_at" in data.model_fields_set:
            key.expires_at = data.expires_at
        await session.flush()
        await session.refresh(key)
        payload = _serialize(key)
    await write_audit_log("api_key.updated", actor=current_user, company_id=payload["company_id"], target_type="api_key", target_id=key_id, request=request)
    return payload


@router.delete("/{key_id}")
async def revoke_api_key(key_id: int, request: Request, current_user: User = Depends(get_current_user)):
    _require_api_key_permission(current_user)
    db = get_db()
    async with db.get_session() as session:
        key = await session.get(ApiKey, key_id)
        if not key:
            raise HTTPException(status_code=404, detail="API key not found")
        if current_user.is_admin:
            pass
        elif current_user.is_company_admin and key.company_id == current_user.company_id:
            pass
        elif key.user_id == current_user.id:
            pass
        else:
            raise HTTPException(status_code=403, detail="Forbidden")
        key.is_active = False
        key.revoked_at = datetime.utcnow()
        company_id = key.company_id
    await write_audit_log("api_key.revoked", actor=current_user, company_id=company_id, target_type="api_key", target_id=key_id, request=request)
    return {"status": "revoked"}
