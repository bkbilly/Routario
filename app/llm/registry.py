"""
app/llm/registry.py

Auto-discovering registry for LLM providers.
"""
from __future__ import annotations

import importlib
import logging
import os
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from llm.base import BaseLLMProvider

logger = logging.getLogger(__name__)

# provider_id -> class
_LLM_REGISTRY: dict[str, type[BaseLLMProvider]] = {}


class LLMRegistry:

    @staticmethod
    def register(provider_id: str):
        """Class decorator — registers the LLM provider under provider_id."""
        def decorator(cls):
            _LLM_REGISTRY[provider_id] = cls
            logger.info(f"LLM Provider registered: {provider_id} -> {cls.__name__}")
            return cls
        return decorator

    @staticmethod
    def get(provider_id: str) -> Optional[BaseLLMProvider]:
        """Return an instance of the LLM provider, or None if not found."""
        cls = _LLM_REGISTRY.get(provider_id)
        return cls() if cls else None

    @staticmethod
    def all() -> list[dict]:
        """Return metadata for every registered provider (used by UI)."""
        result = []
        for pid, cls in _LLM_REGISTRY.items():
            result.append({
                "provider_id": pid,
                "display_name": cls.DISPLAY_NAME,
                "fields": [
                    {
                        "key": f.key,
                        "label": f.label,
                        "field_type": f.field_type,
                        "required": f.required,
                        "placeholder": f.placeholder,
                        "help_text": f.help_text,
                        "default": f.default,
                        "options": f.options,
                    }
                    for f in cls.FIELDS
                ],
            })
        return result


def autodiscover():
    """Import every *.py file in app/llm/providers/."""
    providers_dir = os.path.join(os.path.dirname(__file__), "providers")
    if not os.path.exists(providers_dir):
        return

    for fname in os.listdir(providers_dir):
        if fname.endswith(".py") and not fname.startswith("_"):
            modname = fname[:-3]
            try:
                importlib.import_module(f"llm.providers.{modname}")
            except Exception as e:
                logger.error(f"Failed to auto-discover LLM provider module '{modname}': {e}")
