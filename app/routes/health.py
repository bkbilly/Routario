from pathlib import Path
from datetime import datetime, timezone
import os
import platform
import shutil
import subprocess
import sys
from time import monotonic

from fastapi import APIRouter, Response, status
from sqlalchemy import select, text

from core.config import get_settings
from core.database import get_db
from core.gateway import get_active_device_protocols, protocol_server_manager
from core.runtime_health import PROCESS_STARTED_AT, runtime_state_snapshot, task_snapshot
from core.valhalla import is_valhalla_available
from integrations.integration_model import IntegrationAccount
from integrations.registry import IntegrationRegistry
from models import Device, DeviceState
from protocols import ProtocolRegistry

router = APIRouter(tags=["health"])

_GIT_COMMIT: str | None = None


async def _check_db() -> dict:
    started = monotonic()
    try:
        db = get_db()
        async with db.get_session() as session:
            await session.execute(text("SELECT 1"))
        return {"ok": True, "latency_ms": round((monotonic() - started) * 1000, 2)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


async def _check_redis() -> dict:
    settings = get_settings()
    started = monotonic()
    try:
        import redis.asyncio as redis
        client = redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        await client.ping()
        await client.aclose()
        return {"ok": True, "latency_ms": round((monotonic() - started) * 1000, 2)}
    except Exception as exc:
        return {"ok": False, "optional": True, "error": str(exc)}


def _check_disk() -> dict:
    try:
        path = Path("/tmp/routario-healthcheck")
        path.write_text("ok", encoding="utf-8")
        path.unlink(missing_ok=True)
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _disk_usage_row(path: Path) -> dict:
    usage = shutil.disk_usage(path)
    used_pct = round((usage.used / usage.total) * 100, 1) if usage.total else 0
    return {
        "path": str(path),
        "exists": path.exists(),
        "total_bytes": usage.total,
        "used_bytes": usage.used,
        "free_bytes": usage.free,
        "used_percent": used_pct,
        "ok": used_pct < 95,
        "degraded": used_pct >= 85,
    }


def _check_disk_capacity() -> dict:
    paths = [Path("web/uploads"), Path("web/uploads/dashcam"), Path("web/uploads/voice")]
    rows = []
    for path in paths:
        try:
            probe = path if path.exists() else path.parent
            rows.append({**_disk_usage_row(probe), "label": str(path)})
        except Exception as exc:
            rows.append({"label": str(path), "ok": False, "error": str(exc)})
    return {
        "ok": all(row.get("ok") for row in rows),
        "optional": True,
        "degraded": any(row.get("degraded") for row in rows),
        "paths": rows,
    }


def _check_database_pool() -> dict:
    db = get_db()
    pool = db.engine.sync_engine.pool
    row = {
        "ok": True,
        "optional": True,
        "database_type": "sqlite" if getattr(db, "_is_sqlite", False) else "postgresql" if getattr(db, "_is_postgres", False) else "other",
        "pool_class": pool.__class__.__name__,
    }
    for attr in ("size", "checkedout", "overflow", "checkedin"):
        fn = getattr(pool, attr, None)
        if callable(fn):
            try:
                row[attr] = fn()
            except Exception:
                pass
    try:
        row["status"] = pool.status()
    except Exception:
        pass
    return row


def _check_redis_mode() -> dict:
    state = runtime_state_snapshot().get("redis_pubsub") or {}
    return {
        "ok": True,
        "optional": True,
        "available": bool(state.get("available")),
        "mode": state.get("mode") or "unknown",
        "error": state.get("error"),
    }


async def _check_integration_accounts() -> dict:
    db = get_db()
    async with db.get_session() as session:
        accounts_result = await session.execute(
            select(
                IntegrationAccount.id,
                IntegrationAccount.provider_id,
                IntegrationAccount.account_label,
                IntegrationAccount.is_active,
                IntegrationAccount.last_auth_at,
                IntegrationAccount.last_error,
            )
            .where(IntegrationAccount.is_active == True)
            .order_by(IntegrationAccount.provider_id, IntegrationAccount.account_label)
        )
        device_result = await session.execute(
            select(Device.config).where(Device.is_active == True)
        )
        active_devices = device_result.scalars().all()

    counts: dict[tuple[str, str], int] = {}
    for config in active_devices:
        integration = (config or {}).get("integration") or {}
        provider = integration.get("provider")
        label = integration.get("account_label") or ""
        if provider:
            counts[(provider, label)] = counts.get((provider, label), 0) + 1

    rows = []
    for account_id, provider, label, is_active, last_auth_at, last_error in accounts_result.all():
        rows.append({
            "id": account_id,
            "provider_id": provider,
            "account_label": label,
            "is_active": bool(is_active),
            "active_device_count": counts.get((provider, label), 0),
            "last_auth_at": last_auth_at.isoformat() if last_auth_at else None,
            "last_error": last_error,
            "ok": not bool(last_error),
        })

    return {
        "ok": all(row["ok"] for row in rows),
        "optional": True,
        "degraded": any(not row["ok"] for row in rows),
        "active_accounts": len(rows),
        "accounts_with_errors": sum(1 for row in rows if not row["ok"]),
        "accounts": rows,
    }


def _git_commit() -> str | None:
    global _GIT_COMMIT
    if _GIT_COMMIT is not None:
        return _GIT_COMMIT
    _GIT_COMMIT = os.getenv("GIT_COMMIT") or os.getenv("ROUTARIO_COMMIT") or ""
    if _GIT_COMMIT:
        return _GIT_COMMIT
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=Path(__file__).resolve().parents[2],
            check=False,
            capture_output=True,
            text=True,
            timeout=1,
        )
        _GIT_COMMIT = result.stdout.strip() if result.returncode == 0 else ""
    except Exception:
        _GIT_COMMIT = ""
    return _GIT_COMMIT or None


def _check_runtime() -> dict:
    db = get_db()
    now = datetime.now(timezone.utc)
    return {
        "ok": True,
        "optional": True,
        "app_version": "1.0.0",
        "git_commit": _git_commit(),
        "started_at": PROCESS_STARTED_AT.isoformat(),
        "uptime_seconds": round((now - PROCESS_STARTED_AT).total_seconds(), 1),
        "python_version": sys.version.split()[0],
        "platform": platform.platform(),
        "database_type": "sqlite" if getattr(db, "_is_sqlite", False) else "postgresql" if getattr(db, "_is_postgres", False) else "other",
    }


async def _check_protocol_listeners() -> dict:
    active_protocols = await get_active_device_protocols()
    expected: set[tuple[str, str]] = set()
    unknown_protocols: list[str] = []
    integration_protocols: list[str] = []
    for protocol in sorted(active_protocols):
        decoder = ProtocolRegistry.get_decoder(protocol)
        if not decoder:
            if IntegrationRegistry.is_integration(protocol):
                integration_protocols.append(protocol)
            else:
                unknown_protocols.append(protocol)
            continue
        for protocol_type in getattr(decoder, "PROTOCOL_TYPES", ["tcp"]):
            expected.add((protocol.lower(), protocol_type.lower()))

    running_rows = protocol_server_manager.running_protocols()
    running = {
        (row["protocol"].lower(), row["protocol_type"].lower())
        for row in running_rows
        if row.get("running")
    }
    missing = sorted(expected - running)
    unexpected = sorted(running - expected)
    return {
        "ok": not missing and not unknown_protocols,
        "active_protocols": sorted(active_protocols),
        "integration_protocols": integration_protocols,
        "expected_listeners": [
            {"protocol": protocol, "protocol_type": protocol_type}
            for protocol, protocol_type in sorted(expected)
        ],
        "running_listeners": running_rows,
        "missing_listeners": [
            {"protocol": protocol, "protocol_type": protocol_type}
            for protocol, protocol_type in missing
        ],
        "unexpected_listeners": [
            {"protocol": protocol, "protocol_type": protocol_type}
            for protocol, protocol_type in unexpected
        ],
        "unknown_protocols": unknown_protocols,
    }


def _task_ok(row: dict, max_age_seconds: int) -> bool:
    if not row.get("registered") or not row.get("running"):
        return False
    age = row.get("last_success_age_seconds")
    if age is None:
        uptime = row.get("uptime_seconds") or 0
        return uptime <= max_age_seconds
    return age <= max_age_seconds


def _check_background_tasks() -> dict:
    thresholds = {
        "alert_engine": 180,
        "integration_polling": 60,
        "schedule_runner": 180,
    }
    tasks = task_snapshot()
    checks = {}
    for name, max_age in thresholds.items():
        row = tasks.get(name, {"registered": False, "running": False})
        checks[name] = {
            **row,
            "max_success_age_seconds": max_age,
            "ok": _task_ok(row, max_age),
        }
    return {"ok": all(row["ok"] for row in checks.values()), "tasks": checks}


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


async def _check_ingestion_freshness() -> dict:
    now = datetime.now(timezone.utc)
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(Device.id, Device.name, Device.imei, DeviceState.last_update, DeviceState.is_online)
            .outerjoin(DeviceState, Device.id == DeviceState.device_id)
            .where(Device.is_active == True)
        )
        rows = result.all()

    latest = None
    stale_15m = []
    stale_1h = []
    never_seen = []
    online = 0
    for device_id, name, imei, last_update, is_online in rows:
        last_update = _as_utc(last_update)
        if is_online:
            online += 1
        if last_update is None:
            never_seen.append({"id": device_id, "name": name, "imei": imei})
            continue
        if latest is None or last_update > latest:
            latest = last_update
        age = (now - last_update).total_seconds()
        row = {"id": device_id, "name": name, "imei": imei, "age_seconds": round(age, 1)}
        if age > 900:
            stale_15m.append(row)
        if age > 3600:
            stale_1h.append(row)

    return {
        "ok": True,
        "optional": True,
        "active_devices": len(rows),
        "online_devices": online,
        "devices_with_positions": len(rows) - len(never_seen),
        "latest_position_at": latest.isoformat() if latest else None,
        "latest_position_age_seconds": round((now - latest).total_seconds(), 1) if latest else None,
        "never_seen_count": len(never_seen),
        "stale_over_15m_count": len(stale_15m),
        "stale_over_1h_count": len(stale_1h),
        "never_seen_sample": never_seen[:10],
        "stale_over_15m_sample": stale_15m[:10],
    }


@router.get("/health/live")
async def live():
    return {"status": "ok"}


@router.get("/health/ready")
async def ready(response: Response):
    settings = get_settings()
    checks = {
        "database": await _check_db(),
        "disk": _check_disk(),
        "redis": await _check_redis(),
        "valhalla": {"ok": is_valhalla_available(), "optional": not settings.valhalla_enabled},
        "protocol_listeners": await _check_protocol_listeners(),
        "background_tasks": _check_background_tasks(),
        "ingestion": await _check_ingestion_freshness(),
        "integration_accounts": await _check_integration_accounts(),
        "disk_capacity": _check_disk_capacity(),
        "database_pool": _check_database_pool(),
        "redis_mode": _check_redis_mode(),
        "runtime": _check_runtime(),
    }
    required_ok = (
        checks["database"]["ok"]
        and checks["disk"]["ok"]
        and checks["protocol_listeners"]["ok"]
        and checks["background_tasks"]["ok"]
    )
    if settings.valhalla_enabled and not checks["valhalla"]["ok"]:
        checks["valhalla"]["degraded"] = True
    if not required_ok:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {"status": "ok" if required_ok else "unready", "checks": checks}


@router.get("/health")
async def health(response: Response):
    return await ready(response)
