"""
Background task: execute due report schedules and store results.
"""
import asyncio
import json
import logging
from datetime import datetime

from sqlalchemy import delete, select

from core.database import get_db
from core.runtime_health import mark_task_error, mark_task_success
from models.models import (
    ScheduledReport,
    ScheduledReportRun,
    User,
)
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
        historical=schedule.sensors_historical,
    )


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
            mark_task_success("schedule_runner")

        except asyncio.CancelledError:
            break
        except Exception as exc:
            mark_task_error("schedule_runner", exc)
            logger.error("Schedule runner error: %s", exc, exc_info=True)

        await asyncio.sleep(_CHECK_INTERVAL)

    logger.info("Schedule runner stopped")
