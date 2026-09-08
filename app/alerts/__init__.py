"""
Alert Module Registry
Automatically discovers and registers all alert modules in this package.

To add a new alert type:
  1. Create a new .py file in this folder.
  2. Define a class that subclasses BaseAlert.
  3. That's it — it will be picked up automatically on next startup.
"""
import importlib
import pkgutil
import inspect
import logging
from pathlib import Path

from .base import BaseAlert, AlertDefinition, AlertField

logger = logging.getLogger(__name__)

# key → alert class
ALERT_REGISTRY: dict[str, type[BaseAlert]] = {}

# key → AlertDefinition (full, including hidden ones — used by the engine)
ALERT_DEFINITIONS: dict[str, AlertDefinition] = {}

# key → AlertDefinition (only non-hidden — used by /api/alerts/types endpoint)
ALERT_DEFINITIONS_PUBLIC: dict[str, AlertDefinition] = {}

for _, module_name, _ in pkgutil.iter_modules([str(Path(__file__).parent)]):
    if module_name == "base":
        continue
    try:
        module = importlib.import_module(f".{module_name}", package=__name__)
        for _name, obj in inspect.getmembers(module, inspect.isclass):
            if issubclass(obj, BaseAlert) and obj is not BaseAlert:
                defn = obj.definition()
                ALERT_REGISTRY[defn.key]     = obj
                ALERT_DEFINITIONS[defn.key]  = defn
                if not defn.hidden:
                    ALERT_DEFINITIONS_PUBLIC[defn.key] = defn
                logger.debug(f"Registered alert: {defn.key} ({obj.__name__})")
    except Exception as e:
        logger.error(f"Failed to load alert module '{module_name}': {e}")


def register_alert_class(alert_cls: type[BaseAlert]) -> str:
    """Register an alert class dynamically (used by plugins)."""
    defn = alert_cls.definition()
    ALERT_REGISTRY[defn.key] = alert_cls
    ALERT_DEFINITIONS[defn.key] = defn
    if not defn.hidden:
        ALERT_DEFINITIONS_PUBLIC[defn.key] = defn
    logger.info(f"Dynamically registered alert: {defn.key} ({alert_cls.__name__})")
    return defn.key


def unregister_alert_class(key: str) -> None:
    """Unregister an alert class dynamically by key (used by plugins)."""
    ALERT_REGISTRY.pop(key, None)
    ALERT_DEFINITIONS.pop(key, None)
    ALERT_DEFINITIONS_PUBLIC.pop(key, None)
    logger.info(f"Unregistered alert: {key}")

