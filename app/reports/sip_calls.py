"""
SIP / VoIP Calls Report
Provides insights and audit logs for outbound voice alarm and test calls made via SIP.
"""
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import desc, select

from reports.base import Report, ReportDefinition
from reports.common import normalize_utc, table_payload


def _format_duration_human(sec: float) -> str:
    total_sec = round(max(0.0, float(sec or 0.0)))
    if total_sec < 60:
        return f"{total_sec}s"
    m = total_sec // 60
    s = total_sec % 60
    if m < 60:
        return f"{m}m {s}s"
    h = m // 60
    return f"{h}h {m % 60}m {s}s"


class SipCallsReport(Report):
    definition = ReportDefinition(
        key="sip_calls",
        label="SIP Calls",
        description="Outbound VoIP and SIP voice call history, call duration, status, and destination extensions.",
        renderer="table",
        needs_date_range=True,
        supports_vehicle_filter=False,
        supports_user_filter=True,
        schedule_supported=True,
        schedule_uses_device_filter=False,
        schedule_uses_user_filter=True,
    )

    async def run(
        self,
        session,
        current_user: Any,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        device_ids: Optional[list[int]] = None,
        user_ids: Optional[list[int]] = None,
        driver_ids: Optional[list[int]] = None,
        options: Optional[dict[str, Any]] = None,
        historical: bool = False,
    ) -> dict:
        from models import Company, SipCallLog, User

        start_date = normalize_utc(start_date)
        end_date = normalize_utc(end_date)

        actor_user = User.__table__.alias("call_user")
        comp = Company.__table__.alias("call_company")

        query = (
            select(SipCallLog, actor_user.c.username, comp.c.name.label("company_name"))
            .outerjoin(actor_user, SipCallLog.user_id == actor_user.c.id)
            .outerjoin(comp, SipCallLog.company_id == comp.c.id)
        )

        if start_date:
            query = query.where(SipCallLog.created_at >= start_date)
        if end_date:
            query = query.where(SipCallLog.created_at <= end_date)

        # Multi-tenancy access control
        requested_user_ids = user_ids or []
        if current_user.is_admin:
            if requested_user_ids:
                query = query.where(SipCallLog.user_id.in_(requested_user_ids))
        elif current_user.is_company_admin and current_user.company_id:
            query = query.where(SipCallLog.company_id == current_user.company_id)
            if requested_user_ids:
                query = query.where(SipCallLog.user_id.in_(requested_user_ids))
        else:
            query = query.where(SipCallLog.user_id == current_user.id)

        query = query.order_by(desc(SipCallLog.created_at)).limit(2000)
        result = await session.execute(query)

        rows = []
        total_duration = 0.0
        answered_count = 0
        failed_count = 0

        for log, username, company_name in result.all():
            duration = log.duration_seconds or 0.0
            ring_duration = log.ring_duration_seconds or 0.0
            status = (log.status or "completed").strip().lower()

            is_answered = status in ("completed", "answered")
            if is_answered:
                answered_count += 1
                total_duration += duration
            else:
                failed_count += 1

            rows.append({
                "id": log.id,
                "created_at": log.created_at.isoformat() if log.created_at else None,
                "recipient": log.recipient or "-",
                "caller": log.caller or "-",
                "status": status,
                "status_error": log.error_message,
                "duration_seconds": round(duration, 1),
                "ring_duration_seconds": round(ring_duration, 1),
                "server": log.server or "-",
                "message": log.message or "-",
                "user": username or "-",
                "user_id": log.user_id,
                "company": company_name or "-",
                "company_id": log.company_id,
                "error_message": log.error_message or "",
            })

        avg_duration = (total_duration / answered_count) if answered_count > 0 else 0.0

        columns = [
            {"key": "created_at", "label": "Date / Time", "type": "datetime"},
            {"key": "recipient", "label": "Recipient", "type": "text"},
            {"key": "caller", "label": "Caller", "type": "text"},
            {"key": "status", "label": "Status", "type": "status"},
            {"key": "duration_seconds", "label": "Call Duration", "type": "duration_seconds"},
            {"key": "ring_duration_seconds", "label": "Ring Duration", "type": "duration_seconds"},
            {"key": "server", "label": "SIP Server", "type": "text"},
            {"key": "message", "label": "Message", "type": "text", "max_width": 280},
            {"key": "user", "label": "User", "type": "text", "company_admin_only": True},
            {"key": "company", "label": "Company", "type": "text", "super_admin_only": True},
        ]

        if not current_user.is_admin:
            columns = [c for c in columns if not c.get("super_admin_only")]
        if not (current_user.is_admin or current_user.is_company_admin):
            columns = [c for c in columns if not c.get("company_admin_only")]

        summary = [
            {"label": "Total Calls", "value": len(rows)},
            {"label": "Answered", "value": answered_count, "tone": "success"},
            {
                "label": "Unanswered / Failed",
                "value": failed_count,
                "tone": "danger" if failed_count > 0 else None,
            },
            {"label": "Total Duration", "value": _format_duration_human(total_duration)},
            {
                "label": "Avg Duration",
                "value": f"{round(avg_duration, 1)}s" if avg_duration > 0 else "0s",
            },
        ]

        csv_name = (
            f"sip_calls_{start_date.date()}_{end_date.date()}.csv"
            if start_date and end_date
            else "sip_calls.csv"
        )

        return table_payload(
            self.definition.key,
            rows,
            columns,
            summary,
            start_date,
            end_date,
            default_sort={"key": "created_at", "dir": -1},
            csv_filename=csv_name,
        )


report = SipCallsReport()
