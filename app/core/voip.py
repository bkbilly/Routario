"""
app/core/voip.py

Asynchronous VoIP SIP voice call dispatch utility for Routario platform.
Places automated VoIP voice calls for alert alarms and configuration tests.
"""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from typing import Optional, Tuple

from core.config import get_settings

logger = logging.getLogger(__name__)


def _send_voip_call_sync(
    target_extension: str,
    message: str,
    config_override: Optional[dict] = None,
) -> Tuple[bool, str]:
    """Synchronous VoIP call sender called inside asyncio executor thread."""
    from notifications.sip import SipChannel

    settings_obj = get_settings()

    enabled = (
        config_override.get("voip_enabled")
        if config_override and "voip_enabled" in config_override
        else getattr(settings_obj, "voip_enabled", False)
    )
    if isinstance(enabled, str):
        enabled = enabled.lower() in ("true", "1", "yes", "on")

    if not enabled:
        logger.debug("VoIP call dispatch skipped — voip_enabled is False.")
        return False, "VoIP calling is disabled in system settings."

    server = (
        config_override.get("voip_server")
        if config_override and "voip_server" in config_override
        else getattr(settings_obj, "voip_server", "")
    )
    username = (
        config_override.get("voip_username")
        if config_override and "voip_username" in config_override
        else getattr(settings_obj, "voip_username", "")
    )
    password = (
        config_override.get("voip_password")
        if config_override and "voip_password" in config_override
        else getattr(settings_obj, "voip_password", "")
    )
    port_val = (
        config_override.get("voip_port")
        if config_override and "voip_port" in config_override
        else getattr(settings_obj, "voip_port", 5060)
    )
    try:
        port = int(port_val)
    except (ValueError, TypeError):
        port = 5060

    from_ext = (
        config_override.get("voip_from_extension")
        if config_override and "voip_from_extension" in config_override
        else getattr(settings_obj, "voip_from_extension", "")
    ) or username

    tts_engine = (
        config_override.get("voip_tts_engine")
        if config_override and "voip_tts_engine" in config_override
        else getattr(settings_obj, "voip_tts_engine", "gtts")
    ) or "gtts"

    # gTTS Settings
    gtts_language = (
        config_override.get("voip_gtts_language")
        if config_override and "voip_gtts_language" in config_override
        else getattr(settings_obj, "voip_gtts_language", "en")
    ) or "en"

    # eSpeak Settings
    espeak_voice = (
        config_override.get("voip_espeak_voice")
        if config_override and "voip_espeak_voice" in config_override
        else getattr(settings_obj, "voip_espeak_voice", "en")
    ) or "en"
    espeak_speed = (
        config_override.get("voip_espeak_speed")
        if config_override and "voip_espeak_speed" in config_override
        else getattr(settings_obj, "voip_espeak_speed", 150)
    ) or 150
    espeak_pitch = (
        config_override.get("voip_espeak_pitch")
        if config_override and "voip_espeak_pitch" in config_override
        else getattr(settings_obj, "voip_espeak_pitch", 50)
    ) or 50

    # Gemini Audio Settings
    gemini_api_key = (
        config_override.get("voip_gemini_api_key")
        if config_override and "voip_gemini_api_key" in config_override
        else getattr(settings_obj, "voip_gemini_api_key", "")
    ) or getattr(settings_obj, "llm_gemini_api_key", "") or ""

    gemini_model = (
        config_override.get("voip_gemini_model")
        if config_override and "voip_gemini_model" in config_override
        else getattr(settings_obj, "voip_gemini_model", "gemini-2.5-flash-preview-tts")
    ) or "gemini-2.5-flash-preview-tts"

    gemini_voice = (
        config_override.get("voip_gemini_voice")
        if config_override and "voip_gemini_voice" in config_override
        else getattr(settings_obj, "voip_gemini_voice", "Aoede")
    ) or "Aoede"

    gemini_language = (
        config_override.get("voip_gemini_language")
        if config_override and "voip_gemini_language" in config_override
        else getattr(settings_obj, "voip_gemini_language", "en")
    ) or "en"

    repeat_val = (
        config_override.get("voip_repeat")
        if config_override and "voip_repeat" in config_override
        else getattr(settings_obj, "voip_repeat", 2)
    )
    try:
        repeat = max(1, int(repeat_val))
    except (ValueError, TypeError):
        repeat = 2

    pause_val = (
        config_override.get("voip_pause_seconds")
        if config_override and "voip_pause_seconds" in config_override
        else getattr(settings_obj, "voip_pause_seconds", 2)
    )
    try:
        pause = max(0, int(pause_val))
    except (ValueError, TypeError):
        pause = 2

    if not server or not username:
        err = "VoIP dispatch failed — SIP server host and SIP username are required."
        logger.warning(err)
        return False, err

    clean_target = (target_extension or "").strip()
    if not clean_target:
        err = "VoIP dispatch skipped — no target phone number or SIP extension provided."
        logger.warning(err)
        return False, err

    tts_params = {
        "tts": tts_engine,
        "voip_gtts_language": gtts_language,
        "voip_espeak_voice": espeak_voice,
        "voip_espeak_speed": espeak_speed,
        "voip_espeak_pitch": espeak_pitch,
        "voip_gemini_api_key": gemini_api_key,
        "voip_gemini_model": gemini_model,
        "voip_gemini_voice": gemini_voice,
        "voip_gemini_language": gemini_language,
    }

    call_params = {
        "server": server,
        "port": port,
        "username": username,
        "password": password,
        "extension": clean_target,
        "from_extension": from_ext,
        "repeat": repeat,
        "pause": pause,
        "tts": tts_engine,
        **tts_params,
    }

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        audio_path = f.name

    try:
        tts_ok = SipChannel._generate_tts(
            text=message,
            engine=tts_engine,
            params=tts_params,
            output_path=audio_path,
        )
        if not tts_ok:
            err = f"Text-to-speech generation failed using engine '{tts_engine}'."
            logger.error(f"VoIP: {err}")
            return False, err

        logger.info(
            f"VoIP: Placing voice call to '{clean_target}' via {username}@{server}:{port} "
            f"(repeat={repeat}, pause={pause}s, engine={tts_engine})"
        )
        call_ok = SipChannel._call(call_params, audio_path)
        if call_ok:
            logger.info(f"VoIP voice call to '{clean_target}' completed successfully.")
            return True, f"Call to '{clean_target}' completed successfully."
        else:
            err = f"Call to '{clean_target}' was not answered, rejected, or timed out."
            logger.warning(f"VoIP: {err}")
            return False, err
    except Exception as exc:
        err = f"VoIP voice call failed: {exc}"
        logger.error(err, exc_info=True)
        return False, err
    finally:
        try:
            if os.path.exists(audio_path):
                os.unlink(audio_path)
        except OSError:
            pass


async def send_voip_call_async(
    target_extension: str,
    message: str,
    config_override: Optional[dict] = None,
) -> bool:
    """Asynchronously place a VoIP voice call alarm using background thread execution."""
    ok, _ = await asyncio.to_thread(_send_voip_call_sync, target_extension, message, config_override)
    return ok


async def test_voip_call_async(
    target_extension: str,
    message: str,
    config_override: Optional[dict] = None,
) -> Tuple[bool, str]:
    """Asynchronously test a VoIP configuration and return (success, message)."""
    return await asyncio.to_thread(_send_voip_call_sync, target_extension, message, config_override)
