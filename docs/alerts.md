# Alerts

Routario's alert engine evaluates rules on every incoming position update and fires targeted notifications when thresholds are crossed. Alerts are stored in history, broadcast live via WebSocket, and dispatched to your configured notification channels.

---

## How the Alert Engine Works

1. A new position arrives from a device (via native protocol or cloud integration).
2. The alert engine retrieves all alert rules configured for that device.
3. Each applicable rule checker runs against the new position and the device's persistent state.
4. If a rule fires, an `AlertHistory` record is written to the database.
5. The alert is broadcast in real time over WebSocket to all connected dashboard clients.
6. External notifications (Telegram, email, etc.) are dispatched to the user's configured channels.

!!! info "Debounce"
    Each alert type has built-in debounce logic. A speeding alert, for example, will not fire again until the vehicle first drops below the threshold and then exceeds it again — preventing notification floods.

---

## Alert Types

### ⚡ Speed Limit Alert

Fires when a vehicle exceeds the actual posted speed limit of the road it is on, fetched in real time from [Valhalla](https://valhalla.github.io/valhalla/) via OpenStreetMap data. More accurate than a fixed threshold because it accounts for road type and local regulations.

| Parameter | Default | Description |
|---|---|---|
| Overspeed Tolerance (%) | `10` | Percentage above the road limit before the alert fires. 10% on a 50 km/h road triggers at 55 km/h. |
| Confirmation Duration (s) | `15` | Speed must be exceeded continuously for this many seconds before the alert fires. Set to `0` for immediate. |
| Minimum Speed to Check (km/h) | `30` | Speed limit lookup is skipped below this speed to avoid noise at low speeds. |
| Valhalla Query Interval (s) | `10` | How often to query Valhalla for the current road's speed limit. |
| Trace Window (s) | `15` | Seconds of recent GPS history sent to Valhalla for accurate map-matching. |

!!! warning "Requires Valhalla"
    This alert is silently skipped if Valhalla is unavailable or disabled. All other alert types work without it.

---

### 📍 Geofence Alert

Fires when a vehicle enters or exits a drawn geofence area (polygon or circle).

- Configure which event triggers the alert: **enter**, **exit**, or **both**.
- Each geofence is independently debounced — crossing multiple fences generates separate alerts.
- Geofences can be device-specific or apply globally to all devices.
- Draw and edit geofences directly on the live map.

---

### 🔑 Ignition Alert

Fires on ignition-on and/or ignition-off events as reported by the device. Useful for monitoring vehicle start/stop activity, detecting unauthorised use, or tracking working hours.

---

### 🆘 SOS Alert

Fires when a device reports an SOS/panic event triggered by the hardware SOS button. Severity is always set to **critical**.

---

### 🪫 Low Battery Alert

Fires when the configured voltage sensor drops below a threshold.

| Parameter | Default | Description |
|---|---|---|
| Battery Type | `lead_acid` | Preset threshold helper: Lead Acid, AGM, or Lithium (LiFePO4). |
| Voltage Threshold (V) | `12.2` | Alert fires below this voltage. The preset can be adjusted manually. |
| Voltage Sensor | `external_voltage` | Sensor key to read from position data, for example `external_voltage` or `battery_voltage`. |

Values reported in millivolts are normalized to volts automatically.

---

### 🛑 Idling Alert

Fires when a vehicle's engine is running (ignition on) but the vehicle has not moved beyond a minimum speed for a sustained period. Both the minimum speed and the duration are configurable.

---

### 🚛 Towing / Shock Alert

Fires when the device reports a towing or shock/vibration event (hardware sensor trigger). Maps directly to the `towing` or `tampering` alert type emitted by the protocol decoder.

---

### ⛽ Custom / Sensor Rule Alert

Write a custom boolean expression evaluated against the device's real-time sensor data. This lets you create alerts for virtually any condition the device reports.

**Supported attributes:**

`speed` · `ignition` · `satellites` · `altitude` · `battery_voltage` · `fuel_level` · `temperature` · `door_open`

**Supported operators:** `>` `<` `==` `!=` `>=` `<=` `and` `or` `not`

**Example expressions:**

```
fuel_level < 15
temperature > 80 and ignition == true
door_open == true and speed > 0
```

---

### 📴 Device Offline Alert

Fires when a device has not sent a position for longer than a configurable timeout. The engine checks all devices periodically (default every 5 minutes, configurable via `OFFLINE_CHECK_INTERVAL_SECONDS`).

---

### 🔧 Maintenance Due Alert

Fires when a vehicle's odometer or a date-based service schedule is approaching or due. Useful for tracking recurring maintenance across a fleet without an external service management tool.

| Parameter | Default | Description |
|---|---|---|
| Maintenance Type | `service` | Preset types: Service, Oil Change, Tire Change, Brake Service, Air Filter, or Custom. |
| Custom Label | — | Name shown in the alert when type is *Custom*. |
| Track By | `distance` | Track by odometer distance or calendar date. |
| Next Service At (km) | `0` | Odometer reading at which the first service is due. |
| Repeat Every (km) | `5000` | After the first service, how often (in km) to repeat the alert. |
| Warn When Within (km) | `500` | Fire an advance warning this many km before the service is due. |
| Next Service Date | — | Date on which the first service is due when tracking by date. |
| Repeat Every (days) | `180` | How often to repeat the date-based alert. |
| Warn When Within (days) | `14` | Fire an advance warning this many days before the due date. |

Two alert events are generated for each interval:

- **Info** — fired within the configured warning distance or warning days.
- **Warning** — fired when the odometer or date reaches/passes the due value.

After the due value is passed, the next interval begins automatically based on the configured repeat interval — no manual reset needed.

---

### 🪪 Driver ID (Beacon) Alert

Fires when the ignition is on but no authorised BLE beacon has been detected within the expected window. Use this to verify that a registered driver (carrying a paired beacon) is present whenever the vehicle is running.

| Parameter | Default | Description |
|---|---|---|
| Authorised Beacon ID | *(any)* | Full beacon ID to accept, e.g. `uuid:major:minor` or `namespace:instance`. Leave blank to accept any beacon. |
| Absence Timeout (s) | `30` | Fire the alert if no matching beacon is seen for this many seconds while ignition is on. |
| Minimum RSSI (dBm) | `-90` | Ignore beacons with a weaker signal than this threshold — prevents ghost detections from distant beacons. |

The alert fires **once** per ignition cycle and resets automatically when the ignition turns off or when a valid beacon is seen again.

!!! info "Device support"
    BLE beacon detection requires the tracker hardware to scan for beacons and include them in the position payload (typically in a `beacon_ids` sensor field). Not all devices support this — check your device's firmware and protocol documentation.

---

### 🧑‍✈️ No / Unexpected Driver Alert

Fires when a vehicle is moving without an assigned driver, or when the assigned driver is not the expected one.

| Parameter | Default | Description |
|---|---|---|
| Minimum speed (km/h) | `5` | Alert only when speed exceeds this value. |
| Expected driver | *(any driver)* | Leave blank to alert whenever no driver is assigned, or choose a specific driver to alert when someone else is assigned. |

The alert fires once per moving period and resets when the vehicle stops or the correct driver is assigned.

---

### 📡 Device Native Event Alert

Some protocols expose built-in hardware events as sensor values. Routario can create hidden protocol-specific alert rules for these events, such as panic, power cut, tamper, towing, or other native device events.

These rules use the internal `device_event` alert implementation and are injected by protocol support rather than shown as a generic system alert in the dropdown.

---

## Configuring Alerts

Alert rules are configured per device in **Device Management**:

1. Open Device Management and click **Edit** for a device.
2. Navigate to the **Alerts** tab.
3. Click **Add Alert Rule** and select an alert type.
4. Configure the parameters and select which notification channels should receive it.
5. Save — the rule takes effect immediately on the next position update.

!!! tip
    You can add multiple rules of the same type with different thresholds or notification channels on the same device.

---

## Alert Severity

| Severity | Colour | Typical Use |
|---|---|---|
| `critical` | 🔴 Red | SOS, power cut, device tamper |
| `warning` | 🟡 Amber | Speeding, geofence, towing, low battery, maintenance due, unauthorized driver |
| `info` | 🔵 Blue | Ignition on/off, device online/offline, maintenance approaching |

---

## Alert History

All fired alerts are stored in the database and accessible from the **Alerts** panel on the dashboard:

- View unread vs read alerts with a badge count indicator.
- Mark individual alerts as read or clear the entire list.
- Filter to show unread only.
- See the alert location, message, severity, and timestamp.
