from typing import List, TYPE_CHECKING

if TYPE_CHECKING:
    from models import User

ALL_PERMISSIONS: List[str] = [
    "view_devices",
    "edit_devices",
    "manage_alerts",
    "send_commands",
    "manage_integrations",
    "view_history",
    "view_reports",
    "manage_drivers",
    "manage_fuel",
    "manage_maintenance",
    "manage_logbook",
    "manage_geofences",
    "voice_ptt",
    "live_share",
    "view_management",
    "manage_users",
]

PERMISSION_GROUPS = [
    {
        "label": "Devices",
        "perms": [
            ("view_devices",        "View Devices"),
            ("edit_devices",        "Edit Devices"),
            ("manage_alerts",       "Manage Alerts"),
            ("send_commands",       "Send Commands"),
            ("manage_integrations", "Manage Integrations"),
        ],
    },
    {
        "label": "History & Reports",
        "perms": [
            ("view_history",  "View History"),
            ("view_reports",  "View Reports"),
        ],
    },
    {
        "label": "Fleet Operations",
        "perms": [
            ("manage_drivers",     "Manage Drivers"),
            ("manage_fuel",        "Manage Fuel"),
            ("manage_maintenance", "Manage Maintenance"),
            ("manage_logbook",     "Manage Logbook"),
        ],
    },
    {
        "label": "Zones",
        "perms": [
            ("manage_geofences", "Manage Geofences"),
        ],
    },
    {
        "label": "Communication & Sharing",
        "perms": [
            ("voice_ptt",  "Voice PTT"),
            ("live_share", "Live Share"),
        ],
    },
    {
        "label": "Administration",
        "perms": [
            ("view_management", "View Management"),
            ("manage_users",    "Manage Users"),
        ],
    },
]


def user_has_permission(user: "User", perm: str) -> bool:
    if user.is_admin:
        return True
    return perm in (user.permissions or [])


def cap_permissions(requested: List[str], caller: "User") -> List[str]:
    """Return only permissions the caller is allowed to grant."""
    if caller.is_admin:
        return [p for p in requested if p in ALL_PERMISSIONS]
    caller_perms = set(caller.permissions or [])
    return [p for p in requested if p in caller_perms]
