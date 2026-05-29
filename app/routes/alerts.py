"""
Alert Routes
Alert history and type definitions.

Access rules:
  GET  /api/alerts/types    → any authenticated user
  GET  /api/alerts          → returns only the caller's alerts (token-derived)
  POST /api/alerts/{id}/read → caller must own the alert
  DELETE /api/alerts/{id}   → caller must own the alert
"""
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query, Depends

from core.database import get_db
from core.auth import get_current_user
from models import AlertHistory, User
from models.schemas import AlertResponse
from alerts import ALERT_DEFINITIONS_PUBLIC
from sqlalchemy import select

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
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
):
    db = get_db()
    if unread_only:
        return await db.get_user_alerts(current_user.id, unread_only=True, limit=limit, offset=offset)
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