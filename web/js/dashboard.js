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
    await permissionsReady;

    // Hide elements the current user has no permission to access
    if (!hasPermission('manage_geofences')) {
        document.getElementById('drawGeofenceBtn')?.style.setProperty('display', 'none', 'important');
    }
    if (!hasPermission('view_reports')) {
        document.getElementById('dashReportsLink')?.remove();
    }
    if (!hasPermission('view_management')) {
        document.getElementById('dashManagementLink')?.remove();
    }
    if (hasPermission('view_management') && hasPermission('manage_routes')) {
        document.getElementById('dashboardRoutesBtn')?.style.removeProperty('display');
    }

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

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    const historyClip = document.getElementById('historyClipModal');
    if (historyClip && historyClip.style.display !== 'none' && historyClip.style.display !== '') {
        document.getElementById('historyClipVideo')?.pause();
        historyClip.style.display = 'none';
        return;
    }
    
    const modalIds = [
        'dashboardRouteDetailsModal',
        'dashboardRouteEditorModal',
        'dashboardRoutesModal',
        'lbFuelModal',
        'lbEntryModal',
        'alertsModal',
        'historyModal',
        'shareModal',
        'logbookModal',
        'geofenceModal',
    ];

    if (document.getElementById('pttModal')?.classList.contains('active')) {
        pttCloseModal();
        return;
    }

    for (const id of modalIds) {
        const modal = document.getElementById(id);
        if (modal?.classList.contains('active')) {
            modal.classList.remove('active');
            return;
        }
    }
});
