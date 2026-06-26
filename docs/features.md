# Features

A complete overview of everything Routario can do out of the box.

---

## Live Map Dashboard

The main dashboard provides a real-time bird's-eye view of your entire fleet:

- **Live markers** — all tracked devices appear on an interactive Leaflet map, updated in real time via WebSocket with no page refreshes.
- **Device sidebar** — sortable list of all devices with live status indicators (online/offline), last-seen time, speed, and ignition state.
- **Multiple tile layers** — switch between OpenStreetMap, dark, satellite, hybrid, and ESRI imagery.
- **Jump to device** — clicking a device on the sidebar or map flies the view to its current position.

---

## Trip History & Playback

- **Date-range picker** — query any time window for any device. Quick-select buttons (Today, Yesterday, 1 Hour, 2 Hours, 1 Day, 2 Days, 7 Days, current month, previous month) fill the range instantly. The Load button is disabled when the start time is not before the end time.
- **Route playback** — animate the vehicle's path on the map with play/pause and a scrub slider.
- **Trip segmentation** — trips are automatically detected and separated by ignition events. Each trip shows start/end time, distance, and duration. When no trips are found in the selected range, the view switches automatically to the point details panel.
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

Routario evaluates alert rules continuously as positions arrive. Supported alert types include:

- **Speed limit** — backed by real OSM road data via Valhalla
- **Geofence** — enter/exit events for polygons and circles
- **Ignition** — on/off events from the device
- **SOS** — hardware panic button trigger
- **Low battery** — voltage threshold with battery chemistry presets
- **Idling** — engine running but vehicle stationary
- **Towing / Shock** — hardware sensor trigger
- **Maintenance Due** — odometer- or date-based service intervals with advance warnings
- **Driver ID (Beacon)** — unauthorized driver detection via BLE beacon proximity
- **Custom / Sensor Rule** — arbitrary boolean expression over device sensor data
- **Device Offline** — no position received within a configurable timeout

[:octicons-arrow-right-24: Full Alert Reference](alerts.md)

---

## User Management & Multi-Tenancy

- **Three-tier roles** — Super Admin, Company Admin, and Regular User. Company Admins manage users and devices scoped to their company without visibility into other companies.
- **Fine-grained permissions** — on top of roles, each user can be granted specific permissions (view devices, send commands, manage drivers, voice PTT, manage users, etc.) grouped by feature area. A user can only grant permissions they hold themselves.
- **Company management** — group users and devices into companies. Super admins manage all companies; company admins are self-contained within theirs.
- **Device assignment** — grant or revoke access to specific devices per user. Regular users only see their assigned devices.
- **Per-user notification channels** — each user independently configures their alert delivery URLs (Telegram, email, Slack, webhooks, etc.).
- **Unit system** — each user can independently choose metric (km, km/h, m) or imperial (mi, mph, ft) display units.
- **Security settings** — passkey login, self-service MFA setup, permission-based API key management, scoped backup/restore, audit logs, and health visibility.

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

## Driver Management

- **Driver profiles** — create drivers with name, contact details, and notes.
- **Vehicle assignment** — assign a driver to a vehicle; position history stores the assigned driver at each point.
- **Trip attribution** — history and reports link trips to the stored driver attribution. When a driver changes during a trip, the trip report uses the final stored trip driver.

---

## Fleet Reports

Generate reports across your fleet for any time window:

- **Fleet summary** — totals per device: distance driven, trips made, driving time, average speed, and top speed.
- **Trips report** — each trip with start/end time, distance, duration, and a map view of the route.
- **Daily activity** — totals rolled up by calendar day for the whole fleet, each vehicle, or each driver.
- **Driver activity** — per-driver totals for trips, distance, driving time, top speed, and vehicles used.
- **User fleet** — user readiness report for company admins: assigned vehicles, push status, notification channels, webhooks, permissions, alerts, and last activity.
- **Vehicle sensors** — current sensor values or historical sensor rows over a selected period.
- **Alerts** — alert history report with optional user filtering for admins.
- **Billing** — draft billing usage, totals, and company billing details for a selected period.
- **Audit** — super-admin report for administrative and security events.
- **Scheduled reports** — run reports daily, weekly, or monthly and keep stored run history.
- **CSV export** — download data for each report type.
- **Backend-defined reports** — report files define their own controls, columns, summaries, CSV output, and optional row actions.

[:octicons-arrow-right-24: Reports](reports.md)

---

## Route Planning

- **Planned routes** — create multi-stop routes and assign them to vehicles and drivers.
- **Route preview** — preview route geometry before dispatch. Valhalla is used when available, with a straight-line fallback when routing is unavailable.
- **Route lifecycle** — track planned, started, paused, completed, and cancelled routes.
- **Scoped management** — routes are company-scoped and controlled by the Manage Routes permission or route API scopes.
- **Clickable tables** — route rows open directly into edit details for faster dispatch workflows.
- **Route alerts** — trigger alerts when a vehicle leaves its planned path or skips an earlier waypoint.

---

## Billing & Operations

- **Billing plans** — define base price, included devices, included position records, included API calls, and overage rates.
- **Company plan assignment** — assign billing plans from company management or from the billing plan editor.
- **Usage calculation** — measure active devices, stored positions, and API usage events for invoice generation.
- **Fleet Reports integration** — billing reports and billing details are generated from Fleet Reports.
- **Invoice snapshots** — generated invoices keep totals, currency, exchange rate, and usage details at the time of billing.
- **Audit and health tools** — review administrative events and readiness checks from the management area.

---

## Dashcam Clips

Routario supports Teltonika DualCam and generic HTTP camera clip uploads for camera-capable devices.

- **Dashcam upload endpoint** — cameras can upload event clips to `/api/dashcam/upload`.
- **Device Management clip browser** — view, filter, play, and delete clips for devices marked as having a dashcam.
- **History integration** — clips can be shown alongside trip/history time ranges.
- **Nearest-position matching** — when a clip upload does not include coordinates, Routario links it to the nearest stored position for that device.

---

## Voice PTT

Push-to-talk voice messaging for direct communication with drivers and team members:

- **Push-to-talk recording** — hold to record a voice message, transmitted live over WebSocket.
- **Read receipts** — see which users have listened to each message.
- **Offline delivery** — users who are offline receive a browser push notification and hear the message when they reconnect.
- **Message history** — searchable log of all voice messages with timestamps and sender info.

---

## Logbook

Per-vehicle records across three tabs:

- **Service entries** — log repairs, tyre changes, inspections, and any other work with date, odometer reading, cost, description, and file attachments (invoices, photos).
- **Fuel fill-ups** — record each refuel with litres, cost, and odometer to track consumption over time.
- **Maintenance intervals** — define service schedules by distance (km) or time (days); completed services automatically advance the next due date and odometer target.

---

## Live Sharing

- **Share live location** — generate a public share link for a device so external users can view its current position without logging in.
- **Time-limited links** — set expiry from 15 minutes up to 7 days, or a custom duration.
- **Multiple active shares** — create several independent links for the same device simultaneously.

---

## Cloud Integrations

Pull live positions from third-party GPS platforms without reconfiguring your devices. Supported providers:

| Provider | Notes |
|---|---|
| **Wialon (Gurtam)** | Wialon Hosting and Wialon Local (on-premise) |
| **Flespi Cloud** | Supports any device registered on your Flespi account |
| **Traccar** | Any Traccar server (self-hosted or cloud) |
| **3D Tracking** | European fleet management platform |
| **GPS-Server.net** | Hosted and white-label/self-hosted installations |
| **Google Find Hub** | BLE trackers and Android phones via Find Hub |
| **GPS Simulator** | Built-in virtual vehicle — drive any route with configurable speed, ignition, and sensors, no hardware needed |

[:octicons-arrow-right-24: Cloud Integrations](integrations.md)

!!! tip "Build your own"
    Adding a new integration provider requires a single Python file. See [Extending Routario](extending.md#adding-a-cloud-integration).

---

## Administration

- **Backup & Restore** — super admins can back up and restore the full platform; company admins with permission can back up and restore only their company.
- **User impersonation** — admins can temporarily act as any user to diagnose access or configuration issues.
- **Company management** — partition users and devices into isolated companies with their own admin accounts.
- **Company branding** — optionally set a company app name, `/login/<slug>` URL, app icons, and notification badge.
- **Passkeys, API keys, and MFA** — register passkeys, create scoped API keys, and manage authenticator-app MFA.
- **Billing, audit, and health** — manage super-admin billing plans, review audit logs, and inspect readiness checks.

[:octicons-arrow-right-24: Administration Guide](administration.md)
