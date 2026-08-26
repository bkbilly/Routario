/**
 * dashboard-devices.js
 * Device loading, sidebar rendering, sorting, and stats.
 */

// Load Devices
async function loadDevices() {
    try {
        const userId = localStorage.getItem('user_id');
        const response = await apiFetch(`${API_BASE}/devices?_t=${Date.now()}`);
        if (!response.ok) {
            if (response.status === 401) {
                handleLogout(); // Token invalid
                return;
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        // Flatten device.state into the device object so sort fields
        // (last_update, speed, ignition) are available on the first render.
        devices = (await response.json()).map(d => {
            const { state, ...rest } = d;
            return { ...rest, ...(state || {}) };
        });

        // Single render after all states are present — sort is now correct
        renderDeviceList();
        devices.forEach(device => updateDeviceMarker(device.id, device));

        updateStats();
        fitMapToMarkers();
    } catch (error) {
        console.error('Error loading devices:', error);
        showAlert({ title: 'Connection Failed', message: 'Unable to connect to the server.' });
    }
}

// Load Device State
async function loadDeviceState(deviceId) {
    try {
        const response = await apiFetch(`${API_BASE}/devices/${deviceId}/state`);
        if (response.ok) {
            const state = await response.json();

            // Merge state into device object
            const deviceIndex = devices.findIndex(d => d.id === deviceId);
            if (deviceIndex !== -1) {
                devices[deviceIndex] = { ...devices[deviceIndex], ...state };
                updateDeviceMarker(deviceId, devices[deviceIndex]);
                updateSidebarCard(deviceId); // Update sidebar immediately
            }
        }
    } catch (error) {
        console.error(`Error loading state for device ${deviceId}:`, error);
    }
}

function _sidebarCurrentOdometer(device, fallback = 0) {
    const value = device?.state?.total_odometer ?? device?.total_odometer ?? fallback;
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function _sidebarMaintenanceDays(days) {
    if (days === 1) return '1 day';
    if (days < 7) return `${days} days`;
    if (days < 30) {
        const weeks = Math.round(days / 7);
        return weeks === 1 ? '1 week' : `${weeks} weeks`;
    }
    const months = Math.round(days / 30);
    return months === 1 ? '1 month' : `${months} months`;
}

function _sidebarMaintenanceLabel(params) {
    return params.custom_label || (params.maintenance_type || 'service')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
}

function _sidebarMaintenanceItems(device) {
    const rows = Array.isArray(device?.config?.alert_rows) ? device.config.alert_rows : [];
    const odometer = _sidebarCurrentOdometer(device, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return rows
        .filter(row => row.alertKey === 'maintenance_alert')
        .flatMap(row => {
            const p = row.params || {};
            const mode = p.tracking_mode || 'km';
            const label = _sidebarMaintenanceLabel(p);
            const items = [];

            if (mode === 'km' || mode === 'both') {
                const nextKm = Number(p.next_service_km || 0);
                const warningKm = Number(p.warning_km || 500);
                if (Number.isFinite(nextKm)) {
                    const remaining = Math.round(nextKm - odometer);
                    if (remaining <= Math.max(0, warningKm || 0)) {
                        items.push({
                            label,
                            status: remaining <= 0 ? 'due' : 'warn',
                            sort: remaining <= 0 ? remaining : remaining + 1000000,
                            text: remaining < 0
                                ? `${Math.abs(remaining).toLocaleString()} km late`
                                : remaining === 0
                                    ? 'now'
                                    : `in ${remaining.toLocaleString()} km`,
                        });
                    }
                }
            }

            if (mode === 'days' || mode === 'both') {
                const nextDate = p.next_service_date ? new Date(p.next_service_date) : null;
                const warningDays = parseInt(p.warning_days || 14, 10);
                if (nextDate && !Number.isNaN(nextDate.getTime())) {
                    nextDate.setHours(0, 0, 0, 0);
                    const daysLeft = Math.round((nextDate - today) / 86400000);
                    if (daysLeft <= Math.max(0, warningDays || 0)) {
                        items.push({
                            label,
                            status: daysLeft <= 0 ? 'due' : 'warn',
                            sort: daysLeft <= 0 ? daysLeft : daysLeft + 1000000,
                            text: daysLeft < 0
                                ? `${_sidebarMaintenanceDays(Math.abs(daysLeft))} late`
                                : daysLeft === 0
                                    ? 'today'
                                    : `in ${_sidebarMaintenanceDays(daysLeft)}`,
                        });
                    }
                }
            }

            return items;
        })
        .sort((a, b) => a.sort - b.sort);
}

function _sidebarMaintenanceHtml(device) {
    const items = _sidebarMaintenanceItems(device);
    if (!items.length) return '';

    const visible = items.slice(0, 2).map(item => `
        <span class="maintenance-pill ${item.status}" title="${_esc(item.label)}: ${_esc(item.text)}">
            <i class="mdi mdi-wrench"></i>
            <span>${_esc(item.label)}: ${_esc(item.text)}</span>
        </span>`).join('');
    const extra = items.length > 2
        ? `<span class="maintenance-pill more">+${items.length - 2} more</span>`
        : '';

    return `
        <div class="device-info-row device-maintenance-row">
            <span class="info-label">Maintenance</span>
            <span class="info-value device-maintenance-list">${visible}${extra}</span>
        </div>`;
}

// Render Device List
function renderDeviceList() {
    // Clear search when re-rendering (optional, but good UX)
    const searchInput = document.getElementById('deviceSearchInput');
    if (searchInput) {
        searchInput.value = '';
    }

    const list = document.getElementById('deviceList');
    list.innerHTML = '';

    if (devices.length === 0) {
        list.innerHTML = '<div style="padding: 1rem; color: var(--text-muted); text-align: center;">No devices assigned to this user.</div>';
        return;
    }

    getSortedDevices().forEach(device => {
        const card = document.createElement('div');
        card.className = 'device-card';
        card.id = `device-card-${device.id}`; // Add ID for easier updates
        card.onclick = () => selectDevice(device.id);

        const vehicleIcon = (VEHICLE_ICONS[device?.vehicle_type] || VEHICLE_ICONS['other']).emoji;

        card.innerHTML = getDeviceCardContent(device, vehicleIcon);
        const vs = getVehicleStatus(device);
        card.classList.remove('moving', 'idle', 'stopped', 'offline', 'pending');
        card.classList.add(vs.cls);

        list.appendChild(card);
    });
}

// Helper to generate card content (used for initial render and updates)
function getDeviceCardContent(device, icon) {
    const vs = getVehicleStatus(device);
    const lastSeen = timeAgo(device.last_update);
    const maintenanceHtml = _sidebarMaintenanceHtml(device);

    // Full datetime string for tooltip on Last Seen
    const lastSeenFull = device.last_update ? formatDateToLocal(device.last_update) : 'Never';

    const ignitionOn  = device.ignition_on === true;
    const ignitionOff = device.ignition_on === false;

    // Tooltip text for ignition badge
    const ignTooltip = ignitionOn
        ? 'Ignition is ON — engine running'
        : 'Ignition is OFF — engine stopped';

    // Tooltip text for status badge
    const statusTooltipMap = {
        moving:  'Vehicle is moving',
        idle:    'Engine on but not moving',
        stopped: 'Engine off, vehicle parked',
        offline: `No data received for over ${device.config?.offline_timeout_hours ?? 24}h`,
    };
    const statusTooltip = statusTooltipMap[vs.cls] || vs.label;

    const ignBadge = ignitionOn
        ? `<span class="ign-badge on" title="${ignTooltip}">ON</span>`
        : ignitionOff
        ? `<span class="ign-badge off" title="${ignTooltip}">OFF</span>`
        : '';

    return `
        <div class="device-header">
            <div class="device-name">${icon} ${device.name}</div>
            <div class="device-meta">
                ${ignBadge}
                <span class="device-status ${vs.cls}" id="status-${device.id}"
                      title="${statusTooltip}">${vs.label}</span>
            </div>
        </div>
        <div class="device-info">
            <div class="device-info-row">
                <span class="info-label">Last Seen</span>
                <span class="info-value" id="last-seen-${device.id}"
                      title="${lastSeenFull}">${lastSeen}</span>
            </div>
            ${device.current_driver_name ? `
            <div class="device-info-row">
                <span class="info-label">Driver</span>
                <span class="info-value"><i class="mdi mdi-account" style="font-size:0.8rem;"></i> ${device.current_driver_name}</span>
            </div>` : ''}
            <div class="device-info-row">
                <span class="info-label">IMEI</span>
                <span class="info-value" id="imei-${device.id}" style="font-family:var(--font-mono);font-size:0.72rem;">${device.imei || '—'}</span>
            </div>
            ${maintenanceHtml}
        </div>
        ${vs.cls !== 'pending' ? `
        <div class="device-actions">
            ${(hasPermission('manage_logbook') || hasPermission('manage_fuel') || hasPermission('manage_maintenance')) ? `<button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); openLogbookModal(${device.id})" title="Service logbook"><i class="mdi mdi-clipboard-list"></i> Logbook</button>` : ''}
            ${hasPermission('live_share') ? `<button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); openShareModal(${device.id})" title="Share live location"><i class="mdi mdi-share"></i> Share</button>` : ''}
            ${hasPermission('view_history') ? `<button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); openHistoryModal(${device.id})"><i class="mdi mdi-history"></i> History</button>` : ''}
        </div>` : ''}
    `;
}

function updateSidebarCard(deviceId) {
    const device = devices.find(d => d.id === deviceId);
    if (!device) return;

    const card = document.getElementById(`device-card-${deviceId}`);
    if (card) {
        const vehicleIcon = (VEHICLE_ICONS[device?.vehicle_type] || VEHICLE_ICONS['other']).emoji;
        card.innerHTML = getDeviceCardContent(device, vehicleIcon);

        if (selectedDevice === deviceId) card.classList.add('active');

        // Stamp status class so ::before colour matches vehicle state
        const vs = getVehicleStatus(device);
        card.classList.remove('moving', 'idle', 'stopped', 'offline', 'pending');
        card.classList.add(vs.cls);
    }
    applyDeviceAlertHighlights();
}

// Function to update just the times in the sidebar (called every minute)
function updateSidebarTimes() {
    getSortedDevices().forEach(device => {
        const el = document.getElementById(`last-seen-${device.id}`);
        if (el && device.last_update) {
            el.textContent = timeAgo(device.last_update);
            // Keep tooltip in sync too
            el.title = formatDateToLocal(device.last_update);
        }

        // Re-evaluate offline status every minute
        const statusEl = document.getElementById(`status-${device.id}`);
        if (statusEl) {
            const vs = getVehicleStatus(device);
            statusEl.textContent  = vs.label;
            statusEl.className    = `device-status ${vs.cls}`;

            const statusTooltipMap = {
                moving:  'Vehicle is moving',
                idle:    'Engine on but not moving',
                stopped: 'Engine off, vehicle parked',
                offline: `No data received for over ${device.config?.offline_timeout_hours ?? 24}h`,
            };
            statusEl.title = statusTooltipMap[vs.cls] || vs.label;

            const card = document.getElementById(`device-card-${device.id}`);
            if (card) {
                card.classList.remove('moving', 'idle', 'stopped', 'offline', 'pending');
                card.classList.add(vs.cls);
            }
        }
    });

    if (clusterGroup && typeof clusterGroup.refreshClusters === 'function') {
        try { clusterGroup.refreshClusters(); } catch (_) {}
    }
}

// Select Device
async function selectDevice(deviceId, { zoom = true } = {}) {
    selectedDevice = deviceId;
    let assignedRoute = null;
    if (typeof onDashboardDeviceSelectedForRoutes === 'function') {
        assignedRoute = await onDashboardDeviceSelectedForRoutes(deviceId);
    }
    document.querySelectorAll('.device-card').forEach(card => card.classList.remove('active'));
    const card = document.getElementById(`device-card-${deviceId}`);
    if (card) {
        card.classList.add('active');
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    const device = devices.find(d => d.id === deviceId);
    if (!device?.last_latitude || !device?.last_longitude) {
        map.closePopup();
        const icon = (VEHICLE_ICONS[device?.vehicle_type] || VEHICLE_ICONS['other']).emoji;
        showAlert({ title: `${icon} ${device?.name || 'Device'}`, message: 'No position data yet.', type: 'info' });
        return;
    }

    const marker = markers[deviceId];
    if (marker) {
        if (zoom) {
            const hasActiveRoute = assignedRoute && typeof DASHBOARD_ACTIVE_ROUTE_STATUSES !== 'undefined'
                && DASHBOARD_ACTIVE_ROUTE_STATUSES.has(String(assignedRoute.status || '').toLowerCase());
            if (hasActiveRoute && typeof fitDashboardRouteWithVehicle === 'function') {
                const openPopup = () => marker.openPopup();
                map.once('moveend', openPopup);
                const fitted = fitDashboardRouteWithVehicle(assignedRoute, marker.getLatLng());
                if (fitted) {
                    return;
                }
                map.off('moveend', openPopup);
            }
            const targetZoom = 15;
            const currentZoom = map.getZoom();
            const zoomDelta   = Math.abs(targetZoom - currentZoom);
            map.once('moveend', () => marker.openPopup());
            map.flyTo(applyLatLngOffset(marker.getLatLng(), targetZoom), targetZoom, {
                animate:         true,
                duration:        0.5 + zoomDelta * 0.15,
                easeLinearity:   0.25,
            });
        } else {
            marker.openPopup();
        }
    }
}

function updateStats() {
    // Simplified stats logic as panel was removed, but keeping function to avoid errors
    const onlineCount = devices.filter(d => d.is_online).length;
}

// Vehicle sidebar status helper
function getVehicleStatus(device) {
    if (!device.last_update && !device.last_latitude) return { label: 'Pending', cls: 'pending', key: 0 };

    // Treat as offline if last_update exceeds the configured timeout
    const timeoutHours = device.config?.offline_timeout_hours ?? 24;
    if (device.last_update) {
        const lastSeen = new Date(device.last_update.endsWith('Z') ? device.last_update : device.last_update + 'Z');
        const elapsedHours = (Date.now() - lastSeen.getTime()) / 3600000;
        if (elapsedHours >= timeoutHours) return { label: 'Offline', cls: 'offline', key: 0 };
    } else if (!device.is_online) {
        return { label: 'Offline', cls: 'offline', key: 0 };
    }

    if (device.ignition_on === false) return { label: 'Stopped', cls: 'stopped', key: 1 };
    if ((device.last_speed || 0) >= 3) return { label: 'Moving',  cls: 'moving',  key: 3 };
    if (device.ignition_on === true)   return { label: 'Idling',  cls: 'idle',    key: 2 };
    return                                    { label: 'Stopped', cls: 'stopped', key: 1 };
}

function setSortMode(mode) {
    currentSort = mode;
    localStorage.setItem('vehicleSortMode', mode);
    // Sync the dropdown (handles both programmatic calls and direct user clicks)
    const sel = document.getElementById('sortSelect');
    if (sel && sel.value !== mode) sel.value = mode;
    renderDeviceList();
}

function getSortedDevices() {
    const list = [...devices];
    if (currentSort === 'name') {
        list.sort((a, b) => a.name.localeCompare(b.name));
    } else if (currentSort === 'lastseen') {
        list.sort((a, b) => {
            const ta = a.last_update ? new Date(a.last_update) : new Date(0);
            const tb = b.last_update ? new Date(b.last_update) : new Date(0);
            return tb - ta;
        });
    } else if (currentSort === 'status') {
        list.sort((a, b) => getVehicleStatus(b).key - getVehicleStatus(a).key);
    }
    return list;
}

// Filter devices based on search input
function filterDevices() {
    const searchTerm = document.getElementById('deviceSearchInput').value.toLowerCase().trim();
    const deviceCards = document.querySelectorAll('.device-card');

    deviceCards.forEach(card => {
        const deviceName = card.querySelector('.device-name').textContent.toLowerCase();
        const deviceId = card.id.replace('device-card-', '');
        const device = devices.find(d => d.id == deviceId);

        const searchableText = [
            deviceName,
            device?.imei || '',
            device?.license_plate || ''
        ].join(' ').toLowerCase();

        const visible = !searchTerm || searchableText.includes(searchTerm);

        // ── Sidebar card ──
        card.style.display = visible ? '' : 'none';

        // ── Map marker ──
        if (device && markers[device.id]) {
            const marker = markers[device.id];
            const circle = accuracyCircles[device.id];
            if (visible) {
                if (!clusterGroup.hasLayer(marker)) clusterGroup.addLayer(marker);
                if (circle && !map.hasLayer(circle)) circle.addTo(map);
            } else {
                if (clusterGroup.hasLayer(marker)) clusterGroup.removeLayer(marker);
                if (circle && map.hasLayer(circle)) map.removeLayer(circle);
            }
        }
    });
}

// Toggle Sidebar function
function toggleSidebar() {
    document.querySelector('.dashboard').classList.toggle('sidebar-hidden');
    setTimeout(() => {
        map.invalidateSize();
    }, 300);
}

// Periodic Updates
function startPeriodicUpdate() {
    setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            // Fallback to polling if WebSocket is down
            devices.forEach(device => loadDeviceState(device.id));
            loadAlerts();
        }
    }, 30000); // Every 30 seconds
}

function closeDeviceModal() {
    document.getElementById('deviceModal').classList.remove('active');
}
// ── Location Share ────────────────────────────────────────────────────────────

const SHARE_QUICK_GROUPS = {
    'minutes': [
        { label: '5 min', minutes: 5 },
        { label: '10 min', minutes: 10 },
        { label: '15 min', minutes: 15 },
        { label: '30 min', minutes: 30 },
        { label: '45 min', minutes: 45 },
    ],
    'hours': [
        { label: '1 hour', minutes: 60 },
        { label: '2 hours', minutes: 120 },
        { label: '5 hours', minutes: 300 },
        { label: '8 hours', minutes: 480 },
        { label: '12 hours', minutes: 720 },
    ],
    'days': [
        { label: '1 day', minutes: 1440 },
        { label: '2 days', minutes: 2880 },
        { label: '3 days', minutes: 4320 },
        { label: '5 days', minutes: 7200 },
    ],
    'weeks': [
        { label: '1 week', minutes: 10080 },
        { label: '2 weeks', minutes: 20160 },
        { label: '3 weeks', minutes: 30240 },
        { label: '4 weeks', minutes: 40320 },
        { label: '8 weeks', minutes: 80640 },
    ],
};

function cycleShareGroup(btn, groupKey) {
    const steps = SHARE_QUICK_GROUPS[groupKey];
    if (!steps || !steps.length) return;
    const isActive = btn.classList.contains('active');
    const currentStep = parseInt(btn.dataset.step || '0');
    const step = isActive ? (currentStep + 1) % steps.length : currentStep;
    btn.dataset.step = step;
    btn.textContent = steps[step].label;
    btn.dataset.minutes = steps[step].minutes;

    const input = document.getElementById('shareCustomMinutes');
    if (input) input.value = steps[step].minutes;

    _setActiveShareBtn(btn);
}

function _setActiveShareBtn(btn) {
    document.querySelectorAll('.share-duration-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
}

function openShareModal(deviceId) {
    const device = devices.find(d => d.id === deviceId);
    if (!device) return;

    const modal = document.getElementById('shareModal');
    const icon = (VEHICLE_ICONS[device.vehicle_type] || VEHICLE_ICONS['other']).emoji;
    document.getElementById('shareDeviceName').textContent = `${icon} ${device.name}`;
    modal.dataset.deviceId = deviceId;

    // Reset all cycle buttons to their first option
    document.querySelectorAll('.share-duration-btn[data-group]').forEach(btn => {
        const steps = SHARE_QUICK_GROUPS[btn.dataset.group];
        if (steps && steps.length) {
            btn.dataset.step = '0';
            btn.textContent = steps[0].label;
            btn.dataset.minutes = steps[0].minutes;
        }
    });

    const defaultBtn = document.querySelector('.share-duration-btn[data-group="hours"]');
    if (defaultBtn) {
        _setActiveShareBtn(defaultBtn);
        document.getElementById('shareCustomMinutes').value = defaultBtn.dataset.minutes || '60';
    } else {
        _setActiveShareBtn(null);
        document.getElementById('shareCustomMinutes').value = '';
    }

    modal.classList.add('active');
    loadActiveShareLinks(deviceId);
}

function closeShareModal() {
    document.getElementById('shareModal').classList.remove('active');
}

async function generateShareLink() {
    const modal = document.getElementById('shareModal');
    const deviceId = parseInt(modal.dataset.deviceId);
    const activeBtn = document.querySelector('.share-duration-btn.active');
    const customVal = document.getElementById('shareCustomMinutes').value;

    let minutes = activeBtn ? parseInt(activeBtn.dataset.minutes) : parseInt(customVal);
    if (!minutes || isNaN(minutes) || minutes < 1) {
        showAlert('Please select or enter a duration.', 'warning');
        return;
    }
    if (minutes > 525600) {
        showAlert('Maximum share duration is 1 year (525,600 minutes).', 'warning');
        return;
    }

    modal.dataset.lastDurationMinutes = minutes;

    try {
        const res = await apiFetch(`${API_BASE}/share`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_id: deviceId, duration_minutes: minutes })
        });
        if (!res.ok) throw new Error();
        const data = await res.json();

        const fullUrl = window.location.origin + data.url;

        // Auto-copy the link
        await navigator.clipboard.writeText(fullUrl);
        showAlert('Link copied to clipboard!', 'success');

        loadActiveShareLinks(deviceId);
    } catch (e) {
        showAlert('Failed to generate share link.', 'error');
    }
}

// §1 buttons — always visible
function openShareInMaps() {
    const modal = document.getElementById('shareModal');
    const deviceId = parseInt(modal.dataset.deviceId);
    const device = devices.find(d => d.id === deviceId);
    if (!device?.last_latitude || !device?.last_longitude) {
        showAlert('No location available for this device.', 'warning');
        return;
    }
    const { last_latitude: lat, last_longitude: lng, name } = device;
    const label = encodeURIComponent(name);
    const url = /iPad|iPhone|iPod/.test(navigator.userAgent)
        ? `maps://maps.apple.com/?q=${label}&ll=${lat},${lng}`
        : `https://www.google.com/maps?q=${lat},${lng}`;
    window.open(url, '_blank');
}

function copyShareCoords() {
    const modal = document.getElementById('shareModal');
    const deviceId = parseInt(modal.dataset.deviceId);
    const device = devices.find(d => d.id === deviceId);
    if (!device?.last_latitude) {
        showAlert('No location available.', 'warning');
        return;
    }
    const coords = `${device.last_latitude.toFixed(6)}, ${device.last_longitude.toFixed(6)}`;
    navigator.clipboard.writeText(coords).then(() => showAlert(`Copied: ${coords}`, 'success'));
}

// §3 active links
async function loadActiveShareLinks(deviceId) {
    try {
        const res = await apiFetch(`${API_BASE}/share?device_id=${deviceId}`);
        if (!res.ok) return;
        const links = await res.json();
        renderActiveShareLinks(links);
    } catch (e) {
        console.error('Failed to load active share links', e);
    }
}

function renderActiveShareLinks(links) {
    const container = document.getElementById('shareActiveLinks');
    const list = document.getElementById('shareActiveLinksList');

    if (!links?.length) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'block';
    list.innerHTML = links.map(link => {
        const fullUrl = window.location.origin + link.url;
        const exp = new Date(link.expires_at + 'Z');
        const expiresStr = exp.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

        return `
        <div id="share-row-${link.token}"
             style="background:var(--bg-tertiary); border:1px solid var(--border-color);
                    border-radius:8px; padding:0.6rem 0.75rem; margin-bottom:0.5rem;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.4rem;">
                <span style="font-size:0.75rem; color:var(--text-muted);">Expires ${expiresStr}</span>
                <button onclick="revokeShareLink('${link.token}')"
                    style="background:none; border:none; color:var(--text-muted); cursor:pointer;
                           font-size:0.75rem; line-height:1; padding:0;" title="Revoke"><i class="mdi mdi-close"></i></button>
            </div>
            <div style="display:flex; gap:0.4rem;">
                <input readonly value="${fullUrl}"
                    style="flex:1; min-width:0; padding:0.3rem 0.5rem; background:var(--bg-secondary);
                           border:1px solid var(--border-color); border-radius:5px;
                           color:var(--text-muted); font-size:0.72rem; font-family:monospace; cursor:text;">
                <button class="btn btn-secondary" style="font-size:0.75rem; padding:0.3rem 0.55rem;"
                    onclick="copyLinkUrl('${fullUrl}', this)" title="Copy"><i class="mdi mdi-content-copy"></i></button>
                <button class="btn btn-secondary" style="font-size:0.75rem; padding:0.3rem 0.55rem;"
                    onclick="renewShareLink('${link.token}')" title="Renew timer"><i class="mdi mdi-refresh"></i></button>
            </div>
        </div>`;
    }).join('');
}

function copyLinkUrl(url, btn) {
    navigator.clipboard.writeText(url).then(() => {
        const orig = btn.innerHTML;
        btn.innerHTML = '<i class="mdi mdi-check"></i>';
        setTimeout(() => btn.innerHTML = orig, 2000);
    });
}

async function renewShareLink(token) {
    const modal = document.getElementById('shareModal');
    const deviceId = parseInt(modal.dataset.deviceId);

    const activeBtn = document.querySelector('.share-duration-btn.active');
    const customVal = document.getElementById('shareCustomMinutes').value;
    let minutes = activeBtn ? parseInt(activeBtn.dataset.minutes) : parseInt(customVal);
    if (!minutes || minutes < 1) minutes = parseInt(modal.dataset.lastDurationMinutes || '60');

    try {
        const res = await apiFetch(`${API_BASE}/share/${token}/renew`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ duration_minutes: minutes })
        });
        if (!res.ok) throw new Error();
        const label = minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes}m`;
        showAlert(`Link renewed for ${label}`, 'success');
        loadActiveShareLinks(deviceId);
    } catch (e) {
        showAlert('Failed to renew link.', 'error');
    }
}

async function revokeShareLink(token) {
    const modal = document.getElementById('shareModal');
    const deviceId = parseInt(modal.dataset.deviceId);

    try {
        const res = await apiFetch(`${API_BASE}/share/${token}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        document.getElementById(`share-row-${token}`)?.remove();
        if (!document.getElementById('shareActiveLinksList').children.length) {
            document.getElementById('shareActiveLinks').style.display = 'none';
        }
        showAlert('Link revoked.', 'success');
    } catch (e) {
        showAlert('Failed to revoke link.', 'error');
    }
}
