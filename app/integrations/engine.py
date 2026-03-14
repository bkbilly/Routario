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
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Callable, Coroutine, Any

from integrations.registry import IntegrationRegistry
from integrations.base import AuthContext

logger = logging.getLogger(__name__)

# (user_id, provider_id, account_label) → AuthContext
_auth_cache: dict[tuple, AuthContext] = {}


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
        if exp is None or exp > datetime.now(timezone.utc):
            return ctx
        # Token expired — fall through to re-auth

    provider = IntegrationRegistry.get(provider_id)
    if not provider:
        logger.warning(f"Integration engine: unknown provider '{provider_id}'")
        return None

    try:
        ctx = await provider.authenticate(credentials)
        _auth_cache[cache_key] = ctx
        logger.info(f"Integration auth OK: {provider_id} / {account_label}")
        return ctx
    except Exception as e:
        logger.error(f"Integration auth failed: {provider_id} / {account_label}: {e}")
        return None


async def integration_poll_task(
    position_callback: Callable[..., Coroutine[Any, Any, None]],
):
    """
    Runs forever. Import and start in main.py:

        from integrations.engine import integration_poll_task
        asyncio.create_task(integration_poll_task(process_position_callback))
    """
    # Stagger first run so we don't hammer the DB at startup
    await asyncio.sleep(10)

    while True:
        try:
            await _run_poll_cycle(position_callback)
        except Exception as e:
            logger.error(f"Integration poll cycle error: {e}", exc_info=True)

        await asyncio.sleep(30)


async def _run_poll_cycle(
    position_callback: Callable[..., Coroutine[Any, Any, None]],
):
    from core.database import get_db
    from sqlalchemy import select
    from models.models import Device
    from integrations.integration_model import IntegrationAccount

    db = get_db()

    # Load all active devices that have an integration config
    async with db.get_session() as session:
        result = await session.execute(
            select(Device).where(Device.is_active == True)
        )
        all_devices = result.scalars().all()

    integration_devices = [
        d for d in all_devices
        if d.config and d.config.get("integration", {}).get("provider")
    ]

    if not integration_devices:
        return

    # Group by (user_id, provider, account_label)
    # We need user_id to look up the IntegrationAccount
    groups: dict[tuple, list[dict]] = {}

    async with db.get_session() as session:
        for device in integration_devices:
            intg = device.config["integration"]
            provider_id   = intg.get("provider", "")
            account_label = intg.get("account_label", "")
            remote_id     = intg.get("remote_id", "")

            if not provider_id or not remote_id:
                continue

            # Find the owning user_id (first associated user)
            from models.models import user_device_association
            from sqlalchemy import select as sel
            ua = await session.execute(
                sel(user_device_association).where(
                    user_device_association.c.device_id == device.id
                )
            )
            row = ua.first()
            if not row:
                continue
            user_id = row.user_id

            key = (user_id, provider_id, account_label)
            groups.setdefault(key, []).append({
                "remote_id": remote_id,
                "imei":      device.imei,
                "device_id": device.id,
            })

    # For each group: authenticate once, then fetch all positions
    async with db.get_session() as session:
        for (user_id, provider_id, account_label), devices in groups.items():
            # Load credentials from IntegrationAccount
            result = await session.execute(
                select(IntegrationAccount).where(
                    IntegrationAccount.user_id     == user_id,
                    IntegrationAccount.provider_id == provider_id,
                    IntegrationAccount.account_label == account_label,
                    IntegrationAccount.is_active   == True,
                )
            )
            account = result.scalar_one_or_none()
            if not account:
                logger.warning(
                    f"No IntegrationAccount for {user_id}/{provider_id}/{account_label}"
                )
                continue

            credentials = account.get_decrypted_credentials()
            auth_ctx = await _get_auth(user_id, provider_id, account_label, credentials)
            if not auth_ctx:
                # Record error in DB
                from sqlalchemy import update
                await session.execute(
                    update(IntegrationAccount)
                    .where(IntegrationAccount.id == account.id)
                    .values(last_error=f"Auth failed at {datetime.utcnow().isoformat()}")
                )
                continue

            # Update last_auth_at and clear error
            from sqlalchemy import update
            await session.execute(
                update(IntegrationAccount)
                .where(IntegrationAccount.id == account.id)
                .values(last_auth_at=datetime.utcnow(), last_error=None)
            )

            provider = IntegrationRegistry.get(provider_id)
            if not provider:
                continue

            fetched = 0
            errors  = 0
            try:
                async for position in provider.fetch_positions(auth_ctx, devices):
                    try:
                        await position_callback(position)
                        fetched += 1
                    except Exception as e:
                        logger.error(f"Integration: position callback error: {e}")
                        errors += 1
            except Exception as e:
                logger.error(
                    f"Integration fetch error {provider_id}/{account_label}: {e}"
                )
                errors += 1

            if fetched or errors:
                logger.debug(
                    f"Integration poll {provider_id}/{account_label}: "
                    f"{fetched} positions, {errors} errors"
                )
