"""
Beacon / Driver ID Alert Module

Identifies the driver via BLE beacon proximity. When the ignition is on and
no authorised beacon has been seen within `beacon_interval_seconds` × `miss_grace`
consecutive position updates, an UNAUTHORIZED_DRIVER alert fires.

State keys:
  beacon_last_seen   – ISO timestamp of the most-recent matching beacon frame
  beacon_alert_fired – True once the alert has been dispatched; reset on ignition-off
                       or when a beacon is seen again
"""
from datetime import datetime
from typing import Optional

from .base import BaseAlert, AlertDefinition, AlertField
from models.schemas import AlertType, Severity


class BeaconAlert(BaseAlert):

    @classmethod
    def definition(cls) -> AlertDefinition:
        return AlertDefinition(
            key         = "beacon_driver_id",
            alert_type  = AlertType.UNAUTHORIZED_DRIVER,
            label       = "Driver ID (Beacon)",
            description = (
                "Fires when the ignition is on but no authorised BLE beacon "
                "has been detected within the expected interval."
            ),
            icon        = "🪪",
            severity    = Severity.WARNING,
            state_keys  = ["beacon_last_seen", "beacon_alert_fired"],
            fields      = [
                AlertField(
                    key        = "beacon_id",
                    label      = "Authorised Beacon ID",
                    field_type = "text",
                    default    = "",
                    required   = False,
                    help_text  = (
                        "Full beacon ID to accept as a valid driver, e.g. "
                        "'uuid:major:minor' or 'namespace:instance'. "
                        "Leave blank to accept any beacon."
                    ),
                ),
                AlertField(
                    key        = "timeout_seconds",
                    label      = "Absence Timeout",
                    field_type = "number",
                    unit       = "seconds",
                    default    = 30,
                    min_value  = 1,
                    max_value  = 3600,
                    required   = True,
                    help_text  = "Fire an alert if no authorised beacon is seen for this many seconds while the ignition is on.",
                ),
                AlertField(
                    key        = "min_rssi",
                    label      = "Minimum RSSI",
                    field_type = "number",
                    unit       = "dBm",
                    default    = -90,
                    min_value  = -120,
                    max_value  = 0,
                    required   = False,
                    help_text  = "Ignore beacons weaker than this signal strength.",
                ),
            ],
        )

    async def check(self, position, device, state, params: dict) -> Optional[dict]:
        # ── 1. Only care when ignition is on ─────────────────────────────────
        if not position.ignition:
            # Reset cleanly so the alert can re-fire next ignition cycle
            state.alert_states["beacon_last_seen"]   = None
            state.alert_states["beacon_alert_fired"] = False
            return None

        beacon_id       = params.get("beacon_id", "").strip()
        timeout_seconds = int(params.get("timeout_seconds", 30))
        min_rssi        = params.get("min_rssi", -90)

        # ── 2. Check for a matching beacon in this position update ───────────
        beacons: list = position.sensors.get("beacon_ids") or []

        # Filter by ID
        if beacon_id:
            candidates = [b for b in beacons if b.get("id") == beacon_id]
        else:
            candidates = list(beacons)

        # Filter by RSSI (only apply when the beacon actually carries RSSI)
        if min_rssi is not None:
            candidates = [
                b for b in candidates
                if "rssi" not in b or b["rssi"] >= min_rssi
            ]

        beacon_visible = len(candidates) > 0

        # ── 3. Update last-seen timestamp ────────────────────────────────────
        now_iso = position.device_time.isoformat()

        if beacon_visible:
            state.alert_states["beacon_last_seen"]   = now_iso
            state.alert_states["beacon_alert_fired"] = False  # beacon returned → reset
            return None

        # ── 4. Beacon not in this frame — check how long it's been gone ──────
        last_seen_iso = state.alert_states.get("beacon_last_seen")

        if not last_seen_iso:
            # First position since ignition on and beacon never seen yet.
            # Start the absence clock from now.
            state.alert_states["beacon_last_seen"] = now_iso
            return None

        elapsed = (
            position.device_time.replace(tzinfo=None)
            - datetime.fromisoformat(last_seen_iso).replace(tzinfo=None)
        ).total_seconds()

        if elapsed < timeout_seconds:
            return None  # Still within grace window

        # ── 5. Grace window exceeded — fire once ─────────────────────────────
        if state.alert_states.get("beacon_alert_fired"):
            return None  # Already fired; don't spam

        state.alert_states["beacon_alert_fired"] = True

        label = f"beacon '{beacon_id}'" if beacon_id else "any authorised beacon"
        message = (
            f"Unauthorized driver: {label} not detected for "
            f"over {timeout_seconds}s with ignition on."
        )

        return {
            "type":     AlertType.UNAUTHORIZED_DRIVER,
            "severity": Severity.WARNING,
            "message":  message,
            "alert_metadata": {
                "config_key":              "beacon_driver_id",
                "expected_beacon_id":      beacon_id or "(any)",
                "seconds_since_last_seen": int(elapsed),
                "timeout_seconds":         timeout_seconds,
            },
        }
