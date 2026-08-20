"""
Support ticket routes.

Access rules:
  Regular user  : create tickets, view/comment on own tickets
  Company admin : manage tickets in their company, assign to company admins or super admins
  Super admin   : manage all tickets
"""
from datetime import datetime
import os
import uuid
from pathlib import Path
from typing import Optional

import aiofiles
from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import selectinload

from core.audit import write_audit_log
from core.auth import get_current_user
from core.database import get_db
from core.permissions import user_has_permission
from models import SupportTicket, SupportTicketComment, User

router = APIRouter(prefix="/api/tickets", tags=["tickets"])
TICKET_UPLOAD_ROOT = Path("web/uploads/tickets")
MAX_TICKET_FILE_BYTES = 25 * 1024 * 1024
MAX_TICKET_FILES = 10

TICKET_STATUSES = {"open", "in_progress", "waiting_on_user", "resolved", "closed"}
TICKET_PRIORITIES = {"low", "normal", "high", "urgent"}
TICKET_CATEGORIES = {
    "device", "route", "driver", "billing", "alert", "maintenance", "access", "other",
}
RELATED_TYPES = {"device", "route", "driver", "alert", "trip", "maintenance", "user"}
CLOSED_STATUSES = {"resolved", "closed"}


class TicketCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: str = Field(..., min_length=1, max_length=5000)
    category: str = "other"
    priority: str = "normal"
    related_type: Optional[str] = None
    related_id: Optional[int] = None


class TicketUpdate(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = Field(None, min_length=1, max_length=5000)
    category: Optional[str] = None
    priority: Optional[str] = None
    status: Optional[str] = None
    assigned_to: Optional[int] = None
    related_type: Optional[str] = None
    related_id: Optional[int] = None


class TicketCommentCreate(BaseModel):
    body: str = Field("", max_length=5000)
    is_internal: bool = False


class TicketCommentUpdate(BaseModel):
    body: str = Field("", max_length=5000)
    is_internal: Optional[bool] = None


def _is_ticket_admin(user: User) -> bool:
    return bool(user.is_admin or user.is_company_admin)


def _require_ticket_permission(user: User) -> None:
    if not user_has_permission(user, "manage_tickets"):
        raise HTTPException(status_code=403, detail="Permission required: manage_tickets")


def _validate_choice(value: Optional[str], allowed: set[str], field: str) -> None:
    if value is not None and value not in allowed:
        raise HTTPException(status_code=400, detail=f"Invalid {field}")


def _ticket_query_for_user(current_user: User):
    stmt = select(SupportTicket).options(
        selectinload(SupportTicket.creator),
        selectinload(SupportTicket.assignee),
        selectinload(SupportTicket.company),
        selectinload(SupportTicket.comments).selectinload(SupportTicketComment.author),
    )
    if current_user.is_admin:
        return stmt
    if current_user.is_company_admin:
        return stmt.where(SupportTicket.company_id == current_user.company_id)
    return stmt.where(SupportTicket.created_by == current_user.id)


async def _get_ticket(ticket_id: int, current_user: User) -> SupportTicket:
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            _ticket_query_for_user(current_user).where(SupportTicket.id == ticket_id)
        )
        ticket = result.scalar_one_or_none()
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    return ticket


def _comment_visible(comment: SupportTicketComment, current_user: User) -> bool:
    return not comment.is_internal or _is_ticket_admin(current_user)


def _ticket_payload(ticket: SupportTicket, current_user: User) -> dict:
    ticket_attachments = ticket.attachments or _ticket_file_fallback(ticket.id, "ticket")
    comments = [
        {
            "id": c.id,
            "ticket_id": c.ticket_id,
            "author_id": c.author_id,
            "author_name": c.author.username if c.author else None,
            "body": c.body,
            "is_internal": c.is_internal,
            "attachments": c.attachments or [],
            "created_at": c.created_at,
        }
        for c in sorted(ticket.comments or [], key=lambda row: row.created_at)
        if _comment_visible(c, current_user)
    ]
    return {
        "id": ticket.id,
        "company_id": ticket.company_id,
        "company_name": ticket.company.name if ticket.company else None,
        "created_by": ticket.created_by,
        "creator_name": ticket.creator.username if ticket.creator else None,
        "assigned_to": ticket.assigned_to,
        "assignee_name": ticket.assignee.username if ticket.assignee else None,
        "title": ticket.title,
        "description": ticket.description,
        "category": ticket.category,
        "priority": ticket.priority,
        "status": ticket.status,
        "related_type": ticket.related_type,
        "related_id": ticket.related_id,
        "attachments": ticket_attachments,
        "created_at": ticket.created_at,
        "updated_at": ticket.updated_at,
        "closed_at": ticket.closed_at,
        "comments": comments,
    }


def _attachment_name(filename: str) -> str:
    cleaned = os.path.basename(filename or "attachment").strip() or "attachment"
    return cleaned[:180]


def _ticket_file_fallback(ticket_id: int, prefix: str) -> list[dict]:
    folder = TICKET_UPLOAD_ROOT / str(ticket_id)
    if not folder.is_dir():
        return []
    files = sorted(folder.glob(f"{prefix}-*"))
    return [
        {
            "name": path.name,
            "url": f"/uploads/tickets/{ticket_id}/{path.name}",
            "size": path.stat().st_size,
            "content_type": "application/octet-stream",
        }
        for path in files
        if path.is_file()
    ]


def _attachment_path(ticket_id: int, attachment: dict) -> Path | None:
    url = str((attachment or {}).get("url") or "")
    if not url.startswith(f"/uploads/tickets/{ticket_id}/"):
        return None
    filename = os.path.basename(url)
    path = (TICKET_UPLOAD_ROOT / str(ticket_id) / filename).resolve()
    root = (TICKET_UPLOAD_ROOT / str(ticket_id)).resolve()
    if root not in path.parents:
        return None
    return path


def _remove_attachment_file(ticket_id: int, attachment: dict) -> None:
    path = _attachment_path(ticket_id, attachment)
    if not path:
        return
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def _can_manage_ticket_attachments(ticket: SupportTicket, current_user: User) -> bool:
    return _is_ticket_admin(current_user) or ticket.created_by == current_user.id


def _can_manage_comment_attachments(comment: SupportTicketComment, current_user: User) -> bool:
    return _is_ticket_admin(current_user) or comment.author_id == current_user.id


async def _store_ticket_uploads(ticket_id: int, uploads: list[UploadFile], prefix: str) -> list[dict]:
    files = [upload for upload in uploads if upload and upload.filename]
    if len(files) > MAX_TICKET_FILES:
        raise HTTPException(status_code=400, detail=f"Maximum {MAX_TICKET_FILES} files per upload")

    target_dir = TICKET_UPLOAD_ROOT / str(ticket_id)
    target_dir.mkdir(parents=True, exist_ok=True)
    stored: list[dict] = []

    for upload in files:
        original = _attachment_name(upload.filename)
        ext = Path(original).suffix[:20]
        fname = f"{prefix}-{uuid.uuid4().hex}{ext}"
        fpath = target_dir / fname
        size = 0
        async with aiofiles.open(fpath, "wb") as out:
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_TICKET_FILE_BYTES:
                    await out.close()
                    try:
                        fpath.unlink(missing_ok=True)
                    except OSError:
                        pass
                    raise HTTPException(status_code=400, detail=f"File is too large: {original}")
                await out.write(chunk)
        stored.append({
            "name": original,
            "url": f"/uploads/tickets/{ticket_id}/{fname}",
            "size": size,
            "content_type": upload.content_type or "application/octet-stream",
        })
    return stored


def _is_upload_file(item) -> bool:
    return bool(getattr(item, "filename", None)) and callable(getattr(item, "read", None))


def _as_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


async def _ticket_create_from_request(request: Request) -> tuple[TicketCreate, list[UploadFile]]:
    content_type = request.headers.get("content-type", "")
    try:
        if content_type.startswith("multipart/form-data"):
            form = await request.form()
            data = TicketCreate(
                title=str(form.get("title") or ""),
                description=str(form.get("description") or ""),
                category=str(form.get("category") or "other"),
                priority=str(form.get("priority") or "normal"),
                related_type=str(form.get("related_type") or "") or None,
                related_id=int(form["related_id"]) if str(form.get("related_id") or "").strip() else None,
            )
            uploads = [item for item in form.getlist("attachments") if _is_upload_file(item)]
            return data, uploads
        return TicketCreate.model_validate(await request.json()), []
    except (ValidationError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="Invalid ticket fields") from exc


async def _comment_create_from_request(request: Request) -> tuple[TicketCommentCreate, list[UploadFile]]:
    content_type = request.headers.get("content-type", "")
    try:
        if content_type.startswith("multipart/form-data"):
            form = await request.form()
            data = TicketCommentCreate(
                body=str(form.get("body") or ""),
                is_internal=_as_bool(form.get("is_internal")),
            )
            uploads = [item for item in form.getlist("attachments") if _is_upload_file(item)]
            return data, uploads
        return TicketCommentCreate.model_validate(await request.json()), []
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail="Invalid comment fields") from exc


async def _ticket_update_from_request(request: Request) -> tuple[TicketUpdate, list[UploadFile]]:
    content_type = request.headers.get("content-type", "")
    try:
        if content_type.startswith("multipart/form-data"):
            form = await request.form()
            raw = {}
            for field in ("title", "description", "category", "priority", "status", "related_type"):
                if field in form:
                    raw[field] = str(form.get(field) or "").strip() or None
            if "assigned_to" in form:
                value = str(form.get("assigned_to") or "").strip()
                raw["assigned_to"] = int(value) if value else None
            if "related_id" in form:
                value = str(form.get("related_id") or "").strip()
                raw["related_id"] = int(value) if value else None
            uploads = [item for item in form.getlist("attachments") if _is_upload_file(item)]
            return TicketUpdate.model_validate(raw), uploads
        return TicketUpdate.model_validate(await request.json()), []
    except (ValidationError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="Invalid ticket fields") from exc


async def _comment_update_from_request(request: Request) -> tuple[TicketCommentUpdate, list[UploadFile]]:
    content_type = request.headers.get("content-type", "")
    try:
        if content_type.startswith("multipart/form-data"):
            form = await request.form()
            raw = {"body": str(form.get("body") or "")}
            if "is_internal" in form:
                raw["is_internal"] = _as_bool(form.get("is_internal"))
            uploads = [item for item in form.getlist("attachments") if _is_upload_file(item)]
            return TicketCommentUpdate.model_validate(raw), uploads
        return TicketCommentUpdate.model_validate(await request.json()), []
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail="Invalid comment fields") from exc


async def _validate_assignee(assignee_id: Optional[int], current_user: User) -> Optional[User]:
    if assignee_id is None:
        return None
    if not _is_ticket_admin(current_user):
        raise HTTPException(status_code=403, detail="Only admins can assign tickets")

    db = get_db()
    async with db.get_session() as session:
        target = await session.get(User, assignee_id)
    if not target:
        raise HTTPException(status_code=404, detail="Assignee not found")

    if current_user.is_admin:
        if not (target.is_admin or target.is_company_admin):
            raise HTTPException(status_code=400, detail="Tickets can only be assigned to admins")
        return target

    if target.is_admin:
        return target
    if target.is_company_admin and target.company_id == current_user.company_id:
        return target
    raise HTTPException(status_code=403, detail="Company admins can assign tickets only to company admins in their company or super admins")


@router.get("")
async def list_tickets(
    status: Optional[str] = Query(None),
    assigned_to: Optional[int] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
):
    _require_ticket_permission(current_user)
    _validate_choice(status, TICKET_STATUSES, "status")
    stmt = _ticket_query_for_user(current_user)
    if status:
        stmt = stmt.where(SupportTicket.status == status)
    if assigned_to is not None:
        stmt = stmt.where(SupportTicket.assigned_to == assigned_to)
    stmt = stmt.order_by(SupportTicket.updated_at.desc(), SupportTicket.id.desc()).limit(limit).offset(offset)

    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(stmt)
        tickets = result.scalars().all()
    return [_ticket_payload(ticket, current_user) for ticket in tickets]


@router.get("/assignees")
async def list_ticket_assignees(current_user: User = Depends(get_current_user)):
    _require_ticket_permission(current_user)
    if not _is_ticket_admin(current_user):
        raise HTTPException(status_code=403, detail="Only admins can assign tickets")

    db = get_db()
    async with db.get_session() as session:
        if current_user.is_admin:
            stmt = select(User).where(or_(User.is_admin == True, User.is_company_admin == True))
        else:
            stmt = select(User).where(
                or_(
                    User.is_admin == True,
                    and_(User.is_company_admin == True, User.company_id == current_user.company_id),
                )
            )
        result = await session.execute(stmt.order_by(User.is_admin.desc(), func.lower(User.username)))
        users = result.scalars().all()

    return [
        {
            "id": user.id,
            "username": user.username,
            "email": user.email,
            "is_admin": user.is_admin,
            "is_company_admin": user.is_company_admin,
            "company_id": user.company_id,
        }
        for user in users
    ]


@router.post("")
async def create_ticket(
    request: Request,
    current_user: User = Depends(get_current_user),
):
    data, uploads = await _ticket_create_from_request(request)
    _require_ticket_permission(current_user)
    _validate_choice(data.category, TICKET_CATEGORIES, "category")
    _validate_choice(data.priority, TICKET_PRIORITIES, "priority")
    _validate_choice(data.related_type, RELATED_TYPES, "related type")

    db = get_db()
    async with db.get_session() as session:
        ticket = SupportTicket(
            company_id=current_user.company_id,
            created_by=current_user.id,
            title=data.title.strip(),
            description=data.description.strip(),
            category=data.category,
            priority=data.priority,
            related_type=data.related_type,
            related_id=data.related_id,
            updated_at=datetime.utcnow(),
        )
        session.add(ticket)
        await session.flush()
        attachments = await _store_ticket_uploads(ticket.id, uploads, "ticket") if uploads else []
        ticket.attachments = attachments
        await session.flush()
        await session.refresh(ticket)
        ticket_id = ticket.id

    ticket = await _get_ticket(ticket_id, current_user)
    await write_audit_log("ticket.created", actor=current_user, company_id=ticket.company_id, target_type="support_ticket", target_id=ticket.id, request=request)
    return _ticket_payload(ticket, current_user)


@router.get("/{ticket_id}")
async def get_ticket(ticket_id: int, current_user: User = Depends(get_current_user)):
    _require_ticket_permission(current_user)
    ticket = await _get_ticket(ticket_id, current_user)
    return _ticket_payload(ticket, current_user)


@router.patch("/{ticket_id}")
async def update_ticket(
    ticket_id: int,
    request: Request,
    current_user: User = Depends(get_current_user),
):
    data, uploads = await _ticket_update_from_request(request)
    _require_ticket_permission(current_user)
    if not _is_ticket_admin(current_user):
        raise HTTPException(status_code=403, detail="Only admins can update tickets")
    _validate_choice(data.category, TICKET_CATEGORIES, "category")
    _validate_choice(data.priority, TICKET_PRIORITIES, "priority")
    _validate_choice(data.status, TICKET_STATUSES, "status")
    _validate_choice(data.related_type, RELATED_TYPES, "related type")
    await _validate_assignee(data.assigned_to, current_user)

    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            _ticket_query_for_user(current_user).where(SupportTicket.id == ticket_id)
        )
        ticket = result.scalar_one_or_none()
        if not ticket:
            raise HTTPException(status_code=404, detail="Ticket not found")

        old_assigned_to = ticket.assigned_to
        for field in ("title", "description", "category", "priority", "status", "assigned_to", "related_type", "related_id"):
            if field not in data.model_fields_set:
                continue
            value = getattr(data, field)
            if isinstance(value, str):
                value = value.strip()
            setattr(ticket, field, value)

        new_assigned_to = ticket.assigned_to
        assigned_changed = ("assigned_to" in data.model_fields_set) and (new_assigned_to != old_assigned_to) and (new_assigned_to is not None)

        ticket.updated_at = datetime.utcnow()
        if "status" in data.model_fields_set:
            ticket.closed_at = datetime.utcnow() if ticket.status in CLOSED_STATUSES else None
        if uploads:
            ticket.attachments = list(ticket.attachments or _ticket_file_fallback(ticket.id, "ticket")) + await _store_ticket_uploads(ticket.id, uploads, "ticket")

        await session.flush()

        if assigned_changed:
            try:
                from core.email import send_email_async
                assignee = await session.get(User, new_assigned_to)
                if assignee and assignee.email:
                    subject = f"[Routario Ticket #{ticket.id}] Assigned to you: {ticket.title}"
                    body = (
                        f"Hello {assignee.username},\n\n"
                        f"Support ticket #{ticket.id} (\"{ticket.title}\") has been assigned to you by {current_user.username}.\n\n"
                        f"Ticket Details:\n"
                        f"- ID: #{ticket.id}\n"
                        f"- Title: {ticket.title}\n"
                        f"- Priority: {ticket.priority}\n"
                        f"- Status: {ticket.status}\n"
                        f"- Category: {ticket.category}\n"
                        f"- Assigned By: {current_user.username}\n\n"
                        f"Best regards,\n"
                        f"Routario Telematics Platform"
                    )
                    asyncio.create_task(send_email_async([assignee.email], subject, body))
            except Exception as err:
                logger.error("Failed to trigger ticket assignment email: %s", err)

        await session.refresh(ticket)
        updated_id = ticket.id

    ticket = await _get_ticket(updated_id, current_user)
    await write_audit_log("ticket.updated", actor=current_user, company_id=ticket.company_id, target_type="support_ticket", target_id=ticket.id, request=request)
    return _ticket_payload(ticket, current_user)


@router.delete("/{ticket_id}/attachments/{attachment_index}")
async def delete_ticket_attachment(
    ticket_id: int,
    attachment_index: int,
    request: Request,
    current_user: User = Depends(get_current_user),
):
    _require_ticket_permission(current_user)
    ticket = await _get_ticket(ticket_id, current_user)
    if not _can_manage_ticket_attachments(ticket, current_user):
        raise HTTPException(status_code=403, detail="You cannot delete this attachment")

    attachments = list(ticket.attachments or _ticket_file_fallback(ticket.id, "ticket"))
    if attachment_index < 0 or attachment_index >= len(attachments):
        raise HTTPException(status_code=404, detail="Attachment not found")
    removed = attachments.pop(attachment_index)
    _remove_attachment_file(ticket.id, removed)

    db = get_db()
    async with db.get_session() as session:
        db_ticket = await session.get(SupportTicket, ticket.id)
        if db_ticket:
            db_ticket.attachments = attachments
            db_ticket.updated_at = datetime.utcnow()
            await session.flush()

    ticket = await _get_ticket(ticket.id, current_user)
    await write_audit_log("ticket.attachment.deleted", actor=current_user, company_id=ticket.company_id, target_type="support_ticket", target_id=ticket.id, request=request)
    return _ticket_payload(ticket, current_user)


@router.post("/{ticket_id}/comments")
async def add_ticket_comment(
    ticket_id: int,
    request: Request,
    current_user: User = Depends(get_current_user),
):
    data, uploads = await _comment_create_from_request(request)
    _require_ticket_permission(current_user)
    ticket = await _get_ticket(ticket_id, current_user)
    if not data.body.strip() and not uploads:
        raise HTTPException(status_code=400, detail="Comment or attachment is required")
    if data.is_internal and not _is_ticket_admin(current_user):
        raise HTTPException(status_code=403, detail="Only admins can add internal notes")

    db = get_db()
    async with db.get_session() as session:
        comment = SupportTicketComment(
            ticket_id=ticket.id,
            author_id=current_user.id,
            body=data.body.strip(),
            is_internal=data.is_internal,
            attachments=await _store_ticket_uploads(ticket.id, uploads, "comment") if uploads else [],
        )
        session.add(comment)
        db_ticket = await session.get(SupportTicket, ticket.id)
        if db_ticket:
            db_ticket.updated_at = datetime.utcnow()
        await session.flush()

    ticket = await _get_ticket(ticket.id, current_user)
    await write_audit_log("ticket.comment.created", actor=current_user, company_id=ticket.company_id, target_type="support_ticket", target_id=ticket.id, request=request, metadata={"is_internal": data.is_internal})
    return _ticket_payload(ticket, current_user)


@router.patch("/{ticket_id}/comments/{comment_id}")
async def update_ticket_comment(
    ticket_id: int,
    comment_id: int,
    request: Request,
    current_user: User = Depends(get_current_user),
):
    data, uploads = await _comment_update_from_request(request)
    _require_ticket_permission(current_user)
    ticket = await _get_ticket(ticket_id, current_user)
    if not data.body.strip() and not uploads:
        raise HTTPException(status_code=400, detail="Comment or attachment is required")
    if data.is_internal and not _is_ticket_admin(current_user):
        raise HTTPException(status_code=403, detail="Only admins can mark comments as internal")

    db = get_db()
    async with db.get_session() as session:
        comment = await session.get(SupportTicketComment, comment_id)
        if not comment or comment.ticket_id != ticket.id:
            raise HTTPException(status_code=404, detail="Comment not found")
        if comment.author_id != current_user.id:
            raise HTTPException(status_code=403, detail="You can edit only your own comments")
        if comment.is_internal and not _is_ticket_admin(current_user):
            raise HTTPException(status_code=403, detail="Only admins can edit internal notes")

        comment.body = data.body.strip()
        if data.is_internal is not None:
            comment.is_internal = data.is_internal
        if uploads:
            comment.attachments = list(comment.attachments or []) + await _store_ticket_uploads(ticket.id, uploads, "comment")
        db_ticket = await session.get(SupportTicket, ticket.id)
        if db_ticket:
            db_ticket.updated_at = datetime.utcnow()
        await session.flush()

    ticket = await _get_ticket(ticket.id, current_user)
    await write_audit_log(
        "ticket.comment.updated",
        actor=current_user,
        company_id=ticket.company_id,
        target_type="support_ticket",
        target_id=ticket.id,
        request=request,
        metadata={"comment_id": comment_id},
    )
    return _ticket_payload(ticket, current_user)


@router.delete("/{ticket_id}/comments/{comment_id}/attachments/{attachment_index}")
async def delete_ticket_comment_attachment(
    ticket_id: int,
    comment_id: int,
    attachment_index: int,
    request: Request,
    current_user: User = Depends(get_current_user),
):
    _require_ticket_permission(current_user)
    ticket = await _get_ticket(ticket_id, current_user)

    db = get_db()
    async with db.get_session() as session:
        comment = await session.get(SupportTicketComment, comment_id)
        if not comment or comment.ticket_id != ticket.id:
            raise HTTPException(status_code=404, detail="Comment not found")
        if comment.is_internal and not _is_ticket_admin(current_user):
            raise HTTPException(status_code=403, detail="Only admins can edit internal notes")
        if not _can_manage_comment_attachments(comment, current_user):
            raise HTTPException(status_code=403, detail="You cannot delete this attachment")

        attachments = list(comment.attachments or [])
        if attachment_index < 0 or attachment_index >= len(attachments):
            raise HTTPException(status_code=404, detail="Attachment not found")
        removed = attachments.pop(attachment_index)
        _remove_attachment_file(ticket.id, removed)
        comment.attachments = attachments

        db_ticket = await session.get(SupportTicket, ticket.id)
        if db_ticket:
            db_ticket.updated_at = datetime.utcnow()
        await session.flush()

    ticket = await _get_ticket(ticket.id, current_user)
    await write_audit_log(
        "ticket.comment.attachment.deleted",
        actor=current_user,
        company_id=ticket.company_id,
        target_type="support_ticket",
        target_id=ticket.id,
        request=request,
        metadata={"comment_id": comment_id},
    )
    return _ticket_payload(ticket, current_user)
