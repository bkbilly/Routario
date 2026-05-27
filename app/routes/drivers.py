"""
Driver Management Routes
CRUD for drivers and device driver assignment.
"""
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import select, update

from core.auth import get_current_user
from core.database import get_db
from models import Driver, Device, DeviceState, User
from models.schemas import DriverCreate, DriverUpdate, DriverResponse

router = APIRouter(prefix="/api/drivers", tags=["drivers"])


def _require_admin_access(user: User):
    if not (user.is_admin or user.is_company_admin):
        raise HTTPException(status_code=403, detail="Admin access required")

def _check_driver_access(driver: Driver, user: User):
    if user.is_admin:
        return
    if driver.company_id != user.company_id:
        raise HTTPException(status_code=403, detail="Access denied")


@router.get("", response_model=List[DriverResponse])
async def list_drivers(current_user: User = Depends(get_current_user)):
    db = get_db()
    async with db.get_session() as session:
        q = select(Driver)
        if not current_user.is_admin:
            q = q.where(Driver.company_id == current_user.company_id)
        result = await session.execute(q.order_by(Driver.name))
        return result.scalars().all()


@router.post("", response_model=DriverResponse)
async def create_driver(
    data: DriverCreate,
    current_user: User = Depends(get_current_user),
):
    _require_admin_access(current_user)
    db = get_db()
    async with db.get_session() as session:
        driver = Driver(
            company_id=current_user.company_id if not current_user.is_admin else None,
            name=data.name,
            phone=data.phone,
            license_number=data.license_number,
            notes=data.notes,
        )
        session.add(driver)
        await session.flush()
        await session.refresh(driver)
        return driver


@router.put("/{driver_id}", response_model=DriverResponse)
async def update_driver(
    driver_id: int,
    data: DriverUpdate,
    current_user: User = Depends(get_current_user),
):
    _require_admin_access(current_user)
    db = get_db()
    async with db.get_session() as session:
        driver = await session.get(Driver, driver_id)
        if not driver:
            raise HTTPException(status_code=404, detail="Driver not found")
        _check_driver_access(driver, current_user)
        if data.name is not None:
            driver.name = data.name
        if data.phone is not None:
            driver.phone = data.phone
        if data.license_number is not None:
            driver.license_number = data.license_number
        if data.notes is not None:
            driver.notes = data.notes
        if data.company_id is not None and current_user.is_admin:
            driver.company_id = data.company_id
        await session.flush()
        await session.refresh(driver)
        return driver


@router.delete("/{driver_id}")
async def delete_driver(
    driver_id: int,
    current_user: User = Depends(get_current_user),
):
    _require_admin_access(current_user)
    db = get_db()
    async with db.get_session() as session:
        driver = await session.get(Driver, driver_id)
        if not driver:
            raise HTTPException(status_code=404, detail="Driver not found")
        _check_driver_access(driver, current_user)
        await session.delete(driver)
    return {"status": "deleted"}


@router.post("/assign")
async def assign_driver(
    device_id: int,
    driver_id: Optional[int] = None,
    current_user: User = Depends(get_current_user),
):
    """Assign (or unassign) a driver to a device's active state."""
    db = get_db()
    async with db.get_session() as session:
        # Verify device access
        device = await session.get(Device, device_id)
        if not device:
            raise HTTPException(status_code=404, detail="Device not found")

        if driver_id is not None:
            driver = await session.get(Driver, driver_id)
            if not driver:
                raise HTTPException(status_code=404, detail="Driver not found")
            if not current_user.is_admin and driver.company_id != current_user.company_id:
                raise HTTPException(status_code=403, detail="Access denied")

        state = await session.get(DeviceState, device_id)
        if state:
            state.current_driver_id = driver_id
        else:
            state = DeviceState(device_id=device_id, current_driver_id=driver_id)
            session.add(state)
        await session.flush()

    return {"status": "ok", "driver_id": driver_id}
