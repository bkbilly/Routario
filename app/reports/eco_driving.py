"""
Eco-Driving & Driver Safety Leaderboard Report.
"""
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import select

from models import Driver, PositionRecord, Trip
from reports.base import Report, ReportDefinition
from reports.common import (
    accessible_devices,
    filtered_device_map,
    normalize_utc,
    round_value,
    table_payload,
)
from core.eco_driving import calculate_trip_eco_score_async, get_eco_grade


class EcoDrivingReport(Report):
    definition = ReportDefinition(
        key="eco_driving",
        label="Eco-Driving & Driver Safety",
        description="Driver safety performance, eco scores (0-100), harsh accelerations, harsh braking, sharp cornering, and speeding metrics.",
        renderer="table",
        supports_vehicle_filter=True,
        supports_driver_filter=True,
        needs_date_range=True,
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
        start_date = normalize_utc(start_date)
        end_date = normalize_utc(end_date)

        device_map = await filtered_device_map(session, current_user, device_ids)
        if not device_map:
            return table_payload(self.definition.key, [], [], [], start_date, end_date)

        # Query completed trips within the date range
        query = select(Trip).where(
            Trip.device_id.in_(device_map.keys()),
            Trip.start_time >= start_date,
            Trip.start_time <= end_date,
            Trip.end_time.isnot(None),
        ).order_by(Trip.start_time.asc())

        result = await session.execute(query)
        trips = result.scalars().all()

        if driver_ids:
            driver_set = set(driver_ids)
            trips = [t for t in trips if t.driver_id in driver_set]

        # Fetch driver details
        dr_ids = {t.driver_id for t in trips if t.driver_id}
        driver_map = {}
        if dr_ids:
            dr_res = await session.execute(select(Driver).where(Driver.id.in_(dr_ids)))
            driver_map = {d.id: d for d in dr_res.scalars().all()}

        # Group stats by Driver (or Device if no driver assigned)
        grouped = {}
        total_harsh_accels = 0
        total_harsh_brakes = 0
        total_harsh_corners = 0
        total_fatigue_events = 0
        total_dist_fleet = 0.0

        for t in trips:
            dev = device_map.get(t.device_id)
            driver = driver_map.get(t.driver_id) if t.driver_id else None

            group_key = f"driver_{t.driver_id}" if t.driver_id else f"dev_{t.device_id}"
            driver_label = driver.name if driver else (f"Vehicle {dev.name}" if dev else f"Device {t.device_id}")

            if group_key not in grouped:
                grouped[group_key] = {
                    "driver_id": t.driver_id,
                    "driver_name": driver_label,
                    "device_name": dev.name if dev else str(t.device_id),
                    "license_plate": dev.license_plate if dev else None,
                    "trip_count": 0,
                    "distance_km": 0.0,
                    "duration_minutes": 0.0,
                    "harsh_accel_count": 0,
                    "harsh_brake_count": 0,
                    "harsh_corner_count": 0,
                    "speeding_duration_minutes": 0.0,
                    "speeding_minor_minutes": 0.0,
                    "speeding_moderate_minutes": 0.0,
                    "speeding_severe_minutes": 0.0,
                    "idling_duration_minutes": 0.0,
                    "fatigue_events_count": 0,
                    "fatigue_risk": "none",
                    "weighted_eco_sum": 0.0,
                    "weighted_dist_sum": 0.0,
                    "trips": [],
                    "events": [],
                }

            g = grouped[group_key]
            g["trip_count"] += 1
            g["distance_km"] += (t.distance_km or 0.0)
            g["duration_minutes"] += (t.duration_minutes or 0.0)

            trip_score = t.eco_score
            accel_cnt = t.harsh_accel_count or 0
            brake_cnt = t.harsh_brake_count or 0
            corner_cnt = t.harsh_corner_count or 0
            speeding_mins = t.speeding_duration_minutes or 0.0
            idling_mins = t.idling_duration_minutes or 0.0
            speeding_minor = 0.0
            speeding_moderate = 0.0
            speeding_severe = 0.0
            fatigue_risk = "none"
            fatigue_cnt = 0
            continuous_drive = t.duration_minutes or 0.0
            trip_events = []

            # Calculate or extract trip event positions
            try:
                pos_q = select(PositionRecord).where(
                    PositionRecord.device_id == t.device_id,
                    PositionRecord.device_time >= t.start_time,
                    PositionRecord.device_time <= t.end_time,
                ).order_by(PositionRecord.device_time.asc())
                pos_res = await session.execute(pos_q)
                pos_list = pos_res.scalars().all()
                eco_calc = await calculate_trip_eco_score_async(
                    pos_list,
                    distance_km=t.distance_km,
                    duration_minutes=t.duration_minutes,
                )
                if trip_score is None:
                    trip_score = eco_calc["eco_score"]
                    accel_cnt = eco_calc["harsh_accel_count"]
                    brake_cnt = eco_calc["harsh_brake_count"]
                    corner_cnt = eco_calc["harsh_corner_count"]
                    speeding_mins = eco_calc["speeding_duration_minutes"]
                    idling_mins = eco_calc["idling_duration_minutes"]
                speeding_minor = eco_calc.get("speeding_minor_minutes", 0.0)
                speeding_moderate = eco_calc.get("speeding_moderate_minutes", 0.0)
                speeding_severe = eco_calc.get("speeding_severe_minutes", 0.0)
                fatigue_risk = eco_calc.get("fatigue_risk", "none")
                fatigue_cnt = eco_calc.get("fatigue_events_count", 0)
                continuous_drive = eco_calc.get("continuous_driving_minutes", t.duration_minutes or 0.0)
                trip_events = eco_calc.get("events", [])
            except Exception:
                if trip_score is None:
                    trip_score = 100.0

            # Tag each event with driver/vehicle and trip id
            for ev in trip_events:
                ev["trip_id"] = t.id
                ev["driver_name"] = driver_label
                ev["device_name"] = dev.name if dev else str(t.device_id)
                ev["license_plate"] = dev.license_plate if dev else None

            g["events"].extend(trip_events)
            g["harsh_accel_count"] += accel_cnt
            g["harsh_brake_count"] += brake_cnt
            g["harsh_corner_count"] += corner_cnt
            g["speeding_duration_minutes"] += speeding_mins
            g["speeding_minor_minutes"] += speeding_minor
            g["speeding_moderate_minutes"] += speeding_moderate
            g["speeding_severe_minutes"] += speeding_severe
            g["idling_duration_minutes"] += idling_mins
            g["fatigue_events_count"] += fatigue_cnt
            if fatigue_risk == "high" or g["fatigue_risk"] == "high":
                g["fatigue_risk"] = "high"
            elif fatigue_risk == "warning" and g["fatigue_risk"] != "high":
                g["fatigue_risk"] = "warning"

            g["trips"].append({
                "id": t.id,
                "device_id": t.device_id,
                "device_name": dev.name if dev else str(t.device_id),
                "license_plate": dev.license_plate if dev else None,
                "start_time": t.start_time.isoformat().replace("T", " "),
                "end_time": t.end_time.isoformat().replace("T", " ") if t.end_time else None,
                "distance_km": round(t.distance_km or 0.0, 2),
                "duration_minutes": round(t.duration_minutes or 0.0, 1),
                "avg_speed": round(t.avg_speed or 0.0, 1),
                "max_speed": round(t.max_speed or 0.0, 1),
                "start_address": t.start_address,
                "end_address": t.end_address,
                "eco_score": round(trip_score, 0) if trip_score is not None else None,
                "harsh_accel_count": accel_cnt,
                "harsh_brake_count": brake_cnt,
                "harsh_corner_count": corner_cnt,
                "speeding_minor_minutes": round(speeding_minor, 1),
                "speeding_moderate_minutes": round(speeding_moderate, 1),
                "speeding_severe_minutes": round(speeding_severe, 1),
                "continuous_driving_minutes": round(continuous_drive, 1),
                "fatigue_risk": fatigue_risk,
                "events": trip_events,
            })

            weight = max(t.distance_km or 1.0, 1.0)
            g["weighted_eco_sum"] += (trip_score * weight)
            g["weighted_dist_sum"] += weight

            total_harsh_accels += accel_cnt
            total_harsh_brakes += brake_cnt
            total_harsh_corners += corner_cnt
            total_fatigue_events += fatigue_cnt
            total_dist_fleet += (t.distance_km or 0.0)

        rows = []
        best_driver = None
        best_score = -1.0
        total_fleet_weighted_score = 0.0
        total_fleet_weight = 0.0

        for g in grouped.values():
            avg_score = round(g["weighted_eco_sum"] / max(g["weighted_dist_sum"], 1.0), 1)
            grade = get_eco_grade(avg_score)
            g["eco_score"] = avg_score
            g["grade"] = grade
            g["distance_km"] = round(g["distance_km"], 1)
            g["duration_minutes"] = round(g["duration_minutes"], 1)
            g["speeding_duration_minutes"] = round(g["speeding_duration_minutes"], 1)
            g["speeding_minor_minutes"] = round(g["speeding_minor_minutes"], 1)
            g["speeding_moderate_minutes"] = round(g["speeding_moderate_minutes"], 1)
            g["speeding_severe_minutes"] = round(g["speeding_severe_minutes"], 1)
            g["idling_duration_minutes"] = round(g["idling_duration_minutes"], 1)

            total_fleet_weighted_score += g["weighted_eco_sum"]
            total_fleet_weight += g["weighted_dist_sum"]

            if avg_score > best_score and g["distance_km"] >= 1.0:
                best_score = avg_score
                best_driver = f"{g['driver_name']} ({avg_score:.0f}%)"

            rows.append(g)

        # Sort rows by eco_score descending (top performers first)
        rows.sort(key=lambda x: (x["eco_score"], x["distance_km"]), reverse=True)

        fleet_avg_score = round(total_fleet_weighted_score / max(total_fleet_weight, 1.0), 1) if total_fleet_weight > 0 else 100.0
        fleet_grade = get_eco_grade(fleet_avg_score)
        tone = "success" if fleet_avg_score >= 85 else ("warning" if fleet_avg_score >= 70 else "danger")

        summary_cards = [
            {"label": "Fleet Safety Score", "value": f"{fleet_avg_score:.0f}% · Grade {fleet_grade}", "tone": tone},
            {"label": "Harsh Accelerations", "value": str(total_harsh_accels)},
            {"label": "Harsh Braking Events", "value": str(total_harsh_brakes)},
            {"label": "Sharp Turns", "value": str(total_harsh_corners)},
            {"label": "Fatigue Alerts" if total_fatigue_events > 0 else "Safest Driver", "value": str(total_fatigue_events) if total_fatigue_events > 0 else (best_driver or "—"), "tone": "danger" if total_fatigue_events > 0 else "success"},
        ]

        columns = [
            {"key": "driver_name", "label": "Driver / Vehicle", "type": "text", "detail_key": "license_plate"},
            {"key": "eco_score", "label": "Safety Score", "type": "eco_score"},
            {"key": "trip_count", "label": "Trips", "type": "integer"},
            {"key": "distance_km", "label": "Distance (km)", "type": "number", "decimals": 1},
            {"key": "duration_minutes", "label": "Driving Time", "type": "duration_minutes"},
            {"key": "harsh_accel_count", "label": "Harsh Accel", "type": "integer"},
            {"key": "harsh_brake_count", "label": "Harsh Brake", "type": "integer"},
            {"key": "harsh_corner_count", "label": "Sharp Turn", "type": "integer"},
            {"key": "speeding_duration_minutes", "label": "Speeding (min)", "type": "number", "decimals": 1},
            {"key": "idling_duration_minutes", "label": "Idling (min)", "type": "number", "decimals": 1},
        ]

        return {
            **table_payload(
                self.definition.key,
                rows,
                columns,
                summary_cards,
                start_date,
                end_date,
                default_sort={"key": "eco_score", "dir": -1},
                csv_filename=(
                    f"eco_driving_{start_date.date()}_{end_date.date()}.csv"
                    if start_date and end_date
                    else "eco_driving.csv"
                ),
                row_action={"type": "eco_detail", "label": "View safety scorecard & trip breakdown"},
            )
        }


report = EcoDrivingReport()
