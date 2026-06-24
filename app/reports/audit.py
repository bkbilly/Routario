from datetime import datetime
from typing import Any, Optional

from sqlalchemy import desc, select

from reports.base import Report, ReportDefinition
from reports.common import table_payload


class AuditReport(Report):
    definition = ReportDefinition(
        key="audit",
        label="Audit",
        description="System audit log for super admins.",
        needs_date_range=True,
        supports_vehicle_filter=False,
        supports_user_filter=False,
        super_admin_required=True,
        schedule_supported=False,
        schedule_uses_device_filter=False,
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
        from models import AuditLog, Company, User

        actor = User.__table__.alias("actor_user")
        company = Company.__table__.alias("audit_company")
        result = await session.execute(
            select(AuditLog, actor.c.username, company.c.name)
            .outerjoin(actor, AuditLog.actor_user_id == actor.c.id)
            .outerjoin(company, AuditLog.company_id == company.c.id)
            .where(AuditLog.created_at >= start_date, AuditLog.created_at <= end_date)
            .order_by(desc(AuditLog.created_at))
            .limit(1000)
        )

        rows = []
        for log, actor_username, company_name in result.all():
            metadata = log.metadata_json or {}
            rows.append({
                "created_at": log.created_at.isoformat() if log.created_at else None,
                "action": log.action,
                "actor": actor_username or "system",
                "actor_user_id": log.actor_user_id,
                "company": company_name or "-",
                "company_id": log.company_id,
                "target": " ".join(str(v) for v in [log.target_type, log.target_id] if v) or "-",
                "target_type": log.target_type,
                "target_id": log.target_id,
                "ip_address": log.ip_address,
                "user_agent": log.user_agent,
                "metadata": metadata,
                "metadata_text": ", ".join(f"{k}: {v}" for k, v in metadata.items()) if isinstance(metadata, dict) else str(metadata),
            })

        return table_payload(
            self.definition.key,
            rows,
            [
                {"key": "created_at", "label": "Time", "type": "datetime"},
                {"key": "action", "label": "Action", "type": "text"},
                {"key": "actor", "label": "User", "type": "text", "detail_key": "actor_user_id", "detail_type": "integer"},
                {"key": "company", "label": "Company", "type": "text", "detail_key": "company_id", "detail_type": "integer"},
                {"key": "target", "label": "Target", "type": "text"},
                {"key": "ip_address", "label": "IP", "type": "text", "empty": "-"},
                {"key": "metadata_text", "label": "Metadata", "type": "text", "max_width": 320, "empty": "-"},
                {"key": "user_agent", "label": "User Agent", "type": "text", "hidden": True},
                {"key": "target_type", "label": "Target Type", "type": "text", "hidden": True},
                {"key": "target_id", "label": "Target ID", "type": "text", "hidden": True},
                {"key": "metadata", "label": "Metadata JSON", "type": "text", "hidden": True, "csv": False},
            ],
            [
                {"label": "Events", "value": len(rows)},
                {"label": "Users", "value": len({r["actor_user_id"] for r in rows if r["actor_user_id"]})},
                {"label": "Companies", "value": len({r["company_id"] for r in rows if r["company_id"]})},
                {"label": "Actions", "value": len({r["action"] for r in rows})},
            ],
            start_date,
            end_date,
            default_sort={"key": "created_at", "dir": -1},
            csv_filename=f"audit_report_{start_date.date()}_{end_date.date()}.csv",
        )


report = AuditReport()
