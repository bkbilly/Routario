"""
app/integrations/registry.py

Auto-discovering registry for integration providers.

Usage:
    from integrations.registry import IntegrationRegistry

    # Register a provider (done via decorator in each provider.py)
    @IntegrationRegistry.register("3dtracking")
    class ThreeDTrackingIntegration(BaseIntegration): ...

    # Look up a provider
    provider = IntegrationRegistry.get("3dtracking")

    # List all providers (for the UI dropdown)
    all_providers = IntegrationRegistry.all()
"""
from __future__ import annotations

import importlib
import logging
import os
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from integrations.base import BaseIntegration

logger = logging.getLogger(__name__)

# provider_id → class
_REGISTRY: dict[str, type["BaseIntegration"]] = {}

# provider_ids that are recognised as "integration" protocols
# (i.e. not native TCP/serial protocols like teltonika, gt06, …)
INTEGRATION_PROTOCOL_IDS: set[str] = set()


class IntegrationRegistry:

    @staticmethod
    def register(provider_id: str):
        """Class decorator — registers the provider under provider_id."""
        def decorator(cls):
            _REGISTRY[provider_id] = cls
            INTEGRATION_PROTOCOL_IDS.add(provider_id)
            logger.debug(f"Integration registered: {provider_id} → {cls.__name__}")
            return cls
        return decorator

    @staticmethod
    def get(provider_id: str) -> "BaseIntegration | None":
        """Return an instance of the provider, or None if not found."""
        cls = _REGISTRY.get(provider_id)
        return cls() if cls else None

    @staticmethod
    def all() -> list[dict]:
        """
        Return metadata for every registered provider.
        Used by the API to populate the frontend dropdown.
        """
        result = []
        for pid, cls in _REGISTRY.items():
            result.append({
                "provider_id":   pid,
                "display_name":  cls.DISPLAY_NAME,
                "poll_interval": cls.POLL_INTERVAL_SECONDS,
                "fields": [
                    {
                        "key":         f.key,
                        "label":       f.label,
                        "field_type":  f.field_type,
                        "required":    f.required,
                        "placeholder": f.placeholder,
                        "help_text":   f.help_text,
                        "default":     f.default,
                    }
                    for f in cls.FIELDS
                ],
            })
        return result

    @staticmethod
    def is_integration(protocol: str) -> bool:
        """True if the protocol string belongs to an external integration."""
        return protocol in INTEGRATION_PROTOCOL_IDS


def autodiscover():
    """
    Walk app/integrations/<provider_id>/provider.py and import each one.
    Called once at startup from app/integrations/__init__.py.
    """
    integrations_dir = os.path.dirname(__file__)
    for entry in sorted(os.listdir(integrations_dir)):
        provider_module = os.path.join(integrations_dir, entry, "provider.py")
        if os.path.isfile(provider_module):
            module_path = f"integrations.{entry}.provider"
            try:
                importlib.import_module(module_path)
                logger.info(f"Integration loaded: {entry}")
            except Exception as e:
                logger.error(f"Failed to load integration '{entry}': {e}", exc_info=True)
