import json
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import selectinload

from core.audit import write_audit_log
from core.auth import require_api_scope_or_permission
from core.config import get_settings
from core.database import get_db
from core.spatial import calculate_distance_km
from models import Device, PlannedRoute, RouteStop, User

router = APIRouter(prefix="/api/planned-routes", tags=["route-planning"])


class RouteStopIn(BaseModel):
    sequence: int = Field(..., ge=0)
    name: Optional[str] = None
    address: Optional[str] = None
    latitude: float = Field(..., ge=-90, le=90)
    longitude: float = Field(..., ge=-180, le=180)
    planned_arrival: Optional[datetime] = None
    service_minutes: int = Field(0, ge=0)
    stop_kind: str = Field("stop", pattern="^(stop|waypoint)$")
    arrival_radius_m: int = Field(50, ge=5, le=5000)
    dwell_seconds: int = Field(0, ge=0, le=86400)
    notes: Optional[str] = None


class PlannedRouteIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    company_id: Optional[int] = None
    device_id: Optional[int] = None
    status: str = "draft"
    stops: list[RouteStopIn] = Field(default_factory=list)


class PlannedRouteUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    device_id: Optional[int] = None
    status: Optional[str] = None
    stops: Optional[list[RouteStopIn]] = None


class StopStatusIn(BaseModel):
    status: str
    arrived_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    notes: Optional[str] = None


class RoutePreviewIn(BaseModel):
    stops: list[RouteStopIn] = Field(default_factory=list)


def _naive_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _route_stop_values(stop: RouteStopIn) -> dict:
    values = stop.model_dump()
    values["planned_arrival"] = _naive_utc(values.get("planned_arrival"))
    return values


def _route_payload(route: PlannedRoute) -> dict:
    return {
        "id": route.id,
        "company_id": route.company_id,
        "name": route.name,
        "device_id": route.device_id,
        "status": route.status,
        "route_geometry": route.route_geometry,
        "distance_km": route.distance_km,
        "duration_minutes": route.duration_minutes,
        "created_by": route.created_by,
        "created_at": route.created_at,
        "updated_at": route.updated_at,
        "stops": [
            {
                "id": s.id,
                "sequence": s.sequence,
                "name": s.name,
                "address": s.address,
                "latitude": s.latitude,
                "longitude": s.longitude,
                "planned_arrival": s.planned_arrival,
                "service_minutes": s.service_minutes,
                "stop_kind": s.stop_kind,
                "arrival_radius_m": s.arrival_radius_m,
                "dwell_seconds": s.dwell_seconds,
                "status": s.status,
                "arrived_at": s.arrived_at,
                "completed_at": s.completed_at,
                "notes": s.notes,
            }
            for s in (route.stops or [])
        ],
    }


async def _broadcast_route_update(payload: dict, current_user: User) -> None:
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
        else:
            await ws._broadcast_direct(device_id, message)
            db = get_db()
            for uid in list(ws.active_connections.keys()):
                if uid == current_user.id:
                    continue
                user = await db.get_user(uid)
                if user and (user.is_admin or (user.is_company_admin and user.company_id == payload.get("company_id"))):
                    await ws._send_to_user(uid, json.dumps(message))
        await ws._send_to_user(current_user.id, json.dumps(message))
    except Exception:
        pass


async def _calculate_route(stops: list[RouteStopIn]) -> tuple[Optional[dict], Optional[float], Optional[float]]:
    ordered = sorted(stops, key=lambda s: s.sequence)
    if len(ordered) < 2:
        return None, 0.0, 0.0

    settings = get_settings()
    if settings.valhalla_enabled and settings.valhalla_url:
        payload = {
            "locations": [{"lat": s.latitude, "lon": s.longitude} for s in ordered],
            "costing": "auto",
            "directions_options": {"units": "kilometers"},
        }
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(f"{settings.valhalla_url.rstrip('/')}/route", json=payload)
            if resp.status_code == 200:
                data = resp.json()
                summary = (data.get("trip") or {}).get("summary") or {}
                legs = (data.get("trip") or {}).get("legs") or []
                shapes = [leg.get("shape") for leg in legs if leg.get("shape")]
                return (
                    {
                        "provider": "valhalla",
                        "encoded_shapes": shapes,
                        "encoded_shape": shapes[0] if shapes else None,
                        "raw_summary": summary,
                    },
                    float(summary.get("length") or 0),
                    float(summary.get("time") or 0) / 60.0,
                )
        except Exception:
            pass

    distance = 0.0
    for prev, cur in zip(ordered, ordered[1:]):
        distance += calculate_distance_km(prev.latitude, prev.longitude, cur.latitude, cur.longitude)
    return (
        {"provider": "straight_line", "coordinates": [[s.longitude, s.latitude] for s in ordered]},
        round(distance, 3),
        round((distance / 50.0) * 60.0, 1) if distance else 0.0,
    )


async def _assert_company_objects(company_id: Optional[int], device_id: Optional[int]) -> None:
    db = get_db()
    async with db.get_session() as session:
        if device_id is not None:
            device = await session.get(Device, device_id)
            if not device or device.company_id != company_id:
                raise HTTPException(status_code=400, detail="Device does not belong to route company")


def _assignment_status(device_id: Optional[int]) -> str:
    return "planned" if device_id is not None else "draft"


@router.get("")
async def list_routes(
    status: Optional[str] = Query(None),
    company_id: Optional[int] = Query(None),
    current_user: User = Depends(require_api_scope_or_permission("routes:read", "manage_routes")),
):
    db = get_db()
    async with db.get_session() as session:
        q = select(PlannedRoute).options(selectinload(PlannedRoute.stops)).order_by(PlannedRoute.created_at.desc())
        if not current_user.is_admin:
            q = q.where(PlannedRoute.company_id == current_user.company_id)
        elif company_id is not None:
            q = q.where(PlannedRoute.company_id == company_id)
        if status:
            q = q.where(PlannedRoute.status == status)
        result = await session.execute(q)
        return [_route_payload(r) for r in result.scalars().all()]


@router.post("/preview")
async def preview_route(data: RoutePreviewIn, current_user: User = Depends(require_api_scope_or_permission("routes:read", "manage_routes"))):
    geometry, distance, duration = await _calculate_route(data.stops)
    return {
        "route_geometry": geometry,
        "distance_km": distance,
        "duration_minutes": duration,
    }


@router.post("")
async def create_route(data: PlannedRouteIn, request: Request, current_user: User = Depends(require_api_scope_or_permission("routes:write", "manage_routes"))):
    if not (current_user.is_admin or current_user.is_company_admin):
        raise HTTPException(status_code=403, detail="Company admin access required")
    company_id = data.company_id if current_user.is_admin else current_user.company_id
    if current_user.is_admin and data.device_id is not None:
        db = get_db()
        async with db.get_session() as session:
            device = await session.get(Device, data.device_id)
            if not device:
                raise HTTPException(status_code=400, detail="Device does not belong to route company")
            company_id = device.company_id
    await _assert_company_objects(company_id, data.device_id)
    geometry, distance, duration = await _calculate_route(data.stops)
    db = get_db()
    async with db.get_session() as session:
        status = data.status
        if status in {"draft", "planned"}:
            status = _assignment_status(data.device_id)
        route = PlannedRoute(
            company_id=company_id,
            name=data.name,
            device_id=data.device_id,
            driver_id=None,
            status=status,
            route_geometry=geometry,
            distance_km=distance,
            duration_minutes=duration,
            created_by=current_user.id,
        )
        session.add(route)
        await session.flush()
        for stop in sorted(data.stops, key=lambda s: s.sequence):
            session.add(RouteStop(route_id=route.id, **_route_stop_values(stop)))
        await session.flush()
        await session.refresh(route, ["stops"])
        payload = _route_payload(route)
    await write_audit_log("route.created", actor=current_user, company_id=company_id, target_type="planned_route", target_id=payload["id"], request=request)
    await _broadcast_route_update(payload, current_user)
    return payload


@router.get("/{route_id}")
async def get_route(route_id: int, current_user: User = Depends(require_api_scope_or_permission("routes:read", "manage_routes"))):
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(select(PlannedRoute).where(PlannedRoute.id == route_id).options(selectinload(PlannedRoute.stops)))
        route = result.scalar_one_or_none()
        if not route:
            raise HTTPException(status_code=404, detail="Route not found")
        if not current_user.is_admin and route.company_id != current_user.company_id:
            raise HTTPException(status_code=403, detail="Forbidden")
        return _route_payload(route)


@router.put("/{route_id}")
async def update_route(route_id: int, data: PlannedRouteUpdate, request: Request, current_user: User = Depends(require_api_scope_or_permission("routes:write", "manage_routes"))):
    if not (current_user.is_admin or current_user.is_company_admin):
        raise HTTPException(status_code=403, detail="Company admin access required")
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(select(PlannedRoute).where(PlannedRoute.id == route_id).options(selectinload(PlannedRoute.stops)))
        route = result.scalar_one_or_none()
        if not route:
            raise HTTPException(status_code=404, detail="Route not found")
        if not current_user.is_admin and route.company_id != current_user.company_id:
            raise HTTPException(status_code=403, detail="Forbidden")
        locked_statuses = {"active", "started", "in_progress", "paused", "stopped"}
        edit_fields = {"name", "device_id", "stops"}
        if route.status in locked_statuses and edit_fields.intersection(data.model_fields_set):
            raise HTTPException(status_code=400, detail="Started or paused routes cannot be edited")
        next_device_id = data.device_id if "device_id" in data.model_fields_set else route.device_id
        next_company_id = route.company_id
        if next_device_id is not None and (current_user.is_admin or next_company_id is None):
            device = await session.get(Device, next_device_id)
            if not device:
                raise HTTPException(status_code=400, detail="Device does not belong to route company")
            next_company_id = device.company_id
            if next_company_id is not None:
                route.company_id = next_company_id
        await _assert_company_objects(next_company_id, next_device_id)
        if data.status in {"active", "started", "in_progress"} and not next_device_id:
            raise HTTPException(status_code=400, detail="Assign a vehicle before starting this route")
        if data.name is not None:
            route.name = data.name
        if "device_id" in data.model_fields_set:
            route.device_id = data.device_id
            route.driver_id = None
        previous_status = route.status
        if data.status is not None:
            route.status = (
                _assignment_status(route.device_id)
                if data.status in {"draft", "planned"}
                else data.status
            )
        elif "device_id" in data.model_fields_set and route.status in {"draft", "planned"}:
            route.status = _assignment_status(data.device_id)
        if (
            previous_status in {"completed", "cancelled"}
            and route.status not in {"completed", "cancelled"}
        ):
            for stop in route.stops or []:
                stop.status = "pending"
                stop.arrived_at = None
                stop.completed_at = None
        if data.stops is not None:
            await session.execute(delete(RouteStop).where(RouteStop.route_id == route.id))
            geometry, distance, duration = await _calculate_route(data.stops)
            route.route_geometry = geometry
            route.distance_km = distance
            route.duration_minutes = duration
            for stop in sorted(data.stops, key=lambda s: s.sequence):
                session.add(RouteStop(route_id=route.id, **_route_stop_values(stop)))
        route.updated_at = datetime.utcnow()
        await session.flush()
        await session.refresh(route, ["stops"])
        payload = _route_payload(route)
    await write_audit_log("route.updated", actor=current_user, company_id=payload["company_id"], target_type="planned_route", target_id=route_id, request=request)
    await _broadcast_route_update(payload, current_user)
    return payload


@router.put("/{route_id}/stops/{stop_id}")
async def update_stop_status(route_id: int, stop_id: int, data: StopStatusIn, request: Request, current_user: User = Depends(require_api_scope_or_permission("routes:write", "manage_routes"))):
    db = get_db()
    async with db.get_session() as session:
        route = await session.get(PlannedRoute, route_id)
        stop = await session.get(RouteStop, stop_id)
        if not route or not stop or stop.route_id != route_id:
            raise HTTPException(status_code=404, detail="Stop not found")
        if not current_user.is_admin and route.company_id != current_user.company_id:
            raise HTTPException(status_code=403, detail="Forbidden")
        stop.status = data.status
        if "arrived_at" in data.model_fields_set:
            stop.arrived_at = _naive_utc(data.arrived_at)
        if "completed_at" in data.model_fields_set:
            stop.completed_at = _naive_utc(data.completed_at)
        if data.notes is not None:
            stop.notes = data.notes
        route.updated_at = datetime.utcnow()
        company_id = route.company_id
        await session.flush()
        result = await session.execute(select(PlannedRoute).where(PlannedRoute.id == route_id).options(selectinload(PlannedRoute.stops)))
        payload = _route_payload(result.scalar_one())
    await write_audit_log("route.stop_updated", actor=current_user, company_id=company_id, target_type="route_stop", target_id=stop_id, request=request, metadata={"route_id": route_id, "status": data.status})
    await _broadcast_route_update(payload, current_user)
    return {"status": "updated"}


@router.delete("/{route_id}")
async def delete_route(route_id: int, request: Request, current_user: User = Depends(require_api_scope_or_permission("routes:write", "manage_routes"))):
    if not (current_user.is_admin or current_user.is_company_admin):
        raise HTTPException(status_code=403, detail="Company admin access required")
    db = get_db()
    async with db.get_session() as session:
        route = await session.get(PlannedRoute, route_id)
        if not route:
            raise HTTPException(status_code=404, detail="Route not found")
        if not current_user.is_admin and route.company_id != current_user.company_id:
            raise HTTPException(status_code=403, detail="Forbidden")
        company_id = route.company_id
        await session.delete(route)
    await write_audit_log("route.deleted", actor=current_user, company_id=company_id, target_type="planned_route", target_id=route_id, request=request)
    return {"status": "deleted"}
