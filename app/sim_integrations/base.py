"""
SIM Provider base class and core contracts for Routario.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple, Union

from sim_integrations.models import (
    DataSession,
    DataSessionStats,
    RemoteSimCard,
    SimCardInfo,
    SimProviderField,
)


class BaseSimIntegration(ABC):
    """
    Abstract base class for SIM integrations within Routario.
    Each provider implements this interface directly.
    """
    PROVIDER_ID: str = ""
    DISPLAY_NAME: str = ""
    FIELDS: List[SimProviderField] = []

    @abstractmethod
    async def test_credentials(self, credentials: Dict[str, Any]) -> Tuple[bool, str]:
        """Test if credentials are valid."""
        raise NotImplementedError

    @abstractmethod
    async def fetch_remote_sims(self, credentials: Dict[str, Any]) -> List[RemoteSimCard]:
        """Fetch available SIM cards from the provider."""
        raise NotImplementedError

    @abstractmethod
    async def get_data_sessions(
        self,
        credentials: Dict[str, Any],
        date_from: Optional[Union[date, datetime, str]] = None,
        date_till: Optional[Union[date, datetime, str]] = None,
        msisdn: Optional[str] = None,
    ) -> DataSessionStats:
        """Fetch data session stats across the date range."""
        raise NotImplementedError
