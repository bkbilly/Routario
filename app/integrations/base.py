"""
app/integrations/base.py

Base class for all external integration providers.

Every provider must:
  1. Set PROVIDER_ID, DISPLAY_NAME, POLL_INTERVAL_SECONDS, FIELDS
  2. Implement authenticate() → returns an auth context dict
  3. Implement fetch_positions() → yields NormalizedPosition objects

The integration engine calls these methods automatically.
Authentication is cached per (user_id, provider) and refreshed
when token_expires_at is in the past.
"""
from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, AsyncIterator

from models.schemas import NormalizedPosition

logger = logging.getLogger(__name__)


# ── Exceptions ────────────────────────────────────────────────────────────────

class AuthExpiredError(Exception):
    """
    Raised by fetch_positions() when the provider rejects the current session
    mid-cycle (e.g. the remote server expired the session token earlier than
    expected, or a forced logout occurred).

    The integration engine catches this, evicts the cached AuthContext, and
    re-authenticates on the next poll cycle.
    """


# ── Field definition (drives the UI form) ────────────────────────────────────

@dataclass
class IntegrationField:
    """Describes one credential/config field shown in the Add Device form."""
    key:         str
    label:       str
    field_type:  str  = "text"      # "text" | "password" | "url" | "number"
    required:    bool = True
    placeholder: str  = ""
    help_text:   str  = ""
    default:     Any  = None


# ── Auth context returned by authenticate() ───────────────────────────────────

@dataclass
class AuthContext:
    """
    Opaque token bag returned by authenticate().
    Stored in memory; never written to DB (credentials are in IntegrationAccount).
    token_expires_at=None means the token never expires (e.g. API-key based auth).
    """
    data:             dict            # provider-specific — passed back into fetch_positions()
    token_expires_at: datetime | None = None


# ── Remote device descriptor ──────────────────────────────────────────────────

@dataclass
class RemoteDevice:
    """
    Lightweight descriptor of a device as seen on the remote platform.
    Used when auto-importing devices from a provider account.
    """
    remote_id:    str
    name:         str
    imei:         str | None         = None
    vehicle_type: str | None         = None
    license_plate: str | None        = None
    extra:        dict                = field(default_factory=dict)


# ── Base class ────────────────────────────────────────────────────────────────

class BaseIntegration(ABC):
    """
    Abstract base for all integration providers.

    Subclasses are auto-discovered by IntegrationRegistry when they live
    inside   app/integrations/<provider_id>/provider.py
    and are decorated with  @IntegrationRegistry.register("<provider_id>")

    Adaptive polling rates
    ----------------------
    POLL_INTERVAL_SECONDS        — interval (seconds) when ignition is OFF or unknown.
    POLL_INTERVAL_ACTIVE_SECONDS — interval (seconds) when ignition is ON.

    The integration engine tracks the last-known ignition state per device and
    uses the active interval for any device that was last seen with ignition on,
    falling back to the idle interval for everything else.  This keeps API
    traffic low while the fleet is parked overnight and maximises position
    freshness during active trips.
    """

    # ── Required class-level attributes ──────────────────────────────────────
    PROVIDER_ID:                  str  = ""    # e.g. "3dtracking"
    DISPLAY_NAME:                 str  = ""    # e.g. "3D Tracking"
    POLL_INTERVAL_SECONDS:        int  = 120   # idle / unknown interval (seconds)
    POLL_INTERVAL_ACTIVE_SECONDS: int  = 30    # active (ignition ON) interval (seconds)
    FIELDS: list[IntegrationField] = []        # credential fields for the UI

    # ── Auth ──────────────────────────────────────────────────────────────────

    @abstractmethod
    async def authenticate(self, credentials: dict) -> AuthContext:
        """
        Exchange stored credentials for a live auth context.
        Called once per account, then again when token expires.

        credentials: the dict stored in IntegrationAccount.credentials
                     (decrypted by the engine before calling this method)

        Must raise an exception on failure — the engine will log it and
        skip all devices linked to this account until the next cycle.
        """

    # ── Data fetch ────────────────────────────────────────────────────────────

    @abstractmethod
    async def fetch_positions(
        self,
        auth_ctx: AuthContext,
        devices: list[dict],          # [{"remote_id": ..., "imei": ...}, ...]
    ) -> AsyncIterator[NormalizedPosition]:
        """
        Fetch the latest position for every device in the list.
        Yield one NormalizedPosition per device that has fresh data.

        devices: list of dicts with at least "remote_id" and "imei" keys,
                 built from the Device.config["integration"] sub-dict.

        Raise AuthExpiredError if the remote API rejects the session mid-cycle.
        The engine will evict the cached AuthContext and re-authenticate on the
        next poll cycle.
        """

    # ── Optional: list remote devices ────────────────────────────────────────

    async def list_remote_devices(self, auth_ctx: AuthContext) -> list[RemoteDevice]:
        """
        Return all devices visible on the remote account.
        Used by the "Import devices" UI feature (optional — return [] if not supported).
        """
        return []

    # ── Optional: verify credentials without a full auth round-trip ──────────

    async def test_credentials(self, credentials: dict) -> tuple[bool, str]:
        """
        Quick credential check called when the user clicks "Test connection".
        Returns (ok: bool, message: str).
        Default implementation just calls authenticate() and returns success/failure.
        """
        try:
            await self.authenticate(credentials)
            return True, "Connection successful"
        except Exception as e:
            return False, str(e)
