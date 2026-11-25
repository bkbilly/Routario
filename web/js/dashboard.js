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
 *   dashboard-history.js  — history modal, playback, trips, details
 */

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    checkLogin();
    await permissionsReady;

    if (!hasPermission('view_dashboard')) {
        if (hasPermission('view_management')) {
            window.location.replace('management.html');
        } else if (hasPermission('view_reports') || hasPermission('view_audit') || hasPermission('view_health')) {
            window.location.replace('reports.html');
        } else {
            window.location.replace('user-settings.html');
        }
        return;
    }

    try {
        sessionStorage.setItem('routario_prev_page', window.location.pathname);
        window.addEventListener('beforeunload', () => {
            sessionStorage.setItem('routario_prev_page', window.location.pathname);
        });
    } catch (_) {}

    // Hide elements the current user has no permission to access
    if (!hasPermission('manage_geofences')) {
        document.getElementById('drawGeofenceBtn')?.style.setProperty('display', 'none', 'important');
    }
    if (!hasPermission('view_reports') && !hasPermission('view_audit')) {
        document.getElementById('dashReportsLink')?.remove();
    }
    if (!hasPermission('view_management')) {
        document.getElementById('dashManagementLink')?.remove();
    }
    if (hasPermission('view_management') && hasPermission('manage_routes')) {
        document.getElementById('dashboardRoutesBtn')?.style.removeProperty('display');
        loadDashboardRoutes({ force: true });
    }

    // Restore saved sort (fixes the bug where sort was highlighted but not active)
    const savedSort = localStorage.getItem('vehicleSortMode') || 'name';
    currentSort = savedSort;
    const sel = document.getElementById('sortSelect');
    if (sel) sel.value = savedSort;

    initMap();
    await loadDevices();
    connectWebSocket();
    await loadAlerts(); // Load alerts immediately on startup
    if (typeof handlePendingAlertFromUrl === 'function') {
        handlePendingAlertFromUrl();
    }
    startPeriodicUpdate();


    // Start local time update interval (every 60s) for "time ago"
    setInterval(updateSidebarTimes, 60000);

    initHeaderToolsResponsive();
});

function syncHeaderToolsPlacement() {
    const header = document.querySelector('.header');
    const quickTools = document.getElementById('headerQuickTools');
    const menuSlot = document.getElementById('headerMenuToolsSlot');
    const alertsBtn = document.getElementById('alertsBtn');
    const menuWrap = document.querySelector('.header-menu-wrap');
    if (!header || !quickTools || !menuSlot) return;

    const toolIds = ['dashVoicePttBtn', 'dashboardRoutesBtn', 'dashboardAiCopilotWrap'];
    const tools = toolIds.map(id => document.getElementById(id)).filter(Boolean);
    if (!tools.length) return;

    // Move all 3 into headerQuickTools temporarily to measure exact fit
    tools.forEach(btn => quickTools.appendChild(btn));

    const headerStyle = getComputedStyle(header);
    const padX = (parseFloat(headerStyle.paddingLeft) || 0) + (parseFloat(headerStyle.paddingRight) || 0);
    const leftGroup = header.firstElementChild;
    const actionsGroup = quickTools.parentElement;
    const leftRect = leftGroup ? leftGroup.getBoundingClientRect() : null;
    const actionsRect = actionsGroup ? actionsGroup.getBoundingClientRect() : null;
    const leftWidth = leftRect ? leftRect.width : 0;
    const alertsWidth = alertsBtn ? alertsBtn.getBoundingClientRect().width : 0;
    const menuWidth = menuWrap ? menuWrap.getBoundingClientRect().width : 0;
    const quickWidth = quickTools.getBoundingClientRect().width;
    const available = header.clientWidth - padX - leftWidth - alertsWidth - menuWidth - 28;
    const collides = Boolean(leftRect && actionsRect && (leftRect.right + 16 > actionsRect.left));
    const overflows = header.scrollWidth > header.clientWidth + 1;

    const divider = document.getElementById('headerMenuToolsDivider');
    const fits = !collides && !overflows && available >= quickWidth;

    if (!fits) {
        tools.forEach(btn => menuSlot.appendChild(btn));
    }
    if (divider) {
        divider.style.display = fits ? 'none' : '';
    }
}

function initHeaderToolsResponsive() {
    syncHeaderToolsPlacement();
    window.addEventListener('resize', syncHeaderToolsPlacement);

    const header = document.querySelector('.header');
    if (header && typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(syncHeaderToolsPlacement).observe(header);
    }

    // Re-evaluate if Routes or AI Copilot becomes visible asynchronously
    ['dashVoicePttBtn', 'dashboardRoutesBtn', 'dashboardAiCopilotWrap'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            new MutationObserver(syncHeaderToolsPlacement).observe(el, { attributes: true, attributeFilter: ['style'] });
        }
    });
}
window.syncHeaderToolsPlacement = syncHeaderToolsPlacement;

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

    if (document.getElementById('aiCopilotModal')?.classList.contains('active')) {
        closeAiCopilotModal();
        return;
    }

    if (document.getElementById('pttModal')?.classList.contains('active')) {
        pttCloseModal();
        return;
    }

    if (document.getElementById('tripEcoModal')?.classList.contains('active')) {
        if (typeof closeTripEcoModal === 'function') {
            closeTripEcoModal();
        } else {
            document.getElementById('tripEcoModal').classList.remove('active');
        }
        return;
    }

    for (const id of modalIds) {
        const modal = document.getElementById(id);
        if (modal?.classList.contains('active')) {
            if (id === 'historyModal' && typeof closeHistoryModal === 'function') {
                closeHistoryModal();
            } else {
                modal.classList.remove('active');
            }
            return;
        }
    }
});

window.addEventListener('routario:devices-updated', () => {
    if (typeof loadDevices === 'function') loadDevices();
});
