import hashlib
import secrets
from datetime import datetime
from typing import Optional

from sqlalchemy import select

from core.database import get_db
from models import ApiKey, UsageEvent, User

API_KEY_PREFIX = "rt_"


def generate_api_key() -> str:
    return API_KEY_PREFIX + secrets.token_urlsafe(32)


def hash_api_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


async def authenticate_api_key(raw_key: str, ip_address: Optional[str] = None) -> tuple[Optional[User], Optional[ApiKey]]:
    if not raw_key or not raw_key.startswith(API_KEY_PREFIX):
        return None, None
    db = get_db()
    key_hash = hash_api_key(raw_key)
    async with db.get_session() as session:
        result = await session.execute(select(ApiKey).where(ApiKey.key_hash == key_hash, ApiKey.is_active == True))
        api_key = result.scalar_one_or_none()
        if not api_key:
            return None, None
        if api_key.expires_at and api_key.expires_at < datetime.utcnow():
            return None, None
        user = await session.get(User, api_key.user_id)
        if not user:
            return None, None
        api_key.last_used_at = datetime.utcnow()
        api_key.last_used_ip = ip_address
        session.add(UsageEvent(company_id=api_key.company_id, metric="api_call", quantity=1, source="api_key", metadata_json={"api_key_id": api_key.id}))
        return user, api_key
