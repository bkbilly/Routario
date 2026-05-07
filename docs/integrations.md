# Cloud Integrations

Routario can pull live positions from third-party GPS cloud platforms alongside devices connected directly. This lets you manage devices from multiple vendors and platforms in a single unified dashboard.

---

## How Cloud Integrations Work

Cloud integrations run as background polling tasks. On each cycle, Routario authenticates with the remote platform (reusing cached sessions where possible), fetches new position messages for each linked device, and feeds them through the same normalisation pipeline as native devices — so all alerts, history, and WebSocket updates work identically.

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

Wialon uses session-based authentication (`eid` session ID). Routario caches the session for the token's lifetime and automatically re-authenticates if the session is rejected mid-cycle. Positions are polled every **30 seconds**.

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

Routario first tries the `/gw/devices/{id}/messages` endpoint with a time window from the last-seen timestamp to now. If that returns empty (due to TTL settings), it falls back to `/gw/devices/{id}/telemetry/all` — which stores the last known value of every parameter for up to 370 days — ensuring devices appear on the map immediately after being added. Positions are polled every **30 seconds**.

---

## Traccar

[Traccar](https://www.traccar.org/) is a popular open-source GPS tracking server that supports hundreds of device protocols. Connecting Routario to a Traccar instance lets you mirror devices already managed there without reconfiguring them.

### Credentials

| Field | Required | Description |
|---|---|---|
| `server_url` | Yes | Full URL of your Traccar server, e.g. `https://demo.traccar.org` |
| `username` | Yes | Traccar account email or username |
| `password` | Yes | Traccar account password |

### How to connect

1. In Routario, open **Device Management → Add New Device**.
2. Select **Traccar** from the External Integrations group.
3. Enter your Traccar server URL, username, and password.
4. Click **Test Connection** to verify, then save.
5. Use **Import Devices** to pull all devices visible to that account.

### What is synced

- Real-time position (latitude, longitude, altitude, speed, course, satellites)
- Ignition state and sensor attributes from the Traccar device `attributes` payload
- Device name from Traccar unit properties

### Authentication

Traccar uses HTTP Basic Auth per-request — no session token is cached. Routario passes credentials on every API call, so token expiry is not a concern. Positions are polled every **30 seconds**.

---

## 3D Tracking

[3D Tracking](https://www.3dtracking.com/) is a fleet management platform used across Europe. Routario polls its REST API to mirror device positions in real time.

### Credentials

| Field | Required | Description |
|---|---|---|
| `username` | Yes | 3D Tracking account username (usually your email) |
| `password` | Yes | 3D Tracking account password |

### How to connect

1. In Routario, open **Device Management → Add New Device**.
2. Select **3D Tracking** from the External Integrations group.
3. Enter your credentials and click **Test Connection**.
4. Use **Import Devices** to import all units from your account.

### What is synced

- Real-time position, speed, altitude, course, and satellite count
- Digital I/O states and additional sensor parameters from the unit payload

### Authentication

3D Tracking uses session-based authentication. Routario authenticates on first use and caches the `SessionId` for up to 23.5 hours, then re-authenticates automatically.

### Poll interval

3D Tracking polls every **30 seconds** when any linked device was recently active, and every **120 seconds** during quiet periods to reduce API load.

---

## GPS-Server.net

[GPS-Server.net](https://gps-server.net) is a hosted GPS tracking service with white-label support. Routario integrates with the public cloud service and self-hosted installations alike.

### Credentials

| Field | Required | Description |
|---|---|---|
| `email` | Yes | Email address used to log in to GPS-Server.net |
| `password` | Yes | Account password |
| `server_url` | No | Leave blank for the hosted service. Enter the base URL for white-label / self-hosted instances. |

### How to connect

1. In Routario, open **Device Management → Add New Device**.
2. Select **GPS-Server.net** from the External Integrations group.
3. Enter your email and password (and server URL for self-hosted).
4. Click **Test Connection**, then save.
5. Use **Import Devices** to import your fleet — device names, IMEIs, and license plates are synced automatically.

### What is synced

- Real-time position, speed, altitude, course, and satellites
- License plate and vehicle type from GPS-Server.net device properties
- Ignition state and additional sensor data

### Authentication

GPS-Server.net returns a Bearer token on login. Routario caches it and honours the expiry time returned by the API, re-authenticating transparently before the token lapses. Positions are polled every **30 seconds**.

---

## Google Find Hub

Google Find Hub is Google's device-finding network. Routario can pull locations for devices enrolled in Find Hub — including Bluetooth trackers and Android phones set to share location.

!!! warning "Non-standard setup"
    This integration requires running [GoogleFindMyTools](https://github.com/leonboe1/GoogleFindMyTools) separately to obtain the authentication secrets. It is not a simple username/password flow.

### Credentials

| Field | Required | Description |
|---|---|---|
| `secrets_json` | Yes | Full JSON contents of the `Auth/secrets.json` file generated by GoogleFindMyTools |

### How to obtain secrets.json

1. Clone and run [GoogleFindMyTools](https://github.com/leonboe1/GoogleFindMyTools) on any machine.
2. Follow its authentication flow (Google account login + device pairing).
3. After completing the location flow, copy the contents of `Auth/secrets.json`.
4. Paste the entire JSON blob into the **secrets.json contents** field in Routario.

The `secrets.json` file must contain `aas_token` at minimum. If it also contains `owner_key`, Routario will use it to decrypt end-to-end encrypted location payloads.

### What is synced

- Real-time location of all devices visible in your Find Hub account
- E2EE location decryption when `owner_key` is present in secrets

### Authentication

Routario exchanges the `aas_token` for a short-lived OAuth token using the Google Play Services auth endpoint. Tokens are refreshed automatically as they expire.

### Poll interval

Google Find Hub polls every **120 seconds** when a device was recently active, and every **300 seconds** during quiet periods. This is intentionally slower than other integrations to stay within Google's rate limits.

---

## Adding New Integration Providers

See [Extending Routario → Adding a Cloud Integration](extending.md#adding-a-cloud-integration).
