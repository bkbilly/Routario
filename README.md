<div align="center">

![Routario](web/icons/logo-700.png)

**Self-hosted GPS fleet tracking. No subscriptions. No data leaving your server.**

![Platform](https://img.shields.io/badge/platform-web%20%7C%20PWA-3b82f6?style=flat-square)
![Backend](https://img.shields.io/badge/backend-FastAPI%20%2B%20Python-10b981?style=flat-square)
![Database](https://img.shields.io/badge/database-PostgreSQL%20%2B%20PostGIS-8b5cf6?style=flat-square)
![Realtime](https://img.shields.io/badge/realtime-WebSocket%20%2B%20Redis-f59e0b?style=flat-square)

</div>

---

## What is Routario?

Routario connects directly to your GPS hardware over TCP/UDP and gives you a live map, alerts, and history — all running on your own server.

**Your fleet data never leaves your infrastructure.**

---

## Features at a Glance

| | Feature | |
|---|---|---|
| 🗺️ | **Live map** — real-time positions with smooth movement and heading rotation | |
| 🔔 | **Smart alerts** — speeding, geofence, idling, towing, low battery, maintenance, and custom rules | |
| 🕒 | **History & playback** — scrub through routes, replay trips, graph any sensor over time | |
| 🔗 | **Live sharing** — send a time-limited link; recipients see the live map with no login required | |
| 📣 | **Notifications** — Telegram, Discord, Email, Slack, browser push, and SIP voice calls | |
| 📡 | **8 protocols** — plug in Teltonika, GT06, Queclink, H02, TK103, Meitrack, Flespi, or OsmAnd | |
| ⚙️ | **Remote commands** — reboot, request position, set interval, and more from the dashboard | |
| 👥 | **Multi-user** — admin and standard roles, per-user device access and notification channels | |
| 📱 | **PWA** — installs on Android and iOS, push notifications even when the tab is closed | |

---

## Supported Devices

| Protocol | Port | Notes |
|---|---|---|
| **Teltonika** | 5027 (TCP + UDP) | FMB/FMC series, full I/O map, Codec 8/8E/16/26 |
| **GT06 / Concox** | 5023 (TCP) | Binary, widely cloned |
| **Queclink** | 5026 (TCP) | GV/GL/GB series |
| **H02** | 5013 (TCP) | Common in Chinese trackers |
| **TK103 / Coban** | 5001 (TCP) | Legacy ASCII |
| **Meitrack** | 5020 (TCP) | MVT/T series |
| **Flespi** | 5149 (TCP) | JSON-based |
| **OsmAnd** | 5055 (TCP) | HTTP, mobile app |

---

## Alert Types

| Alert | Trigger |
|---|---|
| **Speeding** | Speed exceeds threshold (with noise buffer) |
| **Idling** | Ignition on, zero speed beyond timeout |
| **Geofence** | Enter and/or exit any polygon zone |
| **Towing** | Movement detected with ignition off |
| **Offline** | No data received within configurable hours |
| **Low Battery** | Battery voltage drops below threshold |
| **Maintenance** | Odometer reaches a service interval |
| **Custom Rule** | Any expression: `fuel_level < 10 and ignition` |

Every alert supports a custom schedule (specific days and hours) and can be routed to any notification channel. Multiple instances of the same alert type can be stacked on one device.

---

## Custom Rule Syntax

Custom rules are evaluated against the live position context. Any sensor key reported by the device is available.

```
speed > 120
fuel_level < 10 and ignition
battery_voltage < 3.6 and not ignition
speed > 80 and satellites < 4
```

**Common attributes:** `speed`, `ignition`, `satellites`, `altitude`, `battery_voltage`, `fuel_level`, `temperature`, `door_open` — plus any device-specific sensor key.

**Operators:** `>` `<` `==` `!=` `>=` `<=` `and` `or` `not`

---

## Tech Stack

**Backend** — Python 3.11+, FastAPI, SQLAlchemy 2.0 (async), asyncpg, Redis, PostGIS

**Frontend** — Vanilla JS, Leaflet.js, Chart.js

**Infrastructure** — PostgreSQL + PostGIS, Redis, raw TCP/UDP socket servers per protocol, WebSocket gateway

---

<div align="center">
Built with ❤️ — Routario
</div>