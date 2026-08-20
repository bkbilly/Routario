"""
app/core/email.py

Asynchronous SMTP email dispatch utility for Routario platform.
Sends system emails for ticket owner changes, system alerts, etc.
"""
from __future__ import annotations

import asyncio
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
import logging
import smtplib
from typing import List, Optional

from core.config import get_settings

logger = logging.getLogger(__name__)


def _send_email_sync(
    to_addresses: List[str],
    subject: str,
    body_text: str,
    body_html: Optional[str] = None,
    config_override: Optional[dict] = None,
) -> bool:
    """Synchronous SMTP email sender called inside asyncio executor thread."""
    settings_obj = get_settings()

    enabled = (
        config_override.get("smtp_enabled")
        if config_override and "smtp_enabled" in config_override
        else getattr(settings_obj, "smtp_enabled", False)
    )
    if isinstance(enabled, str):
        enabled = enabled.lower() in ("true", "1", "yes", "on")

    if not enabled:
        logger.debug("SMTP email dispatch skipped — smtp_enabled is False.")
        return False

    host = (config_override.get("smtp_host") if config_override else None) or getattr(settings_obj, "smtp_host", "")
    port_val = (config_override.get("smtp_port") if config_override else None) or getattr(settings_obj, "smtp_port", 587)
    try:
        port = int(port_val)
    except (ValueError, TypeError):
        port = 587

    username = (config_override.get("smtp_username") if config_override else None) or getattr(settings_obj, "smtp_username", "")
    password = (config_override.get("smtp_password") if config_override else None) or getattr(settings_obj, "smtp_password", "")
    use_tls_val = (config_override.get("smtp_use_tls") if config_override else None) or getattr(settings_obj, "smtp_use_tls", True)
    if isinstance(use_tls_val, str):
        use_tls = use_tls_val.lower() in ("true", "1", "yes", "on")
    else:
        use_tls = bool(use_tls_val)

    from_email = (config_override.get("smtp_from_email") if config_override else None) or getattr(settings_obj, "smtp_from_email", "") or username
    from_name = (config_override.get("smtp_from_name") if config_override else None) or getattr(settings_obj, "smtp_from_name", "Routario Telematics")

    if not host or not from_email:
        logger.warning("SMTP email dispatch failed — smtp_host or smtp_from_email missing.")
        return False

    clean_to = [addr.strip() for addr in to_addresses if addr and addr.strip()]
    if not clean_to:
        logger.debug("SMTP email dispatch skipped — no recipient email addresses provided.")
        return False

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"{from_name} <{from_email}>" if from_name else from_email
    msg["To"] = ", ".join(clean_to)

    msg.attach(MIMEText(body_text, "plain", "utf-8"))
    if body_html:
        msg.attach(MIMEText(body_html, "html", "utf-8"))

    try:
        if port == 465:
            with smtplib.SMTP_SSL(host, port, timeout=15) as server:
                if username and password:
                    server.login(username, password)
                server.sendmail(from_email, clean_to, msg.as_string())
        else:
            with smtplib.SMTP(host, port, timeout=15) as server:
                if use_tls:
                    server.starttls()
                if username and password:
                    server.login(username, password)
                server.sendmail(from_email, clean_to, msg.as_string())

        logger.info(f"System email sent successfully to {clean_to}: '{subject}'")
        return True
    except Exception as err:
        logger.error(f"Failed to send system email to {clean_to}: {err}")
        return False


async def send_email_async(
    to_addresses: List[str],
    subject: str,
    body_text: str,
    body_html: Optional[str] = None,
    config_override: Optional[dict] = None,
) -> bool:
    """Asynchronously send a system email using background thread execution."""
    return await asyncio.to_thread(_send_email_sync, to_addresses, subject, body_text, body_html, config_override)
