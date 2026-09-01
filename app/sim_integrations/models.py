"""Data models for SIM provider integrations."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Dict, List, Optional


@dataclass
class SimCardInfo:
    """SIM card summary information parsed from provider."""
    phone_number: str
    plan_name: Optional[str] = None
    expiry_date: Optional[date] = None
    auto_renew: Optional[bool] = None
    contract_id: Optional[str] = None
    balance: Optional[float] = None
    remaining_data_mb: Optional[float] = None
    remaining_data_bytes: Optional[int] = None
    currency: str = "EUR"
    status: Optional[str] = None


@dataclass
class DataSession:
    """Individual data session log row."""
    date: Optional[datetime] = None
    status: Optional[str] = None
    completed_at: Optional[datetime] = None
    country: Optional[str] = None
    network: Optional[str] = None
    billed_raw: str = ""
    billed_bytes: int = 0
    price: float = 0.0
    currency: str = "EUR"


@dataclass
class DataSessionStats:
    """Aggregated statistics and list of sessions for a date range."""
    total_billsec: str
    total_billsec_bytes: int
    total_user_price: float
    currency: str = "EUR"
    sessions_count: int = 0
    status: Optional[str] = None
    balance: Optional[float] = None
    remaining_data_mb: Optional[float] = None
    remaining_data_bytes: Optional[int] = None
    expiry_date: Optional[str] = None
    plan_name: Optional[str] = None
    error_message: Optional[str] = None
    sessions: List[DataSession] = field(default_factory=list)
    sim_data_sessions: Dict[str, DataSessionStats] = field(default_factory=dict)


@dataclass
class SimProviderField:
    """Describes one credential or configuration field shown in the SIM card modal form."""
    key: str
    label: str
    field_type: str = "text"  # "text" | "password" | "number"
    required: bool = True
    placeholder: str = ""
    help_text: str = ""
    default: Any = None


@dataclass
class RemoteSimCard:
    """Descriptor for a SIM card discovered remotely from the provider."""
    phone_number: str
    iccid: Optional[str] = None
    plan_name: Optional[str] = None
    balance: Optional[float] = None
    remaining_data_mb: Optional[float] = None
    remaining_data_bytes: Optional[int] = None
    currency: str = "EUR"
    expiry_date: Optional[str] = None
    status: Optional[str] = None
    extra: Dict[str, Any] = field(default_factory=dict)
