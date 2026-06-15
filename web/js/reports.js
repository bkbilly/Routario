'use strict';

let _reportData          = [];
let _reportPayload       = null;
let _sortCol             = null;
let _sortDir             = 1;
let _allDevices          = [];
let _selectedIds         = new Set(); // empty = all
let _sensorsHistoryMode  = false;
let _tripRows            = []; // sorted trip rows, for map button index lookup

let _allUsers            = [];
let _selectedUserIds     = new Set(); // empty = all visible users
let _allDrivers          = [];
let _selectedDriverIds   = new Set(); // empty = all visible drivers
let _reportDefs          = [];
let _reportDefMap        = {};

const _IS_ADMIN         = localStorage.getItem('is_admin') === 'true';
const _IS_COMPANY_ADMIN = localStorage.getItem('is_company_admin') === 'true';
const _CAN_SEE_USERS    = _IS_ADMIN || _IS_COMPANY_ADMIN;

document.addEventListener('DOMContentLoaded', async () => {
    checkLogin();
    await permissionsReady;
    if (!hasPermission('view_reports')) { window.location.href = 'gps-dashboard.html'; return; }

    const now   = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    document.getElementById('endDate').value   = _fmtDate(now);
    document.getElementById('startDate').value = _fmtDate(start);

    await _loadDevices();
    if (_CAN_SEE_USERS) await _loadUsers();
    await _loadDrivers();
    await _loadReportTypes();
    _updateDescription();
    _injectNavScheduleAction();

    document.addEventListener('click', e => {
        const wrap = document.getElementById('vehSelectWrap');
        if (wrap && !wrap.contains(e.target)) wrap.classList.remove('open');
        const uwrap = document.getElementById('userSelectWrap');
        if (uwrap && !uwrap.contains(e.target)) uwrap.classList.remove('open');
        const dwrap = document.getElementById('driverSelectWrap');
        if (dwrap && !dwrap.contains(e.target)) dwrap.classList.remove('open');
    });

    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        if (document.getElementById('schedModal')?.classList.contains('active')) {
            closeScheduleModal();
            return;
        }
        if (document.getElementById('tripMapModal')?.classList.contains('active')) {
            closeTripMap();
        }
    });
});

async function _loadDevices() {
    try {
        const res = await apiFetch(`${API_BASE}/devices`);
        if (!res.ok) return;
        _allDevices = await res.json();
        const list = document.getElementById('vehOptsList');
        list.innerHTML = '';
        _allDevices.forEach(d => {
            const label = document.createElement('label');
            label.className = 'veh-opt';
            label.innerHTML = `
                <input type="checkbox" data-id="${d.id}" onchange="onVehCheck(this)">
                <span>${_esc(d.name)}${d.license_plate ? ` <span style="color:var(--text-muted);font-size:0.8rem;">(${_esc(d.license_plate)})</span>` : ''}</span>`;
            list.appendChild(label);
        });
    } catch (e) { console.error(e); }
}

async function _loadUsers() {
    try {
        const res = await apiFetch(`${API_BASE}/users`);
        if (!res.ok) return;
        _allUsers = await res.json();
        const list = document.getElementById('userOptsList');
        list.innerHTML = '';
        _allUsers.forEach(u => {
            const label = document.createElement('label');
            label.className = 'veh-opt';
            label.innerHTML = `<input type="checkbox" data-id="${u.id}" onchange="onUserCheck(this)">
                <span>${_esc(u.username)}${u.email ? ` <span style="color:var(--text-muted);font-size:0.8rem;">(${_esc(u.email)})</span>` : ''}</span>`;
            list.appendChild(label);
        });
    } catch (e) { console.error(e); }
}

async function _loadDrivers() {
    try {
        const res = await apiFetch(`${API_BASE}/drivers`);
        if (!res.ok) return;
        _allDrivers = await res.json();
        _renderDriverOptions();
    } catch (e) { console.error(e); }
}

async function _loadReportTypes() {
    try {
        const res = await apiFetch(`${API_BASE}/reports/types`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        _reportDefs = await res.json();
    } catch (e) {
        console.error(e);
        _reportDefs = [];
        showAlert('Failed to load report types.', 'error');
    }
    _reportDefMap = Object.fromEntries(_reportDefs.map(d => [d.key, d]));
    _populateReportSelect('reportType', _reportDefs);
    _populateReportSelect('sfType', _reportDefs.filter(d => d.schedule_supported !== false));
    _syncReportFilters();
}

function _populateReportSelect(id, defs) {
    const select = document.getElementById(id);
    if (!select) return;
    const current = select.value;
    select.innerHTML = defs.length
        ? defs.map(d => `<option value="${_esc(d.key)}">${_esc(d.label)}</option>`).join('')
        : '<option value="">No reports available</option>';
    if (defs.some(d => d.key === current)) select.value = current;
}

function _renderDriverOptions() {
    const list = document.getElementById('driverOptsList');
    if (!list) return;
    list.innerHTML = '';
    _allDrivers.forEach(d => {
        const label = document.createElement('label');
        label.className = 'veh-opt';
        label.innerHTML = `<input type="checkbox" data-id="${d.id}" onchange="onDriverCheck(this)" ${_selectedDriverIds.has(d.id) ? 'checked' : ''}>
            <span>${_esc(d.name)}</span>`;
        list.appendChild(label);
    });
    _syncAllDriverCheck();
    _updateDriverLabel();
}

function _mergeDriversFromTrips(rows) {
    const existing = new Map(_allDrivers.map(d => [d.id, d]));
    rows.forEach(r => {
        if (!r.driver_id || existing.has(r.driver_id)) return;
        existing.set(r.driver_id, { id: r.driver_id, name: r.driver_name || `Driver ${r.driver_id}` });
    });
    _allDrivers = [...existing.values()].sort((a, b) => a.name.localeCompare(b.name));
    _renderDriverOptions();
}

function toggleDriverDropdown(e) {
    e.stopPropagation();
    document.getElementById('driverSelectWrap').classList.toggle('open');
}

function onDriverCheck(cb) {
    const id = parseInt(cb.dataset.id);
    if (cb.checked) _selectedDriverIds.add(id);
    else _selectedDriverIds.delete(id);
    _syncAllDriverCheck();
    _updateDriverLabel();
    if (_isDailyDriverMode() && _reportData.length) _renderReport();
}

function toggleAllDrivers(cb) {
    _selectedDriverIds.clear();
    document.querySelectorAll('#driverOptsList input[type=checkbox]').forEach(el => { el.checked = false; });
    cb.checked = true;
    _updateDriverLabel();
    if (_isDailyDriverMode() && _reportData.length) _renderReport();
}

function _syncAllDriverCheck() {
    const checked = document.querySelectorAll('#driverOptsList input[type=checkbox]:checked');
    const allChk = document.getElementById('allDriverCheck');
    if (allChk) allChk.checked = checked.length === 0;
}

function _updateDriverLabel() {
    const label = document.getElementById('driverSelectLabel');
    if (!label) return;
    if (_selectedDriverIds.size === 0) {
        label.textContent = 'All drivers';
    } else if (_selectedDriverIds.size === 1) {
        const d = _allDrivers.find(d => _selectedDriverIds.has(d.id));
        label.textContent = d ? d.name : '1 driver';
    } else {
        label.textContent = `${_selectedDriverIds.size} drivers`;
    }
}

function toggleUserDropdown(e) {
    e.stopPropagation();
    document.getElementById('userSelectWrap').classList.toggle('open');
}

function onUserCheck(cb) {
    const id = parseInt(cb.dataset.id);
    if (cb.checked) _selectedUserIds.add(id);
    else _selectedUserIds.delete(id);
    _syncAllUserCheck();
    _updateUserLabel();
}

function toggleAllUsers(cb) {
    _selectedUserIds.clear();
    document.querySelectorAll('#userOptsList input[type=checkbox]').forEach(el => { el.checked = false; });
    cb.checked = true;
    _updateUserLabel();
}

function _syncAllUserCheck() {
    const checked = document.querySelectorAll('#userOptsList input[type=checkbox]:checked');
    document.getElementById('allUserCheck').checked = checked.length === 0;
}

function _updateUserLabel() {
    const label = document.getElementById('userSelectLabel');
    if (_selectedUserIds.size === 0) {
        label.textContent = 'All users';
    } else if (_selectedUserIds.size === 1) {
        const u = _allUsers.find(u => _selectedUserIds.has(u.id));
        label.textContent = u ? u.username : '1 user';
    } else {
        label.textContent = `${_selectedUserIds.size} users`;
    }
}

function toggleVehDropdown(e) {
    e.stopPropagation();
    document.getElementById('vehSelectWrap').classList.toggle('open');
}

function onVehCheck(cb) {
    const id = parseInt(cb.dataset.id);
    if (cb.checked) _selectedIds.add(id);
    else _selectedIds.delete(id);
    _syncAllCheck();
    _updateVehLabel();
}

function toggleAllVehicles(cb) {
    _selectedIds.clear();
    // When "All vehicles" is toggled, uncheck all individual vehicles
    document.querySelectorAll('#vehOptsList input[type=checkbox]').forEach(el => { el.checked = false; });
    // "All vehicles" checkbox always stays checked (it means "no filter = all")
    cb.checked = true;
    _updateVehLabel();
}

function _syncAllCheck() {
    const checked = document.querySelectorAll('#vehOptsList input[type=checkbox]:checked');
    const allChk  = document.getElementById('allVehCheck');
    allChk.checked = checked.length === 0;
}

function _updateVehLabel() {
    const label = document.getElementById('vehSelectLabel');
    if (_selectedIds.size === 0) {
        label.textContent = 'All vehicles';
    } else if (_selectedIds.size === 1) {
        const d = _allDevices.find(d => _selectedIds.has(d.id));
        label.textContent = d ? d.name : '1 vehicle';
    } else {
        label.textContent = `${_selectedIds.size} vehicles`;
    }
}

function _isDailyDriverMode() {
    return _getReportControlValue('group_by') === 'drivers';
}

function _syncReportFilters() {
    const type = document.getElementById('reportType').value;
    const def = _reportDefMap[type] || {};
    _renderReportControls(def.controls || []);
    const dailyDrivers = _isDailyDriverMode();

    document.getElementById('historyCheckGroup').style.display = def.supports_historical_toggle ? '' : 'none';
    document.getElementById('vehicleSelectGroup').style.display = (def.supports_vehicle_filter === false || dailyDrivers) ? 'none' : '';
    document.getElementById('dateFromGroup').style.display = def.needs_date_range === false && !document.getElementById('historyCheck').checked ? 'none' : '';
    document.getElementById('dateToGroup').style.display  = def.needs_date_range === false && !document.getElementById('historyCheck').checked ? 'none' : '';
    document.getElementById('userSelectGroup').style.display = (def.supports_user_filter && _CAN_SEE_USERS) ? '' : 'none';
    document.getElementById('driverSelectGroup').style.display = (def.supports_driver_filter && dailyDrivers) ? '' : 'none';
}

function _renderReportControls(controls) {
    const wrap = document.getElementById('reportControlsGroup');
    if (!wrap) return;
    const current = _getReportControlValues();
    wrap.innerHTML = (controls || []).map(c => {
        if (c.type !== 'select') return '';
        const value = current[c.key] ?? c.default;
        const options = (c.options || []).map(o => `<option value="${_esc(o.value)}" ${o.value === value ? 'selected' : ''}>${_esc(o.label)}</option>`).join('');
        return `<div class="form-group">
            <label class="form-label">${_esc(c.label)}</label>
            <select class="form-input report-control" data-key="${_esc(c.key)}" onchange="onReportControlChange()">${options}</select>
        </div>`;
    }).join('');
}

function _getReportControlValue(key) {
    return [...document.querySelectorAll('.report-control')].find(el => el.dataset.key === key)?.value || '';
}

function _getReportControlValues() {
    const values = {};
    document.querySelectorAll('.report-control').forEach(el => { values[el.dataset.key] = el.value; });
    return values;
}

function onReportTypeChange() {
    _reportData = [];
    _reportPayload = null;
    _sensorsHistoryMode = false;
    document.getElementById('reportTable').style.display = 'none';
    document.getElementById('noData').style.display = 'none';
    document.getElementById('summaryBar').style.display = 'none';
    document.getElementById('exportCsvBtn').style.display = 'none';
    document.getElementById('historyCheck').checked = false;
    _syncReportFilters();
    _updateDescription();
}

function _updateDescription() {
    const type = document.getElementById('reportType').value;
    document.getElementById('reportDescription').textContent = _reportDefMap[type]?.description || '';
}

function onHistoryCheckChange() {
    const checked = document.getElementById('historyCheck').checked;
    document.getElementById('dateFromGroup').style.display = checked ? '' : 'none';
    document.getElementById('dateToGroup').style.display   = checked ? '' : 'none';
}

function onReportControlChange() {
    _reportData = [];
    _reportPayload = null;
    document.getElementById('reportTable').style.display = 'none';
    document.getElementById('noData').style.display = 'none';
    document.getElementById('summaryBar').style.display = 'none';
    document.getElementById('exportCsvBtn').style.display = 'none';
    _syncReportFilters();
}

async function generateReport() {
    const type = document.getElementById('reportType').value;
    const def = _reportDefMap[type];
    if (!type || !def) { showAlert('Please select a report type.', 'warning'); return; }

    const historical = !!(def.supports_historical_toggle && document.getElementById('historyCheck').checked);
    const needsRange = def.needs_date_range !== false || historical;
    const start = document.getElementById('startDate').value;
    const end   = document.getElementById('endDate').value;
    if (needsRange && (!start || !end)) { showAlert('Please select a date range.', 'warning'); return; }

    const params = new URLSearchParams();
    if (needsRange) {
        params.set('start_date', `${start}T00:00:00`);
        params.set('end_date', `${end}T23:59:59`);
    }
    if (def.supports_vehicle_filter !== false && _selectedIds.size && !_isDailyDriverMode()) {
        params.set('device_ids', [..._selectedIds].join(','));
    }
    if (def.supports_user_filter && _selectedUserIds.size) {
        params.set('user_ids', [..._selectedUserIds].join(','));
    }
    if (def.supports_driver_filter && _selectedDriverIds.size) {
        params.set('driver_ids', [..._selectedDriverIds].join(','));
    }
    Object.entries(_getReportControlValues()).forEach(([key, value]) => {
        if (value !== '') params.set(key, value);
    });
    if (def.supports_historical_toggle) {
        params.set('historical', historical ? 'true' : 'false');
    }

    const endpoint = `${API_BASE}/reports/${encodeURIComponent(type)}${params.toString() ? `?${params}` : ''}`;

    try {
        const res = await apiFetch(endpoint);
        if (!res.ok) { showAlert('Failed to load report.', 'error'); return; }
        const data = await res.json();
        _reportPayload = Array.isArray(data) ? { rows: data, columns: [] } : data;
        _reportData = _reportPayload.rows || [];
        if (def.supports_driver_filter) _mergeDriversFromTrips(_reportData);
        _sortCol = null;
        _renderReport();
    } catch (e) { console.error(e); showAlert('Error generating report.', 'error'); }
}

function _renderReport() {
    const table   = document.getElementById('reportTable');
    const noData  = document.getElementById('noData');
    const sumBar  = document.getElementById('summaryBar');
    const expBtn  = document.getElementById('exportCsvBtn');
    const payload = _reportPayload || { rows: _reportData, columns: [] };
    const columns = (payload.columns || []).filter(c => c.hidden !== true);

    if (_reportData.length === 0) {
        table.style.display = 'none';
        noData.style.display = '';
        sumBar.style.display = 'none';
        expBtn.style.display = 'none';
        return;
    }

    const sort = _sortCol ? { key: _sortCol, dir: _sortDir } : (payload.default_sort || {});
    const rows = _sortedRowsBy(_reportData, sort.key || columns[0]?.key, sort.dir || 1);
    _tripRows = rows;

    _renderSummaryCards(payload.summary || []);
    document.getElementById('reportHead').innerHTML = `<tr>${columns.map(c => _th(c.key, c.label)).join('')}</tr>`;
    document.getElementById('reportBody').innerHTML = rows.map((row, idx) => _renderGenericRow(row, columns, payload.row_action, idx)).join('')
        + (payload.total_row ? _renderTotalRow(payload.total_row, columns) : '');

    table.style.display = '';
    noData.style.display = 'none';
    expBtn.style.display = '';
}
function sortReport(col) {
    if (_sortCol === col) _sortDir *= -1;
    else { _sortCol = col; _sortDir = 1; }
    _renderReport();
}

function _th(col, label) {
    const active = _sortCol === col;
    const arrow  = active ? (_sortDir === 1 ? ' ▲' : ' ▼') : '';
    return `<th onclick="sortReport('${col}')">${label}<span class="sort-arrow">${arrow}</span></th>`;
}

function _sortedRowsBy(data, col, dir = 1) {
    if (!col) return [...data];
    return [...data].sort((a, b) => {
        const av = a[col] ?? '', bv = b[col] ?? '';
        return typeof av === 'number' ? (av - bv) * dir : String(av).localeCompare(String(bv)) * dir;
    });
}

function _renderSummaryCards(cards) {
    const sumBar = document.getElementById('summaryBar');
    if (!cards.length) {
        sumBar.style.display = 'none';
        return;
    }
    const toneColor = { warning: 'var(--accent-warning,#eab308)', danger: 'var(--accent-danger)', success: 'var(--accent-success)' };
    sumBar.innerHTML = cards.map(card => `<div class="summary-card"><div class="val" style="${card.tone ? `color:${toneColor[card.tone] || card.tone};` : ''}">${_esc(card.value)}</div><div class="lbl">${_esc(card.label)}</div></div>`).join('');
    sumBar.style.display = '';
}

function _renderGenericRow(row, columns, action, idx) {
    const attrs = action?.type === 'trip_map' ? ` style="cursor:pointer;" onclick="showTripMap(${idx})"` : '';
    return `<tr${attrs}>${columns.map(col => _renderCell(row, col)).join('')}</tr>`;
}

function _renderTotalRow(row, columns) {
    return `<tr class="total-row">${columns.map((col, idx) => `<td>${idx === 0 ? _esc(row[col.key] ?? 'Total') : _formatValue(row[col.key], col)}</td>`).join('')}</tr>`;
}

function _renderCell(row, col) {
    const title = col.title_key && row[col.title_key] ? ` title="${_esc(row[col.title_key])}"` : '';
    const style = [
        col.max_width ? `max-width:${col.max_width}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` : '',
        ['datetime', 'datetime_split'].includes(col.type) ? 'white-space:nowrap;' : '',
    ].join('');
    const detail = col.detail_key && row[col.detail_key] ? `<br><span style="color:var(--text-muted);font-size:0.75rem;">${_formatValue(row[col.detail_key], { type: col.detail_type || 'text' })}</span>` : '';
    return `<td${title} style="${style}">${_formatValue(row[col.key], col)}${detail}</td>`;
}

function _formatValue(value, col = {}) {
    if (value === null || value === undefined || value === '') {
        const empty = col.empty || '—';
        return col.empty_tone ? `<span style="color:var(--accent-${col.empty_tone},#eab308);">${_esc(empty)}</span>` : _esc(empty);
    }
    if (col.type === 'datetime') return _fmtDatetime(value);
    if (col.type === 'datetime_split') return _fmtDatetimeSplit(value);
    if (col.type === 'duration_minutes') return _fmtDuration(Number(value));
    if (col.type === 'number') return `${Number(value).toFixed(col.decimals ?? 1)}${col.suffix || ''}`;
    if (col.type === 'integer') return String(parseInt(value, 10));
    if (col.type === 'bool_on') return `<span style="color:${value ? 'var(--accent-success)' : 'var(--text-muted)'};">${value ? 'On' : 'Off'}</span>`;
    if (col.type === 'bool_active') return `<span style="color:${value ? 'var(--accent-success)' : 'var(--text-muted)'};font-weight:${value ? '600' : '400'};">${value ? 'Active' : 'Missing'}</span>`;
    if (col.type === 'read_status') return value ? '<span style="color:var(--text-muted);">Read</span>' : '<span style="color:var(--accent-primary);font-weight:600;">Unread</span>';
    if (col.type === 'severity') {
        const colors = { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#3b82f6', info: 'var(--text-muted)' };
        return `<span style="color:${colors[value] || 'var(--text-muted)'};font-weight:600;text-transform:capitalize;">${_esc(value)}</span>`;
    }
    if (Array.isArray(value)) return _esc(value.join(', '));
    const tone = col.tone_if_positive && Number(value) > 0 ? col.tone_if_positive : null;
    return tone ? `<span style="color:var(--accent-${tone});">${_esc(value)}</span>` : _esc(value);
}

function exportCsv() {
    if (!_reportPayload) return;
    const columns = (_reportPayload.columns || []).filter(c => c.csv !== false && c.hidden !== true);
    const headers = columns.map(c => c.label);
    const sort = _sortCol ? { key: _sortCol, dir: _sortDir } : (_reportPayload.default_sort || {});
    const rows = _sortedRowsBy(_reportData, sort.key || columns[0]?.key, sort.dir || 1);
    _downloadCsv(headers, rows, r => columns.map(c => _plainValue(r[c.key], c)), _reportPayload.csv_filename || 'report.csv');
}

function _plainValue(value, col = {}) {
    if (value === null || value === undefined) return '';
    if (col.type === 'datetime' || col.type === 'datetime_split') return _fmtDatetime(value);
    if (col.type === 'duration_minutes') return String(value);
    if (col.type === 'bool_on') return value ? 'On' : 'Off';
    if (col.type === 'bool_active') return value ? 'Active' : 'Missing';
    if (col.type === 'read_status') return value ? 'Read' : 'Unread';
    if (Array.isArray(value)) return value.join('; ');
    return String(value);
}

function _downloadCsv(headers, rows, rowFn, filename) {
    const lines = [headers.join(','), ...rows.map(r => rowFn(r).map(v => `"${String(v).replace(/"/g,'""')}"`).join(','))];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    _downloadBlob(blob, filename);
}

function _downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
}

// ── Trip Map Modal ────────────────────────────────────────────────

const _TRIP_TILES = {
    openstreetmap_dark: { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, filter: 'invert(100%) hue-rotate(180deg)' },
    openstreetmap:      { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19 },
    stadia_dark:        { url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png', maxZoom: 20 },
    google_streets:     { url: 'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', maxZoom: 21 },
    google_satellite:   { url: 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', maxZoom: 21 },
    google_hybrid:      { url: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', maxZoom: 21 },
};

let _tripMapInst   = null; // Leaflet map instance
let _tripMapLayers = [];   // layers added for the current trip

async function showTripMap(idx) {
    const r = _tripRows[idx];
    if (!r) return;

    const modal   = document.getElementById('tripMapModal');
    const spinner = document.getElementById('tripMapSpinner');
    const title   = document.getElementById('tripMapTitle');
    const meta    = document.getElementById('tripMapMeta');

    const device   = _allDevices.find(d => d.id === r.device_id);
    const emoji    = (VEHICLE_ICONS[device?.vehicle_type] || VEHICLE_ICONS['other']).emoji;
    const duration = r.duration_minutes ? _fmtDuration(r.duration_minutes) : null;
    title.textContent = `${emoji} ${r.device_name} — ${_fmtDatetime(r.start_time)}${duration ? `  ·  ${duration}` : ''}`;
    const parts = [r.start_address, r.end_address].filter(Boolean);
    meta.textContent = parts.join('  →  ');

    // Show modal with spinner overlay; map container stays visible so Leaflet can measure it
    spinner.style.display = 'flex';
    modal.classList.add('active');

    // Wait one frame so the browser has painted the modal before Leaflet reads dimensions
    await new Promise(r => requestAnimationFrame(r));

    // Init map once (container is now visible and properly sized)
    if (!_tripMapInst) {
        const tileKey   = localStorage.getItem('mapTileLayer') || 'openstreetmap_dark';
        const tile      = _TRIP_TILES[tileKey] || _TRIP_TILES['openstreetmap_dark'];
        _tripMapInst    = L.map('tripMapContainer', { zoomControl: true });
        const tileLayer = L.tileLayer(tile.url, { maxZoom: tile.maxZoom, attribution: '© OpenStreetMap contributors' });
        tileLayer.addTo(_tripMapInst);
        if (tile.filter) {
            const pane = _tripMapInst.getPanes().tilePane;
            if (pane) pane.style.filter = tile.filter;
        }
    }

    // Clear previous trip layers
    _tripMapLayers.forEach(l => _tripMapInst.removeLayer(l));
    _tripMapLayers = [];

    try {
        const res = await apiFetch(`${API_BASE}/positions/history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device_id:  r.device_id,
                start_time: r.start_time,
                end_time:   r.end_time || r.start_time,
                max_points: 5000,
            }),
        });
        if (!res.ok) throw new Error('Failed to load positions');
        const data     = await res.json();
        const features = data.features || [];

        spinner.style.display = 'none';
        _tripMapInst.invalidateSize();

        if (!features.length) {
            spinner.style.display = 'flex';
            spinner.innerHTML = '<span style="color:var(--text-muted);">No position data for this trip.</span>';
            return;
        }

        const coords = features.map(f => [f.geometry.coordinates[1], f.geometry.coordinates[0]]);

        const line = L.polyline.antPath(coords, {
            color:      '#3b82f6',
            weight:     4,
            opacity:    0.85,
            delay:      2000,
            dashArray:  [5, 80],
            pulseColor: '#ffffff',
        });
        line.addTo(_tripMapInst);
        _tripMapLayers.push(line);

        const startDot = L.circleMarker(coords[0], { radius: 7, color: '#22c55e', fillColor: '#22c55e', fillOpacity: 1, weight: 2 })
            .bindTooltip('Start', { permanent: false });
        startDot.addTo(_tripMapInst);
        _tripMapLayers.push(startDot);

        const endDot = L.circleMarker(coords[coords.length - 1], { radius: 7, color: '#ef4444', fillColor: '#ef4444', fillOpacity: 1, weight: 2 })
            .bindTooltip('End', { permanent: false });
        endDot.addTo(_tripMapInst);
        _tripMapLayers.push(endDot);

        _tripMapInst.fitBounds(L.featureGroup(_tripMapLayers).getBounds(), { padding: [24, 24] });
    } catch (e) {
        spinner.innerHTML = '<span style="color:var(--text-muted);">Failed to load trip data.</span>';
        spinner.style.display = 'flex';
        console.error(e);
    }
}

function closeTripMap() {
    document.getElementById('tripMapModal').classList.remove('active');
}

// ── Helpers ───────────────────────────────────────────────────────

function _fmtDate(d) { return d.toISOString().split('T')[0]; }

function _fmtDatetime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString(undefined, { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
}

function _fmtDatetimeSplit(iso) {
    if (!iso) return '—';
    const d    = new Date(iso);
    const date = d.toLocaleDateString(undefined, { year:'numeric', month:'2-digit', day:'2-digit' });
    const time = d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
    return `<span style="display:block;">${date}</span><span style="display:block;color:var(--text-muted);">${time}</span>`;
}

function _fmtDuration(minutes) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function _esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ══════════════════════════════════════════════════════════════════════════════
// Tab management
// ══════════════════════════════════════════════════════════════════════════════

let _activeTab = 'reports';

function switchTab(tab) {
    _activeTab = tab;
    document.getElementById('tabReports').classList.toggle('active',   tab === 'reports');
    document.getElementById('tabSchedules').classList.toggle('active', tab === 'schedules');
    document.getElementById('panelReports').style.display   = tab === 'reports'   ? '' : 'none';
    document.getElementById('panelSchedules').style.display = tab === 'schedules' ? '' : 'none';
    if (tab === 'schedules') _loadSchedules();
}

// ══════════════════════════════════════════════════════════════════════════════
// Run viewer
// ══════════════════════════════════════════════════════════════════════════════

let _viewingRunData = null;

async function viewRun(schedId, runId, scheduleName, reportType, runAt) {
    try {
        const res = await apiFetch(`${API_BASE}/report-schedules/${schedId}/runs/${runId}`);
        if (!res.ok) { showAlert('Failed to load run data.', 'error'); return; }
        const run = await res.json();
        if (!run.data) { showAlert('No data stored for this run.', 'warning'); return; }

        _viewingRunData = { schedId, runId, scheduleName, reportType, runAt, data: run.data };

        // Show view banner, hide live controls
        document.getElementById('runViewBanner').style.display = 'flex';
        document.getElementById('liveControls').style.display  = 'none';
        document.getElementById('exportCsvBtn').style.display  = 'none';
        document.getElementById('runViewLabel').textContent =
            `Viewing: ${_esc(scheduleName)}  ·  ${_fmtDatetime(runAt)}`;

        switchTab('reports');
        _renderRunData(reportType, run.data);
    } catch (e) { console.error(e); showAlert('Error loading run.', 'error'); }
}

function exitRunView() {
    _viewingRunData = null;
    document.getElementById('runViewBanner').style.display = 'none';
    document.getElementById('liveControls').style.display  = '';
    document.getElementById('reportTable').style.display   = 'none';
    document.getElementById('summaryBar').style.display    = 'none';
    document.getElementById('noData').style.display        = 'none';
    document.getElementById('exportCsvBtn').style.display  = 'none';
    _reportData = [];
    switchTab('schedules');
}

function _renderRunData(reportType, data) {
    _reportPayload = data || { rows: [], columns: [] };
    _reportData = data.rows || [];
    _sortCol    = null;
    _sortDir    = 1;
    _renderReport();
}

function exportCsvFromRun() {
    if (!_viewingRunData) return;
    exportCsv();
}

// ══════════════════════════════════════════════════════════════════════════════
// Schedules list
// ══════════════════════════════════════════════════════════════════════════════

const _RANGE_LABELS = { last_7_days: 'Last 7 days', last_14_days: 'Last 14 days', last_30_days: 'Last 30 days', last_calendar_month: 'Last calendar month', last_quarter: 'Last quarter', last_year: 'Last year' };
const _DOW          = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function _reportLabel(type) {
    return _reportDefMap[type]?.label || type;
}

function _freqLabel(s) {
    if (s.frequency === 'daily')   return `Daily at ${s.run_time}`;
    if (s.frequency === 'weekly')  return `Weekly (${_DOW[s.day_of_week]}) at ${s.run_time}`;
    if (s.frequency === 'monthly') return `Monthly (day ${s.day_of_month}) at ${s.run_time}`;
    return s.frequency;
}

let _schedules          = [];
let _expandedScheduleId = null;
let _schedSortCol       = 'name';
let _schedSortDir       = 1;

async function _loadSchedules() {
    try {
        const res = await apiFetch(`${API_BASE}/report-schedules`);
        if (!res.ok) return;
        _schedules = await res.json();
        _renderScheduleList();
    } catch (e) { console.error(e); }
}

function filterSchedules() {
    const q = (document.getElementById('schedSearch')?.value || '').toLowerCase().trim();
    const filtered = q
        ? _schedules.filter(s =>
            s.name.toLowerCase().includes(q) ||
            _reportLabel(s.report_type).toLowerCase().includes(q) ||
            _freqLabel(s).toLowerCase().includes(q)
          )
        : _schedules;
    _renderScheduleList(filtered);
}

function _schedTh(col, label) {
    const active = _schedSortCol === col;
    const arrow  = active ? (_schedSortDir === 1 ? ' ▲' : ' ▼') : '';
    return `<th onclick="sortSchedules('${col}')" style="cursor:pointer;user-select:none;">${label}<span class="sort-arrow">${arrow}</span></th>`;
}

function sortSchedules(col) {
    if (_schedSortCol === col) _schedSortDir *= -1;
    else { _schedSortCol = col; _schedSortDir = 1; }
    filterSchedules();
}

function _renderScheduleList(list = _schedules) {
    const head   = document.getElementById('schedHead');
    const tbody  = document.getElementById('schedBody');
    const noData = document.getElementById('schedNoData');
    const count  = document.getElementById('schedCount');
    if (count) count.textContent = `${list.length} schedule${list.length !== 1 ? 's' : ''}`;

    // Sort
    const col = _schedSortCol;
    const dir = _schedSortDir;
    const sorted = [...list].sort((a, b) => {
        let av, bv;
        if      (col === 'name')      { av = a.name;                              bv = b.name; }
        else if (col === 'type')      { av = _reportLabel(a.report_type);         bv = _reportLabel(b.report_type); }
        else if (col === 'frequency') { av = _freqLabel(a);                       bv = _freqLabel(b); }
        else if (col === 'next_run')  { av = a.next_run || '';                    bv = b.next_run || ''; }
        else if (col === 'runs')      { av = a.run_count;                         bv = b.run_count; }
        else if (col === 'status')    { av = a.is_active ? 1 : 0;                 bv = b.is_active ? 1 : 0; }
        else                          { av = ''; bv = ''; }
        return typeof av === 'number' ? (av - bv) * dir : String(av).localeCompare(String(bv)) * dir;
    });

    head.innerHTML = `<tr>
        ${_schedTh('name',      'Name')}
        ${_schedTh('type',      'Type')}
        ${_schedTh('frequency', 'Frequency')}
        ${_schedTh('next_run',  'Next Run')}
        ${_schedTh('runs',      'Runs')}
        ${_schedTh('status',    'Status')}
        <th>Actions</th>
    </tr>`;

    if (!sorted.length) {
        tbody.innerHTML = '';
        const q = (document.getElementById('schedSearch')?.value || '').trim();
        noData.textContent = q ? 'No schedules match your search.' : 'No schedules yet. Use the gear menu to create one.';
        noData.style.display = '';
        return;
    }
    noData.style.display = 'none';

    tbody.innerHTML = sorted.map(s => {
        const badge   = s.is_active
            ? '<span class="sched-badge sched-badge-active">Active</span>'
            : '<span class="sched-badge sched-badge-inactive">Paused</span>';
        const typeStr = _reportLabel(s.report_type);
        const next    = s.next_run ? _fmtDatetimeSplit(s.next_run) : '—';
        const runs    = `${s.run_count} / ${s.keep_runs}`;

        return `<tr onclick="toggleRunHistory(${s.id}, this)" id="sr-${s.id}" ${_expandedScheduleId === s.id ? 'class="expanded"' : ''}>
            <td><strong>${_esc(s.name)}</strong></td>
            <td>${_esc(typeStr)}</td>
            <td style="white-space:nowrap;font-size:0.82rem;">${_esc(_freqLabel(s))}</td>
            <td style="font-size:0.82rem;font-family:var(--font-mono);">${next}</td>
            <td style="font-family:var(--font-mono);font-size:0.82rem;">${runs}</td>
            <td>${badge}</td>
            <td onclick="event.stopPropagation();">
                <button class="btn btn-secondary" style="padding:0.3rem 0.65rem;font-size:0.78rem;" onclick="openScheduleModal(${s.id})">
                    <i class="mdi mdi-pencil"></i>
                </button>
            </td>
        </tr>
        <tr id="rh-${s.id}" class="run-history-row" style="display:${_expandedScheduleId === s.id ? '' : 'none'};">
            <td colspan="7"><div class="run-history-inner" id="rhi-${s.id}">
                <div style="text-align:center;color:var(--text-muted);padding:0.5rem;">Loading…</div>
            </div></td>
        </tr>`;
    }).join('');

    if (_expandedScheduleId) _fetchAndShowRuns(_expandedScheduleId);
}

async function toggleRunHistory(schedId, rowEl) {
    if (_expandedScheduleId === schedId) {
        _expandedScheduleId = null;
        document.getElementById(`rh-${schedId}`).style.display = 'none';
        rowEl.classList.remove('expanded');
        return;
    }
    _expandedScheduleId = schedId;
    document.querySelectorAll('.run-history-row').forEach(r => r.style.display = 'none');
    document.querySelectorAll('.sched-table tbody tr:not(.run-history-row)').forEach(r => r.classList.remove('expanded'));
    rowEl.classList.add('expanded');
    document.getElementById(`rh-${schedId}`).style.display = '';
    await _fetchAndShowRuns(schedId);
}

async function _fetchAndShowRuns(schedId) {
    const container = document.getElementById(`rhi-${schedId}`);
    if (!container) return;
    container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:0.5rem;">Loading…</div>';
    try {
        const res = await apiFetch(`${API_BASE}/report-schedules/${schedId}/runs`);
        if (!res.ok) { container.innerHTML = '<div style="color:var(--accent-danger);padding:0.5rem;">Failed to load runs.</div>'; return; }
        const runs = await res.json();
        const sched = _schedules.find(s => s.id === schedId);

        if (!runs.length) {
            container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:0.5rem;">No runs yet.</div>';
            return;
        }

        container.innerHTML = `
            <table class="run-table">
                <thead><tr><th>Date / Time</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                ${runs.map(r => {
                    const statusHtml = r.status === 'success'
                        ? '<span class="run-status-ok"><i class="mdi mdi-check-circle"></i> Success</span>'
                        : `<span class="run-status-err" title="${_esc(r.error_message || '')}"><i class="mdi mdi-alert-circle"></i> Failed</span>`;
                    const actions = r.has_data
                        ? `<button class="btn btn-secondary" style="padding:0.25rem 0.6rem;font-size:0.75rem;" onclick="viewRun(${schedId},${r.id},'${_esc(sched?.name || '')}','${sched?.report_type || ''}','${r.run_at}')">
                               <i class="mdi mdi-eye"></i> View
                           </button>`
                        : '—';
                    return `<tr>
                        <td style="white-space:nowrap;font-family:var(--font-mono);font-size:0.8rem;">${_fmtDatetime(r.run_at)}</td>
                        <td>${statusHtml}</td>
                        <td>${actions}</td>
                    </tr>`;
                }).join('')}
                </tbody>
            </table>`;
    } catch (e) { console.error(e); container.innerHTML = '<div style="color:var(--accent-danger);padding:0.5rem;">Error loading runs.</div>'; }
}

async function deleteSchedule(id, name) {
    if (!confirm(`Delete schedule "${name}"? This will also delete all stored runs.`)) return;
    try {
        const res = await apiFetch(`${API_BASE}/report-schedules/${id}`, { method: 'DELETE' });
        if (res.ok || res.status === 204) {
            _schedules = _schedules.filter(s => s.id !== id);
            if (_expandedScheduleId === id) _expandedScheduleId = null;
            filterSchedules();
        } else {
            showAlert('Failed to delete schedule.', 'error');
        }
    } catch (e) { console.error(e); }
}

async function deleteScheduleFromModal() {
    if (!_editingScheduleId) return;
    const schedule = _schedules.find(s => s.id === _editingScheduleId);
    const name = schedule?.name || 'this schedule';
    closeScheduleModal();
    await deleteSchedule(_editingScheduleId, name);
}

// ══════════════════════════════════════════════════════════════════════════════
// Schedule create / edit modal
// ══════════════════════════════════════════════════════════════════════════════

let _sfSelectedVehIds  = new Set();
let _sfSelectedUserIds = new Set();
let _editingScheduleId = null;

function _injectNavScheduleAction() {
    const el = document.getElementById('snAddAction');
    if (!el) return;
    el.innerHTML = `<button class="header-menu-item" onclick="openScheduleModal(null);document.getElementById('snDropdown').classList.remove('open');document.getElementById('snGearBtn').classList.remove('active');">
        <span class="header-menu-item-icon"><i class="mdi mdi-calendar-plus" style="font-size:15px;"></i></span>
        <span>New Schedule</span>
    </button>`;
}

async function openScheduleModal(scheduleIdOrObj) {
    let schedule = null;
    if (scheduleIdOrObj !== null && scheduleIdOrObj !== undefined) {
        if (typeof scheduleIdOrObj === 'object') {
            schedule = scheduleIdOrObj;
        } else {
            schedule = _schedules.find(s => s.id === scheduleIdOrObj) || null;
        }
    }

    _editingScheduleId = schedule ? schedule.id : null;
    document.getElementById('schedModalTitle').textContent = schedule ? 'Edit Schedule' : 'New Schedule';
    document.getElementById('sfDeleteBtn').style.display   = schedule ? '' : 'none';

    _sfSelectedVehIds.clear();
    _sfSelectedUserIds.clear();

    if (schedule) {
        document.getElementById('sfName').value        = schedule.name;
        document.getElementById('sfType').value        = schedule.report_type;
        document.getElementById('sfHistorical').checked = schedule.sensors_historical;
        document.getElementById('sfDateRange').value   = schedule.date_range || 'last_30_days';
        document.getElementById('sfFreq').value        = schedule.frequency;
        document.getElementById('sfTime').value        = schedule.run_time;
        document.getElementById('sfDow').value         = schedule.day_of_week ?? 0;
        document.getElementById('sfDom').value         = schedule.day_of_month ?? 1;
        document.getElementById('sfKeep').value        = schedule.keep_runs;
        document.getElementById('sfActive').checked    = schedule.is_active;
        (schedule.filter_device_ids || []).forEach(id => _sfSelectedVehIds.add(id));
        (schedule.filter_user_ids   || []).forEach(id => _sfSelectedUserIds.add(id));
    } else {
        document.getElementById('sfName').value        = '';
        document.getElementById('sfType').value        = _reportDefs.find(d => d.schedule_supported !== false)?.key || '';
        document.getElementById('sfHistorical').checked = false;
        document.getElementById('sfDateRange').value   = 'last_30_days';
        document.getElementById('sfFreq').value        = 'daily';
        document.getElementById('sfTime').value        = '07:00';
        document.getElementById('sfDow').value         = '0';
        document.getElementById('sfDom').value         = '1';
        document.getElementById('sfKeep').value        = '10';
        document.getElementById('sfActive').checked    = true;
    }

    _buildSfVehList();
    _buildSfUserList();
    onSchedTypeChange();
    onSchedFreqChange();

    document.getElementById('schedModal').classList.add('active');
}

function closeScheduleModal() {
    document.getElementById('schedModal').classList.remove('active');
}

function _buildSfVehList() {
    const list = document.getElementById('sfVehList');
    list.innerHTML = '';
    _allDevices.forEach(d => {
        const label = document.createElement('label');
        label.className = 'veh-opt';
        label.innerHTML = `<input type="checkbox" data-id="${d.id}" ${_sfSelectedVehIds.has(d.id) ? 'checked' : ''} onchange="onSfVehCheck(this)">
            <span>${_esc(d.name)}${d.license_plate ? ` <span style="color:var(--text-muted);font-size:0.8rem;">(${_esc(d.license_plate)})</span>` : ''}</span>`;
        list.appendChild(label);
    });
    document.getElementById('sfAllVeh').checked = _sfSelectedVehIds.size === 0;
    _updateSfVehLabel();
}

function _buildSfUserList() {
    const list = document.getElementById('sfUserList');
    list.innerHTML = '';
    _allUsers.forEach(u => {
        const label = document.createElement('label');
        label.className = 'veh-opt';
        label.innerHTML = `<input type="checkbox" data-id="${u.id}" ${_sfSelectedUserIds.has(u.id) ? 'checked' : ''} onchange="onSfUserCheck(this)">
            <span>${_esc(u.username)}${u.email ? ` <span style="color:var(--text-muted);font-size:0.8rem;">(${_esc(u.email)})</span>` : ''}</span>`;
        list.appendChild(label);
    });
    document.getElementById('sfAllUser').checked = _sfSelectedUserIds.size === 0;
    _updateSfUserLabel();
}

function onSchedTypeChange() {
    const t      = document.getElementById('sfType').value;
    const def    = _reportDefMap[t] || {};
    const isSens = def.supports_historical_toggle;

    document.getElementById('sfHistGroup').style.display  = isSens ? '' : 'none';
    document.getElementById('sfUserGroup').style.display  = (def.schedule_uses_user_filter && _CAN_SEE_USERS) ? '' : 'none';
    document.getElementById('sfVehWrap').closest('.form-group').style.display = def.schedule_uses_device_filter === false ? 'none' : '';

    // Date range: hidden for sensors when not in historical mode
    const needsRange = def.needs_date_range !== false || document.getElementById('sfHistorical').checked;
    document.getElementById('sfDateRangeGroup').style.display = needsRange ? '' : 'none';
}

function onSchedHistChange() {
    onSchedTypeChange();
}

function onSchedFreqChange() {
    const f = document.getElementById('sfFreq').value;
    document.getElementById('sfDowGroup').style.display = f === 'weekly'  ? '' : 'none';
    document.getElementById('sfDomGroup').style.display = f === 'monthly' ? '' : 'none';
}

function toggleSfVeh(e) { e.stopPropagation(); document.getElementById('sfVehWrap').classList.toggle('open'); }
function toggleSfUser(e) { e.stopPropagation(); document.getElementById('sfUserWrap').classList.toggle('open'); }

function onSfVehCheck(cb) {
    const id = parseInt(cb.dataset.id);
    if (cb.checked) _sfSelectedVehIds.add(id); else _sfSelectedVehIds.delete(id);
    document.getElementById('sfAllVeh').checked = _sfSelectedVehIds.size === 0;
    _updateSfVehLabel();
}

function onSfUserCheck(cb) {
    const id = parseInt(cb.dataset.id);
    if (cb.checked) _sfSelectedUserIds.add(id); else _sfSelectedUserIds.delete(id);
    document.getElementById('sfAllUser').checked = _sfSelectedUserIds.size === 0;
    _updateSfUserLabel();
}

function toggleSfAllVeh(cb) {
    _sfSelectedVehIds.clear();
    document.querySelectorAll('#sfVehList input[type=checkbox]').forEach(el => el.checked = false);
    cb.checked = true;
    _updateSfVehLabel();
}

function toggleSfAllUser(cb) {
    _sfSelectedUserIds.clear();
    document.querySelectorAll('#sfUserList input[type=checkbox]').forEach(el => el.checked = false);
    cb.checked = true;
    _updateSfUserLabel();
}

function _updateSfVehLabel() {
    const lbl = document.getElementById('sfVehLabel');
    if (_sfSelectedVehIds.size === 0) { lbl.textContent = 'All vehicles'; return; }
    if (_sfSelectedVehIds.size === 1) {
        const d = _allDevices.find(d => _sfSelectedVehIds.has(d.id));
        lbl.textContent = d ? d.name : '1 vehicle';
        return;
    }
    lbl.textContent = `${_sfSelectedVehIds.size} vehicles`;
}

function _updateSfUserLabel() {
    const lbl = document.getElementById('sfUserLabel');
    if (_sfSelectedUserIds.size === 0) { lbl.textContent = 'All users'; return; }
    if (_sfSelectedUserIds.size === 1) {
        const u = _allUsers.find(u => _sfSelectedUserIds.has(u.id));
        lbl.textContent = u ? u.username : '1 user';
        return;
    }
    lbl.textContent = `${_sfSelectedUserIds.size} users`;
}

async function saveSchedule() {
    const name = document.getElementById('sfName').value.trim();
    if (!name) { showAlert('Schedule name is required.', 'warning'); return; }

    const rtype      = document.getElementById('sfType').value;
    const historical = document.getElementById('sfHistorical').checked;
    const dateRange  = document.getElementById('sfDateRange').value;
    const freq       = document.getElementById('sfFreq').value;
    const runTime    = document.getElementById('sfTime').value;
    const keep       = parseInt(document.getElementById('sfKeep').value);

    if (!runTime) { showAlert('Run time is required.', 'warning'); return; }
    if (isNaN(keep) || keep < 1 || keep > 100) { showAlert('Keep Runs must be between 1 and 100.', 'warning'); return; }

    const def = _reportDefMap[rtype] || {};
    const needsRange = def.needs_date_range !== false || historical;
    if (needsRange && !dateRange) { showAlert('Date range is required.', 'warning'); return; }

    const body = {
        name,
        report_type:        rtype,
        filter_device_ids:  def.schedule_uses_device_filter === false ? [] : [..._sfSelectedVehIds],
        filter_user_ids:    [..._sfSelectedUserIds],
        sensors_historical: historical,
        date_range:         needsRange ? dateRange : null,
        frequency:          freq,
        run_time:           runTime,
        day_of_week:        freq === 'weekly'  ? parseInt(document.getElementById('sfDow').value) : null,
        day_of_month:       freq === 'monthly' ? parseInt(document.getElementById('sfDom').value) : null,
        timezone:           Intl.DateTimeFormat().resolvedOptions().timeZone,
        keep_runs:          keep,
        is_active:          document.getElementById('sfActive').checked,
    };

    try {
        const url    = _editingScheduleId
            ? `${API_BASE}/report-schedules/${_editingScheduleId}`
            : `${API_BASE}/report-schedules`;
        const method = _editingScheduleId ? 'PUT' : 'POST';
        const res    = await apiFetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            showAlert(err.detail || 'Failed to save schedule.', 'error');
            return;
        }
        closeScheduleModal();
        await _loadSchedules();
        if (_activeTab !== 'schedules') switchTab('schedules');
    } catch (e) { console.error(e); showAlert('Error saving schedule.', 'error'); }
}

// Close dropdowns in the schedule modal when clicking outside
document.addEventListener('click', e => {
    const vw = document.getElementById('sfVehWrap');
    if (vw && !vw.contains(e.target)) vw.classList.remove('open');
    const uw = document.getElementById('sfUserWrap');
    if (uw && !uw.contains(e.target)) uw.classList.remove('open');
});
