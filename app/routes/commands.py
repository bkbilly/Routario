"""
Command Routes
Send and inspect commands for GPS devices.
"""
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Depends

from core.database import get_db
from core.auth import get_current_user, verify_device_access, require_permission
from models import User
from models.schemas import CommandCreate
from protocols import ProtocolRegistry

import json

from integrations.registry import IntegrationRegistry
from integrations.integration_model import IntegrationAccount
from integrations.engine import _get_auth
from sqlalchemy import select

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/devices", tags=["commands"])


@router.post("/{device_id}/command")
async def send_command(
    device_id: int,
    command: CommandCreate,
    caller: User = Depends(verify_device_access),
    _: User = Depends(require_permission("send_commands")),
):
    """Queue or send a command for a GPS device."""
    db = get_db()
    device = await db.get_device_by_id(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    if IntegrationRegistry.is_integration(device.protocol):
        provider_id = device.protocol
        provider = IntegrationRegistry.get(provider_id)
        intg = (device.config or {}).get("integration") or {}
        if not provider or not getattr(provider, "SUPPORTS_COMMANDS", False):
            raise HTTPException(
                status_code=400,
                detail=f"Integration provider '{provider_id}' does not support sending commands",
            )

        account_label = intg.get("account_label", "")
        remote_id = intg.get("remote_id") or device.imei

        async with db.get_session() as session:
            query = select(IntegrationAccount).where(
                IntegrationAccount.provider_id == provider_id,
                IntegrationAccount.is_active == True,
            )
            if not (caller.is_admin or caller.is_company_admin):
                query = query.where(IntegrationAccount.user_id == caller.id)
            if account_label:
                query = query.where(IntegrationAccount.account_label == account_label)
            result = await session.execute(query)
            account = result.scalar_one_or_none()

        if not account:
            raise HTTPException(status_code=404, detail="Integration account not found")

        credentials = account.get_decrypted_credentials()
        auth_ctx = await _get_auth(account.user_id, provider_id, account.account_label, credentials)
        if not auth_ctx:
            raise HTTPException(status_code=502, detail="Integration authentication failed")

        saved_cmd_id = None
        if command.command_type.startswith("saved:"):
            try:
                saved_cmd_id = int(command.command_type.split(":", 1)[1])
            except ValueError:
                pass

        try:
            res = await provider.send_command(
                auth_ctx=auth_ctx,
                remote_id=remote_id,
                command_type=command.command_type,
                payload=command.payload,
                saved_command_id=saved_cmd_id,
            )
        except Exception as e:
            logger.error(f"Integration send_command error for {device.name}: {e}")
            raise HTTPException(status_code=400, detail=f"Failed to send command to integration: {str(e)}")

        command.device_id = device_id
        db_cmd = await db.create_command(command)
        await db.mark_command_sent(db_cmd.id)

        resp_text = json.dumps(res) if isinstance(res, (dict, list)) else str(res)
        await db.mark_oldest_sent_command_acked(device_id, resp_text)

        result_dict = db_cmd.__dict__.copy() if hasattr(db_cmd, "__dict__") else dict(db_cmd)
        result_dict["status"] = "acked"
        result_dict["response"] = resp_text
        result_dict["encoded_preview"] = command.payload
        return result_dict

    decoder = ProtocolRegistry.get_decoder(device.protocol)
    if not decoder:
        raise HTTPException(status_code=400, detail="Protocol not found")

    try:
        test_bytes = await decoder.encode_command(
            command.command_type,
            {"payload": command.payload, "imei": device.imei or ""},
        )
        if not test_bytes or len(test_bytes) == 0:
            raise HTTPException(
                status_code=400,
                detail=f"Protocol {device.protocol} does not support '{command.command_type}' command",
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Command encoding failed: {str(e)}")

    command.device_id = device_id
    result = await db.create_command(command)

    cmd_desc = (
        f"{command.command_type} ({command.payload})"
        if command.payload and command.command_type != command.payload
        else (command.payload or command.command_type)
    )
    logger.info("Command queued for %s (ID %s): %s", device.name, device.id, cmd_desc)

    result_dict = result.__dict__.copy() if hasattr(result, "__dict__") else dict(result)
    result_dict["encoded_preview"] = test_bytes.hex()
    return result_dict


@router.post("/{device_id}/command/preview")
async def preview_command(
    device_id: int,
    command_data: dict,
    caller: User = Depends(verify_device_access),
    _: User = Depends(require_permission("send_commands")),
):
    """Preview encoding of a command before sending."""
    db = get_db()
    device = await db.get_device_by_id(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    if IntegrationRegistry.is_integration(device.protocol):
        provider_id = device.protocol
        provider = IntegrationRegistry.get(provider_id)
        intg = (device.config or {}).get("integration") or {}
        if not provider or not getattr(provider, "SUPPORTS_COMMANDS", False):
            raise HTTPException(status_code=400, detail=f"Integration provider '{provider_id}' does not support commands")

        command_type = command_data.get("command_type", "")
        payload = command_data.get("payload", "")

        dev_id = intg.get("remote_id") or device.imei
        dev_id_val = int(dev_id) if str(dev_id).isdigit() else dev_id
        preview_body: dict = {"deviceId": dev_id_val}
        if command_type.startswith("saved:"):
            try:
                preview_body["id"] = int(command_type.split(":", 1)[1])
            except ValueError:
                preview_body["type"] = command_type
        elif command_type == "custom":
            preview_body["type"] = "custom"
            preview_body["attributes"] = {"data": payload}
        else:
            preview_body["type"] = command_type
            if payload:
                preview_body["attributes"] = {"data": payload}

        ascii_repr = json.dumps(preview_body, indent=2)
        return {"hex": "", "bytes": len(ascii_repr), "ascii": ascii_repr, "success": True}

    decoder = ProtocolRegistry.get_decoder(device.protocol)
    if not decoder:
        raise HTTPException(status_code=400, detail="Protocol not found")

    command_type = command_data.get("command_type", "")
    payload = command_data.get("payload", "")

    try:
        encoded = await decoder.encode_command(
            command_type, {"payload": payload, "imei": device.imei or ""}
        )
        if not encoded or len(encoded) == 0:
            raise HTTPException(status_code=400, detail="Command could not be encoded")

        try:
            ascii_repr = encoded.decode("ascii", errors="replace")
        except Exception:
            ascii_repr = "Non-ASCII binary data"

        return {"hex": encoded.hex(), "bytes": len(encoded), "ascii": ascii_repr, "success": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Command encoding failed: {str(e)}")


@router.post("/protocol/{protocol}/command/preview")
async def preview_command_for_protocol(
    protocol: str,
    command_data: dict,
    caller: User = Depends(require_permission("send_commands")),
):
    """Preview encoding of a command for a given protocol (no device required)."""
    if IntegrationRegistry.is_integration(protocol):
        provider = IntegrationRegistry.get(protocol)
        if not provider or not getattr(provider, "SUPPORTS_COMMANDS", False):
            raise HTTPException(status_code=400, detail=f"Integration provider '{protocol}' does not support commands")

        command_type = command_data.get("command_type", "")
        payload = command_data.get("payload", "")

        preview_body: dict = {"deviceId": 0}
        if command_type.startswith("saved:"):
            try:
                preview_body["id"] = int(command_type.split(":", 1)[1])
            except ValueError:
                preview_body["type"] = command_type
        elif command_type == "custom":
            preview_body["type"] = "custom"
            preview_body["attributes"] = {"data": payload}
        else:
            preview_body["type"] = command_type
            if payload:
                preview_body["attributes"] = {"data": payload}

        ascii_repr = json.dumps(preview_body, indent=2)
        return {"hex": "", "bytes": len(ascii_repr), "ascii": ascii_repr, "success": True}

    decoder = ProtocolRegistry.get_decoder(protocol)
    if not decoder:
        raise HTTPException(status_code=400, detail="Protocol not found")

    command_type = command_data.get("command_type", "")
    payload = command_data.get("payload", "")

    try:
        encoded = await decoder.encode_command(
            command_type, {"payload": payload, "imei": "000000000000000"}
        )
        if not encoded or len(encoded) == 0:
            raise HTTPException(status_code=400, detail="Command could not be encoded")

        try:
            ascii_repr = encoded.decode("ascii", errors="replace")
        except Exception:
            ascii_repr = "Non-ASCII binary data"

        return {"hex": encoded.hex(), "bytes": len(encoded), "ascii": ascii_repr, "success": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Command encoding failed: {str(e)}")


@router.delete("/{device_id}/commands/{command_id}")
async def cancel_command(
    device_id: int,
    command_id: int,
    caller: User = Depends(verify_device_access),
    _: User = Depends(require_permission("send_commands")),
):
    """Cancel a pending command."""
    db = get_db()
    cancelled = await db.cancel_command(command_id, device_id)
    if not cancelled:
        raise HTTPException(status_code=404, detail="Command not found or already completed")
    return {"ok": True}


@router.delete("/{device_id}/commands/{command_id}/history")
async def delete_command_history(
    device_id: int,
    command_id: int,
    caller: User = Depends(verify_device_access),
    current_user: User = Depends(get_current_user),
):
    """Delete a command history entry (Super Admin only)."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Super admin privileges required to delete command history")

    db = get_db()
    deleted = await db.delete_command_history(command_id, device_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Command history entry not found")
    return {"ok": True}


@router.get("/{device_id}/commands")
async def get_device_commands(
    device_id: int,
    status: Optional[str] = Query(None),
    caller: User = Depends(verify_device_access),
    _: User = Depends(require_permission("send_commands")),
):
    """Get command history for a device."""
    db = get_db()
    device = await db.get_device_by_id(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    return await db.get_device_commands(device_id, status=status)
