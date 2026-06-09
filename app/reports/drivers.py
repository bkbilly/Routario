from datetime import datetime
from typing import Any, Optional

from reports.base import Report, ReportDefinition
from reports.common import round_value, table_payload, trip_rows


class DriverActivityReport(Report):
    definition = ReportDefinition(
        key="drivers",
        label="Driver Activity",
        description="Activity per driver for the selected period — trips, distance, driving time, and top speed.",
        renderer="drivers",
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
        trips = await trip_rows(session, current_user, start_date, end_date, device_ids)
        by_driver = {}
        for trip in trips:
            if not trip.get("driver_name"):
                continue
            key = trip["driver_name"]
            if key not in by_driver:
                by_driver[key] = {"driver": key, "trips": 0, "distance_km": 0.0, "driving_minutes": 0.0, "max_speed": 0.0, "total_avg_speed": 0.0, "vehicles": set()}
            row = by_driver[key]
            row["trips"] += 1
            row["distance_km"] += trip["distance_km"]
            row["driving_minutes"] += trip["duration_minutes"]
            row["max_speed"] = max(row["max_speed"], trip["max_speed"])
            row["total_avg_speed"] += trip["avg_speed"]
            row["vehicles"].add(trip["device_name"])
        rows = []
        for row in by_driver.values():
            rows.append({
                "driver": row["driver"],
                "trips": row["trips"],
                "distance_km": round_value(row["distance_km"], 2),
                "driving_minutes": round_value(row["driving_minutes"], 1),
                "avg_speed": round_value(row["total_avg_speed"] / row["trips"], 1) if row["trips"] else 0,
                "max_speed": round_value(row["max_speed"], 1),
                "vehicle_count": len(row["vehicles"]),
                "vehicle_list": ", ".join(sorted(row["vehicles"])),
            })
        rows.sort(key=lambda r: r["driver"])

        total_trips = sum(r["trips"] for r in rows)
        total_distance = sum(r["distance_km"] for r in rows)
        total_minutes = sum(r["driving_minutes"] for r in rows)
        top_speed = max([r["max_speed"] for r in rows], default=0)
        return table_payload(
            self.definition.key,
            rows,
            [
                {"key": "driver", "label": "Driver", "type": "text"},
                {"key": "trips", "label": "Trips", "type": "integer"},
                {"key": "distance_km", "label": "Distance (km)", "type": "number", "decimals": 1},
                {"key": "driving_minutes", "label": "Drive Time", "type": "duration_minutes"},
                {"key": "avg_speed", "label": "Avg Speed", "type": "number", "decimals": 1, "suffix": " km/h"},
                {"key": "max_speed", "label": "Top Speed", "type": "number", "decimals": 1, "suffix": " km/h"},
                {"key": "vehicle_count", "label": "Vehicles", "type": "integer", "title_key": "vehicle_list"},
            ],
            [
                {"label": "Drivers", "value": len(rows)},
                {"label": "Total Trips", "value": total_trips},
                {"label": "Total Distance (km)", "value": round_value(total_distance, 1)},
                {"label": "Driving Time (h)", "value": round_value(total_minutes / 60, 1)},
                {"label": "Top Speed", "value": f"{round_value(top_speed, 1)} km/h"},
            ],
            start_date,
            end_date,
            default_sort={"key": "driver", "dir": 1},
            csv_filename=f"driver_activity_{start_date.date()}_{end_date.date()}.csv",
            total_row={"driver": "Total", "trips": total_trips, "distance_km": round_value(total_distance, 1), "driving_minutes": round_value(total_minutes, 1), "avg_speed": None, "max_speed": round_value(top_speed, 1), "vehicle_count": None},
        )


report = DriverActivityReport()
