"""
Geofence Routes
"""
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Depends

from core.database import get_db
from core.auth import get_current_user, require_permission
from models import User
from models.schemas import GeofenceCreate, GeofenceUpdate, GeofenceResponse

router = APIRouter(prefix="/api/geofences", tags=["geofences"])


async def _resolve_owner(requested_user_id: Optional[int], current_user: User) -> int:
    """
    Validate and return the effective owner user_id for a geofence.
    - Super admin: any user_id, defaults to self
    - Company admin: any user in their company, defaults to self
    - Regular user: always self, requested_user_id is ignored
    """
    if not (current_user.is_admin or current_user.is_company_admin):
        return current_user.id

    if requested_user_id is None:
        return current_user.id

    if current_user.is_admin:
        return requested_user_id

    # Company admin: verify target user belongs to the same company
    db = get_db()
    target = await db.get_user(requested_user_id)
    if not target or target.company_id != current_user.company_id:
        raise HTTPException(status_code=403, detail="User does not belong to your company")
    return requested_user_id


@router.get("")
async def get_geofences(
    device_id: Optional[int] = Query(None),
    current_user: User = Depends(get_current_user),
):
    db = get_db()
    if current_user.is_admin:
        return await db.get_geofences(device_id=device_id)
    if current_user.is_company_admin and current_user.company_id is not None:
        return await db.get_geofences(device_id=device_id, company_id=current_user.company_id)
    return await db.get_geofences(device_id=device_id, user_id=current_user.id)


@router.post("", response_model=GeofenceResponse)
async def create_geofence(
    geofence: GeofenceCreate,
    current_user: User = Depends(require_permission("manage_geofences")),
):
    db = get_db()
    owner_id = await _resolve_owner(geofence.user_id, current_user)
    data = geofence.model_dump()
    return await db.create_geofence(data, user_id=owner_id)


@router.put("/{geofence_id}")
async def update_geofence(
    geofence_id: int,
    update: GeofenceUpdate,
    current_user: User = Depends(require_permission("manage_geofences")),
):
    db = get_db()
    caller_user_id = None if (current_user.is_admin or current_user.is_company_admin) else current_user.id
    update_data = update.model_dump(exclude_unset=True)

    if "user_id" in update_data:
        update_data["user_id"] = await _resolve_owner(update_data["user_id"], current_user)

    result = await db.update_geofence(geofence_id, update_data, user_id=caller_user_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Geofence not found")
    if result == "forbidden":
        raise HTTPException(status_code=403, detail="You do not have access to this geofence")
    geofences = await db.get_geofences()
    return next((g for g in geofences if g['id'] == geofence_id), result)


@router.delete("/{geofence_id}")
async def delete_geofence(
    geofence_id: int,
    current_user: User = Depends(require_permission("manage_geofences")),
):
    db = get_db()
    user_id = None if (current_user.is_admin or current_user.is_company_admin) else current_user.id
    result = await db.delete_geofence(geofence_id, user_id=user_id)
    if result is False:
        raise HTTPException(status_code=404, detail="Geofence not found")
    if result == "forbidden":
        raise HTTPException(status_code=403, detail="You do not have access to this geofence")
    return {"deleted": True}
