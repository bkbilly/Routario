"""
Background task: execute due report schedules and store results.
"""
import asyncio
import json
import logging
from datetime import datetime, timedelta
from typing import List, Optional, Tuple

from sqlalchemy import delete, select
from sqlalchemy.orm import selectinload

from core.database import get_db
from models.models import (
    AlertHistory,
    Device,
    DeviceState,
    Driver,
    PositionRecord,
    ScheduledReport,
    ScheduledReportRun,
    Trip,
    User,
    user_device_association,
)
from routes.report_schedules import compute_next_run

logger = logging.getLogger(__name__)

_CHECK_INTERVAL = 60  # seconds


# ── Date range helpers ────────────────────────────────────────────────────────

def _date_range(name: str) -> Tuple[datetime, datetime]:
    import calendar
    now   = datetime.utcnow()
    today = now.date()

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
        last_prev  = first_this - timedelta(days=1)
        first_prev = last_prev.replace(day=1)
        return (
            datetime.combine(first_prev, datetime.min.time()),
            datetime.combine(last_prev,  datetime.max.time().replace(microsecond=0)),
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

    # fallback: last 30 days
    return (
        datetime.combine(today - timedelta(days=30), datetime.min.time()),
        datetime.combine(today, datetime.max.time().replace(microsecond=0)),
    )


# ── Device access ─────────────────────────────────────────────────────────────

async def _accessible_devices(session, user: User) -> List[Device]:
    if user.is_admin:
        r = await session.execute(select(Device).where(Device.is_active == True))
        return r.scalars().all()
    if user.is_company_admin and user.company_id:
        r = await session.execute(
            select(Device).where(Device.company_id == user.company_id, Device.is_active == True)
        )
        return r.scalars().all()
    r = await session.execute(
        select(Device)
        .join(user_device_association, user_device_association.c.device_id == Device.id)
        .where(user_device_association.c.user_id == user.id, Device.is_active == True)
    )
    return r.scalars().all()


# ── Report generators ─────────────────────────────────────────────────────────

async def _run_report(session, schedule: ScheduledReport, user: User) -> dict:
    rtype = schedule.report_type

    all_devices = await _accessible_devices(session, user)
    filter_ids  = set(schedule.filter_device_ids or [])
    devices     = [d for d in all_devices if not filter_ids or d.id in filter_ids]
    device_map  = {d.id: d for d in devices}
    device_ids  = list(device_map)

    # ── Sensors ──────────────────────────────────────────────────────────────
    if rtype == "sensors":
        if not schedule.sensors_historical:
            states_r = await session.execute(
                select(DeviceState)
                .where(DeviceState.device_id.in_(device_ids))
                .options(selectinload(DeviceState.current_driver))
            )
            state_map = {s.device_id: s for s in states_r.scalars().all()}
            rows = []
            for d in sorted(devices, key=lambda x: x.name):
                s = state_map.get(d.id)
                rows.append({
                    "id":            d.id,
                    "name":          d.name,
                    "license_plate": d.license_plate,
                    "state": {
                        "ignition_on":          s.ignition_on if s else None,
                        "last_speed":           s.last_speed if s else None,
                        "last_altitude":        s.last_altitude if s else None,
                        "sensors":              s.sensors if s else {},
                        "current_driver_name":  s.current_driver.name if (s and s.current_driver) else None,
                        "last_update":          s.last_update.isoformat() if (s and s.last_update) else None,
                    },
                })
            return {"type": "sensors", "historical": False, "rows": rows}

        start, end = _date_range(schedule.date_range)
        rows = []
        for d in sorted(devices, key=lambda x: x.name):
            pos_r = await session.execute(
                select(PositionRecord)
                .where(
                    PositionRecord.device_id == d.id,
                    PositionRecord.device_time >= start,
                    PositionRecord.device_time <= end,
                )
                .order_by(PositionRecord.device_time.desc())
                .limit(5000)
            )
            for p in pos_r.scalars().all():
                rows.append({
                    "_device":  {"id": d.id, "name": d.name},
                    "time":     p.device_time.isoformat(),
                    "speed":    p.speed,
                    "altitude": p.altitude,
                    "ignition": p.ignition,
                    "sensors":  p.sensors or {},
                })
        return {
            "type":       "sensors",
            "historical": True,
            "start_date": start.isoformat(),
            "end_date":   end.isoformat(),
            "rows":       rows,
        }

    # ── Alerts ────────────────────────────────────────────────────────────────
    if rtype == "alerts":
        start, end = _date_range(schedule.date_range)
        filter_user_ids = schedule.filter_user_ids or []

        if user.is_admin:
            eff_user_ids = filter_user_ids
        elif user.is_company_admin:
            cu = await session.execute(
                select(User.id).where(User.company_id == user.company_id)
            )
            company_ids = [r[0] for r in cu.all()]
            eff_user_ids = [i for i in filter_user_ids if i in company_ids] if filter_user_ids else company_ids
        else:
            eff_user_ids = [user.id]

        query = (
            select(AlertHistory, User.username, Device.name.label("device_name"))
            .join(User,   AlertHistory.user_id   == User.id)
            .outerjoin(Device, AlertHistory.device_id == Device.id)
            .where(AlertHistory.created_at >= start, AlertHistory.created_at <= end)
        )
        if eff_user_ids:
            query = query.where(AlertHistory.user_id.in_(eff_user_ids))
        if filter_ids:
            query = query.where(AlertHistory.device_id.in_(device_ids))

        result = await session.execute(
            query.order_by(AlertHistory.created_at.desc()).limit(2000)
        )
        rows = [
            {
                "id":          a.id,
                "created_at":  a.created_at.isoformat(),
                "alert_type":  a.alert_type,
                "severity":    a.severity,
                "message":     a.message,
                "is_read":     a.is_read,
                "username":    username,
                "device_name": device_name,
            }
            for a, username, device_name in result.all()
        ]
        return {"type": "alerts", "start_date": start.isoformat(), "end_date": end.isoformat(), "rows": rows}

    # ── Trip-based reports (summary / trips / daily / drivers) ────────────────
    start, end = _date_range(schedule.date_range)
    trips_r = await session.execute(
        select(Trip).where(
            Trip.device_id.in_(device_ids),
            Trip.start_time >= start,
            Trip.start_time <= end,
            Trip.end_time.isnot(None),
        ).order_by(Trip.start_time.desc())
    )
    trips = trips_r.scalars().all()

    driver_ids = {t.driver_id for t in trips if t.driver_id}
    driver_map: dict = {}
    if driver_ids:
        dr = await session.execute(select(Driver).where(Driver.id.in_(driver_ids)))
        driver_map = {d.id: d.name for d in dr.scalars().all()}

    trip_rows = [
        {
            "device_id":        t.device_id,
            "device_name":      device_map[t.device_id].name if t.device_id in device_map else str(t.device_id),
            "license_plate":    device_map[t.device_id].license_plate if t.device_id in device_map else None,
            "driver_name":      driver_map.get(t.driver_id) if t.driver_id else None,
            "start_time":       t.start_time.isoformat(),
            "end_time":         t.end_time.isoformat() if t.end_time else None,
            "distance_km":      round(t.distance_km, 2),
            "duration_minutes": round(t.duration_minutes, 1),
            "avg_speed":        round(t.avg_speed, 1),
            "max_speed":        round(t.max_speed, 1),
            "start_address":    t.start_address,
            "end_address":      t.end_address,
        }
        for t in trips
    ]

    if rtype == "summary":
        by_dev: dict = {}
        for r in trip_rows:
            did = r["device_id"]
            if did not in by_dev:
                by_dev[did] = {
                    "device_id":        did,
                    "device_name":      r["device_name"],
                    "license_plate":    r["license_plate"],
                    "driver_name":      r["driver_name"],
                    "trips":            0,
                    "distance_km":      0.0,
                    "driving_minutes":  0.0,
                    "max_speed":        0.0,
                    "_sum_avg":         0.0,
                }
            by_dev[did]["trips"]           += 1
            by_dev[did]["distance_km"]     += r["distance_km"]
            by_dev[did]["driving_minutes"] += r["duration_minutes"]
            by_dev[did]["max_speed"]        = max(by_dev[did]["max_speed"], r["max_speed"])
            by_dev[did]["_sum_avg"]        += r["avg_speed"]

        rows = []
        for d in by_dev.values():
            d["avg_speed"]       = round(d["_sum_avg"] / d["trips"], 1) if d["trips"] else 0.0
            d["distance_km"]     = round(d["distance_km"], 2)
            d["driving_minutes"] = round(d["driving_minutes"], 1)
            d["max_speed"]       = round(d["max_speed"], 1)
            del d["_sum_avg"]
            rows.append(d)

        return {"type": "summary", "start_date": start.isoformat(), "end_date": end.isoformat(), "rows": rows}

    # trips / daily / drivers all store raw trip rows; frontend differentiates
    return {"type": rtype, "start_date": start.isoformat(), "end_date": end.isoformat(), "rows": trip_rows}


# ── Execute one schedule ──────────────────────────────────────────────────────

async def _execute(schedule_id: int) -> None:
    db = get_db()
    async with db.get_session() as session:
        # Re-fetch within this session so updates are tracked and committed
        sched_r = await session.execute(select(ScheduledReport).where(ScheduledReport.id == schedule_id))
        sched   = sched_r.scalar_one_or_none()
        if not sched:
            return

        user_r = await session.execute(select(User).where(User.id == sched.user_id))
        user   = user_r.scalar_one_or_none()
        if not user:
            logger.warning("Schedule %s: owner %s missing", sched.id, sched.user_id)
            return

        try:
            data        = await _run_report(session, sched, user)
            result_json = json.dumps(data, default=str)
            status      = "success"
            error_msg   = None
        except Exception as exc:
            logger.error("Schedule %s run failed: %s", sched.id, exc, exc_info=True)
            result_json = None
            status      = "failed"
            error_msg   = str(exc)

        run = ScheduledReportRun(
            schedule_id=sched.id,
            run_at=datetime.utcnow(),
            status=status,
            error_message=error_msg,
            result_json=result_json,
        )
        session.add(run)
        await session.flush()

        # Prune runs exceeding keep_runs
        all_ids_r = await session.execute(
            select(ScheduledReportRun.id)
            .where(ScheduledReportRun.schedule_id == sched.id)
            .order_by(ScheduledReportRun.run_at.desc())
        )
        all_ids = [r[0] for r in all_ids_r.all()]
        if len(all_ids) > sched.keep_runs:
            await session.execute(
                delete(ScheduledReportRun).where(
                    ScheduledReportRun.id.in_(all_ids[sched.keep_runs:])
                )
            )

        sched.last_run = datetime.utcnow()
        sched.next_run = compute_next_run(
            sched.frequency, sched.run_time, sched.day_of_week, sched.day_of_month,
            sched.user_timezone or user.timezone or "UTC",
        )
        await session.commit()
        logger.info("Schedule %s (%s): %s", sched.id, sched.name, status)


# ── Periodic task ─────────────────────────────────────────────────────────────

async def periodic_schedule_task() -> None:
    logger.info("Schedule runner started")
    while True:
        try:
            now = datetime.utcnow()
            db  = get_db()
            async with db.get_session() as session:
                due_r = await session.execute(
                    select(ScheduledReport).where(
                        ScheduledReport.is_active == True,
                        ScheduledReport.next_run  <= now,
                    )
                )
                due = due_r.scalars().all()

            for schedule in due:
                await _execute(schedule.id)

        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.error("Schedule runner error: %s", exc, exc_info=True)

        await asyncio.sleep(_CHECK_INTERVAL)

    logger.info("Schedule runner stopped")
