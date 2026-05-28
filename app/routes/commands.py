"""
Command Routes
Send and inspect commands for GPS devices.
"""
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Depends

from core.database import get_db
from core.auth import get_current_user, verify_device_access, require_permission
from models import User
from models.schemas import CommandCreate
from protocols import ProtocolRegistry

router = APIRouter(prefix="/api/devices", tags=["commands"])


@router.post("/{device_id}/command")
async def send_command(
    device_id: int,
    command: CommandCreate,
    caller: User = Depends(verify_device_access),
    _: User = Depends(require_permission("send_commands")),
):
    """Queue a command to be sent to the device."""
    db = get_db()
    device = await db.get_device_by_id(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

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
    """Preview hex encoding of a command before sending."""
    db = get_db()
    device = await db.get_device_by_id(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

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
    """Preview hex encoding of a command for a given protocol (no device required)."""
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
        raise HTTPException(status_code=404, detail="Command not found or already sent")
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
