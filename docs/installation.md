# Installation

Routario runs out of the box with Python and SQLite — no external services required. For production deployments with higher load, PostgreSQL and Docker Compose are recommended.

---

## Quick Start (Python + SQLite)

The fastest way to try Routario. No database or Docker setup needed.

### 1. Clone the repository

```bash
git clone https://github.com/bkbilly/routario.git
cd routario
```

### 2. Install dependencies

```bash
pip install -r requirements.txt
```

### 3. Run

```bash
python app/main.py
```

Routario creates `routario.db` in the current directory on first run and starts the web interface on port **8000**.

Open `http://localhost:8000` and log in with:

| Username | Password |
|---|---|
| `admin` | `admin_password` |

!!! warning "Change your password"
    Update the default admin password immediately after first login, or set `ADMIN_PASSWORD` before first run.

That's it. GPS devices can now connect to their respective protocol ports. All alert, history, and notification features work with SQLite — no further configuration required for a single-user or small deployment.

---

## Production Setup (Docker Compose + PostgreSQL)

For fleets, multi-user deployments, or anywhere you need reliability and performance, Docker Compose is the recommended path. It starts Routario alongside PostgreSQL, Redis, and Valhalla.

### Prerequisites

- **Docker 24+** and **Docker Compose v2+**
- Open firewall/NAT ports for each GPS protocol — see [Port Reference](devices.md#protocol-reference)

### 1. Clone and configure

```bash
git clone https://github.com/bkbilly/routario.git
cd routario
cp .env.example .env
```

Edit `.env` and set at minimum:

```env
SECRET_KEY=change-me-to-a-long-random-string
ADMIN_USERNAME=admin
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=your-secure-password
```

See the [Configuration](configuration.md) page for all available variables.

### 2. Start the stack

```bash
docker compose up -d
```

This starts four containers:

| Service | Description |
|---|---|
| `routario` | Main application — API + all protocol servers |
| `postgres` | PostgreSQL with the PostGIS extension |
| `redis` | Pub/sub broker for multi-worker WebSocket sync |
| `valhalla` | Routing engine for road speed-limit alerts |

### 3. Open the dashboard

Navigate to `http://localhost:8000` and log in with the admin credentials you set in `.env`.

!!! info "First run"
    Routario automatically creates the database schema and the default admin user on startup. No manual migration step is required.

!!! info "Valhalla startup time"
    On the very first start, Valhalla downloads and builds routing tiles for the configured region — this can take several minutes. Subsequent restarts reuse cached tiles and start in seconds.

### Configuring the Valhalla region

By default the compose file downloads the OSM extract for Greece. Change `tile_urls` in `docker-compose.yml` to the [Geofabrik extract](https://download.geofabrik.de) for your region before the first run:

```yaml
environment:
  - tile_urls=https://download.geofabrik.de/europe/germany-latest.osm.pbf
```

---

## Databases

### SQLite (default)

SQLite requires no installation or configuration. It is the default when `DATABASE_URL` is not set, making it ideal for development, testing, and small single-server deployments.

```env
DATABASE_URL=sqlite:///./routario.db
```

Routario uses `aiosqlite` for fully async SQLite access and applies WAL mode automatically for better concurrent read performance.

### PostgreSQL (recommended for production)

PostgreSQL is recommended when you need multiple API workers, better concurrent write throughput, or PostGIS for advanced geo queries.

```bash
# Create the database
createuser -P routario
createdb -O routario routario
psql routario -c "CREATE EXTENSION IF NOT EXISTS postgis;"
```

```env
DATABASE_URL=postgresql+asyncpg://routario:routariopass@localhost/routario
```

### Redis (optional)

Redis is used for WebSocket pub/sub so that position updates and alerts are broadcast across all Uvicorn worker processes. Without Redis, broadcasting works within a single process only — fine for development or single-worker deployments.

```env
REDIS_URL=redis://localhost:6379
```

If Redis is not reachable at startup, Routario logs a warning and falls back to in-process broadcasting automatically. No configuration change needed to run without it.

---

## Bare-Metal (Python + PostgreSQL)

If you prefer to run without Docker but want PostgreSQL:

```bash
# Set up the database
createuser -P routario
createdb -O routario routario
psql routario -c "CREATE EXTENSION IF NOT EXISTS postgis;"

# Install dependencies
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Configure and run
export DATABASE_URL=postgresql+asyncpg://routario:routariopass@localhost/routario
export SECRET_KEY=your-long-random-secret
python app/main.py
```

!!! warning "Production"
    For production deployments, put Routario behind a reverse proxy (nginx, Caddy) and use a process manager such as **systemd** or **supervisor** to keep it running.

---

## Firewall & Port Forwarding

Each GPS protocol listens on its own dedicated TCP (and sometimes UDP) port. Open these in your firewall and forward them from your router if running behind NAT.

Refer to the [Protocol Reference](devices.md#protocol-reference) table for the complete port list.

!!! tip
    The web interface and REST API are served on port **8000** only. GPS devices communicate directly with the protocol ports and never go through port 8000.

---

## Updating

```bash
git pull
docker compose pull
docker compose up -d
```

Routario applies any new database migrations automatically on startup.
