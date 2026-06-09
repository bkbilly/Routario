from datetime import datetime
from typing import Any, Optional

from reports.base import Report, ReportDefinition
from reports.common import filtered_device_map, round_value, table_payload


class FleetSummaryReport(Report):
    definition = ReportDefinition(
        key="summary",
        label="Fleet Summary",
        description="Totals per vehicle for the selected period — trips, distance, driving time, and top speed.",
        renderer="summary",
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
        from sqlalchemy import func, select
        from sqlalchemy.orm import selectinload

        from models import Trip
        from models.models import DeviceState

        device_map = await filtered_device_map(session, current_user, device_ids)
        devices = list(device_map.values())

        state_result = await session.execute(
            select(DeviceState)
            .where(DeviceState.device_id.in_(device_map.keys()))
            .options(selectinload(DeviceState.current_driver))
        ) if device_map else None
        state_map = {s.device_id: s for s in state_result.scalars().all()} if state_result else {}

        rows = []
        for device in sorted(devices, key=lambda d: d.name):
            result = await session.execute(
                select(
                    func.count(Trip.id).label("trips"),
                    func.coalesce(func.sum(Trip.distance_km), 0).label("distance_km"),
                    func.coalesce(func.sum(Trip.duration_minutes), 0).label("driving_minutes"),
                    func.coalesce(func.max(Trip.max_speed), 0).label("max_speed"),
                    func.coalesce(func.avg(Trip.avg_speed), 0).label("avg_speed"),
                ).where(
                    Trip.device_id == device.id,
                    Trip.start_time >= start_date,
                    Trip.start_time <= end_date,
                    Trip.end_time.isnot(None),
                )
            )
            row = result.one()
            state = state_map.get(device.id)
            rows.append({
                "device_id": device.id,
                "device_name": device.name,
                "license_plate": device.license_plate,
                "driver_name": state.current_driver.name if state and state.current_driver else None,
                "trips": int(row.trips or 0),
                "distance_km": round_value(row.distance_km, 2),
                "driving_minutes": round_value(row.driving_minutes, 1),
                "max_speed": round_value(row.max_speed, 1),
                "avg_speed": round_value(row.avg_speed, 1),
            })

        total_trips = sum(r["trips"] for r in rows)
        total_distance = sum(r["distance_km"] for r in rows)
        total_minutes = sum(r["driving_minutes"] for r in rows)
        top_speed = max([r["max_speed"] for r in rows], default=0)
        return table_payload(
            self.definition.key,
            rows,
            [
                {"key": "device_name", "label": "Vehicle", "type": "text"},
                {"key": "license_plate", "label": "Plate", "type": "text"},
                {"key": "driver_name", "label": "Driver", "type": "text"},
                {"key": "trips", "label": "Trips", "type": "integer"},
                {"key": "distance_km", "label": "Distance (km)", "type": "number", "decimals": 1},
                {"key": "driving_minutes", "label": "Drive Time", "type": "duration_minutes"},
                {"key": "avg_speed", "label": "Avg Speed", "type": "number", "decimals": 1, "suffix": " km/h"},
                {"key": "max_speed", "label": "Top Speed", "type": "number", "decimals": 1, "suffix": " km/h"},
            ],
            [
                {"label": "Vehicles", "value": len(rows)},
                {"label": "Total Trips", "value": total_trips},
                {"label": "Total Distance (km)", "value": round_value(total_distance, 1)},
                {"label": "Driving Time (h)", "value": round_value(total_minutes / 60, 1)},
                {"label": "Top Speed (km/h)", "value": round_value(top_speed, 0)},
            ],
            start_date,
            end_date,
            default_sort={"key": "device_name", "dir": 1},
            csv_filename=f"fleet_summary_{start_date.date()}_{end_date.date()}.csv",
            total_row={
                "device_name": "Total",
                "trips": total_trips,
                "distance_km": round_value(total_distance, 1),
                "driving_minutes": round_value(total_minutes, 1),
                "avg_speed": None,
                "max_speed": round_value(top_speed, 0),
            },
        )


report = FleetSummaryReport()
