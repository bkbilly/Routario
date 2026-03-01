/**
 * dashboard-map.js
 * Map initialization, tile layers, device markers, and WebSocket connection.
 */

const markerState = {};

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

// Traffic & Satellite (placeholder functions)
function toggleTraffic() {
    alert('Traffic layer not implemented in demo');
}

function toggleSatellite() {
    alert('Satellite view not implemented in demo');
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
                markerState[deviceId] = { lat: toLat, lng: toLng, heading: toHead, animFrame: requestAnimationFrame(step) };
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
