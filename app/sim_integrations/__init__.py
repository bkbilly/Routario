"""
SIM Providers package for Routario.
"""
from sim_integrations.registry import SimProviderRegistry
from sim_integrations.base import BaseSimIntegration, SimProviderField, RemoteSimCard

# Automatically discover and register all providers in this package
SimProviderRegistry.autodiscover()

__all__ = [
    "SimProviderRegistry",
    "BaseSimIntegration",
    "SimProviderField",
    "RemoteSimCard",
]
