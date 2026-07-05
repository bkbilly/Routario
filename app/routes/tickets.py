"""
Support ticket routes.

Access rules:
  Regular user  : create tickets, view/comment on own tickets
  Company admin : manage tickets in their company, assign to company admins or super admins
  Super admin   : manage all tickets
"""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import selectinload

from core.audit import write_audit_log
from core.auth import get_current_user
from core.database import get_db
from core.permissions import user_has_permission
from models import SupportTicket, SupportTicketComment, User

router = APIRouter(prefix="/api/tickets", tags=["tickets"])

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
    body: str = Field(..., min_length=1, max_length=5000)
    is_internal: bool = False


class TicketCommentUpdate(BaseModel):
    body: str = Field(..., min_length=1, max_length=5000)
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
    comments = [
        {
            "id": c.id,
            "ticket_id": c.ticket_id,
            "author_id": c.author_id,
            "author_name": c.author.username if c.author else None,
            "body": c.body,
            "is_internal": c.is_internal,
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
        "created_at": ticket.created_at,
        "updated_at": ticket.updated_at,
        "closed_at": ticket.closed_at,
        "comments": comments,
    }


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
    data: TicketCreate,
    request: Request,
    current_user: User = Depends(get_current_user),
):
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
    data: TicketUpdate,
    request: Request,
    current_user: User = Depends(get_current_user),
):
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

        for field in ("title", "description", "category", "priority", "status", "assigned_to", "related_type", "related_id"):
            if field not in data.model_fields_set:
                continue
            value = getattr(data, field)
            if isinstance(value, str):
                value = value.strip()
            setattr(ticket, field, value)

        ticket.updated_at = datetime.utcnow()
        if "status" in data.model_fields_set:
            ticket.closed_at = datetime.utcnow() if ticket.status in CLOSED_STATUSES else None

        await session.flush()
        await session.refresh(ticket)
        updated_id = ticket.id

    ticket = await _get_ticket(updated_id, current_user)
    await write_audit_log("ticket.updated", actor=current_user, company_id=ticket.company_id, target_type="support_ticket", target_id=ticket.id, request=request)
    return _ticket_payload(ticket, current_user)


@router.post("/{ticket_id}/comments")
async def add_ticket_comment(
    ticket_id: int,
    data: TicketCommentCreate,
    request: Request,
    current_user: User = Depends(get_current_user),
):
    _require_ticket_permission(current_user)
    ticket = await _get_ticket(ticket_id, current_user)
    if data.is_internal and not _is_ticket_admin(current_user):
        raise HTTPException(status_code=403, detail="Only admins can add internal notes")

    db = get_db()
    async with db.get_session() as session:
        comment = SupportTicketComment(
            ticket_id=ticket.id,
            author_id=current_user.id,
            body=data.body.strip(),
            is_internal=data.is_internal,
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
    data: TicketCommentUpdate,
    request: Request,
    current_user: User = Depends(get_current_user),
):
    _require_ticket_permission(current_user)
    ticket = await _get_ticket(ticket_id, current_user)
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
