from typing import Optional
from .base import BaseAlert, AlertDefinition, AlertField
from models.schemas import AlertType, Severity


class DeviceEventAlert(BaseAlert):

    @classmethod
    def definition(cls) -> AlertDefinition:
        return AlertDefinition(
            key         = "device_event",
            alert_type  = AlertType.CUSTOM,
            label       = "Device Native Event",
            description = "Fires when the device reports a built-in hardware event.",
            icon        = "📡",
            severity    = Severity.WARNING,
            hidden      = True,   # injected dynamically per-protocol, not shown in generic dropdown
            state_keys  = [],     # state keys are dynamic per sensor+value
            fields      = [
                AlertField(
                    key        = "sensor_key",
                    label      = "Sensor Key",
                    field_type = "text",
                    default    = "",
                    required   = True,
                    help_text  = "The sensor dict key to watch (set automatically).",
                ),
                AlertField(
                    key        = "trigger_value",
                    label      = "Trigger Value",
                    field_type = "text",
                    default    = "",
                    required   = False,
                    help_text  = "Exact single value to match, or blank for any truthy value.",
                ),
                AlertField(
                    key        = "trigger_values",
                    label      = "Trigger Values",
                    field_type = "text",
                    default    = "",
                    required   = False,
                    help_text  = "List of values to match (set automatically for multi-value events).",
                ),
                AlertField(
                    key        = "event_label",
                    label      = "Event Label",
                    field_type = "text",
                    default    = "",
                    required   = False,
                    help_text  = "Human-readable name shown in alert messages.",
                ),
                AlertField(
                    key        = "severity",
                    label      = "Severity",
                    field_type = "select",
                    default    = "warning",
                    required   = False,
                    options    = [
                        {"value": "info",     "label": "Info"},
                        {"value": "warning",  "label": "Warning"},
                        {"value": "critical", "label": "Critical"},
                    ],
                ),
            ],
        )

    async def check(self, position, device, state, params: dict) -> Optional[dict]:
        sensor_key     = params.get("sensor_key", "")
        trigger_value  = params.get("trigger_value", "")
        trigger_values = params.get("trigger_values", [])
        event_label    = params.get("event_label") or sensor_key.replace("_", " ").title()
        severity_str   = params.get("severity", "warning")
        duration       = params.get("duration")  # seconds or None

        if not sensor_key:
            return None

        debounce_key = f"device_event_{sensor_key}_{trigger_value or ('multi' if trigger_values else 'any')}"
        since_key    = f"device_event_since_{sensor_key}_{trigger_value or ('multi' if trigger_values else 'any')}"

        sensors   = position.sensors or {}
        raw_value = sensors.get(sensor_key)

        if raw_value is None:
            state.alert_states[debounce_key] = False
            state.alert_states[since_key]    = None
            return None

        # Evaluate trigger condition
        if trigger_values:
            triggered = (
                raw_value in trigger_values or
                str(raw_value) in [str(v) for v in trigger_values]
            )
        elif trigger_value:
            triggered = (
                str(raw_value) == str(trigger_value) or
                (str(trigger_value).lstrip('-').isdigit() and not isinstance(raw_value, bool) and raw_value == int(trigger_value))
            )
        else:
            triggered = bool(raw_value)

        if not triggered:
            state.alert_states[debounce_key] = False
            state.alert_states[since_key]    = None
            return None

        if state.alert_states.get(debounce_key):
            return None

        if duration:
            since = state.alert_states.get(since_key)
            if not since:
                state.alert_states[since_key] = position.device_time.isoformat()
                return None

            from datetime import datetime
            elapsed = (
                position.device_time.replace(tzinfo=None)
                - datetime.fromisoformat(since).replace(tzinfo=None)
            ).total_seconds()

            if elapsed < duration:
                return None

        state.alert_states[debounce_key] = True
        state.alert_states[since_key]    = None

        severity_map = {
            "info":     Severity.INFO,
            "warning":  Severity.WARNING,
            "critical": Severity.CRITICAL,
        }
        severity = severity_map.get(severity_str, Severity.WARNING)

        message = f"{event_label}: reported by device (value={raw_value})."
        if duration:
            message = f"{event_label}: sustained for {duration}s (value={raw_value})."

        return {
            "type":     AlertType.CUSTOM,
            "severity": severity,
            "message":  message,
            "alert_metadata": {
                "config_key":   "device_event",
                "sensor_key":   sensor_key,
                "sensor_value": raw_value,
                "event_label":  event_label,
            },
        }
