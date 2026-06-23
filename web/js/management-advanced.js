'use strict';

let _rtpDevices = [];
let _rtpCompanies = [];
let _rtpPlans = [];
let _rtpRoutesLoaded = false;
let _rtpApiLoaded = false;
let _rtpBillingLoaded = false;
let _rtpEditingRouteId = null;
let _rtpEditingPlanId = null;
let _rtpDetailPlanId = null;
let _rtpMap = null;
let _rtpStopLayer = null;
let _rtpRouteLine = null;
let _rtpTileLayer = null;
let _rtpRouteGeometry = null;
let _rtpRouteGeometrySignature = '';
let _rtpPreviewTimer = null;
let _rtpPreviewSignature = '';
let _rtpRouteReadonly = false;
let _rtpAuditRows = [];
let _rtpHealthRows = [];
let _rtpRouteRows = [];
let _rtpCurrencyRates = [];
let _rtpRouteSort = { col: 'name', dir: 'asc' };
let _rtpBillingSort = { col: 'name', dir: 'asc' };
let _rtpAuditSort = { col: 'time', dir: 'desc' };
let _rtpHealthSort = { col: 'name', dir: 'asc' };
let _rtpPlanCompanySelection = new Set();

function rtpEsc(value) {
    return RoutarioUI.escapeHtml(value);
}

function rtpDateTime(value) {
    if (!value) return '-';
    const date = rtpDate(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString();
}

function rtpDate(value) {
    if (!value) return new Date(NaN);
    if (typeof value === 'string' && !value.includes('Z') && !value.includes('+')) {
        return new Date(`${value}Z`);
    }
    return new Date(value);
}

async function rtpJson(url, options = {}) {
    const res = await apiFetch(url, options);
    if (!res.ok) {
        let msg = `Request failed (${res.status})`;
        try { msg = (await res.json()).detail || msg; } catch {}
        throw new Error(Array.isArray(msg) ? msg.map(x => x.msg || JSON.stringify(x)).join(', ') : msg);
    }
    return res.json();
}

async function rtpLoadCommon() {
    const isAdmin = localStorage.getItem('is_admin') === 'true';
    const reqs = [
        rtpJson(`${API_BASE}/devices`).catch(() => []),
        isAdmin ? rtpJson(`${API_BASE}/companies`).catch(() => []) : Promise.resolve([]),
    ];
    [_rtpDevices, _rtpCompanies] = await Promise.all(reqs);
}

function rtpMoney(cents, currency = 'EUR', exchangeRate = null) {
    if (exchangeRate != null && typeof fmtMoneyCentsAtRate === 'function') {
        return fmtMoneyCentsAtRate(cents, currency, exchangeRate);
    }
    if (typeof fmtMoneyCents === 'function') return fmtMoneyCents(cents);
    const displayCurrency = currency || 'EUR';
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: displayCurrency }).format((Number(cents) || 0) / 100);
}

function rtpInvoiceMoney(cents, invoice) {
    return rtpMoney(cents, invoice?.currency || 'EUR', invoice?.exchange_rate ?? 1);
}

function rtpCurrencyInput(cents, digits = 2) {
    const eur = (Number(cents) || 0) / 100;
    return typeof currencyInputValue === 'function' ? currencyInputValue(eur, digits) : eur.toFixed(digits);
}

function rtpCurrencyCentsFromInput(id) {
    const value = document.getElementById(id)?.value;
    const eur = typeof currencyInputToBase === 'function'
        ? currencyInputToBase(value)
        : Number(value || 0);
    return Math.round(Number(eur || 0) * 100);
}

function rtpApplyBillingCurrencyLabels() {
    const cur = typeof userCurrency === 'function' ? userCurrency() : 'EUR';
    const labels = {
        billBaseLabel: `Base Price (${cur})`,
        billDevicePriceLabel: `Per Device (${cur})`,
        billPositionPriceLabel: `Per 1000 Positions (${cur})`,
        billApiPriceLabel: `Per 1000 API Calls (${cur})`,
    };
    Object.entries(labels).forEach(([id, text]) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    });
}

window.addEventListener('routario:currencychange', () => {
    rtpApplyBillingCurrencyLabels();
    if (typeof rtpRenderBillingTable === 'function') rtpRenderBillingTable();
    if (document.getElementById('billingPlanModal')?.classList.contains('active')) {
        const plan = _rtpEditingPlanId ? _rtpPlans.find(p => Number(p.id) === Number(_rtpEditingPlanId)) : null;
        rtpFillPlanForm(plan);
    }
});

function rtpCompareValues(a, b, dir = 'asc') {
    const av = a ?? '';
    const bv = b ?? '';
    let result;
    if (typeof av === 'number' && typeof bv === 'number') {
        result = av - bv;
    } else {
        result = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    }
    return dir === 'desc' ? -result : result;
}

function rtpUpdateSortHeaders(sectionId, sortState) {
    RoutarioTables.updateSortHeaders(sectionId, sortState);
}

function rtpCurrentCompanyId() {
    return parseInt(localStorage.getItem('company_id') || '0', 10) || null;
}

// ── Routes ───────────────────────────────────────────────────────

async function rtpInitRoutes() {
    if (_rtpRoutesLoaded) {
        await rtpLoadRoutes();
        return;
    }
    _rtpRoutesLoaded = true;
    await rtpLoadCommon();
    rtpPopulateRouteSelectors();
    await rtpLoadRoutes();
}

function rtpPopulateRouteSelectors() {
    const devSel = document.getElementById('rpDevice');
    if (!devSel) return;
    devSel.innerHTML = '<option value="">Unassigned</option>' + _rtpDevices.map(d => `<option value="${d.id}">${rtpEsc(d.name)}</option>`).join('');
}

function rtpInitRouteMap() {
    if (!window.L || _rtpMap) {
        setTimeout(() => _rtpMap?.invalidateSize(), 50);
        return;
    }
    _rtpMap = L.map('routePlanMap', { zoomControl: true, attributionControl: true }).setView([39.0742, 21.8243], 6);
    rtpApplyRouteMapTileLayer();
    _rtpStopLayer = L.layerGroup().addTo(_rtpMap);
    _rtpMap.on('click', e => {
        if (_rtpRouteReadonly) return;
        rtpAddStop({ latitude: Number(e.latlng.lat.toFixed(6)), longitude: Number(e.latlng.lng.toFixed(6)) });
    });
    setTimeout(() => _rtpMap.invalidateSize(), 100);
}

function rtpApplyRouteMapTileLayer() {
    if (!_rtpMap || !window.L) return;
    const tileKey = localStorage.getItem('mapTileLayer') || 'openstreetmap_dark';
    const tiles = typeof MAP_TILES !== 'undefined' ? MAP_TILES : rtpRouteMapTiles();
    const tile = tiles[tileKey] || tiles.openstreetmap_dark;
    if (_rtpTileLayer) _rtpMap.removeLayer(_rtpTileLayer);
    _rtpTileLayer = L.tileLayer(tile.url, {
        attribution: tile.attribution,
        maxZoom: tile.maxZoom,
    }).addTo(_rtpMap);
    const tileContainer = _rtpTileLayer.getContainer();
    if (tileContainer) tileContainer.style.filter = tile.cssFilter || '';
}

function rtpRouteMapTiles() {
    return {
        openstreetmap_dark: {
            url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            maxZoom: 19,
            cssFilter: 'invert(100%) hue-rotate(180deg)',
        },
        openstreetmap: {
            url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            maxZoom: 19,
        },
        stadia_dark: {
            url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
            attribution: '© <a href="https://stadiamaps.com/">Stadia Maps</a>',
            maxZoom: 20,
        },
        google_streets: {
            url: 'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
            attribution: '© Google Maps',
            maxZoom: 21,
        },
        google_satellite: {
            url: 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
            attribution: '© Google Maps',
            maxZoom: 21,
        },
        google_hybrid: {
            url: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
            attribution: '© Google Maps',
            maxZoom: 21,
        },
        carto_dark: {
            url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
            attribution: '© <a href="https://carto.com/">CARTO</a>',
            maxZoom: 19,
        },
        carto_light: {
            url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
            attribution: '© <a href="https://carto.com/">CARTO</a>',
            maxZoom: 19,
        },
        esri_satellite: {
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            attribution: '© Esri, Maxar, Earthstar Geographics',
            maxZoom: 19,
        },
    };
}

function rtpAddStop(stop = {}) {
    const box = document.getElementById('rpStops');
    const row = document.createElement('div');
    row.className = 'route-stop-row stack-item';
    const stopKind = stop.stop_kind || 'stop';
    const radius = Number.isFinite(Number(stop.arrival_radius_m)) ? Number(stop.arrival_radius_m) : 50;
    const dwell = Number.isFinite(Number(stop.dwell_seconds)) ? Number(stop.dwell_seconds) : 0;
    row.innerHTML = `
        <div class="route-order-controls">
            <button type="button" class="btn btn-secondary" onclick="rtpMoveStop(this, -1)" title="Move up"><i class="mdi mdi-chevron-up"></i></button>
            <button type="button" class="btn btn-secondary" onclick="rtpMoveStop(this, 1)" title="Move down"><i class="mdi mdi-chevron-down"></i></button>
        </div>
        <label><span>Name</span><input class="form-input rp-stop-name" value="${rtpEsc(stop.name || '')}" placeholder="Stop name"></label>
        <label><span>Type</span><select class="form-input rp-stop-kind">
            <option value="stop" ${stopKind === 'stop' ? 'selected' : ''}>Stop</option>
            <option value="waypoint" ${stopKind === 'waypoint' ? 'selected' : ''}>Waypoint</option>
        </select></label>
        <label><span>Latitude</span><input class="form-input rp-lat" type="number" step="0.000001" value="${stop.latitude ?? ''}"></label>
        <label><span>Longitude</span><input class="form-input rp-lng" type="number" step="0.000001" value="${stop.longitude ?? ''}"></label>
        <label><span>Radius m</span><input class="form-input rp-radius" type="number" min="5" max="5000" step="5" value="${radius}"></label>
        <label><span>Dwell sec</span><input class="form-input rp-dwell" type="number" min="0" max="86400" step="5" value="${dwell}"></label>
        <button class="icon-btn-danger" onclick="this.closest('.route-stop-row').remove(); rtpRefreshRouteMap();" title="Remove"><i class="mdi mdi-delete"></i></button>
    `;
    box.appendChild(row);
    row.querySelectorAll('input, select').forEach(input => input.addEventListener('input', rtpRefreshRouteMap));
    rtpNormalizeStopOrder();
    rtpRefreshRouteMap();
}

function rtpCollectStops() {
    rtpNormalizeStopOrder();
    return [...document.querySelectorAll('#rpStops .route-stop-row')].map((row, index) => ({
        sequence: index,
        name: row.querySelector('.rp-stop-name').value.trim() || null,
        latitude: parseFloat(row.querySelector('.rp-lat').value),
        longitude: parseFloat(row.querySelector('.rp-lng').value),
        stop_kind: row.querySelector('.rp-stop-kind')?.value || 'stop',
        arrival_radius_m: Math.max(5, Math.min(5000, parseInt(row.querySelector('.rp-radius')?.value || '50', 10) || 50)),
        dwell_seconds: Math.max(0, Math.min(86400, parseInt(row.querySelector('.rp-dwell')?.value || '0', 10) || 0)),
    })).filter(s => Number.isFinite(s.latitude) && Number.isFinite(s.longitude));
}

function rtpStopSignature(stops) {
    return stops.map(s => `${s.sequence}:${s.latitude.toFixed(6)},${s.longitude.toFixed(6)}`).join('|');
}

function rtpNormalizeStopOrder() {
    [...document.querySelectorAll('#rpStops .route-stop-row')].forEach((row, index) => {
        row.dataset.sequence = String(index);
    });
}

function rtpMoveStop(button, direction) {
    const row = button.closest('.route-stop-row');
    const box = document.getElementById('rpStops');
    if (!row || !box) return;
    if (direction < 0 && row.previousElementSibling) {
        box.insertBefore(row, row.previousElementSibling);
    } else if (direction > 0 && row.nextElementSibling) {
        box.insertBefore(row.nextElementSibling, row);
    }
    rtpNormalizeStopOrder();
    rtpRefreshRouteMap();
}

function rtpDecodeValhallaShape(encoded) {
    if (!encoded) return [];
    const coordinates = [];
    let index = 0, lat = 0, lng = 0;
    const precision = 1e6;
    while (index < encoded.length) {
        let b, shift = 0, result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20 && index < encoded.length);
        lat += (result & 1) ? ~(result >> 1) : (result >> 1);

        shift = 0;
        result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20 && index < encoded.length);
        lng += (result & 1) ? ~(result >> 1) : (result >> 1);
        coordinates.push([lat / precision, lng / precision]);
    }
    return coordinates;
}

function rtpGeometryLatLngs(geometry) {
    if (!geometry) return [];
    if (geometry.provider === 'valhalla') {
        const shapes = geometry.encoded_shapes || (geometry.encoded_shape ? [geometry.encoded_shape] : []);
        return shapes.flatMap(shape => rtpDecodeValhallaShape(shape));
    }
    if (Array.isArray(geometry.coordinates)) {
        return geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    }
    return [];
}

function rtpStopColor(stop) {
    return String(stop.stop_kind || 'stop').toLowerCase() === 'waypoint' ? '#f59e0b' : '#38bdf8';
}

function rtpStopIcon(stop, index) {
    const color = rtpStopColor(stop);
    return L.divIcon({
        className: 'route-plan-stop-marker',
        html: `<span style="background:${color};">${index + 1}</span>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
    });
}

function rtpExtendBoundsByRadius(bounds, lat, lng, radiusM) {
    const radius = Number(radiusM || 0);
    if (!Number.isFinite(radius) || radius <= 0) return;
    const latitude = Number(lat);
    const longitude = Number(lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

    const latDelta = radius / 111320;
    const lngScale = Math.max(Math.abs(Math.cos(latitude * Math.PI / 180)), 0.01);
    const lngDelta = radius / (111320 * lngScale);
    bounds.extend([latitude - latDelta, longitude - lngDelta]);
    bounds.extend([latitude + latDelta, longitude + lngDelta]);
}

function rtpRouteBounds(stops, lineLatLngs = []) {
    const bounds = L.latLngBounds([]);
    lineLatLngs.forEach(ll => {
        const point = L.latLng(ll);
        if (point && Number.isFinite(point.lat) && Number.isFinite(point.lng)) bounds.extend(point);
    });
    stops.forEach(stop => {
        if (!Number.isFinite(Number(stop.latitude)) || !Number.isFinite(Number(stop.longitude))) return;
        const ll = L.latLng(Number(stop.latitude), Number(stop.longitude));
        bounds.extend(ll);
        rtpExtendBoundsByRadius(bounds, ll.lat, ll.lng, stop.arrival_radius_m || 50);
    });
    return bounds;
}

function rtpScheduleRoutePreview(stops, signature) {
    if (stops.length < 2) return;
    clearTimeout(_rtpPreviewTimer);
    _rtpPreviewSignature = signature;
    _rtpPreviewTimer = setTimeout(async () => {
        try {
            const preview = await rtpJson(`${API_BASE}/planned-routes/preview`, {
                method: 'POST',
                body: JSON.stringify({ stops }),
            });
            if (_rtpPreviewSignature !== signature) return;
            _rtpRouteGeometry = preview.route_geometry;
            _rtpRouteGeometrySignature = signature;
            rtpRefreshRouteMap(false);
        } catch {
            // Keep the straight-line fallback if Valhalla or preview is unavailable.
        }
    }, 500);
}

function rtpRefreshRouteMap(schedulePreview = true) {
    if (!_rtpMap || !_rtpStopLayer) return;
    rtpNormalizeStopOrder();
    const stops = rtpCollectStops().sort((a, b) => a.sequence - b.sequence);
    const signature = rtpStopSignature(stops);
    _rtpStopLayer.clearLayers();
    if (_rtpRouteLine) {
        _rtpRouteLine.remove();
        _rtpRouteLine = null;
    }
    stops.forEach((s, idx) => {
        const color = rtpStopColor(s);
        const ll = [s.latitude, s.longitude];
        L.circle(ll, {
            radius: Number(s.arrival_radius_m || 50),
            color,
            weight: 1,
            opacity: 0.75,
            fillColor: color,
            fillOpacity: 0.08,
            interactive: false,
        }).addTo(_rtpStopLayer);
        L.marker(ll, { draggable: !_rtpRouteReadonly, icon: rtpStopIcon(s, idx) })
            .addTo(_rtpStopLayer)
            .on('dragend', ev => {
                const rows = [...document.querySelectorAll('#rpStops .route-stop-row')];
                const row = rows[idx];
                if (!row) return;
                const ll = ev.target.getLatLng();
                row.querySelector('.rp-lat').value = ll.lat.toFixed(6);
                row.querySelector('.rp-lng').value = ll.lng.toFixed(6);
                rtpRefreshRouteMap();
            });
    });
    if (stops.length > 1) {
        const geometryLatLngs = _rtpRouteGeometrySignature === signature ? rtpGeometryLatLngs(_rtpRouteGeometry) : [];
        const lineLatLngs = geometryLatLngs.length > 1 ? geometryLatLngs : stops.map(s => [s.latitude, s.longitude]);
        _rtpRouteLine = L.polyline(lineLatLngs, { color: '#3b82f6', weight: 4 }).addTo(_rtpMap);
        if (schedulePreview) rtpScheduleRoutePreview(stops, signature);
    }
}

function rtpFitRouteMap() {
    if (!_rtpMap) return;
    _rtpMap.invalidateSize();
    const stops = rtpCollectStops().sort((a, b) => a.sequence - b.sequence);
    const signature = rtpStopSignature(stops);
    const geometryLatLngs = _rtpRouteGeometrySignature === signature ? rtpGeometryLatLngs(_rtpRouteGeometry) : [];
    const lineLatLngs = geometryLatLngs.length > 1 ? geometryLatLngs : [];
    const bounds = rtpRouteBounds(stops, lineLatLngs);
    if (bounds.isValid()) {
        _rtpMap.fitBounds(bounds.pad(0.16), {
            padding: [24, 24],
            maxZoom: 16,
            animate: false,
        });
    }
}

function rtpFitRouteMapSoon() {
    [0, 120, 300, 650].forEach(delay => {
        setTimeout(() => {
            if (!_rtpMap || !document.getElementById('routeModal')?.classList.contains('active')) return;
            rtpFitRouteMap();
        }, delay);
    });
}

function rtpClearRouteForm() {
    _rtpEditingRouteId = null;
    rtpSetRouteReadonly(false);
    document.getElementById('rpName').value = '';
    document.getElementById('rpDevice').value = '';
    document.getElementById('rpStops').innerHTML = '';
    document.getElementById('rpSaveLabel').textContent = 'Save Route';
    const deleteBtn = document.getElementById('rpDeleteBtn');
    if (deleteBtn) deleteBtn.style.display = 'none';
    _rtpRouteGeometry = null;
    _rtpRouteGeometrySignature = '';
    rtpNormalizeStopOrder();
    rtpRefreshRouteMap();
}

function rtpIsRouteLocked(status) {
    return ['active', 'started', 'in_progress', 'paused', 'stopped'].includes(String(status || '').toLowerCase());
}

function rtpSetRouteReadonly(readonly) {
    _rtpRouteReadonly = Boolean(readonly);
    ['rpName', 'rpDevice'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.disabled = _rtpRouteReadonly;
            el.style.opacity = _rtpRouteReadonly ? '0.65' : '';
        }
    });
    ['rpAddStopBtn', 'rpNewBtn', 'rpSaveBtn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = _rtpRouteReadonly ? 'none' : '';
    });
    document.querySelectorAll('#rpStops input, #rpStops select, #rpStops button').forEach(el => {
        el.disabled = _rtpRouteReadonly;
        el.style.opacity = _rtpRouteReadonly ? '0.65' : '';
    });
    rtpRefreshRouteMap(false);
}

async function rtpOpenRouteModal(id = null) {
    try {
        await rtpLoadCommon();
        rtpPopulateRouteSelectors();
        const modal = document.getElementById('routeModal');
        if (modal) modal.classList.add('active');
        rtpInitRouteMap();
        setTimeout(() => _rtpMap?.invalidateSize(), 100);
        if (id) {
            const r = await rtpJson(`${API_BASE}/planned-routes/${id}`);
            const readonly = rtpIsRouteLocked(r.status);
            _rtpEditingRouteId = r.id;
            document.getElementById('rpName').value = r.name || '';
            document.getElementById('rpDevice').value = r.device_id || '';
            document.getElementById('rpStops').innerHTML = '';
            _rtpRouteGeometry = r.route_geometry || null;
            rtpSetRouteReadonly(readonly);
            (r.stops || []).forEach(stop => rtpAddStop(stop));
            _rtpRouteGeometrySignature = rtpStopSignature(rtpCollectStops());
            document.getElementById('rpSaveLabel').textContent = 'Update Route';
            const title = document.getElementById('routeModalTitle');
            if (title) title.textContent = readonly ? 'View Route' : 'Edit Route';
            const deleteBtn = document.getElementById('rpDeleteBtn');
            if (deleteBtn) deleteBtn.style.display = '';
            rtpSetRouteReadonly(readonly);
            rtpRefreshRouteMap(false);
            rtpFitRouteMapSoon();
        } else {
            rtpClearRouteForm();
            const title = document.getElementById('routeModalTitle');
            if (title) title.textContent = 'Route Planner';
            const deleteBtn = document.getElementById('rpDeleteBtn');
            if (deleteBtn) deleteBtn.style.display = 'none';
        }
    } catch (e) { showAlert(e.message, 'error'); }
}

function rtpCloseRouteModal() {
    const modal = document.getElementById('routeModal');
    if (modal) modal.classList.remove('active');
}

function rtpCompanyForSelectedRouteDevice() {
    const deviceId = parseInt(document.getElementById('rpDevice').value || '0', 10) || null;
    const device = _rtpDevices.find(d => d.id === deviceId);
    return device?.company_id || rtpCurrentCompanyId();
}

function rtpRouteActions(route) {
    const status = String(route.status || 'draft').toLowerCase();
    const isEditable = !rtpIsRouteLocked(status);
    const actions = [
        `<button class="btn btn-secondary" onclick="rtpEditRoute(${route.id})"><i class="mdi ${isEditable ? 'mdi-pencil' : 'mdi-eye'}"></i> <span class="drv-btn-label">${isEditable ? 'Edit' : 'View'}</span></button>`,
    ];
    if ((status === 'planned' || status === 'draft') && route.device_id) {
        actions.push(`<button class="btn btn-secondary" onclick="rtpStartRoute(${route.id})"><i class="mdi mdi-play"></i> Start</button>`);
    }
    if (status === 'active' || status === 'started' || status === 'in_progress') {
        actions.push(`<button class="btn btn-secondary" onclick="rtpSetRouteStatus(${route.id}, 'completed')"><i class="mdi mdi-flag-checkered"></i> Finish</button>`);
    }
    if ((status === 'paused' || status === 'stopped') && route.device_id) {
        actions.push(`<button class="btn btn-secondary" onclick="rtpStartRoute(${route.id})"><i class="mdi mdi-play"></i> Resume</button>`);
    }
    if (status === 'completed') {
        actions.push(`<button class="btn btn-secondary" onclick="rtpOpenRouteDetails(${route.id})"><i class="mdi mdi-clipboard-text-clock-outline"></i> Details</button>`);
        actions.push(`<button class="btn btn-secondary" onclick="rtpSetRouteStatus(${route.id}, 'draft')"><i class="mdi mdi-restore"></i> Reopen</button>`);
    }
    return actions.join('');
}

function rtpRouteById(id) {
    return _rtpRouteRows.find(r => Number(r.id) === Number(id));
}

function rtpRouteStatusClass(status) {
    const value = String(status || 'draft').toLowerCase();
    if (value === 'active' || value === 'started' || value === 'in_progress') return 'route-status-active';
    if (value === 'planned' || value === 'draft') return 'route-status-planned';
    if (value === 'paused' || value === 'stopped') return 'route-status-paused';
    if (value === 'completed') return 'route-status-completed';
    if (value === 'cancelled') return 'route-status-cancelled';
    return 'route-status-default';
}

function rtpBroadcastRouteUpdate(route) {
    if (!route) return;
    try {
        const bc = new BroadcastChannel('routario_route_updates');
        bc.postMessage({ type: 'route_update', route });
        bc.close();
    } catch (_) {}
}

async function rtpStartRoute(id) {
    const route = rtpRouteById(id);
    if (!route?.device_id) {
        showAlert('Assign a vehicle before starting this route', 'error');
        return;
    }
    await rtpSetRouteStatus(id, 'active');
}

function rtpRouteTimelineDates(route) {
    const stops = (route?.stops || []).slice().sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
    const activityDates = stops
        .flatMap(stop => [stop.arrived_at, stop.completed_at])
        .filter(Boolean)
        .map(value => rtpDate(value))
        .filter(date => !Number.isNaN(date.getTime()))
        .sort((a, b) => a - b);
    const completedDates = stops
        .map(stop => stop.completed_at ? rtpDate(stop.completed_at) : null)
        .filter(date => date && !Number.isNaN(date.getTime()))
        .sort((a, b) => b - a);
    const routeUpdated = route?.updated_at ? rtpDate(route.updated_at) : null;
    return {
        firstActivity: activityDates[0] || null,
        completedAt: String(route?.status || '').toLowerCase() === 'completed'
            ? (completedDates[0] || (!Number.isNaN(routeUpdated?.getTime()) ? routeUpdated : null))
            : null,
    };
}

async function rtpOpenRouteDetails(id) {
    try {
        const route = await rtpJson(`${API_BASE}/planned-routes/${id}`);
        const modal = document.getElementById('routeDetailsModal');
        const body = document.getElementById('routeDetailsBody');
        if (!modal || !body) return;
        const device = _rtpDevices.find(d => Number(d.id) === Number(route.device_id));
        const stops = (route.stops || []).slice().sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
        const completedStops = stops.filter(stop => String(stop.status || '').toLowerCase() === 'completed').length;
        const timeline = rtpRouteTimelineDates(route);
        const status = String(route.status || 'draft');
        const rows = stops.map((stop, idx) => `
            <tr>
                <td>${idx + 1}</td>
                <td>${rtpEsc(stop.name || `Point ${idx + 1}`)}</td>
                <td>${rtpEsc(stop.stop_kind || 'stop')}</td>
                <td><span class="proto-badge">${rtpEsc(stop.status || 'pending')}</span></td>
                <td>${rtpEsc(rtpDateTime(stop.arrived_at))}</td>
                <td>${rtpEsc(rtpDateTime(stop.completed_at))}</td>
                <td>${Number(stop.arrival_radius_m || 50)}m</td>
                <td>${Number(stop.dwell_seconds || 0)}s</td>
                <td>${Number(stop.latitude).toFixed(6)}, ${Number(stop.longitude).toFixed(6)}</td>
                <td>${rtpEsc(stop.notes || '-')}</td>
            </tr>
        `).join('');
        body.innerHTML = `
            <div class="form-grid" style="margin-bottom:1rem;">
                <div class="stack-item"><div class="stack-item-title">Status</div><div class="stack-item-meta">${rtpEsc(status)}</div></div>
                <div class="stack-item"><div class="stack-item-title">Vehicle</div><div class="stack-item-meta">${rtpEsc(device?.name || '-')}</div></div>
                <div class="stack-item"><div class="stack-item-title">Progress</div><div class="stack-item-meta">${completedStops}/${stops.length} points complete</div></div>
                <div class="stack-item"><div class="stack-item-title">Planned Distance</div><div class="stack-item-meta">${Number(route.distance_km || 0).toFixed(1)} km</div></div>
                <div class="stack-item"><div class="stack-item-title">Planned Duration</div><div class="stack-item-meta">${Number(route.duration_minutes || 0).toFixed(0)} min</div></div>
                <div class="stack-item"><div class="stack-item-title">Created</div><div class="stack-item-meta">${rtpEsc(rtpDateTime(route.created_at))}</div></div>
                <div class="stack-item"><div class="stack-item-title">Updated</div><div class="stack-item-meta">${rtpEsc(rtpDateTime(route.updated_at))}</div></div>
                <div class="stack-item"><div class="stack-item-title">First Activity</div><div class="stack-item-meta">${rtpEsc(rtpDateTime(timeline.firstActivity))}</div></div>
                <div class="stack-item"><div class="stack-item-title">Completed</div><div class="stack-item-meta">${rtpEsc(rtpDateTime(timeline.completedAt))}</div></div>
            </div>
            <div style="overflow-x:auto;">
                <table class="devices-table">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Point</th>
                            <th>Type</th>
                            <th>Status</th>
                            <th>Arrived</th>
                            <th>Completed</th>
                            <th>Radius</th>
                            <th>Dwell</th>
                            <th>Coordinates</th>
                            <th>Notes</th>
                        </tr>
                    </thead>
                    <tbody>${rows || '<tr><td colspan="10" style="text-align:center;color:var(--text-muted);">No route points configured.</td></tr>'}</tbody>
                </table>
            </div>
        `;
        document.getElementById('routeDetailsTitle').textContent = route.name || 'Route Details';
        modal.classList.add('active');
    } catch (e) { showAlert(e.message, 'error'); }
}

function rtpCloseRouteDetails() {
    document.getElementById('routeDetailsModal')?.classList.remove('active');
}

async function rtpSaveRoute() {
    try {
        const name = document.getElementById('rpName').value.trim();
        if (!name) throw new Error('Route name is required');
        const stops = rtpCollectStops();
        if (stops.length < 2) throw new Error('Add at least two valid stops');
        const payload = {
            name,
            company_id: rtpCompanyForSelectedRouteDevice(),
            device_id: parseInt(document.getElementById('rpDevice').value || '0', 10) || null,
            stops,
        };
        if (!_rtpEditingRouteId) payload.status = 'planned';
        const url = _rtpEditingRouteId ? `${API_BASE}/planned-routes/${_rtpEditingRouteId}` : `${API_BASE}/planned-routes`;
        await rtpJson(url, { method: _rtpEditingRouteId ? 'PUT' : 'POST', body: JSON.stringify(payload) });
        showAlert(_rtpEditingRouteId ? 'Route updated' : 'Route saved', 'success');
        rtpClearRouteForm();
        rtpCloseRouteModal();
        await rtpLoadRoutes();
    } catch (e) { showAlert(e.message, 'error'); }
}

async function rtpLoadRoutes() {
    const body = document.getElementById('routesTableBody');
    if (!body) return;
    body.innerHTML = RoutarioTables.stateRow('Loading routes...', 7);
    try {
        _rtpRouteRows = await rtpJson(`${API_BASE}/planned-routes`);
        rtpRenderRoutesTable();
    } catch (e) { body.innerHTML = RoutarioTables.stateRow(rtpEsc(e.message), 7); }
}

function rtpRouteValue(route, col) {
    const device = _rtpDevices.find(d => d.id === route.device_id);
    const stops = route.stops || [];
    const values = {
        name: route.name,
        status: route.status,
        vehicle: device?.name || '',
        stops: stops.length,
        distance: Number(route.distance_km) || 0,
        duration: Number(route.duration_minutes) || 0,
    };
    return values[col];
}

function rtpRouteStopsProgress(route) {
    const stops = route.stops || [];
    const completed = stops.filter(stop => String(stop.status || '').toLowerCase() === 'completed').length;
    return `${completed}/${stops.length}`;
}

function rtpRenderRoutesTable() {
    const body = document.getElementById('routesTableBody');
    if (!body) return;
    const q = (document.getElementById('routesSearch')?.value || '').toLowerCase();
    const rows = _rtpRouteRows.filter(r => [
        r.name, r.status, rtpRouteValue(r, 'vehicle'), (r.stops || []).length,
    ].join(' ').toLowerCase().includes(q));
    rows.sort((a, b) => rtpCompareValues(rtpRouteValue(a, _rtpRouteSort.col), rtpRouteValue(b, _rtpRouteSort.col), _rtpRouteSort.dir));
    const count = document.getElementById('routesCount');
    if (count) count.textContent = `${rows.length} route${rows.length !== 1 ? 's' : ''}`;
    rtpUpdateSortHeaders('section-routes', _rtpRouteSort);
    body.innerHTML = rows.length ? rows.map(r => `
        <tr class="device-row" ondblclick="rtpEditRoute(${r.id})" style="cursor:pointer;">
            <td>${rtpEsc(r.name)}</td>
            <td><span class="proto-badge route-status-badge ${rtpRouteStatusClass(r.status)}">${rtpEsc(r.status)}</span></td>
            <td>${rtpEsc(rtpRouteValue(r, 'vehicle') || '-')}</td>
            <td>${rtpRouteStopsProgress(r)}</td>
            <td class="route-distance-col">${(r.distance_km || 0).toFixed(1)} km</td>
            <td class="route-duration-col">${(r.duration_minutes || 0).toFixed(0)} min</td>
            <td style="text-align:center;"><div class="table-actions" onclick="event.stopPropagation()">${rtpRouteActions(r)}</div></td>
        </tr>
    `).join('') : RoutarioTables.stateRow('No planned routes match.', 7);
}

function rtpSortRoutes(col) {
    _rtpRouteSort = { col, dir: _rtpRouteSort.col === col && _rtpRouteSort.dir === 'asc' ? 'desc' : 'asc' };
    rtpRenderRoutesTable();
}

async function rtpEditRoute(id) {
    await rtpOpenRouteModal(id);
}

async function rtpSetRouteStatus(id, status) {
    try {
        const route = await rtpJson(`${API_BASE}/planned-routes/${id}`, { method: 'PUT', body: JSON.stringify({ status }) });
        rtpBroadcastRouteUpdate(route);
        await rtpLoadRoutes();
    } catch (e) { showAlert(e.message, 'error'); }
}

async function rtpDeleteRoute(id) {
    if (!confirm('Delete this route?')) return;
    try {
        await rtpJson(`${API_BASE}/planned-routes/${id}`, { method: 'DELETE' });
        await rtpLoadRoutes();
    } catch (e) { showAlert(e.message, 'error'); }
}

async function rtpDeleteCurrentRoute() {
    if (!_rtpEditingRouteId) return;
    const id = _rtpEditingRouteId;
    if (!confirm('Delete this route?')) return;
    try {
        await rtpJson(`${API_BASE}/planned-routes/${id}`, { method: 'DELETE' });
        rtpCloseRouteModal();
        rtpClearRouteForm();
        await rtpLoadRoutes();
    } catch (e) { showAlert(e.message, 'error'); }
}

// ── API Keys ─────────────────────────────────────────────────────

async function rtpInitApiKeys() {
    if (_rtpApiLoaded) return;
    _rtpApiLoaded = true;
    try {
        const data = await rtpJson(`${API_BASE}/api-keys/scopes`);
        document.getElementById('akScopes').innerHTML = data.scopes.map(s => `<option value="${s}" selected>${s}</option>`).join('');
        await rtpLoadApiKeys();
    } catch (e) { showAlert(e.message, 'error'); }
}

async function rtpLoadApiKeys() {
    const list = document.getElementById('apiKeysList');
    const keys = await rtpJson(`${API_BASE}/api-keys`);
    list.innerHTML = keys.length ? keys.map(k => `
        <div class="stack-item">
            <div class="stack-item-title">${rtpEsc(k.name)} <span class="proto-badge">${k.is_active ? 'active' : 'revoked'}</span></div>
            <div class="stack-item-meta">${rtpEsc(k.key_prefix)}... · ${(k.scopes || []).join(', ') || 'no scopes'} · last used ${k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}</div>
            ${k.is_active ? `<button class="btn btn-danger" style="margin-top:0.5rem;padding:0.4rem 0.6rem;" onclick="rtpRevokeApiKey(${k.id})">Revoke</button>` : ''}
        </div>
    `).join('') : '<div class="stack-item stack-item-meta">No API keys.</div>';
}

async function rtpCreateApiKey() {
    try {
        const scopes = [...document.getElementById('akScopes').selectedOptions].map(o => o.value);
        const key = await rtpJson(`${API_BASE}/api-keys`, {
            method: 'POST',
            body: JSON.stringify({ name: document.getElementById('akName').value.trim() || 'API Key', scopes }),
        });
        document.getElementById('apiKeyReveal').style.display = '';
        document.getElementById('apiKeyReveal').innerHTML = `<strong>Copy now:</strong><br>${rtpEsc(key.key)}`;
        await rtpLoadApiKeys();
    } catch (e) { showAlert(e.message, 'error'); }
}

async function rtpRevokeApiKey(id) {
    if (!confirm('Revoke this API key?')) return;
    await rtpJson(`${API_BASE}/api-keys/${id}`, { method: 'DELETE' });
    await rtpLoadApiKeys();
}

// ── Billing ──────────────────────────────────────────────────────

async function rtpInitBilling() {
    if (_rtpBillingLoaded) return;
    _rtpBillingLoaded = true;
    await rtpLoadCommon();
    await rtpLoadExchangeRates();
    await rtpLoadPlans();
}

async function rtpLoadPlans() {
    _rtpPlans = await rtpJson(`${API_BASE}/billing/plans`);
    rtpRenderBillingTable();
}

function rtpBillingValue(plan, col) {
    const assigned = rtpCompaniesForPlan(plan.id);
    const values = {
        name: plan.name,
        base: Number(plan.base_price_cents) || 0,
        included: (Number(plan.included_devices) || 0) + (Number(plan.included_positions) || 0) + (Number(plan.included_api_calls) || 0),
        overage: (Number(plan.price_per_device_cents) || 0) + (Number(plan.price_per_1000_positions_cents) || 0) + (Number(plan.price_per_1000_api_calls_cents) || 0),
        companies: assigned.map(c => c.name).join(', '),
    };
    return values[col];
}

function rtpRenderBillingTable() {
    const body = document.getElementById('billingPlansTableBody');
    if (body) {
        const q = (document.getElementById('billingSearch')?.value || '').toLowerCase();
        const rows = _rtpPlans.filter(p => [
            p.name,
            rtpMoney(p.base_price_cents, p.currency),
            p.included_devices,
            p.included_positions,
            p.included_api_calls,
            rtpBillingValue(p, 'companies'),
        ].join(' ').toLowerCase().includes(q));
        rows.sort((a, b) => rtpCompareValues(rtpBillingValue(a, _rtpBillingSort.col), rtpBillingValue(b, _rtpBillingSort.col), _rtpBillingSort.dir));
        const count = document.getElementById('billingCount');
        if (count) count.textContent = `${rows.length} plan${rows.length !== 1 ? 's' : ''}`;
        rtpUpdateSortHeaders('section-billing', _rtpBillingSort);
        body.innerHTML = rows.length ? rows.map(p => {
            const assigned = rtpCompaniesForPlan(p.id);
            const rowAction = assigned.length ? `rtpOpenPlanDetailsModal(${p.id})` : `rtpEditPlan(${p.id})`;
            const detailsButton = assigned.length
                ? `<button class="btn btn-secondary" onclick="rtpOpenPlanDetailsModal(${p.id})"><i class="mdi mdi-eye"></i> Details</button>`
                : '';
            return `
                <tr class="device-row" ondblclick="${rowAction}" style="cursor:pointer;">
                    <td>${rtpEsc(p.name)}</td>
                    <td>${rtpMoney(p.base_price_cents, p.currency)}</td>
                    <td>${p.included_devices} devices<br>${p.included_positions} positions<br>${p.included_api_calls} API calls</td>
                    <td>${rtpMoney(p.price_per_device_cents, p.currency)} / device<br>${rtpMoney(p.price_per_1000_positions_cents, p.currency)} / 1000 positions<br>${rtpMoney(p.price_per_1000_api_calls_cents, p.currency)} / 1000 API calls</td>
                    <td>${assigned.length ? assigned.map(c => rtpEsc(c.name)).join('<br>') : '<span class="stack-item-meta">Unassigned</span>'}</td>
                    <td style="text-align:center;">
                        <div class="table-actions" onclick="event.stopPropagation()">
                            ${detailsButton}
                            <button class="btn btn-secondary" onclick="rtpEditPlan(${p.id})"><i class="mdi mdi-pencil"></i> <span class="drv-btn-label">Edit</span></button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('') : RoutarioTables.stateRow('No billing plans match.', 6);
    }
}

function rtpSortBilling(col) {
    _rtpBillingSort = { col, dir: _rtpBillingSort.col === col && _rtpBillingSort.dir === 'asc' ? 'desc' : 'asc' };
    rtpRenderBillingTable();
}

async function rtpLoadExchangeRates() {
    _rtpCurrencyRates = await rtpJson(`${API_BASE}/currency/rates`);
    if (typeof setCurrencyRates === 'function') setCurrencyRates(_rtpCurrencyRates);
}

function rtpRenderExchangeRates() {
    const body = document.getElementById('exchangeRatesTableBody');
    if (!body) return;
    body.innerHTML = _rtpCurrencyRates.length ? _rtpCurrencyRates.map((row, idx) => `
        <tr>
            <td><input class="form-input" value="${rtpEsc(row.currency || '')}" maxlength="3" ${row.currency === 'EUR' ? 'readonly' : ''} oninput="rtpUpdateExchangeRateDraft(${idx}, 'currency', this.value.toUpperCase())"></td>
            <td><input class="form-input" type="number" min="0.000001" step="0.000001" value="${Number(row.rate || 1)}" ${row.currency === 'EUR' ? 'readonly' : ''} oninput="rtpUpdateExchangeRateDraft(${idx}, 'rate', this.value)"></td>
            <td>${rtpEsc(row.source || 'manual')}</td>
            <td>${row.currency === 'EUR' ? '-' : row.updated_at ? rtpDateTime(row.updated_at) : '-'}</td>
            <td style="text-align:center;">
                ${row.currency === 'EUR' ? '' : `<button type="button" class="btn btn-secondary tbl-btn" onclick="rtpRemoveExchangeRateRow(${idx})"><i class="mdi mdi-delete"></i></button>`}
            </td>
        </tr>
    `).join('') : RoutarioTables.stateRow('No exchange rates configured.', 5, { padding: '1rem' });
}

function rtpUpdateExchangeRateDraft(idx, key, value) {
    if (!_rtpCurrencyRates[idx]) return;
    _rtpCurrencyRates[idx][key] = key === 'rate' ? Number(value || 0) : String(value || '').toUpperCase();
}

function rtpAddExchangeRateRow() {
    _rtpCurrencyRates.push({ currency: '', rate: 1, source: 'manual', updated_at: null });
    rtpRenderExchangeRates();
}

function rtpRemoveExchangeRateRow(idx) {
    _rtpCurrencyRates.splice(idx, 1);
    rtpRenderExchangeRates();
}

async function rtpOpenExchangeRatesModal() {
    try {
        await rtpLoadExchangeRates();
        rtpRenderExchangeRates();
        document.getElementById('exchangeRatesModal')?.classList.add('active');
    } catch (e) { showAlert(e.message, 'error'); }
}

function rtpCloseExchangeRatesModal() {
    document.getElementById('exchangeRatesModal')?.classList.remove('active');
}

function rtpValidatedExchangeRates() {
    const seen = new Set();
    const rows = _rtpCurrencyRates.map(row => ({
        currency: String(row.currency || '').trim().toUpperCase(),
        rate: Number(row.rate),
    })).filter(row => row.currency);
    if (!rows.find(row => row.currency === 'EUR')) rows.unshift({ currency: 'EUR', rate: 1 });
    rows.forEach(row => {
        if (!/^[A-Z]{3}$/.test(row.currency)) throw new Error(`Invalid currency code: ${row.currency || '(blank)'}`);
        if (!Number.isFinite(row.rate) || row.rate <= 0) throw new Error(`Invalid rate for ${row.currency}`);
        if (seen.has(row.currency)) throw new Error(`Duplicate currency: ${row.currency}`);
        seen.add(row.currency);
    });
    return rows.map(row => row.currency === 'EUR' ? { ...row, rate: 1 } : row);
}

async function rtpSaveExchangeRates() {
    try {
        const rates = rtpValidatedExchangeRates();
        _rtpCurrencyRates = await rtpJson(`${API_BASE}/currency/rates`, {
            method: 'PUT',
            body: JSON.stringify({ rates }),
        });
        if (typeof setCurrencyRates === 'function') setCurrencyRates(_rtpCurrencyRates);
        rtpRenderExchangeRates();
        rtpRenderBillingTable();
        rtpCloseExchangeRatesModal();
        showAlert('Exchange rates saved', 'success');
    } catch (e) { showAlert(e.message, 'error'); }
}

async function rtpRefreshExchangeRates() {
    try {
        const currencies = rtpValidatedExchangeRates().map(row => row.currency);
        _rtpCurrencyRates = await rtpJson(`${API_BASE}/currency/rates/refresh`, {
            method: 'POST',
            body: JSON.stringify({ currencies }),
        });
        if (typeof setCurrencyRates === 'function') setCurrencyRates(_rtpCurrencyRates);
        rtpRenderExchangeRates();
        rtpRenderBillingTable();
        showAlert('Exchange rates updated', 'success');
    } catch (e) { showAlert(e.message, 'error'); }
}

function rtpBillingCompanies() {
    return _rtpCompanies.length ? _rtpCompanies : [{ id: rtpCurrentCompanyId(), name: 'Current company', billing_plan_id: null }].filter(c => c.id);
}

function rtpCompaniesForPlan(planId) {
    return rtpBillingCompanies().filter(c => Number(c.billing_plan_id) === Number(planId));
}

function rtpFillPlanForm(plan = null) {
    rtpApplyBillingCurrencyLabels();
    _rtpEditingPlanId = plan?.id || null;
    document.getElementById('billPlanName').value = plan?.name || '';
    document.getElementById('billBase').value = plan ? rtpCurrencyInput(plan.base_price_cents) : '';
    document.getElementById('billIncDevices').value = plan?.included_devices ?? 0;
    document.getElementById('billDevicePrice').value = plan ? rtpCurrencyInput(plan.price_per_device_cents) : 0;
    document.getElementById('billIncPositions').value = plan?.included_positions ?? 0;
    document.getElementById('billPositionPrice').value = plan ? rtpCurrencyInput(plan.price_per_1000_positions_cents) : 0;
    document.getElementById('billIncApi').value = plan?.included_api_calls ?? 0;
    document.getElementById('billApiPrice').value = plan ? rtpCurrencyInput(plan.price_per_1000_api_calls_cents) : 0;
    const search = document.getElementById('billPlanCompanySearch');
    if (search) search.value = '';
    _rtpPlanCompanySelection = new Set(plan ? rtpCompaniesForPlan(plan.id).map(c => Number(c.id)) : []);
    rtpRenderPlanCompanyChecklist(plan);
    const label = document.getElementById('billPlanSaveLabel');
    if (label) label.textContent = plan ? 'Update Plan' : 'Create Plan';
    const deleteBtn = document.getElementById('billPlanDeleteBtn');
    if (deleteBtn) deleteBtn.style.display = plan ? '' : 'none';
}

function rtpRenderPlanCompanyChecklist(plan = _rtpPlans.find(p => p.id === _rtpEditingPlanId) || null) {
    const box = document.getElementById('billPlanCompanies');
    if (!box) return;
    const q = (document.getElementById('billPlanCompanySearch')?.value || '').toLowerCase();
    const companies = rtpBillingCompanies().filter(c => String(c.name || '').toLowerCase().includes(q));
    box.innerHTML = companies.length ? companies.map(c => `
        <label class="company-check-item">
            <input type="checkbox" value="${c.id}" ${_rtpPlanCompanySelection.has(Number(c.id)) ? 'checked' : ''} onchange="rtpTogglePlanCompany(this)">
            <span>${rtpEsc(c.name)}</span>
        </label>
    `).join('') : '<div class="stack-item-meta" style="padding:0.4rem 0.55rem;">No companies match.</div>';
}

function rtpFilterPlanCompanies() {
    rtpRenderPlanCompanyChecklist();
}

function rtpTogglePlanCompany(input) {
    const id = Number(input.value);
    if (input.checked) _rtpPlanCompanySelection.add(id);
    else _rtpPlanCompanySelection.delete(id);
}

function rtpEditPlan(id) {
    const plan = _rtpPlans.find(p => p.id === id);
    if (!plan) return;
    rtpOpenPlanModal(id);
}

function rtpOpenPlanModal(id = null) {
    const plan = id ? _rtpPlans.find(p => p.id === id) : null;
    rtpFillPlanForm(plan);
    const title = document.getElementById('billingPlanModalTitle');
    if (title) title.textContent = plan ? 'Edit Billing Plan' : 'Create Billing Plan';
    const modal = document.getElementById('billingPlanModal');
    if (modal) modal.classList.add('active');
}

function rtpClosePlanModal() {
    const modal = document.getElementById('billingPlanModal');
    if (modal) modal.classList.remove('active');
}

function rtpOpenPlanDetailsModal(id) {
    const plan = _rtpPlans.find(p => p.id === id);
    if (!plan) return;
    _rtpDetailPlanId = id;
    rtpOpenCompanyBillingReportModal(null, id, true);
}

function rtpOpenCompanyBillingReportModal(companyId = null, planId = null, lockPlan = false) {
    _rtpDetailPlanId = planId || null;
    const selectedPlan = planId ? _rtpPlans.find(p => Number(p.id) === Number(planId)) : null;
    document.getElementById('billingPlanDetailsTitle').textContent = lockPlan && selectedPlan
        ? `Billing Report - ${selectedPlan.name}`
        : 'Company Billing Report';
    const now = new Date();
    const companies = lockPlan && planId ? rtpCompaniesForPlan(planId) : rtpBillingCompanies();
    const selectedCompany = companyId
        ? companies.find(c => Number(c.id) === Number(companyId))
        : companies.find(c => planId && Number(c.billing_plan_id) === Number(planId)) || companies[0];
    const selectedPlanId = planId || selectedCompany?.billing_plan_id || _rtpPlans[0]?.id || '';
    const planWrap = document.getElementById('billDetailPlanWrap');
    if (planWrap) planWrap.style.display = lockPlan ? 'none' : '';
    document.getElementById('billDetailYear').value = now.getFullYear();
    document.getElementById('billDetailMonth').value = now.getMonth() + 1;
    document.getElementById('billDetailPeriod').value = 'month';
    document.getElementById('billDetailPlan').innerHTML = _rtpPlans.length
        ? _rtpPlans.map(p => `<option value="${p.id}" ${Number(p.id) === Number(selectedPlanId) ? 'selected' : ''}>${rtpEsc(p.name)}</option>`).join('')
        : '<option value="">No billing plans</option>';
    document.getElementById('billDetailCompany').innerHTML = companies.length
        ? companies.map(c => `<option value="${c.id}" ${Number(c.id) === Number(selectedCompany?.id) ? 'selected' : ''}>${rtpEsc(c.name)}</option>`).join('')
        : '<option value="">No companies</option>';
    document.getElementById('billingPlanDetailsResult').innerHTML = '';
    rtpUpdateBillingPeriodControls();
    document.getElementById('billingPlanDetailsModal').classList.add('active');
}

function rtpBillingCompanyChanged() {
    const companyId = document.getElementById('billDetailCompany')?.value;
    const company = rtpBillingCompanies().find(c => Number(c.id) === Number(companyId));
    const planSelect = document.getElementById('billDetailPlan');
    if (planSelect) {
        planSelect.value = String(company?.billing_plan_id || _rtpPlans[0]?.id || '');
    }
}

function rtpClosePlanDetailsModal() {
    const modal = document.getElementById('billingPlanDetailsModal');
    if (modal) modal.classList.remove('active');
}

function rtpUpdateBillingPeriodControls() {
    const period = document.getElementById('billDetailPeriod')?.value || 'month';
    const monthWrap = document.getElementById('billDetailMonthWrap');
    if (monthWrap) monthWrap.style.display = period === 'year' ? 'none' : '';
}

function rtpBillingReportContext() {
    const companyId = document.getElementById('billDetailCompany').value;
    const planId = document.getElementById('billDetailPlan').value || _rtpDetailPlanId;
    const year = Number(document.getElementById('billDetailYear').value);
    const month = Number(document.getElementById('billDetailMonth').value);
    const periodType = document.getElementById('billDetailPeriod')?.value || 'month';
    const plan = _rtpPlans.find(p => Number(p.id) === Number(planId));
    const company = rtpBillingCompanies().find(c => Number(c.id) === Number(companyId));
    return { companyId, planId, year, month, periodType, plan, company };
}

async function rtpFetchBillingReport(ctx) {
    if (ctx.periodType !== 'year') {
        const qs = `year=${ctx.year}&month=${ctx.month}&plan_id=${ctx.planId}`;
        const usageData = await rtpJson(`${API_BASE}/billing/companies/${ctx.companyId}/usage?year=${ctx.year}&month=${ctx.month}`);
        const invoice = await rtpJson(`${API_BASE}/billing/companies/${ctx.companyId}/invoices?${qs}`, { method: 'POST' });
        return {
            invoice,
            usage: usageData.usage || invoice.usage || {},
            monthRows: [],
            periodLabel: new Date(ctx.year, ctx.month - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' }),
        };
    }

    const months = [];
    for (let m = 1; m <= 12; m += 1) {
        const qs = `year=${ctx.year}&month=${m}&plan_id=${ctx.planId}`;
        const usageData = await rtpJson(`${API_BASE}/billing/companies/${ctx.companyId}/usage?year=${ctx.year}&month=${m}`);
        const invoice = await rtpJson(`${API_BASE}/billing/companies/${ctx.companyId}/invoices?${qs}`, { method: 'POST' });
        months.push({ month: m, label: new Date(ctx.year, m - 1, 1).toLocaleString(undefined, { month: 'short' }), usage: usageData.usage || invoice.usage || {}, invoice });
    }
    const firstInvoice = months[0]?.invoice || {};
    const usage = months.reduce((acc, row) => {
        acc.active_devices += Number(row.usage.active_devices || 0);
        acc.positions += Number(row.usage.positions || 0);
        acc.api_calls += Number(row.usage.api_calls || 0);
        return acc;
    }, { active_devices: 0, positions: 0, api_calls: 0 });
    const amount = months.reduce((sum, row) => sum + Number(row.invoice.amount_cents || 0), 0);
    const lineMap = new Map();
    months.forEach(row => {
        (row.invoice.line_items || []).forEach(line => {
            const key = `${line.label || '-'}|${line.unit || 'month'}`;
            const current = lineMap.get(key) || {
                label: line.label || '-',
                quantity: 0,
                unit: line.unit || 'month',
                billable_units: 0,
                amount_cents: 0,
            };
            current.quantity += Number(line.quantity || 0);
            current.billable_units += Number(line.billable_units || 0);
            current.amount_cents += Number(line.amount_cents || 0);
            lineMap.set(key, current);
        });
    });
    const lineItems = [...lineMap.values()]
        .filter(line => line.amount_cents > 0 || line.label === 'Free inactive period')
        .map(line => ({
            ...line,
            billable_units: line.billable_units || undefined,
        }));
    return {
        invoice: { ...firstInvoice, amount_cents: amount, line_items: lineItems, usage },
        usage,
        monthRows: months,
        periodLabel: String(ctx.year),
    };
}

async function rtpDetailGenerateBillingSummary() {
    const ctx = rtpBillingReportContext();
    const { companyId, planId, plan, company } = ctx;
    if (!companyId) return showAlert('Select a company first', 'error');
    if (!planId || !plan) return showAlert('Select a billing plan first', 'error');
    try {
        const report = await rtpFetchBillingReport(ctx);
        const inv = report.invoice;
        const u = report.usage;
        const overageDevices = Math.max(0, (u.active_devices || 0) - (plan?.included_devices || 0));
        const overagePositions = Math.max(0, (u.positions || 0) - (plan?.included_positions || 0));
        const overageApi = Math.max(0, (u.api_calls || 0) - (plan?.included_api_calls || 0));
        const lineAmount = label => report.monthRows.length
            ? report.monthRows.reduce((sum, row) => sum + Number((row.invoice.line_items || []).find(x => x.label === label)?.amount_cents || 0), 0)
            : (inv.line_items || []).find(x => x.label === label)?.amount_cents || 0;
        const activeBillingMonths = report.monthRows.length
            ? report.monthRows.filter(row => Number(row.invoice.amount_cents || 0) > 0).length
            : (lineAmount('Base subscription') > 0 ? 1 : 0);
        const rows = [
            {
                metric: 'Base subscription',
                used: activeBillingMonths,
                included: '-',
                overage: '-',
                rate: rtpInvoiceMoney(plan?.base_price_cents || 0, inv),
                amount: lineAmount('Base subscription'),
            },
            {
                metric: 'Active devices',
                used: u.active_devices || 0,
                included: plan?.included_devices || 0,
                overage: overageDevices,
                rate: rtpInvoiceMoney(plan?.price_per_device_cents || 0, inv),
                amount: lineAmount('Additional active devices'),
            },
            {
                metric: 'Position messages',
                used: u.positions || 0,
                included: plan?.included_positions || 0,
                overage: overagePositions,
                rate: `${rtpInvoiceMoney(plan?.price_per_1000_positions_cents || 0, inv)} / 1000`,
                amount: lineAmount('Additional position messages'),
            },
            {
                metric: 'API calls',
                used: u.api_calls || 0,
                included: plan?.included_api_calls || 0,
                overage: overageApi,
                rate: `${rtpInvoiceMoney(plan?.price_per_1000_api_calls_cents || 0, inv)} / 1000`,
                amount: lineAmount('Additional API calls'),
            },
        ];
        const monthRows = report.monthRows.length ? `
            <div style="overflow-x:auto;margin-top:0.75rem;">
                <table class="devices-table">
                    <thead><tr><th>Month</th><th>Devices</th><th>Positions</th><th>API Calls</th><th style="text-align:right;">Amount</th></tr></thead>
                    <tbody>
                        ${report.monthRows.map(row => `
                            <tr>
                                <td>${rtpEsc(row.label)}</td>
                                <td>${row.usage.active_devices || 0}</td>
                                <td>${row.usage.positions || 0}</td>
                                <td>${row.usage.api_calls || 0}</td>
                                <td style="text-align:right;">${rtpInvoiceMoney(row.invoice.amount_cents || 0, row.invoice)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        ` : '';
        document.getElementById('billingPlanDetailsResult').innerHTML = `
            <div class="stack-item">
                <div class="stack-item-title">${rtpEsc(company?.name || 'Company')} - ${rtpEsc(report.periodLabel)}</div>
                <div class="stack-item-meta">Plan: ${rtpEsc(plan?.name || 'Billing plan')}</div>
                <div style="overflow-x:auto;margin-top:0.75rem;">
                    <table class="devices-table">
                        <thead>
                            <tr>
                                <th>Metric</th>
                                <th>Used</th>
                                <th>Included</th>
                                <th>Overage</th>
                                <th>Rate</th>
                                <th style="text-align:right;">Amount</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.map(row => `
                                <tr>
                                    <td>${rtpEsc(row.metric)}</td>
                                    <td>${rtpEsc(row.used)}</td>
                                    <td>${rtpEsc(row.included)}</td>
                                    <td>${rtpEsc(row.overage)}</td>
                                    <td>${rtpEsc(row.rate)}</td>
                                    <td style="text-align:right;">${rtpInvoiceMoney(row.amount, inv)}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
                ${monthRows}
                <div style="display:flex;justify-content:flex-end;margin-top:0.85rem;font-weight:800;font-size:1rem;">
                    Draft Total: ${rtpInvoiceMoney(inv.amount_cents, inv)}
                </div>
            </div>
        `;
    } catch (e) { showAlert(e.message, 'error'); }
}

async function rtpPrintBillingDetails() {
    const ctx = rtpBillingReportContext();
    const { companyId, planId, plan, company } = ctx;
    if (!companyId || !plan || !company || !planId) return showAlert('Select a company and billing plan first', 'error');
    try {
        const report = await rtpFetchBillingReport(ctx);
        const invoice = report.invoice;
        const usage = report.usage;
        const period = report.periodLabel;
        const lines = invoice.line_items || [];
        const rows = lines.map(line => `
            <tr>
                <td>${rtpEsc(line.label || '-')}</td>
                <td>${rtpEsc(line.quantity ?? 1)}</td>
                <td>${rtpEsc(line.unit || 'month')}</td>
                <td>${line.billable_units ?? '-'}</td>
                <td class="money">${rtpInvoiceMoney(line.amount_cents, invoice)}</td>
            </tr>
        `).join('');
        const monthlyRows = report.monthRows.length ? report.monthRows.map(row => `
            <tr>
                <td>${rtpEsc(row.label)}</td>
                <td>${row.usage.active_devices || 0}</td>
                <td>${row.usage.positions || 0}</td>
                <td>${row.usage.api_calls || 0}</td>
                <td class="money">${rtpInvoiceMoney(row.invoice.amount_cents || 0, row.invoice)}</td>
            </tr>
        `).join('') : '';
        const overageDevices = Math.max(0, (usage.active_devices || 0) - (plan.included_devices || 0));
        const overagePositions = Math.max(0, (usage.positions || 0) - (plan.included_positions || 0));
        const overageApi = Math.max(0, (usage.api_calls || 0) - (plan.included_api_calls || 0));
        const html = `<!DOCTYPE html>
<html>
<head>
    <title>${rtpEsc(company.name)} ${rtpEsc(period)} Billing</title>
    <style>
        @page { size: A4; margin: 16mm; }
        * { box-sizing: border-box; }
        body { margin: 0; color: #111827; font-family: Arial, sans-serif; font-size: 12px; line-height: 1.45; }
        .page { width: 100%; }
        .header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #1f2937; padding-bottom: 14px; margin-bottom: 18px; }
        .brand { font-size: 24px; font-weight: 800; color: #1d4ed8; }
        .subtitle { color: #6b7280; margin-top: 4px; }
        .meta { text-align: right; color: #374151; }
        h2 { font-size: 14px; margin: 18px 0 8px; color: #111827; }
        .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-bottom: 14px; }
        .box { border: 1px solid #d1d5db; border-radius: 8px; padding: 10px; background: #f9fafb; }
        .label { color: #6b7280; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 3px; }
        .value { font-weight: 700; font-size: 14px; }
        table { width: 100%; border-collapse: collapse; margin-top: 6px; }
        th { background: #f3f4f6; color: #374151; text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
        th, td { border-bottom: 1px solid #e5e7eb; padding: 8px; vertical-align: top; }
        .money { text-align: right; white-space: nowrap; }
        .total { display: flex; justify-content: flex-end; margin-top: 14px; }
        .total-box { min-width: 240px; border: 2px solid #1f2937; border-radius: 8px; padding: 12px; }
        .total-row { display: flex; justify-content: space-between; gap: 20px; font-size: 16px; font-weight: 800; }
        .notes { margin-top: 18px; color: #6b7280; font-size: 11px; }
        @media print { .no-print { display: none; } }
    </style>
</head>
<body>
    <div class="page">
        <div class="header">
            <div>
                <div class="brand">Routario</div>
                <div class="subtitle">Monthly usage and draft billing report</div>
            </div>
            <div class="meta">
                <strong>${rtpEsc(company.name)}</strong><br>
                ${rtpEsc(period)}<br>
                Generated ${new Date().toLocaleString()}
            </div>
        </div>
        <div class="grid">
            <div class="box"><div class="label">Plan</div><div class="value">${rtpEsc(plan.name)}</div></div>
            <div class="box"><div class="label">Base Price</div><div class="value">${rtpInvoiceMoney(plan.base_price_cents, invoice)}</div></div>
            <div class="box"><div class="label">Draft Total</div><div class="value">${rtpInvoiceMoney(invoice.amount_cents, invoice)}</div></div>
            <div class="box"><div class="label">Currency</div><div class="value">${rtpEsc(invoice.currency || 'EUR')}</div></div>
            <div class="box"><div class="label">Exchange Rate</div><div class="value">1 EUR = ${Number(invoice.exchange_rate || 1).toFixed(4)} ${rtpEsc(invoice.currency || 'EUR')}</div></div>
            <div class="box"><div class="label">Base Total</div><div class="value">${rtpMoney(invoice.amount_cents, 'EUR', 1)}</div></div>
        </div>
        <h2>Usage Summary</h2>
        <table>
            <thead><tr><th>Metric</th><th>Included</th><th>Used</th><th>Overage</th><th>Overage Rate</th></tr></thead>
            <tbody>
                <tr><td>Active devices</td><td>${plan.included_devices}</td><td>${usage.active_devices || 0}</td><td>${overageDevices}</td><td>${rtpInvoiceMoney(plan.price_per_device_cents, invoice)} / device</td></tr>
                <tr><td>Position messages</td><td>${plan.included_positions}</td><td>${usage.positions || 0}</td><td>${overagePositions}</td><td>${rtpInvoiceMoney(plan.price_per_1000_positions_cents, invoice)} / 1000</td></tr>
                <tr><td>API calls</td><td>${plan.included_api_calls}</td><td>${usage.api_calls || 0}</td><td>${overageApi}</td><td>${rtpInvoiceMoney(plan.price_per_1000_api_calls_cents, invoice)} / 1000</td></tr>
            </tbody>
        </table>
        ${monthlyRows ? `<h2>Monthly Breakdown</h2>
        <table>
            <thead><tr><th>Month</th><th>Devices</th><th>Positions</th><th>API Calls</th><th class="money">Amount</th></tr></thead>
            <tbody>${monthlyRows}</tbody>
        </table>` : ''}
        <h2>Billing Lines</h2>
        <table>
            <thead><tr><th>Description</th><th>Quantity</th><th>Unit</th><th>Billable Units</th><th class="money">Amount</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="5">No billable lines.</td></tr>'}</tbody>
        </table>
        <div class="total"><div class="total-box"><div class="total-row"><span>Total</span><span>${rtpInvoiceMoney(invoice.amount_cents, invoice)}</span></div></div></div>
        <div class="notes">This is a draft billing report based on recorded Routario usage for the selected period. Review before issuing a final invoice.</div>
    </div>
</body>
</html>`;
        const win = window.open('', '_blank');
        if (!win) throw new Error('Popup blocked. Allow popups to open the printable report.');
        win.document.open();
        win.document.write(html);
        win.document.close();
        win.focus();
    } catch (e) { showAlert(e.message, 'error'); }
}

async function rtpCreatePlan() {
    try {
        const wasEditing = Boolean(_rtpEditingPlanId);
        const payload = {
            name: document.getElementById('billPlanName').value.trim(),
            currency: 'EUR',
            base_price_cents: rtpCurrencyCentsFromInput('billBase'),
            included_devices: Number(document.getElementById('billIncDevices').value || 0),
            price_per_device_cents: rtpCurrencyCentsFromInput('billDevicePrice'),
            included_positions: Number(document.getElementById('billIncPositions').value || 0),
            price_per_1000_positions_cents: rtpCurrencyCentsFromInput('billPositionPrice'),
            included_api_calls: Number(document.getElementById('billIncApi').value || 0),
            price_per_1000_api_calls_cents: rtpCurrencyCentsFromInput('billApiPrice'),
        };
        if (!payload.name) throw new Error('Plan name is required');
        const url = _rtpEditingPlanId ? `${API_BASE}/billing/plans/${_rtpEditingPlanId}` : `${API_BASE}/billing/plans`;
        const plan = await rtpJson(url, { method: _rtpEditingPlanId ? 'PUT' : 'POST', body: JSON.stringify(payload) });
        await rtpSavePlanCompanyAssignments(plan.id);
        rtpFillPlanForm();
        rtpClosePlanModal();
        await rtpLoadPlans();
        showAlert(wasEditing ? 'Plan updated' : 'Plan created', 'success');
    } catch (e) { showAlert(e.message, 'error'); }
}

async function rtpSavePlanCompanyAssignments(planId) {
    const box = document.getElementById('billPlanCompanies');
    if (!box) return;
    const selected = _rtpPlanCompanySelection;
    const updates = [];
    rtpBillingCompanies().forEach(company => {
        const companyId = Number(company.id);
        const shouldAssign = selected.has(companyId);
        const isAssigned = Number(company.billing_plan_id) === Number(planId);
        if (shouldAssign !== isAssigned) {
            const nextPlanId = shouldAssign ? Number(planId) : null;
            updates.push(rtpJson(`${API_BASE}/billing/companies/${companyId}`, {
                method: 'PUT',
                body: JSON.stringify({ plan_id: nextPlanId }),
            }).then(() => { company.billing_plan_id = nextPlanId; }));
        }
    });
    await Promise.all(updates);
}

async function rtpDeletePlan(id) {
    if (!confirm('Delete this billing plan? Plans assigned to companies cannot be deleted.')) return;
    try {
        const wasEditing = _rtpEditingPlanId === id;
        await rtpJson(`${API_BASE}/billing/plans/${id}`, { method: 'DELETE' });
        if (wasEditing) {
            rtpFillPlanForm();
            rtpClosePlanModal();
        }
        await rtpLoadPlans();
        showAlert('Plan deleted', 'success');
    } catch (e) { showAlert(e.message, 'error'); }
}

// ── Audit / Health ───────────────────────────────────────────────

async function rtpLoadAudit() {
    const body = document.getElementById('auditTableBody');
    if (!body) return;
    body.innerHTML = RoutarioTables.stateRow('Loading audit logs...', 6);
    try {
        _rtpAuditRows = await rtpJson(`${API_BASE}/audit-logs?limit=500`);
        rtpRenderAuditTable();
    } catch (e) {
        body.innerHTML = RoutarioTables.stateRow(rtpEsc(e.message), 6);
    }
}

function rtpRenderAuditTable() {
    const body = document.getElementById('auditTableBody');
    if (!body) return;
    const q = (document.getElementById('auditSearch')?.value || '').toLowerCase();
    const rows = _rtpAuditRows.filter(l => [
        l.action, l.actor_username, l.actor_user_id, l.company_name, l.company_id,
        l.target_type, l.target_id, l.ip_address, JSON.stringify(l.metadata || {})
    ].join(' ').toLowerCase().includes(q));
    rows.sort((a, b) => rtpCompareValues(rtpAuditValue(a, _rtpAuditSort.col), rtpAuditValue(b, _rtpAuditSort.col), _rtpAuditSort.dir));
    const count = document.getElementById('auditCount');
    if (count) count.textContent = `${rows.length} event${rows.length !== 1 ? 's' : ''}`;
    rtpUpdateSortHeaders('section-audit', _rtpAuditSort);
    body.innerHTML = rows.length ? rows.map(l => `
        <tr>
            <td style="white-space:nowrap;">${new Date(l.created_at).toLocaleString()}</td>
            <td>${rtpEsc(l.action)}</td>
            <td>${rtpEsc(l.actor_username || 'system')}${l.actor_user_id ? `<div class="stack-item-meta">#${l.actor_user_id}</div>` : ''}</td>
            <td>${rtpEsc(l.company_name || '-')}${l.company_id ? `<div class="stack-item-meta">#${l.company_id}</div>` : ''}</td>
            <td>${rtpEsc([l.target_type, l.target_id].filter(Boolean).join(' ')) || '-'}</td>
            <td>${rtpEsc(l.ip_address || '-')}</td>
        </tr>
    `).join('') : RoutarioTables.stateRow('No audit events match.', 6);
}

function rtpAuditValue(row, col) {
    const values = {
        time: row.created_at ? new Date(row.created_at).getTime() : 0,
        action: row.action,
        user: row.actor_username || 'system',
        company: row.company_name || '',
        target: [row.target_type, row.target_id].filter(Boolean).join(' '),
        ip: row.ip_address || '',
    };
    return values[col];
}

function rtpSortAudit(col) {
    _rtpAuditSort = { col, dir: _rtpAuditSort.col === col && _rtpAuditSort.dir === 'asc' ? 'desc' : 'asc' };
    rtpRenderAuditTable();
}

async function rtpLoadHealth() {
    const body = document.getElementById('healthTableBody');
    if (!body) return;
    body.innerHTML = RoutarioTables.stateRow('Loading health checks...', 3);
    try {
        const res = await fetch('/health/ready');
        const data = await res.json();
        _rtpHealthRows = Object.entries(data.checks || {}).map(([name, check]) => ({ name, ...check }));
        rtpRenderHealthTable();
    } catch (e) {
        body.innerHTML = RoutarioTables.stateRow(rtpEsc(e.message), 3);
    }
}

function rtpRenderHealthTable() {
    const body = document.getElementById('healthTableBody');
    if (!body) return;
    const q = (document.getElementById('healthSearch')?.value || '').toLowerCase();
    const rows = _rtpHealthRows.filter(row => JSON.stringify(row).toLowerCase().includes(q));
    rows.sort((a, b) => rtpCompareValues(rtpHealthValue(a, _rtpHealthSort.col), rtpHealthValue(b, _rtpHealthSort.col), _rtpHealthSort.dir));
    const count = document.getElementById('healthCount');
    if (count) count.textContent = `${rows.length} check${rows.length !== 1 ? 's' : ''}`;
    rtpUpdateSortHeaders('section-health', _rtpHealthSort);
    body.innerHTML = rows.length ? rows.map(row => `
        <tr>
            <td>${rtpEsc(row.name)}</td>
            <td><span class="proto-badge health-status health-status-${rtpHealthStatus(row)}">${rtpHealthStatus(row)}</span></td>
            <td>${rtpHealthDetails(row)}</td>
        </tr>
    `).join('') : RoutarioTables.stateRow('No health checks match.', 3);
}

function rtpListenerLabel(listener) {
    if (!listener) return '';
    const transport = listener.protocol_type || listener.type || '';
    const port = listener.port ? `:${listener.port}` : '';
    return [listener.protocol, transport].filter(Boolean).join('/') + port;
}

function rtpHealthDetails(row) {
    if (row.name === 'database') {
        const metrics = [
            ...rtpLatencyMetrics(row),
            ['DB', row.database_type || '-'],
            ['Pool', row.pool_class || '-'],
            ['Pool size', row.pool_size ?? row.size ?? '-'],
            ['In pool', row.connections_in_pool ?? row.checkedin ?? '-'],
            ['Checked out', row.current_checked_out ?? row.checkedout ?? '-'],
            ['Overflow', row.current_overflow ?? row.overflow ?? '-'],
        ];
        const lines = row.error ? [['Error', row.error]] : [];
        return rtpHealthBox(metrics, lines, row.error ? 'danger' : '');
    }

    if (row.name === 'disk') {
        const worst = Math.max(...(row.paths || []).map(p => Number(p.used_percent) || 0), 0);
        const metrics = [
            ['Writable', row.ok ? 'yes' : 'no', row.ok ? 'ok' : 'danger'],
            ['Worst usage', `${worst}%`, worst >= 95 ? 'danger' : worst >= 85 ? 'warn' : 'ok'],
        ];
        const lines = (row.paths || []).map(p => {
            const used = p.used_percent == null ? '?' : `${p.used_percent}%`;
            const free = p.free_bytes == null ? '-' : rtpFormatBytes(p.free_bytes);
            const state = p.ok ? (p.degraded ? 'degraded' : 'ok') : 'critical';
            const error = p.error ? `; ${p.error}` : '';
            return [p.label || p.path, `${state}, used ${used}, free ${free}${error}`];
        });
        if (row.error) lines.unshift(['Error', row.error]);
        return rtpHealthBox(metrics, lines, row.error ? 'danger' : '');
    }

    if (row.name === 'redis') {
        const metrics = [
            ...rtpLatencyMetrics(row),
            ['Reachable', row.ok ? 'yes' : 'no', row.ok ? 'ok' : 'info'],
            ['Pub/sub', row.available ? 'redis' : (row.mode || 'fallback'), row.available ? 'ok' : 'info'],
        ];
        const lines = [];
        if (row.error) lines.push(['Ping', row.error]);
        if (row.pubsub_error && row.pubsub_error !== row.error) lines.push(['Pub/sub', row.pubsub_error]);
        return rtpHealthBox(metrics, lines);
    }

    if (row.name === 'valhalla') {
        const enabled = row.enabled !== false && row.optional !== true;
        const metrics = [
            ['Enabled', enabled ? 'yes' : 'no', enabled ? 'ok' : 'info'],
            ['Reachable', row.available || row.ok ? 'yes' : 'no', row.available || row.ok ? 'ok' : (enabled ? 'danger' : 'info')],
        ];
        const lines = [
            ['URL', row.url || '-'],
            ['State', row.message || (row.ok ? 'available' : enabled ? 'unreachable' : 'disabled')],
        ];
        if (row.error) lines.push(['Error', row.error]);
        return rtpHealthBox(metrics, lines, row.degraded ? 'warn' : '');
    }

    if (row.error) return rtpHealthBox([], [['Error', row.error]], 'danger');

    if (row.name === 'protocol_listeners') {
        const metrics = [
            ['Active', row.active_protocols?.length || 0],
            ['Expected', row.expected_listeners?.length || 0],
            ['Running', row.running_listeners?.filter(l => l.running)?.length || 0],
        ];
        const lines = [];
        if (row.unknown_protocols?.length) {
            lines.push(['Unknown', row.unknown_protocols.join(', ')]);
        }
        if (row.missing_listeners?.length) {
            lines.push(['Missing', row.missing_listeners.map(rtpListenerLabel).join(', ')]);
        }
        if (row.unhealthy_listeners?.length) {
            lines.push(['Stopped', row.unhealthy_listeners.map(rtpListenerLabel).join(', ')]);
        }
        if (row.unexpected_listeners?.length) {
            lines.push(['Unexpected', row.unexpected_listeners.map(rtpListenerLabel).join(', ')]);
        }
        if (row.integration_protocols?.length) {
            lines.push(['Integration-only', row.integration_protocols.join(', ')]);
        }
        if (!lines.length) lines.push(['Listeners', row.running_listeners?.length ? row.running_listeners.map(rtpListenerLabel).join(', ') : 'none']);
        return rtpHealthBox(metrics, lines);
    }

    if (row.name === 'background_tasks' && row.tasks) {
        const tasks = Object.entries(row.tasks);
        const metrics = [
            ['Running', tasks.filter(([, task]) => task.running).length],
            ['Total', tasks.length],
        ];
        const lines = tasks.map(([name, task]) => {
            const status = task.ok ? 'ok' : 'fail';
            const age = task.last_success_age_seconds == null ? 'no successful loop yet' : `${task.last_success_age_seconds}s since success`;
            const error = task.last_error ? `; ${task.last_error}` : '';
            return [name, `${status}, ${age}${error}`];
        });
        return rtpHealthBox(metrics, lines);
    }

    if (row.name === 'ingestion') {
        const latest = row.latest_position_age_seconds == null ? 'none' : `${row.latest_position_age_seconds}s ago`;
        return rtpHealthBox(
            [
                ['Active', row.active_devices ?? 0],
                ['Online', row.online_devices ?? 0],
                ['With positions', row.devices_with_positions ?? 0],
                ['Stale >15m', row.stale_over_15m_count ?? 0, row.stale_over_15m_count ? 'warn' : 'ok'],
                ['Never seen', row.never_seen_count ?? 0, row.never_seen_count ? 'warn' : 'ok'],
            ],
            [['Latest position', latest]]
        );
    }

    if (row.name === 'integration_accounts') {
        if (!row.accounts?.length) return rtpHealthBox([['Accounts', 0]], [['Integrations', 'No active integration accounts']]);
        const errored = row.accounts.filter(a => a.last_error);
        const sample = (errored.length ? errored : row.accounts).slice(0, 5).map(a => {
            const devices = `${a.active_device_count ?? 0} device${a.active_device_count === 1 ? '' : 's'}`;
            const auth = a.last_auth_at ? `auth ${new Date(a.last_auth_at).toLocaleString()}` : 'not authenticated yet';
            const error = a.last_error ? `; ${a.last_error}` : '';
            return [`${a.provider_id}/${a.account_label || 'default'}`, `${devices}, ${auth}${error}`];
        });
        return rtpHealthBox(
            [
                ['Accounts', row.active_accounts ?? 0],
                ['Errors', row.accounts_with_errors ?? 0, row.accounts_with_errors ? 'danger' : 'ok'],
            ],
            sample
        );
    }

    if (row.name === 'runtime') {
        return rtpHealthBox(
            [
                ['Version', row.app_version || '-'],
                ['Commit', row.git_commit || '-'],
                ['Uptime', `${row.uptime_seconds ?? 0}s`],
                ['Python', row.python_version || '-'],
                ['DB', row.database_type || '-'],
            ],
            [['Platform', row.platform || '-']]
        );
    }

    if (row.degraded) return rtpHealthBox([], [['State', 'degraded']], 'warn');
    return '';
}

function rtpLatencyMetrics(row) {
    return row.latency_ms == null ? [] : [['Latency', `${row.latency_ms} ms`]];
}

function rtpHealthBox(metrics = [], lines = [], tone = '') {
    const metricHtml = metrics.length ? `<div class="health-metrics">${metrics.map(([label, value, metricTone]) => rtpHealthMetric(label, value, metricTone)).join('')}</div>` : '';
    const lineHtml = lines.length ? `<div class="health-lines">${lines.map(([label, value]) => `
        <div class="health-line">
            <span class="health-line-label">${rtpEsc(label)}</span>
            <span class="health-line-value">${rtpEsc(value)}</span>
        </div>
    `).join('')}</div>` : '';
    const toneClass = tone ? ` health-details-${tone}` : '';
    return `<div class="health-details${toneClass}">${metricHtml}${lineHtml}</div>`;
}

function rtpHealthMetric(label, value, tone = '') {
    const toneClass = tone ? ` health-chip-${tone}` : '';
    return `<span class="health-metric${toneClass}"><span>${rtpEsc(label)}</span><strong>${rtpEsc(value)}</strong></span>`;
}

function rtpFormatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value)) return '-';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
    }
    return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function rtpHealthValue(row, col) {
    const status = rtpHealthStatus(row);
    const values = {
        name: row.name,
        status,
        latency: Number(row.latency_ms) || 0,
        details: row.error || (row.degraded ? 'degraded' : JSON.stringify(row)),
    };
    return values[col];
}

function rtpHealthStatus(row) {
    if (row.degraded) return 'degraded';
    if (row.ok) return 'ok';
    if (row.optional) return 'optional';
    return 'fail';
}

function rtpSortHealth(col) {
    _rtpHealthSort = { col, dir: _rtpHealthSort.col === col && _rtpHealthSort.dir === 'asc' ? 'desc' : 'asc' };
    rtpRenderHealthTable();
}
