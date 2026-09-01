import logging
import re
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import select

from models import SimCard
from reports.base import Report, ReportDefinition
from reports.common import filtered_device_map, normalize_utc, round_value, table_payload
from sim_integrations import SimProviderRegistry

logger = logging.getLogger(__name__)


def _normalize_phone(num: Optional[str]) -> str:
    if not num:
        return ""
    digits = re.sub(r"\D", "", str(num))
    return digits.lstrip("0")


class SimCardsReport(Report):
    definition = ReportDefinition(
        key="sim_cards",
        label="SIM Cards",
        description="SIM card data usage, cost, and session history for assigned vehicles over the selected period.",
        renderer="table",
        supports_vehicle_filter=True,
        needs_date_range=True,
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
        start_date = normalize_utc(start_date)
        end_date = normalize_utc(end_date)

        device_map = await filtered_device_map(session, current_user, device_ids)
        if not device_map:
            return table_payload(self.definition.key, [], [], [], start_date, end_date)

        sim_q = select(SimCard).where(SimCard.device_id.in_(device_map.keys()))
        sim_cards = (await session.execute(sim_q)).scalars().all()

        # Group SIM cards by (provider_id, tuple(credentials.items())) to minimize provider queries
        sims_by_account: dict[tuple, list[SimCard]] = {}
        for sc in sim_cards:
            creds_key = (sc.provider_id, tuple(sorted((sc.credentials or {}).items())))
            sims_by_account.setdefault(creds_key, []).append(sc)

        rows: list[dict] = []
        for (provider_id, _), group_sims in sims_by_account.items():
            integration = SimProviderRegistry.get(provider_id) if provider_id else None
            stats = None
            provider_error = None
            creds = group_sims[0].credentials or {}

            if integration:
                try:
                    stats = await integration.get_data_sessions(
                        credentials=creds,
                        date_from=start_date,
                        date_till=end_date,
                    )
                except Exception as e:
                    logger.error("Failed to query data sessions for SIM provider '%s': %s", provider_id, e)
                    stats = None
                    provider_error = str(e)

            # Build normalized lookup map for per-SIM stats
            norm_stats = {}
            if stats and stats.sim_data_sessions:
                for k, v in stats.sim_data_sessions.items():
                    norm_stats[_normalize_phone(k)] = v

            for sc in group_sims:
                device = device_map.get(sc.device_id)
                sim_stats = None
                if stats:
                    norm_phone = _normalize_phone(sc.phone_number)
                    if norm_stats:
                        sim_stats = norm_stats.get(norm_phone)
                    if not sim_stats and len(group_sims) == 1:
                        sim_stats = stats

                total_bytes = sim_stats.total_billsec_bytes if sim_stats else 0
                total_mb = round(total_bytes / (1024 * 1024), 2)
                total_cost = sim_stats.total_user_price if sim_stats else 0.0
                currency = sim_stats.currency if sim_stats else (sc.currency or "EUR")

                # Update live balance, expiry date, and plan on the SIM card record if provider returned it
                if sim_stats and sim_stats.balance is not None:
                    sc.balance = sim_stats.balance
                elif stats and stats.balance is not None:
                    sc.balance = stats.balance

                if sim_stats and sim_stats.currency:
                    sc.currency = sim_stats.currency
                elif stats and stats.currency:
                    sc.currency = stats.currency

                if sim_stats and sim_stats.expiry_date:
                    sc.expiry_date = sim_stats.expiry_date
                elif stats and stats.expiry_date:
                    sc.expiry_date = stats.expiry_date

                if sim_stats and sim_stats.plan_name:
                    sc.plan_name = sim_stats.plan_name
                elif stats and stats.plan_name:
                    sc.plan_name = stats.plan_name

                if sim_stats and sim_stats.remaining_data_mb is not None:
                    sc.remaining_data_mb = sim_stats.remaining_data_mb
                elif stats and getattr(stats, "remaining_data_mb", None) is not None:
                    sc.remaining_data_mb = stats.remaining_data_mb

                status_error = None
                if sim_stats and getattr(sim_stats, "error_message", None):
                    status_error = sim_stats.error_message

                if sim_stats and getattr(sim_stats, "status", None):
                    status_text = sim_stats.status
                elif not sc.provider_id:
                    status_text = "Manual"
                elif stats is None:
                    if not any(bool(v) for v in creds.values()):
                        status_text = "Missing Credentials"
                        status_error = "No credentials configured for this SIM provider."
                    else:
                        status_text = "Connection Error"
                        status_error = provider_error or "Failed to connect to SIM provider."
                else:
                    status_text = "Active" if (sc.balance is None or sc.balance > 0 or (sc.remaining_data_mb is not None and sc.remaining_data_mb > 0)) else "Low Balance"

                rows.append({
                    "vehicle": device.name if device else "-",
                    "license_plate": device.license_plate if device else None,
                    "phone_number": sc.phone_number,
                    "provider": sc.provider_id or "Manual",
                    "account_label": sc.account_label or "-",
                    "plan_name": sc.plan_name or "-",
                    "balance": sc.balance,
                    "remaining_data_mb": sc.remaining_data_mb,
                    "currency": currency,
                    "data_usage_mb": total_mb,
                    "cost": round(total_cost, 2),
                    "expiry_date": sc.expiry_date,
                    "status": status_text,
                    "status_error": status_error,
                })

        try:
            await session.commit()
        except Exception as e:
            logger.warning("Could not persist updated SIM data: %s", e)

        total_mb_all = sum(float(r["data_usage_mb"] or 0) for r in rows)
        total_cost_all = sum(float(r["cost"] or 0) for r in rows)

        summary = [
            {"label": "Assigned SIMs", "value": len(rows)},
            {"label": "Total Data Usage", "value": f"{round_value(total_mb_all, 2)} MB"},
            {"label": "Total Cost", "value": f"{round_value(total_cost_all, 2)} EUR"},
        ]

        columns = [
            {"key": "vehicle", "label": "Vehicle", "type": "text", "detail_key": "license_plate"},
            {"key": "phone_number", "label": "Phone / MSISDN", "type": "text"},
            {"key": "provider", "label": "Provider", "type": "provider"},
            {"key": "plan_name", "label": "Plan", "type": "text"},
            {"key": "data_usage_mb", "label": "Data (MB)", "type": "number", "decimals": 2, "suffix": " MB"},
            {"key": "cost", "label": "Cost", "type": "number", "decimals": 2},
            {"key": "balance", "label": "Balance", "type": "number", "decimals": 2},
            {"key": "remaining_data_mb", "label": "Remaining Data", "type": "number", "decimals": 2, "suffix": " MB", "empty": "—"},
            {"key": "expiry_date", "label": "Expiry", "type": "date", "empty": "—"},
            {"key": "status", "label": "Status", "type": "status"},
        ]

        return table_payload(
            self.definition.key,
            rows,
            columns,
            summary,
            start_date,
            end_date,
            default_sort={"key": "data_usage_mb", "dir": -1},
            csv_filename=(
                f"sim_cards_{start_date.date()}_{end_date.date()}.csv"
                if start_date and end_date
                else "sim_cards.csv"
            ),
        )


report = SimCardsReport()
