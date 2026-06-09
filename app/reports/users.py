from datetime import datetime
from typing import Any, Optional

from reports.base import Report, ReportDefinition
from reports.common import KEY_USER_PERMISSIONS, table_payload


class UserFleetReportModule(Report):
    definition = ReportDefinition(
        key="users",
        label="User Fleet",
        description="Account readiness by user — vehicle access, push status, notification channels, alert backlog, schedules, and key permissions.",
        renderer="users",
        supports_vehicle_filter=False,
        supports_user_filter=True,
        company_admin_required=True,
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
        from sqlalchemy import case, func, select
        from sqlalchemy.orm import selectinload

        from core.push_notifications import PushSubscription
        from models import Company, User
        from models.models import AlertHistory, ScheduledReport

        q = select(User).options(selectinload(User.devices), selectinload(User.company))
        if not current_user.is_admin:
            q = q.where(User.company_id == current_user.company_id)
        if user_ids:
            q = q.where(User.id.in_(user_ids))

        users = sorted((await session.execute(q)).scalars().all(), key=lambda u: u.username.lower())
        ids = [u.id for u in users]

        push_map = {}
        alert_map = {}
        schedule_map = {}
        company_map = {}

        if ids:
            push_result = await session.execute(select(PushSubscription).where(PushSubscription.user_id.in_(ids)))
            push_map = {p.user_id: p for p in push_result.scalars().all()}

            alert_result = await session.execute(
                select(
                    AlertHistory.user_id,
                    func.count(AlertHistory.id).label("total_alerts"),
                    func.coalesce(func.sum(case((AlertHistory.is_read == False, 1), else_=0)), 0).label("unread_alerts"),
                    func.coalesce(func.sum(case((AlertHistory.severity.in_(["critical", "high"]), 1), else_=0)), 0).label("critical_alerts"),
                )
                .where(
                    AlertHistory.user_id.in_(ids),
                    AlertHistory.created_at >= start_date,
                    AlertHistory.created_at <= end_date,
                )
                .group_by(AlertHistory.user_id)
            )
            alert_map = {
                row.user_id: {
                    "total_alerts": int(row.total_alerts or 0),
                    "unread_alerts": int(row.unread_alerts or 0),
                    "critical_alerts": int(row.critical_alerts or 0),
                }
                for row in alert_result.all()
            }

            sched_result = await session.execute(
                select(ScheduledReport.user_id, func.count(ScheduledReport.id).label("active_scheduled_reports"))
                .where(ScheduledReport.user_id.in_(ids), ScheduledReport.is_active == True)
                .group_by(ScheduledReport.user_id)
            )
            schedule_map = {row.user_id: int(row.active_scheduled_reports or 0) for row in sched_result.all()}

        if current_user.is_admin:
            company_result = await session.execute(select(Company))
            company_map = {c.id: c.name for c in company_result.scalars().all()}

        rows = []
        for user in users:
            channels = user.notification_channels or []
            if isinstance(channels, dict):
                channels = []
            webhooks = user.webhook_urls or []
            permissions = user.permissions or []
            if user.is_admin:
                role = "Admin"
            elif user.is_company_admin:
                role = "Company Admin"
            else:
                role = "User"

            alerts = alert_map.get(user.id, {})
            push = push_map.get(user.id)
            assigned_device_names = sorted([d.name for d in (user.devices or [])])
            notification_channel_names = [c.get("name", "") for c in channels if isinstance(c, dict) and c.get("name")]
            key_permissions = [p for p in KEY_USER_PERMISSIONS if user.is_admin or p in permissions]
            rows.append({
                "user_id": user.id,
                "username": user.username,
                "email": user.email,
                "role": role,
                "company_id": user.company_id,
                "company_name": company_map.get(user.company_id) if current_user.is_admin else (user.company.name if user.company else None),
                "assigned_devices": len(user.devices or []),
                "assigned_device_names": assigned_device_names,
                "assigned_device_names_text": ", ".join(assigned_device_names),
                "push_enabled": push is not None,
                "push_updated_at": push.updated_at.isoformat() if push else None,
                "notification_channel_count": len(channels),
                "notification_channel_names": notification_channel_names,
                "notification_channel_names_text": ", ".join(notification_channel_names),
                "webhook_count": len(webhooks),
                "unread_alerts": alerts.get("unread_alerts", 0),
                "total_alerts": alerts.get("total_alerts", 0),
                "critical_alerts": alerts.get("critical_alerts", 0),
                "active_scheduled_reports": schedule_map.get(user.id, 0),
                "permission_count": len(permissions),
                "key_permissions": key_permissions,
                "key_permissions_text": ", ".join(key_permissions),
                "timezone": user.timezone or "UTC",
                "language": user.language or "en",
                "units": user.units or "metric",
                "created_at": user.created_at.isoformat() if user.created_at else None,
                "last_activity": user.last_activity.isoformat() if user.last_activity else None,
            })

        push_enabled = sum(1 for r in rows if r["push_enabled"])
        missing_fallback = sum(1 for r in rows if not r["push_enabled"] and not r["notification_channel_count"] and not r["webhook_count"])
        unread_alerts = sum(r["unread_alerts"] for r in rows)
        inactive = sum(1 for r in rows if not r["last_activity"])
        return table_payload(
            self.definition.key,
            rows,
            [
                {"key": "username", "label": "User", "type": "text", "detail_key": "email"},
                {"key": "role", "label": "Role", "type": "text", "detail_key": "company_name"},
                {"key": "assigned_devices", "label": "Vehicles", "type": "integer", "title_key": "assigned_device_names_text"},
                {"key": "push_enabled", "label": "Push", "type": "bool_active", "detail_key": "push_updated_at"},
                {"key": "notification_channel_count", "label": "Channels", "type": "integer", "title_key": "notification_channel_names_text"},
                {"key": "webhook_count", "label": "Webhooks", "type": "integer"},
                {"key": "unread_alerts", "label": "Unread", "type": "integer", "tone_if_positive": "warning"},
                {"key": "critical_alerts", "label": "Critical", "type": "integer", "tone_if_positive": "danger"},
                {"key": "active_scheduled_reports", "label": "Schedules", "type": "integer"},
                {"key": "last_activity", "label": "Last Activity", "type": "datetime_split", "empty": "Never", "empty_tone": "warning"},
                {"key": "key_permissions_text", "label": "Key Permissions", "type": "text", "max_width": 220},
            ],
            [
                {"label": "Users", "value": len(rows)},
                {"label": "Push Enabled", "value": push_enabled},
                {"label": "No Alert Fallback", "value": missing_fallback, "tone": "danger" if missing_fallback else "success"},
                {"label": "Unread Alerts", "value": unread_alerts},
                {"label": "No Activity", "value": inactive},
            ],
            start_date,
            end_date,
            default_sort={"key": "username", "dir": 1},
            csv_filename=f"user_fleet_{start_date.date()}_{end_date.date()}.csv",
        )


report = UserFleetReportModule()
