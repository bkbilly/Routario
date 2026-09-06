"""
Data Retention Engine
Periodic background task and helpers to truncate old historical GPS position data.
"""
import asyncio
import logging
import os
from pathlib import Path
import time
from datetime import datetime, timezone, timedelta

from sqlalchemy import delete, select
from core.config import get_settings
from core.database import get_db
from core.runtime_health import mark_task_error, mark_task_success, register_task
from models import PositionRecord

logger = logging.getLogger(__name__)


async def downsample_old_positions(
    downsample_days: int = None,
    interval_seconds: int = None,
    batch_size: int = 2000,
) -> int:
    """
    Downsamples historical position records older than `downsample_days`.
    Reduces high-frequency tracking records down to `interval_seconds` (default 60s),
    while always preserving critical telematics events:
      - Ignition on/off state transitions
      - Significant speed state changes (stopped vs moving)
      - Critical sensor alarms / alerts (SOS, crash, harsh braking/accel, etc.)
    Returns total number of pruned redundant records.
    """
    settings_obj = get_settings()
    days = downsample_days if downsample_days is not None else getattr(settings_obj, "history_downsample_days", 30)
    interval = interval_seconds if interval_seconds is not None else getattr(settings_obj, "history_downsample_interval_seconds", 60)

    if days <= 0 or interval <= 0:
        return 0

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    db = get_db()
    total_pruned = 0

    try:
        async with db.get_session() as session:
            # Query devices with records older than downsample cutoff
            dev_stmt = (
                select(PositionRecord.device_id)
                .where(PositionRecord.device_time < cutoff)
                .distinct()
            )
            dev_res = await session.execute(dev_stmt)
            device_ids = [r[0] for r in dev_res.fetchall() if r[0] is not None]

            for dev_id in device_ids:
                offset = 0
                while True:
                    stmt = (
                        select(
                            PositionRecord.id,
                            PositionRecord.device_time,
                            PositionRecord.ignition,
                            PositionRecord.sensors,
                            PositionRecord.speed,
                        )
                        .where(
                            PositionRecord.device_id == dev_id,
                            PositionRecord.device_time < cutoff,
                        )
                        .order_by(PositionRecord.device_time.asc())
                        .limit(batch_size)
                        .offset(offset)
                    )
                    rows = (await session.execute(stmt)).fetchall()
                    if not rows:
                        break

                    ids_to_prune = []
                    last_kept_time = None
                    last_ignition = None
                    last_speed = None

                    for row in rows:
                        rec_id, rec_time, rec_ign, rec_sensors, rec_speed = row

                        # Check critical preservation conditions
                        ign_changed = (last_ignition is not None and rec_ign != last_ignition)

                        # Significant speed transition (e.g. stopped vs moving)
                        speed_transition = False
                        if last_speed is not None and rec_speed is not None:
                            if (last_speed == 0 and rec_speed > 5) or (last_speed > 5 and rec_speed == 0):
                                speed_transition = True

                        has_alarm = False
                        if rec_sensors and isinstance(rec_sensors, dict):
                            has_alarm = any(
                                k in rec_sensors
                                for k in ("alarm", "sos", "alert", "crash", "dtc", "harsh_accel", "harsh_braking")
                            )

                        time_gap = (rec_time - last_kept_time).total_seconds() if last_kept_time else 999999

                        if ign_changed or has_alarm or speed_transition or time_gap >= interval:
                            last_kept_time = rec_time
                            last_ignition = rec_ign
                            last_speed = rec_speed
                        else:
                            ids_to_prune.append(rec_id)

                    if ids_to_prune:
                        # Batch delete redundant records in chunks of 500
                        for i in range(0, len(ids_to_prune), 500):
                            chunk = ids_to_prune[i : i + 500]
                            del_stmt = delete(PositionRecord).where(PositionRecord.id.in_(chunk))
                            await session.execute(del_stmt)
                        await session.commit()
                        total_pruned += len(ids_to_prune)

                    if len(rows) < batch_size:
                        break

                    kept_count = len(rows) - len(ids_to_prune)
                    offset += max(1, kept_count)
                    await asyncio.sleep(0.01)

        if total_pruned > 0:
            logger.info(
                "Downsampled position records: pruned %d redundant points older than %d days (resolution: %ds)",
                total_pruned,
                days,
                interval,
            )
    except Exception as e:
        logger.error("Failed during position downsampling: %s", e)
        raise

    return total_pruned


async def purge_old_positions(days: int = None, chunk_size: int = 5000) -> int:
    """
    Purge position records older than `days` days in safe, non-blocking batches.
    Returns number of deleted rows.
    """
    settings_obj = get_settings()
    if days is None:
        days = settings_obj.history_retention_days

    if days <= 0:
        return 0

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    db = get_db()
    total_deleted = 0

    try:
        async with db.get_session() as session:
            while True:
                # Find chunk of IDs to delete to avoid long table locks
                subquery = (
                    select(PositionRecord.id)
                    .where(PositionRecord.device_time < cutoff)
                    .limit(chunk_size)
                )
                ids_res = await session.execute(subquery)
                ids_to_del = [r[0] for r in ids_res.fetchall()]
                if not ids_to_del:
                    break

                del_stmt = delete(PositionRecord).where(PositionRecord.id.in_(ids_to_del))
                res = await session.execute(del_stmt)
                await session.commit()
                deleted_in_batch = res.rowcount or len(ids_to_del)
                total_deleted += deleted_in_batch

                if len(ids_to_del) < chunk_size:
                    break

                await asyncio.sleep(0.01)

            if total_deleted > 0:
                logger.info(
                    "Purged %d historical position records older than %d days (cutoff: %s)",
                    total_deleted,
                    days,
                    cutoff.isoformat(),
                )
    except Exception as e:
        logger.error("Failed to purge old positions: %s", e)
        raise

    return total_deleted


def purge_old_tts_cache(days: int = None) -> int:
    """Purge cached TTS audio files in web/uploads/tts/ not accessed for `days` days."""
    settings_obj = get_settings()
    if days is None:
        days = getattr(settings_obj, "voip_tts_cache_retention_days", 30)

    if days <= 0:
        return 0

    cutoff_ts = time.time() - (days * 86400)
    tts_dir = Path("web/uploads/tts")
    if not tts_dir.is_dir():
        return 0

    deleted = 0
    try:
        for p in tts_dir.glob("*.wav"):
            try:
                stat = p.stat()
                # Most recent timestamp between last access (atime) and modification (mtime)
                last_used = max(stat.st_mtime, getattr(stat, "st_atime", stat.st_mtime))
                if last_used < cutoff_ts:
                    p.unlink(missing_ok=True)
                    deleted += 1
            except Exception as e:
                logger.warning("Could not unlink old TTS audio file %s: %s", p, e)
        if deleted > 0:
            logger.info("Purged %d unused TTS audio cache files older than %d days", deleted, days)
    except Exception as e:
        logger.error("Failed during TTS audio cache cleanup: %s", e)

    return deleted


async def periodic_history_cleanup_task():
    """Background loop that periodically checks and runs time-series downsampling, retention purges, and TTS cache cleanup."""
    register_task("history_cleanup_task")
    logger.info("Periodic history retention & downsampling task started.")

    while True:
        try:
            settings_obj = get_settings()

            # 1. Time-Series Downsampling
            downsample_pruned = 0
            if getattr(settings_obj, "history_downsample_enabled", False):
                downsample_days = getattr(settings_obj, "history_downsample_days", 30)
                downsample_interval = getattr(settings_obj, "history_downsample_interval_seconds", 60)
                downsample_pruned = await downsample_old_positions(downsample_days, downsample_interval)

            # 2. Hard Retention Purge
            purge_count = 0
            if settings_obj.history_retention_enabled and settings_obj.history_retention_days > 0:
                purge_count = await purge_old_positions(settings_obj.history_retention_days)

            # 3. TTS Audio Cache Retention
            tts_days = getattr(settings_obj, "voip_tts_cache_retention_days", 30)
            tts_deleted = 0
            if tts_days > 0:
                tts_deleted = purge_old_tts_cache(tts_days)

            status_msg = []
            if downsample_pruned > 0:
                status_msg.append(f"Downsampled {downsample_pruned} redundant points.")
            if purge_count > 0:
                status_msg.append(f"Purged {purge_count} expired records.")
            if tts_deleted > 0:
                status_msg.append(f"Cleaned {tts_deleted} TTS audio files.")

            summary = " ".join(status_msg) if status_msg else "Retention and downsampling checks complete. No action needed."
            mark_task_success("history_cleanup_task", summary)

        except asyncio.CancelledError:
            logger.info("History cleanup task cancelled.")
            break
        except Exception as e:
            logger.error("Error in history retention cleanup task: %s", e)
            mark_task_error("history_cleanup_task", str(e))

        # Check every 6 hours
        await asyncio.sleep(21600)
