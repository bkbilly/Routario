"""
Cold-Chain Temperature Breach Alert Example
"""
from typing import Optional
from alerts.base import BaseAlert, AlertDefinition, AlertField
from alerts import register_alert_class
from models.schemas import AlertType, Severity


class TemperatureBreachAlert(BaseAlert):

    @classmethod
    def definition(cls) -> AlertDefinition:
        return AlertDefinition(
            key="temperature_breach",
            alert_type=AlertType.CUSTOM,
            label="Temperature Breach Alert",
            description="Triggers an alert when cargo temperature breaches configured upper or lower limits.",
            icon="❄️",
            severity=Severity.WARNING,
            fields=[
                AlertField(
                    key="min_temp",
                    label="Minimum Allowed (°C)",
                    default=-20.0,
                    min_value=-50.0,
                    max_value=50.0,
                    unit="°C",
                ),
                AlertField(
                    key="max_temp",
                    label="Maximum Allowed (°C)",
                    default=4.0,
                    min_value=-50.0,
                    max_value=50.0,
                    unit="°C",
                ),
            ],
        )

    async def check(self, position, device, state, params: dict) -> Optional[dict]:
        sensors = position.sensors or {}
        temp = sensors.get("temperature")
        if temp is None:
            return None

        min_val = float(params.get("min_temp", -20.0))
        max_val = float(params.get("max_temp", 4.0))

        if temp < min_val:
            return {
                "triggered": True,
                "message": f"Cold chain critical low: current temperature {temp:.1f}°C is below minimum {min_val:.1f}°C.",
                "data": {"temperature": temp, "limit": min_val, "condition": "below_min"},
            }
        elif temp > max_val:
            return {
                "triggered": True,
                "message": f"Cold chain critical high: current temperature {temp:.1f}°C is above maximum {max_val:.1f}°C.",
                "data": {"temperature": temp, "limit": max_val, "condition": "above_max"},
            }

        return None


register_alert_class(TemperatureBreachAlert)
