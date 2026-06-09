from datetime import date, datetime, timedelta
from typing import Any, Optional
import math

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from reports.base import Report, ReportDefinition
from reports.common import filtered_device_map, round_value, table_payload


def _maintenance_label(params: dict) -> str:
    mtype = params.get("maintenance_type", "service")
    return params.get("custom_label") or str(mtype).replace("_", " ").title()


def _next_due_km(current_km: float, next_service_km: float, interval_km: float) -> float:
    if interval_km <= 0:
        return next_service_km
    if current_km <= next_service_km:
        return next_service_km
    return next_service_km + math.ceil((current_km - next_service_km) / interval_km) * interval_km


def _next_due_date(next_service: str, interval_days: int) -> Optional[date]:
    if not next_service or interval_days <= 0:
        return None
    try:
        base = date.fromisoformat(next_service)
    except ValueError:
        return None
    today = datetime.utcnow().date()
    if today <= base:
        return base
    return base + timedelta(days=math.ceil((today - base).days / interval_days) * interval_days)


class LogbookReport(Report):
    definition = ReportDefinition(
        key="logbook",
        label="Logbook",
        description="Fuel or maintenance logbook reports for the selected vehicles and period.",
        renderer="logbook",
        controls=(
            {
                "key": "logbook_type",
                "label": "Logbook Type",
                "type": "select",
                "default": "maintenance",
                "options": [
                    {"value": "maintenance", "label": "Maintenance"},
                    {"value": "fuel", "label": "Fuel"},
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
        from models import DeviceState, FuelLog, LogbookEntry

        logbook_type = (options or {}).get("logbook_type") or "maintenance"
        if logbook_type not in {"maintenance", "fuel"}:
            logbook_type = "maintenance"

        device_map = await filtered_device_map(session, current_user, device_ids)
        if not device_map:
            return table_payload(self.definition.key, [], [], [], start_date, end_date)

        rows: list[dict] = []

        if logbook_type == "fuel":
            fuel_result = await session.execute(
                select(FuelLog)
                .where(
                    FuelLog.device_id.in_(device_map.keys()),
                    FuelLog.date >= start_date,
                    FuelLog.date <= end_date,
                )
                .order_by(FuelLog.date.desc())
            )
            for log in fuel_result.scalars().all():
                device = device_map.get(log.device_id)
                total_cost = (log.liters or 0) * (log.price_per_liter or 0) if log.price_per_liter is not None else None
                rows.append({
                    "vehicle": device.name if device else f"Vehicle {log.device_id}",
                    "license_plate": device.license_plate if device else None,
                    "date": log.date.isoformat() if log.date else None,
                    "description": "Fuel fill-up",
                    "odometer_km": log.odometer_km,
                    "liters": log.liters,
                    "price_per_liter": log.price_per_liter,
                    "cost": round_value(total_cost, 2) if total_cost is not None else None,
                    "status": "Full tank" if log.full_tank else "Partial",
                    "notes": log.notes,
                })

        if logbook_type == "maintenance":
            service_result = await session.execute(
                select(LogbookEntry)
                .where(
                    LogbookEntry.device_id.in_(device_map.keys()),
                    LogbookEntry.date >= start_date,
                    LogbookEntry.date <= end_date,
                )
                .order_by(LogbookEntry.date.desc())
            )
            for entry in service_result.scalars().all():
                device = device_map.get(entry.device_id)
                rows.append({
                    "vehicle": device.name if device else f"Vehicle {entry.device_id}",
                    "license_plate": device.license_plate if device else None,
                    "date": entry.date.isoformat() if entry.date else None,
                    "description": entry.description,
                    "odometer_km": entry.odometer,
                    "liters": None,
                    "price_per_liter": None,
                    "cost": entry.price,
                    "status": "Service Entry",
                    "notes": "Documents" if entry.documents else None,
                })

            state_result = await session.execute(
                select(DeviceState)
                .where(DeviceState.device_id.in_(device_map.keys()))
                .options(selectinload(DeviceState.device))
            )
            state_map = {s.device_id: s for s in state_result.scalars().all()}
            today = datetime.utcnow().date()

            for device in device_map.values():
                for item in device.config.get("alert_rows", []) if isinstance(device.config, dict) else []:
                    if not isinstance(item, dict) or item.get("alertKey") != "maintenance_alert":
                        continue
                    params = dict(item.get("params") or {})
                    mode = params.get("tracking_mode", "km")
                    state = state_map.get(device.id)
                    current_km = float(state.total_odometer or 0) if state else 0.0

                    due_km = remaining_km = None
                    due_date = None
                    days_remaining = None
                    status = "Scheduled"
                    status_rank = 0

                    if mode in ("km", "both"):
                        due_km = _next_due_km(
                            current_km,
                            float(params.get("next_service_km") or 0),
                            float(params.get("interval_km") or 0),
                        )
                        remaining_km = due_km - current_km
                        warning_km = float(params.get("warning_km") or 0)
                        if remaining_km <= 0:
                            status, status_rank = "Due", 2
                        elif warning_km and remaining_km <= warning_km:
                            status, status_rank = "Due Soon", max(status_rank, 1)

                    if mode in ("days", "both"):
                        due_date = _next_due_date(
                            str(params.get("next_service_date") or ""),
                            int(params.get("interval_days") or 0),
                        )
                        if due_date:
                            days_remaining = (due_date - today).days
                            warning_days = int(params.get("warning_days") or 0)
                            if days_remaining <= 0:
                                status, status_rank = "Due", 2
                            elif warning_days and days_remaining <= warning_days and status_rank < 2:
                                status, status_rank = "Due Soon", max(status_rank, 1)

                    rows.append({
                        "vehicle": device.name,
                        "license_plate": device.license_plate,
                        "date": due_date.isoformat() if due_date else None,
                        "description": _maintenance_label(params),
                        "odometer_km": due_km,
                        "liters": None,
                        "price_per_liter": None,
                        "cost": None,
                        "status": status,
                        "notes": (
                            f"{round_value(remaining_km, 0)} km remaining" if remaining_km is not None else
                            f"{days_remaining} days remaining" if days_remaining is not None else None
                        ),
                    })

        total_fuel = sum(float(r["liters"] or 0) for r in rows)
        total_cost = sum(float(r["cost"] or 0) for r in rows)
        due_count = sum(1 for r in rows if r["status"] == "Due")
        soon_count = sum(1 for r in rows if r["status"] == "Due Soon")
        summary = [
            {"label": "Entries", "value": len(rows)},
        ]
        if logbook_type == "fuel":
            summary += [
                {"label": "Fuel (L)", "value": round_value(total_fuel, 1)},
                {"label": "Total Cost", "value": round_value(total_cost, 2)},
            ]
        else:
            summary += [
                {"label": "Maintenance Due", "value": due_count, "tone": "danger" if due_count else "success"},
                {"label": "Due Soon", "value": soon_count, "tone": "warning" if soon_count else "success"},
                {"label": "Service Entries", "value": sum(1 for r in rows if r["status"] == "Service Entry")},
            ]

        columns = [
            {"key": "vehicle", "label": "Vehicle", "type": "text", "detail_key": "license_plate"},
            {"key": "date", "label": "Date / Due", "type": "datetime_split", "empty": "-"},
            {"key": "description", "label": "Description", "type": "text", "max_width": 220},
            {"key": "odometer_km", "label": "Odometer / Due", "type": "number", "decimals": 0, "suffix": " km"},
        ]
        if logbook_type == "fuel":
            columns += [
                {"key": "liters", "label": "Liters", "type": "number", "decimals": 1},
                {"key": "cost", "label": "Cost", "type": "number", "decimals": 2},
                {"key": "price_per_liter", "label": "Price/L", "type": "number", "decimals": 3},
                {"key": "status", "label": "Status", "type": "text", "empty": "-"},
                {"key": "notes", "label": "Notes", "type": "text", "max_width": 260},
            ]
        else:
            columns += [
                {"key": "status", "label": "Status", "type": "text", "empty": "-"},
                {"key": "notes", "label": "Remaining", "type": "text", "max_width": 220},
            ]

        return table_payload(
            self.definition.key,
            rows,
            columns,
            summary,
            start_date,
            end_date,
            default_sort={"key": "date", "dir": -1},
            csv_filename=f"logbook_{logbook_type}_{start_date.date()}_{end_date.date()}.csv",
        )


report = LogbookReport()
