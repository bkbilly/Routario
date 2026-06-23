from datetime import datetime
from types import SimpleNamespace
from typing import Any, Optional

from sqlalchemy import select

from core.currency import cents_at_rate, currency_snapshot
from reports.base import Report, ReportDefinition
from reports.common import table_payload
from services.billing import billing_usage, invoice_lines, month_window


def _period_window(period: str, now: Optional[datetime] = None) -> tuple[datetime, datetime, str, list[tuple[int, int, str]]]:
    now = now or datetime.utcnow()
    year = now.year
    month = now.month

    if period == "last_month":
        if month == 1:
            year -= 1
            month = 12
        else:
            month -= 1
        start, end = month_window(year, month)
        label = start.strftime("%B %Y")
        return start, end, label, [(year, month, label)]

    if period == "this_year":
        months = [(year, m, datetime(year, m, 1).strftime("%b")) for m in range(1, month + 1)]
        return datetime(year, 1, 1), now, str(year), months

    if period == "last_year":
        year -= 1
        months = [(year, m, datetime(year, m, 1).strftime("%b")) for m in range(1, 13)]
        return datetime(year, 1, 1), datetime(year + 1, 1, 1), str(year), months

    start, end = month_window(year, month)
    label = start.strftime("%B %Y")
    return start, end, label, [(year, month, label)]


def _plan_stub(plan: Any) -> SimpleNamespace:
    return SimpleNamespace(
        base_price_cents=plan.base_price_cents,
        included_devices=plan.included_devices,
        included_positions=plan.included_positions,
        included_api_calls=plan.included_api_calls,
        price_per_device_cents=plan.price_per_device_cents,
        price_per_1000_positions_cents=plan.price_per_1000_positions_cents,
        price_per_1000_api_calls_cents=plan.price_per_1000_api_calls_cents,
    )


def _line_amounts(lines: list[dict], exchange_rate: float) -> list[dict]:
    return [
        {
            **line,
            "amount_display_cents": cents_at_rate(int(line.get("amount_cents") or 0), exchange_rate),
        }
        for line in lines
    ]


def _plan_details(plan: Any, exchange_rate: float) -> Optional[dict]:
    if not plan:
        return None
    return {
        "id": plan.id,
        "name": plan.name,
        "currency": plan.currency,
        "is_active": plan.is_active,
        "base_price_cents": plan.base_price_cents,
        "base_price_display_cents": cents_at_rate(plan.base_price_cents, exchange_rate),
        "included_devices": plan.included_devices,
        "included_positions": plan.included_positions,
        "included_api_calls": plan.included_api_calls,
        "price_per_device_cents": plan.price_per_device_cents,
        "price_per_device_display_cents": cents_at_rate(plan.price_per_device_cents, exchange_rate),
        "price_per_1000_positions_cents": plan.price_per_1000_positions_cents,
        "price_per_1000_positions_display_cents": cents_at_rate(plan.price_per_1000_positions_cents, exchange_rate),
        "price_per_1000_api_calls_cents": plan.price_per_1000_api_calls_cents,
        "price_per_1000_api_calls_display_cents": cents_at_rate(plan.price_per_1000_api_calls_cents, exchange_rate),
    }


async def billing_detail_payload(session, current_user: Any, company_id: int, period: str) -> Optional[dict]:
    from models import BillingPlan, Company

    company_stmt = select(Company).where(Company.id == company_id)
    if not current_user.is_admin:
        company_stmt = company_stmt.where(Company.id == current_user.company_id)

    company = (await session.execute(company_stmt)).scalar_one_or_none()
    if not company:
        return None

    start, end, period_label, months = _period_window(period)
    currency, exchange_rate = currency_snapshot(current_user)

    plan = await session.get(BillingPlan, company.billing_plan_id) if company.billing_plan_id else None
    totals = {"active_devices": 0, "positions": 0, "api_calls": 0, "amount_cents": 0}
    events: dict[str, int] = {}
    line_totals: dict[tuple[str, str], dict] = {}
    monthly = []

    for year, month, label in months:
        month_start, month_end = month_window(year, month)
        usage = await billing_usage(company.id, month_start, month_end)
        lines = []
        amount_cents = 0
        if plan:
            amount_cents, lines = invoice_lines(_plan_stub(plan), usage)
            for line in lines:
                key = (line.get("label") or "", line.get("unit") or "")
                if key not in line_totals:
                    line_totals[key] = {
                        "label": line.get("label"),
                        "quantity": 0,
                        "unit": line.get("unit"),
                        "billable_units": 0,
                        "amount_cents": 0,
                    }
                line_totals[key]["quantity"] += int(line.get("quantity") or 0)
                line_totals[key]["billable_units"] += int(line.get("billable_units") or 0)
                line_totals[key]["amount_cents"] += int(line.get("amount_cents") or 0)

        totals["active_devices"] += int(usage.get("active_devices") or 0)
        totals["positions"] += int(usage.get("positions") or 0)
        totals["api_calls"] += int(usage.get("api_calls") or 0)
        totals["amount_cents"] += amount_cents
        for metric, quantity in (usage.get("events") or {}).items():
            events[metric] = events.get(metric, 0) + int(quantity or 0)

        monthly.append({
            "label": label,
            "period_start": month_start.isoformat(),
            "period_end": month_end.isoformat(),
            "usage": usage,
            "line_items": _line_amounts(lines, exchange_rate),
            "amount_cents": amount_cents,
            "amount_display_cents": cents_at_rate(amount_cents, exchange_rate),
        })

    return {
        "company": {
            "id": company.id,
            "name": company.name,
            "billing_email": company.billing_email,
            "billing_status": company.billing_status,
        },
        "period": {
            "key": period,
            "label": period_label,
            "start": start.isoformat(),
            "end": end.isoformat(),
        },
        "currency": currency,
        "plan": _plan_details(plan, exchange_rate),
        "usage": {
            "active_devices": totals["active_devices"],
            "positions": totals["positions"],
            "api_calls": totals["api_calls"],
            "events": events,
        },
        "line_items": _line_amounts(list(line_totals.values()), exchange_rate),
        "monthly": monthly,
        "total_cents": totals["amount_cents"],
        "total_display_cents": cents_at_rate(totals["amount_cents"], exchange_rate),
    }


class BillingReport(Report):
    definition = ReportDefinition(
        key="billing",
        label="Billing",
        description="Draft billing usage and totals by company for the selected billing period.",
        needs_date_range=False,
        supports_vehicle_filter=False,
        company_admin_required=True,
        schedule_uses_device_filter=False,
        controls=(
            {
                "key": "period",
                "label": "Period",
                "type": "select",
                "default": "this_month",
                "options": [
                    {"value": "this_month", "label": "This month"},
                    {"value": "last_month", "label": "Last month"},
                    {"value": "this_year", "label": "This year"},
                    {"value": "last_year", "label": "Last year"},
                ],
            },
        ),
    )

    async def run(
        self,
        session,
        current_user: Any,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        device_ids: Optional[list[int]] = None,
        user_ids: Optional[list[int]] = None,
        driver_ids: Optional[list[int]] = None,
        options: Optional[dict[str, Any]] = None,
        historical: bool = False,
    ) -> dict:
        from models import BillingPlan, Company

        period = (options or {}).get("period") or "this_month"
        start, end, period_label, months = _period_window(period)
        currency, exchange_rate = currency_snapshot(current_user)

        company_stmt = select(Company).order_by(Company.name)
        if not current_user.is_admin:
            company_stmt = company_stmt.where(Company.id == current_user.company_id)

        companies = (await session.execute(company_stmt)).scalars().all()
        plan_ids = {c.billing_plan_id for c in companies if c.billing_plan_id}
        plans = {}
        if plan_ids:
            plan_rows = (await session.execute(select(BillingPlan).where(BillingPlan.id.in_(plan_ids)))).scalars().all()
            plans = {p.id: p for p in plan_rows}

        rows = []
        totals = {"active_devices": 0, "positions": 0, "api_calls": 0, "amount_cents": 0}

        for company in companies:
            plan = plans.get(company.billing_plan_id)
            usage = {"active_devices": 0, "positions": 0, "api_calls": 0, "events": {}}
            amount_cents = 0
            line_totals = {
                "Base subscription": 0,
                "Additional active devices": 0,
                "Additional position messages": 0,
                "Additional API calls": 0,
            }

            for year, month, _label in months:
                month_start, month_end = month_window(year, month)
                month_usage = await billing_usage(company.id, month_start, month_end)
                usage["active_devices"] += int(month_usage.get("active_devices") or 0)
                usage["positions"] += int(month_usage.get("positions") or 0)
                usage["api_calls"] += int(month_usage.get("api_calls") or 0)
                for metric, quantity in (month_usage.get("events") or {}).items():
                    usage["events"][metric] = usage["events"].get(metric, 0) + int(quantity or 0)

                if plan:
                    month_amount, lines = invoice_lines(_plan_stub(plan), month_usage)
                    amount_cents += month_amount
                    for line in lines:
                        label = line.get("label")
                        if label in line_totals:
                            line_totals[label] += int(line.get("amount_cents") or 0)

            totals["active_devices"] += usage["active_devices"]
            totals["positions"] += usage["positions"]
            totals["api_calls"] += usage["api_calls"]
            totals["amount_cents"] += amount_cents

            rows.append({
                "company_id": company.id,
                "company_name": company.name,
                "plan_name": plan.name if plan else "No billing plan",
                "period_key": period,
                "period": period_label,
                "active_devices": usage["active_devices"],
                "positions": usage["positions"],
                "api_calls": usage["api_calls"],
                "base_cents": cents_at_rate(line_totals["Base subscription"], exchange_rate),
                "device_overage_cents": cents_at_rate(line_totals["Additional active devices"], exchange_rate),
                "position_overage_cents": cents_at_rate(line_totals["Additional position messages"], exchange_rate),
                "api_overage_cents": cents_at_rate(line_totals["Additional API calls"], exchange_rate),
                "total_cents": cents_at_rate(amount_cents, exchange_rate),
                "currency": currency,
            })

        return table_payload(
            self.definition.key,
            rows,
            [
                {"key": "company_name", "label": "Company", "type": "text"},
                {"key": "company_id", "label": "Company ID", "type": "integer", "hidden": True},
                {"key": "plan_name", "label": "Plan", "type": "text"},
                {"key": "period_key", "label": "Period Key", "type": "text", "hidden": True},
                {"key": "period", "label": "Period", "type": "text"},
                {"key": "active_devices", "label": "Devices", "type": "integer"},
                {"key": "positions", "label": "Positions", "type": "integer"},
                {"key": "api_calls", "label": "API Calls", "type": "integer"},
                {"key": "base_cents", "label": "Base", "type": "currency_cents", "currency_key": "currency"},
                {"key": "device_overage_cents", "label": "Device Overage", "type": "currency_cents", "currency_key": "currency"},
                {"key": "position_overage_cents", "label": "Position Overage", "type": "currency_cents", "currency_key": "currency"},
                {"key": "api_overage_cents", "label": "API Overage", "type": "currency_cents", "currency_key": "currency"},
                {"key": "total_cents", "label": "Draft Total", "type": "currency_cents", "currency_key": "currency"},
            ],
            [
                {"label": "Companies", "value": len(rows)},
                {"label": "Active Devices", "value": totals["active_devices"]},
                {"label": "Positions", "value": totals["positions"]},
                {"label": "API Calls", "value": totals["api_calls"]},
                {"label": "Draft Total", "value": f"{currency} {cents_at_rate(totals['amount_cents'], exchange_rate) / 100:.2f}"},
            ],
            start,
            end,
            default_sort={"key": "company_name", "dir": 1},
            csv_filename=f"billing_report_{period}.csv",
            row_action={"type": "billing_detail", "label": "View billing details"},
            total_row={
                "company_name": "Total",
                "active_devices": totals["active_devices"],
                "positions": totals["positions"],
                "api_calls": totals["api_calls"],
                "total_cents": cents_at_rate(totals["amount_cents"], exchange_rate),
                "currency": currency,
            },
        )


report = BillingReport()
