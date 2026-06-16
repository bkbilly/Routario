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

try {
    dashboardRouteBroadcast = new BroadcastChannel('routario_route_updates');
    dashboardRouteBroadcast.onmessage = ({ data }) => {
        if (data?.type === 'route_update' && data.route) {
            applyDashboardRouteUpdate(data.route);
        }
    };
} catch (_) {}

const DASHBOARD_ROUTE_STATUSES = new Set(['active', 'started', 'in_progress', 'paused', 'planned', 'draft']);
const DASHBOARD_ACTIVE_ROUTE_STATUSES = new Set(['active', 'started', 'in_progress']);

function routeEsc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

function routeStatusLabel(status) {
    const value = String(status || 'draft').toLowerCase();
    return value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function routeCanManage() {
    return typeof hasPermission === 'function' && hasPermission('manage_routes');
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
    return 3;
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

    if (!route) {
        panel.style.display = 'none';
        panel.innerHTML = '';
        return;
    }

    const progress = dashboardRouteProgress(route);
    const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    const status = String(route.status || 'draft').toLowerCase();
    const canManage = routeCanManage();
    const canStart = canManage && (status === 'planned' || status === 'draft');
    const canPause = canManage && DASHBOARD_ACTIVE_ROUTE_STATUSES.has(status);
    const canResume = canManage && (status === 'paused' || status === 'stopped');
    const canComplete = canManage && (DASHBOARD_ACTIVE_ROUTE_STATUSES.has(status) || status === 'paused' || status === 'stopped');
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
    panel.innerHTML = `
        <div class="selected-route-header">
            <div>
                <div class="selected-route-eyebrow">Assigned route</div>
                <div class="selected-route-title">${routeEsc(route.name)}</div>
            </div>
            <div class="selected-route-header-actions">
                ${routePager}
                <span class="selected-route-status">${routeStatusLabel(route.status)}</span>
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
    } catch (e) {
        showAlert({ title: 'Route Update Failed', message: e.message, type: 'error' });
    }
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
