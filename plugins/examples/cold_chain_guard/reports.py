"""
Cold-Chain Compliance Audit Report Example
"""
from datetime import datetime
from typing import Any, Optional

from reports.base import Report, ReportDefinition
from reports import register_report


class ColdChainComplianceReport(Report):
    definition = ReportDefinition(
        key="cold_chain_compliance",
        label="Cold-Chain Temperature Compliance",
        description="Statistical temperature audit summarizing average, minimum, maximum values and excursion counts.",
        renderer="table",
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
        return {
            "key": self.definition.key,
            "title": self.definition.label,
            "columns": [
                {"key": "device_name", "label": "Device / Asset", "type": "text"},
                {"key": "avg_temp", "label": "Avg Temp (°C)", "type": "number"},
                {"key": "min_temp", "label": "Min Temp (°C)", "type": "number"},
                {"key": "max_temp", "label": "Max Temp (°C)", "type": "number"},
                {"key": "excursions", "label": "Excursions", "type": "number"},
            ],
            "rows": [],
            "summary_cards": [
                {"label": "Total Monitored Assets", "value": "0"},
                {"label": "Excursions", "value": "0"},
            ],
        }


register_report(ColdChainComplianceReport())
