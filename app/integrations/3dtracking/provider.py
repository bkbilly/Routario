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

from integrations.base import BaseIntegration, AuthContext, IntegrationField, RemoteDevice
from integrations.registry import IntegrationRegistry
from models.schemas import NormalizedPosition

logger = logging.getLogger(__name__)

_DEFAULT_BASE = "https://api.3dtracking.net/api/v1.0"

# In-memory StartId store: keyed by (user_guid, account_label)
# Persists across poll cycles for the lifetime of the process.
_start_id_store: dict[tuple, int] = {}


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

    # ── List remote devices ───────────────────────────────────────────────────

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
        base          = auth_ctx.data["base_url"]
        account_label = auth_ctx.data.get("account_label", "default")

        store_key = (user_guid, account_label)

        # Determine StartId for this call:
        #   - First ever call → omit StartId (defaults to last 24 h on the API side)
        #   - Subsequent calls → pass the StartId saved from the previous response
        current_start_id = _start_id_store.get(store_key)  # None on first call

        params: dict = {
            "UserIdGuid":         user_guid,
            "SessionId":          session_id,
            "IncludeInputOutputs": "True",
        }
        if current_start_id is not None:
            params["StartId"] = current_start_id
            logger.debug(f"3DTracking: fetching PositionsList from StartId={current_start_id}")
        else:
            logger.info("3DTracking: first poll — fetching last 24 h of positions (no StartId)")

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.get(
                    f"{base}/Data/PositionsList",
                    params=params,
                )
                resp.raise_for_status()
                data = resp.json()

        except Exception as e:
            logger.error(f"3DTracking: PositionsList request failed: {e}")
            return

        status = data.get("Status", {})
        if status.get("Result", "").lower() != "ok":
            error_code = status.get("ErrorCode", "")
            message    = status.get("Message", "")
            if error_code == "429":
                # Rate limited — do NOT advance StartId so the next poll retries
                # the same window from scratch.
                logger.warning("3DTracking: rate limited (429), will retry next cycle without advancing StartId")
            else:
                logger.warning(f"3DTracking: PositionsList failed [{error_code}]: {message}")
            return

        result = data.get("Result", {}) or {}

        # Save the new StartId immediately so the next poll continues from here
        new_start_id = result.get("StartId")
        if new_start_id is not None:
            _start_id_store[store_key] = new_start_id
            logger.debug(f"3DTracking: saved next StartId={new_start_id}")

        positions = result.get("Position") or []
        if not positions:
            logger.debug("3DTracking: no new positions in this poll cycle")
            return

        # Build a lookup of remote_id → device config so we can match IMEI
        device_by_uid: dict[str, dict] = {d["remote_id"]: d for d in devices}

        # Deduplicate: keep only the latest record per unit
        # (the API may return multiple rows per unit in one batch)
        latest_by_uid: dict[str, dict] = {}
        for pos_data in positions:
            uid = pos_data.get("Unit", {}).get("Uid", "")
            if not uid:
                continue
            # Prefer the record with the most recent GPS time
            existing = latest_by_uid.get(uid)
            if existing is None:
                latest_by_uid[uid] = pos_data
            else:
                try:
                    existing_ts = datetime.fromisoformat(existing.get("GPSTimeUtc", "1970-01-01"))
                    new_ts      = datetime.fromisoformat(pos_data.get("GPSTimeUtc",  "1970-01-01"))
                    if new_ts > existing_ts:
                        latest_by_uid[uid] = pos_data
                except ValueError:
                    pass  # keep existing on parse error

        for uid, pos_data in latest_by_uid.items():
            device = device_by_uid.get(uid)
            if not device:
                # Position for a unit not in our managed device list — skip
                continue

            pos = self._parse_position(device["imei"], pos_data)
            if pos:
                yield pos

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _parse_position(self, imei: str, p: dict) -> NormalizedPosition | None:
        """
        Parse a 3DTracking PositionsList record into a NormalizedPosition.
        Field names are PascalCase — handle common variants defensively.
        """
        try:
            lat = p.get("Latitude")
            lng = p.get("Longitude")
            if lat is None or lng is None:
                return None

            def _parse_dt(raw: str | None) -> datetime | None:
                if not raw:
                    return None
                try:
                    dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
                    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
                except ValueError:
                    return None

            # device_time — when the GPS fix was taken (UTC)
            device_time = (
                _parse_dt(p.get("GPSTimeUtc"))
                or _parse_dt(p.get("GPSTimeLocal"))
                or datetime.now(timezone.utc)
            )

            # server_time — when the 3DTracking server received the record
            server_time = _parse_dt(p.get("ServerTimeUTC")) or datetime.now(timezone.utc)

            speed   = float(p.get("Speed", 0) or 0)
            heading = float(p.get("Heading", 0) or 0)

            ignition_raw = str(p.get("Ignition", "")).lower()
            ignition     = ignition_raw == "on"

            return NormalizedPosition(
                imei=imei,
                device_time=device_time,
                server_time=server_time,
                latitude=float(lat),
                longitude=float(lng),
                speed=speed,
                course=heading,
                ignition=ignition,
                raw_data=p,
            )

        except Exception as e:
            logger.error(f"3DTracking: _parse_position error: {e}", exc_info=True)
            return None
