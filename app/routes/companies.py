"""
Company Routes
CRUD and membership management for companies.

Access rules:
  All endpoints → super admin only
"""
from pathlib import Path
import re
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query, Depends, File, UploadFile, Request
from sqlalchemy import select, func, update, delete
from sqlalchemy.orm import selectinload

from core.database import get_db
from core.auth import require_admin
from core.audit import write_audit_log
from models import BillingPlan, Company, User, Device, DeviceState, Driver
from models.schemas import CompanyCreate, CompanyUpdate, CompanyResponse, CompanyUserSummary, CompanyDeviceSummary, UserResponse, DeviceResponse

router = APIRouter(prefix="/api/companies", tags=["companies"])

BRANDING_DIR = Path("web/uploads/company-branding")
ALLOWED_IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}
MAX_BRANDING_BYTES = 2 * 1024 * 1024
LOGIN_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$")


def _clean_app_name(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None


def _clean_login_slug(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip().lower()
    if not value:
        return None
    if not LOGIN_SLUG_RE.match(value):
        raise HTTPException(
            status_code=400,
            detail="Login URL slug must be 3-100 lowercase letters, numbers, or hyphens",
        )
    return value


async def _ensure_login_slug_available(slug: str | None, exclude_company_id: int | None = None):
    if not slug:
        return
    db = get_db()
    async with db.get_session() as session:
        q = select(Company).where(Company.login_slug == slug)
        if exclude_company_id is not None:
            q = q.where(Company.id != exclude_company_id)
        if (await session.execute(q)).scalar_one_or_none():
            raise HTTPException(status_code=400, detail="Login URL slug already exists")


async def _ensure_billing_plan_exists(plan_id: int | None):
    if plan_id is None:
        return
    db = get_db()
    async with db.get_session() as session:
        if not await session.get(BillingPlan, plan_id):
            raise HTTPException(status_code=400, detail="Billing plan not found")


async def _store_branding_file(company: Company, upload: UploadFile, kind: str) -> str:
    suffix = ALLOWED_IMAGE_TYPES.get(upload.content_type or "")
    if not suffix:
        raise HTTPException(status_code=400, detail="Unsupported image type")

    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    if len(data) > MAX_BRANDING_BYTES:
        raise HTTPException(status_code=400, detail="Image must be 2 MB or smaller")

    BRANDING_DIR.mkdir(parents=True, exist_ok=True)
    current = getattr(company, f"{kind}_filename", None)
    if current:
        try:
            (BRANDING_DIR / current).unlink()
        except OSError:
            pass

    filename = f"company-{company.id}-{kind}{suffix}"
    path = BRANDING_DIR / filename
    path.write_bytes(data)
    return filename


def _delete_branding_file(filename: str | None):
    if not filename:
        return
    try:
        (BRANDING_DIR / filename).unlink()
    except OSError:
        pass


def _build_company_response(c: Company) -> CompanyResponse:
    sorted_users = sorted(
        c.users or [],
        key=lambda u: (not getattr(u, "is_company_admin", False), (u.username or "").lower())
    )
    users_summary = [CompanyUserSummary.model_validate(u) for u in sorted_users]
    devices_summary = [CompanyDeviceSummary.model_validate(d) for d in (c.devices or [])]
    return CompanyResponse(
        id=c.id,
        name=c.name,
        app_name=c.app_name,
        login_slug=c.login_slug,
        icon_url=c.icon_url,
        badge_url=c.badge_url,
        branding_version=c.branding_version or 1,
        billing_plan_id=c.billing_plan_id,
        billing_email=c.billing_email,
        billing_status=c.billing_status or "active",
        created_at=c.created_at,
        user_count=len(users_summary),
        device_count=len(devices_summary),
        users=users_summary,
        devices=devices_summary,
    )


async def _fetch_company_response(company_id: int) -> Optional[CompanyResponse]:
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(Company)
            .where(Company.id == company_id)
            .options(
                selectinload(Company.users),
                selectinload(Company.devices),
            )
        )
        company = result.scalar_one_or_none()
        if not company:
            return None
        return _build_company_response(company)


@router.get("", response_model=List[CompanyResponse])
async def get_all_companies(admin: User = Depends(require_admin)):
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(Company)
            .options(
                selectinload(Company.users),
                selectinload(Company.devices),
            )
            .order_by(Company.name)
        )
        companies = result.scalars().all()
        return [_build_company_response(c) for c in companies]


@router.post("", response_model=CompanyResponse)
async def create_company(data: CompanyCreate, request: Request, admin: User = Depends(require_admin)):
    db = get_db()
    data.app_name = _clean_app_name(data.app_name)
    data.login_slug = _clean_login_slug(data.login_slug)
    await _ensure_login_slug_available(data.login_slug)
    await _ensure_billing_plan_exists(data.billing_plan_id)
    company = await db.create_company(data)
    await write_audit_log("company.created", actor=admin, company_id=company.id, target_type="company", target_id=company.id, request=request)
    resp = await _fetch_company_response(company.id)
    if not resp:
        raise HTTPException(status_code=500, detail="Failed to load created company")
    return resp


@router.get("/{company_id}", response_model=CompanyResponse)
async def get_company(company_id: int, admin: User = Depends(require_admin)):
    resp = await _fetch_company_response(company_id)
    if not resp:
        raise HTTPException(status_code=404, detail="Company not found")
    return resp


@router.put("/{company_id}", response_model=CompanyResponse)
async def update_company(company_id: int, data: CompanyUpdate, request: Request, admin: User = Depends(require_admin)):
    db = get_db()
    if data.app_name is not None:
        data.app_name = _clean_app_name(data.app_name)
    if "login_slug" in data.model_fields_set:
        data.login_slug = _clean_login_slug(data.login_slug)
        await _ensure_login_slug_available(data.login_slug, exclude_company_id=company_id)
    if "billing_plan_id" in data.model_fields_set:
        await _ensure_billing_plan_exists(data.billing_plan_id)
    company = await db.update_company(company_id, data)
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")
    await write_audit_log("company.updated", actor=admin, company_id=company_id, target_type="company", target_id=company_id, request=request)
    resp = await _fetch_company_response(company_id)
    if not resp:
        raise HTTPException(status_code=404, detail="Company not found")
    return resp


@router.post("/{company_id}/branding/icon", response_model=CompanyResponse)
async def upload_company_icon(
    company_id: int,
    file: UploadFile = File(...),
    admin: User = Depends(require_admin),
):
    db = get_db()
    async with db.get_session() as session:
        company = await session.get(Company, company_id)
        if not company:
            raise HTTPException(status_code=404, detail="Company not found")
        company.icon_filename = await _store_branding_file(company, file, "icon")
        company.branding_version = (company.branding_version or 1) + 1
        await session.flush()
    resp = await _fetch_company_response(company_id)
    if not resp:
        raise HTTPException(status_code=404, detail="Company not found")
    return resp


@router.delete("/{company_id}/branding/icon", response_model=CompanyResponse)
async def delete_company_icon(company_id: int, admin: User = Depends(require_admin)):
    db = get_db()
    async with db.get_session() as session:
        company = await session.get(Company, company_id)
        if not company:
            raise HTTPException(status_code=404, detail="Company not found")
        _delete_branding_file(company.icon_filename)
        company.icon_filename = None
        company.branding_version = (company.branding_version or 1) + 1
        await session.flush()
    resp = await _fetch_company_response(company_id)
    if not resp:
        raise HTTPException(status_code=404, detail="Company not found")
    return resp


@router.post("/{company_id}/branding/badge", response_model=CompanyResponse)
async def upload_company_badge(
    company_id: int,
    file: UploadFile = File(...),
    admin: User = Depends(require_admin),
):
    db = get_db()
    async with db.get_session() as session:
        company = await session.get(Company, company_id)
        if not company:
            raise HTTPException(status_code=404, detail="Company not found")
        company.badge_filename = await _store_branding_file(company, file, "badge")
        company.branding_version = (company.branding_version or 1) + 1
        await session.flush()
    resp = await _fetch_company_response(company_id)
    if not resp:
        raise HTTPException(status_code=404, detail="Company not found")
    return resp


@router.delete("/{company_id}/branding/badge", response_model=CompanyResponse)
async def delete_company_badge(company_id: int, admin: User = Depends(require_admin)):
    db = get_db()
    async with db.get_session() as session:
        company = await session.get(Company, company_id)
        if not company:
            raise HTTPException(status_code=404, detail="Company not found")
        _delete_branding_file(company.badge_filename)
        company.badge_filename = None
        company.branding_version = (company.branding_version or 1) + 1
        await session.flush()
    resp = await _fetch_company_response(company_id)
    if not resp:
        raise HTTPException(status_code=404, detail="Company not found")
    return resp


@router.delete("/{company_id}")
async def delete_company(company_id: int, request: Request, admin: User = Depends(require_admin)):
    db = get_db()
    success = await db.delete_company(company_id)
    if not success:
        raise HTTPException(status_code=404, detail="Company not found")
    await write_audit_log("company.deleted", actor=admin, company_id=company_id, target_type="company", target_id=company_id, request=request)
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
        result = await session.execute(
            select(Device)
            .where(Device.company_id == company_id)
            .options(
                selectinload(Device.state).selectinload(DeviceState.current_driver),
                selectinload(Device.sim_card),
            )
        )
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
        await session.execute(
            update(Driver).where(Driver.user_id == user_id).values(company_id=user.company_id)
        )
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
