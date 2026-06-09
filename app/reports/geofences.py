from datetime import datetime
from typing import Any, Optional

from sqlalchemy import select

from reports.base import Report, ReportDefinition
from reports.common import filtered_device_map, table_payload


class GeofenceActivityReport(Report):
    definition = ReportDefinition(
        key="geofences",
        label="Geofence Activity",
        description="Geofence enter and exit activity by vehicle, geofence, event, and recipient.",
        renderer="geofences",
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
        from models import Device, User
        from models.models import AlertHistory

        device_map = await filtered_device_map(session, current_user, device_ids)
        if not device_map:
            return table_payload(self.definition.key, [], [], [], start_date, end_date)

        query = (
            select(AlertHistory, Device.name.label("device_name"), Device.license_plate, User.username)
            .join(Device, AlertHistory.device_id == Device.id)
            .join(User, AlertHistory.user_id == User.id)
            .where(
                AlertHistory.device_id.in_(device_map.keys()),
                AlertHistory.alert_type.in_(["geofence_enter", "geofence_exit"]),
                AlertHistory.created_at >= start_date,
                AlertHistory.created_at <= end_date,
            )
        )
        if current_user.is_company_admin and current_user.company_id:
            query = query.where(User.company_id == current_user.company_id)
        elif not current_user.is_admin:
            query = query.where(AlertHistory.user_id == current_user.id)
        if user_ids and (current_user.is_admin or current_user.is_company_admin):
            query = query.where(AlertHistory.user_id.in_(user_ids))

        result = await session.execute(query.order_by(AlertHistory.created_at.desc()).limit(5000))

        grouped: dict[tuple, dict] = {}
        for alert, device_name, license_plate, username in result.all():
            meta = alert.alert_metadata or {}
            event = meta.get("event") or ("enter" if alert.alert_type == "geofence_enter" else "exit")
            geofence_name = meta.get("geofence_name") or alert.message.replace("Geofence Entered: ", "").replace("Geofence Exited: ", "")
            key = (
                alert.device_id,
                meta.get("geofence_id") or geofence_name,
                event,
                alert.created_at.replace(microsecond=0) if alert.created_at else None,
            )
            row = grouped.setdefault(key, {
                "created_at": alert.created_at.isoformat() if alert.created_at else None,
                "device_id": alert.device_id,
                "vehicle": device_name,
                "license_plate": license_plate,
                "geofence_id": meta.get("geofence_id"),
                "geofence_name": geofence_name,
                "event": event.title(),
                "severity": alert.severity,
                "message": alert.message,
                "latitude": alert.latitude,
                "longitude": alert.longitude,
                "recipients": set(),
                "notification_count": 0,
            })
            if username:
                row["recipients"].add(username)
            row["notification_count"] += 1

        rows = []
        for row in grouped.values():
            recipients = sorted(row.pop("recipients"))
            row["recipients_text"] = ", ".join(recipients)
            rows.append(row)

        rows.sort(key=lambda r: r["created_at"] or "", reverse=True)
        enters = sum(1 for r in rows if r["event"] == "Enter")
        exits = sum(1 for r in rows if r["event"] == "Exit")

        return table_payload(
            self.definition.key,
            rows,
            [
                {"key": "created_at", "label": "Date / Time", "type": "datetime"},
                {"key": "vehicle", "label": "Vehicle", "type": "text", "detail_key": "license_plate"},
                {"key": "geofence_name", "label": "Geofence", "type": "text"},
                {"key": "event", "label": "Event", "type": "text"},
                {"key": "severity", "label": "Severity", "type": "severity"},
                {"key": "notification_count", "label": "Notifications", "type": "integer", "title_key": "recipients_text"},
                {"key": "latitude", "label": "Latitude", "type": "number", "decimals": 6},
                {"key": "longitude", "label": "Longitude", "type": "number", "decimals": 6},
                {"key": "message", "label": "Message", "type": "text", "max_width": 260},
            ],
            [
                {"label": "Events", "value": len(rows)},
                {"label": "Entries", "value": enters},
                {"label": "Exits", "value": exits},
                {"label": "Geofences", "value": len({r["geofence_name"] for r in rows if r["geofence_name"]})},
                {"label": "Vehicles", "value": len({r["device_id"] for r in rows})},
            ],
            start_date,
            end_date,
            default_sort={"key": "created_at", "dir": -1},
            csv_filename=f"geofence_activity_{start_date.date()}_{end_date.date()}.csv",
        )


report = GeofenceActivityReport()
