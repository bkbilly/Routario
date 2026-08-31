from typing import List, TYPE_CHECKING

if TYPE_CHECKING:
    from models import User

ALL_PERMISSIONS: List[str] = [
    "view_dashboard",
    "view_devices",
    "edit_devices",
    "send_commands",
    "manage_integrations",
    "manage_alerts",
    "manage_geofences",
    "view_history",
    "view_reports",
    "llm",
    "manage_drivers",
    "manage_sim_cards",
    "manage_fuel",
    "manage_maintenance",
    "manage_logbook",
    "manage_routes",
    "manage_tickets",
    "voice_ptt",
    "live_share",
    "view_management",
    "manage_users",
    "view_audit",
    "view_health",
    "manage_api_keys",
    "manage_webhooks",
    "manage_mfa",
    "manage_backups",
]

PERMISSION_GROUPS = [
    {
        "label": "Dashboard",
        "perms": [
            ("view_dashboard",     "View Dashboard"),
            ("view_history",       "View History"),
            ("manage_geofences",   "Manage Geofences"),
            ("manage_routes",      "Manage Routes"),
            ("manage_logbook",     "Manage Logbook"),
            ("manage_fuel",        "Manage Fuel"),
            ("manage_maintenance", "Manage Maintenance"),
            ("voice_ptt",          "Voice PTT"),
            ("live_share",         "Live Share"),
        ],
    },
    {
        "label": "Device Management",
        "perms": [
            ("view_devices",       "View Devices"),
            ("edit_devices",       "Edit Devices"),
            ("send_commands",      "Send Commands"),
            ("manage_alerts",      "Manage Alerts"),
            ("manage_integrations", "Manage Integrations"),
        ],
    },
    {
        "label": "Management",
        "perms": [
            ("view_management",    "View Management"),
            ("manage_users",       "Manage Users"),
            ("manage_drivers",     "Manage Drivers"),
            ("manage_sim_cards",   "Manage SIM Cards"),
            ("manage_mfa",         "Manage Users' MFA"),
        ],
    },
    {
        "label": "Fleet Reports",
        "perms": [
            ("view_reports",       "View Reports"),
            ("llm",                "AI Copilot & LLM Reports"),
            ("view_health",        "View Health Checks"),
            ("view_audit",         "View Audit Log"),
        ],
    },
    {
        "label": "User Settings",
        "perms": [
            ("manage_api_keys",    "Manage API Keys"),
            ("manage_tickets",     "Manage Tickets"),
            ("manage_webhooks",    "Manage Webhooks"),
            ("manage_backups",     "Backup & Restore"),
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
