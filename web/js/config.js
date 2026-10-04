// Global Configuration
// Change 'localhost' to your server IP if accessing from another machine
const API_BASE = '/api';
const WS_BASE_URL = `ws${location.protocol === 'https:' ? 's' : ''}://${location.host}/ws/`;

/**
 * Drop-in replacement for fetch() that automatically:
 *  - Attaches the Authorization: Bearer <token> header
 *  - Redirects to login if the server returns 401
 *
 * Usage: exactly like fetch(), e.g.
 *   const res = await apiFetch(`${API_BASE}/devices`);
 *   const res = await apiFetch(`${API_BASE}/users`, { method: 'POST', body: JSON.stringify(data) });
 */
async function apiFetch(url, options = {}) {
    const token = localStorage.getItem('auth_token');

    const headers = {
        ...(options.headers || {}),
    };

    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    // Only set Content-Type to JSON if there's a body and it hasn't been set already
    if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, { ...options, headers });

    if (response.status === 401) {
        // Token expired or invalid — send back to login
        localStorage.removeItem('auth_token');
        localStorage.removeItem('user_id');
        localStorage.removeItem('username');
        localStorage.removeItem('is_admin');
        localStorage.removeItem('is_company_admin');
        localStorage.removeItem('company_id');
        window.location.href = 'login.html';
        return response; // won't reach, but keeps return type consistent
    }

    return response;
}

function _playCriticalAlertTone() {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.setValueAtTime(660, now + 0.15);
        osc.frequency.setValueAtTime(880, now + 0.30);
        osc.frequency.setValueAtTime(660, now + 0.45);
        osc.frequency.setValueAtTime(880, now + 0.60);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.85);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.85);
        setTimeout(() => ctx.close().catch(() => {}), 1000);
    } catch (_) {}
}

function _ensureToastStyles() {
    if (document.getElementById('routarioToastStyles')) return;
    const style = document.createElement('style');
    style.id = 'routarioToastStyles';
    style.textContent = `
.toast-container {
    position: fixed;
    bottom: 2rem;
    right: 2rem;
    max-width: 440px;
    width: calc(100vw - 3rem);
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    z-index: 99999;
    pointer-events: none;
}
.toast {
    position: relative;
    background: #181e2e;
    color: #f1f5f9;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 12px;
    padding: 0.95rem 1.15rem;
    display: flex;
    align-items: flex-start;
    gap: 0.85rem;
    box-shadow: 0 16px 36px rgba(0, 0, 0, 0.75), 0 4px 12px rgba(0, 0, 0, 0.5);
    animation: toastSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    pointer-events: auto;
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
}
body.light-theme .toast {
    background: #ffffff;
    color: #0f172a;
    border: 1px solid rgba(0, 0, 0, 0.1);
    box-shadow: 0 16px 36px rgba(0, 0, 0, 0.15), 0 4px 12px rgba(0, 0, 0, 0.08);
}
.toast-icon {
    font-size: 1.5rem;
    line-height: 1;
    flex-shrink: 0;
    margin-top: 0.1rem;
}
.toast-content {
    flex: 1;
    min-width: 0;
}
.toast-title {
    font-weight: 700;
    font-size: 0.95rem;
    line-height: 1.3;
    margin-bottom: 0.25rem;
    color: #f8fafc;
}
body.light-theme .toast-title {
    color: #0f172a;
}
.toast-message {
    font-size: 0.85rem;
    line-height: 1.45;
    color: #e2e8f0;
    word-break: break-word;
    font-weight: 500;
}
body.light-theme .toast-message {
    color: #334155;
}
.toast-close {
    background: none;
    border: none;
    color: #94a3b8;
    cursor: pointer;
    padding: 0.2rem;
    font-size: 1.1rem;
    line-height: 1;
    flex-shrink: 0;
    margin-left: 0.25rem;
    border-radius: 4px;
    transition: color 0.15s, background 0.15s;
}
.toast-close:hover {
    color: #f8fafc;
    background: rgba(255, 255, 255, 0.1);
}
body.light-theme .toast-close:hover {
    color: #0f172a;
    background: rgba(0, 0, 0, 0.06);
}
.toast-success  { border-left: 5px solid #10b981; }
.toast-success .toast-icon { color: #10b981; }
.toast-error    { border-left: 5px solid #ef4444; }
.toast-error .toast-icon { color: #ef4444; }
.toast-warning  { border-left: 5px solid #f59e0b; }
.toast-warning .toast-icon { color: #f59e0b; }
.toast-info     { border-left: 5px solid #3b82f6; }
.toast-info .toast-icon { color: #3b82f6; }

.toast-critical {
    background: #1c1520;
    border: 1px solid rgba(239, 68, 68, 0.5);
    border-left: 6px solid #ef4444;
    box-shadow: 0 0 24px rgba(239, 68, 68, 0.3), 0 16px 40px rgba(0, 0, 0, 0.8);
}
body.light-theme .toast-critical {
    background: #fff5f5;
    border: 1px solid rgba(239, 68, 68, 0.4);
    border-left: 6px solid #ef4444;
}
.toast-critical .toast-icon {
    color: #ef4444;
    font-size: 1.6rem;
    animation: toast-crit-pulse 1s infinite alternate ease-in-out;
}
@keyframes toast-crit-pulse {
    0% { transform: scale(1); filter: drop-shadow(0 0 2px rgba(239, 68, 68, 0.4)); }
    100% { transform: scale(1.18); filter: drop-shadow(0 0 8px rgba(239, 68, 68, 0.8)); }
}
@keyframes toastSlideIn {
    from { transform: translateX(110%); opacity: 0; }
    to   { transform: translateX(0);    opacity: 1; }
}
`;
    document.head.appendChild(style);
}

function _dismissAlertById(alertId) {
    if (!alertId) return;
    if (typeof handleAlertDismissedLocally === 'function') {
        handleAlertDismissedLocally(alertId, true);
    }
    const token = localStorage.getItem('auth_token') || localStorage.getItem('token') || '';
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    fetch(`${API_BASE}/alerts/${alertId}/read`, { method: 'POST', headers })
        .then(res => {
            if (res.ok) {
                if (typeof handleAlertDismissedLocally === 'function') {
                    handleAlertDismissedLocally(alertId, true);
                }
            }
        })
        .catch(err => console.debug('Failed to dismiss alert:', err));
}
window._dismissAlertById = _dismissAlertById;

/**
 * Show a toast notification.
 * Accepts either showAlert(message, type, duration)
 * or showAlert({ title, message, type, duration, alertId }).
 */
function showAlert(messageOrData, type = 'info', duration = 3000) {
    _ensureToastStyles();

    let title = null, message, resolvedType = type, resolvedDuration = duration, alertId = null;

    if (messageOrData && typeof messageOrData === 'object') {
        message          = messageOrData.message || '';
        title            = messageOrData.title   || null;
        resolvedType     = messageOrData.type    || type;
        resolvedDuration = messageOrData.duration || duration;
        alertId          = messageOrData.alertId || messageOrData.id || null;
    } else if (Array.isArray(messageOrData)) {
        message = messageOrData.map(e => (typeof e === 'object' ? (e.msg || JSON.stringify(e)) : String(e))).join('\n');
    } else {
        message = String(messageOrData ?? '');
    }

    // Auto-scale display duration for long or multi-line messages so users have time to read
    let finalDuration = resolvedDuration;
    if (resolvedType === 'critical') {
        finalDuration = resolvedDuration === 3000 ? 10000 : Math.max(resolvedDuration, 10000);
        if ('vibrate' in navigator) {
            try {
                navigator.vibrate([500, 150, 500, 150, 500, 200, 800, 200, 1200]);
            } catch (_) {}
        }
        _playCriticalAlertTone();
    } else if (message.includes('\n') || message.length > 80) {
        const calculated = Math.max(8000, Math.min(25000, message.length * 50));
        finalDuration = resolvedDuration === 3000 ? calculated : Math.max(resolvedDuration, calculated);
    }

    const icons = {
        success: 'mdi-check-circle',
        error: 'mdi-close-circle',
        warning: 'mdi-alert',
        info: 'mdi-information',
        critical: 'mdi-alert-octagon',
    };
    const icon  = icons[resolvedType] || 'mdi-information';

    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        container.id = 'toastContainer';
        document.body.appendChild(container);
    }

    const safeTitle = title ? String(title).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').trim() : null;
    const safeMsg   = String(message).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').trim().replace(/\n/g, '<br>');

    const toast = document.createElement('div');
    toast.className = `toast toast-${resolvedType}`;
    if (alertId) toast.dataset.alertId = String(alertId);

    const iconHtml = `<div class="toast-icon"><i class="mdi ${icon}"></i></div>`;
    const contentHtml = `<div class="toast-content">${safeTitle ? `<div class="toast-title">${safeTitle}</div>` : ''}<div class="toast-message">${safeMsg}</div></div>`;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.innerHTML = '<i class="mdi mdi-close"></i>';
    closeBtn.onclick = () => {
        toast.remove();
        if (alertId) {
            _dismissAlertById(alertId);
        }
    };

    toast.innerHTML = iconHtml + contentHtml;
    toast.appendChild(closeBtn);
    container.appendChild(toast);

    setTimeout(() => {
        if (!toast.isConnected) return;
        toast.style.animation = 'toastSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) reverse forwards';
        setTimeout(() => toast.remove(), 300);
    }, finalDuration);
}

// ── Universal Alert Title and Icon Resolvers ──────────────────────────────────
function getAlertDisplayTitle(alert) {
    if (!alert) return 'Alert';
    const meta = alert.alert_metadata || {};
    const params = meta.params || {};

    const typeStr = (alert.alert_type || alert.type || '').toString().toLowerCase();
    const configKey = (meta.config_key || '').toString().toLowerCase();
    const isDeviceEvent = typeStr === 'device_event' || configKey === 'device_event';

    // 1. Check event_label in meta or params (ignore generic placeholders like "device event")
    const eventLabel = meta.event_label || params.event_label;
    if (eventLabel && typeof eventLabel === 'string' && eventLabel.trim().toLowerCase() !== 'device event') {
        return eventLabel.trim();
    }

    // 2. Check rule_name in meta (ignore generic placeholders like "device event" or "device_event")
    const ruleName = meta.rule_name;
    if (ruleName && typeof ruleName === 'string' && ruleName.trim().toLowerCase() !== 'device event' && ruleName.trim().toLowerCase() !== 'device_event') {
        return ruleName.trim();
    }

    // 3. For device events, check sensor_key (e.g., 'towing' -> 'Towing', 'power_cut' -> 'Power Cut')
    const sensorKey = meta.sensor_key || params.sensor_key;
    if (sensorKey && typeof sensorKey === 'string') {
        return sensorKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
    }

    // 4. Notification title
    if ((typeStr === 'notification' || configKey === 'notification') && meta.title) {
        return meta.title.trim();
    }

    // 5. Check if message has a specific prefix (e.g., "Device Event: Towing" or "Towing: reported by device")
    if (alert.message && typeof alert.message === 'string') {
        const colonIdx = alert.message.indexOf(':');
        if (colonIdx > 0 && colonIdx < 35) {
            const prefix = alert.message.substring(0, colonIdx).trim();
            if (prefix.toLowerCase() === 'device event') {
                const rest = alert.message.substring(colonIdx + 1).split(/[\(\.,]/)[0].trim();
                if (rest && rest.toLowerCase() !== 'device event') return rest;
            } else if (prefix.toLowerCase() !== 'alert' && !prefix.includes('{')) {
                return prefix;
            }
        }
    }

    // 6. Look up in ALERT_TYPES if registered
    if (typeof ALERT_TYPES !== 'undefined' && ALERT_TYPES[typeStr]?.label) {
        return ALERT_TYPES[typeStr].label;
    }

    // 7. General alert type fallback formatted nicely (e.g. "geofence_enter" -> "Geofence Enter")
    if (typeStr && typeStr !== 'custom' && typeStr !== 'device_event') {
        return typeStr.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    return isDeviceEvent ? 'Device Alert' : (meta.rule_name || 'Alert');
}

function getAlertIconClass(alert) {
    if (!alert) return 'mdi-bell';
    const meta = alert.alert_metadata || {};
    const params = meta.params || {};

    const ICON_MAP = {
        speeding:               'mdi-speedometer',
        speed:                  'mdi-speedometer',
        geofence_enter:         'mdi-map-marker-check',
        geofence_exit:          'mdi-map-marker-minus',
        geofence:               'mdi-map-marker-radius',
        geofencing:             'mdi-map-marker-radius',
        offline:                'mdi-wifi-off',
        towing:                 'mdi-tow-truck',
        low_battery:            'mdi-battery-low',
        battery:                'mdi-battery-low',
        power_cut:              'mdi-power-plug-off',
        power:                  'mdi-power-plug-off',
        sos:                    'mdi-alarm-light',
        panic:                  'mdi-alarm-light',
        alarm:                  'mdi-alarm-light',
        tampering:              'mdi-alert',
        tamper:                 'mdi-alert',
        door:                   'mdi-door-open',
        door_open:              'mdi-door-open',
        crash:                  'mdi-car-crash',
        accident:               'mdi-car-crash',
        vibration:              'mdi-vibrate',
        shock:                  'mdi-vibrate',
        movement:               'mdi-motion-sensor',
        motion:                 'mdi-motion-sensor',
        idling:                 'mdi-engine-off',
        idle:                   'mdi-engine-off',
        ignition_on:            'mdi-key-variant',
        ignition_off:           'mdi-key-variant',
        fuel:                   'mdi-gas-station',
        fuel_drop:              'mdi-gas-station',
        temperature:            'mdi-thermometer-alert',
        maintenance:            'mdi-wrench',
        driver:                 'mdi-account-alert',
        no_driver:              'mdi-account-alert',
        notification:           'mdi-message-badge',
        route_waypoint_skipped: 'mdi-map-marker-off',
        route_off_route:        'mdi-map-marker-path',
        route_completed:        'mdi-flag-checkered',
    };

    const sensorKey = (meta.sensor_key || params.sensor_key || '').toString().toLowerCase();
    if (sensorKey && ICON_MAP[sensorKey]) return ICON_MAP[sensorKey];

    const eventLabel = (meta.event_label || params.event_label || meta.rule_name || '').toString().toLowerCase();
    for (const [key, icon] of Object.entries(ICON_MAP)) {
        if (eventLabel.includes(key)) return icon;
    }

    const alertType = (alert.alert_type || alert.type || '').toString().toLowerCase();
    if (ICON_MAP[alertType]) return ICON_MAP[alertType];

    return 'mdi-bell';
}

function getAlertIconHtml(alert) {
    return `<i class="mdi ${getAlertIconClass(alert)}"></i>`;
}

window.getAlertDisplayTitle = getAlertDisplayTitle;
window.getAlertIconClass    = getAlertIconClass;
window.getAlertIconHtml     = getAlertIconHtml;

// ── Global Real-Time Alert WebSocket (active on all authenticated pages) ───────
let _globalWs = null;
let _globalWsReconnectTimer = null;
let _globalWsConnectedUserId = null;

function initGlobalAlertWebSocket() {
    const userId = localStorage.getItem('user_id');
    const token  = localStorage.getItem('auth_token') || localStorage.getItem('token') || '';
    if (!userId || !token) return;

    if (window.location.pathname.endsWith('login.html') || window.location.pathname.endsWith('/login')) return;

    if (_globalWs && (_globalWs.readyState === WebSocket.OPEN || _globalWs.readyState === WebSocket.CONNECTING)) {
        if (_globalWsConnectedUserId === userId) return;
        try { _globalWs.close(1000, 'user changed'); } catch (_) {}
    }
    _globalWsConnectedUserId = userId;

    if (_globalWsReconnectTimer) {
        clearTimeout(_globalWsReconnectTimer);
        _globalWsReconnectTimer = null;
    }

    const wsUrl = `${WS_BASE_URL}${userId}?token=${encodeURIComponent(token)}`;
    try {
        _globalWs = new WebSocket(wsUrl);
        window.ws = _globalWs;

        _globalWs.onopen = () => {
            console.log('[WebSocket] Global socket connected for user', userId, 'on', window.location.pathname);
        };

        _globalWs.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                _dispatchGlobalWebSocketMessage(message);
            } catch (err) {
                console.error('[WebSocket] Message parsing error:', err);
            }
        };

        _globalWs.onerror = (e) => {
            console.debug('[WebSocket] Socket error on', window.location.pathname, e);
        };

        _globalWs.onclose = () => {
            if (!localStorage.getItem('auth_token')) return;
            _globalWsReconnectTimer = setTimeout(initGlobalAlertWebSocket, 5000);
        };
    } catch (e) {
        console.warn('[WebSocket] Global init failed:', e);
    }
}

const _recentAlertKeys = new Set();
function _isDuplicateAlert(message) {
    if (!message || message.type !== 'alert') return false;
    if (message._dedupChecked) return false;
    const alertData = message.data || {};
    const alertId = alertData.id || alertData.alert_id;
    const alertKey = alertId
        ? `id_${alertId}`
        : `${message.device_id}_${alertData.alert_type}_${alertData.created_at || message.timestamp || ''}`;

    if (_recentAlertKeys.has(alertKey)) {
        return true;
    }
    _recentAlertKeys.add(alertKey);
    message._dedupChecked = true;
    setTimeout(() => _recentAlertKeys.delete(alertKey), 8000);
    return false;
}
window._isDuplicateAlert = _isDuplicateAlert;

const _alertsBroadcastChannel = (typeof BroadcastChannel !== 'undefined')
    ? new BroadcastChannel('routario_alerts_sync')
    : null;

function handleAlertDismissedLocally(alertId, broadcastToOthers = false) {
    if (!alertId) return;
    const strAlertId = String(alertId);

    // 1. Remove active toasts on this page matching this alertId
    try {
        const toasts = document.querySelectorAll(`.toast[data-alert-id="${strAlertId}"]`);
        toasts.forEach(t => t.remove());
    } catch (_) {}

    // 2. Decrement in-memory loadedAlerts if present
    if (Array.isArray(window.loadedAlerts)) {
        window.loadedAlerts = window.loadedAlerts.filter(a => String(a.id) !== strAlertId);
        if (typeof updateAlertsButtonState === 'function') {
            const hasCritical = window.loadedAlerts.some(a => a.severity === 'critical' || a.severity === 'high');
            updateAlertsButtonState(window.loadedAlerts.length, hasCritical);
        }
    } else if (typeof updateAlertsButtonState === 'function') {
        const badge = document.getElementById('alertCount');
        const currentCount = parseInt(badge?.textContent, 10) || 0;
        updateAlertsButtonState(Math.max(0, currentCount - 1));
    }

    // 3. Remove item from any open alerts list modal on this page
    try {
        const modalItem = document.querySelector(`#alertsList [data-alert-id="${strAlertId}"]`);
        if (modalItem) modalItem.remove();
    } catch (_) {}

    // 4. Reload alerts from server to guarantee sync
    if (typeof loadAlerts === 'function') {
        loadAlerts();
    }
    if (typeof loadAlertRuleHistoryData === 'function') {
        loadAlertRuleHistoryData();
    }
    if (typeof historyVisible !== 'undefined' && historyVisible && typeof loadAlertHistory === 'function') {
        loadAlertHistory();
    }
    if (typeof devices !== 'undefined' && Array.isArray(devices) && typeof updateSidebarCard === 'function') {
        devices.forEach(d => updateSidebarCard(d.id));
    }

    // 5. Broadcast to other open tabs if requested
    if (broadcastToOthers) {
        if (_alertsBroadcastChannel) {
            try { _alertsBroadcastChannel.postMessage({ type: 'ALERT_DISMISSED', alertId: strAlertId }); } catch (_) {}
        }
        try {
            localStorage.setItem('routario_alert_sync', JSON.stringify({
                type: 'ALERT_DISMISSED',
                alertId: strAlertId,
                _t: Date.now()
            }));
        } catch (_) {}
    }
}
window.handleAlertDismissedLocally = handleAlertDismissedLocally;

function handleAlertsClearedLocally(broadcastToOthers = false) {
    // 1. Remove all active alert toasts
    try {
        document.querySelectorAll('.toast[data-alert-id]').forEach(t => t.remove());
    } catch (_) {}

    // 2. Clear in-memory loaded alerts and update badge
    window.loadedAlerts = [];
    if (typeof updateAlertsButtonState === 'function') {
        updateAlertsButtonState(0, false);
    }

    // 3. Clear modal list
    const list = document.getElementById('alertsList');
    if (list) {
        list.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-muted);">No alerts</div>';
    }

    // 4. Reload alerts / history
    if (typeof loadAlerts === 'function') {
        loadAlerts();
    }
    if (typeof loadAlertRuleHistoryData === 'function') {
        loadAlertRuleHistoryData();
    }
    if (typeof historyVisible !== 'undefined' && historyVisible && typeof loadAlertHistory === 'function') {
        loadAlertHistory();
    }
    if (typeof devices !== 'undefined' && Array.isArray(devices) && typeof updateSidebarCard === 'function') {
        devices.forEach(d => updateSidebarCard(d.id));
    }

    // 5. Broadcast to other open tabs if requested
    if (broadcastToOthers) {
        if (_alertsBroadcastChannel) {
            try { _alertsBroadcastChannel.postMessage({ type: 'ALERTS_CLEARED' }); } catch (_) {}
        }
        try {
            localStorage.setItem('routario_alert_sync', JSON.stringify({
                type: 'ALERTS_CLEARED',
                _t: Date.now()
            }));
        } catch (_) {}
    }
}
window.handleAlertsClearedLocally = handleAlertsClearedLocally;

// Cross-tab BroadcastChannel listener
if (_alertsBroadcastChannel) {
    _alertsBroadcastChannel.onmessage = (event) => {
        if (!event.data) return;
        if (event.data.type === 'ALERT_DISMISSED') {
            handleAlertDismissedLocally(event.data.alertId, false);
        } else if (event.data.type === 'ALERTS_CLEARED') {
            handleAlertsClearedLocally(false);
        }
    };
}

// Storage event listener fallback (for other windows/tabs)
window.addEventListener('storage', (event) => {
    if (event.key === 'routario_alert_sync' && event.newValue) {
        try {
            const data = JSON.parse(event.newValue);
            if (data.type === 'ALERT_DISMISSED') {
                handleAlertDismissedLocally(data.alertId, false);
            } else if (data.type === 'ALERTS_CLEARED') {
                handleAlertsClearedLocally(false);
            }
        } catch (_) {}
    }
});

function _dispatchGlobalWebSocketMessage(message) {
    if (!message) return;

    if (message.type === 'alert_dismissed') {
        handleAlertDismissedLocally(message.alert_id, true);
        return;
    }
    if (message.type === 'alerts_cleared') {
        handleAlertsClearedLocally(true);
        return;
    }

    if (message.type === 'alert') {
        if (_isDuplicateAlert(message)) {
            console.debug('[WebSocket] Duplicate alert message suppressed:', message);
            return;
        }
    }

    // If on dashboard, delegate full handling to dashboard-map.js
    if (typeof handleWebSocketMessage === 'function') {
        handleWebSocketMessage(message);
        return;
    }

    // On all other pages (device-management, reports, management, company, etc.):
    if (message.type === 'alert') {
        console.log('[WebSocket] Real-time alert on page:', window.location.pathname, message);
        const alertData = message.data || {};
        const title = typeof getAlertDisplayTitle === 'function'
            ? getAlertDisplayTitle(alertData)
            : (alertData.alert_metadata?.rule_name || alertData.alert_metadata?.event_label || (alertData.alert_type ? alertData.alert_type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Alert'));
        const toastMessage = alertData.alert_metadata?.rule_condition || alertData.message || 'New alert triggered';

        showAlert({
            title,
            message: toastMessage,
            type: alertData.severity || 'info',
            alertId: alertData.id || alertData.alert_id,
        });

        if (typeof updateAlertsButtonState === 'function') {
            const currentCount = Array.isArray(window.loadedAlerts) ? window.loadedAlerts.length : (typeof loadedAlerts !== 'undefined' && Array.isArray(loadedAlerts) ? loadedAlerts.length : 0);
            updateAlertsButtonState(currentCount + 1, alertData.severity === 'critical' || alertData.severity === 'high');
        }

        if (typeof loadAlertRuleHistoryData === 'function') {
            loadAlertRuleHistoryData();
        }
        if (typeof loadAlerts === 'function') {
            loadAlerts();
        }
    }
}

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'ALERT_DISMISSED') {
            if (event.data.needsApiCall && event.data.alertId) {
                _dismissAlertById(event.data.alertId);
            } else {
                handleAlertDismissedLocally(event.data.alertId, true);
            }
        } else if (event.data?.type === 'ALERTS_CLEARED') {
            handleAlertsClearedLocally(true);
        }
    });
}

window.initGlobalAlertWebSocket = initGlobalAlertWebSocket;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initGlobalAlertWebSocket();
    });
} else {
    initGlobalAlertWebSocket();
}

function hasPermission(perm) {
    if (localStorage.getItem('is_admin') === 'true') return true;
    try {
        return JSON.parse(localStorage.getItem('permissions') || '[]').includes(perm);
    } catch { return false; }
}

/**
 * Apply light or dark theme across the application.
 * @param {string} theme - 'light' or 'dark'
 */
function applyTheme(theme) {
    const activeTheme = (theme === 'light') ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', activeTheme);
    if (activeTheme === 'light') {
        document.documentElement.classList.add('light-theme');
        if (document.body) document.body.classList.add('light-theme');
    } else {
        document.documentElement.classList.remove('light-theme');
        if (document.body) document.body.classList.remove('light-theme');
    }
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
        metaThemeColor.setAttribute('content', activeTheme === 'light' ? '#f1f3f7' : '#170b1c');
    }
    window.dispatchEvent(new CustomEvent('routario:themechange', { detail: { theme: activeTheme } }));
}

// Immediately apply saved or default theme
applyTheme(localStorage.getItem('theme') || 'dark');

function handleLogout() {
    const loginSlug = localStorage.getItem('company_login_slug');
    const slugCompanyId = localStorage.getItem('company_login_slug_company_id');
    const currentCompanyId = localStorage.getItem('company_id');
    const loginUrl = loginSlug && slugCompanyId && currentCompanyId && slugCompanyId === currentCompanyId
        ? `/login/${encodeURIComponent(loginSlug)}`
        : '/login.html';
    ['auth_token','user_id','username','is_admin','units','currency','theme','is_company_admin','company_id',
     'permissions',
     'impersonation_stack',
     'impersonating_admin_token','impersonating_admin_user_id','impersonating_admin_username']
        .forEach(k => localStorage.removeItem(k));
    applyTheme('dark');
    window.location.href = loginUrl;
}

function checkLogin() {
    if (!localStorage.getItem('auth_token')) window.location.href = 'login.html';
}

function _setHeadLink(rel, href) {
    let link = document.querySelector(`link[rel="${rel}"]`);
    if (!link) {
        link = document.createElement('link');
        link.rel = rel;
        document.head.appendChild(link);
    }
    link.href = href;
}

function _defaultTitleForPage() {
    const title = document.documentElement.dataset.defaultTitle || document.title || 'Routario';
    return title.includes(' - Routario') ? title.replace(' - Routario', '') : title.replace('Routario', '').trim();
}

async function applyCompanyBranding(companyId = localStorage.getItem('company_id')) {
    const cid = parseInt(companyId || '0', 10) || null;
    if (!cid) return;
    if (!document.documentElement.dataset.defaultTitle) {
        document.documentElement.dataset.defaultTitle = document.title || 'Routario';
    }

    const base = `/branding/company/${cid}`;
    _setHeadLink('manifest', `/manifest.json?company_id=${cid}`);
    _setHeadLink('icon', `${base}/favicon.ico`);
    _setHeadLink('apple-touch-icon', `${base}/apple-touch-icon.png`);

    try {
        const res = await fetch(`${base}/metadata`);
        if (!res.ok) return;
        const meta = await res.json();
        const version = meta.branding_version || 1;
        if (meta.login_slug) {
            localStorage.setItem('company_login_slug', meta.login_slug);
            localStorage.setItem('company_login_slug_company_id', String(cid));
        } else {
            localStorage.removeItem('company_login_slug');
            localStorage.removeItem('company_login_slug_company_id');
        }
        _setHeadLink('manifest', `/manifest.json?company_id=${cid}&v=${version}`);
        if (meta.icon_url) {
            _setHeadLink('icon', `${base}/favicon.ico?v=${version}`);
            _setHeadLink('apple-touch-icon', `${base}/apple-touch-icon.png?v=${version}`);
            document.querySelectorAll('.logo-icon').forEach(img => { img.src = `${base}/icon-192.png?v=${version}`; });
        } else {
            document.querySelectorAll('.logo-icon').forEach(img => { img.src = '/icons/icon-192.png'; });
        }
        if (meta.app_name) {
            const page = _defaultTitleForPage();
            document.title = page ? `${page} - ${meta.app_name}` : meta.app_name;
            const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
            if (appleTitle) appleTitle.content = meta.app_name;
            document.querySelectorAll('.logo-text').forEach(el => { el.textContent = meta.app_name; });
        } else {
            document.title = document.documentElement.dataset.defaultTitle || document.title;
            const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
            if (appleTitle) appleTitle.content = 'Routario';
            document.querySelectorAll('.logo-text').forEach(el => { el.textContent = 'Routario'; });
        }
    } catch {
        // Branding is cosmetic; keep the default Routario assets if it fails.
    }
}

async function applyCompanyLoginBranding(companySlug) {
    const slug = String(companySlug || '').trim().toLowerCase();
    if (!slug) return null;
    if (!document.documentElement.dataset.defaultTitle) {
        document.documentElement.dataset.defaultTitle = document.title || 'Routario';
    }

    try {
        const res = await fetch(`/branding/login/${encodeURIComponent(slug)}/metadata`);
        if (!res.ok) return null;
        const meta = await res.json();
        if (!meta.company_id) return null;
        if (meta.login_slug) {
            localStorage.setItem('company_login_slug', meta.login_slug);
            localStorage.setItem('company_login_slug_company_id', String(meta.company_id));
        }

        const version = meta.branding_version || 1;
        const base = `/branding/company/${meta.company_id}`;
        _setHeadLink('manifest', `/manifest.json?company_slug=${encodeURIComponent(slug)}&v=${version}`);

        if (meta.icon_url) {
            _setHeadLink('icon', `${base}/favicon.ico?v=${version}`);
            _setHeadLink('apple-touch-icon', `${base}/apple-touch-icon.png?v=${version}`);
            document.querySelectorAll('.logo-icon').forEach(img => { img.src = `${base}/icon-192.png?v=${version}`; });
        }
        if (meta.app_name) {
            const page = _defaultTitleForPage();
            document.title = page ? `${page} - ${meta.app_name}` : meta.app_name;
            const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
            if (appleTitle) appleTitle.content = meta.app_name;
            document.querySelectorAll('.logo-text').forEach(el => { el.textContent = meta.app_name; });
        }
        return meta;
    } catch {
        return null;
    }
}

function _esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _parseDate(val) {
    if (!val) return null;
    if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
    if (typeof val === 'number') {
        const d = new Date(val < 1e11 ? val * 1000 : val);
        return isNaN(d.getTime()) ? null : d;
    }
    let str = String(val).trim();
    if (!str) return null;
    if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(str)) str += 'Z';
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
}

function formatDateValue(val, format = null) {
    const d = _parseDate(val);
    if (!d) return val ? String(val) : 'N/A';

    const fmt = format || localStorage.getItem('date_format') || 'auto';
    const tz = localStorage.getItem('timezone');

    let year, month, day;
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz || undefined,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(d);
        const map = {};
        parts.forEach(({ type, value }) => { map[type] = value; });
        year = map.year;
        month = map.month;
        day = map.day;
    } catch (_) {
        year = String(d.getFullYear());
        month = String(d.getMonth() + 1).padStart(2, '0');
        day = String(d.getDate()).padStart(2, '0');
    }

    if (fmt === 'YYYY-MM-DD') return `${year}-${month}-${day}`;
    if (fmt === 'DD/MM/YYYY') return `${day}/${month}/${year}`;
    if (fmt === 'MM/DD/YYYY') return `${month}/${day}/${year}`;
    if (fmt === 'DD.MM.YYYY') return `${day}.${month}.${year}`;

    try {
        return d.toLocaleDateString(undefined, {
            timeZone: tz || undefined,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
    } catch (_) {
        return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
    }
}

function formatTimeValue(val, { withSeconds = false, format = null } = {}) {
    const d = _parseDate(val);
    if (!d) return val ? String(val) : 'N/A';

    const fmt = format || localStorage.getItem('time_format') || 'auto';
    const tz = localStorage.getItem('timezone');

    const opts = {
        minute: '2-digit',
        ...(withSeconds ? { second: '2-digit' } : {})
    };
    if (tz) {
        try { opts.timeZone = tz; } catch (_) {}
    }

    if (fmt === '12h') {
        opts.hour = 'numeric';
        opts.hour12 = true;
        return d.toLocaleTimeString(undefined, opts);
    }
    if (fmt === '24h') {
        opts.hour = '2-digit';
        opts.hour12 = false;
        return d.toLocaleTimeString(undefined, opts);
    }

    opts.hour = '2-digit';
    return d.toLocaleTimeString(undefined, opts);
}

function formatDateTimeValue(val, { withSeconds = false, dateFormat = null, timeFormat = null } = {}) {
    const d = _parseDate(val);
    if (!d) return val ? String(val) : 'N/A';
    return `${formatDateValue(d, dateFormat)} ${formatTimeValue(d, { withSeconds, format: timeFormat })}`;
}

function formatDateToLocal(str, { withSeconds = false } = {}) {
    if (!str) return 'N/A';
    const d = _parseDate(str);
    if (!d) return String(str);
    return formatDateTimeValue(d, { withSeconds });
}

function formatDateToLocalSplit(str, { withSeconds = true } = {}) {
    if (!str) return 'N/A';
    const d = _parseDate(str);
    if (!d) return String(str);
    const dateStr = formatDateValue(d);
    const timeStr = formatTimeValue(d, { withSeconds });
    return `<div style="font-weight:600;">${dateStr}</div><div style="font-size:0.75rem;color:var(--text-muted);">${timeStr}</div>`;
}

function parseUserDateTime(str) {
    if (!str) return null;
    str = String(str).trim();
    if (!str) return null;

    const fmt = localStorage.getItem('date_format') || 'auto';

    const ymdMatch = /^(\d{4})[-\/\.](\d{1,2})[-\/\.](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(am|pm))?)?$/i.exec(str);
    if (ymdMatch) {
        let [, year, month, day, hr, min, sec, ampm] = ymdMatch;
        let h = hr ? parseInt(hr, 10) : 0;
        const m = min ? parseInt(min, 10) : 0;
        const s = sec ? parseInt(sec, 10) : 0;
        if (ampm) {
            ampm = ampm.toLowerCase();
            if (ampm === 'pm' && h < 12) h += 12;
            if (ampm === 'am' && h === 12) h = 0;
        }
        return new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10), h, m, s);
    }

    const dmyMatch = /^(\d{1,2})[-\/\.](\d{1,2})[-\/\.](\d{4})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(am|pm))?)?$/i.exec(str);
    if (dmyMatch) {
        let [, p1, p2, year, hr, min, sec, ampm] = dmyMatch;
        const p1Num = parseInt(p1, 10);
        const p2Num = parseInt(p2, 10);
        let day, month;
        if (fmt === 'MM/DD/YYYY') {
            month = p1Num - 1;
            day = p2Num;
        } else {
            day = p1Num;
            month = p2Num - 1;
        }
        let h = hr ? parseInt(hr, 10) : 0;
        const m = min ? parseInt(min, 10) : 0;
        const s = sec ? parseInt(sec, 10) : 0;
        if (ampm) {
            ampm = ampm.toLowerCase();
            if (ampm === 'pm' && h < 12) h += 12;
            if (ampm === 'am' && h === 12) h = 0;
        }
        return new Date(parseInt(year, 10), month, day, h, m, s);
    }

    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
}

window.formatDateValue = formatDateValue;
window.formatTimeValue = formatTimeValue;
window.formatDateTimeValue = formatDateTimeValue;
window.formatDateToLocal = formatDateToLocal;
window.formatDateToLocalSplit = formatDateToLocalSplit;
window.parseUserDateTime = parseUserDateTime;

async function syncUserTimezone(user = null) {
    const token = localStorage.getItem('auth_token');
    const userId = localStorage.getItem('user_id');
    if (!token || !userId || typeof Intl === 'undefined') return;

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timezone || timezone === localStorage.getItem('timezone')) return;
    if (user?.timezone === timezone) {
        localStorage.setItem('timezone', timezone);
        return;
    }

    try {
        const res = await apiFetch(`${API_BASE}/users/${userId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ timezone }),
        });
        if (res.ok) localStorage.setItem('timezone', timezone);
    } catch {
        // Timezone is a convenience value; keep the app working if sync fails.
    }
}

// Refresh permissions from the server on every page load so changes take
// effect without requiring a logout.  Resolves with the user object (or null)
// so callers can reuse the data without a second fetch.
const permissionsReady = (function () {
    const token  = localStorage.getItem('auth_token');
    const userId = localStorage.getItem('user_id');
    if (!token || !userId) return Promise.resolve(null);
    return fetch(`${API_BASE}/users/${userId}`, {
        headers: { Authorization: `Bearer ${token}` },
    })
    .then(r => {
        if (r.status === 401) { handleLogout(); return null; }
        return r.ok ? r.json() : null;
    })
    .then(user => {
        if (!user) return null;
        if (Array.isArray(user.permissions))
            localStorage.setItem('permissions', JSON.stringify(user.permissions));
        if (user.is_admin !== undefined)
            localStorage.setItem('is_admin', user.is_admin);
        if (user.is_company_admin !== undefined)
            localStorage.setItem('is_company_admin', user.is_company_admin);
        if (user.company_id !== undefined)
            localStorage.setItem('company_id', user.company_id ?? '');
        if (user.units)
            localStorage.setItem('units', user.units);
        if (user.currency)
            localStorage.setItem('currency', user.currency);
        if (user.theme) {
            localStorage.setItem('theme', user.theme);
            applyTheme(user.theme);
        }
        if (user.sidebar_compact !== undefined) {
            localStorage.setItem('sidebar_compact', user.sidebar_compact ? 'true' : 'false');
            applySidebarCompact(user.sidebar_compact);
        }
        if (user.time_format !== undefined)
            localStorage.setItem('time_format', user.time_format || 'auto');
        if (user.date_format !== undefined)
            localStorage.setItem('date_format', user.date_format || 'auto');
        if (user.timezone)
            localStorage.setItem('timezone', user.timezone);
        applyCompanyBranding(user.company_id);
        syncUserTimezone(user);
        return user;
    })
    .catch(() => null); // network failure: use cached value
})();

function applySidebarCompact(compact) {
    const isCompact = compact === true || compact === 'true';
    if (document.body) document.body.classList.toggle('sidebar-compact', isCompact);
    const dashboard = document.querySelector('.dashboard');
    if (dashboard) dashboard.classList.toggle('sidebar-compact', isCompact);
}
window.applySidebarCompact = applySidebarCompact;

if (localStorage.getItem('sidebar_compact') === 'true') {
    if (document.body) document.body.classList.add('sidebar-compact');
    else document.addEventListener('DOMContentLoaded', () => document.body?.classList.add('sidebar-compact'));
}

if (localStorage.getItem('company_id')) {
    applyCompanyBranding();
}
