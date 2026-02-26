"""
Apprise Notification Channel
Catch-all for any URL supported by the Apprise library
(Telegram, Discord, Slack, Email, etc.).

This module is intentionally named with a 'z_' prefix so it sorts last
in the registry and only handles URLs that no other channel claimed first.
See: https://github.com/caronc/apprise/wiki
"""

import logging

from apprise import Apprise

from .base import BaseNotificationChannel

logger = logging.getLogger(__name__)


class AppriseChannel(BaseNotificationChannel):

    @classmethod
    def matches(cls, url: str) -> bool:
        # Apprise is the catch-all — it accepts everything except sip://
        # which is handled by SipChannel earlier in the registry.
        return not url.strip().lower().startswith("sip://")

    async def send(self, url: str, title: str, message: str) -> bool:
        try:
            apobj = Apprise()
            apobj.add(url)
            result = apobj.notify(title=title, body=message)
            return bool(result)
        except Exception as e:
            logger.error(f"Apprise: failed to send to '{url}': {e}")
            return False
