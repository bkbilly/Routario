"""
Fleet Reports Routes.

Report implementations live in app/reports/* and are dispatched through the
central report registry.
"""
import csv
import io
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from core.auth import require_permission
from core.database import get_db
from models import User
from reports import get_report, get_report_definitions
from reports.common import parse_id_csv

router = APIRouter(prefix="/api/reports", tags=["reports"])


async def _run_report(
    key: str,
    current_user: User,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    device_ids: Optional[str] = None,
    user_ids: Optional[str] = None,
    driver_ids: Optional[str] = None,
    options: Optional[dict] = None,
    historical: bool = False,
) -> dict:
    report = get_report(key)
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    if report.definition.company_admin_required and not (current_user.is_admin or current_user.is_company_admin):
        raise HTTPException(status_code=403, detail="Company admin access required")
    if report.definition.needs_date_range and (not start_date or not end_date):
        raise HTTPException(status_code=400, detail="start_date and end_date are required")
    if historical and (not start_date or not end_date):
        raise HTTPException(status_code=400, detail="start_date and end_date are required for historical reports")

    db = get_db()
    async with db.get_session() as session:
        return await report.run(
            session=session,
            current_user=current_user,
            start_date=start_date,
            end_date=end_date,
            device_ids=parse_id_csv(device_ids),
            user_ids=parse_id_csv(user_ids),
            driver_ids=parse_id_csv(driver_ids),
            options=options or {},
            historical=historical,
        )


@router.get("/types")
async def report_types(current_user: User = Depends(require_permission("view_reports"))):
    return get_report_definitions(current_user)


@router.get("/fleet")
async def fleet_report(
    start_date: datetime = Query(...),
    end_date: datetime = Query(...),
    device_ids: Optional[str] = Query(None, description="Comma-separated device IDs; omit for all"),
    current_user: User = Depends(require_permission("view_reports")),
):
    return await _run_report("summary", current_user, start_date, end_date, device_ids=device_ids)


@router.get("/fleet/csv")
async def fleet_report_csv(
    start_date: datetime = Query(...),
    end_date: datetime = Query(...),
    device_ids: Optional[str] = Query(None),
    current_user: User = Depends(require_permission("view_reports")),
):
    report = await fleet_report(start_date, end_date, device_ids, current_user)

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Device", "Plate", "Driver", "Trips", "Distance (km)", "Driving (min)", "Max Speed (km/h)", "Avg Speed (km/h)"])
    for r in report["rows"] if isinstance(report, dict) else report.rows:
        if isinstance(r, dict):
            writer.writerow([r["device_name"], r.get("license_plate") or "", r.get("driver_name") or "", r["trips"],
                             r["distance_km"], r["driving_minutes"], r["max_speed"], r["avg_speed"]])
        else:
            writer.writerow([r.device_name, r.license_plate or "", r.driver_name or "", r.trips,
                             r.distance_km, r.driving_minutes, r.max_speed, r.avg_speed])

    output.seek(0)
    filename = f"fleet_report_{start_date.date()}_{end_date.date()}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/users")
async def users_report(
    start_date: datetime = Query(...),
    end_date: datetime = Query(...),
    user_ids: Optional[str] = Query(None, description="Comma-separated user IDs; omit for all"),
    current_user: User = Depends(require_permission("view_reports")),
):
    return await _run_report("users", current_user, start_date, end_date, user_ids=user_ids)


@router.get("/trips")
async def trips_report(
    start_date: datetime = Query(...),
    end_date: datetime = Query(...),
    device_ids: Optional[str] = Query(None),
    current_user: User = Depends(require_permission("view_reports")),
):
    return await _run_report("trips", current_user, start_date, end_date, device_ids=device_ids)


@router.get("/{report_key}")
async def report_by_key(
    report_key: str,
    start_date: Optional[datetime] = Query(None),
    end_date: Optional[datetime] = Query(None),
    device_ids: Optional[str] = Query(None),
    user_ids: Optional[str] = Query(None),
    driver_ids: Optional[str] = Query(None),
    group_by: Optional[str] = Query(None),
    historical: bool = Query(False),
    current_user: User = Depends(require_permission("view_reports")),
):
    options = {}
    if group_by is not None:
        options["group_by"] = group_by
    return await _run_report(report_key, current_user, start_date, end_date, device_ids, user_ids, driver_ids, options, historical)
