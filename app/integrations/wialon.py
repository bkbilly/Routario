"""
app/integrations/wialon.py

Wialon (Gurtam) cloud integration.
API base: https://hst-api.wialon.com/wialon/ajax.html  (hosted)
          https://<your-host>/wialon/ajax.html          (on-premise)

Auth:
  POST svc=token/login  params={"token":"<api_token>"}
  → { "eid": "<session_id>", "user": { ... } }
  Sessions are valid for the lifetime of the token unless revoked.

List units:
  POST svc=core/search_items
       params={"spec":{"itemsType":"avl_unit","propName":"sys_name",
                        "propValueMask":"*","sortType":"sys_name"},
               "force":1,"flags":1025,"from":0,"to":0}
  → { "items": [ { "id": <int>, "nm": <str>, "uid": <str/imei>, ... } ] }

Last messages (batch):
  POST svc=core/batch
       params={"params":[
           {"svc":"avl_evts","params":{}},
           ...
       ],"flags":0}

  For per-unit last position:
  POST svc=messages/load_last
       params={"itemId":<unit_id>,"lastTime":0,"lastCount":1,
               "flags":0x0400,"flagsMask":0xFF00,"loadCount":1}
  → { "messages": [ { "t":<unix>, "pos": { "x":<lon>, "y":<lat>,
                       "z":<alt>, "s":<speed_km_h>, "c":<course>,
                       "sc":<sats> }, "p": { ... sensors ... } } ] }

  Alternatively, use the avl_evts endpoint after subscribing to the data
  layer — but load_last is simpler and stateless for a polling approach.

Speed units: Wialon returns speed already in km/h.
Time:        Unix epoch (seconds, UTC).
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

# Default Wialon hosted API endpoint.  On-premise users override via the
# optional server_url credential field.
_DEFAULT_BASE = "https://hst-api.wialon.com"

# In-memory last-seen tracker: (eid_prefix, unit_id) → last unix timestamp
_last_seen: dict[tuple, int] = {}


@IntegrationRegistry.register("wialon")
class WialonIntegration(BaseIntegration):

    PROVIDER_ID           = "wialon"
    DISPLAY_NAME          = "Wialon (Gurtam)"
    POLL_INTERVAL_SECONDS = 30

    FIELDS = [
        IntegrationField(
            key="token",
            label="Wialon API Token",
            field_type="password",
            required=True,
            placeholder="your_wialon_token_here",
            help_text=(
                "API token generated in Wialon under User Settings → API. "
                "Requires at minimum: Online Tracking + General Information access."
            ),
        ),
        IntegrationField(
            key="server_url",
            label="Server URL (optional)",
            field_type="url",
            required=False,
            placeholder="https://hst-api.wialon.com",
            help_text=(
                "Leave blank for Wialon Hosting. "
                "On-premise / Wialon Local users: enter your server base URL."
            ),
            default="",
        ),
    ]

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _base(self, auth_ctx: AuthContext) -> str:
        return auth_ctx.data["base_url"]

    def _eid(self, auth_ctx: AuthContext) -> str:
        return auth_ctx.data["eid"]

    async def _call(
        self,
        client: httpx.AsyncClient,
        base: str,
        eid: str,
        svc: str,
        params: dict,
    ) -> dict:
        """Execute a single Wialon Remote API call."""
        import json as _json
        resp = await client.post(
            f"{base}/wialon/ajax.html",
            data={
                "svc":    svc,
                "params": _json.dumps(params),
                "sid":    eid,
            },
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()
        # Wialon wraps errors as {"error": <code>, "reason": "..."}
        if isinstance(data, dict) and "error" in data:
            err_code = data["error"]
            reason   = data.get("reason", "")
            if err_code in (1, 4):  # 1=Invalid session, 4=User has been blocked/token revoked
                raise AuthExpiredError(f"Wialon session invalid (error {err_code}): {reason}")
            raise RuntimeError(f"Wialon API error {err_code}: {reason}")
        return data

    # ── Auth ──────────────────────────────────────────────────────────────────

    async def authenticate(self, credentials: dict) -> AuthContext:
        import json as _json
        token    = credentials["token"].strip()
        base_url = (credentials.get("server_url") or _DEFAULT_BASE).rstrip("/")

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{base_url}/wialon/ajax.html",
                data={
                    "svc":    "token/login",
                    "params": _json.dumps({"token": token}),
                },
            )
            resp.raise_for_status()
            data = resp.json()

        if "error" in data:
            raise ValueError(
                f"Wialon auth failed (error {data['error']}): {data.get('reason', '')}"
            )

        eid = data.get("eid")
        if not eid:
            raise ValueError("Wialon: no session id (eid) returned by token/login")

        logger.info(f"Wialon: authenticated, eid={eid[:8]}…")
        return AuthContext(
            data={
                "eid":      eid,
                "base_url": base_url,
                "eid_pfx":  eid[:8],
            },
            token_expires_at=None,  # Wialon sessions are tied to the token lifetime
        )

    # ── List remote devices ───────────────────────────────────────────────────

    async def list_remote_devices(self, auth_ctx: AuthContext) -> list[RemoteDevice]:
        base = self._base(auth_ctx)
        eid  = self._eid(auth_ctx)

        try:
            async with httpx.AsyncClient(timeout=20) as client:
                data = await self._call(
                    client, base, eid,
                    svc="core/search_items",
                    params={
                        "spec": {
                            "itemsType":     "avl_unit",
                            "propName":      "sys_name",
                            "propValueMask": "*",
                            "sortType":      "sys_name",
                        },
                        "force": 1,
                        "flags": 1025,   # 1=base info, 1024=unit props (includes uid/IMEI)
                        "from":  0,
                        "to":    0,
                    },
                )

            devices = []
            for item in (data.get("items") or []):
                unit_id = str(item.get("id", ""))
                name    = item.get("nm") or unit_id
                # uid field contains the hardware UID / IMEI reported by the device
                imei    = str(item.get("uid") or "").strip() or None
                # license plate may be in the profile properties dict
                props       = item.get("prp") or {}
                lic_plate   = props.get("lic_reg_num") or None
                vehicle_type = props.get("vehicle_type") or None

                devices.append(RemoteDevice(
                    remote_id=unit_id,
                    name=name,
                    imei=imei,
                    license_plate=lic_plate,
                    vehicle_type=vehicle_type,
                ))
            return devices

        except AuthExpiredError:
            raise
        except Exception as e:
            logger.error(f"Wialon: list_remote_devices error: {e}", exc_info=True)
            return []

    # ── Fetch positions ───────────────────────────────────────────────────────

    async def fetch_positions(
        self,
        auth_ctx: AuthContext,
        devices: list[dict],
    ) -> AsyncIterator[NormalizedPosition]:
        base    = self._base(auth_ctx)
        eid     = self._eid(auth_ctx)
        eid_pfx = auth_ctx.data["eid_pfx"]

        async with httpx.AsyncClient(timeout=30) as client:
            for device in devices:
                unit_id   = str(device["remote_id"])
                imei      = device["imei"]
                cache_key = (eid_pfx, unit_id)
                last_ts   = _last_seen.get(cache_key, 0)

                try:
                    data = await self._call(
                        client, base, eid,
                        svc="messages/load_last",
                        params={
                            "itemId":    int(unit_id),
                            "lastTime":  0,
                            "lastCount": 1,
                            "flags":     0x0400,      # position data
                            "flagsMask": 0xFF00,
                            "loadCount": 1,
                        },
                    )
                except AuthExpiredError:
                    raise
                except Exception as e:
                    logger.error(f"Wialon: load_last error for unit {unit_id}: {e}")
                    continue

                messages = data.get("messages") or []
                if not messages:
                    logger.debug(f"Wialon: no messages for unit {unit_id}")
                    continue

                msg = messages[-1]   # most recent
                msg_ts = int(msg.get("t") or 0)

                # Skip if we've already processed this record
                if msg_ts <= last_ts:
                    continue

                pos = self._parse_message(imei, msg)
                if pos:
                    _last_seen[cache_key] = msg_ts
                    yield pos

    # ── Message parser ────────────────────────────────────────────────────────

    def _parse_message(self, imei: str, msg: dict) -> NormalizedPosition | None:
        try:
            pos_data = msg.get("pos")
            if not pos_data:
                return None

            lat = float(pos_data.get("y") or 0)
            lng = float(pos_data.get("x") or 0)
            if lat == 0.0 and lng == 0.0:
                return None

            ts          = int(msg.get("t") or 0)
            device_time = datetime.fromtimestamp(ts, tz=timezone.utc) if ts else datetime.now(timezone.utc)
            server_time = datetime.now(timezone.utc)

            altitude  = float(pos_data.get("z") or 0) or None
            speed_kph = float(pos_data.get("s") or 0)
            course    = float(pos_data.get("c") or 0)
            satellites = int(pos_data.get("sc") or 0) or None

            # params dict carries sensor / I/O data
            params   = msg.get("p") or {}
            sensors: dict = {}
            ignition: bool | None = None

            # Common Wialon parameter names
            _sensor_map = [
                ("engine_ignition_status",  "ignition_raw"),
                ("external_powersource_voltage", "external_voltage"),
                ("battery_voltage",         "battery_voltage"),
                ("battery_charging_status", "charging"),
                ("vehicle_mileage",         "odometer"),
                ("can_fuel_level",          "fuel_level"),
                ("gsm_signal_level",        "gsm_signal"),
                ("engine_rpm",              "rpm"),
                ("din1",                    "digital_in_1"),
                ("din2",                    "digital_in_2"),
            ]
            for src, dst in _sensor_map:
                v = params.get(src)
                if v is not None:
                    sensors[dst] = v

            # Resolve ignition from dedicated param or fallback to digital_in_1
            raw_ign = params.get("engine_ignition_status") or params.get("din1")
            if raw_ign is not None:
                try:
                    ignition = bool(int(raw_ign))
                except (ValueError, TypeError):
                    ignition = bool(raw_ign)

            # Pass through any unlisted params
            known = {src for src, _ in _sensor_map}
            for k, v in params.items():
                if k not in known and k not in sensors:
                    sensors[k] = v

            return NormalizedPosition(
                imei=imei,
                device_time=device_time,
                server_time=server_time,
                latitude=lat,
                longitude=lng,
                altitude=altitude,
                speed=speed_kph if speed_kph else None,
                course=course,
                satellites=satellites,
                ignition=ignition,
                sensors=sensors,
                raw_data={"source": "wialon"},
            )

        except Exception as e:
            logger.error(f"Wialon: parse error for {imei}: {e}", exc_info=True)
            return None

    # ── Credentials test ──────────────────────────────────────────────────────

    async def test_credentials(self, credentials: dict) -> tuple[bool, str]:
        try:
            ctx = await self.authenticate(credentials)
            eid = ctx.data["eid"]
            return True, f"Connected — session {eid[:8]}…"
        except Exception as e:
            return False, str(e)
