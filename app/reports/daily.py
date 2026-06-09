from datetime import datetime
from typing import Any, Optional

from reports.base import Report, ReportDefinition
from reports.common import round_value, table_payload, trip_rows


class DailyActivityReport(Report):
    definition = ReportDefinition(
        key="daily",
        label="Daily Activity",
        description="Trip activity aggregated by day for the whole fleet, each vehicle, or each driver.",
        renderer="daily",
        supports_driver_filter=True,
        controls=(
            {
                "key": "group_by",
                "label": "Daily Breakdown",
                "type": "select",
                "default": "fleet",
                "options": [
                    {"value": "fleet", "label": "Fleet total"},
                    {"value": "vehicles", "label": "Vehicles"},
                    {"value": "drivers", "label": "Drivers"},
                ],
            },
        ),
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
        group_by = (options or {}).get("group_by") or "fleet"
        trips = await trip_rows(session, current_user, start_date, end_date, device_ids)
        selected_drivers = set(driver_ids or [])
        groups = {}
        for trip in trips:
            if group_by == "drivers":
                if not trip.get("driver_id"):
                    continue
                if selected_drivers and trip["driver_id"] not in selected_drivers:
                    continue
            date = trip["start_time"][:10]
            key = date
            label = ""
            extra = ""
            if group_by == "vehicles":
                key = f"{date}:vehicle:{trip['device_id']}"
                label = trip.get("device_name") or f"Vehicle {trip['device_id']}"
                extra = trip.get("license_plate") or ""
            elif group_by == "drivers":
                key = f"{date}:driver:{trip['driver_id']}"
                label = trip.get("driver_name") or f"Driver {trip['driver_id']}"
            if key not in groups:
                groups[key] = {"date": date, "label": label, "extra": extra, "trips": 0, "distance_km": 0.0, "driving_minutes": 0.0}
            groups[key]["trips"] += 1
            groups[key]["distance_km"] += trip["distance_km"]
            groups[key]["driving_minutes"] += trip["duration_minutes"]

        rows = sorted(groups.values(), key=lambda r: (r["date"], r.get("label") or ""), reverse=True)
        for row in rows:
            row["distance_km"] = round_value(row["distance_km"], 2)
            row["driving_minutes"] = round_value(row["driving_minutes"], 1)

        columns = [{"key": "date", "label": "Date", "type": "text"}]
        if group_by != "fleet":
            columns.append({"key": "label", "label": "Vehicle" if group_by == "vehicles" else "Driver", "type": "text"})
        if group_by == "vehicles":
            columns.append({"key": "extra", "label": "Plate", "type": "text"})
        columns += [
            {"key": "trips", "label": "Trips", "type": "integer"},
            {"key": "distance_km", "label": "Distance (km)", "type": "number", "decimals": 1},
            {"key": "driving_minutes", "label": "Drive Time", "type": "duration_minutes"},
        ]

        total_trips = sum(r["trips"] for r in rows)
        total_distance = sum(r["distance_km"] for r in rows)
        total_minutes = sum(r["driving_minutes"] for r in rows)
        return table_payload(
            self.definition.key,
            rows,
            columns,
            [
                {"label": "Days", "value": len({r["date"] for r in rows})},
                *([] if group_by == "fleet" else [{"label": "Vehicle Days" if group_by == "vehicles" else "Driver Days", "value": len(rows)}]),
                {"label": "Total Trips", "value": total_trips},
                {"label": "Total Distance (km)", "value": round_value(total_distance, 1)},
                {"label": "Driving Time (h)", "value": round_value(total_minutes / 60, 1)},
            ],
            start_date,
            end_date,
            default_sort={"key": "date", "dir": -1},
            csv_filename=f"daily_activity_{group_by}_{start_date.date()}_{end_date.date()}.csv",
            total_row={"date": "Total", "trips": total_trips, "distance_km": round_value(total_distance, 1), "driving_minutes": round_value(total_minutes, 1)},
        )


report = DailyActivityReport()
