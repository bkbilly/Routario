# Installation

Get Routario running locally or on a server in minutes using Docker Compose. A manual bare-metal setup is also supported.

---

## Prerequisites

- **Docker 24+** and **Docker Compose v2+** *(recommended path)*
- Or: **Python 3.11+**, **PostgreSQL 15+** with PostGIS, and **Redis 7+**
- Open firewall/NAT ports for each GPS protocol you want to use — see [Port Reference](devices.md#protocol-reference)
- *(Optional)* A [Valhalla](https://valhalla.github.io/valhalla/) instance for road speed-limit alerts

---

## Docker Compose (recommended)

### 1. Clone the repository

```bash
git clone https://github.com/your-org/routario.git
cd routario
```

### 2. Create your environment file

```bash
cp .env.example .env
```

Edit `.env` with your preferred editor. At minimum, change the secret key and admin credentials:

```env
SECRET_KEY=change-me-to-a-long-random-string
ADMIN_USERNAME=admin
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=your-secure-password
```

See the [Configuration](configuration.md) page for all available variables.

### 3. Start the stack

```bash
docker compose up -d
```

This starts:

| Service | Description |
|---|---|
| `routario` | Main application — API + all protocol servers |
| `postgres` | PostgreSQL 15 with the PostGIS extension |
| `redis` | Pub/sub broker and position cache |

### 4. Open the dashboard

Navigate to `http://localhost:8000` and log in with the admin credentials you set in `.env`.

!!! info "First run"
    Routario automatically creates the database schema and the default admin user on startup. No manual migration step is required.

---

## Optional: Valhalla (road speed limits)

Valhalla is an open-source routing engine used by Routario to look up the posted speed limit of the road a vehicle is on. Without it, the *Speed Limit Alert* is silently skipped; all other alerts work normally.

```yaml
# Add to your docker-compose.yml
valhalla:
  image: ghcr.io/gis-ops/docker-valhalla/valhalla:latest
  volumes:
    - ./valhalla_data:/custom_files
  environment:
    - tile_urls=https://download.geofabrik.de/europe/greece-latest.osm.pbf
  ports:
    - "8002:8002"
```

Then in your `.env`:

```env
VALHALLA_URL=http://valhalla:8002
VALHALLA_ENABLED=true
```

---

## Manual Installation (bare-metal)

### 1. Set up the database

```bash
createuser -P gps_user
createdb -O gps_user gps_platform
psql gps_platform -c "CREATE EXTENSION IF NOT EXISTS postgis;"
```

### 2. Install Python dependencies

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 3. Configure environment

Export the variables listed in [Configuration](configuration.md), or create a `.env` file in the project root.

### 4. Run the application

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4
```

!!! warning "Production"
    For production deployments, put Routario behind a reverse proxy (nginx, Caddy) and use a process manager such as **systemd** or **supervisor** to keep it running.

---

## Firewall & Port Forwarding

Each GPS protocol listens on its own dedicated TCP (and sometimes UDP) port. You must open these in your firewall and forward them from your router if running behind NAT.

Refer to the [Protocol Reference](devices.md#protocol-reference) table for the complete port list.

!!! tip
    The REST API and web interface are served on port **8000** only. GPS devices communicate directly with the protocol ports — they never go through port 8000.

---

## Updating

```bash
git pull
docker compose pull
docker compose up -d --build
```

Routario applies any new database migrations automatically on startup.
