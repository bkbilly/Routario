"""
app/integrations/traccar.py

Traccar integration.
Traccar is self-hosted — the user provides their own server URL.
API docs: https://www.traccar.org/api-reference/

Auth:   Basic auth (username + password) on every request.
        Traccar also supports session tokens — we use the session endpoint
        to get a JSESSIONID cookie for the lifetime of the poll session.

Poll:   GET /api/positions?deviceId=<id>&from=<ISO>&to=<ISO>
        Returns ALL position records in the given time window, not just the
        latest one.  On the first poll we request the last 24 hours; on every
        subsequent poll we request from the last-seen timestamp to now, so no
        records are missed or re-processed.
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

_KNOTS_TO_KPH = 1.852

# In-memory store of the latest device_time successfully processed, keyed by
# (base_url, remote_device_id).  Used as the `from` parameter on the next poll
# so we fetch every new record rather than just the current snapshot.
_last_seen: dict[tuple, datetime] = {}


def _normalize_url(url: str) -> str:
    u = (url or "").strip()
    if u and not u.startswith(("http://", "https://")):
        u = f"http://{u}"
    return u.rstrip("/")


@IntegrationRegistry.register("traccar")
class TraccarIntegration(BaseIntegration):

    PROVIDER_ID           = "traccar"
    DISPLAY_NAME          = "Traccar"
    POLL_INTERVAL_SECONDS = 30
    SUPPORTS_COMMANDS     = True

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
        base = _normalize_url(credentials.get("server_url", ""))
        auth = (credentials["username"], credentials["password"])

        try:
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
        except httpx.ConnectError as e:
            logger.error(f"Traccar connection error to '{base}': {e}")
            raise Exception(f"Cannot resolve or connect to Traccar server at '{base}'. Please verify your Server URL (DNS / network issue).") from e
        except httpx.HTTPStatusError as e:
            if e.response.status_code in (401, 403):
                raise Exception("Traccar authentication failed: Invalid username or password.") from e
            raise Exception(f"Traccar server HTTP error ({e.response.status_code}): {e.response.text}") from e
        except Exception as e:
            logger.error(f"Traccar auth error: {e}")
            raise

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

        now = datetime.now(timezone.utc)

        # Collect per-device time windows and issue one request per device so
        # each `from` can be individualised.  Traccar supports multiple
        # deviceId params in a single call but the `from`/`to` window is
        # global — we therefore batch devices that share the same window and
        # fall back to individual calls for those with different last-seen times.
        #
        # Simpler approach used here: one bulk call using the earliest last-seen
        # time across all devices.  Any extra (already-processed) records that
        # come back for devices whose cursor is ahead are filtered out by the
        # per-device _last_seen check below.
        earliest_from: datetime | None = None
        for rid in id_map:
            cache_key = (base, rid)
            imei = id_map[rid]

            # Use the DB floor if it's newer than the in-memory cursor
            device_dict = next((d for d in devices if d["remote_id"] == rid), {})
            floor = device_dict.get("last_seen_floor")
            last  = _last_seen.get(cache_key)

            if floor and (last is None or floor > last):
                last = floor

            if last is None:
                candidate = now - timedelta(hours=24)
            else:
                candidate = last
            if earliest_from is None or candidate < earliest_from:
                earliest_from = candidate

        # `from` is exclusive on some Traccar versions — subtract one second to
        # make sure we don't miss the record at exactly `earliest_from`.
        from_dt = (earliest_from - timedelta(seconds=1)).astimezone(timezone.utc)

        params: list[tuple] = [("deviceId", rid) for rid in id_map]
        params.append(("from", from_dt.strftime("%Y-%m-%dT%H:%M:%SZ")))
        params.append(("to",   now.strftime("%Y-%m-%dT%H:%M:%SZ")))

        try:
            async with httpx.AsyncClient(
                timeout=30,
                auth=auth,
                cookies=cookies,
            ) as client:
                resp = await client.get(f"{base}/api/positions", params=params)
                resp.raise_for_status()
                positions = resp.json()

        except Exception as e:
            logger.error(f"Traccar: bulk fetch error: {e}")
            return

        if not positions:
            logger.debug("Traccar: no new positions in this poll cycle")
            return

        # Sort ascending by fixTime so we process and store records in order
        def _sort_key(p: dict) -> str:
            return p.get("fixTime") or p.get("deviceTime") or ""

        positions.sort(key=_sort_key)

        for pos_data in positions:
            device_id = str(pos_data.get("deviceId", ""))
            imei      = id_map.get(device_id)
            if not imei:
                continue

            pos = self._parse_position(imei, pos_data)
            if not pos:
                continue

            # Skip records we have already processed (can happen when the bulk
            # `from` window is earlier than this device's individual cursor).
            cache_key = (base, device_id)
            last = _last_seen.get(cache_key)
            if last is not None and pos.device_time <= last:
                continue

            # Advance the cursor for this device
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
            server_time = datetime.now(timezone.utc)

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

    # ── Commands ──────────────────────────────────────────────────────────────

    async def get_command_support(self, auth_ctx: AuthContext, remote_id: str) -> dict:
        base    = auth_ctx.data["base_url"]
        auth    = auth_ctx.data["auth"]
        cookies = auth_ctx.data["cookies"]

        saved_commands = []
        available_commands = ["custom"]
        command_info = {
            "custom": {
                "description": "Send a custom text command to the device via Traccar",
                "example": "YOUR_COMMAND_DATA",
                "requires_params": True,
            }
        }

        dev_id = int(remote_id) if str(remote_id).isdigit() else remote_id

        try:
            async with httpx.AsyncClient(timeout=15, auth=auth, cookies=cookies) as client:
                raw_saved = []
                # Try GET /api/commands?deviceId=... and GET /api/commands/send?deviceId=...
                for endpoint in [f"{base}/api/commands", f"{base}/api/commands/send"]:
                    try:
                        resp_saved = await client.get(endpoint, params={"deviceId": dev_id})
                        if resp_saved.status_code == 200:
                            data = resp_saved.json()
                            if isinstance(data, list) and len(data) > 0:
                                raw_saved = data
                                break
                    except Exception:
                        pass

                # Fallback: try GET /api/commands without deviceId param
                if not raw_saved:
                    try:
                        resp_all = await client.get(f"{base}/api/commands")
                        if resp_all.status_code == 200:
                            data = resp_all.json()
                            if isinstance(data, list):
                                raw_saved = data
                    except Exception:
                        pass

                seen_ids = set()
                for item in raw_saved:
                    if not isinstance(item, dict):
                        continue
                    cmd_id = item.get("id")
                    if cmd_id is None or cmd_id in seen_ids:
                        continue
                    seen_ids.add(cmd_id)
                    cmd_type = item.get("type", "custom")
                    name = item.get("description") or f"Saved Command #{cmd_id} ({cmd_type})"
                    saved_commands.append({
                        "id": cmd_id,
                        "name": name,
                        "type": cmd_type,
                        "description": f"Traccar saved command: {name}",
                        "attributes": item.get("attributes", {}),
                    })
                    saved_key = f"saved:{cmd_id}"
                    available_commands.append(saved_key)
                    command_info[saved_key] = {
                        "description": f"Traccar saved command: {name}",
                        "example": f"Saved command #{cmd_id}",
                        "requires_params": False,
                    }

                # Fetch supported command types for device
                try:
                    resp_types = await client.get(f"{base}/api/commands/types", params={"deviceId": dev_id})
                    if resp_types.status_code == 200:
                        raw_types = resp_types.json()
                        if isinstance(raw_types, list):
                            for item in raw_types:
                                ctype = item.get("type") if isinstance(item, dict) else str(item)
                                if ctype and ctype != "custom" and ctype not in available_commands:
                                    available_commands.append(ctype)
                                    command_info[ctype] = {
                                        "description": f"Traccar standard command: {ctype}",
                                        "example": ctype,
                                        "requires_params": False,
                                    }
                except Exception:
                    pass
        except Exception as e:
            logger.error(f"Traccar: get_command_support error for remote_id {remote_id}: {e}")

        return {
            "supports_commands": True,
            "available_commands": available_commands,
            "command_info": command_info,
            "saved_commands": saved_commands,
        }

    async def send_command(
        self,
        auth_ctx: AuthContext,
        remote_id: str,
        command_type: str,
        payload: str = "",
        saved_command_id: int | None = None,
        attributes: dict | None = None,
    ) -> dict:
        base    = auth_ctx.data["base_url"]
        auth    = auth_ctx.data["auth"]
        cookies = auth_ctx.data["cookies"]

        dev_id = int(remote_id) if str(remote_id).isdigit() else remote_id
        body: dict = {"deviceId": dev_id}

        if saved_command_id is not None:
            body["id"] = int(saved_command_id)
        elif command_type.startswith("saved:"):
            try:
                body["id"] = int(command_type.split(":", 1)[1])
            except ValueError:
                body["type"] = command_type
        elif command_type == "custom":
            body["type"] = "custom"
            body["attributes"] = {"data": payload}
        else:
            body["type"] = command_type
            if payload:
                body["attributes"] = {"data": payload}

        if attributes:
            body.setdefault("attributes", {}).update(attributes)

        async with httpx.AsyncClient(timeout=15, auth=auth, cookies=cookies) as client:
            resp = await client.post(f"{base}/api/commands/send", json=body)
            if resp.status_code >= 400:
                err_msg = resp.text
                try:
                    err_json = resp.json()
                    err_msg = err_json.get("message") or err_msg
                except Exception:
                    pass
                raise Exception(f"Traccar error ({resp.status_code}): {err_msg}")

            if resp.status_code == 204 or not resp.content:
                return {"status": "sent", "message": "Command executed successfully on Traccar"}
            try:
                return resp.json()
            except Exception:
                return {"status": "sent", "message": resp.text}

