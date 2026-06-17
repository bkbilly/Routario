from datetime import datetime
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, select

from core.audit import write_audit_log
from core.auth import get_current_user, require_company_admin
from core.currency import BASE_CURRENCY, set_currency_rates
from core.database import get_db
from models import CurrencyRate, User

router = APIRouter(prefix="/api/currency", tags=["currency"])


def _require_super_admin(user: User) -> None:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Super admin access required")


class CurrencyRateIn(BaseModel):
    currency: str = Field(..., min_length=3, max_length=3)
    rate: float = Field(..., gt=0)

    @field_validator("currency")
    @classmethod
    def normalize_currency(cls, value: str) -> str:
        return value.upper()


class CurrencyRatesIn(BaseModel):
    rates: list[CurrencyRateIn]


class CurrencyRefreshIn(BaseModel):
    currencies: Optional[list[str]] = None


def _rate_payload(row: CurrencyRate) -> dict:
    return {
        "currency": row.currency,
        "rate": row.rate,
        "source": "system" if row.currency == BASE_CURRENCY else row.source,
        "updated_at": row.updated_at,
    }


def _rate_order_expr():
    return CurrencyRate.currency == BASE_CURRENCY


async def _load_rate_map(session) -> dict[str, float]:
    result = await session.execute(select(CurrencyRate))
    return {row.currency: float(row.rate) for row in result.scalars().all()}


@router.get("/rates")
async def list_rates(_: User = Depends(get_current_user)):
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(select(CurrencyRate).order_by(_rate_order_expr().desc(), CurrencyRate.currency))
        return [_rate_payload(row) for row in result.scalars().all()]


@router.put("/rates")
async def save_rates(data: CurrencyRatesIn, request: Request, current_user: User = Depends(require_company_admin)):
    _require_super_admin(current_user)
    if not any(rate.currency == BASE_CURRENCY for rate in data.rates):
        data.rates.append(CurrencyRateIn(currency=BASE_CURRENCY, rate=1))

    now = datetime.utcnow()
    db = get_db()
    async with db.get_session() as session:
        keep = {item.currency for item in data.rates}
        existing_rates = await _load_rate_map(session)
        existing_sources = {
            row.currency: row.source
            for row in (await session.execute(select(CurrencyRate))).scalars().all()
        }
        for item in data.rates:
            source = "system" if item.currency == BASE_CURRENCY else "manual"
            rate = await session.get(CurrencyRate, item.currency)
            if rate:
                unchanged = abs(float(existing_rates.get(item.currency, 0)) - float(item.rate)) < 0.000000001
                rate.rate = item.rate
                rate.source = "system" if item.currency == BASE_CURRENCY else existing_sources.get(item.currency, "manual") if unchanged else "manual"
                rate.updated_at = now
            else:
                session.add(CurrencyRate(currency=item.currency, rate=item.rate, source=source, updated_at=now))
        await session.execute(delete(CurrencyRate).where(~CurrencyRate.currency.in_(keep), CurrencyRate.currency != BASE_CURRENCY))
        await session.flush()
        rate_map = await _load_rate_map(session)
        result = await session.execute(select(CurrencyRate).order_by(_rate_order_expr().desc(), CurrencyRate.currency))
        payload = [_rate_payload(row) for row in result.scalars().all()]

    set_currency_rates(rate_map)
    await write_audit_log("currency.rates_updated", actor=current_user, target_type="currency_rates", request=request)
    return payload


@router.post("/rates/refresh")
async def refresh_rates(data: CurrencyRefreshIn, request: Request, current_user: User = Depends(require_company_admin)):
    _require_super_admin(current_user)
    db = get_db()
    async with db.get_session() as session:
        existing = await _load_rate_map(session)

    requested = [c.upper() for c in (data.currencies or existing.keys()) if c and c.upper() != BASE_CURRENCY]
    requested = sorted(set(requested))
    if not requested:
        return await list_rates(current_user)

    url = "https://api.frankfurter.dev/v1/latest"
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            response = await client.get(url, params={"from": BASE_CURRENCY, "to": ",".join(requested)})
            response.raise_for_status()
            remote_rates = response.json().get("rates") or {}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not refresh exchange rates: {exc}") from exc

    now = datetime.utcnow()
    db = get_db()
    async with db.get_session() as session:
        base = await session.get(CurrencyRate, BASE_CURRENCY)
        if base:
            base.rate = 1
            base.source = "system"
            base.updated_at = now
        else:
            session.add(CurrencyRate(currency=BASE_CURRENCY, rate=1, source="system", updated_at=now))
        for currency, value in remote_rates.items():
            rate = await session.get(CurrencyRate, currency.upper())
            if rate:
                rate.rate = float(value)
                rate.source = "frankfurter"
                rate.updated_at = now
            else:
                session.add(CurrencyRate(currency=currency.upper(), rate=float(value), source="frankfurter", updated_at=now))
        await session.flush()
        rate_map = await _load_rate_map(session)
        result = await session.execute(select(CurrencyRate).order_by(_rate_order_expr().desc(), CurrencyRate.currency))
        payload = [_rate_payload(row) for row in result.scalars().all()]

    set_currency_rates(rate_map)
    await write_audit_log("currency.rates_refreshed", actor=current_user, target_type="currency_rates", request=request, metadata={"currencies": requested})
    return payload
