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
        devices = await response.json();

        // Load state for each device before rendering, so sort fields
        // (last_update, speed, ignition) are available on the first render.
        for (const device of devices) {
            await loadDeviceState(device.id);
        }

        // Single render after all states are present — sort is now correct
        renderDeviceList();

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
        card.classList.remove('moving', 'idle', 'stopped', 'offline');
        card.classList.add(vs.cls);

        list.appendChild(card);
    });
}

// Helper to generate card content (used for initial render and updates)
function getDeviceCardContent(device, icon) {
    const vs = getVehicleStatus(device);
    const lastSeen = timeAgo(device.last_update);
    const mileage = formatDistance(device.total_odometer);

    const ignBadge = device.ignition_on === true
        ? `<span class="ign-badge on">ON</span>`
        : device.ignition_on === false
        ? `<span class="ign-badge off">OFF</span>`
        : '';

    return `
        <div class="device-header">
            <div class="device-name">${icon} ${device.name}</div>
            <div class="device-meta">
                ${ignBadge}
                <span class="device-status ${vs.cls}" id="status-${device.id}">${vs.label}</span>
            </div>
        </div>
        <div class="device-info">
            <div class="device-info-row">
                <span class="info-label">Last Seen</span>
                <span class="info-value" id="last-seen-${device.id}">${lastSeen}</span>
            </div>
            <div class="device-info-row">
                <span class="info-label">Mileage</span>
                <span class="info-value" id="mileage-${device.id}">${mileage}</span>
            </div>
        </div>
        <div class="device-actions">
            <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); openHistoryModal(${device.id})">🕒 History</button>
            <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); openShareModal(${device.id})" title="Share live location">🔗 Share</button>
        </div>
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
        card.classList.remove('moving', 'idle', 'stopped', 'offline');
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
        }
    });
}

// Select Device
function selectDevice(deviceId, { zoom = true } = {}) {
    selectedDevice = deviceId;
    document.querySelectorAll('.device-card').forEach(card => card.classList.remove('active'));
    const card = document.getElementById(`device-card-${deviceId}`);
    if (card) {
        card.classList.add('active');
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    const marker = markers[deviceId];
    if (marker) {
        if (zoom) map.setView(marker.getLatLng(), 15);
        marker.openPopup();
    }
}

function updateStats() {
    // Simplified stats logic as panel was removed, but keeping function to avoid errors
    const onlineCount = devices.filter(d => d.is_online).length;
}

// Vehicle sidebar status helper
function getVehicleStatus(device) {
    if (!device.is_online)                      return { label: 'Offline', cls: 'offline', key: 0 };
    if (device.ignition_on === false)           return { label: 'Stopped', cls: 'stopped', key: 1 };
    if ((device.last_speed || 0) < 3)           return { label: 'Idling',  cls: 'idle',    key: 2 };
    return                                             { label: 'Moving',  cls: 'moving',  key: 3 };
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
            if (visible) {
                if (!map.hasLayer(marker)) marker.addTo(map);
            } else {
                if (map.hasLayer(marker)) map.removeLayer(marker);
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
        }
        loadAlerts();
    }, 30000); // Every 30 seconds
}

function closeDeviceModal() {
    document.getElementById('deviceModal').classList.remove('active');
}
// ── Location Share ────────────────────────────────────────────────────────────

function openShareModal(deviceId) {
    const device = devices.find(d => d.id === deviceId);
    if (!device) return;

    const modal = document.getElementById('shareModal');
    document.getElementById('shareDeviceName').textContent = device.name;
    modal.dataset.deviceId = deviceId;

    // Reset duration picker
    document.querySelectorAll('.share-duration-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('shareCustomMinutes').value = '';

    modal.classList.add('active');
    loadActiveShareLinks(deviceId);
}

function closeShareModal() {
    document.getElementById('shareModal').classList.remove('active');
}

function selectShareDuration(btn) {
    document.querySelectorAll('.share-duration-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('shareCustomMinutes').value = '';
}

async function generateShareLink() {
    const modal = document.getElementById('shareModal');
    const deviceId = parseInt(modal.dataset.deviceId);
    const activeBtn = document.querySelector('.share-duration-btn.active');
    const customVal = document.getElementById('shareCustomMinutes').value;

    let minutes = activeBtn ? parseInt(activeBtn.dataset.minutes) : parseInt(customVal);
    if (!minutes || minutes < 1) {
        showToast('Please select or enter a duration.', 'warning');
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
        showToast('Link copied to clipboard!', 'success');

        loadActiveShareLinks(deviceId);
    } catch (e) {
        showToast('Failed to generate share link.', 'error');
    }
}

// §1 buttons — always visible
function openShareInMaps() {
    const modal = document.getElementById('shareModal');
    const deviceId = parseInt(modal.dataset.deviceId);
    const device = devices.find(d => d.id === deviceId);
    if (!device?.last_latitude || !device?.last_longitude) {
        showToast('No location available for this device.', 'warning');
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
        showToast('No location available.', 'warning');
        return;
    }
    const coords = `${device.last_latitude.toFixed(6)}, ${device.last_longitude.toFixed(6)}`;
    navigator.clipboard.writeText(coords).then(() => showToast(`Copied: ${coords}`, 'success'));
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
                           font-size:0.75rem; line-height:1; padding:0;" title="Revoke">✕</button>
            </div>
            <div style="display:flex; gap:0.4rem;">
                <input readonly value="${fullUrl}"
                    style="flex:1; min-width:0; padding:0.3rem 0.5rem; background:var(--bg-secondary);
                           border:1px solid var(--border-color); border-radius:5px;
                           color:var(--text-muted); font-size:0.72rem; font-family:monospace; cursor:text;">
                <button class="btn btn-secondary" style="font-size:0.75rem; padding:0.3rem 0.55rem;"
                    onclick="copyLinkUrl('${fullUrl}', this)" title="Copy">📋</button>
                <button class="btn btn-secondary" style="font-size:0.75rem; padding:0.3rem 0.55rem;"
                    onclick="renewShareLink('${link.token}')" title="Renew timer">🔄</button>
            </div>
        </div>`;
    }).join('');
}

function copyLinkUrl(url, btn) {
    navigator.clipboard.writeText(url).then(() => {
        const orig = btn.textContent;
        btn.textContent = '✅';
        setTimeout(() => btn.textContent = orig, 2000);
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
        showToast(`Link renewed for ${label}`, 'success');
        loadActiveShareLinks(deviceId);
    } catch (e) {
        showToast('Failed to renew link.', 'error');
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
        showToast('Link revoked.', 'success');
    } catch (e) {
        showToast('Failed to revoke link.', 'error');
    }
}
