"""
Device Routes
CRUD and state operations for GPS devices.

Access rules:
  GET  /api/devices/all      → admin only
  GET  /api/devices          → returns caller's own devices (token-derived, not query param)
  POST /api/devices          → admin only
  GET  /api/devices/{id}     → must have device access
  PUT  /api/devices/{id}     → must have device access
  DELETE /api/devices/{id}   → admin only
  GET  /api/devices/{id}/state      → must have device access
  GET  /api/devices/{id}/statistics → must have device access
  GET  /api/devices/{id}/trips      → must have device access
"""
from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query, Depends
from sqlalchemy import select, update, and_
from sqlalchemy.orm import selectinload

from core.database import get_db
from core.auth import get_current_user, require_admin, require_company_admin, verify_device_access
from integrations.engine import clear_device_state, evict_auth_cache
from integrations.integration_model import IntegrationAccount
from models import User, Device, DeviceState, user_device_association
from models.models import Driver
from models.schemas import DeviceCreate, DeviceResponse, DeviceStateResponse, TripResponse, UserResponse

router = APIRouter(prefix="/api/devices", tags=["devices"])


@router.get("/all", response_model=List[DeviceResponse])
async def get_all_devices(caller: User = Depends(require_company_admin)):
    """Return devices. Super admin sees all; company admin sees their company's."""
    db = get_db()
    async with db.get_session() as session:
        q = select(Device).options(selectinload(Device.state).selectinload(DeviceState.current_driver))
        if not caller.is_admin:
            q = q.where(Device.company_id == caller.company_id)
        result = await session.execute(q)
        return result.scalars().all()


@router.get("", response_model=List[DeviceResponse])
async def get_devices(current_user: User = Depends(get_current_user)):
    """Return devices for the caller. Company admins see all company devices."""
    db = get_db()
    if current_user.is_admin:
        async with db.get_session() as session:
            result = await session.execute(
                select(Device).options(selectinload(Device.state).selectinload(DeviceState.current_driver))
            )
            return result.scalars().all()
    if current_user.is_company_admin and current_user.company_id is not None:
        async with db.get_session() as session:
            result = await session.execute(
                select(Device)
                .where(Device.company_id == current_user.company_id)
                .options(selectinload(Device.state).selectinload(DeviceState.current_driver))
            )
            return result.scalars().all()
    return await db.get_user_devices(current_user.id)


@router.post("", response_model=DeviceResponse)
async def create_device(
    device_data: DeviceCreate,
    assign_to: Optional[int] = Query(None, description="User ID to assign device to"),
    caller: User = Depends(require_company_admin),
):
    """Create a new device. Super admin or company admin."""
    if not caller.is_admin:
        device_data.company_id = caller.company_id  # force company for company admins

    db = get_db()
    existing = await db.get_device_by_imei(device_data.imei)
    if existing:
        raise HTTPException(status_code=400, detail="IMEI already exists")

    device = await db.create_device(device_data)
    target_user = assign_to if assign_to else caller.id
    await db.add_device_to_user(target_user, device.id)
    return device


@router.get("/{device_id}", response_model=DeviceResponse)
async def get_device(
    device_id: int,
    caller: User = Depends(verify_device_access),
):
    db = get_db()
    device = await db.get_device_by_id(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


@router.put("/{device_id}", response_model=DeviceResponse)
async def update_device(
    device_id: int,
    device_data: DeviceCreate,
    new_odometer: Optional[float] = Query(None),
    caller: User = Depends(verify_device_access),
):
    db = get_db()
    if not (caller.is_admin or caller.is_company_admin):
        existing = await db.get_device_by_id(device_id)
        if existing:
            device_data.imei       = existing.imei
            device_data.protocol   = existing.protocol
            device_data.company_id = existing.company_id
    elif not caller.is_admin:
        # Company admins can change IMEI and protocol but not company assignment
        existing = await db.get_device_by_id(device_id)
        if existing:
            device_data.company_id = existing.company_id
    device = await db.update_device(device_id, device_data)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    if new_odometer is not None:
        async with db.get_session() as session:
            await session.execute(
                update(DeviceState)
                .where(DeviceState.device_id == device_id)
                .values(total_odometer=new_odometer)
            )
    return device


@router.delete("/{device_id}")
async def delete_device(device_id: int, admin: User = Depends(require_company_admin)):
    """Delete a device and all associated data. Admin only."""
    db = get_db()

    # Capture what we need before the CASCADE wipes it
    device = await db.get_device_by_id(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    imei          = device.imei
    intg          = (device.config or {}).get("integration") or {}
    provider_id   = intg.get("provider")
    account_label = intg.get("account_label", "")
    owner_ids     = [u.id for u in (device.users or [])]

    # Delete device — FK cascades remove positions, trips, state, alerts, commands, geofences
    success = await db.delete_device(device_id)
    if not success:
        raise HTTPException(status_code=404, detail="Device not found")

    # Clear in-memory polling state for this IMEI
    clear_device_state(imei)

    # If this was an integration device, clean up the IntegrationAccount when
    # no other device belonging to the same user still references it.
    if provider_id:
        for user_id in owner_ids:
            remaining = await db.get_user_devices(user_id)
            still_used = any(
                ((d.config or {}).get("integration") or {}).get("provider") == provider_id
                and ((d.config or {}).get("integration") or {}).get("account_label", "") == account_label
                for d in remaining
            )
            if not still_used:
                async with db.get_session() as session:
                    await session.execute(
                        update(IntegrationAccount)
                        .where(
                            IntegrationAccount.user_id       == user_id,
                            IntegrationAccount.provider_id   == provider_id,
                            IntegrationAccount.account_label == account_label,
                        )
                        .values(state={})
                    )
                evict_auth_cache(user_id, provider_id, account_label)

    return {"status": "deleted"}


@router.get("/{device_id}/state", response_model=DeviceStateResponse)
async def get_device_state(
    device_id: int,
    caller: User = Depends(verify_device_access),
):
    db = get_db()
    device = await db.get_device_by_id(device_id)
    if not device or not device.state:
        raise HTTPException(status_code=404, detail="Device state not found")
    return device.state


@router.get("/{device_id}/statistics")
async def get_device_statistics(
    device_id: int,
    start_date: Optional[datetime] = Query(None),
    end_date: Optional[datetime] = Query(None),
    caller: User = Depends(verify_device_access),
):
    db = get_db()
    if not start_date:
        start_date = datetime.utcnow() - timedelta(days=30)
    if not end_date:
        end_date = datetime.utcnow()
    return await db.get_device_statistics(device_id, start_date, end_date)


@router.get("/{device_id}/trips", response_model=List[TripResponse])
async def get_device_trips(
    device_id: int,
    start_date: Optional[datetime] = Query(None),
    end_date: Optional[datetime] = Query(None),
    caller: User = Depends(verify_device_access),
):
    db = get_db()
    if not start_date:
        start_date = datetime.utcnow() - timedelta(days=7)
    if not end_date:
        end_date = datetime.utcnow()
    return await db.get_device_trips(device_id, start_date, end_date)


@router.get("/{device_id}/users", response_model=List[UserResponse])
async def get_device_users(device_id: int, admin: User = Depends(require_company_admin)):
    """Get users assigned to this device. Admin or company admin."""
    db = get_db()
    device = await db.get_device_by_id(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    return device.users or []


@router.post("/{device_id}/users")
async def assign_user_to_device(
    device_id: int,
    user_id: int = Query(...),
    action: str = Query("add"),
    admin: User = Depends(require_company_admin),
):
    """Assign or remove a user from a device. Admin or company admin."""
    db = get_db()
    async with db.get_session() as session:
        if action == "add":
            exists = await session.execute(
                user_device_association.select().where(
                    and_(
                        user_device_association.c.user_id == user_id,
                        user_device_association.c.device_id == device_id,
                    )
                )
            )
            if not exists.scalar_one_or_none():
                await session.execute(
                    user_device_association.insert().values(
                        user_id=user_id, device_id=device_id, access_level="user"
                    )
                )
        elif action == "remove":
            await session.execute(
                user_device_association.delete().where(
                    and_(
                        user_device_association.c.user_id == user_id,
                        user_device_association.c.device_id == device_id,
                    )
                )
            )
    return {"status": "success"}


@router.get("/{device_id}/command-support")
async def check_command_support(
    device_id: int,
    caller: User = Depends(verify_device_access),
):
    from protocols import ProtocolRegistry
    db = get_db()
    device = await db.get_device_by_id(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    decoder = ProtocolRegistry.get_decoder(device.protocol)
    if not decoder:
        return {"supports_commands": False, "available_commands": [], "protocol": device.protocol, "command_info": {}}

    available_commands = []
    command_info = {}
    if hasattr(decoder, "get_available_commands"):
        try:
            available_commands = decoder.get_available_commands()
            if hasattr(decoder, "get_command_info"):
                for cmd in available_commands:
                    command_info[cmd] = decoder.get_command_info(cmd)
        except Exception as e:
            pass
    else:
        for cmd_type in ["reset", "interval", "reboot", "custom"]:
            try:
                result = await decoder.encode_command(cmd_type, {})
                if result and len(result) > 0:
                    available_commands.append(cmd_type)
            except Exception:
                pass

    return {
        "supports_commands": len(available_commands) > 0,
        "available_commands": available_commands,
        "protocol": device.protocol,
        "command_info": command_info,
    }


def _command_support_for_protocol(protocol: str) -> dict:
    from protocols import ProtocolRegistry
    decoder = ProtocolRegistry.get_decoder(protocol)
    if not decoder:
        return {"supports_commands": False, "available_commands": [], "protocol": protocol, "command_info": {}}
    available_commands = []
    command_info = {}
    if hasattr(decoder, "get_available_commands"):
        try:
            available_commands = decoder.get_available_commands()
            if hasattr(decoder, "get_command_info"):
                for cmd in available_commands:
                    command_info[cmd] = decoder.get_command_info(cmd)
        except Exception:
            pass
    return {
        "supports_commands": len(available_commands) > 0,
        "available_commands": available_commands,
        "protocol": protocol,
        "command_info": command_info,
    }


@router.get("/protocol/{protocol}/command-support")
async def check_protocol_command_support(
    protocol: str,
    caller: User = Depends(get_current_user),
):
    return _command_support_for_protocol(protocol)
