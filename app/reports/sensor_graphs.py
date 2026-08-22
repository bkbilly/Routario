"""
Sensor Graphs Report.

Allows selecting up to 5 vehicles and a date range, returning time-series
telemetry data for graphing and tabular analysis.
"""
from datetime import datetime
from typing import Any, Optional

from reports.base import Report, ReportDefinition
from reports.common import filtered_device_map, round_value, table_payload

# Metadata for known sensors
SENSOR_META = {
    "speed": {"label": "Speed", "unit": "km/h", "decimals": 1, "type": "number"},
    "altitude": {"label": "Altitude", "unit": "m", "decimals": 0, "type": "number"},
    "satellites": {"label": "Satellites", "unit": "", "decimals": 0, "type": "number"},
    "ignition": {"label": "Ignition", "unit": "", "decimals": 0, "type": "bool_on"},
    "battery": {"label": "Battery", "unit": "%", "decimals": 0, "type": "number"},
    "battery_level": {"label": "Battery", "unit": "%", "decimals": 0, "type": "number"},
    "battery_voltage": {"label": "Battery Voltage", "unit": "V", "decimals": 2, "type": "number"},
    "external_voltage": {"label": "External Voltage", "unit": "V", "decimals": 2, "type": "number"},
    "temperature": {"label": "Temperature", "unit": "°C", "decimals": 1, "type": "number"},
    "temp": {"label": "Temperature", "unit": "°C", "decimals": 1, "type": "number"},
    "fuel": {"label": "Fuel", "unit": "%", "decimals": 0, "type": "number"},
    "fuel_level": {"label": "Fuel Level", "unit": "%", "decimals": 0, "type": "number"},
    "rpm": {"label": "Engine RPM", "unit": "RPM", "decimals": 0, "type": "number"},
    "odometer": {"label": "Odometer", "unit": "km", "decimals": 1, "type": "number"},
    "total_odometer": {"label": "Total Odometer", "unit": "km", "decimals": 1, "type": "number"},
}


def get_sensor_meta(k: str) -> dict[str, Any]:
    if k in SENSOR_META:
        return SENSOR_META[k]
    label = k.replace("_", " ").title()
    return {"label": label, "unit": "", "decimals": 1, "type": "auto"}


class SensorGraphsReport(Report):
    definition = ReportDefinition(
        key="sensor_graphs",
        label="Sensor Graphs",
        description="Interactive sensor graphs and data tables for up to 5 vehicles across a date range.",
        renderer="sensor_graphs",
        needs_date_range=True,
        supports_vehicle_filter=True,
        schedule_supported=True,
        schedule_uses_device_filter=True,
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
    ) -> dict[str, Any]:
        from sqlalchemy import select
        from models.models import DeviceState, PositionRecord

        device_map = await filtered_device_map(session, current_user, device_ids)
        if not device_map:
            return table_payload(
                self.definition.key,
                [],
                [],
                [],
                start_date,
                end_date,
                csv_filename="sensor_graphs.csv",
            )

        # Enforce max 5 vehicles limit
        selected_devices = sorted(device_map.values(), key=lambda d: d.name)[:5]
        selected_ids = [d.id for d in selected_devices]

        # Parse requested sensor keys if provided in options
        requested_sensors_raw = (options or {}).get("sensors", "")
        requested_sensors = [s.strip() for s in requested_sensors_raw.split(",") if s.strip()] if requested_sensors_raw else None

        # Fetch position records
        query = (
            select(PositionRecord)
            .where(
                PositionRecord.device_id.in_(selected_ids),
                PositionRecord.device_time >= start_date,
                PositionRecord.device_time <= end_date,
            )
            .order_by(PositionRecord.device_time.asc())
        )
        result = await session.execute(query)
        positions = result.scalars().all()

        # Discover all available sensors across fetched records
        discovered_sensor_keys: set[str] = set()
        for p in positions:
            if p.speed is not None:
                discovered_sensor_keys.add("speed")
            if p.altitude is not None:
                discovered_sensor_keys.add("altitude")
            if p.satellites is not None:
                discovered_sensor_keys.add("satellites")
            if p.ignition is not None:
                discovered_sensor_keys.add("ignition")
            for k in (p.sensors or {}):
                discovered_sensor_keys.add(k)

        # If no position records found yet, query DeviceState for available sensors
        if not discovered_sensor_keys:
            states_r = await session.execute(
                select(DeviceState).where(DeviceState.device_id.in_(selected_ids))
            )
            for s in states_r.scalars().all():
                if s.last_speed is not None:
                    discovered_sensor_keys.add("speed")
                if s.last_altitude is not None:
                    discovered_sensor_keys.add("altitude")
                if s.ignition_on is not None:
                    discovered_sensor_keys.add("ignition")
                for k in (s.sensors or {}):
                    discovered_sensor_keys.add(k)

        if not discovered_sensor_keys:
            discovered_sensor_keys = {"speed", "battery", "ignition", "altitude"}

        # Priority ordering for standard sensors
        priority = ["speed", "battery", "battery_level", "ignition", "altitude", "fuel", "fuel_level", "temperature", "rpm", "odometer"]
        available_sensors = sorted(
            [{"key": k, **get_sensor_meta(k)} for k in discovered_sensor_keys],
            key=lambda x: (priority.index(x["key"]) if x["key"] in priority else 99, x["label"].casefold())
        )

        active_sensor_keys = requested_sensors if requested_sensors else [s["key"] for s in available_sensors[:3]]
        # Ensure only valid keys are kept
        active_sensor_keys = [k for k in active_sensor_keys if k in discovered_sensor_keys or k in SENSOR_META]
        if not active_sensor_keys and available_sensors:
            active_sensor_keys = [available_sensors[0]["key"]]

        # Build rows and series
        rows = []
        series_by_vehicle = {
            d.id: {"id": d.id, "name": d.name, "license_plate": d.license_plate, "points": []}
            for d in selected_devices
        }

        sensor_stats: dict[str, dict[str, Any]] = {
            k: {"min": None, "max": None, "sum": 0.0, "count": 0} for k in active_sensor_keys
        }

        for p in positions:
            d = device_map.get(p.device_id)
            if not d:
                continue
            time_str = p.device_time.isoformat() + "Z" if p.device_time.tzinfo is None else p.device_time.isoformat()
            point_data: dict[str, Any] = {
                "time": time_str,
            }
            row: dict[str, Any] = {
                "device_id": d.id,
                "vehicle": d.name,
                "license_plate": d.license_plate,
                "time": time_str,
            }

            for s_key in active_sensor_keys:
                val = None
                if s_key == "speed":
                    val = p.speed
                elif s_key == "altitude":
                    val = p.altitude
                elif s_key == "satellites":
                    val = p.satellites
                elif s_key == "ignition":
                    val = 1 if p.ignition else (0 if p.ignition is False else None)
                elif p.sensors and s_key in p.sensors:
                    val = p.sensors[s_key]

                row[s_key] = val
                point_data[s_key] = val

                # Track stats for numeric
                if isinstance(val, (int, float)) and val is not None and not isinstance(val, bool):
                    stats = sensor_stats[s_key]
                    stats["min"] = val if stats["min"] is None else min(stats["min"], val)
                    stats["max"] = val if stats["max"] is None else max(stats["max"], val)
                    stats["sum"] += float(val)
                    stats["count"] += 1

            rows.append(row)
            if p.device_id in series_by_vehicle:
                series_by_vehicle[p.device_id]["points"].append(point_data)

        # Build summary statistics
        summary = []
        for s_key in active_sensor_keys:
            stats = sensor_stats.get(s_key)
            meta = get_sensor_meta(s_key)
            if stats and stats["count"] > 0:
                avg = stats["sum"] / stats["count"]
                unit = f" {meta['unit']}" if meta['unit'] else ""
                summary.append({
                    "label": f"Avg {meta['label']}",
                    "value": f"{round_value(avg, meta.get('decimals', 1))}{unit}",
                })
                summary.append({
                    "label": f"Max {meta['label']}",
                    "value": f"{round_value(stats['max'], meta.get('decimals', 1))}{unit}",
                })

        # Columns for table view
        columns = [
            {"key": "vehicle", "label": "Vehicle", "type": "text"},
            {"key": "time", "label": "Time", "type": "datetime"},
        ]
        for s_key in active_sensor_keys:
            meta = get_sensor_meta(s_key)
            suffix = f" {meta['unit']}" if meta['unit'] else ""
            columns.append({
                "key": s_key,
                "label": meta["label"] + (f" ({meta['unit']})" if meta['unit'] else ""),
                "type": meta.get("type", "auto"),
                "decimals": meta.get("decimals", 1),
                "suffix": suffix,
            })

        payload = table_payload(
            self.definition.key,
            rows,
            columns,
            summary,
            start_date,
            end_date,
            default_sort={"key": "time", "dir": -1},
            csv_filename=f"sensor_graphs_{start_date.date()}_{end_date.date()}.csv",
        )
        payload["available_sensors"] = available_sensors
        payload["active_sensors"] = active_sensor_keys
        payload["vehicles"] = [{"id": d.id, "name": d.name, "license_plate": d.license_plate} for d in selected_devices]
        payload["series"] = list(series_by_vehicle.values())
        return payload


report = SensorGraphsReport()
