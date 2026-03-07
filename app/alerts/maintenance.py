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
            description= "Fires when a maintenance interval is approaching.",
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
                    field_type = "text",          # plain text input
                    default    = "",
                    required   = False,
                    help_text  = "Used as the alert name when type is 'Custom'.",
                ),
                AlertField(
                    key       = "first_service_km",
                    label     = "First Service At",
                    unit      = "km",
                    default   = 0,
                    min_value = 0,
                    max_value = 999999,
                    required  = True,
                    help_text = "Odometer reading of the first service.",
                ),
                AlertField(
                    key       = "interval_km",
                    label     = "Service Interval",
                    unit      = "km",
                    default   = 5000,
                    min_value = 10,
                    max_value = 100000,
                    help_text = "How often (in km) this service is due.",
                ),
                AlertField(
                    key        = "warning_km",
                    label      = "Warn When Within",
                    unit       = "km",
                    default    = 500,
                    min_value  = 50,
                    max_value  = 2000,
                    required   = False,
                    help_text  = "Start alerting when this many km remain before the service is due.",
                ),
            ],
        )

    async def check(self, position, device, state, params: dict) -> Optional[dict]:
        mtype      = params.get("maintenance_type", "oil_change")
        interval   = params.get("interval_km", 10000)
        warning_km = params.get("warning_km", 500)
        label      = params.get("custom_label") or mtype.replace("_", " ").title()

        odometer  = state.total_odometer or 0
        first_service = params.get("first_service_km", 0)
        offset = first_service % interval if first_service else 0
        remaining = interval - ((odometer - offset) % interval)


        alerted_key = f"maint_{mtype}_alerted"

        if 0 < remaining <= warning_km:
            if not state.alert_states.get(alerted_key):
                state.alert_states[alerted_key] = True
                return {
                    "type":           AlertType.MAINTENANCE,
                    "severity":       Severity.INFO,
                    "message":        f"Maintenance: {label} due in {int(remaining)} km.",
                    "alert_metadata": {
                        "maintenance_type": mtype,
                        "remaining_km":     int(remaining),
                    },
                }
        elif remaining > warning_km:
            state.alert_states[alerted_key] = False

        return None
