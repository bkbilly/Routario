'use strict';

let _rtpDevices = [];
let _rtpDrivers = [];
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
let _rtpRouteGeometry = null;
let _rtpRouteGeometrySignature = '';
let _rtpPreviewTimer = null;
let _rtpPreviewSignature = '';
let _rtpRouteReadonly = false;
let _rtpAuditRows = [];
let _rtpHealthRows = [];
let _rtpRouteRows = [];
let _rtpRouteSort = { col: 'name', dir: 'asc' };
let _rtpBillingSort = { col: 'name', dir: 'asc' };
let _rtpAuditSort = { col: 'time', dir: 'desc' };
let _rtpHealthSort = { col: 'name', dir: 'asc' };
let _rtpPlanCompanySelection = new Set();

function rtpEsc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
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
        rtpJson(`${API_BASE}/drivers`).catch(() => []),
        isAdmin ? rtpJson(`${API_BASE}/companies`).catch(() => []) : Promise.resolve([]),
    ];
    [_rtpDevices, _rtpDrivers, _rtpCompanies] = await Promise.all(reqs);
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
    document.querySelectorAll(`#${sectionId} .devices-table th[data-sort]`).forEach(th => {
        th.removeAttribute('data-sort-dir');
        if (th.dataset.sort === sortState.col) th.setAttribute('data-sort-dir', sortState.dir);
    });
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
    const drvSel = document.getElementById('rpDriver');
    if (!devSel || !drvSel) return;
    devSel.innerHTML = '<option value="">Unassigned</option>' + _rtpDevices.map(d => `<option value="${d.id}">${rtpEsc(d.name)}</option>`).join('');
    drvSel.innerHTML = '<option value="">Unassigned</option>' + _rtpDrivers.map(d => `<option value="${d.id}">${rtpEsc(d.name)}</option>`).join('');
}

function rtpInitRouteMap() {
    if (!window.L || _rtpMap) {
        setTimeout(() => _rtpMap?.invalidateSize(), 50);
        return;
    }
    _rtpMap = L.map('routePlanMap', { zoomControl: true, attributionControl: false }).setView([39.0742, 21.8243], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(_rtpMap);
    _rtpStopLayer = L.layerGroup().addTo(_rtpMap);
    _rtpMap.on('click', e => {
        if (_rtpRouteReadonly) return;
        rtpAddStop({ latitude: Number(e.latlng.lat.toFixed(6)), longitude: Number(e.latlng.lng.toFixed(6)) });
    });
    setTimeout(() => _rtpMap.invalidateSize(), 100);
}

function rtpAddStop(stop = {}) {
    const box = document.getElementById('rpStops');
    const row = document.createElement('div');
    row.className = 'route-stop-row stack-item';
    row.innerHTML = `
        <div class="route-order-controls">
            <button type="button" class="btn btn-secondary" onclick="rtpMoveStop(this, -1)" title="Move up"><i class="mdi mdi-chevron-up"></i></button>
            <button type="button" class="btn btn-secondary" onclick="rtpMoveStop(this, 1)" title="Move down"><i class="mdi mdi-chevron-down"></i></button>
        </div>
        <label><span>Name</span><input class="form-input rp-stop-name" value="${rtpEsc(stop.name || '')}" placeholder="Stop name"></label>
        <label><span>Latitude</span><input class="form-input rp-lat" type="number" step="0.000001" value="${stop.latitude ?? ''}"></label>
        <label><span>Longitude</span><input class="form-input rp-lng" type="number" step="0.000001" value="${stop.longitude ?? ''}"></label>
        <button class="icon-btn-danger" onclick="this.closest('.route-stop-row').remove(); rtpRefreshRouteMap();" title="Remove"><i class="mdi mdi-delete"></i></button>
    `;
    box.appendChild(row);
    row.querySelectorAll('input').forEach(input => input.addEventListener('input', rtpRefreshRouteMap));
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
        L.marker([s.latitude, s.longitude], { draggable: !_rtpRouteReadonly })
            .addTo(_rtpStopLayer)
            .bindTooltip(String(idx + 1), { permanent: true, direction: 'top' })
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

function rtpClearRouteForm() {
    _rtpEditingRouteId = null;
    rtpSetRouteReadonly(false);
    document.getElementById('rpName').value = '';
    document.getElementById('rpDevice').value = '';
    document.getElementById('rpDriver').value = '';
    document.getElementById('rpStops').innerHTML = '';
    document.getElementById('rpSaveLabel').textContent = 'Save Route';
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
    ['rpName', 'rpDevice', 'rpDriver'].forEach(id => {
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
    document.querySelectorAll('#rpStops input, #rpStops button').forEach(el => {
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
            document.getElementById('rpDriver').value = r.driver_id || '';
            document.getElementById('rpStops').innerHTML = '';
            _rtpRouteGeometry = r.route_geometry || null;
            rtpSetRouteReadonly(readonly);
            (r.stops || []).forEach(stop => rtpAddStop(stop));
            _rtpRouteGeometrySignature = rtpStopSignature(rtpCollectStops());
            document.getElementById('rpSaveLabel').textContent = 'Update Route';
            const title = document.getElementById('routeModalTitle');
            if (title) title.textContent = readonly ? 'View Route' : 'Edit Route';
            rtpSetRouteReadonly(readonly);
            rtpRefreshRouteMap(false);
        } else {
            rtpClearRouteForm();
            const title = document.getElementById('routeModalTitle');
            if (title) title.textContent = 'Route Planner';
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
    const hasVehicle = Boolean(route.device_id);
    const actions = [`<button class="btn btn-secondary" onclick="rtpEditRoute(${route.id})"><i class="mdi ${isEditable ? 'mdi-pencil' : 'mdi-eye'}"></i> ${isEditable ? 'Edit' : 'View'}</button>`];

    if (status === 'active' || status === 'started' || status === 'in_progress') {
        actions.push(`<button class="btn btn-secondary" onclick="rtpSetRouteStatus(${route.id}, 'paused')"><i class="mdi mdi-pause"></i> Pause</button>`);
        actions.push(`<button class="btn btn-secondary" onclick="rtpSetRouteStatus(${route.id}, 'completed')"><i class="mdi mdi-check"></i> Complete</button>`);
    } else if (status === 'completed') {
        actions.push(`<button class="btn btn-secondary" onclick="rtpSetRouteStatus(${route.id}, 'draft')"><i class="mdi mdi-restore"></i> Reopen</button>`);
    } else if (status === 'paused' || status === 'stopped') {
        if (hasVehicle) actions.push(`<button class="btn btn-secondary" onclick="rtpStartRoute(${route.id})"><i class="mdi mdi-play"></i> Resume</button>`);
        actions.push(`<button class="btn btn-secondary" onclick="rtpSetRouteStatus(${route.id}, 'completed')"><i class="mdi mdi-check"></i> Complete</button>`);
    } else {
        if (hasVehicle) actions.push(`<button class="btn btn-secondary" onclick="rtpStartRoute(${route.id})"><i class="mdi mdi-play"></i> Start</button>`);
    }

    actions.push(`<button class="icon-btn-danger" onclick="rtpDeleteRoute(${route.id})" title="Delete"><i class="mdi mdi-delete"></i></button>`);
    return actions.join('');
}

function rtpRouteById(id) {
    return _rtpRouteRows.find(r => Number(r.id) === Number(id));
}

async function rtpStartRoute(id) {
    const route = rtpRouteById(id);
    if (!route?.device_id) {
        showAlert('Assign a vehicle before starting this route', 'error');
        return;
    }
    await rtpSetRouteStatus(id, 'active');
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
            driver_id: parseInt(document.getElementById('rpDriver').value || '0', 10) || null,
            stops,
        };
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
    body.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-muted);">Loading routes...</td></tr>';
    try {
        _rtpRouteRows = await rtpJson(`${API_BASE}/planned-routes`);
        rtpRenderRoutesTable();
    } catch (e) { body.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-muted);">${rtpEsc(e.message)}</td></tr>`; }
}

function rtpRouteValue(route, col) {
    const device = _rtpDevices.find(d => d.id === route.device_id);
    const driver = _rtpDrivers.find(d => d.id === route.driver_id);
    const values = {
        name: route.name,
        status: route.status,
        vehicle: device?.name || '',
        driver: driver?.name || '',
        stops: (route.stops || []).length,
        distance: Number(route.distance_km) || 0,
        duration: Number(route.duration_minutes) || 0,
    };
    return values[col];
}

function rtpRenderRoutesTable() {
    const body = document.getElementById('routesTableBody');
    if (!body) return;
    const q = (document.getElementById('routesSearch')?.value || '').toLowerCase();
    const rows = _rtpRouteRows.filter(r => [
        r.name, r.status, rtpRouteValue(r, 'vehicle'), rtpRouteValue(r, 'driver'), (r.stops || []).length,
    ].join(' ').toLowerCase().includes(q));
    rows.sort((a, b) => rtpCompareValues(rtpRouteValue(a, _rtpRouteSort.col), rtpRouteValue(b, _rtpRouteSort.col), _rtpRouteSort.dir));
    const count = document.getElementById('routesCount');
    if (count) count.textContent = `${rows.length} route${rows.length !== 1 ? 's' : ''}`;
    rtpUpdateSortHeaders('section-routes', _rtpRouteSort);
    body.innerHTML = rows.length ? rows.map(r => `
        <tr>
            <td>${rtpEsc(r.name)}</td>
            <td><span class="proto-badge">${rtpEsc(r.status)}</span></td>
            <td>${rtpEsc(rtpRouteValue(r, 'vehicle') || '-')}</td>
            <td>${rtpEsc(rtpRouteValue(r, 'driver') || '-')}</td>
            <td>${(r.stops || []).length}</td>
            <td>${(r.distance_km || 0).toFixed(1)} km</td>
            <td>${(r.duration_minutes || 0).toFixed(0)} min</td>
            <td style="text-align:center;"><div class="table-actions">${rtpRouteActions(r)}</div></td>
        </tr>
    `).join('') : '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-muted);">No planned routes match.</td></tr>';
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
        await rtpJson(`${API_BASE}/planned-routes/${id}`, { method: 'PUT', body: JSON.stringify({ status }) });
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
            return `
                <tr>
                    <td>${rtpEsc(p.name)}</td>
                    <td>${rtpMoney(p.base_price_cents, p.currency)}</td>
                    <td>${p.included_devices} devices<br>${p.included_positions} positions<br>${p.included_api_calls} API calls</td>
                    <td>${rtpMoney(p.price_per_device_cents, p.currency)} / device<br>${rtpMoney(p.price_per_1000_positions_cents, p.currency)} / 1000 positions<br>${rtpMoney(p.price_per_1000_api_calls_cents, p.currency)} / 1000 API calls</td>
                    <td>${assigned.length ? assigned.map(c => rtpEsc(c.name)).join('<br>') : '<span class="stack-item-meta">Unassigned</span>'}</td>
                    <td style="text-align:center;">
                        <div class="table-actions">
                            <button class="btn btn-secondary" onclick="rtpOpenPlanDetailsModal(${p.id})"><i class="mdi mdi-eye"></i> Details</button>
                            <button class="btn btn-secondary" onclick="rtpEditPlan(${p.id})"><i class="mdi mdi-pencil"></i> Edit</button>
                            <button class="icon-btn-danger" onclick="rtpDeletePlan(${p.id})" title="Delete"><i class="mdi mdi-delete"></i></button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('') : '<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-muted);">No billing plans match.</td></tr>';
    }
}

function rtpSortBilling(col) {
    _rtpBillingSort = { col, dir: _rtpBillingSort.col === col && _rtpBillingSort.dir === 'asc' ? 'desc' : 'asc' };
    rtpRenderBillingTable();
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
    document.getElementById('billingPlanDetailsTitle').textContent = `${plan.name} Details`;
    const assigned = rtpCompaniesForPlan(id);
    const now = new Date();
    document.getElementById('billDetailYear').value = now.getFullYear();
    document.getElementById('billDetailMonth').value = now.getMonth() + 1;
    document.getElementById('billDetailCompany').innerHTML = assigned.length
        ? assigned.map(c => `<option value="${c.id}">${rtpEsc(c.name)}</option>`).join('')
        : '<option value="">No assigned companies</option>';
    document.getElementById('billingPlanDetailsResult').innerHTML = '';
    document.getElementById('billingPlanDetailsModal').classList.add('active');
}

function rtpClosePlanDetailsModal() {
    const modal = document.getElementById('billingPlanDetailsModal');
    if (modal) modal.classList.remove('active');
}

async function rtpDetailGenerateBillingSummary() {
    const companyId = document.getElementById('billDetailCompany').value;
    const year = document.getElementById('billDetailYear').value;
    const month = document.getElementById('billDetailMonth').value;
    const plan = _rtpPlans.find(p => Number(p.id) === Number(_rtpDetailPlanId));
    const company = rtpBillingCompanies().find(c => Number(c.id) === Number(companyId));
    if (!companyId) return showAlert('Select a company first', 'error');
    try {
        const usageData = await rtpJson(`${API_BASE}/billing/companies/${companyId}/usage?year=${year}&month=${month}`);
        const inv = await rtpJson(`${API_BASE}/billing/companies/${companyId}/invoices?year=${year}&month=${month}`, { method: 'POST' });
        const u = usageData.usage || inv.usage || {};
        const overageDevices = Math.max(0, (u.active_devices || 0) - (plan?.included_devices || 0));
        const overagePositions = Math.max(0, (u.positions || 0) - (plan?.included_positions || 0));
        const overageApi = Math.max(0, (u.api_calls || 0) - (plan?.included_api_calls || 0));
        const period = new Date(Number(year), Number(month) - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
        const lineAmount = label => (inv.line_items || []).find(x => x.label === label)?.amount_cents || 0;
        const rows = [
            {
                metric: 'Base subscription',
                used: 1,
                included: '-',
                overage: '-',
                rate: rtpInvoiceMoney(plan?.base_price_cents || 0, inv),
                amount: plan?.base_price_cents || 0,
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
        document.getElementById('billingPlanDetailsResult').innerHTML = `
            <div class="stack-item">
                <div class="stack-item-title">${rtpEsc(company?.name || 'Company')} - ${rtpEsc(period)}</div>
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
                <div style="display:flex;justify-content:flex-end;margin-top:0.85rem;font-weight:800;font-size:1rem;">
                    Draft Total: ${rtpInvoiceMoney(inv.amount_cents, inv)}
                </div>
            </div>
        `;
    } catch (e) { showAlert(e.message, 'error'); }
}

async function rtpPrintBillingDetails() {
    const companyId = document.getElementById('billDetailCompany').value;
    const year = document.getElementById('billDetailYear').value;
    const month = document.getElementById('billDetailMonth').value;
    const plan = _rtpPlans.find(p => Number(p.id) === Number(_rtpDetailPlanId));
    const company = rtpBillingCompanies().find(c => Number(c.id) === Number(companyId));
    if (!companyId || !plan || !company) return showAlert('Select a company first', 'error');
    try {
        const usageData = await rtpJson(`${API_BASE}/billing/companies/${companyId}/usage?year=${year}&month=${month}`);
        const invoice = await rtpJson(`${API_BASE}/billing/companies/${companyId}/invoices?year=${year}&month=${month}`, { method: 'POST' });
        const usage = usageData.usage || invoice.usage || {};
        const period = new Date(Number(year), Number(month) - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
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
    body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-muted);">Loading audit logs...</td></tr>';
    try {
        _rtpAuditRows = await rtpJson(`${API_BASE}/audit-logs?limit=500`);
        rtpRenderAuditTable();
    } catch (e) {
        body.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-muted);">${rtpEsc(e.message)}</td></tr>`;
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
    `).join('') : '<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-muted);">No audit events match.</td></tr>';
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
    body.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:2rem;color:var(--text-muted);">Loading health checks...</td></tr>';
    try {
        const res = await fetch('/health/ready');
        const data = await res.json();
        _rtpHealthRows = Object.entries(data.checks || {}).map(([name, check]) => ({ name, ...check }));
        rtpRenderHealthTable();
    } catch (e) {
        body.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:2rem;color:var(--text-muted);">${rtpEsc(e.message)}</td></tr>`;
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
            <td><span class="proto-badge">${row.ok ? 'ok' : row.optional ? 'optional' : 'fail'}</span></td>
            <td>${row.latency_ms ? `${row.latency_ms} ms` : '-'}</td>
            <td>${rtpEsc(row.error || (row.degraded ? 'degraded' : ''))}</td>
        </tr>
    `).join('') : '<tr><td colspan="4" style="text-align:center;padding:2rem;color:var(--text-muted);">No health checks match.</td></tr>';
}

function rtpHealthValue(row, col) {
    const status = row.ok ? 'ok' : row.optional ? 'optional' : 'fail';
    const values = {
        name: row.name,
        status,
        latency: Number(row.latency_ms) || 0,
        details: row.error || (row.degraded ? 'degraded' : ''),
    };
    return values[col];
}

function rtpSortHealth(col) {
    _rtpHealthSort = { col, dir: _rtpHealthSort.col === col && _rtpHealthSort.dir === 'asc' ? 'desc' : 'asc' };
    rtpRenderHealthTable();
}
