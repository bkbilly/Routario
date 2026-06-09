from datetime import datetime
from typing import Any, Optional

from reports.base import Report, ReportDefinition
from reports.common import filtered_device_map, table_payload


class AlertsReport(Report):
    definition = ReportDefinition(
        key="alerts",
        label="Alerts",
        description="Alert history for the selected period. Admins can filter by user.",
        renderer="alerts",
        supports_user_filter=True,
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
        from sqlalchemy import select

        from models import Device, User
        from models.models import AlertHistory

        device_map = await filtered_device_map(session, current_user, device_ids)

        requested_user_ids = user_ids or []
        if current_user.is_admin:
            effective_user_ids = requested_user_ids
        elif current_user.is_company_admin:
            company_result = await session.execute(
                select(User.id).where(User.company_id == current_user.company_id)
            )
            company_ids = [r[0] for r in company_result.all()]
            effective_user_ids = [i for i in requested_user_ids if i in company_ids] if requested_user_ids else company_ids
        else:
            effective_user_ids = [current_user.id]

        query = (
            select(AlertHistory, User.username, Device.name.label("device_name"))
            .join(User, AlertHistory.user_id == User.id)
            .outerjoin(Device, AlertHistory.device_id == Device.id)
            .where(AlertHistory.created_at >= start_date, AlertHistory.created_at <= end_date)
        )
        if effective_user_ids:
            query = query.where(AlertHistory.user_id.in_(effective_user_ids))
        if device_ids:
            query = query.where(AlertHistory.device_id.in_(device_map.keys()))

        result = await session.execute(query.order_by(AlertHistory.created_at.desc()).limit(2000))
        rows = [
            {
                "id": a.id,
                "created_at": a.created_at.isoformat(),
                "alert_type": a.alert_type,
                "severity": a.severity,
                "message": a.message,
                "is_read": a.is_read,
                "username": username,
                "device_name": device_name,
            }
            for a, username, device_name in result.all()
        ]
        unread = sum(1 for r in rows if not r["is_read"])
        critical = sum(1 for r in rows if r["severity"] in {"critical", "high"})
        by_type = {}
        for row in rows:
            by_type[row["alert_type"]] = by_type.get(row["alert_type"], 0) + 1
        top_type = max(by_type.items(), key=lambda item: item[1], default=None)
        columns = [
            {"key": "created_at", "label": "Date / Time", "type": "datetime"},
            {"key": "username", "label": "User", "type": "text", "company_admin_only": True},
            {"key": "device_name", "label": "Vehicle", "type": "text"},
            {"key": "alert_type", "label": "Type", "type": "text"},
            {"key": "severity", "label": "Severity", "type": "severity"},
            {"key": "message", "label": "Message", "type": "text", "max_width": 260},
            {"key": "is_read", "label": "Status", "type": "read_status"},
        ]
        if not (current_user.is_admin or current_user.is_company_admin):
            columns = [c for c in columns if not c.get("company_admin_only")]
        return table_payload(
            self.definition.key,
            rows,
            columns,
            [
                {"label": "Total Alerts", "value": len(rows)},
                {"label": "Unread", "value": unread, "tone": "warning"},
                {"label": "Critical / High", "value": critical, "tone": "danger"},
                *([{"label": f"Most Frequent ({top_type[1]})", "value": top_type[0]}] if top_type else []),
            ],
            start_date,
            end_date,
            default_sort={"key": "created_at", "dir": -1},
            csv_filename=f"alerts_{start_date.date()}_{end_date.date()}.csv",
        )


report = AlertsReport()
