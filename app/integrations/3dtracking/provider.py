"""
app/integrations/3dtracking/provider.py

3D Tracking integration.
API base: https://api.3dtracking.net/api/v1.0/

Auth:
  GET /Authentication/UserAuthenticate?UserName=<user>&Password=<pass>
  → { Status: {Result:"ok"}, Result: { UserIdGuid, SessionId } }

List units:
  GET /Units/Unit/List?UserIdGuid=<guid>&SessionId=<session>
  → { Status: {Result:"ok"}, Result: [ { Uid, Name, IMEI, Status, ... } ] }

Position (per unit):
  GET /Units/Unit/LastPosition?UserIdGuid=<guid>&SessionId=<session>&UnitUid=<uid>
  → { Status: {Result:"ok"}, Result: { Latitude, Longitude, Speed, ... } }
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone, timedelta
from typing import AsyncIterator

import httpx

from integrations.base import BaseIntegration, AuthContext, IntegrationField, RemoteDevice
from integrations.registry import IntegrationRegistry
from models.schemas import NormalizedPosition

logger = logging.getLogger(__name__)

_DEFAULT_BASE = "https://api.3dtracking.net/api/v1.0"


@IntegrationRegistry.register("3dtracking")
class ThreeDTrackingIntegration(BaseIntegration):

    PROVIDER_ID           = "3dtracking"
    DISPLAY_NAME          = "3D Tracking"
    POLL_INTERVAL_SECONDS = 30

    FIELDS = [
        IntegrationField(
            key="base_url",
            label="API Base URL",
            field_type="url",
            required=False,
            placeholder=_DEFAULT_BASE,
            help_text="Leave blank to use the default 3D Tracking API endpoint.",
            default=_DEFAULT_BASE,
        ),
        IntegrationField(
            key="username",
            label="Username",
            field_type="text",
            required=True,
            placeholder="your@email.com",
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
        base = (credentials.get("base_url") or _DEFAULT_BASE).rstrip("/")

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{base}/Authentication/UserAuthenticate",
                params={
                    "UserName": credentials["username"],
                    "Password": credentials["password"],
                },
            )
            resp.raise_for_status()
            data = resp.json()

        status = data.get("Status", {})
        if status.get("Result", "").lower() != "ok":
            raise ValueError(
                f"3DTracking auth failed: {status.get('Message', 'Unknown error')}"
            )

        result     = data.get("Result", {})
        session_id = result.get("SessionId")
        user_guid  = result.get("UserIdGuid")

        if not session_id:
            raise ValueError("3DTracking: no SessionId in auth response")

        # Sessions typically last 24 hours — refresh with a 30 min safety buffer
        expires_at = datetime.now(timezone.utc) + timedelta(hours=23, minutes=30)

        logger.info(f"3DTracking: authenticated user {user_guid}, session {session_id[:8]}…")

        return AuthContext(
            data={
                "session_id": session_id,
                "user_guid":  user_guid,
                "base_url":   base,
            },
            token_expires_at=expires_at,
        )

    # ── List remote units ─────────────────────────────────────────────────────

    async def list_remote_devices(self, auth_ctx: AuthContext) -> list[RemoteDevice]:
        session_id = auth_ctx.data["session_id"]
        user_guid  = auth_ctx.data["user_guid"]
        base       = auth_ctx.data["base_url"]

        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(
                    f"{base}/Units/Unit/List",
                    params={
                        "UserIdGuid": user_guid,
                        "SessionId":  session_id,
                    },
                )
                resp.raise_for_status()
                data = resp.json()

            if data.get("Status", {}).get("Result", "").lower() != "ok":
                logger.warning(
                    f"3DTracking: Unit/List failed: "
                    f"{data.get('Status', {}).get('Message')}"
                )
                return []

            units = data.get("Result") or []
            if not isinstance(units, list):
                units = [units]

            result = []
            for u in units:
                uid   = str(u.get("Uid") or "")
                name  = str(u.get("Name") or uid)
                imei  = str(u.get("IMEI") or "")
                plate = u.get("LicensePlate") or u.get("RegistrationNumber") or name

                result.append(RemoteDevice(
                    remote_id=uid,
                    name=name,
                    imei=imei if imei else None,
                    license_plate=plate,
                    extra={
                        "status":       u.get("Status"),
                        "group":        u.get("GroupName"),
                        "company":      u.get("CompanyName"),
                        "phone":        u.get("PhoneNumber"),
                    },
                ))
            return result

        except Exception as e:
            logger.error(f"3DTracking: list_remote_devices error: {e}", exc_info=True)
            return []

    # ── Fetch positions ───────────────────────────────────────────────────────

    async def fetch_positions(
        self,
        auth_ctx: AuthContext,
        devices: list[dict],
    ) -> AsyncIterator[NormalizedPosition]:
        session_id = auth_ctx.data["session_id"]
        user_guid  = auth_ctx.data["user_guid"]
        base       = auth_ctx.data["base_url"]

        async with httpx.AsyncClient(timeout=15) as client:
            for device in devices:
                unit_uid = device["remote_id"]
                imei     = device["imei"]
                try:
                    resp = await client.get(
                        f"{base}/Units/Unit/LastPosition",
                        params={
                            "UserIdGuid": user_guid,
                            "SessionId":  session_id,
                            "UnitUid":    unit_uid,
                        },
                    )
                    resp.raise_for_status()
                    data = resp.json()

                    if data.get("Status", {}).get("Result", "").lower() != "ok":
                        logger.warning(
                            f"3DTracking: LastPosition failed for unit {unit_uid}: "
                            f"{data.get('Status', {}).get('Message')}"
                        )
                        continue

                    pos_data = data.get("Result")
                    if not pos_data:
                        continue

                    pos = self._parse_position(imei, pos_data)
                    if pos:
                        yield pos

                except Exception as e:
                    logger.error(f"3DTracking: error fetching unit {unit_uid}: {e}")

    def _parse_position(self, imei: str, p: dict) -> NormalizedPosition | None:
        """
        Parse a 3DTracking LastPosition record.
        Field names are PascalCase — handle common variants defensively.
        """
        try:
            def _get(*keys):
                for k in keys:
                    v = p.get(k) or p.get(k.lower()) or p.get(k.upper())
                    if v is not None:
                        return v
                return None

            lat = float(_get("Latitude",  "Lat") or 0)
            lng = float(_get("Longitude", "Lon", "Lng") or 0)

            if lat == 0.0 and lng == 0.0:
                return None

            # Timestamp — try common field names, handle /Date(ms)/ format
            ts_raw = _get("GpsTime", "DeviceTime", "Timestamp", "Time", "RecordTime", "PositionTime")
            if ts_raw:
                try:
                    if str(ts_raw).startswith("/Date("):
                        ms = int(str(ts_raw)[6:].split(")")[0].split("+")[0].split("-")[0])
                        device_time = datetime.fromtimestamp(ms / 1000, tz=timezone.utc).replace(tzinfo=None)
                    else:
                        device_time = datetime.fromisoformat(
                            str(ts_raw).replace("Z", "+00:00")
                        ).astimezone(timezone.utc).replace(tzinfo=None)
                except (ValueError, OverflowError):
                    device_time = datetime.utcnow()
            else:
                device_time = datetime.utcnow()

            # Ignition
            ignition = _get("Ignition", "IgnitionStatus", "EngineOn", "Engine")
            if ignition is not None:
                ignition = bool(ignition) if isinstance(ignition, bool) \
                    else str(ignition).lower() in ("1", "true", "on")

            speed  = float(_get("Speed",   "GpsSpeed",  "SpeedKmh") or 0)
            course = float(_get("Heading", "Course",    "Direction", "Bearing") or 0)
            alt    = float(_get("Altitude", "Alt") or 0)
            sats   = int(  _get("Satellites", "GpsSatellites", "Sat") or 0)

            sensors: dict = {}
            for src, dst in [
                ("BatteryVoltage",  "battery_voltage"),
                ("ExternalVoltage", "external_voltage"),
                ("FuelLevel",       "fuel_level"),
                ("Odometer",        "odometer"),
                ("Temperature",     "temperature"),
                ("GsmSignal",       "gsm_signal"),
                ("Rpm",             "rpm"),
            ]:
                v = _get(src)
                if v is not None:
                    try:
                        sensors[dst] = float(v)
                    except (ValueError, TypeError):
                        sensors[dst] = v

            return NormalizedPosition(
                imei=imei,
                device_time=device_time,
                server_time=datetime.now(timezone.utc),
                latitude=lat,
                longitude=lng,
                altitude=alt,
                speed=speed,
                course=course,
                satellites=sats,
                ignition=ignition,
                sensors=sensors,
                raw_data={"source": "3dtracking"},
            )

        except Exception as e:
            logger.error(f"3DTracking: parse error for {imei}: {e}", exc_info=True)
            return None
