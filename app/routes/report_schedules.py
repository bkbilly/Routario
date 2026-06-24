"""
Report Schedule Routes — CRUD for scheduled reports and their run history.
"""
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
try:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
except ImportError:
    from backports.zoneinfo import ZoneInfo, ZoneInfoNotFoundError  # type: ignore

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select, delete

from core.auth import require_permission
from core.database import get_db
from models import User
from models.models import ScheduledReport, ScheduledReportRun
from reports import get_report, valid_report_types

router = APIRouter(prefix="/api/report-schedules", tags=["report-schedules"])

MAX_KEEP_RUNS = 100

_VALID_FREQS      = {"daily", "weekly", "monthly"}
_VALID_RANGES     = {
    "last_day", "last_7_days", "last_14_days", "last_30_days",
    "last_calendar_month", "last_quarter", "last_year",
}


def _get_tz(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name or "UTC")
    except Exception:
        return ZoneInfo("UTC")


def compute_next_run(
    frequency: str,
    run_time: str,
    day_of_week: Optional[int],
    day_of_month: Optional[int],
    tz_name: str = "UTC",
) -> datetime:
    """Return the next run as a naive UTC datetime, computed in the user's timezone."""
    tz = _get_tz(tz_name)
    now = datetime.now(tz)
    h, m = map(int, run_time.split(":"))

    if frequency == "daily":
        candidate = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if candidate <= now:
            candidate += timedelta(days=1)

    elif frequency == "weekly":
        days_ahead = (day_of_week - now.weekday()) % 7
        if days_ahead == 0:
            candidate = now.replace(hour=h, minute=m, second=0, microsecond=0)
            if candidate > now:
                return candidate.astimezone(timezone.utc).replace(tzinfo=None)
            days_ahead = 7
        candidate = (now + timedelta(days=days_ahead)).replace(hour=h, minute=m, second=0, microsecond=0)

    elif frequency == "monthly":
        import calendar
        def _monthly_candidate(year: int, month: int) -> datetime:
            last = calendar.monthrange(year, month)[1]
            return now.replace(year=year, month=month, day=min(day_of_month, last),
                               hour=h, minute=m, second=0, microsecond=0)

        candidate = _monthly_candidate(now.year, now.month)
        if candidate <= now:
            nm = now.month + 1 if now.month < 12 else 1
            ny = now.year if now.month < 12 else now.year + 1
            candidate = _monthly_candidate(ny, nm)

    else:
        candidate = now + timedelta(days=1)

    return candidate.astimezone(timezone.utc).replace(tzinfo=None)


class ScheduleCreate(BaseModel):
    name:               str              = Field(..., min_length=1, max_length=200)
    report_type:        str
    filter_device_ids:  List[int]        = []
    filter_user_ids:    List[int]        = []
    options:            Dict[str, Any]   = Field(default_factory=dict)
    notification_channels: List[str]     = []
    attach_results:     bool             = True
    attach_documents:   bool             = True
    sensors_historical: bool             = False
    date_range:         Optional[str]    = None
    frequency:          str
    run_time:           str
    day_of_week:        Optional[int]    = None
    day_of_month:       Optional[int]    = None
    timezone:           str              = "UTC"
    keep_runs:          int              = Field(10, ge=1, le=MAX_KEEP_RUNS)
    is_active:          bool             = True


class ScheduleUpdate(BaseModel):
    name:               Optional[str]       = None
    report_type:        Optional[str]       = None
    filter_device_ids:  Optional[List[int]] = None
    filter_user_ids:    Optional[List[int]] = None
    options:            Optional[Dict[str, Any]] = None
    notification_channels: Optional[List[str]] = None
    attach_results:     Optional[bool]      = None
    attach_documents:   Optional[bool]      = None
    sensors_historical: Optional[bool]      = None
    date_range:         Optional[str]       = None
    frequency:          Optional[str]       = None
    run_time:           Optional[str]       = None
    day_of_week:        Optional[int]       = None
    day_of_month:       Optional[int]       = None
    timezone:           Optional[str]       = None
    keep_runs:          Optional[int]       = Field(None, ge=1, le=MAX_KEEP_RUNS)
    is_active:          Optional[bool]      = None


def _normalise_options(report, options: Optional[dict]) -> dict:
    values = options or {}
    clean = {}
    controls = report.definition.schedule_controls or report.definition.controls or ()
    for control in controls:
        key = control.get("key")
        if not key:
            continue
        value = values.get(key, control.get("default"))
        if value is None:
            continue
        if control.get("type") == "select":
            allowed = {str(option.get("value")) for option in control.get("options", [])}
            value = str(value)
            if allowed and value not in allowed:
                raise HTTPException(400, f"Invalid option for {key}")
        elif control.get("type") == "number":
            try:
                value = int(value)
            except (TypeError, ValueError):
                raise HTTPException(400, f"Invalid option for {key}")
            if control.get("min") is not None and value < int(control["min"]):
                raise HTTPException(400, f"Invalid option for {key}")
            if control.get("max") is not None and value > int(control["max"]):
                raise HTTPException(400, f"Invalid option for {key}")
        clean[key] = value
    return clean


def _validate(data: ScheduleCreate) -> dict:
    if data.report_type not in valid_report_types():
        raise HTTPException(400, "Invalid report_type")
    report = get_report(data.report_type)
    if report and not report.definition.schedule_supported:
        raise HTTPException(400, "Report type cannot be scheduled")
    if data.frequency not in _VALID_FREQS:
        raise HTTPException(400, "Invalid frequency")
    if data.frequency == "weekly" and data.day_of_week is None:
        raise HTTPException(400, "day_of_week required for weekly frequency")
    if data.frequency == "monthly" and data.day_of_month is None:
        raise HTTPException(400, "day_of_month required for monthly frequency")
    needs_range = (report.definition.needs_date_range if report else True) or data.sensors_historical
    if needs_range:
        if not data.date_range:
            raise HTTPException(400, "date_range required for this report type")
        if data.date_range not in _VALID_RANGES:
            raise HTTPException(400, "Invalid date_range")
    try:
        h, m = map(int, data.run_time.split(":"))
        assert 0 <= h <= 23 and 0 <= m <= 59
    except Exception:
        raise HTTPException(400, "run_time must be HH:MM (24 h)")
    return _normalise_options(report, data.options)


def _utc_iso(dt: Optional[datetime]) -> Optional[str]:
    """Return a UTC ISO 8601 string with Z suffix so browsers parse it correctly."""
    return (dt.isoformat() + "Z") if dt else None


def _to_dict(s: ScheduledReport, run_count: int = 0) -> dict:
    return {
        "id":                 s.id,
        "name":               s.name,
        "report_type":        s.report_type,
        "filter_device_ids":  s.filter_device_ids or [],
        "filter_user_ids":    s.filter_user_ids or [],
        "options":            s.report_options or {},
        "notification_channels": s.notification_channels or [],
        "attach_results":     s.attach_results,
        "attach_documents":   s.attach_documents,
        "sensors_historical": s.sensors_historical,
        "date_range":         s.date_range,
        "frequency":          s.frequency,
        "run_time":           s.run_time,
        "day_of_week":        s.day_of_week,
        "day_of_month":       s.day_of_month,
        "user_timezone":      s.user_timezone,
        "keep_runs":          s.keep_runs,
        "is_active":          s.is_active,
        "next_run":           _utc_iso(s.next_run),
        "last_run":           _utc_iso(s.last_run),
        "created_at":         _utc_iso(s.created_at),
        "run_count":          run_count,
    }


@router.get("")
async def list_schedules(current_user: User = Depends(require_permission("view_reports"))):
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(ScheduledReport)
            .where(ScheduledReport.user_id == current_user.id)
            .order_by(ScheduledReport.created_at.desc())
        )
        schedules = result.scalars().all()

        counts_result = await session.execute(
            select(ScheduledReportRun.schedule_id, func.count(ScheduledReportRun.id))
            .where(ScheduledReportRun.schedule_id.in_([s.id for s in schedules]))
            .group_by(ScheduledReportRun.schedule_id)
        )
        counts = dict(counts_result.all())

        return [_to_dict(s, counts.get(s.id, 0)) for s in schedules]


@router.post("", status_code=201)
async def create_schedule(
    data: ScheduleCreate,
    current_user: User = Depends(require_permission("view_reports")),
):
    options = _validate(data)
    report = get_report(data.report_type)
    if report and report.definition.company_admin_required and not (current_user.is_admin or current_user.is_company_admin):
        raise HTTPException(403, "Company admin access required")
    tz = data.timezone or current_user.timezone or "UTC"
    next_run = compute_next_run(data.frequency, data.run_time, data.day_of_week, data.day_of_month, tz)

    db = get_db()
    async with db.get_session() as session:
        schedule = ScheduledReport(
            user_id=current_user.id,
            name=data.name,
            report_type=data.report_type,
            filter_device_ids=data.filter_device_ids,
            filter_user_ids=data.filter_user_ids,
            report_options=options,
            notification_channels=data.notification_channels,
            attach_results=data.attach_results,
            attach_documents=data.attach_documents,
            sensors_historical=data.sensors_historical,
            date_range=data.date_range,
            frequency=data.frequency,
            run_time=data.run_time,
            day_of_week=data.day_of_week,
            day_of_month=data.day_of_month,
            user_timezone=tz,
            keep_runs=data.keep_runs,
            is_active=data.is_active,
            next_run=next_run,
        )
        session.add(schedule)
        await session.commit()
        await session.refresh(schedule)
        return _to_dict(schedule)


@router.put("/{schedule_id}")
async def update_schedule(
    schedule_id: int,
    data: ScheduleUpdate,
    current_user: User = Depends(require_permission("view_reports")),
):
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(ScheduledReport).where(
                ScheduledReport.id == schedule_id,
                ScheduledReport.user_id == current_user.id,
            )
        )
        schedule = result.scalar_one_or_none()
        if not schedule:
            raise HTTPException(404, "Schedule not found")

        report_type = data.report_type or schedule.report_type
        if report_type not in valid_report_types():
            raise HTTPException(400, "Invalid report_type")
        report = get_report(report_type)
        if report and not report.definition.schedule_supported:
            raise HTTPException(400, "Report type cannot be scheduled")
        if report and report.definition.company_admin_required and not (current_user.is_admin or current_user.is_company_admin):
            raise HTTPException(403, "Company admin access required")

        if data.report_type        is not None:
            schedule.report_type = data.report_type
            if data.options is None:
                schedule.report_options = _normalise_options(report, {})
        if data.name               is not None: schedule.name               = data.name
        if data.filter_device_ids  is not None: schedule.filter_device_ids  = data.filter_device_ids
        if data.filter_user_ids    is not None: schedule.filter_user_ids    = data.filter_user_ids
        if data.options            is not None: schedule.report_options     = _normalise_options(report, data.options)
        if data.notification_channels is not None: schedule.notification_channels = data.notification_channels
        if data.attach_results     is not None: schedule.attach_results     = data.attach_results
        if data.attach_documents   is not None: schedule.attach_documents   = data.attach_documents
        if data.sensors_historical is not None: schedule.sensors_historical = data.sensors_historical
        if data.date_range         is not None: schedule.date_range         = data.date_range
        if data.frequency          is not None: schedule.frequency          = data.frequency
        if data.run_time           is not None: schedule.run_time           = data.run_time
        if data.day_of_week        is not None: schedule.day_of_week        = data.day_of_week
        if data.day_of_month       is not None: schedule.day_of_month       = data.day_of_month
        if data.timezone           is not None: schedule.user_timezone      = data.timezone
        if data.keep_runs          is not None: schedule.keep_runs          = data.keep_runs
        if data.is_active          is not None: schedule.is_active          = data.is_active

        merged = ScheduleCreate(
            name=schedule.name,
            report_type=schedule.report_type,
            filter_device_ids=schedule.filter_device_ids or [],
            filter_user_ids=schedule.filter_user_ids or [],
            options=schedule.report_options or {},
            notification_channels=schedule.notification_channels or [],
            attach_results=schedule.attach_results,
            attach_documents=schedule.attach_documents,
            sensors_historical=schedule.sensors_historical,
            date_range=schedule.date_range,
            frequency=schedule.frequency,
            run_time=schedule.run_time,
            day_of_week=schedule.day_of_week,
            day_of_month=schedule.day_of_month,
            timezone=schedule.user_timezone,
            keep_runs=schedule.keep_runs,
            is_active=schedule.is_active,
        )
        schedule.report_options = _validate(merged)

        timing_changed = any(
            v is not None for v in [data.frequency, data.run_time, data.day_of_week, data.day_of_month, data.timezone]
        )
        if timing_changed:
            schedule.next_run = compute_next_run(
                schedule.frequency, schedule.run_time, schedule.day_of_week, schedule.day_of_month,
                schedule.user_timezone,
            )

        await session.commit()
        await session.refresh(schedule)
        return _to_dict(schedule)


@router.delete("/{schedule_id}", status_code=204)
async def delete_schedule(
    schedule_id: int,
    current_user: User = Depends(require_permission("view_reports")),
):
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(ScheduledReport).where(
                ScheduledReport.id == schedule_id,
                ScheduledReport.user_id == current_user.id,
            )
        )
        schedule = result.scalar_one_or_none()
        if not schedule:
            raise HTTPException(404, "Schedule not found")
        await session.delete(schedule)
        await session.commit()


@router.get("/{schedule_id}/runs")
async def list_runs(
    schedule_id: int,
    current_user: User = Depends(require_permission("view_reports")),
):
    db = get_db()
    async with db.get_session() as session:
        owned = await session.execute(
            select(ScheduledReport).where(
                ScheduledReport.id == schedule_id,
                ScheduledReport.user_id == current_user.id,
            )
        )
        if not owned.scalar_one_or_none():
            raise HTTPException(404, "Schedule not found")

        result = await session.execute(
            select(ScheduledReportRun)
            .where(ScheduledReportRun.schedule_id == schedule_id)
            .order_by(ScheduledReportRun.run_at.desc())
        )
        return [
            {
                "id":            r.id,
                "run_at":        _utc_iso(r.run_at),
                "status":        r.status,
                "error_message": r.error_message,
                "has_data":      r.result_json is not None,
            }
            for r in result.scalars().all()
        ]


@router.get("/{schedule_id}/runs/{run_id}")
async def get_run(
    schedule_id: int,
    run_id: int,
    current_user: User = Depends(require_permission("view_reports")),
):
    db = get_db()
    async with db.get_session() as session:
        owned = await session.execute(
            select(ScheduledReport).where(
                ScheduledReport.id == schedule_id,
                ScheduledReport.user_id == current_user.id,
            )
        )
        schedule = owned.scalar_one_or_none()
        if not schedule:
            raise HTTPException(404, "Schedule not found")

        result = await session.execute(
            select(ScheduledReportRun).where(
                ScheduledReportRun.id == run_id,
                ScheduledReportRun.schedule_id == schedule_id,
            )
        )
        run = result.scalar_one_or_none()
        if not run:
            raise HTTPException(404, "Run not found")

        return {
            "id":             run.id,
            "schedule_name":  schedule.name,
            "report_type":    schedule.report_type,
            "run_at":         run.run_at.isoformat(),
            "status":         run.status,
            "error_message":  run.error_message,
            "data":           json.loads(run.result_json) if run.result_json else None,
        }
