/**
 * units.js — Display unit conversion utility.
 * The backend always stores metric values (km/h, km, metres).
 * This module converts for display based on the 'units' localStorage key
 * set from the user's profile preference ('metric' or 'imperial').
 */

function _isImperial() {
    return localStorage.getItem('units') === 'imperial';
}

function fmtSpeed(kmh) {
    if (kmh == null) return '—';
    return _isImperial()
        ? `${(kmh * 0.621371).toFixed(1)} mph`
        : `${Number(kmh).toFixed(1)} km/h`;
}

function fmtDist(km) {
    if (km == null) return '—';
    if (_isImperial()) {
        const mi = km * 0.621371;
        return mi >= 0.1 ? `${mi.toFixed(1)} mi` : `${Math.round(mi * 5280)} ft`;
    }
    return km >= 1 ? `${km.toFixed(1)} km` : `${Math.round(km * 1000)} m`;
}

function fmtAlt(m) {
    if (m == null) return '—';
    return _isImperial() ? `${Math.round(m * 3.28084)} ft` : `${Math.round(m)} m`;
}

function fmtOdometer(km) {
    if (km == null) return '—';
    return _isImperial()
        ? `${Math.round(km * 0.621371)} mi`
        : `${Math.round(km)} km`;
}

// Raw number in display units for <input> fields (no suffix)
function toDisplaySpeed(kmh) {
    return _isImperial() ? +(kmh * 0.621371).toFixed(1) : +Number(kmh).toFixed(1);
}
function toDisplayDist(km) {
    return _isImperial() ? +(km * 0.621371).toFixed(1) : +Number(km).toFixed(1);
}

// Convert display-unit values back to metric for storage
function fromDisplaySpeed(val) { return _isImperial() ? val / 0.621371 : val; }
function fromDisplayDist(val)  { return _isImperial() ? val / 0.621371 : val; }

function speedUnit() { return _isImperial() ? 'mph'  : 'km/h'; }
function distUnit()  { return _isImperial() ? 'mi'   : 'km'; }
function altUnit()   { return _isImperial() ? 'ft'   : 'm'; }

// Currency values are stored canonically in EUR and converted at the UI boundary.
// Rates are EUR-based display rates; update here if the supported display set changes.
const CURRENCY_RATES = {
    EUR: 1,
    USD: 1.16,
    GBP: 0.86,
    CHF: 0.92,
};

let CURRENCY_OPTIONS = [
    ['EUR', 'Euro (€)'],
    ['USD', 'US Dollar ($)'],
    ['GBP', 'British Pound (£)'],
    ['CHF', 'Swiss Franc (CHF)'],
];

function currencyName(code) {
    const currency = String(code || 'EUR').toUpperCase();
    try {
        const label = new Intl.DisplayNames([navigator.language || 'en'], { type: 'currency' }).of(currency);
        return label ? `${label} (${currency})` : currency;
    } catch {
        return currency;
    }
}

function setCurrencyRates(rates) {
    Object.keys(CURRENCY_RATES).forEach(code => delete CURRENCY_RATES[code]);
    CURRENCY_RATES.EUR = 1;
    (rates || []).forEach(row => {
        const code = String(row.currency || '').toUpperCase();
        const rate = Number(row.rate);
        if (/^[A-Z]{3}$/.test(code) && Number.isFinite(rate) && rate > 0) {
            CURRENCY_RATES[code] = rate;
        }
    });
    CURRENCY_OPTIONS = Object.keys(CURRENCY_RATES)
        .sort((a, b) => a === 'EUR' ? -1 : b === 'EUR' ? 1 : a.localeCompare(b))
        .map(code => [code, currencyName(code)]);
    window.dispatchEvent(new Event('routario:currencyrateschange'));
}

async function loadCurrencyRates() {
    if (typeof apiFetch !== 'function' || typeof API_BASE === 'undefined' || !localStorage.getItem('auth_token')) return;
    try {
        const res = await apiFetch(`${API_BASE}/currency/rates`);
        if (!res.ok) return;
        setCurrencyRates(await res.json());
    } catch {}
}

function userCurrency() {
    const cur = String(localStorage.getItem('currency') || 'EUR').toUpperCase();
    return CURRENCY_RATES[cur] ? cur : 'EUR';
}

function currencyRate(currency = userCurrency()) {
    return CURRENCY_RATES[String(currency || 'EUR').toUpperCase()] || CURRENCY_RATES.EUR;
}

function toDisplayCurrency(amountEur, currency = userCurrency()) {
    if (amountEur == null || amountEur === '') return null;
    const value = Number(amountEur);
    return Number.isFinite(value) ? value * currencyRate(currency) : null;
}

function fromDisplayCurrency(amount, currency = userCurrency()) {
    if (amount == null || amount === '') return null;
    const value = Number(amount);
    return Number.isFinite(value) ? value / currencyRate(currency) : null;
}

function fmtMoney(amountEur, currency = userCurrency(), digits = 2) {
    if (amountEur == null || amountEur === '') return '—';
    const displayCurrency = String(currency || userCurrency()).toUpperCase();
    return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: CURRENCY_RATES[displayCurrency] ? displayCurrency : 'EUR',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    }).format(toDisplayCurrency(amountEur, displayCurrency));
}

function toDisplayCurrencyAtRate(amountEur, exchangeRate = 1) {
    if (amountEur == null || amountEur === '') return null;
    const value = Number(amountEur);
    const rate = Number(exchangeRate || 1);
    return Number.isFinite(value) && Number.isFinite(rate) ? value * rate : null;
}

function fmtMoneyAtRate(amountEur, currency = 'EUR', exchangeRate = 1, digits = 2) {
    if (amountEur == null || amountEur === '') return '—';
    const displayCurrency = String(currency || 'EUR').toUpperCase();
    const display = toDisplayCurrencyAtRate(amountEur, exchangeRate);
    if (display == null) return '—';
    return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: CURRENCY_RATES[displayCurrency] ? displayCurrency : 'EUR',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    }).format(display);
}

function fmtMoneyCentsAtRate(centsEur, currency = 'EUR', exchangeRate = 1) {
    return fmtMoneyAtRate((Number(centsEur) || 0) / 100, currency, exchangeRate, 2);
}

function fmtMoneyCents(centsEur, currency = userCurrency()) {
    return fmtMoney((Number(centsEur) || 0) / 100, currency, 2);
}

function currencyInputValue(amountEur, digits = 2, currency = userCurrency()) {
    if (amountEur == null || amountEur === '') return '';
    const display = toDisplayCurrency(amountEur, currency);
    return display == null ? '' : Number(display).toFixed(digits);
}

function currencyInputToBase(value, currency = userCurrency()) {
    if (value == null || value === '') return null;
    return fromDisplayCurrency(Number(value), currency);
}

function currencyLabel(baseLabel) {
    return `${baseLabel} (${userCurrency()})`;
}

window.addEventListener('DOMContentLoaded', () => {
    loadCurrencyRates();
});
