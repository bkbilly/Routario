"""
Fuel Log Routes — per-device fuel fill-up tracking with consumption stats.
"""
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import select

from core.auth import get_current_user, verify_device_access
from core.database import get_db
from models import FuelLog, User
from models.schemas import FuelLogCreate, FuelLogUpdate, FuelLogResponse

router = APIRouter(prefix="/api/devices", tags=["fuel"])


@router.get("/{device_id}/fuel", response_model=List[FuelLogResponse])
async def list_fuel_logs(
    device_id: int,
    current_user: User = Depends(verify_device_access),
):
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(FuelLog)
            .where(FuelLog.device_id == device_id)
            .order_by(FuelLog.date.desc())
        )
        return result.scalars().all()


@router.post("/{device_id}/fuel", response_model=FuelLogResponse)
async def create_fuel_log(
    device_id: int,
    data: FuelLogCreate,
    current_user: User = Depends(verify_device_access),
):
    db = get_db()
    async with db.get_session() as session:
        log = FuelLog(
            device_id=device_id,
            date=data.date.replace(tzinfo=None) if data.date.tzinfo else data.date,
            liters=data.liters,
            odometer_km=data.odometer_km,
            price_per_liter=data.price_per_liter,
            full_tank=data.full_tank,
            notes=data.notes,
        )
        session.add(log)
        await session.flush()
        await session.refresh(log)
        return log


@router.put("/{device_id}/fuel/{log_id}", response_model=FuelLogResponse)
async def update_fuel_log(
    device_id: int,
    log_id: int,
    data: FuelLogUpdate,
    current_user: User = Depends(verify_device_access),
):
    db = get_db()
    async with db.get_session() as session:
        log = await _get_log_or_404(session, device_id, log_id)
        if data.date is not None:
            log.date = data.date.replace(tzinfo=None) if data.date.tzinfo else data.date
        if data.liters is not None:
            log.liters = data.liters
        if data.odometer_km is not None:
            log.odometer_km = data.odometer_km
        if data.price_per_liter is not None:
            log.price_per_liter = data.price_per_liter
        if data.full_tank is not None:
            log.full_tank = data.full_tank
        if data.notes is not None:
            log.notes = data.notes
        await session.flush()
        await session.refresh(log)
        return log


@router.delete("/{device_id}/fuel/{log_id}")
async def delete_fuel_log(
    device_id: int,
    log_id: int,
    current_user: User = Depends(verify_device_access),
):
    db = get_db()
    async with db.get_session() as session:
        log = await _get_log_or_404(session, device_id, log_id)
        await session.delete(log)
    return {"status": "deleted"}


async def _get_log_or_404(session, device_id: int, log_id: int) -> FuelLog:
    result = await session.execute(
        select(FuelLog).where(FuelLog.id == log_id, FuelLog.device_id == device_id)
    )
    log = result.scalar_one_or_none()
    if not log:
        raise HTTPException(status_code=404, detail="Fuel log not found")
    return log
