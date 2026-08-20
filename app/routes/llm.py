"""
app/routes/llm.py

FastAPI routes for LLM Providers, Copilot Chat, and AI Custom Reports.
"""
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core.auth import get_current_user
from core.database import get_db
from core.permissions import user_has_permission
from llm.engine import execute_llm_chat, execute_llm_report
from llm.registry import LLMRegistry
from models import User

router = APIRouter(prefix="/api/llm", tags=["llm"])


class LLMChatRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=5000)
    history: Optional[list] = None


class LLMReportRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=5000)
    device_ids: Optional[list[int]] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None


def require_llm_permission(current_user: User = Depends(get_current_user)):
    if not user_has_permission(current_user, "llm"):
        raise HTTPException(
            status_code=403,
            detail="You do not have permission to access AI / LLM features.",
        )
    return current_user


@router.get("/providers")
async def get_llm_providers(current_user: User = Depends(get_current_user)):
    """Return metadata and field schemas for all registered LLM providers."""
    return LLMRegistry.all()


@router.post("/chat")
async def handle_llm_chat(
    req: LLMChatRequest,
    current_user: User = Depends(require_llm_permission),
):
    """Execute a Copilot query over fleet telemetry."""
    try:
        db = get_db()
        async with db.get_session() as session:
            response_text = await execute_llm_chat(
                session=session,
                user=current_user,
                prompt=req.prompt,
                history=req.history,
            )
            return {"response": response_text}
    except RuntimeError as err:
        raise HTTPException(status_code=400, detail=str(err))
    except Exception as err:
        raise HTTPException(status_code=500, detail=f"LLM Chat execution failed: {err}")


@router.post("/report")
async def handle_llm_report(
    req: LLMReportRequest,
    current_user: User = Depends(require_llm_permission),
):
    """Generate a custom AI Fleet Report."""
    try:
        db = get_db()
        async with db.get_session() as session:
            report_text = await execute_llm_report(
                session=session,
                user=current_user,
                prompt=req.prompt,
                device_ids=req.device_ids,
                start_time=req.start_time,
                end_time=req.end_time,
            )
            return {"report": report_text}
    except RuntimeError as err:
        raise HTTPException(status_code=400, detail=str(err))
    except Exception as err:
        raise HTTPException(status_code=500, detail=f"LLM Report generation failed: {err}")
