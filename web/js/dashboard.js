// State
let map = null;
let markers = {};
let polylines = {};
let ws = null;
let devices = [];
let selectedDevice = null;
let historyDeviceId = null;
let playbackInterval = null;
let historyData = [];
let historyTrips = [];
let historyIndex = 0;
let loadedAlerts = [];
let currentUser = null;
const markerAnimations = {};
const markerState = {};
let currentSort = localStorage.getItem('vehicleSortMode') || 'name';
let sensorChart = null;
let selectedSensorAttrs = new Set(['speed']);   // default selection
let currentHistoryTab = 'details';
let currentTileLayer = null;

const SENSOR_COLORS = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
    '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'
];
const tripColors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];


const MAP_TILES = {
    openstreetmap: {
        label: '🗺️ OpenStreetMap',
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19
    },
    google_streets: {
        label: '🛣️ Google Streets',
        url: 'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
        attribution: '© Google Maps',
        maxZoom: 21
    },
    google_satellite: {
        label: '🛰️ Google Satellite',
        url: 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
        attribution: '© Google Maps',
        maxZoom: 21
    },
    google_hybrid: {
        label: '🌍 Google Hybrid',
        url: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
        attribution: '© Google Maps',
        maxZoom: 21
    },
    carto_dark: {
        label: '🌑 Dark Mode',
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        attribution: '© <a href="https://carto.com/">CARTO</a>',
        maxZoom: 19
    },
    carto_light: {
        label: '☀️ Light Mode',
        url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
        attribution: '© <a href="https://carto.com/">CARTO</a>',
        maxZoom: 19
    },
    esri_satellite: {
        label: '🌐 ESRI Satellite',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attribution: '© Esri, Maxar, Earthstar Geographics',
        maxZoom: 19
    }
};



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
    return `${parseFloat(meters).toLocaleString(undefined, {minimumFractionDigits: 1, maximumFractionDigits: 1})} km`;
}

// ── Smooth marker animation ───────────────────────────────────────
function animateMarker(deviceId, marker, fromLat, fromLng, toLat, toLng, fromHeading, toHeading, duration = 800) {
    // Cancel any in-progress animation for this device
    if (markerAnimations[deviceId]) {
        cancelAnimationFrame(markerAnimations[deviceId]);
        delete markerAnimations[deviceId];
    }

    const startTime = performance.now();

    // Shortest-path heading interpolation
    let dH = ((toHeading - fromHeading + 540) % 360) - 180;

    function step(now) {
        const elapsed = now - startTime;
        const t = Math.min(elapsed / duration, 1);
        // Ease in-out cubic
        const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

        const lat = fromLat + (toLat - fromLat) * ease;
        const lng = fromLng + (toLng - fromLng) * ease;
        marker.setLatLng([lat, lng]);

        // Animate heading on the SVG/icon element inside the marker
        const currentHeading = fromHeading + dH * ease;
        const el = marker.getElement();
        if (el) {
            const svg = el.querySelector('svg');
            if (svg) {
                svg.style.transform = `rotate(${currentHeading}deg)`;
            } else {
                const iconDiv = el.querySelector('.marker-icon-inner');
                if (iconDiv) iconDiv.style.transform = `rotate(${currentHeading}deg)`;
            }
        }

        if (t < 1) {
            markerAnimations[deviceId] = requestAnimationFrame(step);
        } else {
            delete markerAnimations[deviceId];
        }
    }

    markerAnimations[deviceId] = requestAnimationFrame(step);
}


// Vehicle sidebar status helper
function getVehicleStatus(device) {
    if (!device.is_online) return { emoji: '⚪', label: 'Offline', key: 0 };
    if (!device.ignition_on) return { emoji: '🔴', label: 'Stopped', key: 1 };
    if ((device.last_speed || 0) < 3) return { emoji: '🟠', label: 'Idling', key: 2 };
    return { emoji: '🟢', label: 'Moving', key: 3 };
}

function getCurrentTripForPoint(isoTimeStr) {
    if (!historyTrips.length || !isoTimeStr) return null;
    const t = new Date(isoTimeStr).getTime();
    return historyTrips.find((trip, i) => {
        const start = new Date(trip.start_time).getTime();
        const end   = trip.end_time ? new Date(trip.end_time).getTime() : Infinity;
        return t >= start && t <= end;
    }) || null;
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
            const count = parseInt(mutation.target.textContent) || 0;
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

// Login Check Function
function checkLogin() {
    const token = localStorage.getItem('auth_token');
    const userId = localStorage.getItem('user_id');
    
    if (!token || !userId) {
        window.location.href = 'login.html';
    } else {
        currentUser = { id: userId };
    }
}

// Logout Function
function handleLogout() {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('user_id');
    localStorage.removeItem('username');
    localStorage.removeItem('is_admin');
    window.location.href = 'login.html';
}

// Initialize Leaflet Map
function initMap() {
    map = L.map('map').setView([20, 0], 2);
    
    const savedTile = localStorage.getItem('mapTileLayer') || 'openstreetmap';
    applyTileLayer(savedTile);
    populateMapPicker();

    // Initialize geofences module
    initGeofences(map);
}


function applyTileLayer(tileKey) {
    const tile = MAP_TILES[tileKey] || MAP_TILES['openstreetmap'];

    if (currentTileLayer) {
        map.removeLayer(currentTileLayer);
    }

    currentTileLayer = L.tileLayer(tile.url, {
        attribution: tile.attribution,
        maxZoom: tile.maxZoom
    }).addTo(map);

    localStorage.setItem('mapTileLayer', tileKey);

    // Update picker UI if open
    document.querySelectorAll('.map-tile-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tile === tileKey);
    });
}

function populateMapPicker() {
    const picker = document.getElementById('mapTilePicker');
    if (!picker) return;
    picker.innerHTML = Object.entries(MAP_TILES).map(([key, tile]) => `
        <button class="map-tile-option" data-tile="${key}" onclick="applyTileLayer('${key}'); toggleMapPicker();"
            style="display: block; width: 100%; text-align: left; background: transparent; border: none;
                   color: var(--text-primary); padding: 0.5rem 0.75rem; border-radius: 6px; cursor: pointer;
                   font-size: 0.85rem; transition: background 0.15s;"
            onmouseover="this.style.background='var(--bg-hover)'"
            onmouseout="this.style.background='transparent'">
            ${tile.label}
        </button>
    `).join('');
}

function toggleMapPicker() {
    const picker = document.getElementById('mapTilePicker');
    picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
}

function closePicker(e) {
    const picker = document.getElementById('mapTilePicker');
    const btn = document.getElementById('mapPickerBtn');
    if (picker && !picker.contains(e.target) && !btn.contains(e.target)) {
        picker.style.display = 'none';
    }
}

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

// Fit map to markers
function fitMapToMarkers() {
    const validMarkers = Object.values(markers).filter(m => m && m.getLatLng);
    if (validMarkers.length === 0) return;  // no markers, stay at world view

    if (validMarkers.length === 1) {
        map.setView(validMarkers[0].getLatLng(), 15);
    } else {
        const group = L.featureGroup(validMarkers);
        map.fitBounds(group.getBounds().pad(0.2));
    }
}

// Load Trips for History Modal
async function loadTripsForHistory(deviceId, startTime, endTime) {
    const container = document.getElementById('tripListContent');
    if (!container) return;
    container.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:0.5rem 0;text-align:center;">Loading trips…</div>';

    try {
        const res = await apiFetch(
            `${API_BASE}/devices/${deviceId}/trips?start_date=${startTime.toISOString()}&end_date=${endTime.toISOString()}`
        );
        if (!res.ok) throw new Error('Failed to fetch trips');
        const trips = await res.json();
        historyTrips = trips;

        if (!trips.length) {
            container.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:0.5rem 0;text-align:center;">No trips detected in this period</div>';
            return;
        }

        container.innerHTML = trips.map((trip, i) => {
            const start = trip.start_time ? formatDateToLocal(trip.start_time) : '—';
            const end   = trip.end_time   ? formatDateToLocal(trip.end_time)   : 'Ongoing';
            const dist  = trip.distance_km != null ? `${trip.distance_km.toFixed(1)} km` : '—';
            const dur   = formatDuration(trip.duration_minutes);
            const from  = trip.start_address || 'Unknown start';
            const to    = trip.end_address   || (trip.end_time ? 'Unknown end' : 'In progress');
            const label = trips.length - i;

            return `
            <div class="trip-card" onclick="seekToTrip('${trip.start_time}')" title="Click to jump to this trip">
                <div class="trip-card-header">
                    <span class="trip-index">Trip ${label}</span>
                    <span class="trip-badges">
                        <span class="trip-badge">📍 ${dist}</span>
                        <span class="trip-badge">⏱ ${dur}</span>
                    </span>
                </div>
                <div class="trip-card-body">
                    <div class="trip-time">${start} → ${end}</div>
                </div>
            </div>`;
        }).join('');

    } catch (e) {
        historyTrips = [];
        container.innerHTML = '<div style="color:var(--accent-danger);font-size:0.8rem;padding:0.5rem 0;">Failed to load trips</div>';
    }
}

function seekToTrip(startTimeStr) {
    if (!historyData.length) return;
    const target = new Date(startTimeStr).getTime();
    let closest = 0;
    let closestDiff = Infinity;
    historyData.forEach((f, idx) => {
        const diff = Math.abs(new Date(f.properties.time).getTime() - target);
        if (diff < closestDiff) { closestDiff = diff; closest = idx; }
    });
    historyIndex = closest;
    stopPlayback();
    updatePlaybackUI();
    map.panTo([
        historyData[closest].geometry.coordinates[1],
        historyData[closest].geometry.coordinates[0]
    ]);
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

// Update Device Marker
function updateDeviceMarker(deviceId, state) {
    if (!state.last_latitude || !state.last_longitude) return;

    const toLat   = state.last_latitude;
    const toLng   = state.last_longitude;
    const toHead  = state.last_course || 0;
    const device  = devices.find(d => d.id === deviceId);
    const deviceName = device ? device.name : 'Unknown Device';

    const vehicle = VEHICLE_ICONS[device?.vehicle_type] || VEHICLE_ICONS['other'];
    const ignitionColor = state.ignition_on ? '#10b981' : '#ef4444';
    const ignitionText  = state.ignition_on ? 'ON' : 'OFF';
    const popupContent = `
        <div class="vp-popup">
            <div class="vp-header">
                <span class="vp-icon">${vehicle.emoji}</span>
                <span class="vp-name">${deviceName}</span>
            </div>
            <div class="vp-grid">
                <span class="vp-label">Plate</span>      <span class="vp-value">${device?.license_plate || '—'}</span>
                <span class="vp-label">Speed</span>      <span class="vp-value">${Number(state.last_speed || 0).toFixed(1)} km/h</span>
                <span class="vp-label">Ignition</span>   <span class="vp-value" style="color:${ignitionColor};font-weight:700;">${ignitionText}</span>
                <span class="vp-label">Satellites</span> <span class="vp-value">${state.satellites || 0}</span>
                <span class="vp-label">Lat/Lng</span>    <span class="vp-value">${toLat.toFixed(5)}, ${toLng.toFixed(5)}</span>
                <span class="vp-label">Altitude</span>   <span class="vp-value">${Math.round(state.last_altitude || 0)} m</span>
                <span class="vp-label">Odometer</span>   <span class="vp-value">${Math.round((state.total_odometer || 0))} km</span>
                <span class="vp-label">IMEI</span>       <span class="vp-value vp-mono">${device?.imei || '—'}</span>
            </div>
        </div>
    `;
    if (!markers[deviceId]) {
        // ── First appearance: create marker, no animation ──
        const icon = L.divIcon({
            html: getMarkerHtml(device?.vehicle_type, state.ignition_on),
            className: 'custom-marker',
            iconSize: [36, 36],
            iconAnchor: [18, 18]
        });
        markers[deviceId] = L.marker([toLat, toLng], { icon })
            .bindPopup(popupContent)
            .addTo(map);

        markers[deviceId].on('click', () => selectDevice(deviceId, { zoom: false }));

        // Set initial rotation immediately
        const el = markers[deviceId].getElement();
        if (el) {
            const svg = el.querySelector('.marker-svg');
            const vehicle = VEHICLE_ICONS[device?.vehicle_type];
            const offset  = (!vehicle || device?.vehicle_type === 'arrow') ? 0 : vehicle.offset;
            if (svg) svg.style.transform = `rotate(${toHead + offset}deg)`;

        }

        markerState[deviceId] = { lat: toLat, lng: toLng, heading: toHead };

    } else {
        // ── Subsequent updates: animate, never call setIcon ──
        markers[deviceId].setPopupContent(popupContent);

        const prev = markerState[deviceId] || { lat: toLat, lng: toLng, heading: toHead };

        // Cancel any running animation
        if (prev.animFrame) cancelAnimationFrame(prev.animFrame);

        const fromLat  = prev.lat;
        const fromLng  = prev.lng;
        const fromHead = prev.heading;

        // Shortest-arc heading delta
        const dH = ((toHead - fromHead + 540) % 360) - 180;

        const duration  = 1000; // ms — tune to match your GPS update interval
        const startTime = performance.now();

        function step(now) {
            const t    = Math.min((now - startTime) / duration, 1);
            // Ease-out cubic
            const ease = 1 - Math.pow(1 - t, 3);

            const lat  = fromLat  + (toLat  - fromLat)  * ease;
            const lng  = fromLng  + (toLng  - fromLng)  * ease;
            const head = fromHead + dH * ease;

            markers[deviceId].setLatLng([lat, lng]);

            // Rotate the inner element directly — no setIcon, no DOM rebuild
            const el = markers[deviceId].getElement();
            if (el) {
                const svg = el.querySelector('.marker-svg');
                if (svg) svg.style.transform = `rotate(${head}deg)`;
            }

            if (t < 1) {
                markerState[deviceId].animFrame = requestAnimationFrame(step);
            } else {
                markerState[deviceId] = { lat: toLat, lng: toLng, heading: toHead, animFrame: null };
            }
        }

        markerState[deviceId] = { lat: fromLat, lng: fromLng, heading: fromHead, animFrame: requestAnimationFrame(step) };
    }

    // Update devices array
    const deviceIndex = devices.findIndex(d => d.id === deviceId);
    if (deviceIndex !== -1) {
        if (!state.hasOwnProperty('is_online') && state.last_latitude) state.is_online = true;
        devices[deviceIndex] = { ...devices[deviceIndex], ...state };
    }
}

// WebSocket Connection
function connectWebSocket() {
    const userId = localStorage.getItem('user_id');
    if (!userId) return;

    // Use static config from config.js
    const wsUrl = `${WS_BASE_URL}${userId}`;
    
    console.log('Connecting to WebSocket:', wsUrl);
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => { 
        console.log('WebSocket connected');
        // document.getElementById('connectionStatus').textContent = 'Connected'; // Element removed from UI
    };
    
    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            handleWebSocketMessage(message);
        } catch (e) {
            console.error('Error parsing WS message:', e);
        }
    };
    
    ws.onerror = (e) => { 
        console.error('WS Error:', e); 
    };
    
    ws.onclose = (e) => { 
        console.log('WebSocket disconnected, reconnecting...', e.reason);
        // document.getElementById('connectionStatus').textContent = 'Disconnected';
        setTimeout(connectWebSocket, 5000); 
    };
}

function handleWebSocketMessage(message) {
    if (message.type === 'position_update') {
        const devIdx = devices.findIndex(d => d.id === message.device_id);
        if (devIdx > -1) {
            devices[devIdx] = { ...devices[devIdx], ...message.data };
            updateDeviceMarker(message.device_id, devices[devIdx]);
            updateSidebarCard(message.device_id);
        }
        updateStats();
    } else if (message.type === 'alert') {
        let title, toastMessage;
        if (message.data.type === 'custom' && message.data.alert_metadata?.rule_name) {
            title        = message.data.alert_metadata.rule_name;
            toastMessage = message.data.alert_metadata.rule_condition || message.data.message;
        } else {
            title        = message.data.type.replace(/_/g, ' ').toUpperCase();
            toastMessage = message.data.message;
        }
        showAlert({ title, message: toastMessage, type: message.data.severity || 'info' });
        loadAlerts();
    }
}

// --- HISTORY FUNCTIONS ---
function openHistoryModal(deviceId) {
    historyDeviceId = deviceId;
    setHistoryRange(24);
    document.getElementById('historyModal').classList.add('active');
}

function closeHistoryModal() { document.getElementById('historyModal').classList.remove('active'); }

function setHistoryRange(hours) {
    const now = new Date();
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
    
    const toLocalISO = (date) => {
        const tzOffset = date.getTimezoneOffset() * 60000;
        return new Date(date.getTime() - tzOffset).toISOString().slice(0, 16);
    };

    document.getElementById('historyStart').value = toLocalISO(start);
    document.getElementById('historyEnd').value = toLocalISO(end);
}

async function handleHistorySubmit(e) {
    e.preventDefault();
    const start = new Date(document.getElementById('historyStart').value);
    const end = new Date(document.getElementById('historyEnd').value);
    await loadHistory(historyDeviceId, start, end);
    closeHistoryModal();
}

async function loadHistory(deviceId, startTime, endTime) {
    if (polylines['history']) {
        polylines['history'].eachLayer(l => map.removeLayer(l));
        delete polylines['history'];
    }
    if (markers['history_pos']) {
        map.removeLayer(markers['history_pos']);
        delete markers['history_pos'];
    }
    stopPlayback();

    // FIXED: Hide live marker for this device when history loads
    if (markers[deviceId]) {
        markers[deviceId].remove();
    }

    try {
        const response = await apiFetch(`${API_BASE}/positions/history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_id: deviceId, start_time: startTime.toISOString(), end_time: endTime.toISOString(), max_points: 2000 })
        });
        const data = await response.json();
        historyData = data.features;
        historyIndex = 0;
        if (historyData.length === 0) { showAlert({ title: 'History', message: 'No data found.', type: 'warning' }); return; }
        document.getElementById('historySlider').max = historyData.length - 1;
        document.getElementById('historySlider').value = 0;

        // Draw trip polylines — each contiguous run of the same trip_id gets its own color.
        // Points between trips (trip_id: null) are drawn as a subtle dashed grey line.
        const allLayers = [];
        let tripColorMap = {};
        let tripColorIdx = 0;
        let currentTripId = undefined;
        let currentSegment = [];

        const flushSegment = () => {
            if (currentSegment.length < 2) { currentSegment = []; return; }
            if (currentTripId) {
                if (!(currentTripId in tripColorMap)) {
                    tripColorMap[currentTripId] = tripColors[tripColorIdx++ % tripColors.length];
                }
                const pl = L.polyline(currentSegment, {
                    color:   tripColorMap[currentTripId],
                    weight:  4,
                    opacity: 0.85,
                }).addTo(map);
                allLayers.push(pl);
            } else {
                const pl = L.polyline(currentSegment, {
                    color:     '#6b7280',
                    weight:    2,
                    opacity:   0.4,
                    dashArray: '4 6',
                }).addTo(map);
                allLayers.push(pl);
            }
            currentSegment = [];
        };

        historyData.forEach(f => {
            const tripId = f.properties?.trip_id ?? null;
            const latlng = [f.geometry.coordinates[1], f.geometry.coordinates[0]];
            if (tripId !== currentTripId) {
                flushSegment();
                currentTripId = tripId;
            }
            currentSegment.push(latlng);
        });
        flushSegment();
        polylines['history'] = L.featureGroup(allLayers);
        map.fitBounds(polylines['history'].getBounds());
        
        // Correcting ID for new separate structure (footer is now separate from sidebar)
        // Actually, we need to show the history footer
        const footer = document.getElementById('historyControls');
        if (footer) footer.style.display = 'flex';
        document.querySelector('.sidebar').classList.add('history-active');
        
        // Hide regular list
        document.getElementById('sidebarDeviceList').style.display = 'none';
        document.getElementById('sidebarNavRow').style.display = 'none';
        document.getElementById('sidebarUserProfile').style.display = 'none';

        // Show History Details section
        document.getElementById('sidebarHistoryDetails').style.display = 'block';
        
        const device = devices.find(d => d.id === deviceId);
        document.getElementById('historyDeviceName').textContent = device ? device.name : 'History Details';
        await loadTripsForHistory(deviceId, startTime, endTime);
        updatePlaybackUI();
    } catch (error) {
        console.log(error);
        showAlert({ title: 'Error', message: 'Failed to load history.', type: 'error' });
    }
}

function exitHistoryMode() {
    stopPlayback();
    if (polylines['history']) {
        polylines['history'].eachLayer(l => map.removeLayer(l));
        delete polylines['history'];
    }

    if (markers['history_pos']) {
        map.removeLayer(markers['history_pos']);
        delete markers['history_pos'];
    }
    if (sensorChart) { sensorChart.destroy(); sensorChart = null; }
    selectedSensorAttrs = new Set(['speed']);
    currentHistoryTab = 'trips';
    switchHistoryTab('trips');
    
    // FIXED: Restore live marker when exiting history mode
    if (markers[historyDeviceId]) {
        markers[historyDeviceId].addTo(map);
    }

    // Hide history footer
    const footer = document.getElementById('historyControls');
    if (footer) footer.style.display = 'none';
    document.querySelector('.sidebar').classList.remove('history-active');

    historyTrips = [];
    const tripLabel = document.getElementById('historyTripLabel');
    if (tripLabel) tripLabel.textContent = '';
    const tripList = document.getElementById('tripListContent');
    if (tripList) tripList.innerHTML = '';
    document.getElementById('sidebarDeviceList').style.display = 'block';
    document.getElementById('sidebarNavRow').style.display = 'flex';
    document.getElementById('sidebarUserProfile').style.display = 'flex';
    document.getElementById('sidebarHistoryDetails').style.display = 'none';
}

function togglePlayback() { if (playbackInterval) stopPlayback(); else startPlayback(); }

function startPlayback() {
    if (historyData.length === 0) return;
    document.getElementById('playbackBtn').textContent = '⏸️';
    if (!markers['history_pos']) createHistoryMarker();
    playbackInterval = setInterval(() => {
        if (historyIndex >= historyData.length - 1) { stopPlayback(); return; }
        historyIndex++;
        updatePlaybackUI();
    }, 100);
}

function stopPlayback() {
    if (playbackInterval) { clearInterval(playbackInterval); playbackInterval = null; document.getElementById('playbackBtn').textContent = '▶️'; }
}

function seekHistory(value) { historyIndex = parseInt(value); stopPlayback(); updatePlaybackUI(); }
function stepHistory(delta) {
    stopPlayback();
    historyIndex = Math.max(0, Math.min(historyData.length - 1, historyIndex + delta));
    updatePlaybackUI();
}

function updatePlaybackUI() {
    if (historyData.length === 0) return;
    const feature = historyData[historyIndex];
    const p = feature.properties;
    const position = [feature.geometry.coordinates[1], feature.geometry.coordinates[0]];
    const time = formatDateToLocal(p.time);
    const heading = p.course || 0;
    const device = devices.find(d => d.id === historyDeviceId);

    buildSensorAttrList();
    updateSensorChartCursor(historyIndex);
    document.getElementById('historySlider').value = historyIndex;
    document.getElementById('historyTimestamp').textContent = time;
    
    if (!markers['history_pos']) createHistoryMarker();
    
    const vehicle = VEHICLE_ICONS[device?.vehicle_type] || VEHICLE_ICONS['other'];
    const ignColor = p.ignition ? '#10b981' : '#ef4444';
    const historyPopup = `
        <div class="vp-popup">
            <div class="vp-header">
                <span class="vp-icon">${vehicle.emoji}</span>
                <span class="vp-name">${device?.name || 'History'}</span>
            </div>
            <div class="vp-grid">
                <span class="vp-label">Time</span>      <span class="vp-value vp-mono">${time}</span>
                <span class="vp-label">Speed</span>     <span class="vp-value">${Number(p.speed || 0).toFixed(1)} km/h</span>
                <span class="vp-label">Heading</span>   <span class="vp-value">${Number(p.course || 0).toFixed(0)}°</span>
                <span class="vp-label">Ignition</span>  <span class="vp-value" style="color:${ignColor};font-weight:700;">${p.ignition ? 'ON' : 'OFF'}</span>
                <span class="vp-label">Satellites</span><span class="vp-value">${p.satellites || 0}</span>
                <span class="vp-label">Altitude</span>  <span class="vp-value">${Number(p.altitude || 0).toFixed(0)} m</span>
                <span class="vp-label">Lat/Lng</span>   <span class="vp-value">${position[0].toFixed(5)}, ${position[1].toFixed(5)}</span>
            </div>
        </div>
    `;
    markers['history_pos'].setLatLng(position).setIcon(L.divIcon({
        html: getMarkerHtml(device?.vehicle_type, p.ignition, heading),
        className: 'history-marker',
        iconSize: [32, 32],
        iconAnchor: [16, 16]
    })).bindPopup(historyPopup);
    
    updatePointDetails(feature);

    // Trip label in floating controls
    const tripLabel = document.getElementById('historyTripLabel');
    const currentTrip = getCurrentTripForPoint(p.time);
    if (tripLabel) {
        if (currentTrip) {
            const tripIndex = historyTrips.length - historyTrips.indexOf(currentTrip);
            const dist = currentTrip.distance_km != null ? ` · ${currentTrip.distance_km.toFixed(1)} km` : '';
            tripLabel.textContent = `Trip ${tripIndex}${dist}`;
        } else {
            tripLabel.textContent = historyTrips.length ? 'Between trips' : '';
        }
    }

    // Highlight active trip card in sidebar
    document.querySelectorAll('.trip-card').forEach((card, i) => {
        const isActive = currentTrip && historyTrips.indexOf(currentTrip) === i;
        card.classList.toggle('trip-card-active', isActive);
    });
}

function updatePointDetails(feature) {
    const p = feature.properties;
    const content = document.getElementById('pointDetailsContent');
    
    // FIXED: Replaced 'Time' with 'Heading' in the first detail-item
    let html = `
        <div class="detail-grid">
            <div class="detail-item"><span class="detail-key">Heading</span><div class="detail-val">${(p.course || 0).toFixed(0)}°</div></div>
            <div class="detail-item"><span class="detail-key">Speed</span><div class="detail-val">${(p.speed || 0).toFixed(1)} km/h</div></div>
            <div class="detail-item"><span class="detail-key">Lat/Lon</span><div class="detail-val">${feature.geometry.coordinates[1].toFixed(5)}, ${feature.geometry.coordinates[0].toFixed(5)}</div></div>
            <div class="detail-item"><span class="detail-key">Altitude</span><div class="detail-val">${(p.altitude || 0).toFixed(0)} m</div></div>
            <div class="detail-item"><span class="detail-key">Satellites</span><div class="detail-val">${p.satellites || 0}</div></div>
            <div class="detail-item"><span class="detail-key">Ignition</span><div class="detail-val" style="color: ${p.ignition ? 'var(--accent-success)' : 'var(--text-muted)'}">${p.ignition ? 'ON' : 'OFF'}</div></div>
        </div>
    `;
    if (p.sensors && Object.keys(p.sensors).length > 0) {
        html += '<h4 style="font-size: 0.8rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 0.5rem;">Attributes</h4>';
        html += '<table class="attr-table"><tbody>';
        Object.keys(p.sensors).sort().forEach(key => { html += `<tr><td class="attr-key">${key}</td><td class="attr-val">${p.sensors[key]}</td></tr>`; });
        html += '</tbody></table>';
    } else html += '<div style="text-align: center; color: var(--text-muted); padding: 1rem; font-size: 0.875rem;">No additional attributes</div>';
    content.innerHTML = html;
}

function createHistoryMarker() {
    const device = devices.find(d => d.id === historyDeviceId);
    const vehicleIcon = (VEHICLE_ICONS[device?.vehicle_type] || VEHICLE_ICONS['other']).emoji;
    const heading = historyData[historyIndex].properties.course || 0;
    const rotationStyle = (device?.vehicle_type === 'arrow') ? `transform: rotate(${heading}deg);` : '';

    const icon = L.divIcon({
        html: `<div style="font-size: 28px; ${rotationStyle}">${vehicleIcon}</div>`,
        className: 'history-marker',
        iconSize: [32, 32],
        iconAnchor: [16, 16]
    });
    const startPos = historyData[historyIndex].geometry.coordinates;
    markers['history_pos'] = L.marker([startPos[1], startPos[0]], { icon }).addTo(map);
}

function updateStats() {
    // Simplified stats logic as panel was removed, but keeping function to avoid errors
    const onlineCount = devices.filter(d => d.is_online).length;
}

async function loadAlerts() {
    try {
        // FIXED: Use user_id from localStorage
        const userId = localStorage.getItem('user_id');
        const response = await apiFetch(`${API_BASE}/alerts?unread_only=true`);
        loadedAlerts = await response.json();
        
        // Fix: Check length for displaying number inside parentheses
        const countEl = document.getElementById('alertCount');
        if (loadedAlerts.length > 0) {
            countEl.textContent = loadedAlerts.length;
            countEl.style.display = 'inline';
        } else {
            countEl.textContent = '0';
            countEl.style.display = 'inline'; // Always show 0 if loaded
        }

        const list = document.getElementById('alertsList');
        list.innerHTML = '';
        
        if (loadedAlerts.length === 0) {
            list.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-muted);">No alerts</div>';
            return;
        }
        
        loadedAlerts.forEach(alert => {
            const item = document.createElement('div');
            item.className = `alert-item ${alert.severity}`;
            const icon = { 'speeding': '⚡', 'geofence_enter': '📍', 'geofence_exit': '🚪', 'offline': '📡', 'towing': '🚨' }[alert.alert_type] || '🔔';
            
            let title, messageText;
            if (alert.alert_type === 'custom' && alert.alert_metadata?.rule_name) {
                title       = alert.alert_metadata.rule_name;
                messageText = alert.alert_metadata.rule_condition || alert.message;
            } else {
                title       = alert.alert_type.replace(/_/g, ' ').toUpperCase();
                messageText = alert.message;
            }
            
            const device = devices.find(d => d.id === alert.device_id);
            const vehicleTag = device
                ? `<span style="
                    display:inline-flex; align-items:center; gap:0.3rem;
                    background:rgba(59,130,246,0.12); border:1px solid rgba(59,130,246,0.25);
                    border-radius:5px; padding:0.15rem 0.5rem;
                    font-size:0.7rem; font-weight:600; color:var(--accent-primary);
                    margin-bottom:0.3rem;"
                  >${(VEHICLE_ICONS[device.vehicle_type] || VEHICLE_ICONS['other']).emoji} ${device.name}</span>`
                : '';

            item.innerHTML = `
                <div class="alert-icon">${icon}</div>
                <div class="alert-content">
                    ${vehicleTag}
                    <div class="alert-title">${title}</div>
                    <div class="alert-message">${messageText}</div>
                    <div class="alert-time">${formatDateToLocal(alert.created_at)}</div>
                </div>
                <button class="alert-dismiss" onclick="dismissAlert(${alert.id})">✕</button>
            `;
            
            list.appendChild(item);
        });
        applyDeviceAlertHighlights();
    } catch (error) {
        console.error('Error loading alerts:', error);
    }
}

function applyDeviceAlertHighlights() {
    // Collect device IDs that have unread alerts
    const alertDeviceIds = new Set(
        loadedAlerts
            .filter(a => a.device_id != null)
            .map(a => a.device_id)
    );

    // Apply or remove .has-alert on every device card
    document.querySelectorAll('.device-card').forEach(card => {
        const deviceId = parseInt(card.id.replace('device-card-', ''));
        const hasAlert = alertDeviceIds.has(deviceId);
        card.classList.toggle('has-alert', hasAlert);

        // Add/remove the pulsing dot next to the device name
        const nameEl = card.querySelector('.device-name');
        if (nameEl) {
            const existing = nameEl.querySelector('.alert-pulse');
            if (hasAlert && !existing) {
                const dot = document.createElement('span');
                dot.className = 'alert-pulse';
                dot.title = 'Unread alert';
                nameEl.appendChild(dot);
            } else if (!hasAlert && existing) {
                existing.remove();
            }
        }
    });
}

function openAlertsModal() {
    loadAlerts();
    document.getElementById('alertsModal').classList.add('active');
}

function closeAlertsModal() {
    document.getElementById('alertsModal').classList.remove('active');
}

async function dismissAlert(alertId) {
    try {
        const res = await apiFetch(`${API_BASE}/alerts/${alertId}/read`, { method: 'POST' });
        if (res.ok) loadAlerts();
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
    
    loadAlerts();
    showAlert({ title: 'Success', message: 'All alerts cleared', type: 'success' });
}

function closeDeviceModal() {
    document.getElementById('deviceModal').classList.remove('active');
}

// Generic Alert/Toast Function
function showAlert(data) {
    const message = typeof data === 'string' ? data : data.message;
    const title = data.title || 'Notification';
    const type = data.type || 'info';
    
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast`;
    
    // Icons
    const icons = {
        'success': '✓',
        'error': '✕',
        'warning': '⚠',
        'info': 'ℹ'
    };
    
    toast.innerHTML = `
        <div class="toast-icon">${icons[type] || 'ℹ'}</div>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            <div class="toast-message">${message}</div>
        </div>
    `;
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'slideInRight 0.3s reverse forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
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

// Traffic & Satellite (placeholder functions)
function toggleTraffic() {
    alert('Traffic layer not implemented in demo');
}

function toggleSatellite() {
    alert('Satellite view not implemented in demo');
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

// ── Tab switcher ───────────────────────────────────────────────
function switchHistoryTab(tab) {
    currentHistoryTab = tab;
    document.getElementById('tabTrips').style.display   = tab === 'trips'   ? 'block' : 'none';
    document.getElementById('tabDetails').style.display = tab === 'details' ? 'block' : 'none';
    document.getElementById('tabGraph').style.display   = tab === 'graph'   ? 'block' : 'none';
    document.getElementById('tabBtnTrips').classList.toggle('active',   tab === 'trips');
    document.getElementById('tabBtnDetails').classList.toggle('active', tab === 'details');
    document.getElementById('tabBtnGraph').classList.toggle('active',   tab === 'graph');
    if (tab === 'graph') renderSensorGraph();
}
// ── Build attribute list from all historyData ──────────────────
function buildSensorAttrList() {
    if (!historyData || historyData.length === 0) return;

    // Collect all numeric keys across all points
    const attrSet = new Set();

    // Always include core fields if they are numeric
    const coreFields = ['speed', 'altitude', 'course', 'satellites'];
    coreFields.forEach(f => attrSet.add(f));

    historyData.forEach(feat => {
        const p = feat.properties;
        // Add sensor sub-keys
        if (p.sensors) {
            Object.entries(p.sensors).forEach(([k, v]) => {
                if (k !== 'raw' && !isNaN(parseFloat(v))) attrSet.add('sensors.' + k);
            });
        }
    });

    const container = document.getElementById('sensorAttrList');
    container.innerHTML = '';

    let colorIdx = 0;
    attrSet.forEach(attr => {
        const color = SENSOR_COLORS[colorIdx % SENSOR_COLORS.length];
        colorIdx++;

        const chip = document.createElement('button');
        chip.className = 'sensor-chip' + (selectedSensorAttrs.has(attr) ? ' selected' : '');
        chip.dataset.attr = attr;
        chip.dataset.color = color;
        chip.style.setProperty('--chip-color', color);
        chip.textContent = formatAttrLabel(attr);
        chip.onclick = () => toggleSensorAttr(attr, chip);
        container.appendChild(chip);
    });

    renderSensorGraph();
}

function buildSensorAttrList() {
    if (!historyData || historyData.length === 0) return;

    // Collect all numeric keys across all points
    const attrSet = new Set();

    // Always include core fields if they are numeric
    const coreFields = ['speed', 'altitude', 'course', 'satellites'];
    coreFields.forEach(f => attrSet.add(f));

    historyData.forEach(feat => {
        const p = feat.properties;
        // Add sensor sub-keys
        if (p.sensors) {
            Object.entries(p.sensors).forEach(([k, v]) => {
                if (k !== 'raw' && !isNaN(parseFloat(v))) attrSet.add('sensors.' + k);
            });
        }
    });

    const container = document.getElementById('sensorAttrList');
    container.innerHTML = '';

    let colorIdx = 0;
    attrSet.forEach(attr => {
        const color = SENSOR_COLORS[colorIdx % SENSOR_COLORS.length];
        colorIdx++;

        const chip = document.createElement('button');
        chip.className = 'sensor-chip' + (selectedSensorAttrs.has(attr) ? ' selected' : '');
        chip.dataset.attr = attr;
        chip.dataset.color = color;
        chip.style.setProperty('--chip-color', color);
        chip.textContent = formatAttrLabel(attr);
        chip.onclick = () => toggleSensorAttr(attr, chip);
        container.appendChild(chip);
    });

    renderSensorGraph();
}


function formatAttrLabel(attr) {
    return attr
        .replace('sensors.', '')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
}

function toggleSensorAttr(attr, chip) {
    if (selectedSensorAttrs.has(attr)) {
        selectedSensorAttrs.delete(attr);
        chip.classList.remove('selected');
    } else {
        selectedSensorAttrs.add(attr);
        chip.classList.add('selected');
    }
    renderSensorGraph();
}

// ── Render / update the Chart.js graph ────────────────────────
function renderSensorGraph() {
    if (!historyData || historyData.length === 0) return;

    const canvas = document.getElementById('sensorChart');
    const emptyMsg = document.getElementById('sensorChartEmpty');

    if (selectedSensorAttrs.size === 0) {
        canvas.style.display = 'none';
        emptyMsg.style.display = 'block';
        return;
    }
    canvas.style.display = 'block';
    emptyMsg.style.display = 'none';

    // Build labels (timestamps) and datasets
    const labels = historyData.map(f => {
        const d = new Date(f.properties.time);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    });

    const chips = document.querySelectorAll('.sensor-chip.selected');
    const colorMap = {};
    chips.forEach(c => { colorMap[c.dataset.attr] = c.dataset.color; });

    const datasets = Array.from(selectedSensorAttrs).map(attr => {
        const color = colorMap[attr] || '#3b82f6';
        const data = historyData.map(f => {
            const p = f.properties;
            if (attr.startsWith('sensors.')) {
                const key = attr.slice('sensors.'.length);
                const val = p.sensors?.[key];
                return val !== undefined ? parseFloat(val) : null;
            }
            const val = p[attr];
            return val !== undefined ? parseFloat(val) : null;
        });
        return {
            label: formatAttrLabel(attr),
            data,
            borderColor: color,
            backgroundColor: color + '22',
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 5,
            tension: 0.3,
            fill: false,
            yAxisID: 'y',
        };
    });

    if (sensorChart) {
        sensorChart.data.labels = labels;
        sensorChart.data.datasets = datasets;
        sensorChart.update('none');
    } else {
        sensorChart = new Chart(canvas, {
            type: 'line',
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: {
                        display: true,
                        labels: {
                            color: '#9ca3af',
                            font: { family: 'JetBrains Mono', size: 10 },
                            boxWidth: 12,
                            padding: 8,
                        }
                    },
                    tooltip: {
                        backgroundColor: '#131825',
                        borderColor: '#374151',
                        borderWidth: 1,
                        titleColor: '#e5e7eb',
                        bodyColor: '#9ca3af',
                        titleFont: { family: 'JetBrains Mono', size: 11 },
                        bodyFont: { family: 'JetBrains Mono', size: 11 },
                    },
                    // Vertical cursor line plugin (defined below)
                    verticalLine: { index: historyIndex }
                },
                scales: {
                    x: {
                        ticks: {
                            color: '#6b7280',
                            font: { family: 'JetBrains Mono', size: 9 },
                            maxTicksLimit: 6,
                            maxRotation: 0,
                        },
                        grid: { color: '#374151' }
                    },
                    y: {
                        ticks: { color: '#6b7280', font: { family: 'JetBrains Mono', size: 10 } },
                        grid: { color: '#374151' }
                    }
                }
            },
            plugins: [verticalLinePlugin]
        });
    }

    updateSensorChartCursor(historyIndex);
}

// ── Vertical cursor line plugin ────────────────────────────────
const verticalLinePlugin = {
    id: 'verticalLine',
    afterDraw(chart) {
        const idx = chart.options.plugins.verticalLine?.index;
        if (idx == null || !chart.data.labels?.length) return;
        const meta = chart.getDatasetMeta(0);
        if (!meta || !meta.data[idx]) return;
        const x = meta.data[idx].x;
        const ctx = chart.ctx;
        const top = chart.chartArea.top;
        const bottom = chart.chartArea.bottom;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.restore();
    }
};

function updateSensorChartCursor(idx) {
    if (!sensorChart) return;
    sensorChart.options.plugins.verticalLine.index = idx;
    sensorChart.update('none');
}

// ── Export history data to CSV ─────────────────────────────────
function exportHistoryCSV() {
    if (!historyData || historyData.length === 0) {
        showAlert({ title: 'Export', message: 'No history data to export.', type: 'warning' });
        return;
    }

    // Collect all sensor keys across all points
    const sensorKeys = new Set();
    historyData.forEach(f => {
        if (f.properties.sensors) {
            Object.keys(f.properties.sensors).forEach(k => {
                if (k !== 'raw') sensorKeys.add(k);
            });
        }
    });

    const coreFields = ['time', 'latitude', 'longitude', 'speed', 'altitude', 'course', 'satellites', 'ignition'];
    const sensorCols = Array.from(sensorKeys).sort();
    const allHeaders = [...coreFields, ...sensorCols];

    // Build CSV rows
    const rows = historyData.map(f => {
        const p = f.properties;
        const coords = f.geometry.coordinates;
        const row = {
            time:       p.time || '',
            latitude:   coords[1],
            longitude:  coords[0],
            speed:      p.speed      ?? '',
            altitude:   p.altitude   ?? '',
            course:     p.course     ?? '',
            satellites: p.satellites ?? '',
            ignition:   p.ignition != null ? (p.ignition ? 'true' : 'false') : '',
        };
        sensorCols.forEach(k => {
            row[k] = p.sensors?.[k] ?? '';
        });
        return allHeaders.map(h => {
            const val = row[h] ?? '';
            // Wrap in quotes if value contains comma or quote
            const str = String(val);
            return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
        }).join(',');
    });

    const csvContent = [allHeaders.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const device = devices.find(d => d.id === historyDeviceId);
    const deviceName = (device?.name || 'device').replace(/\s+/g, '_');
    const now = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const filename = `history_${deviceName}_${now}.csv`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    showAlert({ title: 'Export', message: `Exported ${historyData.length} points to ${filename}`, type: 'success' });
}
