"""
System Settings Routes
Superuser management of platform-wide configuration settings.
"""
from datetime import datetime
from typing import Any, Dict, List, Optional
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select

from core.audit import write_audit_log
from core.auth import require_admin, get_current_user
from core.config import SYSTEM_SETTINGS_METADATA, apply_setting_to_runtime, get_settings
from core.database import get_db
from models import SystemSetting, User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/system-settings", tags=["system-settings"])


def _mask_secret(val: Any) -> str:
    return ""


async def load_system_settings_from_db_session(session) -> None:
    """Load DB overrides into the runtime settings instance."""
    stmt = select(SystemSetting)
    res = await session.execute(stmt)
    records = res.scalars().all()
    for row in records:
        if row.key in SYSTEM_SETTINGS_METADATA:
            meta = SYSTEM_SETTINGS_METADATA[row.key]
            if not meta.get("readonly", False):
                apply_setting_to_runtime(row.key, row.value)


@router.get("/public", response_model=Dict[str, Any])
async def get_public_system_settings() -> Dict[str, Any]:
    """Retrieve public non-secret client settings for all authenticated users."""
    settings_obj = get_settings()
    return {
        "history_batch_size": getattr(settings_obj, "history_batch_size", 2000),
        "history_max_api_limit": getattr(settings_obj, "history_max_api_limit", 10000),
        "trip_min_distance_km": getattr(settings_obj, "trip_min_distance_km", 0.1),
        "trip_min_duration_seconds": getattr(settings_obj, "trip_min_duration_seconds", 60),
        "llm_enabled": getattr(settings_obj, "llm_enabled", False),
        "smtp_enabled": getattr(settings_obj, "smtp_enabled", False),
        "voip_enabled": getattr(settings_obj, "voip_enabled", False),
    }


@router.get("", response_model=Dict[str, Any])
async def get_system_settings(
    current_user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Retrieve all system settings grouped by category (Superuser only)."""
    settings_obj = get_settings()
    db = get_db()

    # Load custom DB overrides to be accurate
    db_values: Dict[str, str] = {}
    try:
        async with db.get_session() as session:
            stmt = select(SystemSetting)
            res = await session.execute(stmt)
            for row in res.scalars().all():
                db_values[row.key] = row.value
    except Exception as e:
        logger.warning("Could not read system_settings table: %s", e)

    categories: Dict[str, List[Dict[str, Any]]] = {}

    for key, meta in SYSTEM_SETTINGS_METADATA.items():
        cat = meta.get("category", "General")
        is_secret = meta.get("secret", False)
        is_readonly = meta.get("readonly", False)

        raw_val = getattr(settings_obj, key, None)
        if raw_val is None and "default" in meta:
            raw_val = meta["default"]

        if is_secret:
            display_val = _mask_secret(raw_val)
        else:
            display_val = raw_val

        item = {
            "key": key,
            "label": meta.get("label", key),
            "type": meta.get("type", "str"),
            "category": cat,
            "description": meta.get("description", ""),
            "secret": is_secret,
            "readonly": is_readonly,
            "value": display_val,
            "has_value": bool(raw_val),
            "options": meta.get("options", None),
        }

        if cat not in categories:
            categories[cat] = []
        categories[cat].append(item)

    return {
        "categories": categories,
        "count": len(SYSTEM_SETTINGS_METADATA),
    }


class SystemSettingsUpdateRequest(BaseModel):
    settings: Dict[str, Any]


@router.put("", response_model=Dict[str, Any])
async def update_system_settings(
    request_body: SystemSettingsUpdateRequest,
    req: Request,
    current_user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Batch update system settings (Superuser only)."""
    updates = request_body.settings
    settings_obj = get_settings()
    db = get_db()

    updated_keys = []

    async with db.get_session() as session:
        for key, new_val in updates.items():
            if key not in SYSTEM_SETTINGS_METADATA:
                continue

            meta = SYSTEM_SETTINGS_METADATA[key]

            # Ignore read-only settings
            if meta.get("readonly", False):
                continue

            # Ignore empty or masked secrets if unchanged
            if meta.get("secret", False) and (not new_val or new_val == "********"):
                continue

            # Convert boolean & numeric types to standard str for DB storage
            val_type = meta.get("type", "str")
            if val_type == "bool":
                if isinstance(new_val, str):
                    clean_str_val = "true" if new_val.lower() in ("true", "1", "yes", "on") else "false"
                else:
                    clean_str_val = "true" if bool(new_val) else "false"
            else:
                clean_str_val = str(new_val) if new_val is not None else ""

            # Check existing record in DB
            stmt = select(SystemSetting).where(SystemSetting.key == key)
            res = await session.execute(stmt)
            rec = res.scalar_one_or_none()

            if rec:
                rec.value = clean_str_val
                rec.updated_at = datetime.utcnow()
                rec.updated_by = current_user.id
            else:
                rec = SystemSetting(
                    key=key,
                    value=clean_str_val,
                    updated_at=datetime.utcnow(),
                    updated_by=current_user.id,
                )
                session.add(rec)

            # Update runtime singleton
            apply_setting_to_runtime(key, clean_str_val)
            updated_keys.append(key)

        await session.commit()

    if updated_keys:
        await write_audit_log(
            action="update_system_settings",
            actor=current_user,
            target_type="system",
            target_id="system_settings",
            request=req,
            metadata={"updated_keys": updated_keys},
        )

    return {
        "success": True,
        "updated_keys": updated_keys,
        "message": f"Successfully updated {len(updated_keys)} system settings.",
    }


@router.post("/purge-history", response_model=Dict[str, Any])
async def trigger_history_purge(
    days: int = None,
    current_user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Manually trigger truncation of historical position data older than specified or configured days."""
    from core.retention import purge_old_positions
    settings_obj = get_settings()
    target_days = days if days is not None else settings_obj.history_retention_days

    if target_days <= 0:
        raise HTTPException(status_code=400, detail="Retention days must be greater than 0")

    count = await purge_old_positions(target_days)
    return {
        "success": True,
        "deleted_records": count,
        "message": f"Successfully truncated {count} position records older than {target_days} days.",
    }


class SmtpTestRequest(BaseModel):
    recipient_email: Optional[str] = None
    config_override: Optional[Dict[str, Any]] = None


@router.post("/test-smtp", response_model=Dict[str, Any])
async def test_smtp_configuration(
    payload: Optional[SmtpTestRequest] = None,
    current_user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Test SMTP email configuration by sending a test message."""
    from core.email import send_email_async
    recipient = ((payload.recipient_email if payload else None) or "").strip() or current_user.email
    if not recipient or "@" not in recipient:
        raise HTTPException(status_code=400, detail="A valid recipient email address is required.")

    override = payload.config_override if payload else None

    subject = "Routario SMTP Test Email"
    body_text = (
        f"Hello {current_user.username},\n\n"
        f"This test email confirms that your outgoing SMTP server configuration in Routario is working properly.\n\n"
        f"Sent at: {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}\n"
    )
    body_html = f"""
    <div style="font-family:'Outfit','Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px 24px;background:#131825;color:#e5e7eb;border-radius:16px;border:1px solid #2a3447;">
        <h2 style="color:#ffffff;margin-top:0;font-size:22px;font-weight:700;">Routario SMTP Test</h2>
        <p style="color:#9ca3af;font-size:14px;line-height:1.5;">Hello <strong style="color:#ffffff;">{current_user.username}</strong>,</p>
        <p style="color:#9ca3af;font-size:14px;line-height:1.5;">This test email confirms that your outgoing SMTP server configuration in Routario is working properly!</p>
        <div style="background:#1a2035;padding:16px;border-radius:8px;border:1px solid #2a3447;margin:20px 0;font-size:13px;color:#cbd5e1;">
            <div><strong>Status:</strong> <span style="color:#22c55e;">Connected & Verified</span></div>
            <div style="margin-top:4px;"><strong>Sent at:</strong> {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}</div>
            <div style="margin-top:4px;"><strong>Recipient:</strong> {recipient}</div>
        </div>
        <p style="color:#6b7280;font-size:12px;margin-bottom:0;">Routario GPS Telematics Platform</p>
    </div>
    """

    ok = await send_email_async([recipient], subject, body_text, body_html, config_override=override)
    if not ok:
        raise HTTPException(
            status_code=400,
            detail="Failed to send test email. Please check your SMTP host, port, username, password, or encryption settings.",
        )

    return {
        "success": True,
        "message": f"Test email sent successfully to {recipient}!",
    }


class VoipTestRequest(BaseModel):
    target_extension: Optional[str] = None
    config_override: Optional[Dict[str, Any]] = None


@router.post("/test-voip", response_model=Dict[str, Any])
async def test_voip_configuration(
    payload: Optional[VoipTestRequest] = None,
    current_user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Test VoIP / SIP calling configuration by placing a test call with TTS message."""
    from core.voip import test_voip_call_async
    target = ((payload.target_extension if payload else None) or "").strip()
    if not target:
        target = getattr(current_user, "phone_number", None) or ""
        target = target.strip()
    if not target:
        raise HTTPException(
            status_code=400,
            detail="A target phone number or SIP extension is required for the test call.",
        )

    override = payload.config_override if payload else None
    msg = f"Hello {current_user.username}. This test voice call confirms that your outgoing VoIP SIP configuration in Routario is working properly."
    ok, error_msg = await test_voip_call_async(
        target_extension=target,
        message=msg,
        config_override=override,
    )
    if not ok:
        raise HTTPException(
            status_code=400,
            detail=f"VoIP test call failed: {error_msg}",
        )

    return {
        "success": True,
        "message": f"Test VoIP voice call completed successfully to '{target}'!",
    }
