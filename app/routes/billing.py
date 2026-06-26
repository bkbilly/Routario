from datetime import datetime
from types import SimpleNamespace
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, update

from core.audit import write_audit_log
from core.auth import require_admin
from core.currency import cents_at_rate, currency_snapshot
from core.database import get_db
from models import BillingInvoice, BillingPlan, Company, UsageEvent, User
from services.billing import billing_usage, invoice_lines, month_window

router = APIRouter(prefix="/api/billing", tags=["billing"])


def _require_billing_permission(user: User) -> None:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Super admin access required")


class BillingPlanIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    currency: str = Field("EUR", min_length=3, max_length=3)
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

@router.get("/plans")
async def list_plans(_: User = Depends(require_admin)):
    _require_billing_permission(_)
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(select(BillingPlan).order_by(BillingPlan.name))
        return [_plan_payload(p) for p in result.scalars().all()]


@router.post("/plans")
async def create_plan(data: BillingPlanIn, request: Request, current_user: User = Depends(require_admin)):
    _require_billing_permission(current_user)
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
async def update_plan(plan_id: int, data: BillingPlanIn, request: Request, current_user: User = Depends(require_admin)):
    _require_billing_permission(current_user)
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
async def delete_plan(plan_id: int, request: Request, current_user: User = Depends(require_admin)):
    _require_billing_permission(current_user)
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
async def update_company_billing(company_id: int, data: CompanyBillingIn, request: Request, current_user: User = Depends(require_admin)):
    _require_billing_permission(current_user)
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
    current_user: User = Depends(require_admin),
):
    _require_billing_permission(current_user)
    start, end = month_window(year, month)
    return {"company_id": company_id, "period_start": start, "period_end": end, "usage": await billing_usage(company_id, start, end)}


@router.post("/usage-events")
async def record_usage_event(data: UsageEventIn, request: Request, current_user: User = Depends(require_admin)):
    _require_billing_permission(current_user)
    db = get_db()
    async with db.get_session() as session:
        session.add(UsageEvent(company_id=data.company_id, metric=data.metric, quantity=data.quantity, source=data.source, metadata_json=data.metadata))
    await write_audit_log("billing.usage_event_recorded", actor=current_user, company_id=data.company_id, target_type="company", target_id=data.company_id, request=request, metadata={"metric": data.metric, "quantity": data.quantity})
    return {"status": "recorded"}


@router.post("/companies/{company_id}/invoices")
async def generate_invoice(
    company_id: int,
    request: Request,
    year: int = Query(..., ge=2000),
    month: int = Query(..., ge=1, le=12),
    plan_id: Optional[int] = Query(None),
    current_user: User = Depends(require_admin),
):
    _require_billing_permission(current_user)
    db = get_db()
    start, end = month_window(year, month)
    async with db.get_session() as session:
        company = await session.get(Company, company_id)
        if not company:
            raise HTTPException(status_code=404, detail="Company not found")
        selected_plan_id = plan_id or company.billing_plan_id
        if not selected_plan_id:
            raise HTTPException(status_code=400, detail="Company has no billing plan")
        plan = await session.get(BillingPlan, selected_plan_id)
        if not plan:
            raise HTTPException(status_code=400, detail="Billing plan was not found")
        plan_data = {
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
        }

    usage = await billing_usage(company_id, start, end)
    plan_stub = SimpleNamespace(**plan_data)
    amount, lines = invoice_lines(plan_stub, usage)
    currency, exchange_rate = currency_snapshot(current_user)
    amount_display_cents = cents_at_rate(amount, exchange_rate)

    async with db.get_session() as session:
        invoice = BillingInvoice(
            company_id=company_id,
            period_start=start,
            period_end=end,
            currency=currency,
            exchange_rate=exchange_rate,
            amount_cents=amount,
            amount_display_cents=amount_display_cents,
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
            "exchange_rate": invoice.exchange_rate,
            "amount_cents": invoice.amount_cents,
            "amount_display_cents": invoice.amount_display_cents,
            "status": invoice.status,
            "line_items": invoice.line_items,
            "usage": usage,
            "plan": plan_data,
        }
    await write_audit_log("billing.invoice_generated", actor=current_user, company_id=company_id, target_type="billing_invoice", target_id=payload["id"], request=request)
    return payload


@router.get("/companies/{company_id}/invoices")
async def list_invoices(company_id: int, current_user: User = Depends(require_admin)):
    _require_billing_permission(current_user)
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
                "exchange_rate": inv.exchange_rate,
                "amount_cents": inv.amount_cents,
                "amount_display_cents": inv.amount_display_cents,
                "status": inv.status,
                "line_items": inv.line_items or [],
                "created_at": inv.created_at,
            }
            for inv in result.scalars().all()
        ]
