from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import desc, select

from core.auth import require_company_admin
from core.database import get_db
from models import AuditLog, Company, User

router = APIRouter(prefix="/api/audit-logs", tags=["audit"])


def _require_audit_permission(user: User) -> None:
    if not user.is_admin and "view_audit" not in (user.permissions or []):
        raise HTTPException(status_code=403, detail="Permission required: view_audit")


def _row(log: AuditLog, actor_username: Optional[str] = None, company_name: Optional[str] = None) -> dict:
    return {
        "id": log.id,
        "actor_user_id": log.actor_user_id,
        "actor_username": actor_username,
        "company_id": log.company_id,
        "company_name": company_name,
        "action": log.action,
        "target_type": log.target_type,
        "target_id": log.target_id,
        "ip_address": log.ip_address,
        "user_agent": log.user_agent,
        "metadata": log.metadata_json or {},
        "created_at": log.created_at,
    }


@router.get("")
async def list_audit_logs(
    action: Optional[str] = Query(None),
    actor_user_id: Optional[int] = Query(None),
    company_id: Optional[int] = Query(None),
    start_date: Optional[datetime] = Query(None),
    end_date: Optional[datetime] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(require_company_admin),
):
    _require_audit_permission(current_user)
    db = get_db()
    if not end_date:
        end_date = datetime.utcnow()
    if not start_date:
        start_date = end_date - timedelta(days=30)

    async with db.get_session() as session:
        actor = User.__table__.alias("actor_user")
        company = Company.__table__.alias("audit_company")
        q = (
            select(AuditLog, actor.c.username, company.c.name)
            .outerjoin(actor, AuditLog.actor_user_id == actor.c.id)
            .outerjoin(company, AuditLog.company_id == company.c.id)
            .where(AuditLog.created_at >= start_date, AuditLog.created_at <= end_date)
        )
        if not current_user.is_admin:
            q = q.where(AuditLog.company_id == current_user.company_id)
        elif company_id is not None:
            q = q.where(AuditLog.company_id == company_id)
        if action:
            q = q.where(AuditLog.action == action)
        if actor_user_id is not None:
            q = q.where(AuditLog.actor_user_id == actor_user_id)
        q = q.order_by(desc(AuditLog.created_at)).limit(limit).offset(offset)
        result = await session.execute(q)
        return [_row(log, actor_username, company_name) for log, actor_username, company_name in result.all()]
