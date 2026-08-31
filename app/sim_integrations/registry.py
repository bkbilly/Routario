"""
Auto-discovering registry for SIM provider integrations.
"""
from __future__ import annotations

import importlib
import logging
import pkgutil
from pathlib import Path
from typing import Dict, List, Optional, Type

from sim_integrations.base import BaseSimIntegration

logger = logging.getLogger(__name__)

_REGISTRY: Dict[str, Type[BaseSimIntegration]] = {}


class SimProviderRegistry:
    @staticmethod
    def register(provider_id: str):
        """Class decorator to register a SIM provider class."""
        def decorator(cls: Type[BaseSimIntegration]):
            _REGISTRY[provider_id] = cls
            logger.debug(f"SIM provider registered: {provider_id} -> {cls.__name__}")
            return cls
        return decorator

    @staticmethod
    def get(provider_id: str) -> Optional[BaseSimIntegration]:
        """Return an instantiated provider instance or None."""
        cls = _REGISTRY.get(provider_id)
        return cls() if cls else None

    @staticmethod
    def all() -> List[dict]:
        """Return metadata for all registered providers."""
        result = []
        for pid, cls in _REGISTRY.items():
            fields_data = [
                {
                    "key": f.key,
                    "label": f.label,
                    "field_type": f.field_type,
                    "required": f.required,
                    "placeholder": f.placeholder,
                    "help_text": f.help_text,
                    "default": f.default,
                }
                for f in cls.FIELDS
            ]
            result.append({
                "provider_id": pid,
                "display_name": cls.DISPLAY_NAME,
                "fields": fields_data,
            })
        return result

    @classmethod
    def autodiscover(cls):
        """Autodiscover all provider modules in this package."""
        pkg_dir = str(Path(__file__).parent)
        for _, module_name, _ in pkgutil.iter_modules([pkg_dir]):
            if module_name in ("base", "registry", "__init__", "models", "utils", "exceptions"):
                continue
            try:
                importlib.import_module(f"sim_integrations.{module_name}")
            except Exception as e:
                logger.error(f"Failed to load SIM provider module '{module_name}': {e}")
