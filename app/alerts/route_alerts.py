from __future__ import annotations

from datetime import datetime, timedelta
from math import cos, radians, sqrt
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from .base import BaseAlert, AlertDefinition, AlertField
from core.database import get_db
from core.spatial import calculate_distance_km
from models import PlannedRoute
from models.schemas import AlertType, Severity

ACTIVE_ROUTE_STATUSES = {"active", "started", "in_progress"}
RECENT_COMPLETED_WINDOW = timedelta(minutes=5)


def _utcnow_naive() -> datetime:
    return datetime.utcnow()


async def _routes_for_device(device_id: int, *, include_recent_completed: bool = False) -> list[PlannedRoute]:
    statuses = set(ACTIVE_ROUTE_STATUSES)
    if include_recent_completed:
        statuses.add("completed")

    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(PlannedRoute)
            .where(
                PlannedRoute.device_id == device_id,
                PlannedRoute.status.in_(statuses),
            )
            .options(selectinload(PlannedRoute.stops))
            .order_by(PlannedRoute.updated_at.desc(), PlannedRoute.created_at.desc())
        )
        routes = list(result.scalars().all())

    if not include_recent_completed:
        return routes

    cutoff = _utcnow_naive() - RECENT_COMPLETED_WINDOW
    return [
        route for route in routes
        if (route.status or "").lower() in ACTIVE_ROUTE_STATUSES
        or (route.updated_at and route.updated_at >= cutoff)
    ]


def _decode_valhalla_shape(encoded: str) -> list[tuple[float, float]]:
    if not encoded:
        return []

    coordinates: list[tuple[float, float]] = []
    index = 0
    lat = 0
    lng = 0
    precision = 1e6

    while index < len(encoded):
        shift = 0
        result = 0
        while index < len(encoded):
            b = ord(encoded[index]) - 63
            index += 1
            result |= (b & 0x1F) << shift
            shift += 5
            if b < 0x20:
                break
        lat += ~(result >> 1) if result & 1 else result >> 1

        shift = 0
        result = 0
        while index < len(encoded):
            b = ord(encoded[index]) - 63
            index += 1
            result |= (b & 0x1F) << shift
            shift += 5
            if b < 0x20:
                break
        lng += ~(result >> 1) if result & 1 else result >> 1

        coordinates.append((lat / precision, lng / precision))

    return coordinates


def _route_lat_lngs(route: PlannedRoute) -> list[tuple[float, float]]:
    geometry = route.route_geometry or {}
    if geometry.get("provider") == "valhalla":
        shapes = geometry.get("encoded_shapes") or ([geometry.get("encoded_shape")] if geometry.get("encoded_shape") else [])
        decoded: list[tuple[float, float]] = []
        for shape in shapes:
            decoded.extend(_decode_valhalla_shape(shape))
        if len(decoded) > 1:
            return decoded

    coordinates = geometry.get("coordinates")
    if isinstance(coordinates, list):
        points = []
        for item in coordinates:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                lng, lat = item[0], item[1]
                points.append((float(lat), float(lng)))
        if len(points) > 1:
            return points

    return [
        (float(stop.latitude), float(stop.longitude))
        for stop in sorted(route.stops or [], key=lambda s: int(s.sequence or 0))
    ]


def _point_segment_distance_m(
    lat: float,
    lng: float,
    start: tuple[float, float],
    end: tuple[float, float],
) -> float:
    lat1, lng1 = start
    lat2, lng2 = end
    origin_lat = radians(lat)
    meters_per_degree_lat = 111_320.0
    meters_per_degree_lng = max(111_320.0 * cos(origin_lat), 1.0)

    x = 0.0
    y = 0.0
    x1 = (lng1 - lng) * meters_per_degree_lng
    y1 = (lat1 - lat) * meters_per_degree_lat
    x2 = (lng2 - lng) * meters_per_degree_lng
    y2 = (lat2 - lat) * meters_per_degree_lat

    dx = x2 - x1
    dy = y2 - y1
    length_sq = dx * dx + dy * dy
    if length_sq <= 0:
        return calculate_distance_km(lat, lng, lat1, lng1) * 1000

    t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / length_sq))
    proj_x = x1 + t * dx
    proj_y = y1 + t * dy
    return sqrt((x - proj_x) ** 2 + (y - proj_y) ** 2)


def _distance_to_route_m(lat: float, lng: float, route: PlannedRoute) -> Optional[float]:
    points = _route_lat_lngs(route)
    if len(points) < 2:
        return None
    return min(
        _point_segment_distance_m(lat, lng, start, end)
        for start, end in zip(points, points[1:])
    )


def _scope_matches(stop, scope: str) -> bool:
    kind = (stop.stop_kind or "stop").lower()
    if scope == "stops":
        return kind == "stop"
    if scope == "waypoints":
        return kind == "waypoint"
    return True


class RouteWaypointSkippedAlert(BaseAlert):
    @classmethod
    def definition(cls) -> AlertDefinition:
        return AlertDefinition(
            key="route_waypoint_skipped",
            alert_type=AlertType.ROUTE_WAYPOINT_SKIPPED,
            label="Route Point Skipped",
            description="Fires when the vehicle completes a later route point while an earlier configured route point remains incomplete.",
            icon="↷",
            severity=Severity.WARNING,
            state_keys=["route_skipped_alerted_*"],
            fields=[
                AlertField(
                    key="point_scope",
                    label="Check",
                    field_type="select",
                    default="all",
                    options=[
                        {"value": "all", "label": "Stops and waypoints"},
                        {"value": "stops", "label": "Stops only"},
                        {"value": "waypoints", "label": "Waypoints only"},
                    ],
                    help_text="Choose which route point types can trigger skipped alerts.",
                ),
            ],
        )

    async def check(self, position, device, state, params: dict) -> Optional[dict]:
        return None

    async def check_many(self, position, device, state, params: dict) -> list:
        scope = params.get("point_scope", "all")
        alerts = []
        routes = await _routes_for_device(device.id, include_recent_completed=True)

        for route in routes:
            stops = sorted(route.stops or [], key=lambda s: int(s.sequence or 0))
            completed_sequences = [
                int(stop.sequence or 0)
                for stop in stops
                if (stop.status or "").lower() == "completed"
            ]
            prefix = f"route_skipped_alerted_{route.id}_"

            if not completed_sequences:
                for key in list(state.alert_states.keys()):
                    if key.startswith(prefix):
                        state.alert_states.pop(key, None)
                continue

            latest_completed = max(completed_sequences)
            skipped = [
                stop for stop in stops
                if int(stop.sequence or 0) < latest_completed
                and (stop.status or "").lower() != "completed"
                and _scope_matches(stop, scope)
            ]

            for stop in skipped:
                state_key = f"{prefix}{stop.id}"
                if state.alert_states.get(state_key):
                    continue
                state.alert_states[state_key] = True
                label = stop.name or f"Point {int(stop.sequence or 0) + 1}"
                kind = (stop.stop_kind or "stop").lower()
                alerts.append({
                    "type": AlertType.ROUTE_WAYPOINT_SKIPPED,
                    "severity": Severity.WARNING,
                    "message": f"Route point skipped: {label} on {route.name}.",
                    "alert_metadata": {
                        "config_key": "route_waypoint_skipped",
                        "route_id": route.id,
                        "route_name": route.name,
                        "stop_id": stop.id,
                        "stop_name": label,
                        "stop_kind": kind,
                        "sequence": stop.sequence,
                        "point_scope": scope,
                    },
                })

        return alerts


class RouteOffRouteAlert(BaseAlert):
    @classmethod
    def definition(cls) -> AlertDefinition:
        return AlertDefinition(
            key="route_off_route",
            alert_type=AlertType.ROUTE_OFF_ROUTE,
            label="Route Deviation Alert",
            description="Fires when a vehicle assigned to an active route remains farther than the configured distance from the route path.",
            icon="🧭",
            severity=Severity.WARNING,
            state_keys=["route_off_route_since_*", "route_off_route_alerted_*"],
            fields=[
                AlertField(
                    key="distance_meters",
                    label="Allowed Deviation",
                    unit="meters",
                    default=150,
                    min_value=10,
                    max_value=5000,
                    help_text="Alert fires when the vehicle is farther than this distance from the route path.",
                ),
                AlertField(
                    key="duration_seconds",
                    label="Confirmation Duration",
                    unit="seconds",
                    default=60,
                    min_value=0,
                    max_value=3600,
                    help_text="Vehicle must remain off-route for this long before the alert fires.",
                ),
            ],
        )

    async def check(self, position, device, state, params: dict) -> Optional[dict]:
        routes = await _routes_for_device(device.id)
        if not routes:
            return None

        threshold = float(params.get("distance_meters", 150) or 150)
        duration = float(params.get("duration_seconds", 60) or 0)
        now_iso = position.device_time.isoformat()

        for route in routes:
            distance_m = _distance_to_route_m(position.latitude, position.longitude, route)
            if distance_m is None:
                continue

            since_key = f"route_off_route_since_{route.id}"
            alerted_key = f"route_off_route_alerted_{route.id}"

            if distance_m <= threshold:
                state.alert_states.pop(since_key, None)
                state.alert_states[alerted_key] = False
                continue

            since = state.alert_states.get(since_key)
            if not since:
                state.alert_states[since_key] = now_iso
                state.alert_states[alerted_key] = False
                continue

            elapsed = (
                position.device_time.replace(tzinfo=None)
                - datetime.fromisoformat(since).replace(tzinfo=None)
            ).total_seconds()
            if elapsed < duration or state.alert_states.get(alerted_key):
                continue

            state.alert_states[alerted_key] = True
            return {
                "type": AlertType.ROUTE_OFF_ROUTE,
                "severity": Severity.WARNING,
                "message": f"Route deviation: vehicle is {int(distance_m)}m from {route.name}.",
                "alert_metadata": {
                    "config_key": "route_off_route",
                    "route_id": route.id,
                    "route_name": route.name,
                    "distance_meters": round(distance_m, 1),
                    "threshold_meters": threshold,
                    "duration_seconds": duration,
                },
            }

        return None
