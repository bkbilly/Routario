"""
OBD Fuel Drain Alerts Example
"""
from typing import Optional
from alerts.base import BaseAlert, AlertDefinition, AlertField
from alerts import register_alert_class
from models.schemas import AlertType, Severity


class FuelDrainAlert(BaseAlert):

    @classmethod
    def definition(cls) -> AlertDefinition:
        return AlertDefinition(
            key="fuel_drain_theft",
            alert_type=AlertType.CUSTOM,
            label="Fuel Theft & Drain Detection",
            description="Detects rapid fuel level reduction while vehicle is stationary or ignition is off.",
            icon="⛽",
            severity=Severity.CRITICAL,
            fields=[
                AlertField(
                    key="drop_threshold",
                    label="Drop Threshold (%)",
                    default=8.0,
                    min_value=1.0,
                    max_value=50.0,
                    unit="%",
                ),
            ],
        )

    async def check(self, position, device, state, params: dict) -> Optional[dict]:
        return None


register_alert_class(FuelDrainAlert)
