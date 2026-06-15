from pathlib import Path
from time import monotonic

from fastapi import APIRouter, Response, status
from sqlalchemy import text

from core.config import get_settings
from core.database import get_db
from core.valhalla import is_valhalla_available

router = APIRouter(tags=["health"])


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
    }
    required_ok = checks["database"]["ok"] and checks["disk"]["ok"]
    if settings.valhalla_enabled and not checks["valhalla"]["ok"]:
        checks["valhalla"]["degraded"] = True
    if not required_ok:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {"status": "ok" if required_ok else "unready", "checks": checks}


@router.get("/health")
async def health(response: Response):
    return await ready(response)
