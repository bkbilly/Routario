/**
 * dashboard-alerts.js
 * Map-specific alert highlight marker, jump-to-alert playback, and sidebar badges.
 * Drawer UI, tabs, filtering, and CRUD are handled by RoutarioAlertsDrawer in ui-utils.js.
 */

let alertHighlightMarker = null;

function _clearAlertHighlight() {
    if (alertHighlightMarker) {
        map.removeLayer(alertHighlightMarker);
        alertHighlightMarker = null;
    }
}

function _placeAlertHighlight(lat, lng, alertObj, iconHtml, title) {
    _clearAlertHighlight();

    alertHighlightMarker = L.marker([lat, lng], {
        icon: L.divIcon({
            html: `<div style="
                width:36px; height:36px;
                display:flex; align-items:center; justify-content:center;
                font-size:1.4rem;
                filter:drop-shadow(0 2px 6px rgba(0,0,0,0.7));
                animation:alertBounce 0.6s ease-out;">${iconHtml}</div>`,
            className: 'custom-marker',
            iconSize:  [36, 36],
            iconAnchor:[18, 18],
        }),
        zIndexOffset: 1000,
    }).addTo(map);

    const device = devices.find(d => d.id === alertObj.device_id);
    const meta   = alertObj.alert_metadata;
    const ts     = alertObj.created_at.endsWith('Z') ? alertObj.created_at : alertObj.created_at + 'Z';
    const dt     = new Date(ts);
    const datePart = typeof formatDateValue === 'function' ? formatDateValue(dt) : dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const timePart = typeof formatTimeValue === 'function' ? formatTimeValue(dt) : dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const rows   = [];
    if (device) rows.push(`<span class="vp-label">Device</span><span class="vp-value">${(VEHICLE_ICONS[device.vehicle_type] || VEHICLE_ICONS['other']).emoji} ${device.name}</span>`);
    rows.push(`<span class="vp-label">Time</span><span class="vp-value vp-mono">${datePart}<br>${timePart}</span>`);
    if (meta?.rule_condition) rows.push(`<span class="vp-label">Condition</span><span class="vp-value vp-mono">${meta.rule_condition}</span>`);
    if (alertObj.address)     rows.push(`<span class="vp-label">Address</span><span class="vp-value">${alertObj.address}</span>`);

    alertHighlightMarker.bindPopup(`
        <div class="vp-popup" style="min-width:180px;">
            <div class="vp-header">
                <span class="vp-icon">${iconHtml}</span>
                <span class="vp-name">${title}</span>
            </div>
            <div class="vp-grid">${rows.join('')}</div>
        </div>`,
        { closeButton: true, maxWidth: 220 }
    ).openPopup();
}

async function jumpToAlert(alert) {
    if (!alert || alert.latitude == null || alert.longitude == null || isNaN(Number(alert.latitude)) || isNaN(Number(alert.longitude))) {
        return;
    }
    if (typeof closeAlertsModal === 'function') closeAlertsModal();

    const icon  = typeof getAlertIconHtml === 'function' ? getAlertIconHtml(alert) : '<i class="mdi mdi-bell"></i>';
    const title = typeof getAlertDisplayTitle === 'function' ? getAlertDisplayTitle(alert) : (alert.alert_type ? alert.alert_type.replace(/_/g, ' ').toUpperCase() : 'Alert');

    const lat = Number(alert.latitude);
    const lng = Number(alert.longitude);

    const alertTime = new Date(alert.created_at.endsWith('Z') ? alert.created_at : alert.created_at + 'Z');
    const startTime = new Date(alertTime.getTime() - 30 * 60 * 1000);
    const endTime   = new Date(alertTime.getTime() + 30 * 60 * 1000);

    if (alert.device_id) {
        await loadHistory(alert.device_id, startTime, endTime);

        const dashboard = document.querySelector('.dashboard');
        if (dashboard && dashboard.classList.contains('sidebar-hidden')) {
            dashboard.classList.remove('sidebar-hidden');
            setTimeout(() => map.invalidateSize(), 300);
        }

        if (historyData.length) {
            const alertMs = alertTime.getTime();
            let closestIdx = 0, closestDiff = Infinity;
            historyData.forEach((f, idx) => {
                const t = f.properties.time;
                const diff = Math.abs(new Date(t.endsWith('Z') ? t : t + 'Z').getTime() - alertMs);
                if (diff < closestDiff) { closestDiff = diff; closestIdx = idx; }
            });
            historyIndex = closestIdx;
            stopPlayback();
            updatePlaybackUI();
        }
    }

    map.setView(applyLatLngOffset([lat, lng], 16), 16);
    _placeAlertHighlight(lat, lng, alert, icon, title);
}

async function handlePendingAlertFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const alertId = params.get('alert');
    if (!alertId) return;

    params.delete('alert');
    const newUrl = window.location.pathname + (params.toString() ? `?${params.toString()}` : '') + window.location.hash;
    window.history.replaceState({}, '', newUrl);

    let target = Array.isArray(window.loadedAlerts) ? window.loadedAlerts.find(a => String(a.id) === String(alertId)) : null;
    if (!target) {
        try {
            const res = await apiFetch(`${API_BASE}/alerts?read_only=true&limit=50`);
            if (res.ok) {
                const hist = await res.json();
                target = Array.isArray(hist) ? hist.find(a => String(a.id) === String(alertId)) : null;
            }
        } catch (_) {}
    }
    if (target) jumpToAlert(target);
}
window.handlePendingAlertFromUrl = handlePendingAlertFromUrl;

function applyDeviceAlertHighlights(alertsList = window.loadedAlerts || []) {
    const alertCountByDevice = {};
    if (Array.isArray(alertsList)) {
        alertsList.forEach(a => {
            if (a.device_id != null) {
                alertCountByDevice[a.device_id] = (alertCountByDevice[a.device_id] || 0) + 1;
            }
        });
    }

    document.querySelectorAll('.device-card').forEach(card => {
        const deviceId = parseInt(card.id.replace('device-card-', ''), 10);
        const count    = alertCountByDevice[deviceId] || 0;

        const infoEl   = card.querySelector('.device-info');
        const existing = card.querySelector('.device-alert-row');
        if (count > 0 && infoEl) {
            const row = existing || document.createElement('div');
            row.className = 'device-info-row device-alert-row';
            row.innerHTML = `<span class="info-label">Alerts</span>
                <span class="info-value device-alert-count">${count > 99 ? '99+' : count} unread</span>`;
            if (!existing) infoEl.appendChild(row);
        } else if (existing) {
            existing.remove();
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    if (window.RoutarioAlertsDrawer) {
        window.RoutarioAlertsDrawer.mount({
            buttonId: 'alertsBtn',
            iconId: 'alertsBtnIcon',
            badgeId: 'alertCount',
            getDevices: () => (typeof devices !== 'undefined' ? devices : []),
            onAlertClick: (alert) => jumpToAlert(alert),
            onAlertsChanged: (list) => {
                applyDeviceAlertHighlights(list);
                if (typeof devices !== 'undefined' && typeof updateSidebarCard === 'function') {
                    devices.forEach(d => updateSidebarCard(d.id));
                }
            },
        });
    }
});
