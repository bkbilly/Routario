# Configuration

All Routario settings are controlled via environment variables. Place them in a `.env` file in the project root or inject them directly into your Docker environment.

---

## Database

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql+asyncpg://gps_user:gps_password@localhost/gps_platform` | Full async PostgreSQL connection string |
| `DB_POOL_SIZE` | `20` | SQLAlchemy connection pool size |
| `DB_MAX_OVERFLOW` | `40` | Maximum overflow connections beyond the pool |

---

## Redis

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `REDIS_CACHE_TTL` | `3600` | Default cache time-to-live in seconds |

---

## API Server

| Variable | Default | Description |
|---|---|---|
| `API_HOST` | `0.0.0.0` | Bind address for the FastAPI server |
| `API_PORT` | `8000` | HTTP port for the web interface and API |
| `API_WORKERS` | `4` | Number of Uvicorn worker processes |

---

## Security

| Variable | Default | Description |
|---|---|---|
| `SECRET_KEY` | *(change me)* | JWT signing secret |
| `ALGORITHM` | `HS256` | JWT signing algorithm |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `30` | JWT token lifetime in minutes |

!!! danger "Important"
    Always change `SECRET_KEY` to a long, random string before deploying to production. Never commit it to version control.

---

## Default Admin User

On first startup, Routario creates an admin account using these values. If the username already exists, these settings are ignored.

| Variable | Default | Description |
|---|---|---|
| `ADMIN_USERNAME` | `admin` | Initial admin username |
| `ADMIN_EMAIL` | `admin@example.com` | Initial admin email |
| `ADMIN_PASSWORD` | `admin_password` | Initial admin password — **change immediately** |

---

## Protocol Gateway

| Variable | Default | Description |
|---|---|---|
| `TCP_HOST` | `0.0.0.0` | Bind address for all TCP protocol servers |
| `UDP_HOST` | `0.0.0.0` | Bind address for all UDP protocol servers |

---

## Valhalla (Speed Limit Alerts)

| Variable | Default | Description |
|---|---|---|
| `VALHALLA_URL` | `http://localhost:8002` | URL of the Valhalla routing engine |
| `VALHALLA_ENABLED` | `true` | Set to `false` to disable without removing config |

---

## Geocoding (Optional)

Reverse geocoding populates start/end addresses on trips.

| Variable | Default | Description |
|---|---|---|
| `GEOCODING_ENABLED` | `false` | Enable reverse geocoding |
| `GEOCODING_PROVIDER` | `nominatim` | Provider: `nominatim`, `google`, or `mapbox` |
| `GEOCODING_API_KEY` | — | API key for Google or Mapbox (not needed for Nominatim) |

---

## Push Notifications (VAPID)

Required for browser push notifications (PWA). Generate a VAPID key pair with:

```bash
npx web-push generate-vapid-keys
```

| Variable | Description |
|---|---|
| `VAPID_PRIVATE_KEY` | VAPID private key (Base64 URL-safe) |
| `VAPID_PUBLIC_KEY` | VAPID public key shared with the browser |
| `VAPID_MAILTO` | Contact address, e.g. `mailto:admin@example.com` |

---

## Feature Flags

| Variable | Default | Description |
|---|---|---|
| `ENABLE_WEBSOCKETS` | `true` | Enable real-time WebSocket updates |
| `ENABLE_NOTIFICATIONS` | `true` | Enable external alert notifications |
| `ENABLE_COMMAND_QUEUE` | `true` | Enable device command queuing and delivery |
| `OFFLINE_CHECK_INTERVAL_SECONDS` | `300` | How often to check for offline devices (seconds) |
