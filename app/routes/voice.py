"""
Voice PTT Route
WebSocket-based push-to-talk with message persistence.
"""
import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

import jwt
from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from sqlalchemy import select, delete as sql_delete
from sqlalchemy.orm import selectinload

from core.auth import get_current_user, require_admin, require_company_admin, require_permission
from core.config import get_settings
from core.database import get_db
from core.push_notifications import get_push_service
from models.models import User, VoiceMessage, VoiceMessageRead

router = APIRouter(prefix="/api/voice", tags=["voice"])

AUDIO_DIR = Path(__file__).parent.parent.parent / "web" / "uploads" / "voice"


# ── Connection Manager ────────────────────────────────────────────────────────

class _VoiceManager:
    def __init__(self):
        self._ws: Dict[int, List[WebSocket]] = {}   # user_id -> all open tabs
        self._users: Dict[int, User] = {}

    def connect(self, user: User, ws: WebSocket):
        self._ws.setdefault(user.id, []).append(ws)
        self._users[user.id] = user

    def disconnect(self, user_id: int, ws: WebSocket):
        conns = self._ws.get(user_id, [])
        if ws in conns:
            conns.remove(ws)
        if not conns:
            self._ws.pop(user_id, None)
            self._users.pop(user_id, None)

    def targets(self, sender: User, recipients: List[int]) -> List[int]:
        if recipients:
            return [uid for uid in recipients if uid != sender.id and uid in self._ws]
        return [
            uid for uid, u in self._users.items()
            if uid != sender.id and (
                sender.is_admin
                or u.company_id == sender.company_id
                or u.is_admin
            )
        ]

    async def send_json(self, user_ids: List[int], data: dict):
        for uid in user_ids:
            dead = []
            for ws in list(self._ws.get(uid, [])):
                try:
                    await ws.send_json(data)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self.disconnect(uid, ws)

    async def send_bytes(self, user_ids: List[int], data: bytes):
        for uid in user_ids:
            dead = []
            for ws in list(self._ws.get(uid, [])):
                try:
                    await ws.send_bytes(data)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self.disconnect(uid, ws)

    async def send_to_user(self, user_id: int, data: dict):
        """Send to all open tabs of a single user."""
        await self.send_json([user_id], data)


_mgr = _VoiceManager()


async def _all_intended_recipients(sender: User, recipients: List[int]) -> List[int]:
    """Return all user IDs who should receive this message (connected or not)."""
    if recipients:
        return [uid for uid in recipients if uid != sender.id]
    # Broadcast — query all PTT-enabled users in scope from DB
    db = get_db()
    async with db.get_session() as sess:
        q = select(User).where(User.id != sender.id)
        if not sender.is_admin:
            q = q.where(User.company_id == sender.company_id)
        result = await sess.execute(q)
        return [
            u.id for u in result.scalars().all()
            if u.is_admin or "voice_ptt" in (u.permissions or [])
        ]


async def _notify_offline(sender: User, all_ids: List[int], live_ids: List[int], dur_str: str):
    """Push to intended recipients who did NOT receive the live WS audio."""
    push     = get_push_service()
    db       = get_db()
    live_set = set(live_ids)
    for uid in all_ids:
        if uid not in live_set:
            await push.notify_user_direct(
                db,
                uid,
                title=f"🎙 Voice message from {sender.username}",
                message=f"{dur_str} — tap to listen",
            )


async def _authenticate_ws(token: str) -> Optional[User]:
    try:
        settings = get_settings()
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        user_id = int(payload["sub"])
        return await get_db().get_user(user_id)
    except Exception:
        return None


# ── WebSocket endpoint ────────────────────────────────────────────────────────

@router.websocket("/ws")
async def voice_ws(websocket: WebSocket, token: str = Query(...)):
    user = await _authenticate_ws(token)
    if not user:
        await websocket.close(code=4001)
        return
    if not user.is_admin and "voice_ptt" not in (user.permissions or []):
        await websocket.close(code=4003)
        return

    await websocket.accept()
    _mgr.connect(user, websocket)

    session_id: Optional[str] = None
    recipients: List[int] = []
    buf = bytearray()
    started_at: Optional[datetime] = None

    try:
        while True:
            msg = await websocket.receive()

            if "text" in msg:
                try:
                    data = json.loads(msg["text"])
                except Exception:
                    continue
                t = data.get("type")

                if t == "start":
                    session_id = str(uuid.uuid4())
                    recipients = data.get("recipients", [])
                    buf = bytearray()
                    started_at = datetime.utcnow()
                    tgts = _mgr.targets(user, recipients)
                    await _mgr.send_json(tgts, {
                        "type": "transmitting",
                        "session_id": session_id,
                        "sender_id": user.id,
                        "sender_name": user.username,
                    })

                elif t == "end" and session_id:
                    duration = (datetime.utcnow() - started_at).total_seconds() if started_at else 0
                    dur_str   = f"{int(duration // 60)}:{int(duration % 60):02d}"
                    tgts      = _mgr.targets(user, recipients)
                    await _mgr.send_json(tgts, {
                        "type": "done",
                        "session_id": session_id,
                        "sender_id": user.id,
                        "sender_name": user.username,
                        "duration": round(duration, 1),
                    })
                    if buf:
                        fname = f"{session_id}.webm"
                        (AUDIO_DIR / fname).write_bytes(bytes(buf))
                        all_ids = await _all_intended_recipients(user, recipients)
                        # Derive company_id from recipients when sender has none (super admin)
                        msg_company_id = user.company_id
                        if not msg_company_id and recipients:
                            db = get_db()
                            async with db.get_session() as sess:
                                r = await sess.execute(
                                    select(User.company_id)
                                    .where(User.id.in_(recipients))
                                    .limit(1)
                                )
                                msg_company_id = r.scalar_one_or_none()
                        db = get_db()
                        async with db.get_session() as sess:
                            vm = VoiceMessage(
                                sender_id=user.id,
                                company_id=msg_company_id,
                                recipient_ids=recipients,
                                file_path=fname,
                                duration_seconds=round(duration, 1),
                            )
                            sess.add(vm)
                        await _notify_offline(user, all_ids, tgts, dur_str)
                    session_id = None
                    buf = bytearray()
                    recipients = []
                    started_at = None

            elif "bytes" in msg and session_id:
                chunk = msg["bytes"]
                buf.extend(chunk)
                tgts = _mgr.targets(user, recipients)
                framed = session_id.encode() + b"|" + chunk
                await _mgr.send_bytes(tgts, framed)

    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        _mgr.disconnect(user.id, websocket)


# ── REST endpoints ────────────────────────────────────────────────────────────

@router.get("/users")
async def voice_users(current_user: User = Depends(require_permission("voice_ptt"))):
    db = get_db()
    async with db.get_session() as sess:
        result = await sess.execute(select(User))
        all_users = result.scalars().all()

    def _has_ptt(u: User) -> bool:
        return u.is_admin or "voice_ptt" in (u.permissions or [])

    if current_user.is_admin:
        users = [u for u in all_users if u.id != current_user.id and _has_ptt(u)]
    else:
        users = [
            u for u in all_users
            if u.id != current_user.id
            and _has_ptt(u)
            and (u.company_id == current_user.company_id or u.is_admin)
        ]
    return [
        {
            "id": u.id,
            "username": u.username,
            "is_admin": u.is_admin,
            "is_company_admin": u.is_company_admin,
        }
        for u in sorted(users, key=lambda u: u.username.lower())
    ]


@router.get("/messages")
async def list_messages(
    current_user: User = Depends(require_permission("voice_ptt")),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    from sqlalchemy import func, or_
    db = get_db()
    async with db.get_session() as sess:
        def _scope(q):
            if not current_user.is_admin:
                return q.where(or_(
                    VoiceMessage.company_id == current_user.company_id,
                    VoiceMessage.company_id.is_(None),
                ))
            return q

        total = (await sess.execute(
            _scope(select(func.count(VoiceMessage.id)))
        )).scalar_one()

        q = _scope(select(VoiceMessage)).options(
            selectinload(VoiceMessage.sender)
        ).order_by(VoiceMessage.created_at.desc()).offset((page - 1) * page_size).limit(page_size)

        result = await sess.execute(q)
        msgs = result.scalars().all()

        read_result = await sess.execute(
            select(VoiceMessageRead.message_id)
            .where(VoiceMessageRead.user_id == current_user.id)
        )
        read_ids = {row[0] for row in read_result}

    pages = max(1, (total + page_size - 1) // page_size)
    return {
        "items": [_to_dict(m, read_ids) for m in msgs],
        "total": total,
        "page": page,
        "pages": pages,
        "page_size": page_size,
    }


@router.post("/messages/read-all")
async def mark_all_read(current_user: User = Depends(require_permission("voice_ptt"))):
    db = get_db()
    async with db.get_session() as sess:
        q = select(VoiceMessage.id)
        if not current_user.is_admin:
            from sqlalchemy import or_
            q = q.where(
                or_(
                    VoiceMessage.company_id == current_user.company_id,
                    VoiceMessage.company_id.is_(None),
                )
            )
        result = await sess.execute(q)
        msg_ids = [row[0] for row in result]
        existing = await sess.execute(
            select(VoiceMessageRead.message_id)
            .where(VoiceMessageRead.user_id == current_user.id)
        )
        already_read = {row[0] for row in existing}
        for mid in msg_ids:
            if mid not in already_read:
                sess.add(VoiceMessageRead(message_id=mid, user_id=current_user.id))
    await _mgr.send_to_user(current_user.id, {"type": "read_all"})
    return {"ok": True}


@router.post("/messages/{message_id}/read")
async def mark_read(message_id: int, current_user: User = Depends(require_permission("voice_ptt"))):
    db = get_db()
    async with db.get_session() as sess:
        existing = await sess.execute(
            select(VoiceMessageRead)
            .where(VoiceMessageRead.message_id == message_id, VoiceMessageRead.user_id == current_user.id)
        )
        if not existing.scalar_one_or_none():
            sess.add(VoiceMessageRead(message_id=message_id, user_id=current_user.id))
    await _mgr.send_to_user(current_user.id, {"type": "message_read", "message_id": message_id})
    return {"ok": True}


@router.get("/messages/{message_id}/audio")
async def get_audio(message_id: int, current_user: User = Depends(require_permission("voice_ptt"))):
    db = get_db()
    async with db.get_session() as sess:
        result = await sess.execute(select(VoiceMessage).where(VoiceMessage.id == message_id))
        msg = result.scalar_one_or_none()
    if not msg:
        raise HTTPException(404)
    if not current_user.is_admin and msg.company_id is not None and msg.company_id != current_user.company_id:
        raise HTTPException(403)
    path = AUDIO_DIR / msg.file_path
    if not path.exists():
        raise HTTPException(404, "Audio file not found")
    return FileResponse(str(path), media_type="audio/webm")


@router.delete("/messages")
async def delete_all_messages(current_user: User = Depends(require_admin)):
    """Delete every voice message and its audio file. Super admin only."""
    db = get_db()
    async with db.get_session() as sess:
        result = await sess.execute(select(VoiceMessage.file_path))
        for (fp,) in result:
            path = AUDIO_DIR / fp
            if path.exists():
                path.unlink(missing_ok=True)
        await sess.execute(sql_delete(VoiceMessage))
    return {"ok": True}


@router.delete("/messages/{message_id}")
async def delete_message(
    message_id: int,
    current_user: User = Depends(require_company_admin),
):
    db = get_db()
    async with db.get_session() as sess:
        result = await sess.execute(select(VoiceMessage).where(VoiceMessage.id == message_id))
        msg = result.scalar_one_or_none()
        if not msg:
            raise HTTPException(404)
        if not current_user.is_admin and msg.company_id != current_user.company_id:
            raise HTTPException(403)
        path = AUDIO_DIR / msg.file_path
        if path.exists():
            path.unlink()
        await sess.delete(msg)
    return {"ok": True}


def _to_dict(m: VoiceMessage, read_ids: set = None) -> dict:
    return {
        "id": m.id,
        "sender_id": m.sender_id,
        "sender_name": m.sender.username if m.sender else "Unknown",
        "company_id": m.company_id,
        "recipient_ids": m.recipient_ids or [],
        "duration_seconds": m.duration_seconds,
        "created_at": m.created_at.isoformat() + "Z",
        "is_read": m.id in (read_ids or set()),
    }
