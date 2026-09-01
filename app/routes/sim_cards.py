"""
SIM Cards API Routes for Routario.
Endpoints for managing SIM cards, testing credentials, fetching remote SIMs,
and querying provider integration schemas.
"""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import delete, select, update
from sqlalchemy.orm import selectinload

from core.audit import write_audit_log
from core.auth import get_current_user, require_permission
from core.database import get_db
from models import Device, SimCard, User
from models.schemas import SimCardCreate, SimCardResponse, SimCardUpdate
from sim_integrations import RemoteSimCard, SimProviderRegistry

router = APIRouter(prefix="/api/sim-cards", tags=["sim_cards"])


class TestCredentialsRequest(BaseModel):
    provider_id: str
    credentials: Dict[str, Any]


class FetchRemoteRequest(BaseModel):
    provider_id: str
    credentials: Dict[str, Any]


async def require_sim_admin(current_user: User = Depends(get_current_user)) -> User:
    """Ensure caller is either a Super Admin or a Company Admin with manage_sim_cards permission."""
    if current_user.is_admin:
        return current_user
    if current_user.is_company_admin and "manage_sim_cards" in (current_user.permissions or []):
        return current_user
    raise HTTPException(
        status_code=403,
        detail="Permission required: manage_sim_cards (Super Admin or Company Admin only)",
    )


def _check_sim_access(sim: SimCard, user: User):
    if user.is_admin:
        return
    if sim.company_id is not None and sim.company_id != user.company_id:
        raise HTTPException(status_code=403, detail="Access denied")


def _sim_to_response(sim: SimCard) -> dict:
    return {
        "id": sim.id,
        "company_id": sim.company_id,
        "device_id": sim.device_id,
        "device_name": sim.device.name if sim.device else None,
        "provider_id": sim.provider_id,
        "account_label": sim.account_label,
        "phone_number": sim.phone_number,
        "plan_name": sim.plan_name,
        "balance": sim.balance,
        "remaining_data_mb": sim.remaining_data_mb,
        "currency": sim.currency or "EUR",
        "expiry_date": sim.expiry_date,
        "credentials": sim.credentials or {},
        "created_at": sim.created_at,
    }


@router.get("/providers")
async def get_providers(current_user: User = Depends(require_sim_admin)):
    """Return all available SIM providers and their configuration fields."""
    return SimProviderRegistry.all()


@router.post("/test")
async def test_credentials(
    payload: TestCredentialsRequest,
    current_user: User = Depends(require_sim_admin),
):
    """Test SIM provider credentials without saving."""
    if not payload.provider_id:
        return {"ok": True, "message": "No provider configured"}
    integration = SimProviderRegistry.get(payload.provider_id)
    if not integration:
        raise HTTPException(status_code=404, detail=f"Provider '{payload.provider_id}' not found")

    ok, message = await integration.test_credentials(payload.credentials)
    return {"ok": ok, "message": message}


@router.post("/fetch-remote")
async def fetch_remote_sims(
    payload: FetchRemoteRequest,
    current_user: User = Depends(require_sim_admin),
):
    """Fetch SIM cards available remotely on the provider account."""
    if not payload.provider_id:
        raise HTTPException(status_code=400, detail="Please select a provider first")
    integration = SimProviderRegistry.get(payload.provider_id)
    if not integration:
        raise HTTPException(status_code=404, detail=f"Provider '{payload.provider_id}' not found")

    try:
        remote_sims = await integration.fetch_remote_sims(payload.credentials)
        return [
            {
                "phone_number": s.phone_number,
                "plan_name": s.plan_name,
                "balance": s.balance,
                "remaining_data_mb": s.remaining_data_mb,
                "currency": s.currency,
                "expiry_date": s.expiry_date,
            }
            for s in remote_sims
        ]
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("", response_model=List[SimCardResponse])
async def list_sim_cards(current_user: User = Depends(require_sim_admin)):
    """List SIM cards for caller's company (or all for super admin)."""
    db = get_db()
    async with db.get_session() as session:
        q = select(SimCard).options(selectinload(SimCard.device))
        if not current_user.is_admin:
            q = q.where(
                (SimCard.company_id == current_user.company_id) | (SimCard.company_id.is_(None))
            )
        q = q.order_by(SimCard.id.desc())
        sims = (await session.execute(q)).scalars().all()
        return [_sim_to_response(s) for s in sims]


@router.post("", response_model=SimCardResponse)
async def create_sim_card(
    data: SimCardCreate,
    request: Request,
    current_user: User = Depends(require_sim_admin),
):
    """Register a new SIM card."""
    company_id = data.company_id if current_user.is_admin else current_user.company_id

    clean_phone = data.phone_number.strip()
    if not clean_phone:
        raise HTTPException(status_code=400, detail="Phone number is required")

    provider_id = data.provider_id.strip() if data.provider_id else None
    account_label = data.account_label.strip() if data.account_label else clean_phone

    db = get_db()
    async with db.get_session() as session:
        # Enforce unique phone number
        existing_phone = await session.execute(
            select(SimCard).where(SimCard.phone_number == clean_phone)
        )
        if existing_phone.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="A SIM card with this phone number already exists")

        # If device_id provided, ensure no other SIM is linked to this device
        if data.device_id:
            dev = await session.get(Device, data.device_id)
            if not dev or (not current_user.is_admin and company_id and dev.company_id != company_id):
                raise HTTPException(status_code=400, detail="Invalid device for this company")
            # Unlink previous sim card
            await session.execute(
                update(SimCard).where(SimCard.device_id == data.device_id).values(device_id=None)
            )

        sim = SimCard(
            company_id=company_id,
            device_id=data.device_id,
            provider_id=provider_id,
            account_label=account_label,
            credentials=data.credentials or {},
            phone_number=clean_phone,
            plan_name=data.plan_name,
            balance=data.balance,
            remaining_data_mb=data.remaining_data_mb,
            currency=data.currency or "EUR",
            expiry_date=data.expiry_date,
        )
        session.add(sim)
        await session.commit()

        # Re-query with relationship loaded
        res = await session.execute(
            select(SimCard).where(SimCard.id == sim.id).options(selectinload(SimCard.device))
        )
        loaded = res.scalar_one()
        await write_audit_log(
            "sim_card.created",
            actor=current_user,
            company_id=company_id,
            target_type="sim_card",
            target_id=str(loaded.id),
            request=request,
            metadata={"phone_number": loaded.phone_number, "provider_id": loaded.provider_id},
        )
        return _sim_to_response(loaded)


@router.put("/{sim_id}", response_model=SimCardResponse)
async def update_sim_card(
    sim_id: int,
    data: SimCardUpdate,
    request: Request,
    current_user: User = Depends(require_sim_admin),
):
    """Update a SIM card."""
    db = get_db()
    async with db.get_session() as session:
        sim = await session.get(SimCard, sim_id)
        if not sim:
            raise HTTPException(status_code=404, detail="SIM card not found")
        _check_sim_access(sim, current_user)

        if "provider_id" in data.model_fields_set:
            sim.provider_id = data.provider_id.strip() if data.provider_id else None
        if "company_id" in data.model_fields_set and current_user.is_admin:
            sim.company_id = data.company_id
        if "account_label" in data.model_fields_set:
            sim.account_label = data.account_label
        if "credentials" in data.model_fields_set and data.credentials is not None:
            new_creds = {k: v for k, v in data.credentials.items() if v is not None and str(v).strip() != ""}
            if new_creds:
                merged = dict(sim.credentials or {})
                merged.update(new_creds)
                sim.credentials = merged
        if "phone_number" in data.model_fields_set and data.phone_number is not None:
            clean_phone = data.phone_number.strip()
            if not clean_phone:
                raise HTTPException(status_code=400, detail="Phone number cannot be empty")
            if clean_phone != sim.phone_number:
                existing_phone = await session.execute(
                    select(SimCard).where(SimCard.phone_number == clean_phone, SimCard.id != sim.id)
                )
                if existing_phone.scalar_one_or_none():
                    raise HTTPException(status_code=400, detail="A SIM card with this phone number already exists")
            sim.phone_number = clean_phone
        if "plan_name" in data.model_fields_set:
            sim.plan_name = data.plan_name
        if "balance" in data.model_fields_set:
            sim.balance = data.balance
        if "remaining_data_mb" in data.model_fields_set:
            sim.remaining_data_mb = data.remaining_data_mb
        if "currency" in data.model_fields_set and data.currency is not None:
            sim.currency = data.currency
        if "expiry_date" in data.model_fields_set:
            sim.expiry_date = data.expiry_date

        if "device_id" in data.model_fields_set:
            new_device_id = data.device_id
            if new_device_id and new_device_id != sim.device_id:
                dev = await session.get(Device, new_device_id)
                if not dev or (not current_user.is_admin and dev.company_id != sim.company_id):
                    raise HTTPException(status_code=400, detail="Invalid device for this company")
                # Detach any other sim assigned to this device
                await session.execute(
                    update(SimCard).where(SimCard.device_id == new_device_id).values(device_id=None)
                )
            sim.device_id = new_device_id

        await session.commit()
        res = await session.execute(
            select(SimCard).where(SimCard.id == sim.id).options(selectinload(SimCard.device))
        )
        loaded = res.scalar_one()
        await write_audit_log(
            "sim_card.updated",
            actor=current_user,
            company_id=sim.company_id,
            target_type="sim_card",
            target_id=str(loaded.id),
            request=request,
        )
        return _sim_to_response(loaded)


@router.delete("/{sim_id}")
async def delete_sim_card(
    sim_id: int,
    request: Request,
    current_user: User = Depends(require_sim_admin),
):
    """Delete a SIM card."""
    db = get_db()
    async with db.get_session() as session:
        sim = await session.get(SimCard, sim_id)
        if not sim:
            raise HTTPException(status_code=404, detail="SIM card not found")
        _check_sim_access(sim, current_user)

        company_id = sim.company_id
        await session.delete(sim)
        await session.commit()

        await write_audit_log(
            "sim_card.deleted",
            actor=current_user,
            company_id=company_id,
            target_type="sim_card",
            target_id=str(sim_id),
            request=request,
        )
        return {"ok": True}
