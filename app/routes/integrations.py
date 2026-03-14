"""
app/routes/integrations.py

API endpoints for managing integration accounts and provider metadata.

GET  /api/integrations/providers
    → List all registered providers with their field definitions.
    Used by the frontend to build the dynamic credential form.

GET  /api/integrations/accounts
    → List the current user's IntegrationAccounts (credentials redacted).

POST /api/integrations/accounts
    → Create or reuse an IntegrationAccount.
    If an account with the same (provider_id, account_label) already exists
    for this user, the existing account id is returned instead of creating
    a duplicate — this is the credential-sharing mechanism.

DELETE /api/integrations/accounts/{account_id}
    → Deactivate an account (soft delete).

POST /api/integrations/accounts/{account_id}/test
    → Test credentials without saving — calls provider.test_credentials().

GET  /api/integrations/accounts/{account_id}/devices
    → List remote devices visible on that account (calls list_remote_devices).
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select, update

from core.auth import get_current_user
from core.database import get_db
from integrations.integration_model import IntegrationAccount
from integrations.registry import IntegrationRegistry
from integrations.engine import _get_auth
from models import User

router = APIRouter(prefix="/api/integrations", tags=["integrations"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class AccountCreate(BaseModel):
    provider_id:   str
    account_label: str
    credentials:   Dict[str, Any]


class AccountResponse(BaseModel):
    id:            int
    provider_id:   str
    account_label: str
    is_active:     bool
    last_auth_at:  Optional[datetime]
    last_error:    Optional[str]
    created_at:    datetime

    class Config:
        from_attributes = True


class TestCredentialsRequest(BaseModel):
    provider_id:  str
    credentials:  Dict[str, Any]


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/providers")
async def list_providers():
    """Return metadata for all registered integration providers."""
    return IntegrationRegistry.all()


@router.get("/accounts", response_model=List[AccountResponse])
async def list_accounts(current_user: User = Depends(get_current_user)):
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(IntegrationAccount).where(
                IntegrationAccount.user_id   == current_user.id,
                IntegrationAccount.is_active == True,
            )
        )
        return result.scalars().all()


@router.post("/accounts", response_model=AccountResponse, status_code=status.HTTP_201_CREATED)
async def create_account(
    body: AccountCreate,
    current_user: User = Depends(get_current_user),
):
    """
    Create a new IntegrationAccount or return the existing one if credentials
    for this (provider, label) already exist — enabling credential sharing.
    """
    if not IntegrationRegistry.get(body.provider_id):
        raise HTTPException(status_code=400, detail=f"Unknown provider: {body.provider_id}")

    db = get_db()
    async with db.get_session() as session:
        # Check for existing account with same label
        result = await session.execute(
            select(IntegrationAccount).where(
                IntegrationAccount.user_id       == current_user.id,
                IntegrationAccount.provider_id   == body.provider_id,
                IntegrationAccount.account_label == body.account_label,
            )
        )
        existing = result.scalar_one_or_none()

        if existing:
            # Update credentials in case they changed, then return existing
            await session.execute(
                update(IntegrationAccount)
                .where(IntegrationAccount.id == existing.id)
                .values(credentials=body.credentials, is_active=True, last_error=None)
            )
            await session.flush()
            await session.refresh(existing)
            return existing

        account = IntegrationAccount(
            user_id=current_user.id,
            provider_id=body.provider_id,
            account_label=body.account_label,
            credentials=body.credentials,
        )
        session.add(account)
        await session.flush()
        await session.refresh(account)
        return account


@router.delete("/accounts/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(
    account_id: int,
    current_user: User = Depends(get_current_user),
):
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(IntegrationAccount).where(
                IntegrationAccount.id      == account_id,
                IntegrationAccount.user_id == current_user.id,
            )
        )
        account = result.scalar_one_or_none()
        if not account:
            raise HTTPException(status_code=404, detail="Account not found")
        await session.execute(
            update(IntegrationAccount)
            .where(IntegrationAccount.id == account_id)
            .values(is_active=False)
        )


@router.post("/accounts/test")
async def test_credentials(
    body: TestCredentialsRequest,
    current_user: User = Depends(get_current_user),
):
    """Test credentials without saving them."""
    provider = IntegrationRegistry.get(body.provider_id)
    if not provider:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {body.provider_id}")

    ok, message = await provider.test_credentials(body.credentials)
    return {"ok": ok, "message": message}


@router.get("/accounts/{account_id}/devices")
async def list_account_devices(
    account_id: int,
    current_user: User = Depends(get_current_user),
):
    """List remote devices available on an integration account."""
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(IntegrationAccount).where(
                IntegrationAccount.id      == account_id,
                IntegrationAccount.user_id == current_user.id,
                IntegrationAccount.is_active == True,
            )
        )
        account = result.scalar_one_or_none()
        if not account:
            raise HTTPException(status_code=404, detail="Account not found")

    provider = IntegrationRegistry.get(account.provider_id)
    if not provider:
        raise HTTPException(status_code=400, detail="Provider no longer available")

    credentials = account.get_decrypted_credentials()
    auth_ctx = await _get_auth(
        current_user.id,
        account.provider_id,
        account.account_label,
        credentials,
    )
    if not auth_ctx:
        raise HTTPException(status_code=502, detail="Authentication failed")

    devices = await provider.list_remote_devices(auth_ctx)
    return [
        {
            "remote_id":     d.remote_id,
            "name":          d.name,
            "imei":          d.imei,
            "license_plate": d.license_plate,
            "extra":         d.extra,
        }
        for d in devices
    ]
