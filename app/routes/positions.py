"""
Position Routes
GPS position history endpoint.
"""
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status

from core.database import get_db
from core.auth import get_current_user
from models import User
from models.schemas import PositionHistoryRequest, PositionHistoryResponse, PositionGeoJSON

router = APIRouter(prefix="/api/positions", tags=["positions"])


@router.post("/history", response_model=PositionHistoryResponse)
async def get_position_history(
    request: PositionHistoryRequest,
    current_user: User = Depends(get_current_user),
):
    db = get_db()

    # Verify the caller has access to the requested device
    if not current_user.is_admin:
        user_devices = await db.get_user_devices(current_user.id)
        if not any(d.id == request.device_id for d in user_devices):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You do not have access to this device",
            )

    # Fetch positions and trips for the requested time range in parallel
    positions = await db.get_position_history(
        request.device_id, request.start_time, request.end_time,
        request.max_points, request.order
    )

    trips = await db.get_device_trips(
        request.device_id, request.start_time, request.end_time
    )

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
            async with db.get_session() as session:
                distance_km = await db._calculate_distance(
                    session, prev.latitude, prev.longitude, pos.latitude, pos.longitude
                )
                total_distance += distance_km

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
                "altitude":  pos.altitude,
                "satellites": pos.satellites,
                "sensors":   pos.sensors,
                "trip_id":   find_trip_id(pos.device_time),
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
        summary={
            "total_distance_km": round(total_distance, 2),
            "duration_minutes":  duration_minutes,
            "max_speed":         round(max_speed, 1),
        },
    )
