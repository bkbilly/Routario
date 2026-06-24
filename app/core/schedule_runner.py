"""
Background task: execute due report schedules and store results.
"""
import asyncio
import csv
import html
import json
import logging
import tempfile
from datetime import datetime
from pathlib import Path

from sqlalchemy import delete, select

from core.database import get_db
from core.runtime_health import mark_task_error, mark_task_success
from models.models import (
    ScheduledReport,
    ScheduledReportRun,
    User,
)
from notifications import get_channel
from reports import get_report
from reports.common import date_range
from routes.report_schedules import compute_next_run

logger = logging.getLogger(__name__)

_CHECK_INTERVAL = 60  # seconds

# ── Report generators ─────────────────────────────────────────────────────────

async def _run_report(session, schedule: ScheduledReport, user: User) -> dict:
    report = get_report(schedule.report_type)
    if not report:
        raise ValueError(f"Unknown report type: {schedule.report_type}")
    if report.definition.super_admin_required and not user.is_admin:
        raise PermissionError(f"Report type requires super admin: {schedule.report_type}")
    if report.definition.company_admin_required and not (user.is_admin or user.is_company_admin):
        raise PermissionError(f"Report type requires company admin: {schedule.report_type}")

    start = end = None
    if report.definition.needs_date_range or schedule.sensors_historical:
        start, end = date_range(schedule.date_range)

    return await report.run(
        session=session,
        current_user=user,
        start_date=start,
        end_date=end,
        device_ids=schedule.filter_device_ids or [],
        user_ids=schedule.filter_user_ids or [],
        options=schedule.report_options or {},
        historical=schedule.sensors_historical,
    )


# ── Execute one schedule ──────────────────────────────────────────────────────

def _plain(value) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return "; ".join(str(v) for v in value)
    return str(value)


def _result_attachments(schedule: ScheduledReport, data: dict) -> tuple[tempfile.TemporaryDirectory | None, list[str]]:
    attachments: list[str] = []
    tempdir = tempfile.TemporaryDirectory(prefix=f"routario_schedule_{schedule.id}_")
    root = Path(tempdir.name)
    columns = [c for c in data.get("columns", []) if not c.get("hidden") and c.get("csv") is not False]
    rows = data.get("rows", [])

    if schedule.attach_results:
        csv_path = root / f"{schedule.name.replace(' ', '_')}_{datetime.utcnow().strftime('%Y%m%d_%H%M')}.csv"
        with csv_path.open("w", newline="", encoding="utf-8") as fh:
            writer = csv.writer(fh)
            writer.writerow([c.get("label") or c.get("key") for c in columns])
            for row in rows:
                writer.writerow([_plain(row.get(c.get("key"))) for c in columns])
        attachments.append(str(csv_path))

        html_path = csv_path.with_suffix(".html")
        summary = "".join(
            f"<li><strong>{html.escape(str(card.get('label', '')))}</strong>: {html.escape(str(card.get('value', '')))}</li>"
            for card in data.get("summary", [])
        )
        table_head = "".join(f"<th>{html.escape(str(c.get('label') or c.get('key')))}</th>" for c in columns)
        table_rows = "".join(
            "<tr>" + "".join(f"<td>{html.escape(_plain(row.get(c.get('key'))))}</td>" for c in columns) + "</tr>"
            for row in rows
        )
        html_path.write_text(
            "<!doctype html><html><head><meta charset='utf-8'><style>"
            "body{font-family:Arial,sans-serif;margin:24px;color:#111827}"
            "table{border-collapse:collapse;width:100%}th,td{border:1px solid #d1d5db;padding:6px 8px;font-size:12px;text-align:left}"
            "th{background:#f3f4f6}</style></head><body>"
            f"<h1>{html.escape(schedule.name)}</h1><p>{html.escape(schedule.report_type)}</p><ul>{summary}</ul>"
            f"<table><thead><tr>{table_head}</tr></thead><tbody>{table_rows}</tbody></table></body></html>",
            encoding="utf-8",
        )
        attachments.append(str(html_path))

    if schedule.attach_documents:
        upload_root = Path("web").resolve()
        seen: set[str] = set()
        for row in rows:
            for url_path in row.get("documents") or []:
                fs_path = (upload_root / str(url_path).lstrip("/")).resolve()
                if str(fs_path).startswith(str(upload_root)) and fs_path.is_file() and str(fs_path) not in seen:
                    seen.add(str(fs_path))
                    attachments.append(str(fs_path))

    if not attachments:
        tempdir.cleanup()
        return None, []
    return tempdir, attachments


async def _send_schedule_notification(schedule: ScheduledReport, user: User, data: dict, status: str, error_msg: str | None) -> None:
    selected = set(schedule.notification_channels or [])
    if not selected:
        return
    channels = [
        c for c in (user.notification_channels or [])
        if c.get("name") in selected and c.get("url")
    ]
    if not channels:
        return

    tempdir, attachments = _result_attachments(schedule, data) if status == "success" else (None, [])
    title = f"Routario scheduled report: {schedule.name}"
    rows = len(data.get("rows", [])) if isinstance(data, dict) else 0
    message = (
        f"Scheduled report '{schedule.name}' completed successfully with {rows} row(s)."
        if status == "success"
        else f"Scheduled report '{schedule.name}' failed: {error_msg or 'Unknown error'}"
    )
    try:
        await asyncio.gather(
            *[
                ch.send(c["url"], title, message, attachments)
                for c in channels
                if (ch := get_channel(c["url"])) is not None
            ],
            return_exceptions=True,
        )
    finally:
        if tempdir:
            tempdir.cleanup()

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

        try:
            await _send_schedule_notification(sched, user, data if status == "success" else {}, status, error_msg)
        except Exception as exc:
            logger.error("Schedule %s notification failed: %s", sched.id, exc, exc_info=True)

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
            mark_task_success("schedule_runner")

        except asyncio.CancelledError:
            break
        except Exception as exc:
            mark_task_error("schedule_runner", exc)
            logger.error("Schedule runner error: %s", exc, exc_info=True)

        await asyncio.sleep(_CHECK_INTERVAL)

    logger.info("Schedule runner stopped")
