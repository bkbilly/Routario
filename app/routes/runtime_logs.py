from __future__ import annotations

import json
import asyncio

import jwt
from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect

from core.auth import require_admin
from core.config import get_settings
from core.database import get_db
from pydantic import BaseModel
from core.runtime_logs import runtime_log_buffer, is_debug_mode, set_debug_mode

router = APIRouter(prefix="/api/runtime-logs", tags=["runtime-logs"])


class DebugModeRequest(BaseModel):
    enabled: bool


@router.get("")
async def get_runtime_logs(
    limit: int = Query(1000, ge=1, le=5000),
    current_user: User = Depends(require_admin),
):
    return await runtime_log_buffer.snapshot(limit=limit)


@router.get("/debug-mode")
async def get_debug_mode(current_user: User = Depends(require_admin)):
    return {"enabled": is_debug_mode()}


@router.post("/debug-mode")
async def toggle_debug_mode(
    body: DebugModeRequest,
    current_user: User = Depends(require_admin),
):
    enabled = set_debug_mode(body.enabled)
    return {"enabled": enabled}


async def _user_from_ws_token(token: str) -> User | None:
    try:
        settings = get_settings()
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        user_id = int(payload["sub"])
    except Exception:
        return None
    return await get_db().get_user(user_id)


@router.websocket("/ws")
async def runtime_logs_ws(websocket: WebSocket, token: str = Query(...), limit: int = Query(1000, ge=1, le=5000)):
    user = await _user_from_ws_token(token)
    if not user:
        await websocket.close(code=4001)
        return
    if not user.is_admin:
        await websocket.close(code=4003)
        return

    await websocket.accept()
    snapshot = await runtime_log_buffer.snapshot(limit=limit)
    await websocket.send_text(json.dumps({"type": "runtime_log_snapshot", **snapshot}, default=str))
    queue = await runtime_log_buffer.subscribe()
    try:
        while True:
            payload = await queue.get()
            await websocket.send_text(json.dumps(payload, default=str))
    except asyncio.CancelledError:
        pass
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        await runtime_log_buffer.unsubscribe(queue)
