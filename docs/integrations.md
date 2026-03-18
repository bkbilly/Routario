# Cloud Integrations

Routario can pull live positions from third-party GPS cloud platforms alongside devices connected directly. This lets you manage devices from multiple vendors and platforms in a single unified dashboard.

---

## How Cloud Integrations Work

Cloud integrations run as a background polling task every **30 seconds**. On each cycle, Routario authenticates with the remote platform (reusing cached sessions where possible), fetches new position messages for each linked device, and feeds them through the same normalisation pipeline as native devices — so all alerts, history, and WebSocket updates work identically.

!!! info "Smart polling"
    Each cycle tracks a per-device cursor (last-seen timestamp) so only genuinely new messages are fetched — not the entire history.

---

## Wialon (Gurtam)

Wialon is one of the world's most widely used fleet management platforms. Routario integrates with both **Wialon Hosting** (cloud) and **Wialon Local** (on-premise) installations.

### Credentials

| Field | Required | Description |
|---|---|---|
| `token` | Yes | API token from Wialon User Settings → API. Requires *Online Tracking* and *General Information* access. |
| `server_url` | No | Override for on-premise Wialon. Default: `https://hst-api.wialon.com` |

### How to connect

1. In Wialon, go to **User Settings → API** and generate a new API token.
2. In Routario, open **Device Management → Add New Device**.
3. Select **Wialon (Gurtam)** from the protocol dropdown under *External Integrations*.
4. Enter the API token (and server URL for on-premise).
5. Click **Test Connection** to verify, then save.
6. Use **Import Devices** to automatically create device entries for all units visible on your Wialon account.

### What is synced

- Real-time position (latitude, longitude, altitude, speed, course, satellites)
- Sensor data from Wialon's parameter payload (`p` field) — fuel, temperature, digital I/O, custom counters
- Device name and license plate from Wialon unit properties

### Authentication

Wialon uses session-based authentication (`eid` session ID). Routario caches the session for the token's lifetime and automatically re-authenticates if the session is rejected mid-cycle.

---

## Flespi Cloud

Flespi is an IoT middleware platform that normalises data from hundreds of GPS tracker models into a unified parameter schema. Connecting Routario to Flespi Cloud lets you receive data from any device Flespi supports — even if Routario has no native decoder for it.

### Credentials

| Field | Required | Description |
|---|---|---|
| `token` | Yes | Standard or ACL token with read access to `gw/devices` |

### How to connect

1. In your [Flespi account](https://flespi.io), go to **Tokens** and create a token with `gw/devices` read access.
2. In Routario, open **Device Management → Add New Device**.
3. Select **Flespi Cloud** from the External Integrations group.
4. Paste your token and click **Test Connection**.
5. Use **Import Devices** to pull in all devices registered on your Flespi account.

### What is synced

- Position, speed, altitude, course, satellites, validity from Flespi's unified parameter names (`position.*`)
- Ignition state (`engine.ignition.status`)
- All additional parameters passed through to the sensors dict: battery voltage, fuel level, RPM, odometer, HDOP, GSM cell info, and any device-specific custom parameters

### Message fetch strategy

Routario first tries the `/gw/devices/{id}/messages` endpoint with a time window from the last-seen timestamp to now. If that returns empty (due to TTL settings), it falls back to `/gw/devices/{id}/telemetry/all` — which stores the last known value of every parameter for up to 370 days — ensuring devices appear on the map immediately after being added.

---

## Adding New Integration Providers

The integration system is auto-discovering. To add support for a new cloud platform:

1. Create a new file in `app/integrations/`.
2. Subclass `BaseIntegration` and implement `authenticate()`, `fetch_positions()`, and optionally `list_remote_devices()`.
3. Decorate with `@IntegrationRegistry.register("provider_id")`.
4. Define `DISPLAY_NAME`, `POLL_INTERVAL_SECONDS`, and the `FIELDS` list (describes the credential form shown in the UI).

```python
from integrations.base import BaseIntegration, AuthContext, IntegrationField
from integrations.registry import IntegrationRegistry

@IntegrationRegistry.register("myprovider")
class MyProviderIntegration(BaseIntegration):
    PROVIDER_ID           = "myprovider"
    DISPLAY_NAME          = "My Provider"
    POLL_INTERVAL_SECONDS = 30

    FIELDS = [
        IntegrationField(key="token", label="API Token",
                         field_type="password", required=True),
    ]

    async def authenticate(self, credentials: dict) -> AuthContext:
        ...

    async def fetch_positions(self, auth_ctx, devices):
        ...
```

!!! tip
    Raise `AuthExpiredError` inside `fetch_positions()` when the remote API rejects your session. Routario will evict the cached `AuthContext` and re-authenticate on the next poll cycle automatically.
