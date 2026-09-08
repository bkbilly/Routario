"""
Fuel Eco-Driving Scorecard Report Example
"""
from datetime import datetime
from typing import Any, Optional

from reports.base import Report, ReportDefinition
from reports import register_report


class FuelEcoScorecardReport(Report):
    definition = ReportDefinition(
        key="fuel_eco_scorecard",
        label="Fuel Efficiency & Eco-Driving Scorecard",
        description="Aggregates fuel consumption rates, estimated idle fuel waste, and eco-driving performance score.",
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
                {"key": "device_name", "label": "Vehicle", "type": "text"},
                {"key": "eco_score", "label": "Eco Score", "type": "number"},
                {"key": "idle_pct", "label": "Idle %", "type": "number"},
                {"key": "fuel_used_l", "label": "Fuel Used (L)", "type": "number"},
            ],
            "rows": [],
            "summary_cards": [
                {"label": "Avg Fleet Eco Score", "value": "92/100"},
            ],
        }


register_report(FuelEcoScorecardReport())
