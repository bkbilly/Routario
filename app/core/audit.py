from typing import Any, Optional

from fastapi import Request

from core.database import get_db
from models import AuditLog, User


def request_ip(request: Optional[Request]) -> Optional[str]:
    if not request:
        return None
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()
    return request.client.host if request.client else None


async def write_audit_log(
    action: str,
    actor: Optional[User] = None,
    *,
    company_id: Optional[int] = None,
    target_type: Optional[str] = None,
    target_id: Optional[Any] = None,
    request: Optional[Request] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> None:
    db = get_db()
    actor_company = getattr(actor, "company_id", None) if actor else None
    async with db.get_session() as session:
        session.add(
            AuditLog(
                actor_user_id=getattr(actor, "id", None),
                company_id=company_id if company_id is not None else actor_company,
                action=action,
                target_type=target_type,
                target_id=str(target_id) if target_id is not None else None,
                ip_address=request_ip(request),
                user_agent=request.headers.get("user-agent") if request else None,
                metadata_json=metadata or {},
            )
        )
