"""
Report base classes and metadata definitions.
"""
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Awaitable, Callable, Optional


@dataclass(frozen=True)
class ReportDefinition:
    key: str
    label: str
    description: str
    renderer: str = "table"
    needs_date_range: bool = True
    supports_vehicle_filter: bool = True
    supports_user_filter: bool = False
    supports_driver_filter: bool = False
    supports_historical_toggle: bool = False
    company_admin_required: bool = False
    schedule_supported: bool = True
    schedule_uses_device_filter: bool = True
    schedule_uses_user_filter: bool = False
    controls: tuple[dict[str, Any], ...] = ()

    def public(self, user: Any) -> Optional[dict[str, Any]]:
        if self.company_admin_required and not (user.is_admin or user.is_company_admin):
            return None
        return {
            "key": self.key,
            "label": self.label,
            "description": self.description,
            "renderer": self.renderer,
            "needs_date_range": self.needs_date_range,
            "supports_vehicle_filter": self.supports_vehicle_filter,
            "supports_user_filter": self.supports_user_filter,
            "supports_driver_filter": self.supports_driver_filter,
            "supports_historical_toggle": self.supports_historical_toggle,
            "company_admin_required": self.company_admin_required,
            "schedule_supported": self.schedule_supported,
            "schedule_uses_device_filter": self.schedule_uses_device_filter,
            "schedule_uses_user_filter": self.schedule_uses_user_filter,
            "controls": list(self.controls),
        }


ReportRunner = Callable[..., Awaitable[dict[str, Any]]]


class Report:
    definition: ReportDefinition

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
    ) -> dict[str, Any]:
        raise NotImplementedError
