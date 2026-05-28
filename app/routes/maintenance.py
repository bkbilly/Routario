"""
Maintenance Routes — mark a scheduled maintenance item as serviced.
Updates the next_service_km / next_service_date in the alert row params.
"""
import math
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from core.auth import get_current_user, verify_device_access, require_permission
from core.database import get_db
from models import User

router = APIRouter(prefix="/api/devices", tags=["maintenance"])


class ServiceLogRequest(BaseModel):
    uid: int
    current_odometer_km: float


@router.post("/{device_id}/maintenance/service")
async def log_service(
    device_id: int,
    req: ServiceLogRequest,
    current_user: User = Depends(verify_device_access),
    _: User = Depends(require_permission("manage_maintenance")),
):
    """
    Mark a maintenance alert row as just serviced.
    Advances next_service_km and next_service_date by one interval.
    """
    db = get_db()
    async with db.get_session() as session:
        device = await db.get_device_by_id(device_id)
        if not device:
            raise HTTPException(status_code=404, detail="Device not found")

        config = dict(device.config or {})
        alert_rows = list(config.get("alert_rows", []))

        row = next((r for r in alert_rows if isinstance(r, dict) and r.get("uid") == req.uid), None)
        if not row or row.get("alertKey") != "maintenance_alert":
            raise HTTPException(status_code=404, detail="Maintenance alert row not found")

        params = dict(row.get("params", {}))
        mode = params.get("tracking_mode", "km")

        if mode in ("km", "both"):
            interval_km = float(params.get("interval_km", 5000))
            params["next_service_km"] = req.current_odometer_km + interval_km

        if mode in ("days", "both"):
            interval_days = int(params.get("interval_days", 180))
            params["next_service_date"] = (date.today() + timedelta(days=interval_days)).isoformat()

        row["params"] = params
        config["alert_rows"] = alert_rows

        async with db.get_session() as s:
            from sqlalchemy import select
            from models import Device as DeviceModel
            d = await s.get(DeviceModel, device_id)
            if d:
                d.config = config
                await s.flush()

    return {"status": "ok", "params": params}
