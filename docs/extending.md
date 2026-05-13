# Extending Routario

Routario is designed to be extended without touching core files. Protocols, integrations, alert types, and notification channels are all auto-discovered at startup — add a file, implement the interface, and it appears in the UI on the next restart.

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
        # field_type options: "text" | "password" | "number" | "url" | "textarea"
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
