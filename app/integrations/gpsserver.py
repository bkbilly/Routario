"""
app/integrations/gpsserver.py

GPS-Server.net cloud integration.
API base: https://gps-server.net/api/

Auth:
  POST /api/auth/login
       { "email": "<email>", "password": "<password>" }
  → { "status": "ok", "token": "<jwt>", "expires": <unix_ts> }
  The JWT is passed as  Authorization: Bearer <token>  on subsequent calls.

List devices:
  GET /api/devices
  → [ { "id": <int>, "name": <str>, "imei": <str>,
        "plate": <str|null>, "type": <str|null>, ... } ]

Last position per device:
  GET /api/devices/<id>/position
  → { "id": <int>, "device_id": <int>,
      "latitude": <float>, "longitude": <float>,
      "altitude": <float|null>, "speed": <float>,   (km/h)
      "course": <float>, "satellites": <int>,
      "timestamp": <ISO8601>,
      "ignition": <bool|null>,
      "sensors": { <name>: <value>, ... } }

  Returns 404 when the device has no position history yet.

Polling strategy:
  GPS-Server.net does not expose a delta / since-timestamp endpoint on the
  free / standard API, so we fetch each device's last position individually
  and skip records whose timestamp hasn't advanced since the last poll.

Speed:  already in km/h.
Time:   ISO 8601, UTC.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone, timedelta
from typing import AsyncIterator

import httpx

from integrations.base import (
    BaseIntegration,
    AuthContext,
    AuthExpiredError,
    IntegrationField,
    RemoteDevice,
)
from integrations.registry import IntegrationRegistry
from models.schemas import NormalizedPosition

logger = logging.getLogger(__name__)

_BASE_URL = "https://gps-server.net"

# (token_prefix, device_id) → last ISO-8601 timestamp string seen
_last_seen: dict[tuple, str] = {}


@IntegrationRegistry.register("gpsserver")
class GPSServerIntegration(BaseIntegration):

    PROVIDER_ID           = "gpsserver"
    DISPLAY_NAME          = "GPS-Server.net"
    POLL_INTERVAL_SECONDS = 30

    FIELDS = [
        IntegrationField(
            key="email",
            label="Email / Username",
            field_type="text",
            required=True,
            placeholder="you@example.com",
            help_text="The email address you use to log in to GPS-Server.net.",
        ),
        IntegrationField(
            key="password",
            label="Password",
            field_type="password",
            required=True,
        ),
        IntegrationField(
            key="server_url",
            label="Server URL (optional)",
            field_type="url",
            required=False,
            placeholder="https://gps-server.net",
            help_text=(
                "Leave blank for the hosted service. "
                "White-label / self-hosted installations: enter your server base URL."
            ),
            default="",
        ),
    ]

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _base(self, auth_ctx: AuthContext) -> str:
        return auth_ctx.data["base_url"]

    def _headers(self, auth_ctx: AuthContext) -> dict:
        return {
            "Authorization": f"Bearer {auth_ctx.data['token']}",
            "Accept":        "application/json",
        }

    # ── Auth ──────────────────────────────────────────────────────────────────

    async def authenticate(self, credentials: dict) -> AuthContext:
        base = (credentials.get("server_url") or _BASE_URL).rstrip("/")

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{base}/api/auth/login",
                json={
                    "email":    credentials["email"].strip(),
                    "password": credentials["password"],
                },
                headers={"Accept": "application/json"},
            )

            if resp.status_code == 401:
                raise ValueError("GPS-Server.net: invalid email or password")
            resp.raise_for_status()
            data = resp.json()

        if data.get("status") != "ok" or not data.get("token"):
            raise ValueError(
                f"GPS-Server.net: unexpected auth response: {data}"
            )

        token   = data["token"]
        expires = data.get("expires")
        expires_at = (
            datetime.fromtimestamp(int(expires), tz=timezone.utc) - timedelta(minutes=5)
            if expires
            else None
        )

        logger.info("GPS-Server.net: authenticated successfully")
        return AuthContext(
            data={
                "token":    token,
                "base_url": base,
                "tok_pfx":  token[:8],
            },
            token_expires_at=expires_at,
        )

    # ── List remote devices ───────────────────────────────────────────────────

    async def list_remote_devices(self, auth_ctx: AuthContext) -> list[RemoteDevice]:
        base = self._base(auth_ctx)
        hdrs = self._headers(auth_ctx)

        try:
            async with httpx.AsyncClient(timeout=20) as client:
                resp = await client.get(f"{base}/api/devices", headers=hdrs)

                if resp.status_code in (401, 403):
                    raise AuthExpiredError("GPS-Server.net: token rejected while listing devices")
                resp.raise_for_status()
                items = resp.json()

            devices = []
            for item in (items if isinstance(items, list) else []):
                device_id = str(item.get("id", ""))
                name      = item.get("name") or device_id
                imei      = str(item.get("imei") or "").strip() or None
                plate     = item.get("plate") or None
                vtype     = item.get("type")  or None

                devices.append(RemoteDevice(
                    remote_id=device_id,
                    name=name,
                    imei=imei,
                    license_plate=plate,
                    vehicle_type=vtype,
                ))
            return devices

        except AuthExpiredError:
            raise
        except Exception as e:
            logger.error(f"GPS-Server.net: list_remote_devices error: {e}", exc_info=True)
            return []

    # ── Fetch positions ───────────────────────────────────────────────────────

    async def fetch_positions(
        self,
        auth_ctx: AuthContext,
        devices: list[dict],
    ) -> AsyncIterator[NormalizedPosition]:
        base    = self._base(auth_ctx)
        hdrs    = self._headers(auth_ctx)
        tok_pfx = auth_ctx.data["tok_pfx"]

        async with httpx.AsyncClient(timeout=30) as client:
            for device in devices:
                device_id = str(device["remote_id"])
                imei      = device["imei"]
                cache_key = (tok_pfx, device_id)

                try:
                    resp = await client.get(
                        f"{base}/api/devices/{device_id}/position",
                        headers=hdrs,
                    )

                    if resp.status_code == 404:
                        # Device exists but has no position data yet
                        logger.debug(f"GPS-Server.net: no position for device {device_id}")
                        continue

                    if resp.status_code in (401, 403):
                        raise AuthExpiredError(
                            "GPS-Server.net: token rejected during position fetch"
                        )
                    resp.raise_for_status()
                    data = resp.json()

                except AuthExpiredError:
                    raise
                except Exception as e:
                    logger.error(
                        f"GPS-Server.net: position fetch error for device {device_id}: {e}"
                    )
                    continue

                if not data:
                    continue

                ts_raw = data.get("timestamp") or ""

                # Skip if this is the same record we already processed
                if ts_raw and ts_raw == _last_seen.get(cache_key):
                    continue

                pos = self._parse_position(imei, data)
                if pos:
                    if ts_raw:
                        _last_seen[cache_key] = ts_raw
                    yield pos

    # ── Position parser ───────────────────────────────────────────────────────

    def _parse_position(self, imei: str, data: dict) -> NormalizedPosition | None:
        try:
            lat = float(data.get("latitude") or 0)
            lng = float(data.get("longitude") or 0)
            if lat == 0.0 and lng == 0.0:
                return None

            ts_raw = data.get("timestamp") or ""
            if ts_raw:
                try:
                    device_time = datetime.fromisoformat(
                        ts_raw.replace("Z", "+00:00")
                    )
                    if device_time.tzinfo is None:
                        device_time = device_time.replace(tzinfo=timezone.utc)
                except ValueError:
                    device_time = datetime.now(timezone.utc)
            else:
                device_time = datetime.now(timezone.utc)

            server_time = datetime.now(timezone.utc)

            altitude   = float(data["altitude"])  if data.get("altitude")   is not None else None
            speed_kph  = float(data["speed"])     if data.get("speed")      is not None else None
            course     = float(data["course"])    if data.get("course")     is not None else None
            satellites = int(data["satellites"])  if data.get("satellites") is not None else None

            ignition_raw = data.get("ignition")
            if ignition_raw is not None:
                try:
                    ignition: bool | None = bool(ignition_raw)
                except (ValueError, TypeError):
                    ignition = None
            else:
                ignition = None

            # Sensor dict from the API — pass through as-is, with light normalisation
            raw_sensors = data.get("sensors") or {}
            sensors: dict = {}

            _sensor_aliases = {
                "battery_voltage":      "battery_voltage",
                "battery_level":        "battery_percent",
                "external_voltage":     "external_voltage",
                "fuel_level":           "fuel_level",
                "odometer":             "odometer",
                "mileage":              "odometer",
                "gsm_signal":           "gsm_signal",
                "gsm_level":            "gsm_signal",
                "rpm":                  "rpm",
                "temperature":          "temperature",
                "temperature1":         "temperature_1",
                "temperature2":         "temperature_2",
                "door":                 "door",
                "digital_input_1":      "digital_in_1",
                "digital_input_2":      "digital_in_2",
                "digital_output_1":     "digital_out_1",
                "digital_output_2":     "digital_out_2",
            }

            mapped_keys: set = set()
            for src, dst in _sensor_aliases.items():
                v = raw_sensors.get(src)
                if v is not None:
                    sensors[dst] = v
                    mapped_keys.add(src)

            # Populate ignition from sensors if not already set at top level
            if ignition is None:
                ign_v = raw_sensors.get("ignition") or raw_sensors.get("digital_input_1")
                if ign_v is not None:
                    try:
                        ignition = bool(int(ign_v))
                    except (ValueError, TypeError):
                        ignition = bool(ign_v)

            # Pass through any remaining sensor keys not already mapped
            for k, v in raw_sensors.items():
                if k not in mapped_keys and k not in sensors and k != "ignition":
                    sensors[k] = v

            return NormalizedPosition(
                imei=imei,
                device_time=device_time,
                server_time=server_time,
                latitude=lat,
                longitude=lng,
                altitude=altitude,
                speed=speed_kph,
                course=course,
                satellites=satellites,
                ignition=ignition,
                sensors=sensors,
                raw_data={"source": "gpsserver"},
            )

        except Exception as e:
            logger.error(f"GPS-Server.net: parse error for {imei}: {e}", exc_info=True)
            return None

    # ── Credentials test ──────────────────────────────────────────────────────

    async def test_credentials(self, credentials: dict) -> tuple[bool, str]:
        try:
            ctx   = await self.authenticate(credentials)
            hdrs  = self._headers(ctx)
            base  = self._base(ctx)
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(f"{base}/api/devices", headers=hdrs)
                if resp.status_code in (401, 403):
                    return False, "Token accepted but device list request was rejected."
                resp.raise_for_status()
                count = len(resp.json()) if isinstance(resp.json(), list) else "?"
            return True, f"Connected — {count} device(s) visible on account."
        except Exception as e:
            return False, str(e)
