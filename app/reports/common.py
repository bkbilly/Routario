"""
Shared report helpers.
"""
from datetime import datetime, timedelta
from typing import Any, Optional, Tuple

from sqlalchemy import select


KEY_USER_PERMISSIONS = [
    "view_devices",
    "view_history",
    "view_reports",
    "manage_alerts",
    "manage_drivers",
    "send_commands",
    "voice_ptt",
    "live_share",
]


def table_payload(
    report_type: str,
    rows: list[dict],
    columns: list[dict],
    summary: Optional[list[dict]] = None,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    default_sort: Optional[dict] = None,
    csv_filename: Optional[str] = None,
    row_action: Optional[dict] = None,
    total_row: Optional[dict] = None,
    historical: Optional[bool] = None,
) -> dict[str, Any]:
    payload = {
        "type": report_type,
        "start_date": start_date.isoformat() if start_date else None,
        "end_date": end_date.isoformat() if end_date else None,
        "columns": columns,
        "summary": summary or [],
        "rows": rows,
        "default_sort": default_sort or {},
        "csv_filename": csv_filename or f"{report_type}.csv",
    }
    if row_action:
        payload["row_action"] = row_action
    if total_row:
        payload["total_row"] = total_row
    if historical is not None:
        payload["historical"] = historical
    return payload


def round_value(value: Any, digits: int = 1) -> float:
    return round(float(value or 0), digits)


def parse_id_csv(value: Optional[str]) -> list[int]:
    if not value:
        return []
    return [int(x) for x in value.split(",") if x.strip().isdigit()]


async def accessible_devices(session, user: Any) -> list[Any]:
    from models import Device, user_device_association

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


async def filtered_device_map(session, user: Any, device_ids: Optional[list[int]] = None) -> dict[int, Any]:
    devices = await accessible_devices(session, user)
    filter_ids = set(device_ids or [])
    if filter_ids:
        devices = [d for d in devices if d.id in filter_ids]
    return {d.id: d for d in devices}


async def trip_rows(
    session,
    user: User,
    start_date: datetime,
    end_date: datetime,
    device_ids: Optional[list[int]] = None,
) -> list[dict]:
    from models import Driver, Trip

    device_map = await filtered_device_map(session, user, device_ids)
    if not device_map:
        return []

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
    driver_map: dict[int, Driver] = {}
    if driver_ids:
        dr = await session.execute(select(Driver).where(Driver.id.in_(driver_ids)))
        driver_map = {d.id: d for d in dr.scalars().all()}

    rows = []
    for trip in trips:
        dev = device_map.get(trip.device_id)
        driver = driver_map.get(trip.driver_id) if trip.driver_id else None
        rows.append({
            "device_id": trip.device_id,
            "device_name": dev.name if dev else str(trip.device_id),
            "license_plate": dev.license_plate if dev else None,
            "driver_id": trip.driver_id,
            "driver_user_id": driver.user_id if driver else None,
            "driver_name": driver.name if driver else None,
            "start_time": trip.start_time.isoformat(),
            "end_time": trip.end_time.isoformat() if trip.end_time else None,
            "distance_km": round(trip.distance_km, 2),
            "duration_minutes": round(trip.duration_minutes, 1),
            "avg_speed": round(trip.avg_speed, 1),
            "max_speed": round(trip.max_speed, 1),
            "start_address": trip.start_address,
            "end_address": trip.end_address,
        })
    return rows


def date_range(name: str) -> Tuple[datetime, datetime]:
    import calendar
    now = datetime.utcnow()
    today = now.date()

    if name == "last_day":
        yesterday = today - timedelta(days=1)
        return (
            datetime.combine(yesterday, datetime.min.time()),
            datetime.combine(yesterday, datetime.max.time().replace(microsecond=0)),
        )
    if name == "last_7_days":
        return (
            datetime.combine(today - timedelta(days=7), datetime.min.time()),
            datetime.combine(today, datetime.max.time().replace(microsecond=0)),
        )
    if name == "last_14_days":
        return (
            datetime.combine(today - timedelta(days=14), datetime.min.time()),
            datetime.combine(today, datetime.max.time().replace(microsecond=0)),
        )
    if name == "last_30_days":
        return (
            datetime.combine(today - timedelta(days=30), datetime.min.time()),
            datetime.combine(today, datetime.max.time().replace(microsecond=0)),
        )
    if name == "last_calendar_month":
        first_this = today.replace(day=1)
        last_prev = first_this - timedelta(days=1)
        first_prev = last_prev.replace(day=1)
        return (
            datetime.combine(first_prev, datetime.min.time()),
            datetime.combine(last_prev, datetime.max.time().replace(microsecond=0)),
        )
    if name == "last_quarter":
        q = (today.month - 1) // 3
        if q == 0:
            sy, sm, ey, em = today.year - 1, 10, today.year - 1, 12
        else:
            sy, sm = today.year, (q - 1) * 3 + 1
            ey, em = today.year, q * 3
        return (
            datetime(sy, sm, 1),
            datetime(ey, em, calendar.monthrange(ey, em)[1], 23, 59, 59),
        )
    if name == "last_year":
        y = today.year - 1
        return datetime(y, 1, 1), datetime(y, 12, 31, 23, 59, 59)

    return (
        datetime.combine(today - timedelta(days=30), datetime.min.time()),
        datetime.combine(today, datetime.max.time().replace(microsecond=0)),
    )
