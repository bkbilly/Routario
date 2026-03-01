/**
 * dashboard-utils.js
 * Shared utility and formatting helpers.
 */

// Helper to format dates to local time for display
function formatDateToLocal(dateString) {
    if (!dateString) return 'N/A';
    if (dateString.indexOf('Z') === -1 && dateString.indexOf('+') === -1) {
        dateString += 'Z';
    }
    return new Date(dateString).toLocaleString();
}

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