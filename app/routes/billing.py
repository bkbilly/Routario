import math
from datetime import datetime
from types import SimpleNamespace
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update

from core.audit import write_audit_log
from core.auth import require_company_admin
from core.database import get_db
from models import BillingInvoice, BillingPlan, Company, Device, PositionRecord, UsageEvent, User

router = APIRouter(prefix="/api/billing", tags=["billing"])


def _require_billing_permission(user: User) -> None:
    if not user.is_admin and "manage_billing" not in (user.permissions or []):
        raise HTTPException(status_code=403, detail="Permission required: manage_billing")


class BillingPlanIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    currency: str = Field("USD", min_length=3, max_length=3)
    base_price_cents: int = Field(0, ge=0)
    included_devices: int = Field(0, ge=0)
    included_positions: int = Field(0, ge=0)
    included_api_calls: int = Field(0, ge=0)
    price_per_device_cents: int = Field(0, ge=0)
    price_per_1000_positions_cents: int = Field(0, ge=0)
    price_per_1000_api_calls_cents: int = Field(0, ge=0)
    is_active: bool = True


class CompanyBillingIn(BaseModel):
    plan_id: Optional[int] = None
    billing_email: Optional[str] = None
    billing_status: Optional[str] = None


class UsageEventIn(BaseModel):
    company_id: int
    metric: str
    quantity: int = Field(1, ge=1)
    source: Optional[str] = None
    metadata: dict = Field(default_factory=dict)


def _month_window(year: int, month: int) -> tuple[datetime, datetime]:
    start = datetime(year, month, 1)
    if month == 12:
        return start, datetime(year + 1, 1, 1)
    return start, datetime(year, month + 1, 1)


def _plan_payload(plan: BillingPlan) -> dict:
    return {
        "id": plan.id,
        "name": plan.name,
        "currency": plan.currency,
        "base_price_cents": plan.base_price_cents,
        "included_devices": plan.included_devices,
        "included_positions": plan.included_positions,
        "included_api_calls": plan.included_api_calls,
        "price_per_device_cents": plan.price_per_device_cents,
        "price_per_1000_positions_cents": plan.price_per_1000_positions_cents,
        "price_per_1000_api_calls_cents": plan.price_per_1000_api_calls_cents,
        "is_active": plan.is_active,
        "created_at": plan.created_at,
    }


async def _usage(company_id: int, start: datetime, end: datetime) -> dict:
    db = get_db()
    async with db.get_session() as session:
        devices = (await session.execute(
            select(func.count(Device.id)).where(Device.company_id == company_id, Device.is_active == True)
        )).scalar_one() or 0
        positions = (await session.execute(
            select(func.count(PositionRecord.id))
            .join(Device, PositionRecord.device_id == Device.id)
            .where(Device.company_id == company_id, PositionRecord.device_time >= start, PositionRecord.device_time < end)
        )).scalar_one() or 0
        events = (await session.execute(
            select(UsageEvent.metric, func.coalesce(func.sum(UsageEvent.quantity), 0))
            .where(UsageEvent.company_id == company_id, UsageEvent.created_at >= start, UsageEvent.created_at < end)
            .group_by(UsageEvent.metric)
        )).all()
        event_totals = {metric: int(total or 0) for metric, total in events}
        return {
            "active_devices": int(devices),
            "positions": int(positions),
            "api_calls": int(event_totals.get("api_call", 0)),
            "events": event_totals,
        }


def _invoice_lines(plan: BillingPlan, usage: dict) -> tuple[int, list[dict]]:
    lines = [
        {"label": "Base subscription", "quantity": 1, "unit": "month", "amount_cents": plan.base_price_cents}
    ]
    amount = plan.base_price_cents
    extra_devices = max(0, usage["active_devices"] - plan.included_devices)
    if extra_devices:
        line_amount = extra_devices * plan.price_per_device_cents
        amount += line_amount
        lines.append({"label": "Additional active devices", "quantity": extra_devices, "unit": "device", "amount_cents": line_amount})
    extra_positions = max(0, usage["positions"] - plan.included_positions)
    if extra_positions:
        units = math.ceil(extra_positions / 1000)
        line_amount = units * plan.price_per_1000_positions_cents
        amount += line_amount
        lines.append({"label": "Additional position messages", "quantity": extra_positions, "unit": "position", "billable_units": units, "amount_cents": line_amount})
    extra_api = max(0, usage["api_calls"] - plan.included_api_calls)
    if extra_api:
        units = math.ceil(extra_api / 1000)
        line_amount = units * plan.price_per_1000_api_calls_cents
        amount += line_amount
        lines.append({"label": "Additional API calls", "quantity": extra_api, "unit": "call", "billable_units": units, "amount_cents": line_amount})
    return amount, lines


@router.get("/plans")
async def list_plans(_: User = Depends(require_company_admin)):
    _require_billing_permission(_)
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(select(BillingPlan).order_by(BillingPlan.name))
        return [_plan_payload(p) for p in result.scalars().all()]


@router.post("/plans")
async def create_plan(data: BillingPlanIn, request: Request, current_user: User = Depends(require_company_admin)):
    _require_billing_permission(current_user)
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Super admin access required")
    db = get_db()
    async with db.get_session() as session:
        plan = BillingPlan(**data.model_dump())
        session.add(plan)
        await session.flush()
        await session.refresh(plan)
        payload = _plan_payload(plan)
    await write_audit_log("billing.plan_created", actor=current_user, target_type="billing_plan", target_id=payload["id"], request=request)
    return payload


@router.put("/plans/{plan_id}")
async def update_plan(plan_id: int, data: BillingPlanIn, request: Request, current_user: User = Depends(require_company_admin)):
    _require_billing_permission(current_user)
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Super admin access required")
    db = get_db()
    async with db.get_session() as session:
        plan = await session.get(BillingPlan, plan_id)
        if not plan:
            raise HTTPException(status_code=404, detail="Plan not found")
        for key, value in data.model_dump().items():
            setattr(plan, key, value)
        await session.flush()
        await session.refresh(plan)
        payload = _plan_payload(plan)
    await write_audit_log("billing.plan_updated", actor=current_user, target_type="billing_plan", target_id=plan_id, request=request)
    return payload


@router.delete("/plans/{plan_id}")
async def delete_plan(plan_id: int, request: Request, current_user: User = Depends(require_company_admin)):
    _require_billing_permission(current_user)
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Super admin access required")
    db = get_db()
    async with db.get_session() as session:
        plan = await session.get(BillingPlan, plan_id)
        if not plan:
            raise HTTPException(status_code=404, detail="Plan not found")
        await session.execute(
            update(Company)
            .where(Company.billing_plan_id == plan_id)
            .values(billing_plan_id=None)
        )
        await session.delete(plan)
    await write_audit_log("billing.plan_deleted", actor=current_user, target_type="billing_plan", target_id=plan_id, request=request)
    return {"status": "deleted"}


@router.put("/companies/{company_id}")
async def update_company_billing(company_id: int, data: CompanyBillingIn, request: Request, current_user: User = Depends(require_company_admin)):
    _require_billing_permission(current_user)
    if not current_user.is_admin and current_user.company_id != company_id:
        raise HTTPException(status_code=403, detail="Forbidden")
    db = get_db()
    async with db.get_session() as session:
        company = await session.get(Company, company_id)
        if not company:
            raise HTTPException(status_code=404, detail="Company not found")
        if "plan_id" in data.model_fields_set:
            company.billing_plan_id = data.plan_id
        if "billing_email" in data.model_fields_set:
            company.billing_email = data.billing_email
        if data.billing_status is not None:
            company.billing_status = data.billing_status
        await session.flush()
        await session.refresh(company)
        payload = {
            "company_id": company.id,
            "billing_plan_id": company.billing_plan_id,
            "billing_email": company.billing_email,
            "billing_status": company.billing_status,
        }
    await write_audit_log("billing.company_updated", actor=current_user, company_id=company_id, target_type="company", target_id=company_id, request=request)
    return payload


@router.get("/companies/{company_id}/usage")
async def company_usage(
    company_id: int,
    year: int = Query(..., ge=2000),
    month: int = Query(..., ge=1, le=12),
    current_user: User = Depends(require_company_admin),
):
    _require_billing_permission(current_user)
    if not current_user.is_admin and current_user.company_id != company_id:
        raise HTTPException(status_code=403, detail="Forbidden")
    start, end = _month_window(year, month)
    return {"company_id": company_id, "period_start": start, "period_end": end, "usage": await _usage(company_id, start, end)}


@router.post("/usage-events")
async def record_usage_event(data: UsageEventIn, request: Request, current_user: User = Depends(require_company_admin)):
    _require_billing_permission(current_user)
    if not current_user.is_admin and current_user.company_id != data.company_id:
        raise HTTPException(status_code=403, detail="Forbidden")
    db = get_db()
    async with db.get_session() as session:
        session.add(UsageEvent(company_id=data.company_id, metric=data.metric, quantity=data.quantity, source=data.source, metadata_json=data.metadata))
    await write_audit_log("billing.usage_event_recorded", actor=current_user, company_id=data.company_id, target_type="company", target_id=data.company_id, request=request, metadata={"metric": data.metric, "quantity": data.quantity})
    return {"status": "recorded"}


@router.post("/companies/{company_id}/invoices")
async def generate_invoice(company_id: int, request: Request, year: int = Query(..., ge=2000), month: int = Query(..., ge=1, le=12), current_user: User = Depends(require_company_admin)):
    _require_billing_permission(current_user)
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Super admin access required")
    db = get_db()
    start, end = _month_window(year, month)
    async with db.get_session() as session:
        company = await session.get(Company, company_id)
        if not company:
            raise HTTPException(status_code=404, detail="Company not found")
        if not company.billing_plan_id:
            raise HTTPException(status_code=400, detail="Company has no billing plan")
        plan = await session.get(BillingPlan, company.billing_plan_id)
        if not plan:
            raise HTTPException(status_code=400, detail="Company billing plan was not found")
        plan_data = {
            "id": plan.id,
            "currency": plan.currency,
            "base_price_cents": plan.base_price_cents,
            "included_devices": plan.included_devices,
            "included_positions": plan.included_positions,
            "included_api_calls": plan.included_api_calls,
            "price_per_device_cents": plan.price_per_device_cents,
            "price_per_1000_positions_cents": plan.price_per_1000_positions_cents,
            "price_per_1000_api_calls_cents": plan.price_per_1000_api_calls_cents,
        }

    usage = await _usage(company_id, start, end)
    plan_stub = SimpleNamespace(**plan_data)
    amount, lines = _invoice_lines(plan_stub, usage)

    async with db.get_session() as session:
        invoice = BillingInvoice(
            company_id=company_id,
            period_start=start,
            period_end=end,
            currency=plan_data["currency"],
            amount_cents=amount,
            status="draft",
            line_items=lines,
        )
        session.add(invoice)
        await session.flush()
        await session.refresh(invoice)
        payload = {
            "id": invoice.id,
            "company_id": invoice.company_id,
            "period_start": invoice.period_start,
            "period_end": invoice.period_end,
            "currency": invoice.currency,
            "amount_cents": invoice.amount_cents,
            "status": invoice.status,
            "line_items": invoice.line_items,
            "usage": usage,
        }
    await write_audit_log("billing.invoice_generated", actor=current_user, company_id=company_id, target_type="billing_invoice", target_id=payload["id"], request=request)
    return payload


@router.get("/companies/{company_id}/invoices")
async def list_invoices(company_id: int, current_user: User = Depends(require_company_admin)):
    _require_billing_permission(current_user)
    if not current_user.is_admin and current_user.company_id != company_id:
        raise HTTPException(status_code=403, detail="Forbidden")
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(select(BillingInvoice).where(BillingInvoice.company_id == company_id).order_by(BillingInvoice.period_start.desc()))
        return [
            {
                "id": inv.id,
                "company_id": inv.company_id,
                "period_start": inv.period_start,
                "period_end": inv.period_end,
                "currency": inv.currency,
                "amount_cents": inv.amount_cents,
                "status": inv.status,
                "line_items": inv.line_items or [],
                "created_at": inv.created_at,
            }
            for inv in result.scalars().all()
        ]
