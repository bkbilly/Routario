"""
Tachograph Driver Summary Report Example
"""
from datetime import datetime
from typing import Any, Optional

from reports.base import Report, ReportDefinition
from reports import register_report


class TachographDriverSummaryReport(Report):
    definition = ReportDefinition(
        key="tachograph_driver_summary",
        label="Tachograph Driver Shift & Axle Weight Report",
        description="Summarizes driver work states, resting intervals, and maximum recorded axle loads.",
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
                {"key": "driver_name", "label": "Driver", "type": "text"},
                {"key": "driving_hours", "label": "Driving (h)", "type": "number"},
                {"key": "rest_hours", "label": "Rest (h)", "type": "number"},
                {"key": "max_axle_kg", "label": "Max Axle Load (kg)", "type": "number"},
            ],
            "rows": [],
            "summary_cards": [],
        }


register_report(TachographDriverSummaryReport())
