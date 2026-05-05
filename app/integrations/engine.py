"""
app/integrations/engine.py

Background polling engine for all external integrations.

One asyncio task runs forever. Each cycle it:
  1. Loads all Devices where config["integration"]["provider"] is set
  2. Groups them by (user_id, provider, account_label)
  3. Authenticates once per group (caches + refreshes tokens)
  4. Calls provider.fetch_positions() for each group
  5. Feeds every NormalizedPosition into the same process_position_callback
     used by native TCP devices — same alerts, trips, WebSocket, everything

Adaptive polling
----------------
Each device is polled on its own schedule:

  • POLL_INTERVAL_ACTIVE_SECONDS  (default 30 s) — used when the device's last
    known ignition state is ON.
  • POLL_INTERVAL_SECONDS         (default 120 s) — used when ignition is OFF or
    unknown (e.g. first poll, or the provider does not report ignition).

The engine maintains a per-device "next poll" timestamp in _next_poll_at and
a per-device ignition state in _device_ignition.  After every successful
position update the ignition state is refreshed and the next-poll timestamp
is recalculated accordingly.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone, timedelta
from typing import Callable, Coroutine, Any
from core.database import get_db
from sqlalchemy import select, update
from models.models import Device, user_device_association, PositionRecord
from integrations.integration_model import IntegrationAccount

from integrations.registry import IntegrationRegistry
from integrations.base import AuthContext, AuthExpiredError

logger = logging.getLogger(__name__)

# (user_id, provider_id, account_label) → AuthContext
_auth_cache: dict[tuple, AuthContext] = {}

# (device_imei,) → datetime  — wall-clock time when this device should next be polled
_next_poll_at: dict[str, datetime] = {}

# (device_imei,) → bool | None  — last known ignition state (None = unknown)
_device_ignition: dict[str, bool | None] = {}

# Wall-clock last-seen per imei — persisted across the process lifetime.
# Seeded from DB on startup so restarts don't reprocess old positions.
_last_seen_db: dict[str, datetime] = {}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _schedule_next(imei: str, provider, ignition: bool | None) -> None:
    """
    Set _next_poll_at[imei] based on the current ignition state and the
    provider's configured intervals.
    """
    if ignition:
        interval = provider.POLL_INTERVAL_ACTIVE_SECONDS
    else:
        interval = provider.POLL_INTERVAL_SECONDS
    _next_poll_at[imei] = _now() + timedelta(seconds=interval)


def _is_due(imei: str) -> bool:
    """Return True if this device is due (or overdue) for a poll."""
    due = _next_poll_at.get(imei)
    if due is None:
        return True          # never polled → poll immediately
    return _now() >= due


async def _get_auth(
    user_id: int,
    provider_id: str,
    account_label: str,
    credentials: dict,
) -> AuthContext | None:
    """Return a valid AuthContext, refreshing if expired."""
    cache_key = (user_id, provider_id, account_label)
    ctx = _auth_cache.get(cache_key)

    if ctx:
        exp = ctx.token_expires_at
        if exp is None or exp > _now():
            return ctx
        # Token expired — fall through to re-auth

    provider = IntegrationRegistry.get(provider_id)
    if not provider:
        logger.warning(f"Integration engine: unknown provider '{provider_id}'")
        return None

    try:
        ctx = await provider.authenticate(credentials)
        # Inject account_label into auth_ctx.data so providers can use it
        # for scoping any in-memory state (e.g. StartId cursors).
        ctx.data["account_label"] = account_label
        _auth_cache[cache_key] = ctx
        logger.info(f"Integration auth OK: {provider_id} / {account_label}")
        return ctx
    except Exception as e:
        logger.error(f"Integration auth failed: {provider_id} / {account_label}: {e}")
        return None

async def _init_last_seen(db) -> None:
    """
    On startup, populate _last_seen and _device_ignition from the DB so that
    the first poll cycle after a restart doesn't reprocess already-stored positions.
    """
    async with db.get_session() as session:
        result = await session.execute(
            select(Device).where(Device.is_active == True)
        )
        all_devices = result.scalars().all()

        for device in all_devices:
            intg = (device.config or {}).get("integration") or {}
            provider_id = intg.get("provider", "")
            remote_id   = intg.get("remote_id", "")

            if not provider_id or not remote_id:
                continue

            # Find the most recent position record for this device
            pos_result = await session.execute(
                select(PositionRecord)
                .where(PositionRecord.device_id == device.id)
                .order_by(PositionRecord.device_time.desc())
                .limit(1)
            )
            last_pos = pos_result.scalar_one_or_none()

            if last_pos:
                # Seed _last_seen so providers skip anything up to this timestamp
                _last_seen_db[device.imei] = last_pos.device_time.replace(tzinfo=timezone.utc)

                # Seed ignition state so adaptive polling starts correctly
                _device_ignition[device.imei] = last_pos.ignition

                logger.debug(
                    f"Integration init: {device.imei} last seen at "
                    f"{last_pos.device_time.isoformat()}, "
                    f"ignition={last_pos.ignition}"
                )

async def integration_poll_task(
    position_callback: Callable[..., Coroutine[Any, Any, None]],
):
    await asyncio.sleep(2)

    # ── Seed last-seen from DB before first poll ──────────────────────────────
    try:
        await _init_last_seen(get_db())
        logger.info(f"Integration engine: seeded last-seen for {len(_last_seen_db)} devices")
    except Exception as e:
        logger.error(f"Integration engine: failed to seed last-seen: {e}", exc_info=True)

    TICK_SECONDS = 5

    while True:
        try:
            await _run_poll_cycle(position_callback)
        except Exception as e:
            logger.error(f"Integration poll cycle error: {e}", exc_info=True)

        await asyncio.sleep(TICK_SECONDS)

async def _run_poll_cycle(
    position_callback: Callable[..., Coroutine[Any, Any, None]],
):
    db = get_db()

    # ── Build groups of devices that are due for a poll ───────────────────────
    # We only query the DB once per tick; the per-device schedule check is cheap.
    groups: dict[tuple, list[dict]] = {}

    async with db.get_session() as session:
        result = await session.execute(
            select(Device).where(Device.is_active == True)
        )
        all_devices = result.scalars().all()

        for device in all_devices:
            intg = (device.config or {}).get("integration") or {}
            provider_id   = intg.get("provider", "")
            account_label = intg.get("account_label", "")
            remote_id     = intg.get("remote_id", "")

            if not provider_id or not remote_id:
                continue

            # Skip devices that are not yet due for a poll
            if not _is_due(device.imei):
                continue

            # Find the owning user_id via the association table
            ua = await session.execute(
                select(user_device_association).where(
                    user_device_association.c.device_id == device.id
                )
            )
            row = ua.first()
            if not row:
                logger.warning(
                    f"Integration engine: device {device.id} has no associated user, skipping"
                )
                continue
            user_id = row.user_id

            key = (user_id, provider_id, account_label)
            groups.setdefault(key, []).append({
                "remote_id": remote_id,
                "imei":      device.imei,
                "device_id": device.id,
                "last_seen_floor": _last_seen_db.get(device.imei),
            })

    if not groups:
        return

    # ── Authenticate and fetch for each group ─────────────────────────────────
    # Each DB operation uses its own short-lived session so the connection is
    # never held across network I/O (authenticate / fetch_positions).
    for (user_id, provider_id, account_label), devices in groups.items():

        # ── Load account (short session, released before any network call) ─────
        account_id      = None
        credentials     = None
        account_state   = {}
        async with db.get_session() as session:
            result = await session.execute(
                select(IntegrationAccount).where(
                    IntegrationAccount.user_id       == user_id,
                    IntegrationAccount.provider_id   == provider_id,
                    IntegrationAccount.account_label == account_label,
                    IntegrationAccount.is_active     == True,
                )
            )
            account = result.scalar_one_or_none()
            if not account:
                logger.warning(
                    f"No IntegrationAccount for {user_id}/{provider_id}/{account_label}"
                )
                _reschedule_group(devices, provider_id, ignition=None)
                continue
            account_id    = account.id
            credentials   = account.get_decrypted_credentials()
            account_state = dict(account.state or {})
        # DB connection released here — authenticate() may do network I/O

        # ── Authenticate (network I/O; no DB connection held) ─────────────────
        auth_ctx = await _get_auth(user_id, provider_id, account_label, credentials)
        if not auth_ctx:
            async with db.get_session() as session:
                await session.execute(
                    update(IntegrationAccount)
                    .where(IntegrationAccount.id == account_id)
                    .values(last_error=f"Auth failed at {datetime.utcnow().isoformat()}")
                )
            _reschedule_group(devices, provider_id, ignition=None)
            continue

        async with db.get_session() as session:
            await session.execute(
                update(IntegrationAccount)
                .where(IntegrationAccount.id == account_id)
                .values(last_auth_at=datetime.utcnow(), last_error=None)
            )
        # DB connection released here — fetch_positions() may do network I/O

        # Seed persisted state from DB the first time this auth context is used
        if "_persisted_state" not in auth_ctx.data:
            auth_ctx.data["_persisted_state"] = account_state

        provider = IntegrationRegistry.get(provider_id)
        if not provider:
            _reschedule_group(devices, provider_id, ignition=None)
            continue

        fetched   = 0
        errors    = 0
        cache_key = (user_id, provider_id, account_label)

        try:
            # Network I/O — no DB connection held during the fetch
            async for position in provider.fetch_positions(auth_ctx, devices):
                try:
                    await position_callback(position)  # opens its own short session
                    fetched += 1

                    imei         = position.imei
                    new_ignition = position.ignition
                    old_ignition = _device_ignition.get(imei)

                    _device_ignition[imei] = new_ignition
                    _schedule_next(imei, provider, new_ignition)

                    pos_time = position.device_time
                    if pos_time.tzinfo is None:
                        pos_time = pos_time.replace(tzinfo=timezone.utc)
                    existing_floor = _last_seen_db.get(imei)
                    if existing_floor is None or pos_time > existing_floor:
                        _last_seen_db[imei] = pos_time

                    if old_ignition != new_ignition:
                        state_str = (
                            "ON"  if new_ignition is True  else
                            "OFF" if new_ignition is False else
                            "unknown"
                        )
                        logger.info(
                            f"Integration [{provider_id}] {imei}: ignition → {state_str}, "
                            f"next poll in "
                            f"{provider.POLL_INTERVAL_ACTIVE_SECONDS if new_ignition else provider.POLL_INTERVAL_SECONDS}s"
                        )

                except Exception as e:
                    logger.error(f"Integration: position callback error: {e}")
                    errors += 1

        except AuthExpiredError as e:
            _auth_cache.pop(cache_key, None)
            logger.warning(
                f"Integration: session expired mid-cycle for "
                f"{provider_id}/{account_label} — will re-authenticate next poll. ({e})"
            )
            async with db.get_session() as session:
                await session.execute(
                    update(IntegrationAccount)
                    .where(IntegrationAccount.id == account_id)
                    .values(last_error=f"Session expired at {datetime.utcnow().isoformat()}, re-authenticating")
                )
            _reschedule_group(devices, provider_id, ignition=True)
            continue

        except Exception as e:
            logger.error(f"Integration fetch error {provider_id}/{account_label}: {e}")
            errors += 1

        # ── Persist any state the provider updated (e.g. StartId) ─────────────
        new_state = auth_ctx.data.get("_persisted_state")
        if new_state:
            async with db.get_session() as session:
                await session.execute(
                    update(IntegrationAccount)
                    .where(IntegrationAccount.id == account_id)
                    .values(state=new_state)
                )

        for dev in devices:
            imei = dev["imei"]
            if _next_poll_at.get(imei) is None or _next_poll_at[imei] <= _now():
                _schedule_next(imei, provider, _device_ignition.get(imei))

        if fetched or errors:
            logger.debug(
                f"Integration poll {provider_id}/{account_label}: "
                f"{fetched} positions, {errors} errors"
            )


def clear_device_state(imei: str) -> None:
    """Remove all in-memory engine state for a device (call after DB deletion)."""
    _last_seen_db.pop(imei, None)
    _device_ignition.pop(imei, None)
    _next_poll_at.pop(imei, None)


def evict_auth_cache(user_id: int, provider_id: str, account_label: str) -> None:
    """Evict cached auth context for an integration account."""
    _auth_cache.pop((user_id, provider_id, account_label), None)


def _reschedule_group(devices: list[dict], provider_id: str, ignition: bool | None) -> None:
    """
    Reschedule all devices in a group using the provider's idle interval.
    Called when authentication fails or no account is found, so we don't
    re-attempt every 5 s.
    """
    provider = IntegrationRegistry.get(provider_id)
    if not provider:
        # Fallback: retry in 60 s
        for dev in devices:
            _next_poll_at[dev["imei"]] = _now() + timedelta(seconds=60)
        return
    for dev in devices:
        _schedule_next(dev["imei"], provider, ignition)
