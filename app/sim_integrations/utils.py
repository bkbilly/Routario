"""Utility helpers for parsing and unit conversion."""
from __future__ import annotations

from datetime import date, datetime
import re
from typing import Optional, Union


def parse_data_size_to_bytes(size_str: Optional[str]) -> int:
    """
    Parse strings like '8.08 MB', '2.00 KB', '500 Bytes', '1.5 GB' into bytes.
    Returns 0 if None or invalid.
    """
    if not size_str:
        return 0

    cleaned = size_str.replace(",", ".").strip()
    match = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z]+)?", cleaned)
    if not match:
        return 0

    val = float(match.group(1))
    unit = (match.group(2) or "B").upper()

    multipliers = {
        "B": 1,
        "BYTE": 1,
        "BYTES": 1,
        "KB": 1024,
        "KIB": 1024,
        "MB": 1024 * 1024,
        "MIB": 1024 * 1024,
        "GB": 1024 * 1024 * 1024,
        "GIB": 1024 * 1024 * 1024,
        "TB": 1024 * 1024 * 1024 * 1024,
        "TIB": 1024 * 1024 * 1024 * 1024,
    }

    multiplier = multipliers.get(unit, 1)
    return int(round(val * multiplier))


def parse_price(price_str: Optional[str]) -> float:
    """
    Parse monetary amount from strings like '0.0000 €', '4.00 €', '0.0000&nbsp;&euro;'.
    Returns 0.0 if not parsable.
    """
    if not price_str:
        return 0.0

    cleaned = (
        price_str.replace("&nbsp;", " ")
        .replace("&euro;", "€")
        .replace(",", ".")
        .strip()
    )
    match = re.search(r"[-+]?[0-9]+(?:\.[0-9]+)?", cleaned)
    if not match:
        return 0.0

    try:
        return float(match.group(0))
    except (ValueError, TypeError):
        return 0.0


def parse_date(date_val: Optional[Union[date, datetime, str]]) -> Optional[date]:
    """
    Parse a date object or string into datetime.date.
    Accepts date, datetime, or strings like 'YYYY-MM-DD', 'YYYY/MM/DD', 'DD-MM-YYYY'.
    """
    if date_val is None:
        return None
    if isinstance(date_val, datetime):
        return date_val.date()
    if isinstance(date_val, date):
        return date_val
    if isinstance(date_val, str):
        date_str = date_val.strip()
        for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%d-%m-%Y", "%d/%m/%Y"):
            try:
                return datetime.strptime(date_str, fmt).date()
            except ValueError:
                pass
    return None


def format_data_size(bytes_val: int) -> str:
    """Format bytes into human readable string like '14.03 MB' or '2.00 KB'."""
    if bytes_val >= 1024 * 1024 * 1024:
        return f"{bytes_val / (1024 * 1024 * 1024):.2f} GB"
    if bytes_val >= 1024 * 1024:
        return f"{bytes_val / (1024 * 1024):.2f} MB"
    if bytes_val >= 1024:
        return f"{bytes_val / 1024:.2f} KB"
    return f"{bytes_val} Bytes"


def format_status(raw: Optional[str]) -> str:
    """Format raw status string into clean display text."""
    if not raw:
        return "Active"
    cleaned = raw.strip().replace("_", " ").replace("-", " ")
    if cleaned.lower() == "not active":
        return "Not Active"
    if cleaned.lower() == "waiting for activation":
        return "Waiting for Activation"
    return " ".join(word.capitalize() for word in cleaned.split())
