"""
Position Routes
GPS position history endpoint.
"""
from datetime import datetime
from fastapi import APIRouter, Depends
from sqlalchemy import select

from core.database import get_db
from core.auth import get_current_user, verify_device_access, require_permission
from core.spatial import calculate_distance_km
from models import User, Driver
from models.schemas import PositionHistoryRequest, PositionHistoryResponse, PositionGeoJSON

router = APIRouter(prefix="/api/positions", tags=["positions"])


@router.post("/history", response_model=PositionHistoryResponse)
async def get_position_history(
    request: PositionHistoryRequest,
    current_user: User = Depends(require_permission("view_history")),
):
    db = get_db()
    await verify_device_access(request.device_id, current_user)

    # Fetch positions and trips for the requested time range in parallel
    positions = await db.get_position_history(
        request.device_id, request.start_time, request.end_time,
        request.max_points, request.offset, request.order
    )
    truncated = len(positions) > request.max_points
    if truncated:
        positions = positions[:request.max_points]

    trips = await db.get_device_trips(
        request.device_id, request.start_time, request.end_time
    )

    driver_ids = {pos.driver_id for pos in positions if pos.driver_id}
    driver_map = {}
    if driver_ids:
        async with db.get_session() as session:
            result = await session.execute(select(Driver).where(Driver.id.in_(driver_ids)))
            driver_map = {driver.id: driver.name for driver in result.scalars().all()}

    # Build a sorted list of (start, end, trip_id) for fast lookups
    trip_ranges = []
    for t in trips:
        start = t.start_time.replace(tzinfo=None) if t.start_time else None
        end   = (t.end_time.replace(tzinfo=None) if t.end_time else datetime.max)
        if start is not None:
            trip_ranges.append((start, end, t.id))
    trip_ranges.sort(key=lambda x: x[0])

    def find_trip_id(pos_time: datetime):
        t = pos_time.replace(tzinfo=None)
        for start, end, tid in trip_ranges:
            if start <= t <= end:
                return tid
        return None

    features = []
    total_distance = 0.0
    max_speed = 0.0

    for i, pos in enumerate(positions):
        if i > 0:
            prev = positions[i - 1]
            total_distance += calculate_distance_km(
                prev.latitude, prev.longitude, pos.latitude, pos.longitude
            )

        if pos.speed:
            max_speed = max(max_speed, pos.speed)

        features.append(PositionGeoJSON(
            type="Feature",
            geometry={"type": "Point", "coordinates": [pos.longitude, pos.latitude]},
            properties={
                "speed":     pos.speed,
                "course":    pos.course,
                "ignition":  pos.ignition,
                "time":      pos.device_time.isoformat(),
                "server_time": pos.server_time.isoformat() if pos.server_time else None,
                "altitude":  pos.altitude,
                "satellites": pos.satellites,
                "sensors":   pos.sensors,
                "trip_id":   find_trip_id(pos.device_time),
                "driver_id": pos.driver_id,
                "driver_name": driver_map.get(pos.driver_id) if pos.driver_id else None,
            },
        ))

    duration_minutes = 0
    if positions:
        t1 = positions[0].device_time
        t2 = positions[-1].device_time
        duration_minutes = int(abs((t2 - t1).total_seconds()) / 60)

    return PositionHistoryResponse(
        type="FeatureCollection",
        features=features,
        truncated=truncated,
        summary={
            "total_distance_km": round(total_distance, 2),
            "duration_minutes":  duration_minutes,
            "max_speed":         round(max_speed, 1),
        },
    )
