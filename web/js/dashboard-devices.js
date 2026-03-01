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

        list.appendChild(card);
    });
}

// Helper to generate card content (used for initial render and updates)
function getDeviceCardContent(device, icon) {
    const ignIcon = device.ignition_on ? '🔥' : '🅿️';
    const vs = getVehicleStatus(device);
    const lastSeen = timeAgo(device.last_update);
    const mileage = formatDistance(device.total_odometer);

    return `
        <div class="device-header">
            <div class="device-name">${icon} ${device.name}</div>
            <div class="device-meta">
                <span class="ignition-icon" id="ign-icon-${device.id}">${ignIcon}</span>
                <div class="device-status" id="status-${device.id}" style="font-size:1rem;">
                    ${vs.emoji} ${vs.label}
                </div>
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

        if (selectedDevice === deviceId) {
            card.classList.add('active');
        }
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
    if (!device.is_online) return { emoji: '⚪', label: 'Offline', key: 0 };
    if (!device.ignition_on) return { emoji: '🔴', label: 'Stopped', key: 1 };
    if ((device.last_speed || 0) < 3) return { emoji: '🟠', label: 'Idling', key: 2 };
    return { emoji: '🟢', label: 'Moving', key: 3 };
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