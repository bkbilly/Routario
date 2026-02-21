<div align="center">

![Routario](web/icons/logo-700.png)

**Real-time fleet tracking, smart alerts, and sensor analytics — all in one platform.**

![Platform](https://img.shields.io/badge/platform-web%20%7C%20PWA-3b82f6?style=flat-square)
![Backend](https://img.shields.io/badge/backend-FastAPI%20%2B%20Python-10b981?style=flat-square)
![Database](https://img.shields.io/badge/database-PostgreSQL%20%2B%20PostGIS-8b5cf6?style=flat-square)
![Realtime](https://img.shields.io/badge/realtime-WebSocket%20%2B%20Redis-f59e0b?style=flat-square)

</div>

---

## Overview

Routario is a self-hosted GPS fleet tracking platform built for real-world operations. It receives raw data directly from hardware GPS trackers over TCP/UDP, normalizes it across protocols, and delivers live position updates, configurable alerts, and historical analytics through a clean, dark-themed web interface.

---

## Features

### 🗺️ Live Map Dashboard

The central dashboard displays all your vehicles on an interactive map, updated in real time via WebSocket. Each vehicle is represented by a customizable icon (car, truck, van, motorcycle, bus, boat, airplane, and more) with smooth animated movement and heading rotation as positions update.

The sidebar shows each vehicle's current status — online/offline, ignition state, last seen time, and total mileage — and updates instantly without any page refresh. Vehicles can be sorted by name, last seen time, or status, and filtered by name, IMEI, or license plate.

### 📡 Multi-Protocol Device Support

Routario natively decodes raw TCP/UDP data from a wide range of GPS tracker hardware without requiring any third-party middleware:

| Protocol | Port | Notes |
|---|---|---|
| **Teltonika** | 5027 | Codec 8 & 8 Extended, full I/O map |
| **GT06 / Concox** | 5023 | Binary protocol, heartbeat ACK |
| **Queclink** | 5026 | GV/GL/GB series, ASCII |
| **Flespi** | 5149 | JSON-based, standardized fields |
| **TK103** | 5021 | Legacy ASCII |
| **GPS103** | 5022 | SMS-style commands |
| **H02** | 5025 | Binary & ASCII variants |
| **OsmAnd** | 5055 | HTTP-based |
| **Totem** | 5028 | Binary |

All protocols normalize to a unified position schema covering coordinates, speed, course, altitude, satellites, ignition state, and an extensible sensor dictionary.

### 🔔 Smart Alert Engine

Alerts are configured per device and evaluated in real time on every incoming position. Each alert type is fully parameterizable and can be assigned a custom notification schedule (specific days and hours).

**Built-in alert types:**

- **Speeding** — fires when speed exceeds a configurable threshold, with a duration buffer to avoid false positives from GPS noise
- **Idling** — detects ignition-on, zero-speed conditions beyond a configurable timeout
- **Geofence Enter / Exit** — polygon-based zones with per-zone enter, exit, or both triggers
- **Offline** — fires when no data is received beyond a configurable hour threshold
- **Towing** — detects movement with ignition off, beyond a distance threshold
- **Low Battery** — monitors battery voltage sensor values
- **Harsh Braking / Harsh Acceleration** — detects abrupt speed changes
- **Maintenance** — triggers when odometer reaches a configurable interval (oil change, tyre rotation, or any custom type)
- **Custom Rules** — write any condition using sensor attributes and logical operators (e.g. `speed > 80 and ignition`, `fuel_level < 15`)

Multiple alert instances of the same type can be stacked on a single device (e.g. two different speed thresholds with different notification channels).

### 📣 Notification Channels

Alert notifications are dispatched per user through any combination of configured channels:

- **Telegram**
- **Discord**
- **Email (SMTP)**
- **Slack**
- **Browser push notifications** (via Web Push / VAPID)

Each channel is configured once per user account and can be assigned to individual alert rules independently.

### 🕒 History & Playback

For any device, you can load a time range of position history (from 1 hour up to custom date ranges) and:

- View the full route as a polyline on the map
- Play back movement with a slider and play/pause controls
- Step through positions one by one
- See every position's coordinates, speed, altitude, heading, satellite count, and ignition state in the sidebar
- View all raw sensor attributes (battery voltage, fuel level, RPM, temperature, door state, and anything else the device reports)
- Automatically detect and label **trips** within the selected range, with distance and duration per trip

### 📈 Sensor Graph

Within the history view, the Sensor Graph tab lets you select any combination of numeric attributes reported by the device and plot them as time-series line charts. Attributes are discovered automatically from the loaded history — you are not limited to a fixed list. A synchronized cursor line follows the playback position as you scrub through history, connecting the map and the graph in real time.

### ⚙️ Device Management

The device management panel provides full control over every tracker in your fleet:

- Add, edit, and delete devices with name, IMEI, protocol, vehicle type, license plate, and VIN
- View and correct the odometer reading
- Configure the offline threshold per device
- Manage all alert rules through a visual table editor with per-rule threshold, schedule, and channel assignment
- Browse raw position data from the last 24 hours in a paginated table
- Send remote commands to supported devices (reboot, get GPS fix, parameter read/write, and more) and view command history with acknowledgement status

### 👥 Multi-User Access Control

Routario supports multiple user accounts with role-based access:

- **Admin** accounts can create and delete devices and users, assign devices to users, and see all data across the platform
- **Standard** users can only see and configure the devices assigned to them
- Each user has their own notification channel configuration and alert history

### 📱 Progressive Web App (PWA)

Routario ships as a fully installable PWA. Users can add it to their home screen on Android or iOS and use it like a native app. The service worker caches static assets for offline resilience, and Web Push delivers browser notifications even when the tab is closed.

---

## Tech Stack

**Backend** — Python 3.11+, FastAPI, SQLAlchemy 2.0 (async), asyncpg, Redis (pub/sub for WebSocket fan-out), PostGIS for geofence queries, Apprise for notification dispatch.

**Frontend** — Vanilla JavaScript, Leaflet.js (maps), Chart.js (sensor graphs), CSS custom properties, Google Fonts (Outfit + JetBrains Mono).

**Infrastructure** — PostgreSQL + PostGIS, Redis, raw TCP/UDP socket servers per protocol, WebSocket gateway.

---

## Project Structure

```
routario/
├── app/
│   ├── main.py                  # FastAPI app, WebSocket manager
│   ├── core/
│   │   ├── gateway.py           # TCP/UDP device connection handlers
│   │   ├── alert_engine.py      # Real-time alert evaluation
│   │   ├── auth.py              # JWT + role-based access
│   │   ├── database.py          # Async DB layer
│   │   └── push_notifications.py
│   ├── protocols/               # One decoder per protocol
│   │   ├── teltonika.py
│   │   ├── gt06.py
│   │   ├── queclink.py
│   │   ├── flespi.py
│   │   └── ...
│   ├── alerts/                  # One class per alert type
│   │   ├── speeding.py
│   │   ├── geofence.py
│   │   ├── maintenance.py
│   │   ├── custome_rule.py
│   │   └── ...
│   ├── routes/                  # FastAPI routers
│   │   ├── devices.py
│   │   ├── positions.py
│   │   ├── alerts.py
│   │   └── users.py
│   └── models/
│       ├── models.py            # SQLAlchemy ORM
│       └── schemas.py           # Pydantic schemas
└── web/
    ├── gps-dashboard.html       # Live map
    ├── device-management.html   # Device & alert config
    ├── user-settings.html       # Account & notifications
    ├── login.html
    ├── css/
    ├── js/
    ├── icons/
    ├── manifest.json            # PWA manifest
    └── sw.js                    # Service worker
```

---

## Alert Custom Rule Syntax

Custom rules are evaluated against the current position's sensor context. Available attributes:

| Attribute | Example value |
|---|---|
| `speed` | `72.4` (km/h) |
| `ignition` | `true` / `false` |
| `satellites` | `9` |
| `altitude` | `143` (m) |
| `battery_voltage` | `4.12` (V) |
| `fuel_level` | `68` (%) |
| `temperature` | `23.5` (°C) |
| `door_open` | `true` / `false` |
| Any sensor key | device-specific |

Operators: `>`, `<`, `==`, `!=`, `>=`, `<=`, `and`, `or`, `not`

**Examples:**
```
speed > 120
fuel_level < 10 and ignition
battery_voltage < 3.6 and not ignition
speed > 80 and satellites < 4
```

---

<div align="center">
Built with ❤️ — Routario
</div>