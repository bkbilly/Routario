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
| 📣 | **Notifications** — Telegram, Discord, Email, Slack, browser push, and SIP voice calls. Route each alert to specific channels, schedule alerts by day and hour | |
| 🕒 | **History & playback** — scrub through routes, replay trips, graph any sensor over time | |
| 🔗 | **Live sharing** — send a time-limited link; recipients see the live map with no login required | |
| 📋 | **Logbook** — per-vehicle service records with odometer, cost, date, and file attachments | |
| 📡 | **8 protocols** — plug in Teltonika, GT06, Queclink, H02, TK103, Meitrack, Flespi, or OsmAnd | |
| 🔌 | **Cloud integrations** — pull live data from 3rd-party platforms alongside native devices | |
| 🪝 | **Webhooks** — push live position data to any HTTP endpoint on every update | |
| ⚙️ | **Remote commands** — reboot, request position, set interval, and more from the dashboard | |
| 👥 | **Multi-user** — admin and standard roles, per-user device access and notification channels | |
| 📥 | **CSV export** — download full position history with all sensor columns included | |
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

## Tech Stack

**Backend** — Python 3.11+, FastAPI, SQLAlchemy 2.0 (async), asyncpg, Redis, PostGIS

**Frontend** — Vanilla JS, Leaflet.js, Chart.js

**Infrastructure** — PostgreSQL + PostGIS, Redis, raw TCP/UDP socket servers per protocol, WebSocket gateway

---

<div align="center">
Built with ❤️ — Routario
</div>