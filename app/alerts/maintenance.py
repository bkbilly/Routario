import math
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
                    key       = "next_service_km",
                    label     = "Next Service At",
                    unit      = "km",
                    default   = 0,
                    min_value = 0,
                    max_value = 9999999,
                    required  = True,
                    help_text = "Odometer reading at which the next service is due.",
                ),
                AlertField(
                    key       = "interval_km",
                    label     = "Repeat Every",
                    unit      = "km",
                    default   = 5000,
                    min_value = 10,
                    max_value = 100000,
                    help_text = "After the first service, how often (in km) to repeat.",
                ),
                AlertField(
                    key       = "warning_km",
                    label     = "Warn When Within",
                    unit      = "km",
                    default   = 500,
                    min_value = 10,
                    max_value = 5000,
                    required  = False,
                    help_text = "Fire a warning alert this many km before the service is due.",
                ),
            ],
        )

    async def check_many(self, position, device, state, params: dict) -> list:
        mtype        = params.get("maintenance_type", "service")
        next_service = float(params.get("next_service_km", 0))
        interval_km  = float(params.get("interval_km", 5000))
        warning_km   = float(params.get("warning_km", 500))
        label        = params.get("custom_label") or mtype.replace("_", " ").title()

        if interval_km <= 0:
            return []

        odometer = float(state.total_odometer or 0)

        # Find the upcoming service km: the first point in the series
        # {next_service, next_service+interval, ...} that is >= odometer.
        if odometer <= next_service:
            due_km = next_service
        else:
            n      = math.ceil((odometer - next_service) / interval_km)
            due_km = next_service + n * interval_km

        warned_key = f"maint_{mtype}_warned_at"
        due_key    = f"maint_{mtype}_due_at"

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

    async def check(self, position, device, state, params: dict) -> Optional[dict]:
        return None
