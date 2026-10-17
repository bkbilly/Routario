"""
app/routes/system_update.py - System Update & Version Management Endpoints
Provides API endpoints for checking versions, polling GitHub updates,
and executing in-app updates with live log tracking.
"""

import asyncio
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from core.audit import write_audit_log
from core.auth import get_current_user, require_admin
from core.system_update import (
    check_for_updates,
    get_app_version,
    get_deployment_info,
    get_update_status,
    get_version_details,
    start_system_update,
    _restart_server_task,
)
from models import User

router = APIRouter(prefix="/api/system", tags=["system-update"])


class UpdateTriggerRequest(BaseModel):
    target_version: Optional[str] = None


@router.get("/version")
async def get_version_info(
    check: bool = Query(False, description="Force a live check against GitHub releases"),
    current_user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """
    Get current running Routario version and GitHub update availability.
    """
    try:
        update_info = await check_for_updates(force=check)
    except Exception as exc:
        update_info = {
            "current_version": get_app_version(),
            "latest_version": get_app_version(),
            "update_available": False,
            "error": str(exc),
            "deployment": get_deployment_info(),
            "version_details": get_version_details(),
        }
    return update_info


@router.get("/update/status")
async def get_system_update_status(
    current_user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """
    Retrieve live status and terminal output of any ongoing system update (Superuser only).
    """
    return get_update_status()


@router.post("/update")
async def trigger_system_update(
    request: Request,
    body: Optional[UpdateTriggerRequest] = None,
    current_user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """
    Initiate an in-app system update (Superuser only).
    """
    target = body.target_version if body else None
    result = await start_system_update(target_version=target)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "Update failed to start"))

    await write_audit_log(
        action="system_update_started",
        actor=current_user,
        target_type="system",
        target_id="routario",
        request=request,
        metadata={"target_version": target or "latest"},
    )
    return result


@router.post("/restart")
async def trigger_system_restart(
    request: Request,
    current_user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """
    Manually trigger a graceful restart of the Routario server (Superuser only).
    """
    await write_audit_log(
        action="system_restart",
        actor=current_user,
        target_type="system",
        target_id="routario",
        request=request,
    )
    asyncio.create_task(_restart_server_task())
    return {
        "ok": True,
        "message": "Server restart initiated. Service will be back online shortly.",
    }
