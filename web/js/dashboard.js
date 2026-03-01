/**
 * dashboard.js
 * Entry point — runs after the DOM is ready.
 *
 * All logic lives in the following modules (load them before this file):
 *   dashboard-state.js    — shared state variables
 *   dashboard-utils.js    — formatting helpers (timeAgo, formatDistance, …)
 *   dashboard-auth.js     — checkLogin, handleLogout
 *   dashboard-map.js      — initMap, tile layers, markers, WebSocket
 *   dashboard-devices.js  — loadDevices, sidebar cards, sorting, filtering
 *   dashboard-alerts.js   — loadAlerts, toasts, alert modal
 *   dashboard-history.js  — history modal, playback, trips, sensor graph, CSV
 */

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    checkLogin();
    // Restore saved sort (fixes the bug where sort was highlighted but not active)
    const savedSort = localStorage.getItem('vehicleSortMode') || 'name';
    currentSort = savedSort;
    const sel = document.getElementById('sortSelect');
    if (sel) sel.value = savedSort;

    initMap();
    await loadDevices();
    connectWebSocket();
    loadAlerts(); // Load alerts immediately on startup
    startPeriodicUpdate();

    // Set Username in sidebar
    const username = localStorage.getItem('username');
    const userId = parseInt(localStorage.getItem('user_id'));
    if (username) {
        const userDisplay = document.getElementById('userNameDisplay');
        if (userDisplay) userDisplay.textContent = username;
    }
    if (localStorage.getItem('is_admin') === 'true') {
        document.getElementById('userRoleDisplay').textContent = 'Administrator';
    } else {
        document.getElementById('userRoleDisplay').textContent = 'User';
    }

    // Mutation Observer for Alert Button
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            const count = parseInt(mutation.target.textContent) | 0;
            const btn = document.getElementById('alertsBtn');
            if (btn) {
                if (count > 0) {
                    btn.classList.add('has-alerts');
                } else {
                    btn.classList.remove('has-alerts');
                }
            }
        });
    });

    const alertCountSpan = document.getElementById('alertCount');
    if (alertCountSpan) {
        observer.observe(alertCountSpan, { childList: true, characterData: true, subtree: true });
    }

    // Start local time update interval (every 60s) for "time ago"
    setInterval(updateSidebarTimes, 60000);
});

document.addEventListener('click', closePicker);