"""
Auth Routes
Handles login and token issuance.
"""
from fastapi import APIRouter, HTTPException
import jwt

from core.database import get_db
from core.config import get_settings
from models.schemas import UserLogin, Token

router = APIRouter(prefix="/api", tags=["auth"])


@router.post("/login", response_model=Token)
async def login(form_data: UserLogin):
    db = get_db()
    user = await db.authenticate_user(form_data.username, form_data.password)
    if not user:
        raise HTTPException(status_code=400, detail="Incorrect username or password")

    settings = get_settings()
    token_data = {
        "sub": str(user.id),
        "name": user.username,
        "is_admin": user.is_admin,
    }
    token = jwt.encode(token_data, settings.secret_key, algorithm=settings.algorithm)

    return {
        "access_token": token,
        "token_type": "bearer",
        "user_id": user.id,
        "username": user.username,
        "is_admin": user.is_admin,
        "units": getattr(user, "units", "metric") or "metric",
    }
