# Features

A complete overview of everything Routario can do out of the box.

---

## Live Map Dashboard

The main dashboard provides a real-time bird's-eye view of your entire fleet:

- **Live markers** — all tracked devices appear on an interactive Leaflet map, updated in real time via WebSocket with no page refreshes.
- **Device sidebar** — sortable list of all devices with live status indicators (online/offline), last-seen time, speed, and ignition state.
- **Multiple tile layers** — switch between standard street maps, satellite imagery, and hybrid views.
- **Cluster mode** — automatically groups nearby markers when zoomed out to keep the map readable for large fleets.
- **Follow mode** — the map pans to keep the selected vehicle centred as it moves.

---

## Trip History & Playback

- **Date-range picker** — query any time window for any device.
- **Route playback** — animate the vehicle's path on the map with adjustable speed controls.
- **Trip segmentation** — trips are automatically detected and separated by ignition events. Each trip shows start/end address, distance, duration, and max speed.
- **Sensor graph** — plot any sensor attribute (speed, fuel level, temperature, voltage, etc.) over time on an interactive chart.
- **Raw data table** — browse individual position records with full sensor payloads.
- **CSV export** — download the full position history for any date range.

---

## Device Management

- **Add / edit / delete devices** — configure name, IMEI, license plate, protocol, icon colour, and per-device alerts from a single modal.
- **Odometer tracking** — cumulative distance is calculated from GPS data and shown per device.
- **Device commands** — send predefined or custom commands to supported devices (reboot, set interval, set output, request position, etc.) and track delivery status: `pending` → `sent` → `acked`.
- **Raw data viewer** — inspect every position record with full sensor payloads for diagnostics.
- **Device search & filtering** — instantly filter the device table by name, IMEI, plate, or protocol.

---

## Geofences

- Draw geofences directly on the map as **polygons** or **circles**.
- Configure per-geofence alerts for **enter** events, **exit** events, or both.
- Customise fence colour for easy identification on the map.
- Assign geofences to a specific device or globally to all devices.
- Each crossing is debounced per geofence to prevent duplicate alerts.

---

## Smart Alert Engine

Routario evaluates alert rules continuously as positions arrive. Alerts include speed-limit violations backed by real OSM road data (via Valhalla), geofence crossings, ignition events, SOS signals, and custom sensor expressions.

[:octicons-arrow-right-24: Full Alert Reference](alerts.md)

---

## User Management

- **Multi-user** — create separate accounts for drivers, dispatchers, and administrators.
- **Role-based access** — admins manage users and assign devices; regular users only see their assigned devices.
- **Per-user notification channels** — each user independently configures their alert delivery URLs (Telegram, email, Slack, webhooks, etc.).
- **Device assignment** — admins can grant or revoke access to specific devices per user.

---

## Progressive Web App

Routario ships as a full PWA, installable on any device directly from the browser — no app store required.

- **Android & iOS** — add to home screen for a native app-like experience.
- **Offline support** — the shell and static assets are cached so the app loads even with an intermittent connection.
- **Browser push notifications** — receive alert notifications even when the tab is in the background, powered by the Web Push API and VAPID keys.
- **App shortcuts** — jump directly to the Dashboard or Device Management from the home screen icon's long-press menu.

!!! tip "Best experience"
    Install Routario as a PWA for native-style push notifications that arrive even when the browser is closed.

---

## Real-Time WebSocket

The dashboard maintains a persistent WebSocket connection. Whenever a device sends a new position, the update is broadcast to all connected clients within milliseconds — no polling, no page reloads. Alerts are also pushed over WebSocket so they appear as toasts in real time.

---

## Logbook & Sharing

- **Trip logbook** — structured list of all trips for a device with start/end location, duration, and distance.
- **Share live location** — generate a public share link for a device so external users can view its current position without logging in.
