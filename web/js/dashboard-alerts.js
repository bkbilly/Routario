/**
 * dashboard-alerts.js
 * Alert loading, dismissal, toast notifications.
 */

let historyVisible = false;
let historyOffset = 0;
const HISTORY_PAGE_SIZE = 10;

// ── Alert highlight marker (shown when jumping to an alert location) ───────────
let alertHighlightMarker = null;

function _clearAlertHighlight() {
    if (alertHighlightMarker) { map.removeLayer(alertHighlightMarker); alertHighlightMarker = null; }
}

function _placeAlertHighlight(lat, lng, icon, title) {
    _clearAlertHighlight();

    // Emoji pin — use a wrapper div with explicit size so Leaflet anchors correctly
    alertHighlightMarker = L.marker([lat, lng], {
        icon: L.divIcon({
            html: `<span style="
                position: absolute;
                top: 50%; left: 50%;
                transform: translate(-50%, -50%);
                font-size: 1.5rem; line-height: 1;
                display: block;
                filter: drop-shadow(0 2px 6px rgba(0,0,0,0.7));
                animation: alertBounce 0.6s ease-out;">${icon}</span>`,
            className:   '',
            iconSize:    [36, 36],
            iconAnchor:  [18, 18],
            popupAnchor: [0, -22],
        }),
        zIndexOffset: 1000,
    }).addTo(map);

    alertHighlightMarker.bindPopup(
        `<div style="font-size:0.85rem; font-weight:600; white-space:nowrap;">${icon} ${title}</div>`,
        { closeButton: false, offset: [0, -10] }
    ).openPopup();
    map.once('click', _clearAlertHighlight);
}

// ── Main jump-to-alert handler ────────────────────────────────────────────────
async function jumpToAlert(alert) {
    closeAlertsModal();

    const ICON_MAP = {
        speeding: 'mdi-speedometer', geofence_enter: 'mdi-map-marker-check', geofence_exit: 'mdi-map-marker-minus',
        offline: 'mdi-wifi-off', towing: 'mdi-tow-truck', low_battery: 'mdi-battery-low',
        power_cut: 'mdi-power-plug-off', sos: 'mdi-alarm-light', tampering: 'mdi-alert',
    };
    const icon  = `<i class="mdi ${ICON_MAP[alert.alert_type] || 'mdi-bell'}"></i>`;
    const title = alert.alert_type === 'custom' && alert.alert_metadata?.rule_name
        ? alert.alert_metadata.rule_name
        : alert.alert_type.replace(/_/g, ' ').toUpperCase();

    // Offline alerts have no GPS fix — pan to last known position only
    if (alert.alert_type === 'offline' || !alert.latitude || !alert.longitude) {
        const device = devices.find(d => d.id === alert.device_id);
        if (device?.last_latitude && device?.last_longitude) {
            map.setView([device.last_latitude, device.last_longitude], 15);
            _placeAlertHighlight(device.last_latitude, device.last_longitude, icon, `${title} (last known)`);
        } else {
            showAlert({ title: 'No location', message: 'No GPS position available for this alert.', type: 'warning' });
        }
        return;
    }

    historyDeviceId = alert.device_id;

    const alertTime = new Date(alert.created_at.endsWith('Z') ? alert.created_at : alert.created_at + 'Z');
    const startTime = new Date(alertTime.getTime() - 30 * 60 * 1000);
    const endTime   = new Date(alertTime.getTime() + 30 * 60 * 1000);

    await loadHistory(alert.device_id, startTime, endTime);

    // Ensure the sidebar is visible so the history panel can be seen
    const dashboard = document.querySelector('.dashboard');
    if (dashboard.classList.contains('sidebar-hidden')) {
        dashboard.classList.remove('sidebar-hidden');
        setTimeout(() => map.invalidateSize(), 300);
    }

    // Seek slider to the closest point to the alert timestamp
    if (historyData.length) {
        const alertMs = alertTime.getTime();
        let closestIdx = 0, closestDiff = Infinity;
        historyData.forEach((f, idx) => {
            const diff = Math.abs(new Date(f.properties.time).getTime() - alertMs);
            if (diff < closestDiff) { closestDiff = diff; closestIdx = idx; }
        });
        historyIndex = closestIdx;
        stopPlayback();
        updatePlaybackUI();
    }

    // Drop the highlight pin and pan to it
    map.setView([alert.latitude, alert.longitude], 16);
    _placeAlertHighlight(alert.latitude, alert.longitude, icon, title);
}

// ── Build a single alert-item element ────────────────────────────────────────
function _buildAlertItem(alert, { dimmed = false, clickable = true } = {}) {
    const ICON_MAP = {
        speeding:       'mdi-speedometer',
        geofence_enter: 'mdi-map-marker-check',
        geofence_exit:  'mdi-map-marker-minus',
        offline:        'mdi-wifi-off',
        towing:         'mdi-tow-truck',
        low_battery:    'mdi-battery-low',
        power_cut:      'mdi-power-plug-off',
        sos:            'mdi-alarm-light',
        tampering:      'mdi-alert',
    };
    const icon = `<i class="mdi ${ICON_MAP[alert.alert_type] || 'mdi-bell'}"></i>`;

    let title, messageText;
    if (alert.alert_type === 'custom' && alert.alert_metadata?.rule_name) {
        title       = alert.alert_metadata.rule_name;
        messageText = alert.alert_metadata.rule_condition || alert.message;
    } else {
        title       = alert.alert_type.replace(/_/g, ' ').toUpperCase();
        messageText = alert.message;
    }

    const device     = devices.find(d => d.id === alert.device_id);
    const vehicleTag = device
        ? `<span style="
                display:inline-flex; align-items:center; gap:0.3rem;
                background:rgba(59,130,246,0.12); border:1px solid rgba(59,130,246,0.25);
                border-radius:5px; padding:0.15rem 0.5rem;
                font-size:0.7rem; font-weight:600; color:var(--accent-primary);
                margin-bottom:0.3rem;">
            ${(VEHICLE_ICONS[device.vehicle_type] || VEHICLE_ICONS['other']).emoji} ${device.name}
           </span>`
        : '';

    const hasLocation = alert.latitude && alert.longitude;
    const jumpHint = clickable && hasLocation
        ? `<div style="font-size:0.68rem; color:var(--accent-primary); margin-top:0.2rem; opacity:0.8;">
               <i class="mdi mdi-map"></i> Click to view on map
           </div>`
        : '';

    const item = document.createElement('div');
    item.className = `alert-item ${alert.severity}`;
    if (dimmed) item.style.opacity = '0.6';

    if (clickable) {
        item.style.cursor = 'pointer';
        item.title = hasLocation ? 'Click to jump to this alert on the map' : '';
        item.addEventListener('click', (e) => {
            // Don't trigger when clicking the dismiss button
            if (e.target.closest('.alert-dismiss')) return;
            jumpToAlert(alert);
        });
    }

    item.innerHTML = `
        <div class="alert-icon">${icon}</div>
        <div class="alert-content">
            ${vehicleTag}
            <div class="alert-title">${title}</div>
            <div class="alert-message">${messageText}</div>
            <div class="alert-time">${formatDateToLocal(alert.created_at)}</div>
            ${jumpHint}
        </div>
        ${clickable ? `<button class="alert-dismiss" onclick="dismissAlert(${alert.id})"><i class="mdi mdi-close"></i></button>` : ''}
    `;

    return item;
}

// ── Load & render unread alerts ───────────────────────────────────────────────
async function loadAlerts() {
    try {
        const response = await apiFetch(`${API_BASE}/alerts?unread_only=true`);
        loadedAlerts = await response.json();

        const badge = document.getElementById('alertCount');
        if (badge) {
            if (loadedAlerts.length > 0) {
                badge.textContent = loadedAlerts.length > 99 ? '99+' : loadedAlerts.length;
                badge.style.display = 'block';
            } else {
                badge.style.display = 'none';
            }
        }

        const list = document.getElementById('alertsList');
        list.innerHTML = '';

        if (loadedAlerts.length === 0) {
            list.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-muted);">No alerts</div>';
            applyDeviceAlertHighlights();
            return;
        }

        loadedAlerts.forEach(alert => list.appendChild(_buildAlertItem(alert)));
        applyDeviceAlertHighlights();
    } catch (error) {
        console.error('Error loading alerts:', error);
    }
}

function applyDeviceAlertHighlights() {
    const alertCountByDevice = {};
    loadedAlerts.forEach(a => {
        if (a.device_id != null) {
            alertCountByDevice[a.device_id] = (alertCountByDevice[a.device_id] || 0) + 1;
        }
    });

    document.querySelectorAll('.device-card').forEach(card => {
        const deviceId = parseInt(card.id.replace('device-card-', ''));
        const count    = alertCountByDevice[deviceId] || 0;
        card.classList.toggle('has-alert', count > 0);

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

function openAlertsModal() {
    historyVisible = false;
    historyOffset  = 0;
    document.getElementById('alertsHistorySection').style.display = 'none';
    document.getElementById('alertHistoryToggleBtn').innerHTML  = '<i class="mdi mdi-history"></i> History';
    document.getElementById('alertsHistoryList').innerHTML        = '';
    loadAlerts();
    document.getElementById('alertsModal').classList.add('active');
}

function closeAlertsModal() {
    document.getElementById('alertsModal').classList.remove('active');
}

async function dismissAlert(alertId) {
    try {
        const res = await apiFetch(`${API_BASE}/alerts/${alertId}/read`, { method: 'POST' });
        if (res.ok) {
            await loadAlerts();
            devices.forEach(d => updateSidebarCard(d.id));
        }
    } catch (e) {}
}

async function clearAllAlerts() {
    if (loadedAlerts.length === 0) return;
    if (!confirm('Mark all alerts as read?')) return;

    for (const alert of loadedAlerts) {
        try {
            await apiFetch(`${API_BASE}/alerts/${alert.id}/read`, { method: 'POST' });
        } catch (e) {
            console.error('Failed to clear alert', alert.id, e);
        }
    }

    await loadAlerts();
    devices.forEach(d => updateSidebarCard(d.id));
    showAlert({ title: 'Success', message: 'All alerts cleared', type: 'success' });
}

// ── Alert History (cleared alerts) ───────────────────────────────────────────
async function toggleAlertHistory() {
    historyVisible = !historyVisible;
    const section = document.getElementById('alertsHistorySection');
    const btn     = document.getElementById('alertHistoryToggleBtn');
    section.style.display = historyVisible ? 'block' : 'none';
    btn.innerHTML       = historyVisible ? '<i class="mdi mdi-close"></i> Hide History' : '<i class="mdi mdi-history"></i> History';
    if (historyVisible) {
        historyOffset = 0;
        document.getElementById('alertsHistoryList').innerHTML = '';
        await loadAlertHistory();
    }
}

async function loadAlertHistory() {
    try {
        const response = await apiFetch(
            `${API_BASE}/alerts?read_only=true&limit=${HISTORY_PAGE_SIZE + 1}&offset=${historyOffset}`
        );
        const alerts  = await response.json();
        const hasMore = alerts.length > HISTORY_PAGE_SIZE;
        const toShow  = alerts.slice(0, HISTORY_PAGE_SIZE);

        const list = document.getElementById('alertsHistoryList');
        if (historyOffset === 0 && toShow.length === 0) {
            list.innerHTML = '<div style="text-align:center; padding: 1.5rem; color: var(--text-muted); font-size: 0.875rem;">No cleared alerts yet.</div>';
        } else {
            toShow.forEach(alert => list.appendChild(_buildAlertItem(alert, { dimmed: true })));
        }

        historyOffset += toShow.length;
        document.getElementById('alertsHistoryLoadMore').style.display = hasMore ? 'block' : 'none';
    } catch (e) {
        console.error('Failed to load alert history:', e);
    }
}

async function loadMoreAlertHistory() {
    await loadAlertHistory();
}

// ── Toast / Generic Alert ─────────────────────────────────────────────────────
function showAlert(data) {
    const message = typeof data === 'string' ? data : data.message;
    const title   = data.title || 'Notification';
    const type    = data.type  || 'info';

    const container = document.getElementById('toastContainer');
    const toast     = document.createElement('div');
    toast.className = `toast`;

    const icons = { success: 'mdi-check', error: 'mdi-close', warning: 'mdi-alert', info: 'mdi-information' };
    toast.innerHTML = `
        <div class="toast-icon"><i class="mdi ${icons[type] || 'mdi-information'}"></i></div>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            <div class="toast-message">${message}</div>
        </div>
        <button class="toast-close" onclick="this.closest('.toast').remove()" style="background:none;border:none;color:var(--text-muted);cursor:pointer;padding:0 0 0 0.5rem;font-size:1rem;line-height:1;flex-shrink:0;"><i class="mdi mdi-close"></i></button>
    `;

    container.appendChild(toast);
    const duration = (typeof data === 'object' && data.duration) ? data.duration : 3000;
    setTimeout(() => {
        if (!toast.isConnected) return;
        toast.style.animation = 'slideInRight 0.3s reverse forwards';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}
