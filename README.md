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
| 🕒 | **History & playback** — scrub through routes, replay trips, graph any sensor over time | |
| 📊 | **Fleet reports** — backend-defined reports for summary, trips, daily aggregates, drivers, users, alerts, logbook, geofences, sensors, billing, schedules, audit logs, health checks, and CSV export | |
| 🔔 | **Smart alerts** — speeding, geofence, idling, towing, low battery, maintenance, and custom rules | |
| 📣 | **Notifications** — Telegram, Discord, Email, Slack, browser push, and SIP voice calls. Route each alert to specific channels, schedule alerts by day and hour | |
| 🚗 | **Driver management** — create driver profiles, assign to vehicles, track who drove which trip | |
| 📋 | **Logbook** — service records, fuel fill-ups with consumption stats, and maintenance intervals per vehicle; with odometer, cost, date, and file attachments | |
| 🧭 | **Route planning** — create multi-stop planned routes, assign vehicles and drivers, preview route geometry, track status, and trigger off-route or skipped-waypoint alerts | |
| 💳 | **Billing operations** — super-admin billing plan management, company plan assignment, usage tracking, invoices, billing status, and configurable exchange rates | |
| ⚙️ | **Remote commands** — reboot, request position, set interval, and more from the dashboard | |
| 🔗 | **Live sharing** — send a time-limited link; recipients see the live map with no login required | |
| 🎙️ | **Voice PTT** — push-to-talk voice messages over WebSocket; read receipts, push notifications to offline users, message history | |
| 📡 | **8 native protocols** — Teltonika, GT06, Queclink, H02, TK103, Meitrack, Flespi, OsmAnd; listeners run only for protocols used by active devices | |
| 🔌 | **Cloud integrations** — pull live data from Traccar, Wialon, 3D Tracking, Flespi Cloud, GPS Server, Google Find Hub, and the built-in GPS simulator alongside native devices | |
| 🪝 | **Webhooks** — push live position data to any HTTP endpoint on every update | |
| 👥 | **Multi-user & multi-tenant** — three-tier roles (super admin → company admin → user), fine-grained per-user permissions, company-scoped device and user management, and company branding with custom login slugs | |
| 🔐 | **Security controls** — passkey login, scoped API keys, authenticator-app MFA with recovery codes, user impersonation, per-permission settings access, audit logging, health checks, and company-isolated admin tools | |
| 🌍 | **Unit systems** — switch between metric (km, km/h, m) and imperial (mi, mph, ft) per user | |
| 📱 | **PWA** — installs on Android and iOS, push notifications even when the tab is closed | |
| 💾 | **Backup & restore** — super admins can back up the whole platform; company admins with permission can back up and restore only their own company | |
| 📥 | **CSV export** — download full position history with all sensor columns included | |

---

https://github.com/user-attachments/assets/82189d71-8810-4d81-a055-f0dc463d9480

---

## Tech Stack

**Backend** — Python 3.11+, FastAPI, SQLAlchemy 2.0 (async), asyncpg, Redis, PostGIS

**Frontend** — Vanilla JS, Leaflet.js, Chart.js

**Infrastructure** — SQLite for quick start or PostgreSQL + PostGIS for production, optional Redis, dynamic raw TCP/UDP protocol listeners, WebSocket gateway

---


<div align="center">
Built with ❤️ — Routario
</div>
