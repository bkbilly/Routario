"""
Geofence Routes
"""
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Depends

from core.database import get_db
from core.auth import get_current_user
from models import User
from models.schemas import GeofenceCreate, GeofenceUpdate, GeofenceResponse

router = APIRouter(prefix="/api/geofences", tags=["geofences"])


@router.get("")
async def get_geofences(
    device_id: Optional[int] = Query(None),
    current_user: User = Depends(get_current_user),
):
    """
    Get geofences for the current user.
    Admins see all geofences. Regular users see geofences not tied to any device
    plus geofences tied to their own devices.
    """
    if device_id is not None and not current_user.is_admin:
        db = get_db()
        user_devices = await db.get_user_devices(current_user.id)
        if not any(d.id == device_id for d in user_devices):
            raise HTTPException(status_code=403, detail="You do not have access to this device")

    db = get_db()
    return await db.get_geofences(device_id)


@router.post("", response_model=GeofenceResponse)
async def create_geofence(
    geofence: GeofenceCreate,
    current_user: User = Depends(get_current_user),
):
    """Create a geofence."""
    if geofence.device_id is not None and not current_user.is_admin:
        db = get_db()
        user_devices = await db.get_user_devices(current_user.id)
        if not any(d.id == geofence.device_id for d in user_devices):
            raise HTTPException(status_code=403, detail="You do not have access to this device")

    db = get_db()
    return await db.create_geofence(geofence.model_dump())


@router.put("/{geofence_id}")
async def update_geofence(
    geofence_id: int,
    update: GeofenceUpdate,
    current_user: User = Depends(get_current_user),
):
    """Update a geofence's name, description, polygon, color, or alert flags."""
    db = get_db()
    updated = await db.update_geofence(geofence_id, update.model_dump(exclude_unset=True))
    if not updated:
        raise HTTPException(status_code=404, detail="Geofence not found")
    # Return refreshed data from get_geofences
    geofences = await db.get_geofences()
    return next((g for g in geofences if g['id'] == geofence_id), updated)


@router.delete("/{geofence_id}")
async def delete_geofence(
    geofence_id: int,
    current_user: User = Depends(get_current_user),
):
    """Delete a geofence."""
    db = get_db()
    deleted = await db.delete_geofence(geofence_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Geofence not found")
    return {"deleted": True}