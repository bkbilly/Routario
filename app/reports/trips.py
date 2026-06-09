from datetime import datetime
from typing import Any, Optional

from reports.base import Report, ReportDefinition
from reports.common import round_value, table_payload, trip_rows


class TripListReport(Report):
    definition = ReportDefinition(
        key="trips",
        label="Trip List",
        description="Individual trips with start/end location, distance, duration, and driver. Click any row to view the route on a map.",
        renderer="trips",
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
        rows = await trip_rows(session, current_user, start_date, end_date, device_ids)
        total_distance = sum(r["distance_km"] for r in rows)
        total_minutes = sum(r["duration_minutes"] for r in rows)
        top_speed = max([r["max_speed"] for r in rows], default=0)
        return {
            **table_payload(
                self.definition.key,
                rows,
                [
                    {"key": "start_time", "label": "Date", "type": "datetime"},
                    {"key": "device_name", "label": "Vehicle", "type": "text", "detail_key": "license_plate"},
                    {"key": "start_address", "label": "From", "type": "text", "max_width": 180},
                    {"key": "end_address", "label": "To", "type": "text", "max_width": 180},
                    {"key": "distance_km", "label": "Distance (km)", "type": "number", "decimals": 1},
                    {"key": "duration_minutes", "label": "Duration", "type": "duration_minutes"},
                    {"key": "avg_speed", "label": "Avg Speed", "type": "number", "decimals": 1, "suffix": " km/h"},
                    {"key": "max_speed", "label": "Top Speed", "type": "number", "decimals": 1, "suffix": " km/h"},
                    {"key": "driver_name", "label": "Driver", "type": "text"},
                ],
                [
                    {"label": "Trips", "value": len(rows)},
                    {"label": "Total Distance (km)", "value": round_value(total_distance, 1)},
                    {"label": "Driving Time (h)", "value": round_value(total_minutes / 60, 1)},
                    {"label": "Top Speed", "value": f"{round_value(top_speed, 1)} km/h"},
                ],
                start_date,
                end_date,
                default_sort={"key": "start_time", "dir": -1},
                csv_filename=f"trip_list_{start_date.date()}_{end_date.date()}.csv",
                row_action={"type": "trip_map"},
            )
        }


report = TripListReport()
