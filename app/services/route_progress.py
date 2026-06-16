import json
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from core.database import get_db
from core.spatial import calculate_distance_km
from models import Device, PlannedRoute, RouteStop
from models.schemas import NormalizedPosition
from routes.route_planning import _route_payload

logger = logging.getLogger(__name__)

ACTIVE_ROUTE_STATUSES = {"active", "started", "in_progress"}
COMPLETED_STOP_STATUS = "completed"

_route_dwell_state: dict[tuple[int, int], dict[str, object]] = {}


def _utcnow_naive() -> datetime:
    return datetime.utcnow()


def _clear_dwell_state(route_id: int, keep_stop_id: Optional[int] = None) -> None:
    for key in list(_route_dwell_state.keys()):
        current_route_id, current_stop_id = key
        if current_route_id != route_id:
            continue
        if keep_stop_id is not None and current_stop_id == keep_stop_id:
            continue
        _route_dwell_state.pop(key, None)


def _stop_radius_m(stop: RouteStop) -> int:
    try:
        return max(0, int(stop.arrival_radius_m or 50))
    except (TypeError, ValueError):
        return 50


def _stop_dwell_seconds(stop: RouteStop) -> int:
    try:
        return max(0, int(stop.dwell_seconds or 0))
    except (TypeError, ValueError):
        return 0


def _active_routes_query(device_id: int):
    return (
        select(PlannedRoute)
        .where(
            PlannedRoute.device_id == device_id,
            PlannedRoute.status.in_(ACTIVE_ROUTE_STATUSES),
        )
        .options(selectinload(PlannedRoute.stops))
        .order_by(PlannedRoute.updated_at.desc(), PlannedRoute.created_at.desc())
    )


def _point_at_position(route: PlannedRoute, position: NormalizedPosition) -> Optional[RouteStop]:
    candidates: list[tuple[RouteStop, float]] = []
    for stop in sorted(route.stops or [], key=lambda s: int(s.sequence or 0)):
        if (stop.status or "").lower() == COMPLETED_STOP_STATUS:
            continue
        distance_m = calculate_distance_km(
            position.latitude,
            position.longitude,
            stop.latitude,
            stop.longitude,
        ) * 1000
        if distance_m <= _stop_radius_m(stop):
            candidates.append((stop, distance_m))

    if not candidates:
        return None

    candidates.sort(key=lambda item: (int(item[0].sequence or 0), item[1]))
    return candidates[0][0]


def _is_final_route_point(route: PlannedRoute, stop: RouteStop) -> bool:
    sequences = [int(s.sequence or 0) for s in (route.stops or [])]
    return bool(sequences) and int(stop.sequence or 0) >= max(sequences)


async def _broadcast_route_update(payload: dict) -> None:
    device_id = payload.get("device_id")
    if not device_id:
        return

    data = jsonable_encoder(payload)
    message = {
        "type": "route_update",
        "device_id": device_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "data": data,
    }

    try:
        from main import get_ws_manager, redis_pubsub

        ws = get_ws_manager()
        if redis_pubsub.available:
            await redis_pubsub.publish(f"device:{device_id}", message)
            return

        await ws._broadcast_direct(device_id, message)
        db = get_db()
        raw = json.dumps(message)
        for uid in list(ws.active_connections.keys()):
            user = await db.get_user(uid)
            if user and (user.is_admin or (user.is_company_admin and user.company_id == payload.get("company_id"))):
                await ws._send_to_user(uid, raw)
    except Exception as exc:
        logger.debug("Route progress broadcast failed: %s", exc, exc_info=True)


async def process_route_progress_for_position(position: NormalizedPosition, device: Device) -> None:
    db = get_db()
    changed_payloads: list[dict] = []

    async with db.get_session() as session:
        result = await session.execute(_active_routes_query(device.id))
        routes = list(result.scalars().all())

        for route in routes:
            stop = _point_at_position(route, position)
            if not stop:
                _clear_dwell_state(route.id)
                continue

            key = (route.id, stop.id)
            _clear_dwell_state(route.id, stop.id)

            now_utc = _utcnow_naive()
            changed = False
            state = _route_dwell_state.setdefault(
                key,
                {"entered_at": datetime.now(timezone.utc), "arrived_sent": False},
            )

            if not state.get("arrived_sent") and (stop.status or "").lower() == "pending":
                stop.status = "arrived"
                stop.arrived_at = now_utc
                route.updated_at = now_utc
                state["arrived_sent"] = True
                changed = True
                await session.flush()

            entered_at = state.get("entered_at")
            elapsed = 0.0
            if isinstance(entered_at, datetime):
                elapsed = (datetime.now(timezone.utc) - entered_at).total_seconds()

            if elapsed >= _stop_dwell_seconds(stop):
                stop.status = COMPLETED_STOP_STATUS
                stop.completed_at = now_utc
                route.updated_at = now_utc
                if _is_final_route_point(route, stop):
                    route.status = "completed"
                _route_dwell_state.pop(key, None)
                changed = True
                await session.flush()

            if changed:
                refreshed = await session.execute(
                    select(PlannedRoute)
                    .where(PlannedRoute.id == route.id)
                    .options(selectinload(PlannedRoute.stops))
                )
                changed_payloads.append(_route_payload(refreshed.scalar_one()))

    for payload in changed_payloads:
        await _broadcast_route_update(payload)
