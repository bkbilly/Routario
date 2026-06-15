from decimal import Decimal


BASE_CURRENCY = "EUR"

# EUR-based display rates. These are intentionally centralized so the backend
# snapshots the same rate family the frontend uses for conversion.
CURRENCY_RATES: dict[str, Decimal] = {
    "EUR": Decimal("1"),
    "USD": Decimal("1.08"),
    "GBP": Decimal("0.85"),
    "CHF": Decimal("0.95"),
}


def normalize_currency(currency: str | None) -> str:
    code = (currency or BASE_CURRENCY).upper()
    return code if code in CURRENCY_RATES else BASE_CURRENCY


def exchange_rate_for(currency: str | None) -> float:
    return float(CURRENCY_RATES[normalize_currency(currency)])


def currency_snapshot(user) -> tuple[str, float]:
    currency = normalize_currency(getattr(user, "currency", BASE_CURRENCY))
    return currency, exchange_rate_for(currency)


def cents_at_rate(base_cents: int | None, exchange_rate: float | None) -> int:
    rate = Decimal(str(exchange_rate or 1))
    return int((Decimal(int(base_cents or 0)) * rate).quantize(Decimal("1")))
