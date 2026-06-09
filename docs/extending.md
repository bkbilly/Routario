# Extending Routario

Routario is designed to be extended without touching core files. Protocols, integrations, alert types, reports, and notification channels are all auto-discovered at startup — add a file, implement the interface, and it appears in the UI on the next restart.

---

## Adding a Protocol Decoder

Protocol decoders live in `app/protocols/`. Each decoder handles one device protocol on its own TCP/UDP port.

1. Create a new file in `app/protocols/`.
2. Subclass `BaseProtocolDecoder` and implement `decode()` and optionally `encode_command()`.
3. Decorate the class with `@ProtocolRegistry.register("your_protocol")`.

Routario starts a TCP/UDP server on the port defined by `PORT` automatically — no changes to `main.py` required.

```python
from . import BaseProtocolDecoder, ProtocolRegistry

@ProtocolRegistry.register("myprotocol")
class MyProtocolDecoder(BaseProtocolDecoder):
    PORT = 5200
    PROTOCOL_TYPES = ['tcp']

    async def decode(self, data, client_info, known_imei=None):
        # Parse the raw bytes and return a NormalizedPosition (or None to discard)
        ...

    async def encode_command(self, command_type, params):
        # Return raw bytes to send to the device, or None if unsupported
        ...
```

---

## Adding a Cloud Integration

Cloud integrations live in `app/integrations/`. Each integration polls a remote API and feeds positions into the same pipeline as native devices.

1. Create a new file in `app/integrations/`.
2. Subclass `BaseIntegration` and implement `authenticate()`, `fetch_positions()`, and optionally `list_remote_devices()`.
3. Decorate with `@IntegrationRegistry.register("provider_id")`.
4. Define `DISPLAY_NAME`, `POLL_INTERVAL_SECONDS`, and the `FIELDS` list — this describes the credential form shown in the UI.

```python
from integrations.base import BaseIntegration, AuthContext, IntegrationField
from integrations.registry import IntegrationRegistry

@IntegrationRegistry.register("myprovider")
class MyProviderIntegration(BaseIntegration):
    PROVIDER_ID              = "myprovider"
    DISPLAY_NAME             = "My Provider"
    POLL_INTERVAL_SECONDS    = 30
    SUPPORTS_BROWSE          = True   # set False to hide the Browse button in the UI

    FIELDS = [
        IntegrationField(key="token", label="API Token",
                         field_type="password", required=True),
        # field_type options: "text" | "password" | "number" | "url"
    ]

    async def authenticate(self, credentials: dict) -> AuthContext:
        ...

    async def fetch_positions(self, auth_ctx, devices):
        ...
```

!!! tip
    Raise `AuthExpiredError` inside `fetch_positions()` when the remote API rejects your session. Routario evicts the cached `AuthContext` and re-authenticates on the next poll cycle automatically.

!!! info "`SUPPORTS_BROWSE = False`"
    Set this on integrations that have no remote device list to query (e.g. the built-in GPS Simulator). It hides the **Browse** button from the credential form so users are not presented with a button that does nothing.

---

## Adding a Report

Reports live in `app/reports/`. Each report module defines both the backend query and the frontend presentation schema.

1. Create a new file in `app/reports/`.
2. Subclass `Report`.
3. Define a `ReportDefinition`.
4. Implement `run()` and return a `table_payload()`.
5. Expose a module-level `report` object.

The report registry discovers modules automatically. The Reports UI reads report metadata from `/api/reports/types`, renders backend-defined controls, and displays the payload returned by `/api/reports/{report_key}`.

```python
from datetime import datetime
from typing import Any, Optional

from reports.base import Report, ReportDefinition
from reports.common import table_payload


class MyReport(Report):
    definition = ReportDefinition(
        key="my_report",
        label="My Report",
        description="Shows useful information.",
        needs_date_range=True,
        supports_vehicle_filter=True,
        controls=(
            {
                "key": "group_by",
                "label": "Group By",
                "type": "select",
                "default": "vehicle",
                "options": [
                    {"value": "vehicle", "label": "Vehicle"},
                    {"value": "driver", "label": "Driver"},
                ],
            },
        ),
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
        rows = [{"name": "Example", "count": 1}]
        return table_payload(
            self.definition.key,
            rows,
            [
                {"key": "name", "label": "Name", "type": "text"},
                {"key": "count", "label": "Count", "type": "integer"},
            ],
            summary=[{"label": "Rows", "value": len(rows)}],
            start_date=start_date,
            end_date=end_date,
            default_sort={"key": "name", "dir": 1},
            csv_filename="my_report.csv",
        )


report = MyReport()
```

### Report column types

The generic frontend renderer supports these common column types:

| Type | Output |
|---|---|
| `text` | Escaped text, arrays joined with commas. |
| `integer` | Whole number. |
| `number` | Decimal number with optional `decimals` and `suffix`. |
| `datetime` | Localized date/time. |
| `datetime_split` | Date and time on separate lines. |
| `duration_minutes` | Minutes formatted as `1h 20m`. |
| `bool_on` | `On` / `Off` display. |
| `bool_active` | `Active` / `Missing` display. |
| `read_status` | `Read` / `Unread` display. |
| `severity` | Colored severity label. |
| `auto` | Generic value rendering, useful for dynamic sensor keys. |

Columns may also define:

- `detail_key` — secondary text shown below the main value.
- `title_key` — tooltip text.
- `max_width` — truncates long text cells.
- `empty` and `empty_tone` — custom empty-state display.
- `tone_if_positive` — color a positive numeric value.
- `csv: false` — omit the column from CSV export.

### Report row actions

Reports may define a generic `row_action`. The built-in supported action is `trip_map`, which makes each row clickable and opens the trip route map using the row's trip fields.

For user-facing report behavior, scheduled reports, and CSV behavior, see [Reports](reports.md).

---

## Adding an Alert Type

Alert types live in `app/alerts/`. Each alert is evaluated against every incoming position for devices that have the alert rule configured.

1. Create a new file in `app/alerts/`.
2. Subclass `BaseAlert` and implement `definition()` and `check()` (or `check_many()` to return multiple alerts per position).

```python
from typing import Optional
from .base import BaseAlert, AlertDefinition, AlertField
from models.schemas import AlertType, Severity

class MyAlert(BaseAlert):

    @classmethod
    def definition(cls) -> AlertDefinition:
        return AlertDefinition(
            key        = "my_alert",
            alert_type = AlertType.CUSTOM,
            label      = "My Alert",
            description= "Fires when something interesting happens.",
            icon       = "⚠️",
            severity   = Severity.WARNING,
            state_keys = ["my_state_key"],   # persistent state fields this alert uses
            fields     = [
                AlertField(
                    key       = "threshold",
                    label     = "Threshold",
                    default   = 100,
                    min_value = 0,
                    max_value = 10000,
                    required  = True,
                    help_text = "Fire the alert when value exceeds this.",
                ),
            ],
        )

    async def check(self, position, device, state, params: dict) -> Optional[dict]:
        threshold = float(params.get("threshold", 100))
        value = position.sensors.get("my_sensor", 0)

        if value > threshold:
            return {
                "type":     AlertType.CUSTOM,
                "severity": Severity.WARNING,
                "message":  f"Value {value} exceeded threshold {threshold}.",
            }
        return None
```

The `state` object provides persistent per-device storage via `state.alert_states` (a dict) — use it to implement debounce, cooldown, or edge-detection logic between position updates.

No registration step is needed — the alert type is discovered automatically and appears in the *Add Alert Rule* dropdown on the next restart.

---

## Adding a Notification Channel

Custom notification channels live in `app/notifications/`. A channel claims URL schemes via `matches()` and delivers the notification in `send()`.

1. Create a new `.py` file in `app/notifications/`.
2. Subclass `BaseNotificationChannel`.
3. Implement `matches(url)` — return `True` if this class should handle the URL.
4. Implement `async send(url, title, message)` — deliver the notification and return `True` on success.

```python
from notifications.base import BaseNotificationChannel

class MyChannel(BaseNotificationChannel):

    @classmethod
    def matches(cls, url: str) -> bool:
        return url.startswith("myscheme://")

    async def send(self, url: str, title: str, message: str) -> bool:
        # Implement delivery logic here
        return True
```

No registration step is needed — the channel is discovered automatically on the next restart.

!!! info
    The built-in `AppriseChannel` is named with a `z_` prefix so it sorts last and only handles URLs that no other channel claimed first. Your custom channel will take priority over Apprise for any scheme it matches.
