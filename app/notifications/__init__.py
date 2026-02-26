"""
Notifications Package
Automatically discovers and registers all notification channel modules.

Channel modules are tried in registration order (alphabetical file name).
The first channel whose matches() returns True handles the URL.
The apprise channel is intentionally named to sort last so custom schemes
take priority over Apprise's broad catch-all.
"""

import importlib
import inspect
import logging
import pkgutil
from pathlib import Path

from .base import BaseNotificationChannel

logger = logging.getLogger(__name__)

# Ordered list of registered channel classes.
# Channels are tried in this order; first match wins.
CHANNEL_REGISTRY: list[type[BaseNotificationChannel]] = []

for _, module_name, _ in pkgutil.iter_modules([str(Path(__file__).parent)]):
    if module_name == "base":
        continue
    try:
        module = importlib.import_module(f".{module_name}", package=__name__)
        for _name, obj in inspect.getmembers(module, inspect.isclass):
            if issubclass(obj, BaseNotificationChannel) and obj is not BaseNotificationChannel:
                CHANNEL_REGISTRY.append(obj)
                logger.debug(f"Registered notification channel: {obj.__name__}")
    except Exception as e:
        logger.error(f"Failed to load notification module '{module_name}': {e}")

if not CHANNEL_REGISTRY:
    logger.error("No notification channels registered — check the notifications/ package.")


def get_channel(url: str) -> BaseNotificationChannel | None:
    """Return the first registered channel that matches the URL, or None."""
    for channel_cls in CHANNEL_REGISTRY:
        if channel_cls.matches(url):
            return channel_cls()
    return None
