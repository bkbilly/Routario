"""
Alert Routes
Alert history and type definitions.

Access rules:
  GET  /api/alerts/types    → any authenticated user
  GET  /api/alerts          → returns only the caller's alerts (token-derived)
  POST /api/alerts/{id}/read → caller must own the alert
  DELETE /api/alerts/{id}   → caller must own the alert
"""
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, Depends
from pydantic import BaseModel

from core.database import get_db
from core.auth import get_current_user
from models import AlertHistory, User
from models.schemas import AlertResponse
from alerts import ALERT_DEFINITIONS_PUBLIC
from sqlalchemy import select

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/alerts", tags=["alerts"])


@router.get("/types")
async def get_alert_types(current_user: User = Depends(get_current_user)):
    """Return all registered alert type definitions. Any authenticated user."""
    result = {}
    for key, d in ALERT_DEFINITIONS_PUBLIC.items():
        result[key] = {
            "label":    d.label,
            "desc":     d.description,
            "icon":     d.icon,
            "severity": d.severity.value if hasattr(d.severity, "value") else d.severity,
            "fields": [
                {
                    "key":          f.key,
                    "label":        f.label,
                    "field_type":   f.field_type,
                    "default":      f.default,
                    "unit":         f.unit,
                    "min_value":    f.min_value,
                    "max_value":    f.max_value,
                    "options":      f.options,
                    "required":     f.required,
                    "help_text":    f.help_text,
                    "updates_field": f.updates_field,
                    "show_if":       f.show_if,
                }
                for f in d.fields
            ],
        }
    return result


@router.get("/report")
async def get_alerts_report(
    user_ids: List[int]        = Query(default=[]),
    device_ids: List[int]      = Query(default=[]),
    start_date: Optional[datetime] = Query(None),
    end_date: Optional[datetime]   = Query(None),
    alert_type: Optional[str]  = Query(None),
    limit: int                 = Query(500, ge=1, le=2000),
    offset: int                = Query(0, ge=0),
    current_user: User         = Depends(get_current_user),
):
    """
    Alert report with cross-user scoping.
    - Super admin  : all users by default; filter with user_ids.
    - Company admin: scoped to their company; filter with user_ids.
    - Regular user : always own alerts only; user_ids ignored.
    """
    db = get_db()

    if current_user.is_admin:
        effective_user_ids = user_ids  # empty = all users
    elif current_user.is_company_admin:
        async with db.get_session() as session:
            result = await session.execute(
                select(User.id).where(User.company_id == current_user.company_id)
            )
            company_ids = {r[0] for r in result.all()}
        effective_user_ids = (
            [uid for uid in user_ids if uid in company_ids] if user_ids
            else list(company_ids)
        )
        if not effective_user_ids:
            return []
    else:
        effective_user_ids = [current_user.id]

    return await db.get_alerts_report(
        user_ids=effective_user_ids,
        device_ids=device_ids,
        start_date=start_date,
        end_date=end_date,
        alert_type=alert_type,
        limit=limit,
        offset=offset,
    )


@router.get("", response_model=List[AlertResponse])
async def get_alerts(
    unread_only: bool = Query(False),
    read_only: bool = Query(False),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
):
    db = get_db()
    if unread_only:
        return await db.get_user_alerts(current_user.id, unread_only=True, limit=limit, offset=offset)
    if read_only:
        return await db.get_user_alerts(current_user.id, read_only=True, limit=limit, offset=offset)
    return await db.get_user_alerts(current_user.id, limit=limit, offset=offset)


async def _get_alert_owned(alert_id: int, current_user: User):
    """Fetch alert and verify ownership. Raises 404/403 as appropriate."""
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(AlertHistory).where(AlertHistory.id == alert_id)
        )
        alert = result.scalar_one_or_none()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    if not current_user.is_admin and alert.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Forbidden")
    return alert


@router.post("/{alert_id}/read")
async def mark_alert_read(
    alert_id: int,
    current_user: User = Depends(get_current_user),
):
    await _get_alert_owned(alert_id, current_user)
    db = get_db()
    success = await db.mark_alert_read(alert_id)
    if not success:
        raise HTTPException(status_code=404, detail="Alert not found")
    return {"status": "success"}


@router.delete("/{alert_id}")
async def delete_alert(
    alert_id: int,
    current_user: User = Depends(get_current_user),
):
    await _get_alert_owned(alert_id, current_user)
    db = get_db()
    success = await db.delete_alert(alert_id)
    if not success:
        raise HTTPException(status_code=404, detail="Alert not found")
    return {"status": "deleted"}


class AlertTestTriggerRequest(BaseModel):
    device_id: int
    alert_type: str = "custom"
    rule_name: Optional[str] = None
    severity: Optional[str] = "warning"
    message: Optional[str] = None
    params: Optional[Dict[str, Any]] = None
    channels: Optional[List[str]] = None
    notify_user_ids: Optional[List[int]] = None
    send_push: Optional[bool] = True
    send_email: Optional[bool] = False
    send_voip: Optional[bool] = False


@router.post("/test-trigger")
async def trigger_test_alert(
    req: AlertTestTriggerRequest,
    current_user: User = Depends(get_current_user),
):
    """
    Manually trigger a test alert for a device and alert rule,
    dispatching notifications to all configured channels and saving history.
    """
    db = get_db()
    # 1. Fetch device and verify user access
    device = await db.get_device_by_id(req.device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    if not current_user.is_admin:
        if current_user.is_company_admin:
            if device.company_id != current_user.company_id:
                raise HTTPException(status_code=403, detail="Forbidden")
        else:
            user_devices = await db.get_user_devices(current_user.id)
            if not any(d.id == req.device_id for d in user_devices):
                raise HTTPException(status_code=403, detail="Forbidden")

    # 2. Determine target users
    notify_users = []
    if req.notify_user_ids:
        notify_users = await db.get_users_by_ids(req.notify_user_ids)
    if not notify_users and getattr(device, 'users', None):
        notify_users = list(device.users)
    if not notify_users:
        notify_users = [current_user]

    # 3. Format realistic alert message matching real alerts
    alert_label = req.rule_name or req.alert_type.replace("_", " ").title()
    if req.message:
        msg = req.message
    else:
        k = (req.alert_type or "").lower()
        p = req.params or {}
        if k in ("speed", "speeding"):
            lim = p.get("speed_limit") or p.get("limit") or p.get("speed_tolerance") or 90
            try:
                lim_f = float(lim)
                msg = f"Speeding: {lim_f + 12:.1f} km/h — road limit {lim_f:.0f} km/h."
            except Exception:
                msg = f"Speed limit exceeded (> {lim} km/h)."
        elif k in ("idle", "idling"):
            t = p.get("idle_timeout_minutes") or p.get("duration") or 10
            msg = f"Idle Alert: Vehicle idling for {int(t)} min."
        elif k in ("low_battery", "battery"):
            v = p.get("voltage_threshold") or p.get("voltage") or 11.8
            try:
                v_f = float(v)
                msg = f"Low Battery: {v_f - 0.4:.2f}V (threshold {v_f:.1f}V)"
            except Exception:
                msg = f"Low Battery detected for vehicle {device.name}."
        elif k in ("offline", "disconnect"):
            h = p.get("offline_timeout_hours") or 2
            msg = f"Device offline for over {h}h."
        elif k in ("towing", "movement"):
            m = p.get("towing_threshold_meters") or 50
            msg = f"Towing Alert: Vehicle moved {int(m)}m while parked."
        elif k in ("geofence", "geofencing", "geofence_alert"):
            gf_id = p.get("geofence_id")
            gf_name = p.get("geofence_name") or p.get("zone_name")
            if not gf_name and gf_id:
                try:
                    all_gf = await db.get_geofences(device_id=device.id)
                    found_gf = next((g for g in all_gf if str(g.id) == str(gf_id)), None)
                    if not found_gf and current_user.company_id:
                        all_gf_comp = await db.get_geofences(company_id=current_user.company_id)
                        found_gf = next((g for g in all_gf_comp if str(g.id) == str(gf_id)), None)
                    if found_gf:
                        gf_name = found_gf.name
                except Exception:
                    pass
            if not gf_name:
                gf_name = f"Geofence #{gf_id}" if gf_id else "Main Yard"

            p["geofence_name"] = gf_name
            ev_type = str(p.get("event_type") or "enter").lower()
            ev_verb = "Entered" if ev_type in ("enter", "both") else "Exited"
            msg = f"Geofence {ev_verb}: {gf_name}"
        elif k == "device_event":
            label = p.get("event_label") or p.get("sensor_key") or "Panic Button"
            msg = f"Device Event: {label}"
        elif k in ("no_driver", "driver"):
            msg = "Unauthorized movement without driver identified (speed 45 km/h)."
        elif k.startswith("maint"):
            m_type = p.get("maintenance_type") or "service"
            custom_lbl = p.get("custom_label")
            if m_type == "custom" and custom_lbl:
                lbl = custom_lbl
            else:
                m_map = {
                    "service": "Service",
                    "oil_change": "Oil Change",
                    "tire_change": "Tire Change",
                    "brake_service": "Brake Service",
                    "air_filter": "Air Filter",
                }
                lbl = m_map.get(m_type, m_type.replace("_", " ").title())
            msg = f"Maintenance Due: {lbl} is due now!"
        elif req.rule_name:
            msg = f"{req.rule_name} triggered."
        else:
            msg = f"{alert_label} alert triggered."

    # 4. Resolve channels
    channels = list(req.channels) if req.channels is not None else []
    if not channels and device.config:
        cfg_channels = device.config.get("alert_channels", {})
        if req.alert_type in cfg_channels:
            channels = cfg_channels[req.alert_type]

    # 5. Create AlertHistory record
    from models.schemas import AlertCreate, AlertType, Severity

    try:
        type_enum = AlertType(req.alert_type)
    except Exception:
        type_enum = AlertType.CUSTOM

    try:
        sev_enum = Severity(req.severity)
    except Exception:
        sev_enum = Severity.WARNING

    alert_meta = {
        "rule_name": req.rule_name or alert_label,
        "is_test": True,
        "triggered_by": current_user.username,
        "selected_channels": channels,
        "channel_status": [],
        "params": req.params or {},
    }
    if req.params:
        if "geofence_name" in req.params:
            alert_meta["geofence_name"] = req.params["geofence_name"]
        if "geofence_id" in req.params:
            alert_meta["geofence_id"] = req.params["geofence_id"]

    dev_state = await db.get_device_state(device.id)
    lat = dev_state.last_latitude if dev_state else None
    lon = dev_state.last_longitude if dev_state else None
    addr = dev_state.last_address if dev_state else None

    created_alert = await db.create_alert(
        AlertCreate(
            user_id=current_user.id,
            device_id=device.id,
            alert_type=req.alert_type,
            severity=sev_enum.value,
            message=msg,
            latitude=lat,
            longitude=lon,
            address=addr,
            alert_metadata=alert_meta,
        )
    )

    # 6. Dispatch notifications via AlertEngine
    from core.alert_engine import get_alert_engine

    alert_data = {
        "type": type_enum,
        "severity": sev_enum,
        "message": msg,
        "latitude": lat,
        "longitude": lon,
        "channels": channels,
        "send_push": req.send_push if req.send_push is not None else True,
        "send_email": req.send_email if req.send_email is not None else False,
        "alert_metadata": alert_meta,
    }

    engine = get_alert_engine()
    for target_user in notify_users:
        try:
            await engine._send_notification(
                user=target_user,
                device=device,
                alert_data=alert_data,
                alert_id=created_alert.id,
            )
        except Exception as e:
            logger.error("Test alert notification dispatch failed for user %s: %s", getattr(target_user, 'id', None), e, exc_info=True)

    # 6. Broadcast via WebSocket
    try:
        from main import handle_new_alert
        await handle_new_alert(created_alert, notify_user_ids=[u.id for u in notify_users])
    except Exception:
        pass

    # 7. Fetch updated alert with channel_status
    async with db.get_session() as session:
        refreshed = await session.get(AlertHistory, created_alert.id)
        final_meta = refreshed.alert_metadata or {} if refreshed else alert_meta

    return {
        "id": created_alert.id,
        "device_id": created_alert.device_id,
        "device_name": device.name,
        "alert_type": created_alert.alert_type,
        "severity": created_alert.severity,
        "message": created_alert.message,
        "is_read": created_alert.is_read,
        "created_at": created_alert.created_at.isoformat() if created_alert.created_at else None,
        "alert_metadata": final_meta,
        "channel_status": final_meta.get("channel_status", []),
    }