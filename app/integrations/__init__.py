"""
app/integrations/__init__.py
Auto-discovers all provider subfolders on import.
"""
from integrations.registry import IntegrationRegistry, autodiscover

autodiscover()

__all__ = ["IntegrationRegistry"]
