/**
 * dashboard-utils.js
 * Shared utility and formatting helpers.
 */

// Helper to format duration in minutes to "Xh Ym" format
function formatDuration(minutes) {
    if (!minutes || minutes <= 0) return '0 min';
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    if (h === 0) return `${m} min`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}min`;
}

// Helper to format time ago (human readable)
function timeAgo(dateString) {
    if (!dateString) return 'Never';

    // Ensure UTC parsing
    if (dateString.indexOf('Z') === -1 && dateString.indexOf('+') === -1) {
        dateString += 'Z';
    }

    const date = new Date(dateString);
    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);

    if (seconds < 30) return 'Just now';

    const intervals = {
        year: 31536000,
        month: 2592000,
        week: 604800,
        day: 86400,
        hour: 3600,
        minute: 60
    };

    for (let [unit, secondsInUnit] of Object.entries(intervals)) {
        const count = Math.floor(seconds / secondsInUnit);
        if (count >= 1) {
            return `${count} ${unit}${count > 1 ? 's' : ''} ago`;
        }
    }
    return 'Just now';
}

// Helper to format mileage
function formatDistance(meters) {
    if (meters === undefined || meters === null) return '0 km';
    return `${parseFloat(meters).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
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


