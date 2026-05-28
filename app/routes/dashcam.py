"""
Dashcam Route
Video clip upload and retrieval for Teltonika DualCam and generic HTTP cameras.

Upload endpoint is unauthenticated — device identifies itself via IMEI.
All read/delete endpoints require a logged-in user.
"""
import subprocess
import uuid
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select, delete as sql_delete

from core.auth import get_current_user, require_company_admin
from core.database import get_db
from models.models import Device, PositionRecord, User, VideoClip, user_device_association
from models.schemas import VideoClipResponse

router = APIRouter(prefix="/api/dashcam", tags=["dashcam"])

CLIP_DIR = Path(__file__).parent.parent.parent / "web" / "uploads" / "dashcam"

TELTONIKA_EVENT_TYPES = {
    0: "manual",
    1: "harsh_brake",
    2: "harsh_accel",
    3: "harsh_corner",
    4: "collision",
    5: "overspeeding",
    6: "jamming",
}

CAMERA_CHANNELS = {0: "front", 1: "rear", 2: "interior"}


def _generate_thumbnail(video_path: Path, thumb_path: Path) -> bool:
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", str(video_path), "-frames:v", "1", "-q:v", "5", str(thumb_path)],
            capture_output=True, timeout=15,
        )
        return result.returncode == 0 and thumb_path.exists()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


@router.post("/upload")
async def upload_clip(
    imei: str = Form(...),
    timestamp: Optional[int] = Form(None),
    type: Optional[int] = Form(None),
    event_type: Optional[str] = Form(None),
    channel: Optional[int] = Form(0),
    lat: Optional[float] = Form(None),
    lon: Optional[float] = Form(None),
    speed: Optional[float] = Form(None),
    file: UploadFile = File(...),
):
    """
    Teltonika DualCam / generic HTTP camera upload.
    Configure the camera's media server URL to point here.
    Required field: imei. Optional: timestamp (Unix ms or s), type (Teltonika
    event int), event_type (string), channel (0=front,1=rear,2=interior),
    lat, lon, speed, file.
    """
    db = get_db()
    async with db.get_session() as session:
        device = (await session.execute(
            select(Device).where(Device.imei == imei)
        )).scalar_one_or_none()
        if not device:
            raise HTTPException(404, f"No device with IMEI {imei}")

        if event_type is None:
            event_type = TELTONIKA_EVENT_TYPES.get(type or 0, "manual")
        camera = CAMERA_CHANNELS.get(channel or 0, "front")

        if timestamp:
            ts = datetime.utcfromtimestamp(timestamp / 1000 if timestamp > 1e10 else timestamp)
        else:
            ts = datetime.utcnow()

        # If the camera didn't send coordinates, find the nearest position record
        # for this device within ±30 seconds and use its lat/lon/speed.
        if lat is None or lon is None:
            from datetime import timedelta
            window_start = ts - timedelta(seconds=30)
            window_end   = ts + timedelta(seconds=30)
            candidates = (await session.execute(
                select(PositionRecord)
                .where(
                    PositionRecord.device_id == device.id,
                    PositionRecord.device_time >= window_start,
                    PositionRecord.device_time <= window_end,
                )
            )).scalars().all()
            if candidates:
                nearest = min(candidates, key=lambda p: abs((p.device_time - ts).total_seconds()))
                lat   = lat   or nearest.latitude
                lon   = lon   or nearest.longitude
                speed = speed or nearest.speed

        device_dir = CLIP_DIR / str(device.id)
        device_dir.mkdir(parents=True, exist_ok=True)
        ext = Path(file.filename or "clip.mp4").suffix or ".mp4"
        fname = f"{uuid.uuid4().hex}{ext}"
        fpath = device_dir / fname
        content = await file.read()
        fpath.write_bytes(content)

        thumb_rel = None
        thumb_path = fpath.with_suffix(".jpg")
        if _generate_thumbnail(fpath, thumb_path):
            thumb_rel = f"{device.id}/{thumb_path.name}"

        clip = VideoClip(
            device_id=device.id,
            timestamp=ts,
            event_type=event_type,
            camera=camera,
            latitude=lat,
            longitude=lon,
            speed=speed,
            file_path=f"{device.id}/{fname}",
            thumbnail_path=thumb_rel,
            file_size=len(content),
        )
        session.add(clip)
        await session.commit()
        await session.refresh(clip)
        return {"id": clip.id, "status": "ok"}


@router.get("/clips", response_model=List[VideoClipResponse])
async def list_clips(
    device_id: Optional[int] = Query(None),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    event_type: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    db = get_db()
    async with db.get_session() as session:
        q = select(VideoClip).order_by(VideoClip.timestamp.desc())
        if device_id:
            q = q.where(VideoClip.device_id == device_id)
        if start:
            q = q.where(VideoClip.timestamp >= start)
        if end:
            q = q.where(VideoClip.timestamp <= end)
        if event_type:
            q = q.where(VideoClip.event_type == event_type)
        if not current_user.is_admin:
            accessible = select(user_device_association.c.device_id).where(
                user_device_association.c.user_id == current_user.id
            )
            q = q.where(VideoClip.device_id.in_(accessible))
        clips = (await session.execute(q.limit(200))).scalars().all()
        return clips


@router.delete("/clips/{clip_id}", status_code=204)
async def delete_clip(clip_id: int, _: User = Depends(require_company_admin)):
    db = get_db()
    async with db.get_session() as session:
        clip = (await session.execute(
            select(VideoClip).where(VideoClip.id == clip_id)
        )).scalar_one_or_none()
        if not clip:
            raise HTTPException(404)
        for rel in [clip.file_path, clip.thumbnail_path]:
            if rel:
                p = CLIP_DIR / rel
                p.unlink(missing_ok=True)
        await session.execute(sql_delete(VideoClip).where(VideoClip.id == clip_id))
        await session.commit()


@router.get("/clips/{clip_id}/video")
async def serve_video(clip_id: int, current_user: User = Depends(get_current_user)):
    db = get_db()
    async with db.get_session() as session:
        clip = (await session.execute(
            select(VideoClip).where(VideoClip.id == clip_id)
        )).scalar_one_or_none()
        if not clip or not clip.file_path:
            raise HTTPException(404)
        path = CLIP_DIR / clip.file_path
        if not path.exists():
            raise HTTPException(404, "Video file not found")
        return FileResponse(str(path), media_type="video/mp4")


@router.get("/clips/{clip_id}/thumbnail")
async def serve_thumbnail(clip_id: int, current_user: User = Depends(get_current_user)):
    db = get_db()
    async with db.get_session() as session:
        clip = (await session.execute(
            select(VideoClip).where(VideoClip.id == clip_id)
        )).scalar_one_or_none()
        if not clip or not clip.thumbnail_path:
            raise HTTPException(404)
        path = CLIP_DIR / clip.thumbnail_path
        if not path.exists():
            raise HTTPException(404)
        return FileResponse(str(path), media_type="image/jpeg")
