"""
app/integrations/flespi_cloud.py

Flespi cloud integration.
API base: https://flespi.io

Auth:
  Token-based — every request carries:
    Authorization: FlespiToken <token>
  No session endpoint needed; the token is the credential.
  Tokens do not expire unless explicitly configured to do so.

List devices:
  GET /gw/devices/all
  → { "result": [ { "id": <int>, "name": <str>, "configuration": { "ident": <imei> }, ... } ] }

Fetch messages (with time window):
  GET /gw/devices/<id>/messages?data={"from":<unix_float>,"to":<unix_float>}
  → { "result": [ { "timestamp": <float>, "position.latitude": <float>, ... } ] }

  If messages returns empty (common when device messages_ttl is 0 or data is
  outside the TTL window), we fall back to the telemetry endpoint:
  GET /gw/devices/<id>/telemetry/all
  → { "result": [ { "<param>": { "value": <v>, "ts": <unix_float> }, ... } ] }
  Telemetry stores the last known value of every parameter for up to 370 days.
  It is flattened into a regular message dict before parsing.

Message field names follow the Flespi unified parameter naming scheme —
the same scheme used by the native Flespi TCP decoder — so _parse_message
is shared verbatim from that decoder's logic.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone, timedelta
from typing import AsyncIterator

import httpx

from integrations.base import BaseIntegration, AuthContext, IntegrationField, RemoteDevice
from integrations.registry import IntegrationRegistry
from models.schemas import NormalizedPosition

logger = logging.getLogger(__name__)

_BASE_URL = "https://flespi.io"

# In-memory cursor: last processed timestamp per (token_prefix, device_id).
# Flespi messages are ordered by `timestamp` (device RTC time).
# We advance the cursor to the highest timestamp seen each poll so we never
# re-process records from a previous cycle.
_last_seen: dict[tuple, float] = {}

# Fields that map directly to NormalizedPosition top-level attributes.
# Everything else is passed through to sensors{}.
_POSITION_KEYS = frozenset({
    "timestamp", "server.timestamp",
    "position.latitude", "position.longitude",
    "position.altitude", "position.speed",
    "position.direction", "position.satellites",
    "position.valid", "engine.ignition.status",
    # internal flespi metadata — not useful as sensors
    "device.id", "device.name", "device.type.id",
    "channel.id", "protocol.id", "peer",
})


@IntegrationRegistry.register("flespi_cloud")
class FlespiIntegration(BaseIntegration):

    PROVIDER_ID           = "flespi_cloud"
    DISPLAY_NAME          = "Flespi Cloud"
    POLL_INTERVAL_SECONDS = 30

    FIELDS = [
        IntegrationField(
            key="token",
            label="Flespi Cloud Token",
            field_type="password",
            required=True,
            placeholder="your_flespi_token_here",
            help_text=(
                "Standard or ACL token from your Flespi account. "
                "The token needs read access to gw/devices."
            ),
        ),
    ]

    # ── Auth ──────────────────────────────────────────────────────────────────

    async def authenticate(self, credentials: dict) -> AuthContext:
        token = credentials["token"].strip()
        if not token:
            raise ValueError("Flespi Cloud: token must not be empty")

        # Validate the token by calling GET /auth/info
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{_BASE_URL}/auth/info",
                headers={"Authorization": f"FlespiToken {token}"},
            )
            if resp.status_code == 401:
                raise ValueError("Flespi Cloud: invalid or expired token")
            resp.raise_for_status()

        logger.info("Flespi Cloud: token validated successfully")

        return AuthContext(
            data={"token": token},
            token_expires_at=None,  # Flespi tokens don't expire unless explicitly set
        )

    # ── List remote devices ───────────────────────────────────────────────────

    async def list_remote_devices(self, auth_ctx: AuthContext) -> list[RemoteDevice]:
        token = auth_ctx.data["token"]

        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(
                    f"{_BASE_URL}/gw/devices/all",
                    headers={"Authorization": f"FlespiToken {token}"},
                )
                resp.raise_for_status()
                data = resp.json()

            devices = data.get("result") or []
            remote = []
            for d in devices:
                device_id = d.get("id")
                if not device_id:
                    continue
                cfg  = d.get("configuration") or {}
                imei = str(cfg.get("ident") or "")
                remote.append(RemoteDevice(
                    remote_id=str(device_id),
                    name=d.get("name") or str(device_id),
                    imei=imei or None,
                ))
            return remote

        except Exception as e:
            logger.error(f"Flespi Cloud: list_remote_devices error: {e}", exc_info=True)
            return []

    # ── Fetch positions ───────────────────────────────────────────────────────

    async def fetch_positions(
        self,
        auth_ctx: AuthContext,
        devices: list[dict],
    ) -> AsyncIterator[NormalizedPosition]:
        token         = auth_ctx.data["token"]
        token_prefix  = token[:8]   # used as part of the cache key only
        now           = datetime.now(timezone.utc).timestamp()

        headers = {"Authorization": f"FlespiToken {token}"}

        for device in devices:
            device_id = str(device["remote_id"])
            imei      = device["imei"]
            cache_key = (token_prefix, device_id)

            last_ts = _last_seen.get(cache_key)
            if last_ts is None:
                # First poll — fetch the last 24 hours
                from_ts = now - 86_400
            else:
                # Subsequent polls — fetch from the last seen timestamp.
                # Add a tiny epsilon so we don't re-fetch the exact boundary record.
                from_ts = last_ts + 0.001

            # ── 1. Try the messages endpoint (full history) ───────────────────
            messages = await self._fetch_messages(headers, device_id, from_ts, now)

            # ── 2. Fall back to telemetry on the very first poll only ─────────
            # Telemetry stores the last known position for up to 370 days and
            # is independent of messages_ttl. We use it exactly once per process
            # session (last_ts is None) to show the device's last known location
            # immediately on startup. After that we rely solely on new messages.
            if not messages:
                if last_ts is not None:
                    # Already seeded from telemetry or messages this session.
                    # Nothing new to report — wait for real messages to arrive.
                    logger.debug(f"Flespi Cloud: no new messages for device {device_id}")
                    continue

                logger.debug(
                    f"Flespi Cloud: no messages for device {device_id} in window "
                    f"[{from_ts:.0f}, {now:.0f}] — seeding from telemetry"
                )
                messages = await self._fetch_telemetry(headers, device_id)
                if not messages:
                    continue

                # Telemetry yielded — advance cursor to now so subsequent polls
                # skip telemetry and wait for real messages instead.
                for msg in messages:
                    pos = self._parse_message(imei, msg)
                    if pos:
                        _last_seen[cache_key] = now
                        yield pos
                continue

            # ── Real messages: advance cursor and yield all ───────────────────
            for msg in messages:
                pos = self._parse_message(imei, msg)
                if not pos:
                    continue
                msg_ts = float(msg.get("timestamp") or 0)
                if msg_ts > (_last_seen.get(cache_key) or 0):
                    _last_seen[cache_key] = msg_ts
                yield pos

    # ── Internal fetch helpers ────────────────────────────────────────────────

    async def _fetch_messages(
        self,
        headers: dict,
        device_id: str,
        from_ts: float,
        to_ts: float,
    ) -> list[dict]:
        """Fetch device messages in [from_ts, to_ts]. Returns [] on any error or empty result."""
        params = {"data": json.dumps({"from": from_ts, "to": to_ts})}
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.get(
                    f"{_BASE_URL}/gw/devices/{device_id}/messages",
                    headers=headers,
                    params=params,
                )
                if resp.status_code == 404:
                    logger.warning(f"Flespi Cloud: device {device_id} not found on this account")
                    return []
                resp.raise_for_status()
                return resp.json().get("result") or []
        except Exception as e:
            logger.error(f"Flespi Cloud: messages fetch error for device {device_id}: {e}")
            return []

    async def _fetch_telemetry(self, headers: dict, device_id: str) -> list[dict]:
        """
        Fetch the device's telemetry snapshot and convert it into a single
        message dict so it can be passed through _parse_message unchanged.

        Telemetry response shape:
          { "result": [ { "id": <int>, "telemetry": { "<param>": { "value": <v>, "ts": <unix_float> }, ... } } ] }

        We flatten it to:
          { "<param>": <v>, "timestamp": <most_recent_ts> }
        """
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(
                    f"{_BASE_URL}/gw/devices/{device_id}/telemetry/all",
                    headers=headers,
                )
                if resp.status_code == 404:
                    return []
                resp.raise_for_status()
                result = resp.json().get("result") or []

            if not result:
                return []

            # result is a list with one item per requested device:
            #   [ { "id": <int>, "telemetry": { "<param>": { "value": v, "ts": t }, ... } } ]
            item = result[0] if isinstance(result, list) else result
            telemetry: dict = item.get("telemetry") or {}

            if not telemetry:
                return []

            # Flatten: { "param": {"value": v, "ts": t} } → { "param": v }
            # and derive a unified timestamp from the most recent ts value.
            flat: dict = {}
            latest_ts: float = 0.0
            for param, entry in telemetry.items():
                if not isinstance(entry, dict):
                    continue
                flat[param] = entry.get("value")
                ts = float(entry.get("ts") or 0)
                if ts > latest_ts:
                    latest_ts = ts

            if latest_ts:
                flat["timestamp"] = latest_ts

            return [flat] if flat else []

        except Exception as e:
            logger.error(f"Flespi Cloud: telemetry fetch error for device {device_id}: {e}")
            return []

    # ── Message parser ────────────────────────────────────────────────────────

    def _parse_message(self, imei: str, msg: dict) -> NormalizedPosition | None:
        """
        Parse a Flespi device message into a NormalizedPosition.

        Field names follow the Flespi unified parameter scheme:
          position.latitude / position.longitude / position.altitude
          position.speed (km/h)   position.direction (degrees)
          position.satellites     position.valid
          engine.ignition.status  (bool)
          timestamp               (Unix float — device RTC time)
          server.timestamp        (Unix float — flespi receive time)
          battery.voltage / battery.level / gsm.signal.level
          engine.rpm / fuel.level / vehicle.mileage (odometer km)
          gnss.hdop
        """
        try:
            lat = msg.get("position.latitude")
            lng = msg.get("position.longitude")
            if lat is None or lng is None:
                return None
            lat = float(lat)
            lng = float(lng)
            if lat == 0.0 and lng == 0.0:
                return None

            # ── Timestamps ────────────────────────────────────────────────────

            def _from_unix(raw) -> datetime | None:
                if raw is None:
                    return None
                try:
                    t = float(raw)
                    # Flespi uses seconds (with fractional ms); millis would be > 1e12
                    if t > 1e12:
                        t /= 1000.0
                    return datetime.fromtimestamp(t, tz=timezone.utc)
                except (ValueError, TypeError):
                    return None

            device_time = _from_unix(msg.get("timestamp")) or datetime.now(timezone.utc)
            server_time = datetime.now(timezone.utc)

            # ── Core motion ───────────────────────────────────────────────────

            speed      = msg.get("position.speed")
            speed_kph  = float(speed) if speed is not None else None

            course     = float(msg.get("position.direction") or 0)
            altitude   = float(msg.get("position.altitude") or 0)

            sat_raw    = msg.get("position.satellites")
            satellites = int(sat_raw) if sat_raw is not None else None

            valid_raw  = msg.get("position.valid")
            # position.valid may be absent; treat absence as valid
            if valid_raw is not None and not bool(valid_raw):
                return None  # skip invalid GPS fixes

            # ── Ignition ──────────────────────────────────────────────────────
            ignition_raw = msg.get("engine.ignition.status")
            ignition: bool | None = bool(ignition_raw) if ignition_raw is not None else None

            # ── Sensors ───────────────────────────────────────────────────────
            sensors: dict = {}

            _sensor_map = [
                ("battery.voltage",          "battery_voltage"),
                ("battery.level",            "battery_percent"),
                ("external.powersource.voltage", "external_voltage"),
                ("gsm.signal.level",         "gsm_signal"),
                ("engine.rpm",               "rpm"),
                ("fuel.level",               "fuel_level"),
                ("vehicle.mileage",          "odometer"),
                ("gnss.hdop",                "hdop"),
                ("gsm.mcc",                  "mcc"),
                ("gsm.mnc",                  "mnc"),
                ("gsm.lac",                  "lac"),
                ("gsm.cellid",               "cell_id"),
            ]
            for src_key, dst_key in _sensor_map:
                v = msg.get(src_key)
                if v is not None:
                    sensors[dst_key] = v

            # Pass through any remaining unknown fields not already consumed
            for key, value in msg.items():
                if key not in _POSITION_KEYS and key not in sensors:
                    sensors[key] = value

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
                raw_data={"source": "flespi_cloud"},
            )

        except Exception as e:
            logger.error(f"Flespi Cloud: parse error for {imei}: {e}", exc_info=True)
            return None
