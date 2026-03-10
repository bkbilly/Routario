"""
Logbook Routes
Vehicle maintenance / service log entries per device.

Access rules:
  GET    /api/devices/{device_id}/logbook          → device access required
  POST   /api/devices/{device_id}/logbook          → device access required
  PUT    /api/devices/{device_id}/logbook/{entry_id} → device access required
  DELETE /api/devices/{device_id}/logbook/{entry_id} → device access required
"""
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Form
from pydantic import BaseModel
from sqlalchemy import select

from core.database import get_db
from core.auth import get_current_user, verify_device_access
from models import User
from models.logbook import LogbookEntry

router = APIRouter(prefix="/api/devices", tags=["logbook"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class LogbookEntryResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    device_id: int
    description: str
    odometer: Optional[float]
    date: datetime
    price: Optional[float]
    documents: List[str]
    created_at: datetime
    created_by: int


# ── Helpers ───────────────────────────────────────────────────────────────────

def _naive_utc(dt: datetime) -> datetime:
    """Strip timezone info so it can be stored in TIMESTAMP WITHOUT TIME ZONE."""
    return dt.replace(tzinfo=None) if dt.tzinfo is not None else dt


async def _get_entry_or_404(session, device_id: int, entry_id: int) -> LogbookEntry:
    result = await session.execute(
        select(LogbookEntry).where(
            LogbookEntry.id == entry_id,
            LogbookEntry.device_id == device_id,
        )
    )
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Logbook entry not found")
    return entry


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/{device_id}/logbook", response_model=List[LogbookEntryResponse])
async def list_logbook(
    device_id: int,
    current_user: User = Depends(verify_device_access),
):
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(LogbookEntry)
            .where(LogbookEntry.device_id == device_id)
            .order_by(LogbookEntry.date.desc())
        )
        return result.scalars().all()


@router.post("/{device_id}/logbook", response_model=LogbookEntryResponse)
async def create_logbook_entry(
    device_id: int,
    description: str = Form(...),
    odometer: Optional[float] = Form(None),
    date: datetime = Form(...),
    price: Optional[float] = Form(None),
    documents: List[UploadFile] = File(default=[]),
    current_user: User = Depends(verify_device_access),
):
    import os, uuid, aiofiles

    doc_paths: List[str] = []
    upload_dir = f"web/uploads/logbook/{device_id}"
    os.makedirs(upload_dir, exist_ok=True)

    for doc in documents:
        if doc.filename:
            ext = os.path.splitext(doc.filename)[1]
            fname = f"{uuid.uuid4().hex}{ext}"
            fpath = os.path.join(upload_dir, fname)
            async with aiofiles.open(fpath, "wb") as f:
                await f.write(await doc.read())
            doc_paths.append(f"/uploads/logbook/{device_id}/{fname}")

    db = get_db()
    async with db.get_session() as session:
        entry = LogbookEntry(
            device_id=device_id,
            description=description,
            odometer=odometer,
            date=_naive_utc(date),
            price=price,
            documents=doc_paths,
            created_by=current_user.id,
        )
        session.add(entry)
        await session.flush()
        await session.refresh(entry)
        return entry


@router.put("/{device_id}/logbook/{entry_id}", response_model=LogbookEntryResponse)
async def update_logbook_entry(
    device_id: int,
    entry_id: int,
    description: str = Form(...),
    odometer: Optional[float] = Form(None),
    date: datetime = Form(...),
    price: Optional[float] = Form(None),
    current_user: User = Depends(verify_device_access),
):
    db = get_db()
    async with db.get_session() as session:
        entry = await _get_entry_or_404(session, device_id, entry_id)
        entry.description = description
        entry.odometer = odometer
        entry.date = _naive_utc(date)
        entry.price = price
        await session.flush()
        await session.refresh(entry)
        return entry


@router.delete("/{device_id}/logbook/{entry_id}")
async def delete_logbook_entry(
    device_id: int,
    entry_id: int,
    current_user: User = Depends(verify_device_access),
):
    import os, logging
    db = get_db()
    async with db.get_session() as session:
        entry = await _get_entry_or_404(session, device_id, entry_id)
        doc_paths = list(entry.documents or [])
        await session.delete(entry)

    # Remove uploaded files from disk after the DB row is gone
    for url_path in doc_paths:
        # url_path is like /uploads/logbook/{device_id}/filename.ext
        # Map it to the actual filesystem path under web/
        fs_path = os.path.join("web", url_path.lstrip("/"))
        try:
            if os.path.isfile(fs_path):
                os.remove(fs_path)
        except OSError as exc:
            logging.getLogger(__name__).warning("Could not delete file %s: %s", fs_path, exc)

    return {"status": "deleted"}