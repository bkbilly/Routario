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
