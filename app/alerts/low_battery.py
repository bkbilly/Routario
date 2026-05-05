from typing import Optional

from .base import BaseAlert, AlertDefinition, AlertField
from models.schemas import AlertType, Severity


class LowBatteryAlert(BaseAlert):

    @classmethod
    def definition(cls) -> AlertDefinition:
        return AlertDefinition(
            key         = "low_battery",
            alert_type  = AlertType.LOW_BATTERY,
            label       = "Low Battery Alert",
            description = "Fires when the vehicle battery voltage drops below the configured threshold.",
            icon        = "🪫",
            severity    = Severity.WARNING,
            state_keys  = ["low_battery_alerted"],
            fields      = [
                AlertField(
                    key          = "battery_type",
                    label        = "Battery Type",
                    field_type   = "select",
                    default      = "lead_acid",
                    updates_field= "voltage_threshold",
                    options      = [
                        {"value": "lead_acid", "label": "Lead Acid",         "threshold": 12.2},
                        {"value": "agm",       "label": "AGM",               "threshold": 12.3},
                        {"value": "lithium",   "label": "Lithium (LiFePO4)", "threshold": 13.1},
                    ],
                    help_text    = "Selects a predefined voltage threshold — you can still adjust the value below.",
                ),
                AlertField(
                    key       = "voltage_threshold",
                    label     = "Voltage Threshold",
                    unit      = "V",
                    default   = 12.2,
                    min_value = 5.0,
                    max_value = 32.0,
                    help_text = "Alert fires when battery voltage drops below this value.",
                ),
                AlertField(
                    key        = "voltage_sensor",
                    label      = "Voltage Sensor",
                    field_type = "text",
                    default    = "external_voltage",
                    help_text  = "Sensor key to read from position data (e.g. external_voltage, battery_voltage).",
                ),
            ],
        )

    async def check(self, position, device, state, params: dict) -> Optional[dict]:
        threshold  = float(params.get("voltage_threshold", 11.8))
        sensor_key = params.get("voltage_sensor") or "external_voltage"

        voltage = (position.sensors or {}).get(sensor_key)

        if voltage is None:
            return None

        voltage = float(voltage)
        if voltage > 50:   # reported in mV — normalise to V
            voltage /= 1000.0

        if voltage >= threshold:
            state.alert_states["low_battery_alerted"] = False
            return None

        if state.alert_states.get("low_battery_alerted"):
            return None  # already fired for this low-battery episode

        state.alert_states["low_battery_alerted"] = True
        return {
            "type":           AlertType.LOW_BATTERY,
            "severity":       Severity.WARNING,
            "message":        f"Low Battery: {voltage:.2f}V (threshold {threshold:.1f}V)",
            "alert_metadata": {"config_key": "low_battery", "voltage": voltage, "threshold": threshold},
        }
