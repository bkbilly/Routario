from decimal import Decimal


BASE_CURRENCY = "EUR"

# EUR-based display rates. The database can override these values at runtime.
DEFAULT_CURRENCY_RATES: dict[str, Decimal] = {
    "EUR": Decimal("1"),
    "USD": Decimal("1.08"),
    "GBP": Decimal("0.85"),
    "CHF": Decimal("0.95"),
}
CURRENCY_RATES: dict[str, Decimal] = dict(DEFAULT_CURRENCY_RATES)


def set_currency_rates(rates: dict[str, float | int | str | Decimal]) -> None:
    next_rates = {BASE_CURRENCY: Decimal("1")}
    for code, rate in rates.items():
        currency = (code or "").upper()
        if len(currency) != 3:
            continue
        value = Decimal(str(rate))
        if value <= 0:
            continue
        next_rates[currency] = value
    CURRENCY_RATES.clear()
    CURRENCY_RATES.update(next_rates)


async def load_currency_rates() -> None:
    from sqlalchemy import text
    from core.database import get_db

    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(text("SELECT currency, rate FROM currency_rates"))
        rates = {row.currency: row.rate for row in result.all()}
    set_currency_rates(rates or DEFAULT_CURRENCY_RATES)


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
