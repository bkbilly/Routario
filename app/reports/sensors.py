from datetime import datetime
from typing import Any, Optional

from reports.base import Report, ReportDefinition
from reports.common import filtered_device_map, table_payload


class VehicleSensorsReport(Report):
    definition = ReportDefinition(
        key="sensors",
        label="Vehicle Sensors",
        description="Current sensor readings for all vehicles. Enable historical data to view sensor values over a date range.",
        renderer="sensors",
        needs_date_range=False,
        supports_historical_toggle=True,
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
        from sqlalchemy import select
        from sqlalchemy.orm import selectinload

        from models.models import DeviceState, Driver, PositionRecord

        device_map = await filtered_device_map(session, current_user, device_ids)
        devices = sorted(device_map.values(), key=lambda x: x.name)

        if not historical:
            states_r = await session.execute(
                select(DeviceState)
                .where(DeviceState.device_id.in_(device_map.keys()))
                .options(selectinload(DeviceState.current_driver))
            ) if device_map else None
            state_map = {s.device_id: s for s in states_r.scalars().all()} if states_r else {}
            rows = []
            for d in devices:
                s = state_map.get(d.id)
                row = {
                    "id": d.id,
                    "name": d.name,
                    "license_plate": d.license_plate,
                    "current_driver_name": s.current_driver.name if (s and s.current_driver) else None,
                    "last_update": s.last_update.isoformat() if (s and s.last_update) else None,
                    "ignition_on": s.ignition_on if s else None,
                    "last_speed": s.last_speed if s else None,
                    "last_altitude": s.last_altitude if s else None,
                }
                for key, value in (s.sensors if s else {}).items():
                    row[f"sensor__{key}"] = value
                rows.append(row)
            sensor_keys = sorted({k for row in rows for k in row if k.startswith("sensor__")})
            columns = [
                {"key": "name", "label": "Vehicle", "type": "text"},
                {"key": "license_plate", "label": "Plate", "type": "text"},
                {"key": "current_driver_name", "label": "Driver", "type": "text"},
                {"key": "last_update", "label": "Last Seen", "type": "datetime"},
                {"key": "ignition_on", "label": "Ignition", "type": "bool_on"},
                {"key": "last_speed", "label": "Speed", "type": "number", "decimals": 1, "suffix": " km/h"},
                {"key": "last_altitude", "label": "Altitude", "type": "number", "decimals": 0, "suffix": " m"},
            ] + [{"key": key, "label": key.removeprefix("sensor__"), "type": "auto"} for key in sensor_keys]
            return table_payload(
                self.definition.key,
                rows,
                columns,
                [],
                default_sort={"key": "name", "dir": 1},
                csv_filename="vehicle_sensors.csv",
                historical=False,
            )

        rows = []
        driver_ids = set()
        for d in devices:
            pos_r = await session.execute(
                select(PositionRecord)
                .where(
                    PositionRecord.device_id == d.id,
                    PositionRecord.device_time >= start_date,
                    PositionRecord.device_time <= end_date,
                )
                .order_by(PositionRecord.device_time.desc())
                .limit(5000)
            )
            for p in pos_r.scalars().all():
                row = {
                    "device_id": d.id,
                    "vehicle": d.name,
                    "time": p.device_time.isoformat(),
                    "speed": p.speed,
                    "altitude": p.altitude,
                    "ignition": p.ignition,
                    "driver_id": p.driver_id,
                    "driver_name": None,
                    **{f"sensor__{key}": value for key, value in (p.sensors or {}).items()},
                }
                if p.driver_id:
                    driver_ids.add(p.driver_id)
                rows.append(row)

        driver_map = {}
        if driver_ids:
            driver_r = await session.execute(select(Driver).where(Driver.id.in_(driver_ids)))
            driver_map = {driver.id: driver.name for driver in driver_r.scalars().all()}
            for row in rows:
                row["driver_name"] = driver_map.get(row.get("driver_id"))

        sensor_keys = sorted({k for row in rows for k in row if k.startswith("sensor__")})
        return table_payload(
            self.definition.key,
            rows,
            [
                {"key": "vehicle", "label": "Vehicle", "type": "text"},
                {"key": "time", "label": "Time", "type": "datetime"},
                {"key": "driver_name", "label": "Driver", "type": "text"},
                {"key": "ignition", "label": "Ignition", "type": "bool_on"},
                {"key": "speed", "label": "Speed", "type": "number", "decimals": 1, "suffix": " km/h"},
                {"key": "altitude", "label": "Altitude", "type": "number", "decimals": 0, "suffix": " m"},
                *[{"key": key, "label": key.removeprefix("sensor__"), "type": "auto"} for key in sensor_keys],
            ],
            [],
            start_date,
            end_date,
            default_sort={"key": "time", "dir": -1},
            csv_filename=f"vehicle_sensors_history_{start_date.date()}_{end_date.date()}.csv",
            historical=True,
        )


report = VehicleSensorsReport()
