"""
app/integrations/google_findmy.py

Google Find My Device / Find Hub integration.

Authentication:
  Requires the contents of Auth/secrets.json from GoogleFindMyTools:
  https://github.com/leonboe1/GoogleFindMyTools

  After running the tool's E2EE location-decryption flow the file also contains
  owner_key used for decrypting location reports.

API:
  Google Nova API (protobuf over HTTPS):
    Device list:      POST /nova/nbe_list_devices
    Location trigger: POST /nova/nbe_execute_action
  Location responses are pushed back via Firebase Cloud Messaging (FCM).

Decryption:
  owner_key (from secrets.json) → per-device identity_key (EIK)
  Own reports:    AES-GCM(sha256(identity_key), encrypted_location)
  Network/crowd:  ECDH(SECP160r1) + AES-EAX
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import AsyncIterator, Optional

import httpx

from firebase_messaging import FcmRegisterConfig, FcmPushClient
from integrations.base import (
    BaseIntegration, AuthContext, AuthExpiredError,
    IntegrationField, RemoteDevice,
)
from integrations.registry import IntegrationRegistry
from models.schemas import NormalizedPosition

logger = logging.getLogger(__name__)

_CLIENT_SIG    = "38918a453d07199354f8b19af05ec6562ced5788"
_BUNDLE_ID     = "com.google.android.apps.adm"
_NOVA_BASE     = "https://android.googleapis.com/nova/"
_MCU_MODEL_ID  = "003200"                    # custom ESP32/Zephyr trackers need bit-flipped EIK

# Static client UUID — identifies this Routario instance to Google
_FMDN_CLIENT_UUID = "routario-findmy-integration"

# Per-account last-seen dedup
_last_seen: dict[tuple, datetime] = {}

# --- FCM state (module-level, one client per account) -------------------------
_fcm_clients: dict[str, object]   = {}       # username → FcmPushClient
_fcm_tokens:  dict[str, str]      = {}       # username → FCM registration token
_pending:               dict[tuple, asyncio.Future] = {}  # (username, request_uuid) → Future
_fcm_no_response_count: dict[str, int]            = {}  # username → consecutive empty polls
_FCM_RESTART_THRESHOLD = 5


def _pb():
    from integrations.google_findmy_proto import device_update_pb2
    return device_update_pb2


def _make_fcm_config():
    return FcmRegisterConfig(
        project_id="google.com:api-project-289722593072",
        app_id="1:289722593072:android:3cfcf5bc359f0308",
        api_key="AIzaSyD_gko3P392v6how2H7UpdeXQ0v2HLettc",
        messaging_sender_id="289722593072",
        bundle_id=_BUNDLE_ID,
    )


def _on_fcm_notification(username: str, obj):
    """Called by FcmPushClient whenever an FCM notification arrives."""
    if not isinstance(obj, dict):
        return
    data = obj.get("data") or {}
    b64_payload = data.get("com.google.android.apps.adm.FCM_PAYLOAD")
    if not b64_payload:
        return

    try:
        raw = base64.b64decode(b64_payload)
        pb  = _pb()
        device_update = pb.DeviceUpdate()
        device_update.ParseFromString(raw)
        request_uuid = device_update.fcmMetadata.requestUuid
    except Exception as e:
        logger.debug("Google Find My: FCM payload parse error: %s", e)
        return

    key    = (username, request_uuid)
    future = _pending.get(key)
    if future and not future.done():
        try:
            future.set_result(device_update)
        except Exception:
            pass


async def _start_fcm_client(username: str, fcm_credentials: dict) -> str:
    """Start (or reuse) the FCM listener for this account. Returns the FCM token."""
    if username in _fcm_clients:
        return _fcm_tokens.get(username, "")

    def _callback(obj, notification, ctx):
        _on_fcm_notification(username, obj)

    client = FcmPushClient(
        callback=_callback,
        fcm_config=_make_fcm_config(),
        credentials=fcm_credentials,
    )
    fcm_token = await client.checkin_or_register()
    await client.start()

    _fcm_clients[username] = client
    _fcm_tokens[username]  = fcm_token
    logger.info("Google Find My: FCM listener started for %s (token=…%s)", username, fcm_token[-12:])
    return fcm_token


async def stop_all_fcm_clients() -> None:
    """Stop every active FCM listener. Call during server shutdown."""
    for username, client in list(_fcm_clients.items()):
        if hasattr(client, "stop"):
            try:
                await client.stop()
                logger.debug("Google Find My: FCM client stopped for %s", username)
            except Exception:
                pass
    _fcm_clients.clear()
    _fcm_tokens.clear()
    _fcm_no_response_count.clear()


@IntegrationRegistry.register("google_findmy")
class GoogleFindMyIntegration(BaseIntegration):

    PROVIDER_ID                  = "google_findmy"
    DISPLAY_NAME                 = "Google Find My"
    POLL_INTERVAL_SECONDS        = 300
    POLL_INTERVAL_ACTIVE_SECONDS = 120

    FIELDS = [
        IntegrationField(
            key="secrets_json",
            label="secrets.json contents",
            field_type="textarea",
            required=True,
            placeholder='{"username": "you@gmail.com", "aas_token": "…", "fcm_credentials": {…}}',
            help_text=(
                "Paste the full contents of Auth/secrets.json generated by GoogleFindMyTools "
                "(github.com/leonboe1/GoogleFindMyTools). "
                "After running the tool's location flow, secrets.json also contains owner_key "
                "which enables E2EE location decryption."
            ),
        ),
    ]

    # ── Auth ──────────────────────────────────────────────────────────────────

    async def authenticate(self, credentials: dict) -> AuthContext:
        raw = credentials.get("secrets_json", "")
        try:
            secrets = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError(f"Google Find My: secrets_json is not valid JSON: {e}")
        if not secrets.get("aas_token"):
            raise ValueError(
                "Google Find My: secrets_json must contain an aas_token. "
                "Generate it with GoogleFindMyTools (github.com/leonboe1/GoogleFindMyTools)."
            )
        return await self._auth_from_secrets(secrets)

    async def _auth_from_secrets(self, secrets: dict) -> AuthContext:
        import gpsoauth

        username   = secrets.get("username") or secrets.get("email") or ""
        aas_token  = secrets["aas_token"]
        android_id = str(
            secrets.get("android_id")
            or (secrets.get("fcm_credentials") or {}).get("gcm", {}).get("android_id")
            or ""
        )
        if not android_id:
            raise ValueError("Google Find My: no android_id found in secrets.json.")

        adm_resp = gpsoauth.perform_oauth(
            username, aas_token, android_id,
            service="oauth2:https://www.googleapis.com/auth/android_device_manager",
            app=_BUNDLE_ID,
            client_sig=_CLIENT_SIG,
        )
        access_token = adm_resp.get("Auth")
        if not access_token:
            raise AuthExpiredError(f"Google Find My: AAS token exchange failed: {adm_resp}")

        owner_key: Optional[bytes] = None
        owner_key_hex = secrets.get("owner_key") or ""
        if owner_key_hex:
            try:
                owner_key = bytes.fromhex(owner_key_hex)
            except ValueError:
                logger.warning("Google Find My: owner_key is not valid hex — ignoring")

        # Start FCM listener (needed to receive location push responses)
        fcm_credentials = secrets.get("fcm_credentials")
        fcm_token = ""
        if fcm_credentials:
            try:
                fcm_token = await _start_fcm_client(username, fcm_credentials)
            except Exception as e:
                logger.error("Google Find My: FCM listener failed to start: %s", e, exc_info=True)
        else:
            logger.warning("Google Find My: no fcm_credentials in secrets.json — location fetching unavailable")

        logger.info(
            "Google Find My: authenticated as %s (owner_key=%s, fcm=%s)",
            username,
            "present" if owner_key else "absent",
            "ok" if fcm_token else "unavailable",
        )

        return AuthContext(
            data={
                "username":        username,
                "access_token":    access_token,
                "owner_key":       owner_key,
                "fcm_token":       fcm_token,
                "fcm_credentials": fcm_credentials,
            },
            token_expires_at=datetime.now(timezone.utc) + timedelta(seconds=3500),
        )

    # ── List devices ──────────────────────────────────────────────────────────

    async def list_remote_devices(self, auth_ctx: AuthContext) -> list[RemoteDevice]:
        try:
            metas = await self._nova_list_devices(auth_ctx.data["access_token"])
        except Exception as e:
            logger.error("Google Find My: list_remote_devices error: %s", e, exc_info=True)
            return []

        pb     = _pb()
        result = []
        for meta in metas:
            for cid in _canonic_ids(meta, pb):
                result.append(RemoteDevice(
                    remote_id=cid,
                    name=meta.userDefinedDeviceName or cid,
                    imei=None,
                ))
        return result

    # ── Fetch positions ───────────────────────────────────────────────────────

    async def fetch_positions(
        self,
        auth_ctx: AuthContext,
        devices: list[dict],
    ) -> AsyncIterator[NormalizedPosition]:
        if not devices:
            return

        access_token = auth_ctx.data["access_token"]
        owner_key    = auth_ctx.data.get("owner_key")
        fcm_token    = auth_ctx.data.get("fcm_token", "")
        username     = auth_ctx.data["username"]

        if not fcm_token:
            logger.warning("Google Find My: no FCM token — cannot request locations")
            return
        if not owner_key:
            logger.warning(
                "Google Find My: no owner_key — run GoogleFindMyTools location flow "
                "and re-paste the updated secrets.json"
            )
            return

        wanted = {d["remote_id"]: d for d in devices if d.get("remote_id")}
        if not wanted:
            return

        # Prune _last_seen entries older than 24 hours to prevent unbounded growth
        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        for k in [k for k, ts in _last_seen.items() if ts < cutoff]:
            del _last_seen[k]

        # Send locate requests for all devices in parallel, then collect responses concurrently
        request_map: dict[str, tuple[str, asyncio.Future]] = {}
        loop = asyncio.get_running_loop()

        for canonic_id in wanted:
            req_uuid                       = str(uuid.uuid4())
            future                         = loop.create_future()
            _pending[(username, req_uuid)] = future
            request_map[canonic_id]        = (req_uuid, future)

        # Fire all locate-action requests
        for canonic_id, (req_uuid, _) in request_map.items():
            try:
                await self._send_locate_action(access_token, canonic_id, fcm_token, req_uuid)
            except AuthExpiredError:
                raise
            except Exception as e:
                logger.warning("Google Find My: locate-action failed for %s: %s", canonic_id, e)

        # Wait for all responses concurrently (each gets its own 30 s + one retry)
        collect_tasks = [
            self._collect_device_update(username, access_token, cid, fcm_token, req_uuid, future)
            for cid, (req_uuid, future) in request_map.items()
        ]
        results: list[tuple[str, object]] = await asyncio.gather(*collect_tasks)

        any_received = False
        for canonic_id, device_update in results:
            if device_update is None:
                continue
            any_received = True

            device_row = wanted[canonic_id]
            imei       = device_row.get("imei", "")

            location = _decrypt_device_update(device_update, owner_key, canonic_id)
            if location is None:
                continue

            ts = location["timestamp"]
            dk = (username, canonic_id)
            if _last_seen.get(dk, datetime.min.replace(tzinfo=timezone.utc)) >= ts:
                logger.debug("Google Find My: duplicate position skipped for %s", canonic_id)
                continue
            _last_seen[dk] = ts

            sensors: dict = {}
            if location.get("accuracy") is not None:
                sensors["accuracy_m"] = location["accuracy"]
            if location.get("source"):
                sensors["location_source"] = location["source"]

            yield NormalizedPosition(
                imei=imei,
                device_time=ts,
                server_time=datetime.now(timezone.utc),
                latitude=location["latitude"],
                longitude=location["longitude"],
                altitude=location.get("altitude"),
                speed=None,
                course=None,
                satellites=None,
                ignition=None,
                sensors=sensors,
                raw_data={"source": "google_findmy", "canonic_id": canonic_id},
            )

        # Restart FCM client after consecutive empty polls — likely a dead connection
        if not any_received:
            _fcm_no_response_count[username] = _fcm_no_response_count.get(username, 0) + 1
            if _fcm_no_response_count[username] >= _FCM_RESTART_THRESHOLD:
                logger.warning(
                    "Google Find My: restarting FCM client for %s after %d consecutive empty polls",
                    username, _FCM_RESTART_THRESHOLD,
                )
                old_client = _fcm_clients.pop(username, None)
                _fcm_tokens.pop(username, None)
                _fcm_no_response_count[username] = 0
                if old_client and hasattr(old_client, "stop"):
                    try:
                        await old_client.stop()
                    except Exception:
                        pass
                fcm_creds = auth_ctx.data.get("fcm_credentials")
                if fcm_creds:
                    try:
                        new_token = await _start_fcm_client(username, fcm_creds)
                        auth_ctx.data["fcm_token"] = new_token
                    except Exception as e:
                        logger.error("Google Find My: FCM restart failed for %s: %s", username, e)
        else:
            _fcm_no_response_count[username] = 0

    # ── Credentials test ──────────────────────────────────────────────────────

    async def test_credentials(self, credentials: dict) -> tuple[bool, str]:
        try:
            ctx     = await self.authenticate(credentials)
            devices = await self.list_remote_devices(ctx)
            key_msg = "present" if ctx.data.get("owner_key") else "absent (run GoogleFindMyTools location flow)"
            fcm_msg = "ok" if ctx.data.get("fcm_token") else "unavailable"
            return True, (
                f"Connected as {ctx.data['username']} — "
                f"{len(devices)} device(s), owner_key: {key_msg}, FCM: {fcm_msg}."
            )
        except Exception as e:
            return False, str(e)

    # ── Nova API ──────────────────────────────────────────────────────────────

    async def _nova_post(self, access_token: str, scope: str, payload: bytes) -> bytes:
        headers = {
            "Content-Type":    "application/x-www-form-urlencoded; charset=UTF-8",
            "Authorization":   f"Bearer {access_token}",
            "Accept-Language": "en-US",
            "User-Agent":      "fmd/20006320; gzip",
        }
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(_NOVA_BASE + scope, headers=headers, content=payload)

        if resp.status_code == 401:
            raise AuthExpiredError("Google Find My: access token rejected")
        if resp.status_code != 200:
            raise RuntimeError(f"Google Find My: {scope} returned {resp.status_code}: {resp.text[:200]}")
        return resp.content

    async def _nova_list_devices(self, access_token: str):
        pb  = _pb()
        req = pb.DevicesListRequest()
        req.deviceListRequestPayload.type = pb.DeviceType.Value("SPOT_DEVICE")
        req.deviceListRequestPayload.id   = str(uuid.uuid4())
        raw = await self._nova_post(access_token, "nbe_list_devices", req.SerializeToString())
        dl  = pb.DevicesList()
        dl.ParseFromString(raw)
        logger.debug("Google Find My: nbe_list_devices → %d device(s)", len(dl.deviceMetadata))
        return list(dl.deviceMetadata)

    async def _send_locate_action(
        self,
        access_token: str,
        canonic_id: str,
        fcm_token: str,
        request_uuid: str,
    ) -> None:
        pb  = _pb()
        req = pb.ExecuteActionRequest()

        req.scope.type = pb.DeviceType.Value("SPOT_DEVICE")
        req.scope.device.canonicId.id = canonic_id

        req.requestMetadata.type           = pb.DeviceType.Value("SPOT_DEVICE")
        req.requestMetadata.requestUuid    = request_uuid
        req.requestMetadata.fmdClientUuid  = _FMDN_CLIENT_UUID
        req.requestMetadata.gcmRegistrationId.id = fcm_token
        req.requestMetadata.unknown        = True

        req.action.locateTracker.lastHighTrafficEnablingTime.seconds = int(datetime.now(timezone.utc).timestamp())
        req.action.locateTracker.contributorType = pb.SpotContributorType.Value("FMDN_ALL_LOCATIONS")

        await self._nova_post(access_token, "nbe_execute_action", req.SerializeToString())
        logger.debug("Google Find My: locate-action sent for %s (uuid=%s)", canonic_id, request_uuid)

    async def _collect_device_update(
        self,
        username: str,
        access_token: str,
        canonic_id: str,
        fcm_token: str,
        req_uuid: str,
        future: asyncio.Future,
    ) -> tuple[str, object]:
        """Wait for one device's FCM response, retrying once on timeout."""
        loop  = asyncio.get_running_loop()
        key   = (username, req_uuid)
        device_update = None
        try:
            device_update = await asyncio.wait_for(asyncio.shield(future), timeout=30.0)
        except asyncio.TimeoutError:
            # Retry once — covers the brief FCM reconnect window (~100–200 ms).
            req_uuid2      = str(uuid.uuid4())
            future2        = loop.create_future()
            key2           = (username, req_uuid2)
            _pending[key2] = future2
            try:
                await self._send_locate_action(access_token, canonic_id, fcm_token, req_uuid2)
                device_update = await asyncio.wait_for(asyncio.shield(future2), timeout=20.0)
            except asyncio.TimeoutError:
                logger.warning("Google Find My: no location response for %s (tried twice)", canonic_id)
            except AuthExpiredError:
                raise
            except Exception as e:
                logger.warning("Google Find My: locate retry failed for %s: %s", canonic_id, e)
            finally:
                _pending.pop(key2, None)
        except AuthExpiredError:
            raise
        except Exception as e:
            logger.warning("Google Find My: location error for %s: %s", canonic_id, e)
        finally:
            _pending.pop(key, None)
        return canonic_id, device_update


# ── Module-level helpers ──────────────────────────────────────────────────────

def _canonic_ids(meta, pb) -> list[str]:
    ident = meta.identifierInformation
    if ident.type == pb.IDENTIFIER_ANDROID:
        return [c.id for c in ident.phoneInformation.canonicIds.canonicId if c.id]
    return [c.id for c in ident.canonicIds.canonicId if c.id]


def _decrypt_device_update(device_update, owner_key: Optional[bytes], canonic_id: str) -> Optional[dict]:
    """Decrypt location from a DeviceUpdate protobuf (FCM response)."""
    if owner_key is None:
        return None

    meta = device_update.deviceMetadata
    reg  = meta.information.deviceRegistration
    eus  = reg.encryptedUserSecrets
    enc_eik = eus.encryptedIdentityKey
    if not enc_eik:
        logger.debug("Google Find My: no encryptedIdentityKey in DeviceUpdate for %s", canonic_id)
        return None

    # MCU trackers (custom ESP32/Zephyr) have their EIK stored with all bits flipped
    is_mcu = reg.fastPairModelId == _MCU_MODEL_ID
    if is_mcu:
        enc_eik = bytes(b ^ 0xFF for b in enc_eik)

    identity_key = _decrypt_eik(owner_key, enc_eik, canonic_id)
    if identity_key is None:
        return None

    pb      = _pb()
    reports = meta.information.locationInformation.reports.recentLocationAndNetworkLocations

    candidates: list[tuple] = []
    if reports.HasField("recentLocation"):
        candidates.append((reports.recentLocation, reports.recentLocationTimestamp))
    for loc, ts_msg in zip(reports.networkLocations, reports.networkLocationTimestamps):
        candidates.append((loc, ts_msg))

    if not candidates:
        logger.debug("Google Find My: DeviceUpdate has no location reports for %s", canonic_id)
        return None

    best    = None
    best_ts = datetime.min.replace(tzinfo=timezone.utc)

    for loc_report, ts_msg in candidates:
        ts = datetime.fromtimestamp(ts_msg.seconds, tz=timezone.utc) if ts_msg.seconds else None
        if ts is None:
            continue

        if loc_report.HasField("semanticLocation"):
            continue
        if not loc_report.HasField("geoLocation"):
            continue

        geo      = loc_report.geoLocation
        enc      = geo.encryptedReport
        accuracy = float(geo.accuracy) if geo.accuracy else None

        time_offset = 0 if is_mcu else geo.deviceTimeOffset
        plaintext = _decrypt_report(enc, identity_key, canonic_id, time_offset)
        if plaintext is None:
            continue

        loc_proto = pb.Location()
        try:
            loc_proto.ParseFromString(plaintext)
        except Exception as e:
            logger.debug("Google Find My: Location proto parse failed for %s: %s", canonic_id, e)
            continue

        lat = loc_proto.latitude  / 1e7
        lng = loc_proto.longitude / 1e7
        if lat == 0.0 and lng == 0.0:
            continue

        source    = "findmy_own" if enc.isOwnReport else "findmy_network"
        candidate = {
            "latitude":  lat,
            "longitude": lng,
            "altitude":  loc_proto.altitude if loc_proto.altitude else None,
            "accuracy":  accuracy,
            "timestamp": ts,
            "source":    source,
        }
        if ts > best_ts:
            best_ts = ts
            best    = candidate

    if best is None:
        logger.debug("Google Find My: all %d location candidate(s) failed decryption for %s", len(candidates), canonic_id)
    return best


def _decrypt_eik(owner_key: bytes, encrypted_eik: bytes, canonic_id: str) -> Optional[bytes]:
    """Decrypt the per-device Ephemeral Identity Key (EIK) using the account owner_key."""
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        from cryptography.hazmat.backends import default_backend

        if len(encrypted_eik) == 48:
            iv, ct = encrypted_eik[:16], encrypted_eik[16:]
            dec = Cipher(algorithms.AES(owner_key), modes.CBC(iv), backend=default_backend()).decryptor()
            return dec.update(ct) + dec.finalize()
        if len(encrypted_eik) == 60:
            iv, ct = encrypted_eik[:12], encrypted_eik[12:]
            return AESGCM(owner_key).decrypt(iv, ct, None)
        logger.debug("Google Find My: unexpected EIK length %d for %s", len(encrypted_eik), canonic_id)
        return None
    except Exception as e:
        logger.debug("Google Find My: EIK decryption failed for %s: %s", canonic_id, e)
        return None


def _decrypt_report(enc, identity_key: bytes, canonic_id: str, device_time_offset: int) -> Optional[bytes]:
    """Decrypt a single EncryptedReport."""
    if not enc.encryptedLocation:
        return None
    try:
        if enc.publicKeyRandom == b"":
            return _decrypt_own_report(identity_key, enc.encryptedLocation)
        return _decrypt_network_report(identity_key, enc.encryptedLocation, enc.publicKeyRandom, device_time_offset)
    except Exception as e:
        logger.debug("Google Find My: report decryption failed for %s: %s", canonic_id, e)
        return None


def _decrypt_own_report(identity_key: bytes, encrypted_location: bytes) -> bytes:
    """Own report: AES-GCM with key = SHA-256(identity_key)."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key = hashlib.sha256(identity_key).digest()
    return AESGCM(key).decrypt(encrypted_location[:12], encrypted_location[12:], None)


def _decrypt_network_report(
    identity_key: bytes,
    encrypted_location: bytes,
    public_key_random: bytes,
    device_time_offset: int,
) -> bytes:
    """
    Crowd-sourced report: FMDN ECDH decryption on SECP160r1 + AES-EAX.

    r     = AES-ECB-256(identity_key, fmdn_data(masked_ts)) mod n
    R     = r * G
    S.x   = public_key_random (20 bytes), S.y recovered from curve
    k     = HKDF-SHA256((r*S).x, salt=None, info=b'')
    nonce = R.x[-8:] || S.x[-8:]
    plain = AES-EAX-256-DEC(k, nonce, m', tag)
    """
    from ecdsa import SECP160r1
    from ecdsa.ellipticcurve import Point
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    from cryptography.hazmat.primitives import hashes
    from Cryptodome.Cipher import AES

    curve = SECP160r1
    K     = 10
    ts_b  = (device_time_offset & (~((1 << K) - 1) & 0xFFFFFFFF)).to_bytes(4, "big")

    buf = bytearray(32)
    buf[0:11]  = b"\xff" * 11
    buf[11]    = K
    buf[12:16] = ts_b
    buf[16:27] = b"\x00" * 11
    buf[27]    = K
    buf[28:32] = ts_b

    r_int = int.from_bytes(AES.new(identity_key, AES.MODE_ECB).encrypt(bytes(buf)), "big") % curve.order
    R     = r_int * curve.generator

    Sx = int.from_bytes(public_key_random, "big")
    p  = curve.curve.p()
    yy = (Sx**3 + curve.curve.a() * Sx + curve.curve.b()) % p
    y0 = pow(yy, (p + 1) // 4, p)

    # The broadcast x-coordinate has two valid y values; try both since the parity
    # bit is not transmitted in the FMDN advertisement.
    last_err: Optional[Exception] = None
    for y in (y0, p - y0):
        try:
            S     = Point(curve.curve, Sx, y)
            k     = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=b"").derive(
                (r_int * S).x().to_bytes(20, "big")
            )
            nonce = R.x().to_bytes(20, "big")[12:] + S.x().to_bytes(20, "big")[12:]
            return AES.new(k, AES.MODE_EAX, nonce=nonce).decrypt_and_verify(
                encrypted_location[:-16], encrypted_location[-16:]
            )
        except Exception as e:
            last_err = e
    raise last_err or ValueError("both y parities failed")
