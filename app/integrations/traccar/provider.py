"""
app/integrations/traccar/provider.py

Traccar integration.
Traccar is self-hosted — the user provides their own server URL.
API docs: https://www.traccar.org/api-reference/

Auth:   Basic auth (username + password) on every request.
        Traccar also supports session tokens — we use the session endpoint
        to get a JSESSIONID cookie for the lifetime of the poll session.

Poll:   GET /api/positions?deviceId=<id>  (latest position per device)
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import AsyncIterator

import httpx

from integrations.base import BaseIntegration, AuthContext, IntegrationField, RemoteDevice
from integrations.registry import IntegrationRegistry
from models.schemas import NormalizedPosition

logger = logging.getLogger(__name__)

_KNOTS_TO_KPH = 1.852

# In-memory cache of the last seen device_time per (base_url, remote_device_id).
# Prevents re-processing the same position on every poll cycle, since Traccar's
# /api/positions always returns the latest known position regardless of whether
# it has changed.
_last_seen: dict[tuple, datetime] = {}


@IntegrationRegistry.register("traccar")
class TraccarIntegration(BaseIntegration):

    PROVIDER_ID           = "traccar"
    DISPLAY_NAME          = "Traccar"
    POLL_INTERVAL_SECONDS = 30

    FIELDS = [
        IntegrationField(
            key="server_url",
            label="Traccar Server URL",
            field_type="url",
            required=True,
            placeholder="https://your-traccar.example.com",
            help_text="Full URL of your Traccar server, e.g. https://demo.traccar.org",
        ),
        IntegrationField(
            key="username",
            label="Username / Email",
            field_type="text",
            required=True,
            placeholder="admin@example.com",
        ),
        IntegrationField(
            key="password",
            label="Password",
            field_type="password",
            required=True,
        ),
    ]

    # ── Auth ──────────────────────────────────────────────────────────────────

    async def authenticate(self, credentials: dict) -> AuthContext:
        base = credentials["server_url"].rstrip("/")
        auth = (credentials["username"], credentials["password"])

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{base}/api/session",
                data={
                    "email":    credentials["username"],
                    "password": credentials["password"],
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            resp.raise_for_status()
            user = resp.json()
            cookies = dict(resp.cookies)

        return AuthContext(
            data={
                "base_url": base,
                "auth":     auth,     # (username, password) tuple
                "cookies":  cookies,  # JSESSIONID etc.
                "user_id":  user.get("id"),
            },
            token_expires_at=None,  # Traccar sessions don't have a fixed expiry
        )

    # ── Fetch positions ───────────────────────────────────────────────────────

    async def fetch_positions(
        self,
        auth_ctx: AuthContext,
        devices: list[dict],
    ) -> AsyncIterator[NormalizedPosition]:
        base    = auth_ctx.data["base_url"]
        auth    = auth_ctx.data["auth"]
        cookies = auth_ctx.data["cookies"]

        id_map = {str(d["remote_id"]): d["imei"] for d in devices}
        if not id_map:
            return

        params = [("deviceId", rid) for rid in id_map]

        try:
            async with httpx.AsyncClient(
                timeout=15,
                auth=auth,
                cookies=cookies,
            ) as client:
                resp = await client.get(f"{base}/api/positions", params=params)
                resp.raise_for_status()
                positions = resp.json()

        except Exception as e:
            logger.error(f"Traccar: bulk fetch error: {e}")
            return

        for pos_data in positions:
            device_id = str(pos_data.get("deviceId", ""))
            imei      = id_map.get(device_id)
            if not imei:
                continue

            pos = self._parse_position(imei, pos_data)
            if not pos:
                continue

            # Skip if this is the same position we already processed last cycle
            cache_key = (base, device_id)
            last = _last_seen.get(cache_key)
            if last is not None and last >= pos.device_time:
                continue

            _last_seen[cache_key] = pos.device_time
            yield pos

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _parse_position(self, imei: str, p: dict) -> NormalizedPosition | None:
        try:
            lat = float(p.get("latitude") or 0)
            lng = float(p.get("longitude") or 0)
            if lat == 0 and lng == 0:
                return None

            def _parse_dt(raw) -> datetime | None:
                if not raw:
                    return None
                try:
                    dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
                    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
                except ValueError:
                    return None

            device_time = (
                _parse_dt(p.get("fixTime"))
                or _parse_dt(p.get("deviceTime"))
                or datetime.now(timezone.utc)
            )
            server_time = _parse_dt(p.get("serverTime")) or datetime.now(timezone.utc)

            attrs    = p.get("attributes") or {}
            ignition = attrs.get("ignition")
            if ignition is not None:
                ignition = bool(ignition)

            # Traccar reports speed in knots — convert to km/h
            speed_knots = p.get("speed")
            speed_kph   = round(float(speed_knots) * _KNOTS_TO_KPH, 2) if speed_knots is not None else None

            sat_raw    = attrs.get("sat") or attrs.get("satellites")
            satellites = int(sat_raw) if sat_raw is not None else None

            sensors: dict = {}
            for src_key, dst_key in [
                ("batteryLevel", "battery_percent"),
                ("fuel",         "fuel_level"),
                ("rssi",         "gsm_signal"),
                ("rpm",          "rpm"),
                ("power",        "external_voltage"),
                ("distance",     "odometer"),
            ]:
                v = attrs.get(src_key)
                if v is not None:
                    sensors[dst_key] = v

            return NormalizedPosition(
                imei=imei,
                device_time=device_time,
                server_time=server_time,
                latitude=lat,
                longitude=lng,
                altitude=float(p.get("altitude") or 0),
                speed=speed_kph,
                course=float(p.get("course") or 0),
                satellites=satellites,
                ignition=ignition,
                sensors=sensors,
                raw_data={"source": "traccar"},
            )
        except Exception as e:
            logger.error(f"Traccar: parse error for {imei}: {e}")
            return None

    # ── List remote devices ───────────────────────────────────────────────────

    async def list_remote_devices(self, auth_ctx: AuthContext) -> list[RemoteDevice]:
        base    = auth_ctx.data["base_url"]
        auth    = auth_ctx.data["auth"]
        cookies = auth_ctx.data["cookies"]

        try:
            async with httpx.AsyncClient(timeout=15, auth=auth, cookies=cookies) as client:
                resp = await client.get(f"{base}/api/devices")
                resp.raise_for_status()
                raw = resp.json()

            return [
                RemoteDevice(
                    remote_id=str(d.get("id") or ""),
                    name=str(d.get("name") or d.get("id")),
                    imei=str(d.get("uniqueId") or ""),
                    license_plate=None,
                    extra={"status": d.get("status")},
                )
                for d in raw
                if d.get("id")
            ]
        except Exception as e:
            logger.error(f"Traccar: list_remote_devices error: {e}")
            return []
