"""
Fleet Reports Routes — aggregated trip stats per device over a date range.
"""
import csv
import io
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload

from core.auth import get_current_user, require_permission
from core.database import get_db
from models import Device, Driver, Trip, User, user_device_association
from models.models import DeviceState
from models.schemas import FleetReport, FleetReportRow, TripReportRow

router = APIRouter(prefix="/api/reports", tags=["reports"])


async def _get_accessible_devices(session, user: User) -> List[Device]:
    if user.is_admin:
        result = await session.execute(select(Device).where(Device.is_active == True))
        return result.scalars().all()
    if user.is_company_admin and user.company_id:
        result = await session.execute(
            select(Device).where(Device.company_id == user.company_id, Device.is_active == True)
        )
        return result.scalars().all()
    result = await session.execute(
        select(Device)
        .join(user_device_association, user_device_association.c.device_id == Device.id)
        .where(user_device_association.c.user_id == user.id, Device.is_active == True)
    )
    return result.scalars().all()


@router.get("/fleet", response_model=FleetReport)
async def fleet_report(
    start_date: datetime = Query(...),
    end_date: datetime   = Query(...),
    device_ids: Optional[str] = Query(None, description="Comma-separated device IDs; omit for all"),
    current_user: User = Depends(require_permission("view_reports")),
):
    db = get_db()
    async with db.get_session() as session:
        devices = await _get_accessible_devices(session, current_user)
        if device_ids:
            ids = {int(x) for x in device_ids.split(",") if x.strip().isdigit()}
            devices = [d for d in devices if d.id in ids]

        # Load current driver for each device in one query
        device_ids = [d.id for d in devices]
        state_result = await session.execute(
            select(DeviceState)
            .where(DeviceState.device_id.in_(device_ids))
            .options(selectinload(DeviceState.current_driver))
        )
        state_map = {s.device_id: s for s in state_result.scalars().all()}

        rows: List[FleetReportRow] = []
        for device in sorted(devices, key=lambda d: d.name):
            result = await session.execute(
                select(
                    func.count(Trip.id).label("trips"),
                    func.coalesce(func.sum(Trip.distance_km), 0).label("distance_km"),
                    func.coalesce(func.sum(Trip.duration_minutes), 0).label("driving_minutes"),
                    func.coalesce(func.max(Trip.max_speed), 0).label("max_speed"),
                    func.coalesce(func.avg(Trip.avg_speed), 0).label("avg_speed"),
                ).where(
                    Trip.device_id == device.id,
                    Trip.start_time >= start_date,
                    Trip.start_time <= end_date,
                    Trip.end_time.isnot(None),
                )
            )
            row = result.one()
            state = state_map.get(device.id)
            driver_name = state.current_driver.name if state and state.current_driver else None
            rows.append(FleetReportRow(
                device_id=device.id,
                device_name=device.name,
                license_plate=device.license_plate,
                driver_name=driver_name,
                trips=row.trips,
                distance_km=round(row.distance_km, 2),
                driving_minutes=round(row.driving_minutes, 1),
                max_speed=round(row.max_speed, 1),
                avg_speed=round(row.avg_speed, 1),
            ))

        return FleetReport(start_date=start_date, end_date=end_date, rows=rows)


@router.get("/fleet/csv")
async def fleet_report_csv(
    start_date: datetime = Query(...),
    end_date: datetime   = Query(...),
    device_ids: Optional[str] = Query(None),
    current_user: User = Depends(require_permission("view_reports")),
):
    report = await fleet_report(start_date, end_date, device_ids, current_user)

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Device", "Plate", "Driver", "Trips", "Distance (km)", "Driving (min)", "Max Speed (km/h)", "Avg Speed (km/h)"])
    for r in report.rows:
        writer.writerow([r.device_name, r.license_plate or "", r.driver_name or "", r.trips,
                         r.distance_km, r.driving_minutes, r.max_speed, r.avg_speed])

    output.seek(0)
    filename = f"fleet_report_{start_date.date()}_{end_date.date()}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/trips", response_model=List[TripReportRow])
async def trips_report(
    start_date: datetime = Query(...),
    end_date: datetime   = Query(...),
    device_ids: Optional[str] = Query(None),
    current_user: User = Depends(require_permission("view_reports")),
):
    db = get_db()
    async with db.get_session() as session:
        devices = await _get_accessible_devices(session, current_user)
        if device_ids:
            ids = {int(x) for x in device_ids.split(",") if x.strip().isdigit()}
            devices = [d for d in devices if d.id in ids]
        device_map = {d.id: d for d in devices}

        result = await session.execute(
            select(Trip).where(
                Trip.device_id.in_(device_map.keys()),
                Trip.start_time >= start_date,
                Trip.start_time <= end_date,
                Trip.end_time.isnot(None),
            ).order_by(Trip.start_time.desc())
        )
        trips = result.scalars().all()

        driver_ids = {t.driver_id for t in trips if t.driver_id}
        driver_map: dict = {}
        if driver_ids:
            dr = await session.execute(select(Driver).where(Driver.id.in_(driver_ids)))
            driver_map = {d.id: d.name for d in dr.scalars().all()}

        rows = []
        for trip in trips:
            dev = device_map.get(trip.device_id)
            rows.append(TripReportRow(
                device_id=trip.device_id,
                device_name=dev.name if dev else str(trip.device_id),
                license_plate=dev.license_plate if dev else None,
                driver_name=driver_map.get(trip.driver_id) if trip.driver_id else None,
                start_time=trip.start_time.isoformat(),
                end_time=trip.end_time.isoformat() if trip.end_time else None,
                distance_km=round(trip.distance_km, 2),
                duration_minutes=round(trip.duration_minutes, 1),
                avg_speed=round(trip.avg_speed, 1),
                max_speed=round(trip.max_speed, 1),
                start_address=trip.start_address,
                end_address=trip.end_address,
            ))
        return rows
