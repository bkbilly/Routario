from typing import List, TYPE_CHECKING

if TYPE_CHECKING:
    from models import User

ALL_PERMISSIONS: List[str] = [
    "view_devices",
    "edit_devices",
    "send_commands",
    "manage_integrations",
    "manage_alerts",
    "manage_geofences",
    "view_history",
    "view_reports",
    "manage_drivers",
    "manage_fuel",
    "manage_maintenance",
    "manage_logbook",
    "manage_routes",
    "voice_ptt",
    "live_share",
    "view_management",
    "manage_users",
    "view_audit",
    "view_health",
    "manage_api_keys",
    "manage_mfa",
    "manage_backups",
]

PERMISSION_GROUPS = [
    {
        "label": "Devices & Integrations",
        "perms": [
            ("view_devices",        "View Devices"),
            ("edit_devices",        "Edit Devices"),
            ("send_commands",       "Send Commands"),
            ("manage_integrations", "Manage Integrations"),
        ],
    },
    {
        "label": "Monitoring & Reports",
        "perms": [
            ("manage_alerts",    "Manage Alerts"),
            ("manage_geofences", "Manage Geofences"),
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
            ("manage_routes",      "Manage Routes"),
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
            ("view_audit",      "View Audit Log"),
            ("view_health",     "View Health Checks"),
        ],
    },
    {
        "label": "User Settings",
        "perms": [
            ("manage_api_keys", "Manage API Keys"),
            ("manage_mfa",      "Manage Users' MFA"),
            ("manage_backups",  "Backup & Restore"),
        ],
    },
]


def user_has_permission(user: "User", perm: str) -> bool:
    if user.is_admin:
        return True
    return perm in (user.permissions or [])


def valid_permissions(perms: List[str] | None) -> List[str]:
    """Filter a permission list to currently grantable permissions."""
    if not perms:
        return []
    return [p for p in perms if p in ALL_PERMISSIONS]


def cap_permissions(requested: List[str], caller: "User") -> List[str]:
    """Return only permissions the caller is allowed to grant."""
    if caller.is_admin:
        return valid_permissions(requested)
    caller_perms = set(valid_permissions(caller.permissions or []))
    return [p for p in valid_permissions(requested) if p in caller_perms]
