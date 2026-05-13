"""
Company Routes
CRUD and membership management for companies.

Access rules:
  All endpoints → super admin only
"""
from typing import List

from fastapi import APIRouter, HTTPException, Query, Depends
from sqlalchemy import select, func

from core.database import get_db
from core.auth import require_admin
from models import Company, User, Device
from models.schemas import CompanyCreate, CompanyUpdate, CompanyResponse, UserResponse, DeviceResponse

router = APIRouter(prefix="/api/companies", tags=["companies"])


@router.get("", response_model=List[CompanyResponse])
async def get_all_companies(admin: User = Depends(require_admin)):
    db = get_db()
    companies = await db.get_all_companies()
    result = []
    for c in companies:
        async with db.get_session() as session:
            uc = (await session.execute(
                select(func.count(User.id)).where(User.company_id == c.id)
            )).scalar_one()
            dc = (await session.execute(
                select(func.count(Device.id)).where(Device.company_id == c.id)
            )).scalar_one()
        cr = CompanyResponse.model_validate(c)
        cr.user_count = uc
        cr.device_count = dc
        result.append(cr)
    return result


@router.post("", response_model=CompanyResponse)
async def create_company(data: CompanyCreate, admin: User = Depends(require_admin)):
    db = get_db()
    return await db.create_company(data)


@router.get("/{company_id}", response_model=CompanyResponse)
async def get_company(company_id: int, admin: User = Depends(require_admin)):
    db = get_db()
    company = await db.get_company(company_id)
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")
    return company


@router.put("/{company_id}", response_model=CompanyResponse)
async def update_company(company_id: int, data: CompanyUpdate, admin: User = Depends(require_admin)):
    db = get_db()
    company = await db.update_company(company_id, data)
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")
    return company


@router.delete("/{company_id}")
async def delete_company(company_id: int, admin: User = Depends(require_admin)):
    db = get_db()
    success = await db.delete_company(company_id)
    if not success:
        raise HTTPException(status_code=404, detail="Company not found")
    return {"status": "deleted"}


@router.get("/{company_id}/users", response_model=List[UserResponse])
async def get_company_users(company_id: int, admin: User = Depends(require_admin)):
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(select(User).where(User.company_id == company_id))
        return result.scalars().all()


@router.get("/{company_id}/devices", response_model=List[DeviceResponse])
async def get_company_devices(company_id: int, admin: User = Depends(require_admin)):
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(select(Device).where(Device.company_id == company_id))
        return result.scalars().all()


@router.post("/{company_id}/users")
async def assign_user_to_company(
    company_id: int,
    user_id: int = Query(...),
    action: str = Query("add"),
    admin: User = Depends(require_admin),
):
    """Assign or remove a user from a company."""
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        if action == "add":
            user.company_id = company_id
        elif action == "remove":
            user.company_id = None
            user.is_company_admin = False
        await session.flush()
    return {"status": "success"}


@router.post("/{company_id}/devices")
async def assign_device_to_company(
    company_id: int,
    device_id: int = Query(...),
    action: str = Query("add"),
    admin: User = Depends(require_admin),
):
    """Assign or remove a device from a company."""
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(select(Device).where(Device.id == device_id))
        device = result.scalar_one_or_none()
        if not device:
            raise HTTPException(status_code=404, detail="Device not found")
        if action == "add":
            device.company_id = company_id
        elif action == "remove":
            device.company_id = None
        await session.flush()
    return {"status": "success"}
