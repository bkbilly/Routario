"""
Custom Rule Alert Module
Handles user-defined rule-engine expressions as a proper alert module.
Each alert row stores: name (display), rule (condition), channels, duration (optional).
"""
import re
from datetime import datetime
from typing import Optional

import rule_engine

from .base import BaseAlert, AlertDefinition, AlertField
from models.schemas import AlertType, Severity


class CustomRuleAlert(BaseAlert):

    # Class-level compiled rule cache so expressions aren't re-parsed every position
    _cache: dict = {}

    @classmethod
    def definition(cls) -> AlertDefinition:
        return AlertDefinition(
            key         = "__custom__",
            alert_type  = AlertType.CUSTOM,
            label       = "Custom Rule",
            description = "Fires when a user-defined rule expression evaluates to true.",
            icon        = "⚡",
            severity    = Severity.WARNING,
            hidden      = True,   # never shown in the "Add System Alert" dropdown
            state_keys  = [],     # state keys are dynamic per rule
            fields      = [
                AlertField(
                    key        = "name",
                    label      = "Rule Name",
                    field_type = "text",
                    default    = "",
                    required   = True,
                    help_text  = "Human-readable name shown in alerts.",
                ),
                AlertField(
                    key        = "rule",
                    label      = "Condition",
                    field_type = "text",
                    default    = "",
                    required   = True,
                    help_text  = "Rule expression, e.g. 'speed > 80 and ignition'.",
                ),
            ],
        )

    @staticmethod
    def _state_slug(rule_str: str) -> str:
        """Derive a compact, stable key fragment from the rule string."""
        return re.sub(r'[^a-zA-Z0-9]', '', rule_str)[:40]

    async def check(self, position, device, state, params: dict) -> Optional[dict]:
        rule_str  = params.get("rule",     "").strip()
        rule_name = params.get("name",     "Custom Alert").strip()
        rule_ch   = params.get("channels", [])
        duration  = params.get("duration")          # seconds (int) or None if disabled

        if not rule_str:
            return None

        slug      = self._state_slug(rule_str)
        fired_key = f"c_fired_{slug}"   # True once the alert has been dispatched
        since_key = f"c_since_{slug}"   # ISO timestamp of when the condition first became True

        # Build evaluation context from position fields
        ctx = {
            "speed":    position.speed or 0,
            "ignition": position.ignition,
            **(position.sensors or {}),
        }

        try:
            # Compile and cache the rule expression
            if rule_str not in CustomRuleAlert._cache:
                CustomRuleAlert._cache[rule_str] = rule_engine.Rule(rule_str)

            condition_met = CustomRuleAlert._cache[rule_str].matches(ctx)

        except Exception:
            # Silently ignore malformed rule expressions
            return None

        if not condition_met:
            # Reset all state so the alert can re-fire next time the condition is met
            state.alert_states[fired_key] = False
            state.alert_states[since_key] = None
            return None

        # ── Condition is currently True ──────────────────────────────────────

        # Already fired — don't repeat until condition resets
        if state.alert_states.get(fired_key):
            return None

        if duration:
            # Record when the condition first became True
            if not state.alert_states.get(since_key):
                state.alert_states[since_key] = position.device_time.isoformat()
                return None

            elapsed = (
                position.device_time.replace(tzinfo=None)
                - datetime.fromisoformat(state.alert_states[since_key]).replace(tzinfo=None)
            ).total_seconds()

            if elapsed < duration:
                return None   # Condition met but not sustained long enough yet

        # Fire the alert
        state.alert_states[fired_key] = True
        state.alert_states[since_key] = None  # Reset timer for future cycles

        message = f"{rule_name} (sustained for {duration}s)" if duration else rule_name

        return {
            "type":     AlertType.CUSTOM,
            "severity": Severity.WARNING,
            "message":  message,
            "alert_metadata": {
                "rule_name":         rule_name,
                "rule_condition":    rule_str,
                "selected_channels": rule_ch,
                "duration_seconds":  duration,
            },
        }
