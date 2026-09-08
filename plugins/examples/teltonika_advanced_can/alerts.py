"""
Tachograph Hours Alert Example
"""
from typing import Optional
from alerts.base import BaseAlert, AlertDefinition, AlertField
from alerts import register_alert_class
from models.schemas import AlertType, Severity


class TachographHoursAlert(BaseAlert):

    @classmethod
    def definition(cls) -> AlertDefinition:
        return AlertDefinition(
            key="tacho_hours_exceeded",
            alert_type=AlertType.CUSTOM,
            label="Tachograph Driving Hours Breach",
            description="Triggers when tachograph driver state indicates continuous drive time limit reached.",
            icon="⏱️",
            severity=Severity.WARNING,
            fields=[
                AlertField(
                    key="warning_only",
                    label="Warning Only",
                    default=False,
                    field_type="checkbox",
                ),
            ],
        )

    async def check(self, position, device, state, params: dict) -> Optional[dict]:
        return None


register_alert_class(TachographHoursAlert)
