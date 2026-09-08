"""
Samsara Cloud Sync Error Alert Example
"""
from typing import Optional
from alerts.base import BaseAlert, AlertDefinition, AlertField
from alerts import register_alert_class
from models.schemas import AlertType, Severity


class SamsaraSyncAlert(BaseAlert):

    @classmethod
    def definition(cls) -> AlertDefinition:
        return AlertDefinition(
            key="samsara_sync_error",
            alert_type=AlertType.CUSTOM,
            label="Samsara Cloud Sync Failure",
            description="Triggers when third-party Samsara integration synchronization encounters an error.",
            icon="⚠️",
            severity=Severity.WARNING,
            fields=[],
        )

    async def check(self, position, device, state, params: dict) -> Optional[dict]:
        return None


register_alert_class(SamsaraSyncAlert)
