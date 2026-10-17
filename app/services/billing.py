import math
from datetime import datetime
from typing import Any

from sqlalchemy import func, select

from core.database import get_db
from models import Device, PositionRecord, SipCallLog, UsageEvent


def month_window(year: int, month: int) -> tuple[datetime, datetime]:
    start = datetime(year, month, 1)
    if month == 12:
        return start, datetime(year + 1, 1, 1)
    return start, datetime(year, month + 1, 1)


async def billing_usage(company_id: int, start: datetime, end: datetime, session=None) -> dict:
    if session is not None:
        return await _calc_billing_usage(session, company_id, start, end)
    db = get_db()
    async with db.get_session() as s:
        return await _calc_billing_usage(s, company_id, start, end)


async def _calc_billing_usage(session, company_id: int, start: datetime, end: datetime) -> dict:
    devices = (await session.execute(
        select(func.count(func.distinct(PositionRecord.device_id)))
        .join(Device, PositionRecord.device_id == Device.id)
        .where(Device.company_id == company_id, PositionRecord.device_time >= start, PositionRecord.device_time < end)
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
    voip_calls_log = (await session.execute(
        select(func.count(SipCallLog.id))
        .where(SipCallLog.company_id == company_id, SipCallLog.created_at >= start, SipCallLog.created_at < end)
    )).scalar_one() or 0
    voip_calls = max(int(voip_calls_log), int(event_totals.get("voip_call", 0)))
    return {
        "active_devices": int(devices),
        "positions": int(positions),
        "api_calls": int(event_totals.get("api_call", 0)),
        "voip_calls": int(voip_calls),
        "events": event_totals,
    }


def invoice_lines(plan: Any, usage: dict) -> tuple[int, list[dict]]:
    if not usage["active_devices"] and not usage["positions"] and not usage.get("voip_calls") and not any(usage["events"].values()):
        return 0, [
            {"label": "Free inactive period", "quantity": 1, "unit": "period", "amount_cents": 0}
        ]

    base_cents = plan.base_price_cents or 0
    lines = [
        {"label": "Base subscription", "quantity": 1, "unit": "month", "amount_cents": base_cents}
    ]
    amount = base_cents
    extra_devices = max(0, (usage.get("active_devices") or 0) - (plan.included_devices or 0))
    if extra_devices:
        line_amount = extra_devices * (plan.price_per_device_cents or 0)
        amount += line_amount
        lines.append({"label": "Additional active devices", "quantity": extra_devices, "unit": "device", "amount_cents": line_amount})
    extra_positions = max(0, (usage.get("positions") or 0) - (plan.included_positions or 0))
    if extra_positions:
        units = math.ceil(extra_positions / 1000)
        line_amount = units * (plan.price_per_1000_positions_cents or 0)
        amount += line_amount
        lines.append({"label": "Additional position messages", "quantity": extra_positions, "unit": "position", "billable_units": units, "amount_cents": line_amount})
    extra_api = max(0, (usage.get("api_calls") or 0) - (plan.included_api_calls or 0))
    if extra_api:
        units = math.ceil(extra_api / 1000)
        line_amount = units * (plan.price_per_1000_api_calls_cents or 0)
        amount += line_amount
        lines.append({"label": "Additional API calls", "quantity": extra_api, "unit": "call", "billable_units": units, "amount_cents": line_amount})
    extra_voip = max(0, (usage.get("voip_calls") or 0) - (getattr(plan, "included_voip_calls", 0) or 0))
    price_per_voip = getattr(plan, "price_per_voip_call_cents", 0) or 0
    if extra_voip and price_per_voip:
        line_amount = extra_voip * price_per_voip
        amount += line_amount
        lines.append({"label": "Additional VoIP calls", "quantity": extra_voip, "unit": "call", "amount_cents": line_amount})
    return amount, lines
