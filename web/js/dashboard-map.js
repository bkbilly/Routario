/**
 * dashboard-map.js
 * Map initialization, tile layers, device markers, and WebSocket connection.
 */

// markerState[deviceId] = { lat, lng, heading, animFrame }
const markerState = {};

const MAP_TILES = {
    openstreetmap: {
        label: '🗺️ OpenStreetMap',
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19
    },
    stadia_dark: {
        label: '🌒 Stadia Dark',
        url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
        attribution: '© <a href="https://stadiamaps.com/">Stadia Maps</a>',
        maxZoom: 20
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
        label: '🌑 Carto Dark',
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        attribution: '© <a href="https://carto.com/">CARTO</a>',
        maxZoom: 19
    },
    carto_light: {
        label: '☀️ Carto Light',
        url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
        attribution: '© <a href="https://carto.com/">CARTO</a>',
        maxZoom: 19
    },
    esri_satellite: {
        label: '🌐 ESRI Satellite',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attribution: '© Esri, Maxar, Earthstar Geographics',
        maxZoom: 19
    },
};

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Write the correct rotation directly to the .marker-svg element during animation.
 * heading = raw GPS course (degrees). The per-type offset is added here.
 */
function _applyMarkerRotation(marker, heading, vehicleType) {
    const el = marker.getElement();
    if (!el) return;
    const svg = el.querySelector('.marker-svg');
    if (!svg) return;
    const cfg = VEHICLE_ICONS[vehicleType];
    const offset = (cfg && !cfg.arrow) ? (cfg.offset || 0) : 0;
    svg.style.transform = `rotate(${heading + offset}deg)`;
}

/**
 * Build a L.divIcon with the heading already baked into the HTML string.
 * Use this whenever creating or restoring a marker so there is no
 * post-insertion DOM timing dependency.
 */
function _makeMarkerIcon(vehicleType, ignitionOn, heading) {
    return L.divIcon({
        html: getMarkerHtml(vehicleType, ignitionOn, heading),
        className: 'custom-marker',
        iconSize: [36, 36],
        iconAnchor: [18, 18]
    });
}

// ── Map initialisation ────────────────────────────────────────────────────────

function initMap() {
    map = L.map('map', {
        zoomControl: false,
    }).setView([20, 0], 2);

    const savedTile = localStorage.getItem('mapTileLayer') || 'openstreetmap';
    applyTileLayer(savedTile);
    populateMapPicker();

    // Close flyouts on map click; also auto-close sidebar on mobile
    let popupWasOpen = false;
    map.on('popupopen',  () => { popupWasOpen = true; });
    map.on('popupclose', () => { popupWasOpen = true; setTimeout(() => { popupWasOpen = false; }, 0); });
    map.on('click', () => {
        closeAllMapFlyouts();
        if (window.innerWidth <= 1024) {
            if (popupWasOpen) return;
            const dashboard = document.querySelector('.dashboard');
            if (!dashboard.classList.contains('sidebar-hidden')) {
                dashboard.classList.add('sidebar-hidden');
                setTimeout(() => map.invalidateSize(), 300);
            }
        }

    });

    initGeofences(map);
}

// ── Tile layers ───────────────────────────────────────────────────────────────

function applyTileLayer(tileKey) {
    const tile = MAP_TILES[tileKey] || MAP_TILES['openstreetmap'];

    if (currentTileLayer) map.removeLayer(currentTileLayer);

    currentTileLayer = L.tileLayer(tile.url, {
        attribution: tile.attribution,
        maxZoom: tile.maxZoom
    }).addTo(map);

    localStorage.setItem('mapTileLayer', tileKey);

    document.querySelectorAll('.map-tile-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tile === tileKey);
    });
}

function populateMapPicker() {
    const flyout = document.getElementById('mapLayersFlyout');
    if (!flyout) return;
    const savedTile = localStorage.getItem('mapTileLayer') || 'openstreetmap';
    flyout.innerHTML = Object.entries(MAP_TILES).map(([key, tile]) => `
        <label>
            <input type="radio" name="map-tile-radio" value="${key}" ${key === savedTile ? 'checked' : ''}
                onchange="applyTileLayer('${key}'); closeAllMapFlyouts();">
            <span>${tile.label}</span>
        </label>
    `).join('');
}

// ── Map control flyouts ───────────────────────────────────────────────────────

function toggleMapCtrlFlyout(id, e) {
    if (e) e.stopPropagation();
    const flyout = document.getElementById(id);
    const isOpen = flyout.classList.contains('open');
    closeAllMapFlyouts();
    if (!isOpen) flyout.classList.add('open');
}

function closeAllMapFlyouts() {
    document.querySelectorAll('.map-ctrl-flyout').forEach(f => f.classList.remove('open'));
}

function closePicker(e) {
    const picker = document.getElementById('mapTilePicker');
    const btn    = document.getElementById('mapPickerBtn');
    if (picker && btn && !picker.contains(e.target) && !btn.contains(e.target)) {
        picker.style.display = 'none';
    }
}

// ── Device markers ────────────────────────────────────────────────────────────

function updateDeviceMarker(deviceId, state) {
    if (!state.last_latitude || !state.last_longitude) return;

    const toLat  = state.last_latitude;
    const toLng  = state.last_longitude;
    const toHead = state.last_course || 0;
    const device = devices.find(d => d.id === deviceId);
    const deviceName = device ? device.name : 'Unknown Device';

    // Three-state ignition: true=ON, false=OFF, null/undefined=unknown
    const ignitionColor = state.ignition_on === true  ? '#10b981'
                        : state.ignition_on === false ? '#ef4444'
                        : '#6b7280';
    const ignitionText  = state.ignition_on === true  ? 'ON'
                        : state.ignition_on === false ? 'OFF'
                        : '—';

    const vehicle = VEHICLE_ICONS[device?.vehicle_type] || VEHICLE_ICONS['other'];

    const popupContent = `
        <div class="vp-popup">
            <div class="vp-header">
                <span class="vp-icon">${vehicle.emoji}</span>
                <span class="vp-name">${deviceName}</span>
            </div>
            <div class="vp-grid">
                <span class="vp-label">Ignition</span>   <span class="vp-value" style="color:${ignitionColor};font-weight:700;">${ignitionText}</span>
                <span class="vp-label">Speed</span>      <span class="vp-value">${Number(state.last_speed || 0).toFixed(1)} km/h</span>
                <span class="vp-label">Satellites</span> <span class="vp-value">${state.satellites || 0}</span>
                <span class="vp-label">Altitude</span>   <span class="vp-value">${Math.round(state.last_altitude || 0)} m</span>
                <span class="vp-label">Odometer</span>   <span class="vp-value">${Math.round(state.total_odometer || 0)} km</span>
            </div>
            <div class="vp-actions">
                <button class="vp-action-btn" onclick="openLogbookModal(${deviceId}); if(map) map.closePopup();">📋 Logbook</button>
                <button class="vp-action-btn" onclick="openShareModal(${deviceId}); if(map) map.closePopup();">🔗 Share</button>
                <button class="vp-action-btn" onclick="openHistoryModal(${deviceId}); if(map) map.closePopup();">🕒 History</button>
            </div>
        </div>`;

    if (!markers[deviceId]) {
        // ── First appearance ──────────────────────────────────────────────────
        // Pass toHead into _makeMarkerIcon so the correct rotation is baked
        // directly into the HTML string — no post-insertion DOM fix-up needed.
        markers[deviceId] = L.marker([toLat, toLng], {
            icon: _makeMarkerIcon(device?.vehicle_type, state.ignition_on, toHead)
        })
            .bindPopup(popupContent)
            .addTo(map);

        markers[deviceId].on('click', () => selectDevice(deviceId, { zoom: false }));

        markerState[deviceId] = { lat: toLat, lng: toLng, heading: toHead, animFrame: null };

    } else {
        // ── Subsequent updates: smooth animation ──────────────────────────────
        markers[deviceId].setPopupContent(popupContent);

        const prev = markerState[deviceId] || { lat: toLat, lng: toLng, heading: toHead, animFrame: null };

        if (prev.animFrame) {
            cancelAnimationFrame(prev.animFrame);
            prev.animFrame = null;
        }

        const fromLat  = prev.lat;
        const fromLng  = prev.lng;
        const fromHead = prev.heading; // raw course — markerState is sole source of truth

        // Shortest-arc rotation delta
        const dH = ((toHead - fromHead + 540) % 360) - 180;

        const duration  = 1000;
        const startTime = performance.now();

        function step(now) {
            // Stop animating if the marker left the map (zoom redraw, filter hide, etc.)
            if (!markers[deviceId] || !map.hasLayer(markers[deviceId])) {
                markerState[deviceId] = { lat: toLat, lng: toLng, heading: toHead, animFrame: null };
                return;
            }

            const t    = Math.min((now - startTime) / duration, 1);
            const ease = 1 - Math.pow(1 - t, 3); // ease-out cubic

            const lat  = fromLat  + (toLat  - fromLat)  * ease;
            const lng  = fromLng  + (toLng  - fromLng)  * ease;
            const head = fromHead + dH * ease;

            markers[deviceId].setLatLng([lat, lng]);
            _applyMarkerRotation(markers[deviceId], head, device?.vehicle_type);

            if (t < 1) {
                // Store interpolated heading so next update's fromHead is accurate
                markerState[deviceId] = {
                    lat: toLat, lng: toLng,
                    heading: head,
                    animFrame: requestAnimationFrame(step)
                };
            } else {
                markerState[deviceId] = { lat: toLat, lng: toLng, heading: toHead, animFrame: null };
            }
        }

        markerState[deviceId] = {
            lat: fromLat, lng: fromLng,
            heading: fromHead,
            animFrame: requestAnimationFrame(step)
        };
    }

    // Keep devices array in sync
    const deviceIndex = devices.findIndex(d => d.id === deviceId);
    if (deviceIndex !== -1) {
        if (!state.hasOwnProperty('is_online') && state.last_latitude) state.is_online = true;
        devices[deviceIndex] = { ...devices[deviceIndex], ...state };
    }
}

/**
 * Called in dashboard-devices.js immediately after marker.addTo(map) when a
 * search-filtered marker is made visible again.
 *
 * Leaflet rebuilds the marker's DOM element on re-add, resetting any inline
 * styles we wrote earlier.  We fix this by calling setIcon() with the correct
 * heading baked into the HTML — exactly the same approach as first creation.
 */
function restoreMarkerRotation(deviceId) {
    const saved  = markerState[deviceId];
    const marker = markers[deviceId];
    const device = devices.find(d => d.id === deviceId);
    if (!saved || !marker) return;

    marker.setIcon(_makeMarkerIcon(
        device?.vehicle_type,
        device?.ignition_on,
        saved.heading
    ));
}

// ── Map fit ───────────────────────────────────────────────────────────────────

function fitMapToMarkers() {
    const validMarkers = Object.values(markers).filter(m => m && m.getLatLng);
    if (validMarkers.length === 0) return;

    if (validMarkers.length === 1) {
        map.setView(validMarkers[0].getLatLng(), 15);
    } else {
        const group = L.featureGroup(validMarkers);
        map.fitBounds(group.getBounds().pad(0.2));
    }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connectWebSocket() {
    const userId = localStorage.getItem('user_id');
    if (!userId) return;

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
            // Don't update markers or animate anything while in history mode
            if (!historyDeviceId) {
                updateDeviceMarker(message.device_id, devices[devIdx]);
                updateSidebarCard(message.device_id);
            }
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

// ── User Location ─────────────────────────────────────────────────────────────

let _locating          = false;
let _locationMarker    = null;
let _accuracyCircle    = null;
let _headingMarker     = null;
let _locationWatchId   = null;
let _compassAvailable  = false;
let _lastHeading       = null;

function toggleUserLocation() {
    if (_locating) {
        _stopUserLocation();
    } else {
        _startUserLocation();
    }
}

function _startUserLocation() {
    if (!navigator.geolocation) {
        _flashLocateBtn('error');
        return;
    }

    _locating = true;
    document.getElementById('locateUserBtn').classList.add('locate-active');

    // Request compass on mobile if available
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS 13+ requires explicit permission
        DeviceOrientationEvent.requestPermission()
            .then(state => {
                if (state === 'granted') _listenCompass();
            })
            .catch(() => {});
    } else if (window.DeviceOrientationEvent) {
        _listenCompass();
    }

    // Start watching position
    _locationWatchId = navigator.geolocation.watchPosition(
        _onLocationSuccess,
        _onLocationError,
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
    );
}

function _stopUserLocation() {
    _locating = false;
    document.getElementById('locateUserBtn').classList.remove('locate-active');

    if (_locationWatchId !== null) {
        navigator.geolocation.clearWatch(_locationWatchId);
        _locationWatchId = null;
    }

    window.removeEventListener('deviceorientation',        _onCompass);
    window.removeEventListener('deviceorientationabsolute', _onCompass);

    if (_locationMarker)  { map.removeLayer(_locationMarker);  _locationMarker  = null; }
    if (_accuracyCircle)  { map.removeLayer(_accuracyCircle);  _accuracyCircle  = null; }
    if (_headingMarker)   { map.removeLayer(_headingMarker);   _headingMarker   = null; }

    _compassAvailable = false;
    _lastHeading      = null;
}

function _onLocationSuccess(pos) {
    const { latitude: lat, longitude: lng, accuracy, heading } = pos.coords;

    const firstFix = !_locationMarker;

    // ── Accuracy circle ───────────────────────────────────────────────────────
    if (_accuracyCircle) {
        _accuracyCircle.setLatLng([lat, lng]);
        _accuracyCircle.setRadius(accuracy);
    } else {
        _accuracyCircle = L.circle([lat, lng], {
            radius:    accuracy,
            className: 'user-accuracy-circle',
        }).addTo(map);
    }

    // ── Blue dot marker ───────────────────────────────────────────────────────
    const icon = L.divIcon({
        className: '',
        html: `<div class="user-location-marker">
                   <div class="user-location-pulse"></div>
                   <div class="user-location-dot"></div>
               </div>`,
        iconSize:   [22, 22],
        iconAnchor: [11, 11],
    });

    if (_locationMarker) {
        _locationMarker.setLatLng([lat, lng]);
        _locationMarker.setIcon(icon);
    } else {
        _locationMarker = L.marker([lat, lng], { icon, zIndexOffset: 500 }).addTo(map);
    }

    // Use geolocation heading if compass not available
    if (!_compassAvailable && heading !== null && !isNaN(heading)) {
        _renderHeadingCone(lat, lng, heading);
    }

    // ── Smooth zoom based on accuracy ─────────────────────────────────────────
    if (firstFix) {
        const targetZoom = _accuracyToZoom(accuracy);
        // Fly smoothly — easeLinearity close to 1 = more linear/smooth, 
        // duration scales with how far we need to zoom
        const currentZoom = map.getZoom();
        const zoomDelta   = Math.abs(targetZoom - currentZoom);
        map.flyTo([lat, lng], targetZoom, {
            animate:         true,
            duration:        0.5 + zoomDelta * 0.15,
            easeLinearity:   0.25,
        });
    }
}

function _onLocationError(err) {
    console.warn('Geolocation error:', err.message);
    _flashLocateBtn('error');
    _stopUserLocation();
}

// Map accuracy (metres) to an appropriate zoom level
function _accuracyToZoom(accuracy) {
    // Find the zoom level where the accuracy circle fills ~80% of the map viewport
    const mapSize   = map.getSize();
    const minDim    = Math.min(mapSize.x, mapSize.y);
    const targetPx  = minDim * 0.8;

    // At zoom Z, 1 metre = (256 * 2^Z) / (2π * 6378137 * cos(lat)) pixels
    // Rearranged: Z = log2( targetPx * 2π * R * cos(lat) / (256 * 2 * accuracy) )
    const lat     = map.getCenter().lat;
    const R       = 6378137;
    const latRad  = lat * Math.PI / 180;
    const zoom    = Math.log2(
        (targetPx * 2 * Math.PI * R * Math.cos(latRad)) /
        (256 * 2 * accuracy)
    );

    return Math.min(19, Math.max(11, Math.round(zoom)));
}

// ── Compass ───────────────────────────────────────────────────────────────────

function _listenCompass() {
    // 'deviceorientationabsolute' gives true north; fall back to 'deviceorientation'
    const evtName = 'ondeviceorientationabsolute' in window
        ? 'deviceorientationabsolute'
        : 'deviceorientation';

    window.addEventListener(evtName, _onCompass, { passive: true });
}

function _onCompass(e) {
    // alpha = rotation around Z axis; webkitCompassHeading = iOS true-north heading
    let heading = null;

    if (e.webkitCompassHeading != null) {
        // iOS — already true north, 0° = north
        heading = e.webkitCompassHeading;
    } else if (e.alpha != null) {
        // Android absolute — convert from screen rotation
        heading = (360 - e.alpha) % 360;
    } else {
        return; // relative orientation only — not reliable for compass
    }

    _compassAvailable = true;
    _lastHeading      = heading;

    if (_locationMarker) {
        const ll = _locationMarker.getLatLng();
        _renderHeadingCone(ll.lat, ll.lng, heading);
    }
}

function _renderHeadingCone(lat, lng, heading) {
    // Draw a small SVG cone above the dot to indicate facing direction
    const coneIcon = L.divIcon({
        className: '',
        html: `<div style="
                   position:relative;
                   width:48px; height:48px;
                   display:flex; align-items:center; justify-content:center;
               ">
                   <svg width="48" height="48" viewBox="0 0 48 48"
                        style="position:absolute;top:0;left:0;transform:rotate(${heading}deg);transform-origin:24px 24px;">
                       <path d="M24 4 L29 24 L24 21 L19 24 Z"
                             fill="rgba(66,133,244,0.85)" stroke="white" stroke-width="1.2"/>
                   </svg>
               </div>`,
        iconSize:   [48, 48],
        iconAnchor: [24, 24],
    });

    if (_headingMarker) {
        _headingMarker.setLatLng([lat, lng]);
        _headingMarker.setIcon(coneIcon);
    } else {
        _headingMarker = L.marker([lat, lng], {
            icon: coneIcon,
            zIndexOffset: 499,
            interactive: false,
        }).addTo(map);
    }
}

// ── Button feedback ───────────────────────────────────────────────────────────

function _flashLocateBtn(type) {
    const btn = document.getElementById('locateUserBtn');
    const color = type === 'error' ? 'var(--accent-danger)' : '#4285f4';
    btn.style.color       = color;
    btn.style.borderColor = color;
    setTimeout(() => {
        btn.style.color       = '';
        btn.style.borderColor = '';
    }, 1000);
}
