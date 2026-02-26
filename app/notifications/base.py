"""
Base Notification Channel
All notification channels must subclass BaseNotificationChannel.

To add a new channel type:
  1. Create a new .py file in this folder (e.g. my_channel.py).
  2. Define a class that subclasses BaseNotificationChannel.
  3. Implement matches() and send().
  4. That's it — it will be picked up automatically on next startup.

Example:
    class MyChannel(BaseNotificationChannel):

        @classmethod
        def matches(cls, url: str) -> bool:
            return url.startswith("myscheme://")

        async def send(self, url: str, title: str, message: str) -> bool:
            ...
            return True
"""

from abc import ABC, abstractmethod


class BaseNotificationChannel(ABC):

    @classmethod
    @abstractmethod
    def matches(cls, url: str) -> bool:
        """
        Return True if this channel handles the given URL.
        Called once per URL to decide which channel class owns it.
        The registry tries channels in registration order; the first match wins.
        """
        ...

    @abstractmethod
    async def send(self, url: str, title: str, message: str) -> bool:
        """
        Deliver the notification.

        Args:
            url:     The raw channel URL as entered by the user.
            title:   Short alert title  (e.g. "🚗 Truck 1 - SPEEDING").
            message: Full alert message (e.g. "Speed 95 km/h exceeded limit of 80 km/h").

        Returns:
            True if the notification was delivered successfully, False otherwise.
        """
        ...
