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

Historical positions (used for polling):
  GET /Data/PositionsList?UserIdGuid=<guid>&SessionId=<session>&IncludeInputOutputs=True&StartId=<id>
  StartId=0      → start from 7 days ago
  StartId=<omit> → start from 24 hours ago
  StartId=<N>    → continue from last seen record
  → { Status: {Result:"ok"}, Result: { Position: [...], StartId: <next> } }
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone, timedelta
from typing import AsyncIterator

import httpx

from integrations.base import BaseIntegration, AuthContext, AuthExpiredError, IntegrationField, RemoteDevice
from integrations.registry import IntegrationRegistry
from models.schemas import NormalizedPosition

logger = logging.getLogger(__name__)

_BASE_URL = "https://api.3dtracking.net/api/v1.0"

# In-memory StartId store: keyed by (user_guid, account_label)
# Persists across poll cycles for the lifetime of the process.
_start_id_store: dict[tuple, int] = {}

# Per-device last-seen timestamp: keyed by (user_guid, account_label, unit_uid)
# Used to deduplicate positions returned by the bulk PositionsList endpoint.
_last_seen: dict[tuple, datetime] = {}


@IntegrationRegistry.register("3dtracking")
class ThreeDTrackingIntegration(BaseIntegration):

    PROVIDER_ID           = "3dtracking"
    DISPLAY_NAME          = "3D Tracking"
    POLL_INTERVAL_SECONDS = 30

    FIELDS = [
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
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{_BASE_URL}/Authentication/UserAuthenticate",
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
            },
            token_expires_at=expires_at,
        )

    # ── List remote devices ───────────────────────────────────────────────────

    async def list_remote_devices(self, auth_ctx: AuthContext) -> list[RemoteDevice]:
        session_id = auth_ctx.data["session_id"]
        user_guid  = auth_ctx.data["user_guid"]

        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(
                    f"{_BASE_URL}/Units/Unit/List",
                    params={
                        "UserIdGuid": user_guid,
                        "SessionId":  session_id,
                    },
                )
                resp.raise_for_status()
                data = resp.json()

            if data.get("Status", {}).get("Result", "").lower() != "ok":
                logger.warning(f"3DTracking: Unit/List failed: {data.get('Status', {}).get('Message')}")
                return []

            units = data.get("Result", []) or []
            return [
                RemoteDevice(
                    remote_id=u["Uid"],
                    name=u.get("Name", u["Uid"]),
                    imei=u.get("IMEI") or u.get("Imei") or None,
                )
                for u in units
                if u.get("Uid")
            ]

        except Exception as e:
            logger.error(f"3DTracking: list_remote_devices error: {e}", exc_info=True)
            return []

    # ── Fetch positions ───────────────────────────────────────────────────────

    async def fetch_positions(
        self,
        auth_ctx: AuthContext,
        devices: list[dict],
    ) -> AsyncIterator[NormalizedPosition]:
        session_id    = auth_ctx.data["session_id"]
        user_guid     = auth_ctx.data["user_guid"]
        account_label = auth_ctx.data.get("account_label", "default")

        # StartId is per-account (API constraint), but last_seen is per-device
        account_key = (user_guid, account_label)
        current_start_id = _start_id_store.get(account_key)

        params: dict = {
            "UserIdGuid":          user_guid,
            "SessionId":           session_id,
            "IncludeInputOutputs": "True",
        }
        if current_start_id is not None:
            params["StartId"] = current_start_id
        else:
            logger.info("3DTracking: first poll — fetching last 24 h of positions (no StartId)")

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.get(
                    f"{_BASE_URL}/Data/PositionsList",
                    params=params,
                )
                resp.raise_for_status()
                data = resp.json()

        except Exception as e:
            logger.error(f"3DTracking: PositionsList request failed: {e}")
            return

        status = data.get("Status", {})
        if status.get("Result", "").lower() != "ok":
            error_code = str(status.get("ErrorCode", ""))
            message    = status.get("Message", "")
            if error_code == "429":
                logger.warning("3DTracking: rate limited (429), will retry next cycle")
            elif error_code in ("401", "403") or "session" in message.lower() or "auth" in message.lower():
                _start_id_store.pop(account_key, None)
                logger.warning(
                    f"3DTracking: session rejected [{error_code}]: {message} — evicting auth cache"
                )
                raise AuthExpiredError(f"3DTracking session invalid: {message}")
            else:
                logger.warning(f"3DTracking: PositionsList failed [{error_code}]: {message}")
            return

        result = data.get("Result", {}) or {}

        new_start_id = result.get("StartId")
        if new_start_id is not None:
            _start_id_store[account_key] = new_start_id

        positions = result.get("Position") or []
        if not positions:
            logger.debug("3DTracking: no new positions in this poll cycle")
            return

        device_by_uid: dict[str, dict] = {d["remote_id"]: d for d in devices}

        for pos_data in positions:
            uid = pos_data.get("Unit", {}).get("Uid", "")
            if not uid:
                continue

            device = device_by_uid.get(uid)
            if not device:
                continue

            pos = self._parse_position(device["imei"], pos_data)
            if not pos:
                continue

            # Per-device deduplication using device_time
            device_key = (user_guid, account_label, uid)
            last_seen  = _last_seen.get(device_key)
            if last_seen is not None and pos.device_time <= last_seen:
                logger.debug(f"3DTracking: skipping duplicate for {uid} at {pos.device_time}")
                continue

            _last_seen[device_key] = pos.device_time
            yield pos

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _parse_position(self, imei: str, p: dict) -> NormalizedPosition | None:
        """
        Parse a 3DTracking PositionsList record into a NormalizedPosition.

        Top-level fields of interest (PascalCase):
          Latitude, Longitude, Speed, SpeedMeasure, Heading, Ignition,
          Odometer, EngineTime, EngineStatus, Address,
          ServerTimeUTC, GPSTimeUtc, GPSTimeLocal,
          Driver  { Uid, FirstName, LastName, Code }
          InputOutputs  [ { SystemName, Description, UserDescription, Active } ]
        """
        try:
            lat = p.get("Latitude")
            lng = p.get("Longitude")
            if lat is None or lng is None:
                return None
            lat = float(lat)
            lng = float(lng)
            if lat == 0.0 and lng == 0.0:
                return None

            # ── Timestamps ────────────────────────────────────────────────────

            def _parse_dt(raw) -> datetime | None:
                if not raw:
                    return None
                try:
                    dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
                    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
                except ValueError:
                    return None

            device_time = (
                _parse_dt(p.get("GPSTimeUtc"))
                or _parse_dt(p.get("GPSTimeLocal"))
                or datetime.now(timezone.utc)
            )
            # server_time = when we received and saved the record, not the
            # timestamp reported by the 3DTracking API.
            server_time = datetime.now(timezone.utc)

            # ── Motion fields ─────────────────────────────────────────────────

            speed_raw    = p.get("Speed")
            speed_kph    = float(speed_raw) if speed_raw is not None else None
            # API returns SpeedMeasure; if it ever comes back as "mph" convert it
            if speed_kph is not None:
                measure = str(p.get("SpeedMeasure") or "kph").lower()
                if measure == "mph":
                    speed_kph = round(speed_kph * 1.60934, 2)

            course   = float(p.get("Heading") or 0)
            altitude = float(p.get("Altitude") or 0)

            # ── Ignition ──────────────────────────────────────────────────────
            # The API sends "on" / "off" as a string
            ignition_raw = str(p.get("Ignition") or "").lower()
            ignition: bool | None = None
            if ignition_raw in ("on", "true", "1"):
                ignition = True
            elif ignition_raw in ("off", "false", "0"):
                ignition = False

            # ── Sensors dict ──────────────────────────────────────────────────
            sensors: dict = {}

            # Odometer (km)
            odometer = p.get("Odometer")
            if odometer is not None:
                sensors["odometer"] = float(odometer)

            # Engine running time in seconds
            engine_time = p.get("EngineTime")
            if engine_time is not None:
                sensors["engine_time"] = int(engine_time)

            # Engine status string: "idling", "running", "off", …
            engine_status = p.get("EngineStatus")
            if engine_status:
                sensors["engine_status"] = str(engine_status)

            # Human-readable address from reverse-geocoding (if present)
            address = p.get("Address")
            if address:
                sensors["address"] = str(address)

            # Driver info — only populate if at least a UID is present
            driver = p.get("Driver") or {}
            driver_uid = driver.get("Uid") or ""
            if driver_uid:
                sensors["driver_uid"]        = driver_uid
                sensors["driver_first_name"] = driver.get("FirstName") or ""
                sensors["driver_last_name"]  = driver.get("LastName") or ""
                sensors["driver_code"]       = driver.get("Code") or ""

            # InputOutputs — these are the various digital/analog inputs and outputs
            io_list = p.get("InputOutputs") or []
            io_key_counts: dict[str, int] = {}  # track duplicates to avoid collisions
            for io in io_list:
                sys_name = str(io.get("SystemName") or "").strip()
                if not sys_name:
                    continue
                active = bool(io.get("Active", False))

                # Resolve label: UserDescription → Description → SystemName
                label = (
                    str(io.get("UserDescription") or "").strip()
                    or str(io.get("Description") or "").strip()
                    or sys_name
                )

                # Normalise to a safe sensor key
                key = label.lower().replace(" ", "_").replace("/", "_").replace("-", "_")

                # Deduplicate: if this key was already used, append a counter
                if key in io_key_counts:
                    io_key_counts[key] += 1
                    key = f"{key}_{io_key_counts[key]}"
                else:
                    io_key_counts[key] = 0

                sensors[key] = active

            return NormalizedPosition(
                imei=imei,
                device_time=device_time,
                server_time=server_time,
                latitude=lat,
                longitude=lng,
                altitude=altitude,
                speed=speed_kph,
                course=course,
                satellites=None,   # 3DTracking API does not expose satellite count
                ignition=ignition,
                sensors=sensors,
                raw_data={"source": "3dtracking"},
            )
        except Exception as e:
            logger.error(f"3DTracking: parse error for {imei}: {e}", exc_info=True)
            return None
