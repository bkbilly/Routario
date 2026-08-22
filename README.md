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

**A live demo is available at https://bkbilly.github.io/Routario/demo/.**

**Independent project note:** Routario is an independent open-source project first committed on February 14, 2026. It is not affiliated with any company or commercial product using the Routario name.

---

## Features at a Glance

| | Feature | |
|---|---|---|
| 🗺️ | **Live fleet map** — see all your vehicles moving in real-time with speed, direction, and ignition status | |
| 🌓 | **Light & dark themes** — easily switch between sleek dark mode and clean light mode | |
| 🕒 | **Trip history** — replay past trips on the map, review stops, and view speed and sensor graphs | |
| 🚧 | **Geofences** — draw zones on the map and get alerted when vehicles enter, exit, or stay too long | |
| 🚨 | **Speed limit detection** — detect speeding using actual road speed limits or your own custom thresholds | |
| 🔔 | **Instant alerts** — immediate alerts for speeding, towing, idling, low battery, maintenance, or harsh driving | |
| 📣 | **Multi-channel notifications** — get notified via Telegram, Discord, Slack, Email, browser push, or phone voice calls | |
| 🧭 | **Route planning** — plan multi-stop routes, assign drivers, and track live progress and arrival times | |
| 🚗 | **Driver management** — create driver profiles, track license dates, and automatically log who drove each vehicle | |
| 📋 | **Fuel & service logbook** — track fuel fill-ups, calculate fuel consumption, log repair costs, and attach receipts | |
| 🎙️ | **Voice walkie-talkie (PTT)** — send quick voice messages between fleet dispatchers and drivers | |
| 🤖 | **AI Copilot** — ask questions in plain English about vehicle activity, trips, and fleet costs | |
| 📊 | **Scheduled fleet reports** — automatically receive daily, weekly, or monthly PDF and CSV reports | |
| 🔗 | **Live sharing links** — share temporary live tracking links with customers so they can track deliveries without logging in | |
| ⚙️ | **Remote commands** — send commands directly to vehicles (e.g. cut engine, reboot, change update rate) | |
| 🎫 | **Maintenance & repair tickets** — report vehicle issues, assign repair tasks, and track maintenance progress | |
| 🏢 | **Multi-company support** — host multiple companies with isolated vehicles, custom logos, and branded login pages | |
| 👤 | **User access control** — customize exactly what each team member can see and do | |
| 🔒 | **Easy & secure login** — sign in with Face ID / Touch ID (Passkeys), Google / Microsoft (SSO), or two-factor authentication | |
| 📡 | **Wide GPS tracker support** — connects directly to major GPS hardware (Teltonika, Queclink, Concox, TK103, etc.) or smartphones | |
| 🔌 | **External platform sync** — import live data from existing platforms like Traccar, Wialon, 3D Tracking, or Google Find My | |
| 🪝 | **Webhooks** — forward live GPS data to your own external systems or automations | |
| 🌍 | **Metric & imperial units** — switch easily between kilometers/km/h and miles/mph | |
| 📱 | **Mobile app (PWA)** — install on Android and iOS with background push notifications | |
| 💾 | **Backup & restore** — one-click platform backups and company-level data exports and restores | |

---

## Tech Stack

**Backend** — Python 3.11+, FastAPI, SQLAlchemy 2.0 (async), asyncpg, Redis, PostGIS

**Frontend** — Vanilla JS, Leaflet.js, Chart.js

**Infrastructure** — SQLite for quick start or PostgreSQL + PostGIS for production, optional Redis, dynamic raw TCP/UDP protocol listeners, WebSocket gateway

---


<div align="center">
Built with ❤️ — Routario
</div>
