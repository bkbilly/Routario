"""
No-Driver / Unexpected-Driver Alert

Fires when a vehicle is moving but either:
  • no driver is assigned at all, or
  • the assigned driver is not the expected one (if a name is configured).

State keys:
  no_driver_alert_fired  – True once fired for the current moving period;
                           reset when the vehicle stops or the correct driver appears.
"""
from typing import Optional

from .base import BaseAlert, AlertDefinition, AlertField
from models.schemas import AlertType, Severity


class NoDriverAlert(BaseAlert):

    @classmethod
    def definition(cls) -> AlertDefinition:
        return AlertDefinition(
            key         = "no_driver",
            alert_type  = AlertType.UNAUTHORIZED_DRIVER,
            label       = "No / Unexpected Driver",
            description = (
                "Fires when the vehicle is moving without a driver assigned, "
                "or when the assigned driver is not the expected one."
            ),
            icon        = "🧑‍✈️",
            severity    = Severity.WARNING,
            state_keys  = ["no_driver_alert_fired"],
            fields      = [
                AlertField(
                    key        = "min_speed",
                    label      = "Minimum speed",
                    field_type = "number",
                    unit       = "km/h",
                    default    = 5,
                    min_value  = 0,
                    max_value  = 200,
                    help_text  = "Alert only when speed exceeds this value.",
                ),
                AlertField(
                    key        = "expected_driver",
                    label      = "Expected driver",
                    field_type = "driver_select",
                    default    = "",
                    required   = False,
                    help_text  = (
                        "Select '— Any driver —' to alert whenever no driver is assigned. "
                        "Select a specific driver to alert when someone other than "
                        "that driver is operating the vehicle."
                    ),
                ),
            ],
        )

    async def check(self, position, device, state, params: dict) -> Optional[dict]:
        min_speed          = float(params.get("min_speed", 5))
        expected_driver_raw = params.get("expected_driver") or ""
        expected_driver_id  = int(expected_driver_raw) if str(expected_driver_raw).strip().isdigit() else None

        speed = position.speed or 0

        # Not moving — reset and stay silent
        if speed < min_speed:
            state.alert_states["no_driver_alert_fired"] = False
            return None

        # Vehicle is moving — evaluate driver status
        current_driver_id   = state.current_driver_id
        current_driver_name = (
            state.current_driver.name
            if getattr(state, "current_driver", None)
            else None
        )

        if expected_driver_id:
            driver_ok = current_driver_id == expected_driver_id
            problem = (
                f"Expected driver not present — "
                + (f"'{current_driver_name}' is assigned" if current_driver_name
                   else "no driver is assigned")
            )
        else:
            driver_ok = current_driver_id is not None
            problem   = "Vehicle is moving with no driver assigned"

        if driver_ok:
            state.alert_states["no_driver_alert_fired"] = False
            return None

        # Fire once per moving period
        if state.alert_states.get("no_driver_alert_fired"):
            return None

        state.alert_states["no_driver_alert_fired"] = True

        return {
            "type":     AlertType.UNAUTHORIZED_DRIVER,
            "severity": Severity.WARNING,
            "message":  f"{problem} (speed {speed:.0f} km/h).",
            "alert_metadata": {
                "config_key":        "no_driver",
                "expected_driver_id": expected_driver_id,
                "current_driver":     current_driver_name,
                "speed":              speed,
            },
        }
