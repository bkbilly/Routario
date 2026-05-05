from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional, Any


# ── Field Types ────────────────────────────────────────────────────────────────

@dataclass
class AlertField:
    """
    Declares one configurable parameter for an alert.

    The frontend renders each field automatically based on `field_type`:
      - "number"      → numeric input with min/max/unit
      - "text"        → plain text input
      - "select"      → <select> dropdown; provide `options` as list of {value, label}
      - "multiselect" → checkboxes; provide `options`
      - "checkbox"    → single boolean toggle

    `key`     is how the value is stored in AlertRow.params and read by the module.
    `default` is the value pre-filled when the alert is first added.
    """
    key:        str
    label:      str
    field_type: str   = "number"          # "number" | "select" | "multiselect" | "checkbox"
    default:    Any   = None
    unit:       str   = ""
    min_value:  float = 0
    max_value:  float = 9999
    options:      list        = field(default_factory=list)   # [{value, label}, ...]
    required:     bool        = True
    help_text:    str         = ""
    updates_field: str | None = None   # sibling field key to sync when this select changes
    show_if: dict | None = None        # e.g. {"key": "maintenance_type", "value": "custom"}


# ── Alert Definition ───────────────────────────────────────────────────────────

@dataclass
class AlertDefinition:
    """
    Everything the frontend and backend need to know about an alert type.

    `fields` is a list of AlertField objects. The first field is the "primary"
    threshold shown in the alerts table summary column; additional fields appear
    only in the editor modal.
    """

    # --- Identity ---
    key:        str           # unique config key, e.g. "speed_tolerance"
    alert_type: object        # AlertType enum value

    # --- Frontend UI ---
    label:       str
    description: str
    icon:        str   = "🔔"

    # --- Fields ---
    fields: list = field(default_factory=list)   # List[AlertField]

    # --- Severity ---
    severity: object = "warning"   # Severity enum value

    # --- State keys this module uses in alert_states ---
    state_keys: list = field(default_factory=list)

    # --- If True, hidden from the "Add System Alert" dropdown ---
    hidden: bool = False

    @property
    def primary_field(self) -> Optional[AlertField]:
        """The first field — shown as the threshold badge in the table."""
        return self.fields[0] if self.fields else None

    def default_params(self) -> dict:
        """Returns {key: default} for all fields — used when adding the alert."""
        return {f.key: f.default for f in self.fields}


# ── Base Alert Class ───────────────────────────────────────────────────────────

class BaseAlert(ABC):
    """
    Base class for all alert modules.

    The engine:
      1. Calls definition() to get metadata.
      2. Handles schedule checking — modules do NOT call _is_alert_active().
      3. Calls check_many(), which by default delegates to check().

    Subclasses MUST implement check().
    Override check_many() only when a single position can produce multiple alerts
    (e.g. multiple geofence violations simultaneously).
    """

    @classmethod
    @abstractmethod
    def definition(cls) -> AlertDefinition:
        """Return static metadata for this alert type."""
        ...

    @abstractmethod
    async def check(self, position, device, state, params: dict) -> Optional[dict]:
        """
        Evaluate the alert condition.

        `params` — the AlertRow.params dict for this specific row, containing
        the per-row configured values (e.g. {"speed_limit": 90, "duration_seconds": 30}).

        Returns an alert_data dict to fire the alert, or None.
        Schedule checking is already handled by the engine before this is called.
        """
        ...

    async def check_many(self, position, device, state, params: dict) -> list:
        """Override for alerts that can return multiple events per position."""
        result = await self.check(position, device, state, params)
        return [result] if result else []
