/**
 * Geofences Module — web/js/geofences.js
 *
 * Handles all geofence rendering, creation, editing, and deletion on the map.
 * Depends on: Leaflet, Leaflet.draw, apiFetch, API_BASE (from config.js)
 *
 * Public API (called from dashboard.js):
 *   initGeofences(mapInstance)   — call after initMap()
 *   reloadGeofences()            — re-fetch and re-render all geofences
 */

// ── Buffer polygon helper ─────────────────────────────────────────────────────
/**
 * Build an approximate corridor polygon around a polyline with rounded end caps.
 * Returns an array of [lat, lng] pairs suitable for L.polygon.
 */
function _polylineBufferPolygon(latlngs, bufferMeters) {
    if (latlngs.length < 2) return [];
    const bufDeg = bufferMeters / 111320;
    const CAP_STEPS = 16;
    const left = [], right = [];

    for (let i = 0; i < latlngs.length; i++) {
        const prev = latlngs[Math.max(i - 1, 0)];
        const next = latlngs[Math.min(i + 1, latlngs.length - 1)];
        const dx = next.lng - prev.lng;
        const dy = next.lat - prev.lat;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const px = (-dy / len) * bufDeg;
        const py = ( dx / len) * bufDeg;
        left.push( [latlngs[i].lat + py, latlngs[i].lng + px]);
        right.push([latlngs[i].lat - py, latlngs[i].lng - px]);
    }

    // Sweep a semicircle (clockwise) around a cap point, starting at startAngle
    function cap(center, startAngle) {
        const pts = [];
        for (let i = 0; i <= CAP_STEPS; i++) {
            const a = startAngle - (i / CAP_STEPS) * Math.PI;
            pts.push([center.lat + Math.sin(a) * bufDeg, center.lng + Math.cos(a) * bufDeg]);
        }
        return pts;
    }

    // End cap: sweep clockwise from last-left to last-right around the final point
    const last = latlngs[latlngs.length - 1];
    const prevLast = latlngs[latlngs.length - 2];
    const eDx = last.lng - prevLast.lng, eDy = last.lat - prevLast.lat;
    const eLen = Math.sqrt(eDx * eDx + eDy * eDy) || 1;
    const endCap = cap(last, Math.atan2(eDx / eLen, -eDy / eLen));

    // Start cap: sweep clockwise from first-right to first-left around the first point
    const first = latlngs[0];
    const second = latlngs[1];
    const sDx = second.lng - first.lng, sDy = second.lat - first.lat;
    const sLen = Math.sqrt(sDx * sDx + sDy * sDy) || 1;
    const startCap = cap(first, Math.atan2(-sDx / sLen, sDy / sLen));

    return [...left, ...endCap, ...right.reverse(), ...startCap];
}

// ── Role helpers ──────────────────────────────────────────────────────────────
const _isAdmin        = () => localStorage.getItem('is_admin') === 'true';
const _isCompanyAdmin = () => localStorage.getItem('is_company_admin') === 'true';
const _canAssignOwner = () => _isAdmin() || _isCompanyAdmin();

// ── State ─────────────────────────────────────────────────────────────────────
let _map = null;
let _geofenceLayer = null;        // L.FeatureGroup holding all rendered shapes
let _drawControl = null;          // Active Leaflet.draw control (if any)
let _editingLayer = null;         // The single layer currently in edit mode
let _editingGeofenceId = null;    // ID of geofence being edited (null = new)
let _pendingCoords = null;        // Coords of a freshly drawn shape waiting to be saved
let _pendingType = 'polygon';     // 'polygon' | 'polyline'
let _geofences = [];              // Local cache [{id, name, color, coords, type}, ...]
let _showAllUsersGeofences = false;
let _mapDraggedRecently = false;

// ── Init ──────────────────────────────────────────────────────────────────────
function initGeofences(mapInstance) {
    _map = mapInstance;

    _map.on('dragstart', () => { _mapDraggedRecently = true; });
    _map.on('dragend',   () => { setTimeout(() => { _mapDraggedRecently = false; }, 250); });

    // Feature group that Leaflet.draw uses for edit toolbar
    _geofenceLayer = new L.FeatureGroup().addTo(_map);

    if (_canAssignOwner()) {
        const wrap = document.getElementById('geofenceAllUsersToggleWrap');
        if (wrap) wrap.style.display = '';
    }

    reloadGeofences();
}

// ── Load & Render ─────────────────────────────────────────────────────────────
async function reloadGeofences() {
    try {
        const res = await apiFetch(`${API_BASE}/geofences`);
        if (!res.ok) throw new Error('Failed to fetch geofences');
        _geofences = await res.json();
    } catch (e) {
        console.error('Geofences load error:', e);
        _geofences = [];
    }
    _renderAll();
}

function _renderAll() {
    _geofenceLayer.clearLayers();

    const currentUserId = parseInt(localStorage.getItem('user_id'), 10);
    _geofences.forEach(gf => {
        if (!gf.coordinates || gf.coordinates.length === 0) return;
        if (_canAssignOwner() && !_showAllUsersGeofences && gf.user_id !== currentUserId) return;
        _addLayerToMap(gf);
    });
}

function toggleAllUsersGeofences() {
    _showAllUsersGeofences = !_showAllUsersGeofences;

    const btn = document.getElementById('geofenceAllUsersToggleBtn');
    if (btn) {
        btn.innerHTML = _showAllUsersGeofences
            ? '<i class="mdi mdi-eye-outline"></i> Hide other users\' geofences'
            : '<i class="mdi mdi-eye-off-outline"></i> Show other users\' geofences';
    }

    _renderAll();
}

function _addLayerToMap(gf) {
    const color = gf.color || '#3388ff';
    const styleOpts = {
        color,
        fillColor: color,
        fillOpacity: 0.15,
        weight: 2,
        opacity: 0.8,
    };

    let layer;
    const isLine = gf.geometry_type === 'polyline';

    if (isLine) {
        const latlngs = gf.coordinates.map(c => ({ lat: c[1], lng: c[0] }));
        layer = L.polyline(latlngs.map(ll => [ll.lat, ll.lng]), { ...styleOpts, fillOpacity: 0 });

        // Draw the corridor buffer as a semi-transparent polygon
        const bufferMeters = gf.buffer_meters || 50;
        const corridor = _polylineBufferPolygon(latlngs, bufferMeters);
        if (corridor.length > 0) {
            const corridorLayer = L.polygon(corridor, {
                color,
                fillColor: color,
                fillOpacity: 0.12,
                weight: 0,
            });
            const corridorTooltip = (_canAssignOwner() && gf.owner_username)
                ? `${gf.name}<br><span style="font-size:0.8em;opacity:0.7">${gf.owner_username}</span>`
                : gf.name;
            corridorLayer.bindTooltip(corridorTooltip, {
                permanent: false,
                direction: 'center',
                className: 'geofence-tooltip',
            });
            corridorLayer.on('click', (e) => {
                if (_drawControl || _mapDraggedRecently || !hasPermission('manage_geofences')) return;
                L.DomEvent.stopPropagation(e);
                _enterEditMode(layer, gf.id);
            });
            _geofenceLayer.addLayer(corridorLayer);
        }
    } else {
        // Polygon — [lat, lng] pairs
        const latlngs = gf.coordinates.map(c => [c[1], c[0]]);
        layer = L.polygon(latlngs, styleOpts);
    }

    // Attach metadata so we can identify it on click
    layer._geofenceId = gf.id;
    layer._geofenceData = gf;

    // Label tooltip
    const tooltipContent = (_canAssignOwner() && gf.owner_username)
        ? `${gf.name}<br><span style="font-size:0.8em;opacity:0.7">${gf.owner_username}</span>`
        : gf.name;
    layer.bindTooltip(tooltipContent, {
        permanent: false,
        direction: 'center',
        className: 'geofence-tooltip',
    });

    // Click → enter edit mode (only if user can manage geofences)
    layer.on('click', (e) => {
        if (_drawControl || _mapDraggedRecently || !hasPermission('manage_geofences')) return;
        L.DomEvent.stopPropagation(e);
        _enterEditMode(layer, gf.id);
    });

    _geofenceLayer.addLayer(layer);
    return layer;
}

// ── Draw Mode (create new) ────────────────────────────────────────────────────
function startDrawGeofence(type = 'polygon') {
    if (_editingLayer) _cancelEdit();
    _cancelDraw();

    _pendingType = type;

    const options = type === 'polyline'
        ? new L.Draw.Polyline(_map, { shapeOptions: { color: '#3b82f6', weight: 3 } })
        : new L.Draw.Polygon(_map, {
            shapeOptions: { color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.15, weight: 2 },
            allowIntersection: false,
        });

    options.enable();
    _drawControl = options;

    // Listen for the shape being completed
    _map.once(L.Draw.Event.CREATED, _onDrawCreated);

    // Update button UI
    _setDrawButtonActive(true);
}

function _onDrawCreated(e) {
    _drawControl = null;
    _setDrawButtonActive(false);

    const layer = e.layer;

    // Extract coords as [lng, lat] (GeoJSON order for backend)
    let coords;
    if (_pendingType === 'polyline') {
        coords = layer.getLatLngs().map(ll => [ll.lng, ll.lat]);
    } else {
        coords = layer.getLatLngs()[0].map(ll => [ll.lng, ll.lat]);
        // Close polygon if not closed
        if (coords.length > 0) {
            const first = coords[0], last = coords[coords.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
        }
    }

    _pendingCoords = coords;

    // Show the save modal for a new geofence
    _openGeofenceModal(null, null, _pendingType);
}

function _cancelDraw() {
    if (_drawControl) {
        _drawControl.disable();
        _drawControl = null;
        _map.off(L.Draw.Event.CREATED, _onDrawCreated);
        _setDrawButtonActive(false);
    }
    _pendingCoords = null;
}

// ── Edit Mode (existing geofence) ─────────────────────────────────────────────
function _enterEditMode(layer, geofenceId) {
    if (_editingLayer) _cancelEdit();

    _editingLayer = layer;
    _editingGeofenceId = geofenceId;

    // Make the shape editable
    if (layer.editing) layer.editing.enable();

    // Show the floating edit toolbar
    _showEditToolbar(geofenceId);

    // Cancel on next map click outside the shape
    setTimeout(() => _map.once('click', cancelGeofenceEdit), 0);
}

function _cancelEdit() {
    if (_editingLayer) {
        if (_editingLayer.editing) _editingLayer.editing.disable();
        _editingLayer = null;
        _editingGeofenceId = null;
    }
    _map.off('click', cancelGeofenceEdit);
    _hideEditToolbar();
}

function _getEditedCoords() {
    if (!_editingLayer) return null;
    const isLine = _editingLayer instanceof L.Polyline && !(_editingLayer instanceof L.Polygon);

    if (isLine) {
        return _editingLayer.getLatLngs().map(ll => [ll.lng, ll.lat]);
    } else {
        const lls = _editingLayer.getLatLngs()[0];
        const coords = lls.map(ll => [ll.lng, ll.lat]);
        if (coords.length > 0) {
            const first = coords[0], last = coords[coords.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
        }
        return coords;
    }
}

// ── Edit Toolbar (floating over map) ─────────────────────────────────────────
function _showEditToolbar(geofenceId) {
    const gf = _geofences.find(g => g.id === geofenceId);
    const toolbar = document.getElementById('geofenceEditToolbar');
    const nameEl = document.getElementById('geofenceEditName');
    const ownerEl = document.getElementById('geofenceEditOwner');
    if (nameEl && gf) nameEl.textContent = gf.name;
    if (ownerEl) {
        if (_canAssignOwner() && gf?.owner_username) {
            ownerEl.textContent = gf.owner_username;
            ownerEl.style.display = '';
        } else {
            ownerEl.style.display = 'none';
        }
    }
    if (toolbar) toolbar.style.display = 'flex';
}

function _hideEditToolbar() {
    const toolbar = document.getElementById('geofenceEditToolbar');
    if (toolbar) toolbar.style.display = 'none';
}

// Called by the "Save" button in the edit toolbar
function saveEditedGeofence() {
    if (!_editingLayer) return;
    const gf = _geofences.find(g => g.id === _editingGeofenceId);
    _pendingCoords = _getEditedCoords();
    _openGeofenceModal(_editingGeofenceId, gf, gf?.geometry_type || 'polygon');
}

// Called by the "Delete" button in the edit toolbar
async function deleteGeofence() {
    if (!_editingGeofenceId) return;

    if (!confirm('Delete this geofence? This cannot be undone.')) return;

    try {
        const res = await apiFetch(`${API_BASE}/geofences/${_editingGeofenceId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Delete failed');
        _cancelEdit();
        await reloadGeofences();
        showAlert('Geofence deleted.', 'success');
    } catch (e) {
        console.error(e);
        showAlert('Failed to delete geofence.', 'error');
    }
}

// Called by "Cancel" in the edit toolbar
function cancelGeofenceEdit() {
    _cancelEdit();
    _cancelDraw();
    reloadGeofences(); // Re-render to discard any visual edits
}

// ── Save / Name Modal ─────────────────────────────────────────────────────────
async function _openGeofenceModal(id, gf, type) {
    document.getElementById('geofenceModalId').value = id || '';
    document.getElementById('geofenceModalType').value = type || 'polygon';
    document.getElementById('geofenceModalName').value = gf?.name || '';
    document.getElementById('geofenceModalDescription').value = gf?.description || '';
    document.getElementById('geofenceModalColor').value = gf?.color || '#3b82f6';
    document.getElementById('geofenceModalBuffer').value = gf?.buffer_meters ?? 50;

    const bufferGroup = document.getElementById('geofenceBufferGroup');
    if (bufferGroup) bufferGroup.style.display = type === 'polyline' ? '' : 'none';

    const ownerGroup = document.getElementById('geofenceOwnerGroup');
    if (ownerGroup) {
        if (_canAssignOwner()) {
            ownerGroup.style.display = '';
            await _populateOwnerDropdown(gf?.user_id ?? null);
        } else {
            ownerGroup.style.display = 'none';
        }
    }

    const titleEl = document.getElementById('geofenceModalTitle');
    if (titleEl) titleEl.textContent = id ? 'Edit Geofence' : 'Save Geofence';

    document.getElementById('geofenceModal').classList.add('active');
    setTimeout(() => document.getElementById('geofenceModalName').focus(), 100);
}

async function _populateOwnerDropdown(selectedUserId) {
    const select = document.getElementById('geofenceModalOwner');
    if (!select) return;

    const currentUserId = parseInt(localStorage.getItem('user_id'), 10);
    select.innerHTML = '';

    try {
        const res = await apiFetch(`${API_BASE}/users`);
        if (!res.ok) throw new Error();
        const users = await res.json();

        users.forEach(u => {
            const opt = document.createElement('option');
            opt.value = u.id;
            opt.textContent = u.username + (u.id === currentUserId ? ' (you)' : '');
            if (u.id === (selectedUserId ?? currentUserId)) opt.selected = true;
            select.appendChild(opt);
        });
    } catch {
        const opt = document.createElement('option');
        opt.value = currentUserId;
        opt.textContent = 'me';
        opt.selected = true;
        select.appendChild(opt);
    }
}

function closeGeofenceModal() {
    document.getElementById('geofenceModal').classList.remove('active');
    // If it was a new draw and user cancels, just reload to clear the temp shape
    if (!document.getElementById('geofenceModalId').value) {
        _pendingCoords = null;
        reloadGeofences();
    }
}

async function submitGeofenceModal() {
    const id = document.getElementById('geofenceModalId').value;
    const type = document.getElementById('geofenceModalType').value;
    const name = document.getElementById('geofenceModalName').value.trim();
    const description = document.getElementById('geofenceModalDescription').value.trim();
    const color = document.getElementById('geofenceModalColor').value;

    if (!name) {
        document.getElementById('geofenceModalName').focus();
        return;
    }

    const coords = _pendingCoords;
    if (!coords || coords.length === 0) {
        showAlert('No shape coordinates. Please draw again.', 'error');
        closeGeofenceModal();
        return;
    }

    const bufferMeters = parseInt(document.getElementById('geofenceModalBuffer').value, 10) || 50;

    const payload = {
        name,
        description: description || null,
        polygon: coords,   // backend field name (works for both types)
        color,
        geometry_type: type,
        buffer_meters: type === 'polyline' ? bufferMeters : 50,
    };

    const ownerGroup = document.getElementById('geofenceOwnerGroup');
    if (ownerGroup && ownerGroup.style.display !== 'none') {
        const ownerSelect = document.getElementById('geofenceModalOwner');
        if (ownerSelect?.value) payload.user_id = parseInt(ownerSelect.value, 10);
    }

    try {
        let res;
        if (id) {
            res = await apiFetch(`${API_BASE}/geofences/${id}`, {
                method: 'PUT',
                body: JSON.stringify(payload),
            });
        } else {
            res = await apiFetch(`${API_BASE}/geofences`, {
                method: 'POST',
                body: JSON.stringify(payload),
            });
        }

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Save failed');
        }

        closeGeofenceModal();
        _cancelEdit();
        _pendingCoords = null;
        await reloadGeofences();
        showAlert(id ? 'Geofence updated.' : 'Geofence created.', 'success');
    } catch (e) {
        console.error(e);
        showAlert(`Error: ${e.message}`, 'error');
    }
}

// ── Draw button UI helpers ────────────────────────────────────────────────────
function _setDrawButtonActive(active) {
    const btn = document.getElementById('drawGeofenceBtn');
    if (!btn) return;
    btn.style.background = active ? 'var(--accent-primary)' : 'var(--bg-card)';
    btn.style.color = active ? '#fff' : 'var(--text-primary)';
    btn.title = active ? 'Click on map to draw — press ESC to cancel' : 'Draw Geofence';
}

// Cancel draw on ESC key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        _cancelDraw();
        _cancelEdit();
    }
});

// ── Draw type dropdown toggle ─────────────────────────────────────────────────
function toggleDrawMenu() {
    const menu = document.getElementById('drawGeofenceMenu');
    if (!menu) return;
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function startDrawType(type) {
    const menu = document.getElementById('drawGeofenceMenu');
    if (menu) menu.style.display = 'none';
    startDrawGeofence(type);
}

// Close draw menu on outside click
document.addEventListener('click', (e) => {
    const btn = document.getElementById('drawGeofenceBtn');
    const menu = document.getElementById('drawGeofenceMenu');
    if (menu && btn && !btn.contains(e.target) && !menu.contains(e.target)) {
        menu.style.display = 'none';
    }
});
