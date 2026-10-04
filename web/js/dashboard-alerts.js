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

// ── Main jump-to-alert handler ────────────────────────────────────────────────
async function jumpToAlert(alert) {
    closeAlertsModal();

    const icon  = typeof getAlertIconHtml === 'function' ? getAlertIconHtml(alert) : '<i class="mdi mdi-bell"></i>';
    const title = typeof getAlertDisplayTitle === 'function' ? getAlertDisplayTitle(alert) : (alert.alert_type ? alert.alert_type.replace(/_/g, ' ').toUpperCase() : 'Alert');

    // Offline alerts have no GPS fix — pan to last known position only
    if (alert.alert_type === 'offline' || !alert.latitude || !alert.longitude) {
        const device = devices.find(d => d.id === alert.device_id);
        if (device?.last_latitude && device?.last_longitude) {
            map.setView(applyLatLngOffset([device.last_latitude, device.last_longitude], 15), 15);
            _placeAlertHighlight(device.last_latitude, device.last_longitude, alert, icon, `${title} (last known)`);
        } else {
            showAlert({ title: 'No location', message: 'No GPS position available for this alert.', type: 'warning' });
        }
        return;
    }

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
            const t = f.properties.time;
            const diff = Math.abs(new Date(t.endsWith('Z') ? t : t + 'Z').getTime() - alertMs);
            if (diff < closestDiff) { closestDiff = diff; closestIdx = idx; }
        });
        historyIndex = closestIdx;
        stopPlayback();
        updatePlaybackUI();
    }

    // Drop the highlight pin and pan to it
    map.setView(applyLatLngOffset([alert.latitude, alert.longitude], 16), 16);
    _placeAlertHighlight(alert.latitude, alert.longitude, alert, icon, title);
}

// ── Build a single alert-item element ────────────────────────────────────────
function _buildAlertItem(alert, { dimmed = false, clickable = true, dismissable = true } = {}) {
    const icon = typeof getAlertIconHtml === 'function' ? getAlertIconHtml(alert) : '<i class="mdi mdi-bell"></i>';
    const title = typeof getAlertDisplayTitle === 'function' ? getAlertDisplayTitle(alert) : (alert.alert_type ? alert.alert_type.replace(/_/g, ' ').toUpperCase() : 'Alert');
    const messageText = alert.alert_metadata?.rule_condition || alert.message;

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
    item.dataset.alertId = String(alert.id);
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

    const channelStatusList = alert.alert_metadata?.channel_status || alert.channel_status || [];
    const channelStatusHtml = Array.isArray(channelStatusList) && channelStatusList.length > 0
        ? `<div class="alert-channels-status" style="display:flex;flex-wrap:wrap;gap:0.3rem;margin-top:0.3rem;">
            ${channelStatusList.map(ch => {
                const isOk = ch.status === 'sent' || ch.status === 'delivered' || ch.status === 'success';
                const icon = isOk ? 'mdi-check-circle' : 'mdi-alert-circle';
                const color = isOk ? '#10b981' : '#ef4444';
                const titleText = ch.error ? `${ch.name}: Failed (${ch.error})` : `${ch.name}: ${ch.status}`;
                return `<span title="${_esc(titleText)}" style="display:inline-flex;align-items:center;gap:0.25rem;font-size:0.68rem;padding:0.1rem 0.35rem;border-radius:4px;background:rgba(255,255,255,0.06);color:${color};font-weight:600;"><i class="mdi ${icon}"></i>${_esc(ch.name)}</span>`;
            }).join('')}
           </div>`
        : '';

    item.innerHTML = `
        <div class="alert-icon">${icon}</div>
        <div class="alert-content">
            ${vehicleTag}
            <div class="alert-title">${title}</div>
            <div class="alert-message">${messageText}</div>
            ${channelStatusHtml}
            <div class="alert-time">${formatDateToLocal(alert.created_at)}</div>
            ${jumpHint}
        </div>
        ${dismissable ? `<button class="alert-dismiss" onclick="dismissAlert(${alert.id})"><i class="mdi mdi-close"></i></button>` : ''}
    `;

    return item;
}

// ── Alert button state and icon management ─────────────────────────────────────
function updateAlertsButtonState(count, hasCritical = false) {
    const btn = document.getElementById('alertsBtn');
    const badge = document.getElementById('alertCount');
    let icon = document.getElementById('alertsBtnIcon');

    if (!icon && btn) {
        const existingIcon = btn.querySelector('i, svg');
        if (existingIcon && existingIcon.id !== 'alertCount') {
            if (existingIcon.tagName.toLowerCase() === 'svg') {
                const newI = document.createElement('i');
                newI.id = 'alertsBtnIcon';
                newI.style.fontSize = '16px';
                btn.replaceChild(newI, existingIcon);
                icon = newI;
            } else {
                existingIcon.id = 'alertsBtnIcon';
                icon = existingIcon;
            }
        } else {
            const newI = document.createElement('i');
            newI.id = 'alertsBtnIcon';
            newI.style.fontSize = '16px';
            btn.insertBefore(newI, btn.firstChild);
            icon = newI;
        }
    }

    const numCount = parseInt(count, 10) || 0;

    if (badge) {
        if (numCount > 0) {
            badge.textContent = numCount > 99 ? '99+' : String(numCount);
            badge.style.setProperty('display', 'inline-flex', 'important');
            badge.classList.add('visible');
        } else {
            badge.textContent = '0';
            badge.style.setProperty('display', 'none', 'important');
            badge.classList.remove('visible');
        }
    }

    if (btn) {
        if (numCount > 0) {
            btn.classList.add('has-alerts');
            if (hasCritical) {
                btn.classList.add('has-critical-alerts');
            } else {
                btn.classList.remove('has-critical-alerts');
            }
        } else {
            btn.classList.remove('has-alerts', 'has-critical-alerts');
        }
    }

    if (icon) {
        if (numCount > 0) {
            icon.className = hasCritical
                ? 'mdi mdi-bell-alert'
                : 'mdi mdi-bell-ring';
        } else {
            icon.className = 'mdi mdi-bell-outline';
        }
        icon.style.removeProperty('color');
    }
}
window.updateAlertsButtonState = updateAlertsButtonState;

// ── Load & render unread alerts ───────────────────────────────────────────────
async function loadAlerts() {
    try {
        const response = await apiFetch(`${API_BASE}/alerts?unread_only=true&_t=${Date.now()}`);
        loadedAlerts = await response.json();
        window.loadedAlerts = loadedAlerts;

        const hasCritical = Array.isArray(loadedAlerts) && loadedAlerts.some(a => a.severity === 'critical' || a.severity === 'high');
        updateAlertsButtonState(loadedAlerts.length, hasCritical);

        const list = document.getElementById('alertsList');
        if (list) {
            list.innerHTML = '';
            if (loadedAlerts.length === 0) {
                list.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-muted);">No alerts</div>';
                applyDeviceAlertHighlights();
                return;
            }

            loadedAlerts.forEach(alert => list.appendChild(_buildAlertItem(alert)));
        }
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
        if (typeof handleAlertDismissedLocally === 'function') {
            handleAlertDismissedLocally(alertId, true);
        }
        const res = await apiFetch(`${API_BASE}/alerts/${alertId}/read`, { method: 'POST' });
        if (res.ok) {
            if (typeof handleAlertDismissedLocally === 'function') {
                handleAlertDismissedLocally(alertId, true);
            } else {
                await loadAlerts();
            }
            if (historyVisible) {
                historyOffset = 0;
                const list = document.getElementById('alertsHistoryList');
                if (list) list.innerHTML = '';
                await loadAlertHistory();
            }
            devices.forEach(d => updateSidebarCard(d.id));
        }
    } catch (e) {}
}

async function clearAllAlerts() {
    if (!loadedAlerts || loadedAlerts.length === 0) return;
    if (!confirm('Mark all alerts as read?')) return;

    if (typeof handleAlertsClearedLocally === 'function') {
        handleAlertsClearedLocally(true);
    }

    try {
        await apiFetch(`${API_BASE}/alerts/read-all`, { method: 'POST' });
    } catch (_) {
        await Promise.all(loadedAlerts.map(alert =>
            apiFetch(`${API_BASE}/alerts/${alert.id}/read`, { method: 'POST' })
                .catch(e => console.error('Failed to clear alert', alert.id, e))
        ));
    }

    if (typeof handleAlertsClearedLocally === 'function') {
        handleAlertsClearedLocally(true);
    } else {
        await loadAlerts();
    }

    if (historyVisible) {
        historyOffset = 0;
        const list = document.getElementById('alertsHistoryList');
        if (list) list.innerHTML = '';
        await loadAlertHistory();
    }
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
        document.getElementById('alertsHistoryList').innerHTML = '<div style="text-align:center; padding: 1.5rem; color: var(--text-muted); font-size: 0.85rem;"><i class="mdi mdi-loading mdi-spin" style="font-size:1.2rem; color:var(--accent-primary); margin-right:0.3rem; vertical-align:middle;"></i> Loading alert history…</div>';
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
        if (historyOffset === 0) list.innerHTML = '';
        if (historyOffset === 0 && toShow.length === 0) {
            list.innerHTML = '<div style="text-align:center; padding: 1.5rem; color: var(--text-muted); font-size: 0.875rem;">No cleared alerts yet.</div>';
        } else {
            toShow.forEach(alert => list.appendChild(_buildAlertItem(alert, { dimmed: true, dismissable: false })));
        }

        historyOffset += toShow.length;
        document.getElementById('alertsHistoryLoadMore').style.display = hasMore ? 'block' : 'none';
    } catch (e) {
        console.error('Failed to load alert history:', e);
    }
}

async function loadMoreAlertHistory() {
    const btn = document.querySelector('#alertsHistoryLoadMore button');
    const origHtml = btn ? btn.innerHTML : 'Load More';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i> Loading...';
    }
    try {
        await loadAlertHistory();
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = origHtml;
        }
    }
}

// ── Toast / Generic Alert ─────────────────────────────────────────────────────
