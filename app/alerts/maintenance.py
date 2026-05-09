import math
from datetime import datetime, timedelta, date
from typing import Optional

from .base import BaseAlert, AlertDefinition, AlertField
from models.schemas import AlertType, Severity


class MaintenanceAlert(BaseAlert):

    @classmethod
    def definition(cls) -> AlertDefinition:
        return AlertDefinition(
            key        = "maintenance_alert",
            alert_type = AlertType.MAINTENANCE,
            label      = "Maintenance Due",
            description= "Fires when a maintenance interval is approaching or due.",
            icon       = "🔧",
            severity   = Severity.INFO,
            state_keys = [],
            fields     = [
                AlertField(
                    key        = "maintenance_type",
                    label      = "Maintenance Type",
                    field_type = "select",
                    default    = "service",
                    required   = True,
                    options    = [
                        {"value": "service",       "label": "🔧 Service"},
                        {"value": "oil_change",    "label": "🛢️ Oil Change"},
                        {"value": "tire_change",   "label": "🔄 Tire Change"},
                        {"value": "brake_service", "label": "🛑 Brake Service"},
                        {"value": "air_filter",    "label": "💨 Air Filter"},
                        {"value": "custom",        "label": "⚙️ Custom"},
                    ],
                    help_text  = "Which maintenance interval to track.",
                ),
                AlertField(
                    key        = "custom_label",
                    label      = "Custom Label",
                    field_type = "text",
                    default    = "",
                    required   = False,
                    help_text  = "Used as the alert name when type is 'Custom'.",
                    show_if    = {"key": "maintenance_type", "value": "custom"},
                ),
                AlertField(
                    key        = "tracking_mode",
                    label      = "Track By",
                    field_type = "select",
                    default    = "km",
                    required   = True,
                    options    = [
                        {"value": "km",   "label": "Mileage only"},
                        {"value": "days", "label": "Time only"},
                        {"value": "both", "label": "Either (whichever comes first)"},
                    ],
                    help_text  = "What triggers the maintenance alert.",
                ),
                # ── Mileage fields ─────────────────────────────────────────
                AlertField(
                    key       = "next_service_km",
                    label     = "Next Service At",
                    unit      = "km",
                    default   = 0,
                    min_value = 0,
                    max_value = 9999999,
                    required  = True,
                    help_text = "Odometer reading at which the next service is due.",
                    show_if   = {"key": "tracking_mode", "values": ["km", "both"]},
                ),
                AlertField(
                    key       = "interval_km",
                    label     = "Repeat Every",
                    unit      = "km",
                    default   = 5000,
                    min_value = 10,
                    max_value = 100000,
                    help_text = "After the first service, how often (in km) to repeat.",
                    show_if   = {"key": "tracking_mode", "values": ["km", "both"]},
                ),
                AlertField(
                    key       = "warning_km",
                    label     = "Warn When Within",
                    unit      = "km",
                    default   = 500,
                    min_value = 10,
                    max_value = 5000,
                    required  = False,
                    help_text = "Fire a warning this many km before the service is due.",
                    show_if   = {"key": "tracking_mode", "values": ["km", "both"]},
                ),
                # ── Time fields ────────────────────────────────────────────
                AlertField(
                    key        = "next_service_date",
                    label      = "Next Service Date",
                    field_type = "date",
                    default    = "",
                    required   = True,
                    help_text  = "Date when the next service is due.",
                    show_if    = {"key": "tracking_mode", "values": ["days", "both"]},
                ),
                AlertField(
                    key       = "interval_days",
                    label     = "Repeat Every",
                    unit      = "days",
                    default   = 180,
                    min_value = 1,
                    max_value = 3650,
                    help_text = "How often (in days) to repeat after the first due date.",
                    show_if   = {"key": "tracking_mode", "values": ["days", "both"]},
                ),
                AlertField(
                    key       = "warning_days",
                    label     = "Warn When Within",
                    unit      = "days",
                    default   = 14,
                    min_value = 1,
                    max_value = 365,
                    required  = False,
                    help_text = "Fire a warning this many days before the service is due.",
                    show_if   = {"key": "tracking_mode", "values": ["days", "both"]},
                ),
            ],
        )

    # ── Mileage check — called on each incoming position ─────────────────────

    async def check_many(self, position, device, state, params: dict) -> list:
        tracking_mode = params.get("tracking_mode", "km")
        if tracking_mode not in ("km", "both"):
            return []

        mtype        = params.get("maintenance_type", "service")
        next_service = float(params.get("next_service_km", 0))
        interval_km  = float(params.get("interval_km", 5000))
        warning_km   = float(params.get("warning_km", 500))
        label        = params.get("custom_label") or mtype.replace("_", " ").title()

        if interval_km <= 0:
            return []

        odometer = float(state.total_odometer or 0)

        if odometer <= next_service:
            due_km = next_service
        else:
            n      = math.ceil((odometer - next_service) / interval_km)
            due_km = next_service + n * interval_km

        warned_key = f"maint_{mtype}_km_warned_at"
        due_key    = f"maint_{mtype}_km_due_at"

        warned_at = state.alert_states.get(warned_key)
        due_at    = state.alert_states.get(due_key)

        alerts = []

        if odometer >= due_km:
            if due_at != due_km:
                state.alert_states[due_key]    = due_km
                state.alert_states[warned_key] = due_km
                alerts.append({
                    "type":           AlertType.MAINTENANCE,
                    "severity":       Severity.WARNING,
                    "message":        f"Maintenance: {label} is due now! (at {int(due_km)} km)",
                    "alert_metadata": {
                        "maintenance_type": mtype,
                        "due_km":           int(due_km),
                        "remaining_km":     0,
                    },
                })
        elif odometer >= due_km - warning_km:
            remaining = due_km - odometer
            if warned_at != due_km:
                state.alert_states[warned_key] = due_km
                alerts.append({
                    "type":           AlertType.MAINTENANCE,
                    "severity":       Severity.INFO,
                    "message":        f"Maintenance: {label} due in {int(remaining)} km (at {int(due_km)} km).",
                    "alert_metadata": {
                        "maintenance_type": mtype,
                        "due_km":           int(due_km),
                        "remaining_km":     int(remaining),
                    },
                })

        return alerts

    # ── Time check — called by periodic_alert_task (no position needed) ───────

    async def check_device(self, device, state, params: dict) -> Optional[dict]:
        tracking_mode = params.get("tracking_mode", "km")
        if tracking_mode not in ("days", "both"):
            return None

        mtype            = params.get("maintenance_type", "service")
        next_service_str = params.get("next_service_date", "")
        interval_days    = int(params.get("interval_days", 180))
        warning_days     = int(params.get("warning_days", 14))
        label            = params.get("custom_label") or mtype.replace("_", " ").title()

        if not next_service_str or interval_days <= 0:
            return None

        try:
            next_service_date = date.fromisoformat(next_service_str)
        except ValueError:
            return None

        today        = datetime.utcnow().date()
        days_elapsed = (today - next_service_date).days

        if days_elapsed <= 0:
            due_date = next_service_date
        else:
            n        = math.ceil(days_elapsed / interval_days)
            due_date = next_service_date + timedelta(days=n * interval_days)

        due_str    = due_date.isoformat()
        warned_key = f"maint_{mtype}_days_warned_at"
        due_key    = f"maint_{mtype}_days_due_at"

        warned_at      = state.alert_states.get(warned_key)
        due_at         = state.alert_states.get(due_key)
        days_remaining = (due_date - today).days

        if days_remaining <= 0:
            if due_at != due_str:
                state.alert_states[due_key]    = due_str
                state.alert_states[warned_key] = due_str
                return {
                    "type":     AlertType.MAINTENANCE,
                    "severity": Severity.WARNING,
                    "message":  f"Maintenance: {label} is due today! (scheduled {due_str})",
                    "alert_metadata": {
                        "maintenance_type": mtype,
                        "due_date":         due_str,
                        "days_remaining":   0,
                    },
                }
        elif days_remaining <= warning_days:
            if warned_at != due_str:
                state.alert_states[warned_key] = due_str
                return {
                    "type":     AlertType.MAINTENANCE,
                    "severity": Severity.INFO,
                    "message":  f"Maintenance: {label} due in {days_remaining} day(s) (on {due_str}).",
                    "alert_metadata": {
                        "maintenance_type": mtype,
                        "due_date":         due_str,
                        "days_remaining":   days_remaining,
                    },
                }

        return None

    async def check(self, position, device, state, params: dict) -> Optional[dict]:
        return None
