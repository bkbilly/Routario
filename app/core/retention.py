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

from sqlalchemy import delete
from core.config import get_settings
from core.database import get_db
from core.runtime_health import mark_task_error, mark_task_success, register_task
from models import PositionRecord

logger = logging.getLogger(__name__)


async def purge_old_positions(days: int = None) -> int:
    """Purge position records older than `days` days. Returns number of deleted rows."""
    settings_obj = get_settings()
    if days is None:
        days = settings_obj.history_retention_days

    if days <= 0:
        return 0

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    db = get_db()
    deleted_count = 0

    try:
        async with db.get_session() as session:
            stmt = delete(PositionRecord).where(PositionRecord.device_time < cutoff)
            res = await session.execute(stmt)
            await session.commit()
            deleted_count = res.rowcount or 0
            if deleted_count > 0:
                logger.info("Purged %d historical position records older than %d days (cutoff: %s)", deleted_count, days, cutoff.isoformat())
    except Exception as e:
        logger.error("Failed to purge old positions: %s", e)
        raise

    return deleted_count


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
    """Background loop that periodically checks and purges old historical position data and TTS cache."""
    register_task("history_cleanup_task")
    logger.info("Periodic history & TTS retention cleanup task started.")

    while True:
        try:
            settings_obj = get_settings()
            # 1. Position record retention
            if settings_obj.history_retention_enabled and settings_obj.history_retention_days > 0:
                count = await purge_old_positions(settings_obj.history_retention_days)
                mark_task_success("history_cleanup_task", f"History retention check complete. Deleted {count} records.")
            else:
                mark_task_success("history_cleanup_task", "History retention disabled.")

            # 2. TTS audio cache retention
            tts_days = getattr(settings_obj, "voip_tts_cache_retention_days", 30)
            if tts_days > 0:
                tts_deleted = purge_old_tts_cache(tts_days)
                if tts_deleted > 0:
                    logger.info("TTS retention check purged %d inactive audio files.", tts_deleted)
        except asyncio.CancelledError:
            logger.info("History cleanup task cancelled.")
            break
        except Exception as e:
            logger.error("Error in history retention cleanup task: %s", e)
            mark_task_error("history_cleanup_task", str(e))

        # Check every 6 hours
        await asyncio.sleep(21600)
