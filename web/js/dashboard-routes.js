'use strict';

let dashboardRoutes = [];
let dashboardRoutesLoaded = false;
let dashboardRouteLayer = null;
let dashboardRouteLine = null;
let dashboardRouteStopLayer = null;
let selectedDashboardRoute = null;
let selectedDashboardRouteIndex = 0;
let dashboardRouteLayerSuppressed = false;
const dashboardRouteUpdatingStops = new Set();
let dashboardRouteBroadcast = null;
let dashboardRouteEditorId = null;
let dashboardRouteEditorReadonlyState = false;
let dashboardRouteEditorMap = null;
let dashboardRouteEditorTileLayer = null;
let dashboardRouteEditorStopLayer = null;
let dashboardRouteEditorLine = null;
let dashboardRouteEditorGeometry = null;
let dashboardRouteEditorPreviewTimer = null;
let dashboardRouteEditorPreviewSignature = '';
let dashboardRouteDraggedStopRow = null;

try {
    dashboardRouteBroadcast = new BroadcastChannel('routario_route_updates');
    dashboardRouteBroadcast.onmessage = ({ data }) => {
        if (data?.type === 'route_update' && data.route) {
            applyDashboardRouteUpdate(data.route);
        }
    };
} catch (_) {}

const DASHBOARD_ROUTE_STATUSES = new Set(['active', 'paused', 'planned', 'draft']);
const DASHBOARD_ACTIVE_ROUTE_STATUSES = new Set(['active']);

function routeEsc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

function routeStatusLabel(status) {
    const value = String(status || 'draft').toLowerCase();
    return value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function dashboardRouteDate(value) {
    if (!value) return null;
    if (typeof value === 'string' && !value.includes('Z') && !value.includes('+')) {
        return new Date(`${value}Z`);
    }
    return new Date(value);
}

function dashboardRouteDateTime(value) {
    const date = dashboardRouteDate(value);
    return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : '-';
}

function routeCanManage() {
    return typeof hasPermission === 'function' && hasPermission('manage_routes');
}

function dashboardRouteDeviceName(route) {
    const device = Array.isArray(devices)
        ? devices.find(d => Number(d.id) === Number(route?.device_id))
        : null;
    return device?.name || route?.device_name || (route?.device_id ? `Device #${route.device_id}` : 'Unassigned');
}

function dashboardRouteStatusClass(status) {
    return `status-${String(status || 'draft').toLowerCase().replace(/_/g, '-')}`;
}

function dashboardRouteAssignmentStatus(deviceId) {
    return deviceId ? 'planned' : 'draft';
}

async function loadDashboardRoutes({ force = false } = {}) {
    if (dashboardRoutesLoaded && !force) return dashboardRoutes;
    dashboardRoutesLoaded = true;
    try {
        const res = await apiFetch(`${API_BASE}/planned-routes`);
        if (!res.ok) {
            dashboardRoutes = [];
            return dashboardRoutes;
        }
        dashboardRoutes = await res.json();
    } catch {
        dashboardRoutes = [];
    }
    return dashboardRoutes;
}

function dashboardRouteRank(route) {
    const status = String(route.status || '').toLowerCase();
    if (DASHBOARD_ACTIVE_ROUTE_STATUSES.has(status)) return 0;
    if (status === 'paused') return 1;
    if (status === 'planned') return 2;
    if (status === 'draft') return 3;
    return 4;
}

function dashboardRoutesForDevice(deviceId) {
    return dashboardRoutes
        .filter(route => Number(route.device_id) === Number(deviceId))
        .filter(route => DASHBOARD_ROUTE_STATUSES.has(String(route.status || '').toLowerCase()))
        .sort((a, b) => dashboardRouteRank(a) - dashboardRouteRank(b) || new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
}

function dashboardRouteForDevice(deviceId) {
    return dashboardRoutesForDevice(deviceId)[0] || null;
}

function selectedDashboardRouteForDevice(deviceId) {
    const routes = dashboardRoutesForDevice(deviceId);
    if (!routes.length) {
        selectedDashboardRouteIndex = 0;
        return { route: null, routes };
    }

    const currentId = selectedDashboardRoute?.id;
    const currentIndex = routes.findIndex(route => Number(route.id) === Number(currentId));
    if (currentIndex >= 0) {
        selectedDashboardRouteIndex = currentIndex;
    } else {
        selectedDashboardRouteIndex = Math.max(0, Math.min(selectedDashboardRouteIndex, routes.length - 1));
    }

    return { route: routes[selectedDashboardRouteIndex], routes };
}

function upsertDashboardRoute(route) {
    if (!route?.id) return;
    const idx = dashboardRoutes.findIndex(r => Number(r.id) === Number(route.id));
    if (idx >= 0) {
        dashboardRoutes[idx] = route;
    } else {
        dashboardRoutes.unshift(route);
    }
    dashboardRoutesLoaded = true;
}

function renderDashboardRouteMutation(route) {
    if (!route) return;
    upsertDashboardRoute(route);
    if (Number(route.device_id) === Number(selectedDevice)) {
        const { route: selectedRoute, routes } = selectedDashboardRouteForDevice(selectedDevice);
        renderSelectedRoutePanel(selectedRoute, routes);
        renderDashboardRouteLayer(selectedRoute);
    }
    if (document.getElementById('dashboardRoutesModal')?.classList.contains('active')) {
        renderDashboardRoutesModal();
    }
}

function removeDashboardRoute(routeId) {
    dashboardRoutes = dashboardRoutes.filter(route => Number(route.id) !== Number(routeId));
    if (selectedDashboardRoute && Number(selectedDashboardRoute.id) === Number(routeId)) {
        clearDashboardRouteLayer();
        renderSelectedRoutePanel(null, []);
    }
    if (document.getElementById('dashboardRoutesModal')?.classList.contains('active')) {
        renderDashboardRoutesModal();
    }
}

function applyDashboardRouteUpdate(route) {
    renderDashboardRouteMutation(route);
}

function broadcastDashboardRouteUpdate(route) {
    if (!route) return;
    try {
        dashboardRouteBroadcast?.postMessage({ type: 'route_update', route });
    } catch (_) {}
}

function decodeDashboardValhallaShape(encoded) {
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

function dashboardRouteLatLngs(route) {
    const geometry = route?.route_geometry;
    if (geometry?.provider === 'valhalla') {
        const shapes = geometry.encoded_shapes || (geometry.encoded_shape ? [geometry.encoded_shape] : []);
        const decoded = shapes.flatMap(shape => decodeDashboardValhallaShape(shape));
        if (decoded.length > 1) return decoded;
    }
    if (Array.isArray(geometry?.coordinates)) {
        return geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    }
    return (route?.stops || [])
        .slice()
        .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0))
        .map(stop => [stop.latitude, stop.longitude])
        .filter(([lat, lng]) => Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)));
}

function dashboardRouteStopIcon(stop, index) {
    const status = String(stop.status || 'pending').toLowerCase();
    const cls = status === 'completed' ? 'done' : status === 'arrived' ? 'arrived' : 'pending';
    const kindCls = String(stop.stop_kind || 'stop').toLowerCase() === 'waypoint' ? 'waypoint' : 'stop';
    return L.divIcon({
        className: `route-stop-marker ${kindCls} ${cls}`,
        html: `<span>${index + 1}</span>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
    });
}

function dashboardRouteStopKindLabel(stop) {
    return String(stop.stop_kind || 'stop').toLowerCase() === 'waypoint' ? 'Waypoint' : 'Stop';
}

function dashboardRouteStopColor(stop) {
    const status = String(stop.status || 'pending').toLowerCase();
    if (status === 'completed') return '#10b981';
    if (status === 'arrived') return '#f97316';
    return String(stop.stop_kind || 'stop').toLowerCase() === 'waypoint' ? '#f59e0b' : '#38bdf8';
}

function dashboardExtendBoundsByRadius(bounds, lat, lng, radiusM) {
    const radius = Number(radiusM || 0);
    const latitude = Number(lat);
    const longitude = Number(lng);
    if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

    const latDelta = radius / 111320;
    const lngScale = Math.max(Math.abs(Math.cos(latitude * Math.PI / 180)), 0.01);
    const lngDelta = radius / (111320 * lngScale);
    bounds.extend([latitude - latDelta, longitude - lngDelta]);
    bounds.extend([latitude + latDelta, longitude + lngDelta]);
}

function dashboardRouteBounds(route) {
    const bounds = L.latLngBounds([]);
    dashboardRouteLatLngs(route).forEach(ll => {
        const point = L.latLng(ll);
        if (point && Number.isFinite(point.lat) && Number.isFinite(point.lng)) bounds.extend(point);
    });
    (route?.stops || []).forEach(stop => {
        const latitude = Number(stop.latitude);
        const longitude = Number(stop.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
        bounds.extend([latitude, longitude]);
        dashboardExtendBoundsByRadius(bounds, latitude, longitude, stop.arrival_radius_m || 50);
    });
    return bounds;
}

function clearDashboardRouteLayer({ preserveSelection = false } = {}) {
    if (!preserveSelection) selectedDashboardRoute = null;
    if (dashboardRouteLayer && map) {
        map.removeLayer(dashboardRouteLayer);
    }
    dashboardRouteLayer = null;
    dashboardRouteLine = null;
    dashboardRouteStopLayer = null;
}

function renderDashboardRouteLayer(route) {
    if (!map || !window.L) return;
    clearDashboardRouteLayer({ preserveSelection: true });
    if (!route) {
        selectedDashboardRoute = null;
        return;
    }
    selectedDashboardRoute = route;
    if (dashboardRouteLayerSuppressed) return;

    dashboardRouteLayer = L.layerGroup().addTo(map);
    dashboardRouteStopLayer = L.layerGroup().addTo(dashboardRouteLayer);

    const latLngs = dashboardRouteLatLngs(route);
    if (latLngs.length > 1) {
        dashboardRouteLine = L.polyline(latLngs, {
            color: '#38bdf8',
            weight: 5,
            opacity: 0.9,
            dashArray: String(route.status || '').toLowerCase() === 'paused' ? '8 8' : null,
        }).addTo(dashboardRouteLayer);
    }

    (route.stops || [])
        .slice()
        .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0))
        .forEach((stop, index) => {
            if (!Number.isFinite(Number(stop.latitude)) || !Number.isFinite(Number(stop.longitude))) return;
            const ll = [stop.latitude, stop.longitude];
            const color = dashboardRouteStopColor(stop);
            L.circle(ll, {
                radius: Number(stop.arrival_radius_m || 50),
                color,
                weight: 1,
                opacity: 0.75,
                fillColor: color,
                fillOpacity: 0.08,
                interactive: false,
            }).addTo(dashboardRouteStopLayer);
            L.marker(ll, { icon: dashboardRouteStopIcon(stop, index) })
                .bindPopup(`
                    <div class="route-stop-popup">
                        <strong>${routeEsc(stop.name || `Stop ${index + 1}`)}</strong>
                        <div>${dashboardRouteStopKindLabel(stop)} · ${routeStatusLabel(stop.status || 'pending')}</div>
                        ${stop.notes ? `<div>${routeEsc(stop.notes)}</div>` : ''}
                    </div>
                `)
                .addTo(dashboardRouteStopLayer);
        });
}

function hideDashboardRouteLayerForHistory() {
    dashboardRouteLayerSuppressed = true;
    clearDashboardRouteLayer({ preserveSelection: true });
}

function restoreDashboardRouteLayerAfterHistory() {
    dashboardRouteLayerSuppressed = false;
    if (selectedDashboardRoute) {
        renderDashboardRouteLayer(selectedDashboardRoute);
    } else if (selectedDevice && typeof refreshSelectedDashboardRoute === 'function') {
        refreshSelectedDashboardRoute();
    }
}

function dashboardRouteProgress(route) {
    const stops = route?.stops || [];
    const done = stops.filter(s => String(s.status || '').toLowerCase() === 'completed').length;
    const total = stops.length;
    const ordered = dashboardRouteOrderedStops(route);
    const completedSequences = ordered
        .filter(s => String(s.status || '').toLowerCase() === 'completed')
        .map(s => Number(s.sequence || 0));
    const latestCompleted = completedSequences.length ? Math.max(...completedSequences) : -1;
    const lastSequence = ordered.length ? Math.max(...ordered.map(s => Number(s.sequence || 0))) : -1;
    if (latestCompleted >= lastSequence && lastSequence >= 0) return { done, total, next: null };
    const next = ordered.find(s => (
        String(s.status || '').toLowerCase() !== 'completed'
        && Number(s.sequence || 0) > latestCompleted
    )) || ordered.find(s => String(s.status || '').toLowerCase() !== 'completed');
    return { done, total, next };
}

function dashboardRouteOrderedStops(route) {
    return (route?.stops || [])
        .slice()
        .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
}

function dashboardRoutePointCompletesTrip(route, stopId) {
    const ordered = dashboardRouteOrderedStops(route);
    if (!ordered.length) return false;
    const completedStop = ordered.find(stop => Number(stop.id) === Number(stopId));
    if (!completedStop) return false;
    return Number(completedStop.sequence || 0) >= Math.max(...ordered.map(stop => Number(stop.sequence || 0)));
}

function renderSelectedRoutePanel(route, routeList = []) {
    const panel = document.getElementById('selectedRoutePanel');
    if (!panel) return;
    const closeBtn = document.getElementById('selectedRouteCloseBtn');

    if (!route) {
        panel.style.display = 'none';
        panel.innerHTML = '';
        if (closeBtn) closeBtn.style.display = 'none';
        return;
    }

    const progress = dashboardRouteProgress(route);
    const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    const status = String(route.status || 'draft').toLowerCase();
    const canManage = routeCanManage();
    const canStart = canManage && (status === 'planned' || status === 'draft');
    const canPause = canManage && DASHBOARD_ACTIVE_ROUTE_STATUSES.has(status);
    const canResume = canManage && status === 'paused';
    const canComplete = canManage && (DASHBOARD_ACTIVE_ROUTE_STATUSES.has(status) || status === 'paused');
    const canCompleteStop = canManage && progress.next && DASHBOARD_ACTIVE_ROUTE_STATUSES.has(status);
    const routeCount = routeList.length || 1;
    const currentRouteNumber = Math.max(1, Math.min(selectedDashboardRouteIndex + 1, routeCount));
    const routePager = routeCount > 1 ? `
        <div class="selected-route-pager" aria-label="Assigned route navigation">
            <button type="button" class="icon-btn" onclick="selectDashboardRouteOffset(-1)" title="Previous route"><i class="mdi mdi-chevron-left"></i></button>
            <span>${currentRouteNumber}/${routeCount}</span>
            <button type="button" class="icon-btn" onclick="selectDashboardRouteOffset(1)" title="Next route"><i class="mdi mdi-chevron-right"></i></button>
        </div>
    ` : '';

    panel.style.display = '';
    if (closeBtn) closeBtn.style.display = '';
    panel.innerHTML = `
        <div class="selected-route-header">
            <div>
                <div class="selected-route-eyebrow">Assigned route</div>
                <div class="selected-route-title">${routeEsc(route.name)}</div>
            </div>
            <div class="selected-route-header-actions">
                ${routePager}
                <span class="selected-route-status ${dashboardRouteStatusClass(route.status)}">${routeStatusLabel(route.status)}</span>
            </div>
        </div>
        <div class="selected-route-progress">
            <div class="selected-route-progress-bar"><span style="width:${pct}%"></span></div>
            <div class="selected-route-progress-meta">${progress.done}/${progress.total} points complete</div>
        </div>
        ${progress.next ? `
            <div class="selected-route-next">
                <span>Next</span>
                <strong>${routeEsc(progress.next.name || `Stop ${Number(progress.next.sequence || 0) + 1}`)}</strong>
                <small>${dashboardRouteStopKindLabel(progress.next)} · ${Number(progress.next.arrival_radius_m || 50)}m radius · ${Number(progress.next.dwell_seconds || 0)}s dwell</small>
            </div>
        ` : ''}
        <div class="selected-route-actions">
            ${canStart ? `<button class="btn btn-sm btn-primary" onclick="setDashboardRouteStatus(${route.id}, 'active')"><i class="mdi mdi-play"></i> Start</button>` : ''}
            ${canPause ? `<button class="btn btn-sm btn-secondary" onclick="setDashboardRouteStatus(${route.id}, 'paused')"><i class="mdi mdi-pause"></i> Pause</button>` : ''}
            ${canResume ? `<button class="btn btn-sm btn-primary" onclick="setDashboardRouteStatus(${route.id}, 'active')"><i class="mdi mdi-play"></i> Resume</button>` : ''}
            ${canCompleteStop ? `<button class="btn btn-sm btn-secondary" onclick="completeDashboardRouteStop(${route.id}, ${progress.next.id})"><i class="mdi mdi-check"></i> Complete Stop</button>` : ''}
            ${canComplete ? `<button class="btn btn-sm btn-secondary" onclick="setDashboardRouteStatus(${route.id}, 'completed')"><i class="mdi mdi-flag-checkered"></i> Finish</button>` : ''}
        </div>
    `;
}

function setSelectedRouteCloseButtonVisible(visible) {
    const closeBtn = document.getElementById('selectedRouteCloseBtn');
    if (closeBtn) closeBtn.style.display = visible ? '' : 'none';
}

function closeSelectedDashboardRoutePanel() {
    selectedDashboardRouteIndex = 0;
    clearDashboardRouteLayer();
    renderSelectedRoutePanel(null, []);
}

async function refreshSelectedDashboardRoute({ force = false } = {}) {
    if (!selectedDevice) {
        clearDashboardRouteLayer();
        renderSelectedRoutePanel(null, []);
        return null;
    }
    await loadDashboardRoutes({ force });
    const { route, routes } = selectedDashboardRouteForDevice(selectedDevice);
    renderSelectedRoutePanel(route, routes);
    renderDashboardRouteLayer(route);
    return route;
}

async function onDashboardDeviceSelectedForRoutes(deviceId) {
    selectedDevice = deviceId;
    selectedDashboardRouteIndex = 0;
    return refreshSelectedDashboardRoute({ force: true });
}

function selectDashboardRouteOffset(offset) {
    if (!selectedDevice) return;
    const routes = dashboardRoutesForDevice(selectedDevice);
    if (!routes.length) {
        selectedDashboardRouteIndex = 0;
        renderSelectedRoutePanel(null, []);
        renderDashboardRouteLayer(null);
        return;
    }

    selectedDashboardRouteIndex = (selectedDashboardRouteIndex + offset + routes.length) % routes.length;
    const route = routes[selectedDashboardRouteIndex];
    renderSelectedRoutePanel(route, routes);
    renderDashboardRouteLayer(route);
    fitSelectedDashboardRoute({ fly: true });
}

async function setDashboardRouteStatus(routeId, status) {
    try {
        const res = await apiFetch(`${API_BASE}/planned-routes/${routeId}`, {
            method: 'PUT',
            body: JSON.stringify({ status }),
        });
        if (!res.ok) throw new Error((await res.json()).detail || 'Failed to update route');
        const route = await res.json();
        renderDashboardRouteMutation(route);
        broadcastDashboardRouteUpdate(route);
        return route;
    } catch (e) {
        showAlert({ title: 'Route Update Failed', message: e.message, type: 'error' });
        return null;
    }
}

function dashboardRouteIsViewOnly(route) {
    const status = String(route?.status || '').toLowerCase();
    return ['active', 'paused', 'completed'].includes(status);
}

function dashboardRouteModalActions(route) {
    const status = String(route.status || 'draft').toLowerCase();
    const canManage = routeCanManage();
    const isEditable = !dashboardRouteIsViewOnly(route);
    const canStart = canManage && (status === 'planned' || status === 'draft') && route.device_id;
    const canPause = canManage && DASHBOARD_ACTIVE_ROUTE_STATUSES.has(status);
    const canResume = canManage && status === 'paused' && route.device_id;
    const canFinish = canManage && (DASHBOARD_ACTIVE_ROUTE_STATUSES.has(status) || status === 'paused');
    const canReset = canManage && status === 'completed';
    return [
        canManage ? `<button class="btn btn-secondary" onclick="openDashboardRouteEditor(${route.id})"><i class="mdi ${isEditable ? 'mdi-pencil' : 'mdi-eye'}"></i> ${isEditable ? 'Edit' : 'View'}</button>` : '',
        canStart ? `<button class="btn btn-secondary" onclick="setDashboardRouteStatus(${route.id}, 'active')"><i class="mdi mdi-play"></i> Start</button>` : '',
        canPause ? `<button class="btn btn-secondary" onclick="setDashboardRouteStatus(${route.id}, 'paused')"><i class="mdi mdi-pause"></i> Pause</button>` : '',
        canResume ? `<button class="btn btn-secondary" onclick="setDashboardRouteStatus(${route.id}, 'active')"><i class="mdi mdi-play"></i> Resume</button>` : '',
        canFinish ? `<button class="btn btn-secondary" onclick="setDashboardRouteStatus(${route.id}, 'completed')"><i class="mdi mdi-flag-checkered"></i> Finish</button>` : '',
        canReset ? `<button class="btn btn-secondary" onclick="resetDashboardRoute(${route.id})"><i class="mdi mdi-restore"></i> Reset</button>` : '',
    ].filter(Boolean).join('');
}

async function openDashboardRoutesModal() {
    const modal = document.getElementById('dashboardRoutesModal');
    const list = document.getElementById('dashboardRoutesList');
    if (!modal || !list) return;
    modal.classList.add('active');
    list.innerHTML = '<div class="dashboard-routes-empty">Loading routes...</div>';
    await loadDashboardRoutes({ force: true });
    const newBtn = document.getElementById('dashboardRouteNewBtn');
    if (newBtn) newBtn.style.display = routeCanManage() ? '' : 'none';
    renderDashboardRoutesModal();
    setTimeout(() => document.getElementById('dashboardRoutesSearch')?.focus(), 50);
}

function closeDashboardRoutesModal() {
    document.getElementById('dashboardRoutesModal')?.classList.remove('active');
}

async function showDashboardRouteOnMap(routeId) {
    const route = dashboardRoutes.find(r => Number(r.id) === Number(routeId));
    if (!route) return;
    selectedDashboardRoute = route;
    if (route.device_id && typeof selectDevice === 'function') {
        await selectDevice(route.device_id, { zoom: false });
        const routes = dashboardRoutesForDevice(route.device_id);
        const routeIndex = routes.findIndex(r => Number(r.id) === Number(route.id));
        if (routeIndex >= 0) selectedDashboardRouteIndex = routeIndex;
        renderSelectedRoutePanel(route, routes);
    } else {
        renderDashboardRouteLayer(route);
        setSelectedRouteCloseButtonVisible(true);
    }
    selectedDashboardRoute = route;
    renderDashboardRouteLayer(route);
    fitSelectedDashboardRoute({ fly: true });
}

async function showDashboardRouteEditorRouteOnMap() {
    if (!dashboardRouteEditorId) return;
    await showDashboardRouteOnMap(dashboardRouteEditorId);
    closeDashboardRouteEditor();
    closeDashboardRoutesModal();
}

function openDashboardRouteEditorDetails() {
    if (!dashboardRouteEditorId) return;
    openDashboardRouteDetails(dashboardRouteEditorId);
}

function renderDashboardRoutesModal() {
    const list = document.getElementById('dashboardRoutesList');
    if (!list) return;
    const q = (document.getElementById('dashboardRoutesSearch')?.value || '').toLowerCase();
    const rows = dashboardRoutes
        .filter(route => [
            route.name,
            route.status,
            dashboardRouteDeviceName(route),
            route.stops?.length,
        ].some(value => String(value ?? '').toLowerCase().includes(q)))
        .sort((a, b) => {
            const rank = dashboardRouteRank(a) - dashboardRouteRank(b);
            if (rank) return rank;
            const at = dashboardRouteDate(a.updated_at || a.created_at)?.getTime() || 0;
            const bt = dashboardRouteDate(b.updated_at || b.created_at)?.getTime() || 0;
            return bt - at;
        });

    const count = document.getElementById('dashboardRoutesCount');
    if (count) count.textContent = `${rows.length} route${rows.length !== 1 ? 's' : ''}`;

    if (!rows.length) {
        list.innerHTML = '<div class="dashboard-routes-empty">No routes found.</div>';
        return;
    }

    list.innerHTML = rows.map(route => {
        const progress = dashboardRouteProgress(route);
        const distance = Number(route.distance_km || 0);
        const duration = Number(route.duration_minutes || 0);
        return `
            <div class="dashboard-route-row" ondblclick="openDashboardRouteEditor(${route.id})" title="Double-click to edit or view route">
                <div class="dashboard-route-main">
                    <div class="dashboard-route-title">${routeEsc(route.name || 'Untitled route')}</div>
                    <div class="dashboard-route-meta">
                        <span class="dashboard-route-status ${dashboardRouteStatusClass(route.status)}">${routeStatusLabel(route.status)}</span>
                        <span><i class="mdi mdi-truck-outline"></i> ${routeEsc(dashboardRouteDeviceName(route))}</span>
                        <span><i class="mdi mdi-map-marker-check-outline"></i> ${progress.done}/${progress.total} points</span>
                        <span><i class="mdi mdi-map-marker-distance"></i> ${distance.toFixed(1)} km</span>
                        <span><i class="mdi mdi-clock-outline"></i> ${duration.toFixed(0)} min</span>
                    </div>
                </div>
                <div class="dashboard-route-actions" ondblclick="event.stopPropagation()">
                    ${dashboardRouteModalActions(route)}
                </div>
            </div>
        `;
    }).join('');
}

function populateDashboardRouteDeviceSelect(selectedId = '') {
    const select = document.getElementById('dashboardRouteDevice');
    if (!select) return;
    const options = Array.isArray(devices) ? devices.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' })) : [];
    select.innerHTML = `<option value="">Unassigned</option>` + options.map(device => `
        <option value="${routeEsc(device.id)}" ${Number(device.id) === Number(selectedId) ? 'selected' : ''}>${routeEsc(device.name || `Device #${device.id}`)}</option>
    `).join('');
}

function dashboardRouteEditorReadonly(readonly) {
    dashboardRouteEditorReadonlyState = Boolean(readonly);
    document.getElementById('dashboardRouteEditorModal')?.classList.toggle('route-readonly', Boolean(readonly));
    document.querySelectorAll('#dashboardRouteEditorModal input, #dashboardRouteEditorModal select').forEach(el => {
        el.disabled = readonly;
        el.style.opacity = readonly ? '0.65' : '';
    });
    document.querySelectorAll('#dashboardRouteEditorModal .dashboard-route-stop-row .btn').forEach(el => {
        el.style.display = readonly ? 'none' : '';
    });
    const saveBtn = document.getElementById('dashboardRouteSaveBtn');
    if (saveBtn) saveBtn.style.display = readonly ? 'none' : '';
    const deleteBtn = document.getElementById('dashboardRouteDeleteBtn');
    if (deleteBtn && readonly) deleteBtn.style.display = 'none';
    const hint = document.getElementById('dashboardRouteMapHint');
    if (hint) hint.textContent = readonly ? 'Route points are locked in view mode.' : 'Click the map to add a stop. Drag markers to adjust points.';
    document.querySelectorAll('#dashboardRouteEditorModal .dashboard-route-stop-drag').forEach(el => {
        el.draggable = !readonly;
        el.disabled = readonly;
        el.style.display = readonly ? 'none' : '';
    });
}

function initDashboardRouteStopDrag(wrap) {
    if (!wrap || wrap.dataset.dragInitialized === '1') return;
    wrap.dataset.dragInitialized = '1';
    wrap.addEventListener('dragover', e => {
        if (dashboardRouteEditorReadonlyState || !dashboardRouteDraggedStopRow) return;
        e.preventDefault();
        const afterRow = dashboardRouteStopRowAfterPointer(wrap, e.clientY);
        if (afterRow) {
            wrap.insertBefore(dashboardRouteDraggedStopRow, afterRow);
        } else {
            wrap.appendChild(dashboardRouteDraggedStopRow);
        }
    });
    wrap.addEventListener('drop', e => {
        if (!dashboardRouteDraggedStopRow) return;
        e.preventDefault();
        finishDashboardRouteStopDrag();
    });
}

function dashboardRouteStopRowAfterPointer(wrap, y) {
    return [...wrap.querySelectorAll('.dashboard-route-stop-row:not(.dragging)')]
        .reduce((closest, row) => {
            const box = row.getBoundingClientRect();
            const offset = y - box.top - (box.height / 2);
            if (offset < 0 && offset > closest.offset) return { offset, row };
            return closest;
        }, { offset: Number.NEGATIVE_INFINITY, row: null }).row;
}

function finishDashboardRouteStopDrag() {
    if (!dashboardRouteDraggedStopRow) return;
    dashboardRouteDraggedStopRow.classList.remove('dragging');
    dashboardRouteDraggedStopRow = null;
    refreshDashboardRouteStopSummaries();
    refreshDashboardRouteEditorMap();
}

function addDashboardRouteStop(stop = {}) {
    const wrap = document.getElementById('dashboardRouteStops');
    if (!wrap) return;
    initDashboardRouteStopDrag(wrap);
    const row = document.createElement('div');
    row.className = 'dashboard-route-stop-row';
    row.dataset.status = String(stop.status || 'pending').toLowerCase();
    row.innerHTML = `
        <div class="dashboard-route-stop-summary" onclick="toggleDashboardRouteStopRow(this.closest('.dashboard-route-stop-row'))">
            <button type="button" class="dashboard-route-stop-drag" draggable="true" title="Reorder stop"><i class="mdi mdi-drag"></i></button>
            <span class="dashboard-route-stop-index"></span>
            <div class="dashboard-route-stop-summary-main">
                <div class="dashboard-route-stop-summary-title"></div>
                <div class="dashboard-route-stop-summary-meta"></div>
            </div>
            <i class="mdi mdi-chevron-down dashboard-route-stop-toggle"></i>
        </div>
        <div class="dashboard-route-stop-fields">
            <label><span>Name</span><input class="form-input rp-stop-name" value="${routeEsc(stop.name || '')}" placeholder="Stop name"></label>
            <label><span>Type</span><select class="form-input rp-stop-kind"><option value="stop">Stop</option><option value="waypoint">Waypoint</option></select></label>
            <label><span>Radius</span><input class="form-input rp-stop-radius" type="number" min="5" max="5000" step="1" value="${routeEsc(stop.arrival_radius_m ?? 50)}"></label>
            <input class="rp-stop-lat" type="hidden" value="${routeEsc(stop.latitude ?? '')}">
            <input class="rp-stop-lng" type="hidden" value="${routeEsc(stop.longitude ?? '')}">
            <button type="button" class="btn btn-danger" onclick="this.closest('.dashboard-route-stop-row').remove(); refreshDashboardRouteEditorMap();" title="Remove stop"><i class="mdi mdi-delete"></i></button>
        </div>
    `;
    const dragHandle = row.querySelector('.dashboard-route-stop-drag');
    dragHandle.addEventListener('click', e => e.stopPropagation());
    dragHandle.addEventListener('dragstart', e => {
        if (dashboardRouteEditorReadonlyState) {
            e.preventDefault();
            return;
        }
        dashboardRouteDraggedStopRow = row;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', '');
    });
    dragHandle.addEventListener('dragend', finishDashboardRouteStopDrag);
    row.querySelector('.rp-stop-kind').value = String(stop.stop_kind || 'stop').toLowerCase() === 'waypoint' ? 'waypoint' : 'stop';
    row.querySelectorAll('input, select').forEach(input => input.addEventListener('input', () => {
        refreshDashboardRouteStopSummaries();
        refreshDashboardRouteEditorMap();
    }));
    wrap.appendChild(row);
    dashboardRouteEditorReadonly(dashboardRouteEditorReadonlyState);
    refreshDashboardRouteStopSummaries();
    refreshDashboardRouteEditorMap();
}

function toggleDashboardRouteStopRow(row) {
    if (!row) return;
    row.classList.toggle('expanded');
}

function refreshDashboardRouteStopSummaries() {
    [...document.querySelectorAll('#dashboardRouteStops .dashboard-route-stop-row')].forEach((row, index) => {
        const name = row.querySelector('.rp-stop-name')?.value.trim() || `Stop ${index + 1}`;
        const kind = row.querySelector('.rp-stop-kind')?.value || 'stop';
        const radius = row.querySelector('.rp-stop-radius')?.value || '50';
        const status = row.dataset.status || 'pending';
        const idx = row.querySelector('.dashboard-route-stop-index');
        const title = row.querySelector('.dashboard-route-stop-summary-title');
        const meta = row.querySelector('.dashboard-route-stop-summary-meta');
        if (idx) idx.textContent = index + 1;
        if (title) title.textContent = name;
        if (meta) meta.textContent = `${dashboardRouteStopKindLabel({ stop_kind: kind })} · ${routeStatusLabel(status)} · ${radius}m radius`;
    });
}

function collectDashboardRouteStops() {
    return [...document.querySelectorAll('#dashboardRouteStops .dashboard-route-stop-row')].map(row => {
        const latitude = parseFloat(row.querySelector('.rp-stop-lat')?.value);
        const longitude = parseFloat(row.querySelector('.rp-stop-lng')?.value);
        return {
            name: row.querySelector('.rp-stop-name')?.value.trim(),
            latitude,
            longitude,
            stop_kind: row.querySelector('.rp-stop-kind')?.value || 'stop',
            arrival_radius_m: parseInt(row.querySelector('.rp-stop-radius')?.value || '50', 10),
            service_minutes: 0,
            dwell_seconds: 0,
        };
    })
        .filter(stop => Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude))
        .map((stop, index) => ({
            ...stop,
            sequence: index,
            name: stop.name || `Stop ${index + 1}`,
        }));
}

function dashboardRouteStopSignature(stops) {
    return stops.map(stop => [
        Number(stop.latitude).toFixed(6),
        Number(stop.longitude).toFixed(6),
    ].join(',')).join('|');
}

function scheduleDashboardRouteEditorPreview(stops, signature) {
    if (dashboardRouteEditorReadonlyState || stops.length < 2) return;
    clearTimeout(dashboardRouteEditorPreviewTimer);
    dashboardRouteEditorPreviewSignature = signature;
    dashboardRouteEditorPreviewTimer = setTimeout(async () => {
        try {
            const previewStops = stops.map((stop, index) => ({
                sequence: index,
                name: stop.name || `Stop ${index + 1}`,
                latitude: Number(stop.latitude),
                longitude: Number(stop.longitude),
                stop_kind: stop.stop_kind || 'stop',
                arrival_radius_m: Number(stop.arrival_radius_m || 50),
                service_minutes: 0,
                dwell_seconds: 0,
            }));
            const res = await apiFetch(`${API_BASE}/planned-routes/preview`, {
                method: 'POST',
                body: JSON.stringify({ stops: previewStops }),
            });
            if (!res.ok) return;
            const preview = await res.json();
            if (dashboardRouteEditorPreviewSignature !== signature) return;
            dashboardRouteEditorGeometry = {
                geometry: preview.route_geometry,
                signature,
            };
            refreshDashboardRouteEditorMap({ schedulePreview: false });
        } catch (_) {
            // Keep the direct polyline fallback if preview routing is unavailable.
        }
    }, 500);
}

function initDashboardRouteEditorMap() {
    if (dashboardRouteEditorMap || !window.L || !document.getElementById('dashboardRouteEditorMap')) return;
    dashboardRouteEditorMap = L.map('dashboardRouteEditorMap', { zoomControl: true, attributionControl: true }).setView([39.0742, 21.8243], 6);
    const tileKey = localStorage.getItem('mapTileLayer') || 'openstreetmap_dark';
    const tile = (typeof MAP_TILES !== 'undefined' && MAP_TILES[tileKey]) ? MAP_TILES[tileKey] : {
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19,
    };
    dashboardRouteEditorTileLayer = L.tileLayer(tile.url, {
        attribution: tile.attribution,
        maxZoom: tile.maxZoom || 19,
    }).addTo(dashboardRouteEditorMap);
    setTimeout(() => {
        const tileContainer = dashboardRouteEditorTileLayer?.getContainer();
        if (tileContainer) tileContainer.style.filter = tile.cssFilter || '';
    }, 0);
    dashboardRouteEditorStopLayer = L.layerGroup().addTo(dashboardRouteEditorMap);
    dashboardRouteEditorMap.on('click', e => {
        if (dashboardRouteEditorReadonlyState) return;
        addDashboardRouteStop({
            name: `Stop ${collectDashboardRouteStops().length + 1}`,
            latitude: Number(e.latlng.lat).toFixed(6),
            longitude: Number(e.latlng.lng).toFixed(6),
            arrival_radius_m: 50,
        });
    });
}

function dashboardRouteEditorStopIcon(index, stop) {
    const kindCls = String(stop.stop_kind || 'stop').toLowerCase() === 'waypoint' ? 'waypoint' : 'stop';
    const status = String(stop.status || 'pending').toLowerCase();
    const statusCls = status === 'completed' ? 'done' : status === 'arrived' ? 'arrived' : 'pending';
    return L.divIcon({
        className: `route-plan-stop-marker ${kindCls} ${statusCls}`,
        html: `<span>${index + 1}</span>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
    });
}

function refreshDashboardRouteEditorMap({ fit = false, schedulePreview = true } = {}) {
    if (!dashboardRouteEditorMap || !dashboardRouteEditorStopLayer) return;
    refreshDashboardRouteStopSummaries();
    dashboardRouteEditorStopLayer.clearLayers();
    if (dashboardRouteEditorLine) {
        dashboardRouteEditorLine.remove();
        dashboardRouteEditorLine = null;
    }

    const rows = [...document.querySelectorAll('#dashboardRouteStops .dashboard-route-stop-row')];
    const stops = rows.map(row => {
        const latitude = parseFloat(row.querySelector('.rp-stop-lat')?.value);
        const longitude = parseFloat(row.querySelector('.rp-stop-lng')?.value);
        return {
            row,
            name: row.querySelector('.rp-stop-name')?.value.trim(),
            latitude,
            longitude,
            stop_kind: row.querySelector('.rp-stop-kind')?.value || 'stop',
            arrival_radius_m: parseInt(row.querySelector('.rp-stop-radius')?.value || '50', 10),
            status: row.dataset.status || 'pending',
        };
    })
        .filter(stop => Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude))
        .map((stop, index) => ({
            ...stop,
            index,
            name: stop.name || `Stop ${index + 1}`,
        }));

    const latLngs = stops.map(stop => [stop.latitude, stop.longitude]);
    const geometryStops = stops.map(stop => ({ latitude: stop.latitude, longitude: stop.longitude }));
    const geometryLatLngs = dashboardRouteEditorGeometry
        && dashboardRouteEditorGeometry.signature === dashboardRouteStopSignature(geometryStops)
        ? dashboardRouteLatLngs({ route_geometry: dashboardRouteEditorGeometry.geometry, stops: geometryStops })
        : [];
    const lineLatLngs = geometryLatLngs.length > 1 ? geometryLatLngs : latLngs;
    if (lineLatLngs.length > 1) {
        dashboardRouteEditorLine = L.polyline(lineLatLngs, { color: '#38bdf8', weight: 4, opacity: 0.9 }).addTo(dashboardRouteEditorMap);
    }

    stops.forEach(stop => {
        const marker = L.marker([stop.latitude, stop.longitude], {
            draggable: !dashboardRouteEditorReadonlyState,
            icon: dashboardRouteEditorStopIcon(stop.index, stop),
        }).addTo(dashboardRouteEditorStopLayer);
        marker.bindPopup(`<strong>${routeEsc(stop.name)}</strong><div>${routeEsc(dashboardRouteStopKindLabel(stop))}</div>`);
        marker.on('dragend', e => {
            if (dashboardRouteEditorReadonlyState) return;
            const ll = e.target.getLatLng();
            stop.row.querySelector('.rp-stop-lat').value = ll.lat.toFixed(6);
            stop.row.querySelector('.rp-stop-lng').value = ll.lng.toFixed(6);
            refreshDashboardRouteEditorMap();
        });
        L.circle([stop.latitude, stop.longitude], {
            radius: Number(stop.arrival_radius_m || 50),
            color: dashboardRouteStopColor(stop),
            weight: 2,
            opacity: 0.95,
            fillColor: dashboardRouteStopColor(stop),
            fillOpacity: 0.18,
            interactive: false,
        }).addTo(dashboardRouteEditorStopLayer);
    });

    if (fit && latLngs.length) {
        dashboardRouteEditorMap.fitBounds(L.latLngBounds([...latLngs, ...geometryLatLngs]).pad(0.2), { maxZoom: 15 });
    }
    if (schedulePreview && stops.length > 1) {
        scheduleDashboardRouteEditorPreview(stops, dashboardRouteStopSignature(geometryStops));
    }
}

async function openDashboardRouteEditor(routeId = null) {
    const modal = document.getElementById('dashboardRouteEditorModal');
    if (!modal) return;
    await loadDashboardRoutes({ force: !dashboardRoutesLoaded });
    dashboardRouteEditorId = routeId;
    const route = routeId ? dashboardRoutes.find(r => Number(r.id) === Number(routeId)) : null;
    const readonly = route && dashboardRouteIsViewOnly(route);
    document.getElementById('dashboardRouteEditorTitle').textContent = route ? (readonly ? 'View Route' : 'Edit Route') : 'New Route';
    document.getElementById('dashboardRouteName').value = route?.name || '';
    populateDashboardRouteDeviceSelect(route?.device_id || '');
    document.getElementById('dashboardRouteStops').innerHTML = '';
    (route?.stops?.length ? route.stops.slice().sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0)) : []).forEach(stop => addDashboardRouteStop(stop));
    const editorStops = collectDashboardRouteStops();
    dashboardRouteEditorGeometry = route?.route_geometry
        ? { geometry: route.route_geometry, signature: dashboardRouteStopSignature(editorStops) }
        : null;
    const deleteBtn = document.getElementById('dashboardRouteDeleteBtn');
    if (deleteBtn) deleteBtn.style.display = route && !readonly ? '' : 'none';
    const showMapBtn = document.getElementById('dashboardRouteShowMapBtn');
    if (showMapBtn) showMapBtn.style.display = route ? '' : 'none';
    const detailsBtn = document.getElementById('dashboardRouteDetailsBtn');
    if (detailsBtn) detailsBtn.style.display = route ? '' : 'none';
    modal.classList.add('active');
    dashboardRouteEditorReadonly(Boolean(readonly));
    initDashboardRouteEditorMap();
    setTimeout(() => {
        dashboardRouteEditorMap?.invalidateSize();
        refreshDashboardRouteEditorMap({ fit: true });
    }, 100);
    setTimeout(() => document.getElementById('dashboardRouteName')?.focus(), 50);
}

function closeDashboardRouteEditor() {
    document.getElementById('dashboardRouteEditorModal')?.classList.remove('active');
}

function dashboardRouteCompanyForDevice(deviceId) {
    const device = Array.isArray(devices) ? devices.find(d => Number(d.id) === Number(deviceId)) : null;
    return device?.company_id || (parseInt(localStorage.getItem('company_id') || '0', 10) || null);
}

async function saveDashboardRouteEditor() {
    const name = document.getElementById('dashboardRouteName')?.value.trim();
    const stops = collectDashboardRouteStops();
    if (stops.length < 2) {
        showAlert({ title: 'Route Save Failed', message: 'Add at least two valid stops', type: 'error' });
        return;
    }
    if (!name) {
        showAlert({ title: 'Route Save Failed', message: 'Route name is required', type: 'error' });
        return;
    }
    const deviceId = parseInt(document.getElementById('dashboardRouteDevice')?.value || '0', 10) || null;
    const payload = {
        name,
        device_id: deviceId,
        stops,
    };
    const currentRoute = dashboardRouteEditorId
        ? dashboardRoutes.find(r => Number(r.id) === Number(dashboardRouteEditorId))
        : null;
    const currentStatus = String(currentRoute?.status || '').toLowerCase();
    if (!dashboardRouteEditorId) {
        payload.status = dashboardRouteAssignmentStatus(deviceId);
        payload.company_id = dashboardRouteCompanyForDevice(deviceId);
    } else if (currentStatus === 'draft' || currentStatus === 'planned') {
        payload.status = dashboardRouteAssignmentStatus(deviceId);
    }

    const btn = document.getElementById('dashboardRouteSaveBtn');
    const original = btn?.innerHTML;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i> Saving';
    }
    try {
        const res = await apiFetch(`${API_BASE}/planned-routes${dashboardRouteEditorId ? `/${dashboardRouteEditorId}` : ''}`, {
            method: dashboardRouteEditorId ? 'PUT' : 'POST',
            body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error((await res.json()).detail || 'Failed to save route');
        const route = await res.json();
        renderDashboardRouteMutation(route);
        broadcastDashboardRouteUpdate(route);
        closeDashboardRouteEditor();
        if (document.getElementById('dashboardRoutesModal')?.classList.contains('active')) renderDashboardRoutesModal();
        showAlert({ title: 'Route Saved', message: dashboardRouteEditorId ? 'Route updated' : 'Route created', type: 'success' });
    } catch (e) {
        showAlert({ title: 'Route Save Failed', message: e.message, type: 'error' });
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    }
}

async function deleteDashboardRouteFromEditor() {
    if (!dashboardRouteEditorId || !confirm('Delete this route?')) return;
    try {
        const res = await apiFetch(`${API_BASE}/planned-routes/${dashboardRouteEditorId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).detail || 'Failed to delete route');
        removeDashboardRoute(dashboardRouteEditorId);
        closeDashboardRouteEditor();
        showAlert({ title: 'Route Deleted', message: 'Route removed', type: 'success' });
    } catch (e) {
        showAlert({ title: 'Route Delete Failed', message: e.message, type: 'error' });
    }
}

async function resetDashboardRoute(routeId) {
    const route = dashboardRoutes.find(r => Number(r.id) === Number(routeId));
    await setDashboardRouteStatus(routeId, dashboardRouteAssignmentStatus(route?.device_id));
}

async function openDashboardRouteDetails(routeId) {
    let route = dashboardRoutes.find(r => Number(r.id) === Number(routeId));
    try {
        const res = await apiFetch(`${API_BASE}/planned-routes/${routeId}`);
        if (res.ok) route = await res.json();
    } catch (_) {}
    if (!route) return;
    upsertDashboardRoute(route);
    const modal = document.getElementById('dashboardRouteDetailsModal');
    const body = document.getElementById('dashboardRouteDetailsBody');
    if (!modal || !body) return;
    const stops = dashboardRouteOrderedStops(route);
    const progress = dashboardRouteProgress(route);
    document.getElementById('dashboardRouteDetailsTitle').textContent = route.name || 'Route Details';
    body.innerHTML = `
        <div class="dashboard-route-details-grid">
            <div class="dashboard-route-detail-section"><div class="dashboard-route-detail-label">Status</div><div class="dashboard-route-detail-value">${routeEsc(routeStatusLabel(route.status))}</div></div>
            <div class="dashboard-route-detail-section"><div class="dashboard-route-detail-label">Vehicle</div><div class="dashboard-route-detail-value">${routeEsc(dashboardRouteDeviceName(route))}</div></div>
            <div class="dashboard-route-detail-section"><div class="dashboard-route-detail-label">Progress</div><div class="dashboard-route-detail-value">${progress.done}/${progress.total} points complete</div></div>
            <div class="dashboard-route-detail-section"><div class="dashboard-route-detail-label">Distance</div><div class="dashboard-route-detail-value">${Number(route.distance_km || 0).toFixed(1)} km</div></div>
            <div class="dashboard-route-detail-section"><div class="dashboard-route-detail-label">Duration</div><div class="dashboard-route-detail-value">${Number(route.duration_minutes || 0).toFixed(0)} min</div></div>
            <div class="dashboard-route-detail-section"><div class="dashboard-route-detail-label">Updated</div><div class="dashboard-route-detail-value">${routeEsc(dashboardRouteDateTime(route.updated_at))}</div></div>
        </div>
        <div style="overflow-x:auto;">
            <table class="dashboard-route-stops-table">
                <thead><tr><th>#</th><th>Point</th><th>Type</th><th>Status</th><th>Arrived</th><th>Completed</th><th>Radius</th><th>Coordinates</th></tr></thead>
                <tbody>${stops.map((stop, index) => `
                    <tr>
                        <td>${index + 1}</td>
                        <td>${routeEsc(stop.name || `Point ${index + 1}`)}</td>
                        <td>${routeEsc(dashboardRouteStopKindLabel(stop))}</td>
                        <td>${routeEsc(routeStatusLabel(stop.status || 'pending'))}</td>
                        <td>${routeEsc(dashboardRouteDateTime(stop.arrived_at))}</td>
                        <td>${routeEsc(dashboardRouteDateTime(stop.completed_at))}</td>
                        <td>${Number(stop.arrival_radius_m || 50)}m</td>
                        <td>${Number(stop.latitude).toFixed(6)}, ${Number(stop.longitude).toFixed(6)}</td>
                    </tr>
                `).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);">No route points configured.</td></tr>'}</tbody>
            </table>
        </div>
    `;
    modal.classList.add('active');
}

function closeDashboardRouteDetails() {
    document.getElementById('dashboardRouteDetailsModal')?.classList.remove('active');
}

async function updateDashboardRouteStop(routeId, stopId, payload) {
    const key = `${routeId}:${stopId}`;
    if (dashboardRouteUpdatingStops.has(key)) return false;
    dashboardRouteUpdatingStops.add(key);
    try {
        const res = await apiFetch(`${API_BASE}/planned-routes/${routeId}/stops/${stopId}`, {
            method: 'PUT',
            body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error((await res.json()).detail || 'Failed to update stop');
        const route = await refreshSelectedDashboardRoute({ force: true });
        broadcastDashboardRouteUpdate(route);
        return true;
    } finally {
        dashboardRouteUpdatingStops.delete(key);
    }
}

async function completeDashboardRouteStop(routeId, stopId) {
    try {
        const routeBefore = dashboardRoutes.find(r => Number(r.id) === Number(routeId));
        const completesRoute = dashboardRoutePointCompletesTrip(routeBefore, stopId);
        await updateDashboardRouteStop(routeId, stopId, {
            status: 'completed',
            completed_at: new Date().toISOString(),
        });
        if (completesRoute) {
            await setDashboardRouteStatus(routeId, 'completed');
        }
    } catch (e) {
        showAlert({ title: 'Stop Update Failed', message: e.message, type: 'error' });
    }
}

function fitSelectedDashboardRoute({ fly = false } = {}) {
    if (!map || !selectedDashboardRoute) return;
    const bounds = dashboardRouteBounds(selectedDashboardRoute);
    if (!bounds.isValid()) return;
    const options = {
        paddingTopLeft: [getSidebarOffset(), 16],
        paddingBottomRight: [16, 16],
    };
    if (fly && typeof map.flyToBounds === 'function') {
        map.flyToBounds(bounds.pad(0.18), {
            ...options,
            duration: 0.65,
            easeLinearity: 0.25,
        });
    } else {
        map.fitBounds(bounds.pad(0.18), options);
    }
}

function fitDashboardRouteWithVehicle(route, vehicleLatLng) {
    if (!map || !route || !vehicleLatLng) return false;
    const bounds = dashboardRouteBounds(route);
    const vehiclePoint = L.latLng(vehicleLatLng);
    if (vehiclePoint && Number.isFinite(vehiclePoint.lat) && Number.isFinite(vehiclePoint.lng)) {
        bounds.extend(vehiclePoint);
    }
    if (!bounds.isValid()) return false;
    map.fitBounds(bounds.pad(0.18), {
        paddingTopLeft: [getSidebarOffset(), 16],
        paddingBottomRight: [16, 16],
        maxZoom: 16,
    });
    return true;
}

document.addEventListener('DOMContentLoaded', () => {
    const panel = document.getElementById('selectedRoutePanel');
    if (panel) panel.style.display = 'none';
});
