# Routario Platform

**Routario** is a high-performance, self-hosted GPS tracking and fleet management platform. It provides real-time live maps, smart alerts, cloud integrations, and a full PWA you can install on any device — all running on infrastructure you control.

---

## What can it do?

<div class="grid cards" markdown>

- :material-antenna: **10+ Native Protocols**

    Built-in TCP/UDP decoders for Teltonika, GT06, TK103, Queclink, Meitrack, H02, Flespi, OsmAnd and more.

    [:octicons-arrow-right-24: Supported Devices](devices.md)

- :material-bell-ring: **Smart Alerts**

    Speed limit alerts backed by real road data (Valhalla/OSM), geofence events, ignition, SOS, custom sensor rules and more.

    [:octicons-arrow-right-24: Alerts](alerts.md)

- :material-cloud-sync: **Cloud Integrations**

    Pull live positions from Wialon, Flespi Cloud, and other third-party platforms alongside your native devices.

    [:octicons-arrow-right-24: Cloud Integrations](integrations.md)

- :material-message-badge: **Rich Notifications**

    Telegram, Email, Slack, Discord, webhooks, browser push — via the Apprise library or Web Push API.

    [:octicons-arrow-right-24: Notifications](notifications.md)

- :material-cellphone-arrow-down: **PWA Support**

    Install Routario on iOS and Android from the browser. Offline-capable with native-style push notifications.

    [:octicons-arrow-right-24: Features](features.md#progressive-web-app)

- :material-map-clock: **Trip History**

    Playback routes, explore sensor graphs, view trip summaries, and export raw position data as CSV.

    [:octicons-arrow-right-24: Features](features.md#trip-history--playback)

</div>

---

## How It Works

Routario runs as a single Python/FastAPI application managing three concurrent responsibilities:

1. **Protocol Gateway** — listens on separate TCP/UDP ports for each device protocol, decodes incoming packets into a normalised position format, and persists them to PostgreSQL.
2. **REST API + WebSocket** — serves the web frontend, exposes a JSON API for all CRUD operations, and broadcasts live position updates in real time.
3. **Alert & Integration Engine** — runs background tasks that evaluate alert rules per device, poll cloud integrations, and dispatch notifications.

!!! info "Stack"
    Python 3.11+ · FastAPI · SQLAlchemy 2 (async) · PostgreSQL + PostGIS · Redis · Valhalla (optional, for road speed limits)

---

## Quick Start

The fastest way to run Routario is with Docker Compose:

```bash
git clone https://github.com/your-org/routario.git
cd routario
cp .env.example .env   # edit as needed
docker compose up -d
```

The web interface is available at `http://localhost:8000` after startup.

[:octicons-arrow-right-24: Full Installation Guide](installation.md)
