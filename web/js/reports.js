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
let _healthRows          = [];
let _healthSort          = { col: 'name', dir: 'asc' };
let _billingDetail       = null;
let _selectedBillingKey  = null;
let _sfControlValues     = {};
let _notificationChannels = [];
const _REPORT_TABS = [
    { name: 'reports', panelId: 'panelReports', tabId: 'tabReports' },
    { name: 'schedules', panelId: 'panelSchedules', tabId: 'tabSchedules' },
    { name: 'health', panelId: 'panelHealth', tabId: 'tabHealth' },
];

const _IS_ADMIN         = localStorage.getItem('is_admin') === 'true';
const _IS_COMPANY_ADMIN = localStorage.getItem('is_company_admin') === 'true';
const _CAN_SEE_USERS    = _IS_ADMIN || _IS_COMPANY_ADMIN;

document.addEventListener('DOMContentLoaded', async () => {
    checkLogin();
    await permissionsReady;
    if (!hasPermission('view_reports') && !hasPermission('view_health')) {
        window.location.href = 'gps-dashboard.html';
        return;
    }

    document.getElementById('tabReports').style.display = hasPermission('view_reports') ? '' : 'none';
    document.getElementById('tabSchedules').style.display = hasPermission('view_reports') ? '' : 'none';
    document.getElementById('tabHealth').style.display = hasPermission('view_health') ? '' : 'none';

    const now   = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    document.getElementById('endDate').value   = _fmtDate(now);
    document.getElementById('startDate').value = _fmtDate(start);

    if (hasPermission('view_reports')) {
        _notificationChannels = (await permissionsReady)?.notification_channels || [];
        await _loadDevices();
        if (_CAN_SEE_USERS) await _loadUsers();
        await _loadDrivers();
        await _loadReportTypes();
        _updateDescription();
    }
    _injectNavScheduleAction();
    const hash = RoutarioTabs.hashValue();
    switchTab(_validReportTab(hash) ? hash : hasPermission('view_reports') ? 'reports' : 'health', false);

    window.addEventListener('hashchange', () => {
        const next = RoutarioTabs.hashValue();
        switchTab(_validReportTab(next) ? next : 'reports', false);
    });

    document.addEventListener('click', e => {
        closeExportMenus();
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
            return;
        }
        if (document.getElementById('billingDetailModal')?.classList.contains('active')) {
            closeBillingDetail();
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
    wrap.innerHTML = _renderControlInputs(controls, current, 'report-control', 'onReportControlChange()');
}

function _renderControlInputs(controls, current, className, onchange) {
    return (controls || []).map(c => {
        if (c.visible_when && String(current[c.visible_when.key] ?? '') !== String(c.visible_when.value)) return '';
        const value = current[c.key] ?? c.default;
        let input = '';
        if (c.type === 'select') {
            const options = (c.options || []).map(o => {
                const selected = String(o.value) === String(value) ? 'selected' : '';
                return `<option value="${_esc(o.value)}" ${selected}>${_esc(o.label)}</option>`;
            }).join('');
            input = `<select class="form-input ${className}" data-key="${_esc(c.key)}" onchange="${onchange}">${options}</select>`;
        } else if (c.type === 'number') {
            input = `<input type="number" class="form-input ${className}" data-key="${_esc(c.key)}"
                value="${_esc(value)}" min="${_esc(c.min ?? '')}" max="${_esc(c.max ?? '')}" step="${_esc(c.step ?? 1)}"
                onchange="${onchange}" oninput="${onchange}">`;
        } else {
            return '';
        }
        return `<div class="form-group">
            <label class="form-label">${_esc(c.label)}</label>
            ${input}
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

function _getScheduleControlValues() {
    const values = {};
    document.querySelectorAll('.schedule-control').forEach(el => { values[el.dataset.key] = el.value; });
    return values;
}

function onReportTypeChange() {
    _reportData = [];
    _reportPayload = null;
    _selectedBillingKey = null;
    _billingDetail = null;
    _sensorsHistoryMode = false;
    document.getElementById('reportTable').style.display = 'none';
    document.getElementById('noData').style.display = 'none';
    document.getElementById('summaryBar').style.display = 'none';
    document.getElementById('exportMenuWrap').style.display = 'none';
    closeExportMenus();
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
    _selectedBillingKey = null;
    _billingDetail = null;
    document.getElementById('reportTable').style.display = 'none';
    document.getElementById('noData').style.display = 'none';
    document.getElementById('summaryBar').style.display = 'none';
    document.getElementById('exportMenuWrap').style.display = 'none';
    closeExportMenus();
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
        _setReportLoading(true);
        const res = await apiFetch(endpoint);
        if (!res.ok) { showAlert('Failed to load report.', 'error'); return; }
        const data = await res.json();
        _reportPayload = Array.isArray(data) ? { rows: data, columns: [] } : data;
        _reportData = _reportPayload.rows || [];
        if (def.supports_driver_filter) _mergeDriversFromTrips(_reportData);
        _sortCol = _reportPayload.default_sort?.key || null;
        _sortDir = _reportPayload.default_sort?.dir || 1;
        _renderReport();
    } catch (e) {
        console.error(e);
        showAlert('Error generating report.', 'error');
    } finally {
        _setReportLoading(false);
    }
}

function _setReportLoading(isLoading) {
    const btn = document.getElementById('generateReportBtn');
    const table = document.getElementById('reportTable');
    const noData = document.getElementById('noData');
    const summary = document.getElementById('summaryBar');
    const exportWrap = document.getElementById('exportMenuWrap');

    if (btn) {
        btn.disabled = isLoading;
        btn.innerHTML = isLoading
            ? '<i class="mdi mdi-loading mdi-spin"></i> Generating'
            : '<i class="mdi mdi-chart-bar"></i> Generate';
    }
    if (isLoading) {
        table.style.display = 'none';
        summary.style.display = 'none';
        exportWrap.style.display = 'none';
        noData.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i> Generating report...';
        noData.style.display = '';
    } else {
        noData.textContent = 'No data found for the selected period.';
    }
}

function _renderReport() {
    const table   = document.getElementById('reportTable');
    const noData  = document.getElementById('noData');
    const sumBar  = document.getElementById('summaryBar');
    const expWrap = document.getElementById('exportMenuWrap');
    const payload = _reportPayload || { rows: _reportData, columns: [] };
    const columns = (payload.columns || []).filter(c => c.hidden !== true);

    if (_reportData.length === 0) {
        table.style.display = 'none';
        noData.style.display = '';
        sumBar.style.display = 'none';
        expWrap.style.display = 'none';
        closeExportMenus();
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
    expWrap.style.display = 'inline-flex';
}

function toggleExportMenu(e, menuId) {
    e.stopPropagation();
    const menu = document.getElementById(menuId);
    if (!menu) return;
    const wasOpen = menu.classList.contains('open');
    closeExportMenus();
    if (!wasOpen) menu.classList.add('open');
}

function closeExportMenus() {
    document.querySelectorAll('.export-menu.open').forEach(menu => menu.classList.remove('open'));
}
function sortReport(col) {
    ({ col: _sortCol, dir: _sortDir } = RoutarioTables.toggleNumericSort(_sortCol, _sortDir, col));
    _renderReport();
}

function _th(col, label) {
    return RoutarioTables.sortHeader({
        key: col,
        label,
        activeKey: _sortCol,
        direction: _sortDir,
        onClick: 'sortReport',
    });
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
    let attrs = '';
    if (action?.type === 'trip_map') {
        attrs = ` class="table-row" onclick="showTripMap(${idx})"`;
    } else if (action?.type === 'billing_detail') {
        const key = `${row.company_id}-${row.period_key}`;
        const cls = key === _selectedBillingKey ? 'table-row selected' : 'table-row';
        attrs = ` class="${cls}" title="${_esc(action.label || 'View details')}" onclick='showBillingDetail(${Number(row.company_id)}, ${JSON.stringify(row.period_key || '')}, ${JSON.stringify(key)})'`;
    }
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
    const detail = col.detail_key && row[col.detail_key] ? `<br><span style="color:var(--text-muted);font-size:0.75rem;">${_formatValue(row[col.detail_key], { type: col.detail_type || 'text' }, row)}</span>` : '';
    return `<td${title} style="${style}">${_formatValue(row[col.key], col, row)}${detail}</td>`;
}

function _formatValue(value, col = {}, row = {}) {
    if (value === null || value === undefined || value === '') {
        const empty = col.empty || '—';
        return col.empty_tone ? `<span style="color:var(--accent-${col.empty_tone},#eab308);">${_esc(empty)}</span>` : _esc(empty);
    }
    if (col.type === 'datetime' || col.type === 'datetime_split') return _fmtDatetimeSplit(value);
    if (col.type === 'duration_minutes') return _fmtDuration(Number(value));
    if (col.type === 'currency_cents') {
        const currency = col.currency_key ? row[col.currency_key] : col.currency;
        return _fmtMoneyCents(value, currency || 'EUR');
    }
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

function _fmtMoneyCents(cents, currency = 'EUR') {
    return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
    }).format((Number(cents) || 0) / 100);
}

function exportCsv() {
    if (!_reportPayload) return;
    _exportPayloadCsv(_reportPayload, _reportData);
}

function _exportPayloadCsv(payload, data) {
    const columns = (payload.columns || []).filter(c => c.csv !== false && c.hidden !== true);
    const headers = columns.map(c => c.label);
    const sort = _sortCol ? { key: _sortCol, dir: _sortDir } : (payload.default_sort || {});
    const rows = _sortedRowsBy(data || [], sort.key || columns[0]?.key, sort.dir || 1);
    _downloadCsv(headers, rows, r => columns.map(c => _plainValue(r[c.key], c)), payload.csv_filename || 'report.csv');
}

function exportPdf() {
    if (!_reportPayload) return;
    _exportPayloadPdf(_reportPayload, _reportData, _reportDefMap[_reportPayload.type]?.label || 'Report');
}

function _exportPayloadPdf(payload, data, title = 'Report') {
    const columns = (payload.columns || []).filter(c => c.csv !== false && c.hidden !== true);
    const sort = _sortCol ? { key: _sortCol, dir: _sortDir } : (payload.default_sort || {});
    const rows = _sortedRowsBy(data || [], sort.key || columns[0]?.key, sort.dir || 1);
    const win = window.open('', '_blank');
    if (!win) {
        showAlert('Allow popups to export this PDF.', 'warning');
        return;
    }
    const summary = (payload.summary || []).map(card =>
        `<div class="summary"><strong>${_esc(card.label)}</strong><span>${_esc(card.value)}</span></div>`
    ).join('');
    const tableRows = rows.map(row => `<tr>${columns.map(c => `<td>${_esc(_plainValue(row[c.key], c))}</td>`).join('')}</tr>`).join('')
        + (payload.total_row ? `<tr class="total">${columns.map((c, idx) => `<td>${idx === 0 ? _esc(payload.total_row[c.key] ?? 'Total') : _esc(_plainValue(payload.total_row[c.key], c))}</td>`).join('')}</tr>` : '');
    win.document.write(`<!DOCTYPE html><html><head><title>${_esc(title)}</title>
        <style>
            body { font-family: Arial, sans-serif; color: #111827; margin: 24px; }
            h1 { font-size: 22px; margin: 0 0 4px; }
            .meta { color: #6b7280; margin-bottom: 16px; }
            .summary-wrap { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 16px; }
            .summary { border: 1px solid #d1d5db; border-radius: 6px; padding: 8px; }
            .summary strong { display: block; color: #6b7280; font-size: 10px; text-transform: uppercase; }
            .summary span { display: block; margin-top: 4px; font-weight: 700; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #d1d5db; padding: 6px 8px; font-size: 11px; text-align: left; vertical-align: top; }
            th { background: #f3f4f6; }
            tr.total td { font-weight: 700; background: #f9fafb; }
        </style></head><body>
        <h1>${_esc(title)}</h1>
        <div class="meta">${_esc(payload.start_date ? _fmtDatetime(payload.start_date) : '')}${payload.end_date ? ` - ${_esc(_fmtDatetime(payload.end_date))}` : ''}</div>
        ${summary ? `<div class="summary-wrap">${summary}</div>` : ''}
        <table><thead><tr>${columns.map(c => `<th>${_esc(c.label)}</th>`).join('')}</tr></thead><tbody>${tableRows}</tbody></table>
        <script>window.onload = () => { window.print(); };</script>
        </body></html>`);
    win.document.close();
}

function _plainValue(value, col = {}) {
    if (value === null || value === undefined) return '';
    if (col.type === 'datetime' || col.type === 'datetime_split') return _fmtDatetime(value);
    if (col.type === 'duration_minutes') return String(value);
    if (col.type === 'currency_cents') return String((Number(value) || 0) / 100);
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

// ── Billing Detail Modal ─────────────────────────────────────────

async function showBillingDetail(companyId, period, rowKey) {
    if (!companyId || !period) return;
    _selectedBillingKey = rowKey;
    _renderReport();

    const modal = document.getElementById('billingDetailModal');
    const title = document.getElementById('billingDetailTitle');
    const body = document.getElementById('billingDetailBody');
    const pdfBtn = document.getElementById('billingPdfBtn');
    title.textContent = 'Billing Details';
    body.innerHTML = '<div class="billing-detail-muted" style="padding:1rem;text-align:center;">Loading billing details…</div>';
    if (pdfBtn) pdfBtn.disabled = true;
    modal.classList.add('active');

    try {
        const params = new URLSearchParams({ company_id: String(companyId), period });
        const res = await apiFetch(`${API_BASE}/reports/billing/details?${params}`);
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        _billingDetail = await res.json();
        title.textContent = `${_billingDetail.company?.name || 'Company'} - ${_billingDetail.period?.label || 'Billing'}`;
        body.innerHTML = _billingDetailHtml(_billingDetail);
        if (pdfBtn) pdfBtn.disabled = false;
    } catch (e) {
        console.error(e);
        _billingDetail = null;
        body.innerHTML = '<div style="color:var(--accent-danger);padding:1rem;text-align:center;">Failed to load billing details.</div>';
    }
}

function closeBillingDetail() {
    document.getElementById('billingDetailModal')?.classList.remove('active');
}

function exportBillingDetailPdf() {
    if (!_billingDetail) return;
    const company = _billingDetail.company?.name || 'Billing Details';
    const period = _billingDetail.period?.label || '';
    const win = window.open('', '_blank');
    if (!win) {
        showAlert('Allow popups to export this PDF.', 'warning');
        return;
    }
    win.document.write(`<!DOCTYPE html>
        <html><head><title>${_esc(company)} ${_esc(period)}</title>
        <style>
            body { font-family: Arial, sans-serif; color: #111827; margin: 24px; }
            h1 { font-size: 22px; margin: 0 0 4px; }
            h2 { font-size: 15px; margin: 20px 0 8px; }
            .meta { color: #6b7280; margin-bottom: 18px; }
            .billing-detail-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; }
            .billing-detail-card { border: 1px solid #d1d5db; border-radius: 6px; padding: 8px; }
            .k { color: #6b7280; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
            .v { margin-top: 4px; font-weight: 700; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
            th, td { border: 1px solid #d1d5db; padding: 6px 8px; font-size: 12px; text-align: left; }
            th { background: #f3f4f6; }
            .billing-detail-muted { color: #6b7280; }
            @media print { button { display: none; } }
        </style></head><body>
            <h1>${_esc(company)}</h1>
            <div class="meta">${_esc(period)} billing details</div>
            ${_billingDetailHtml(_billingDetail, true)}
            <script>window.onload = () => { window.print(); };</script>
        </body></html>`);
    win.document.close();
}

function _billingDetailHtml(detail, pdf = false) {
    const currency = detail.currency || 'EUR';
    const company = detail.company || {};
    const plan = detail.plan;
    const usage = detail.usage || {};
    return `
        <div class="billing-detail-grid">
            ${_billingCard('Period', detail.period?.label || '-')}
            ${_billingCard('Billing Email', company.billing_email || '-')}
            ${_billingCard('Billing Status', company.billing_status || '-')}
            ${_billingCard('Draft Total', _fmtMoneyCents(detail.total_display_cents, currency))}
        </div>

        <div>
            <div class="billing-section-title">${pdf ? '<h2>Plan</h2>' : 'Plan'}</div>
            ${plan ? `<div class="billing-detail-grid">
                ${_billingCard('Plan Name', plan.name)}
                ${_billingCard('Base Price', _fmtMoneyCents(plan.base_price_display_cents, currency))}
                ${_billingCard('Included Devices', _fmtInt(plan.included_devices))}
                ${_billingCard('Included Positions', _fmtInt(plan.included_positions))}
                ${_billingCard('Included API Calls', _fmtInt(plan.included_api_calls))}
                ${_billingCard('Extra Device', _fmtMoneyCents(plan.price_per_device_display_cents, currency))}
                ${_billingCard('Extra 1,000 Positions', _fmtMoneyCents(plan.price_per_1000_positions_display_cents, currency))}
                ${_billingCard('Extra 1,000 API Calls', _fmtMoneyCents(plan.price_per_1000_api_calls_display_cents, currency))}
            </div>` : '<div class="billing-detail-muted">No billing plan is assigned to this company.</div>'}
        </div>

        <div>
            <div class="billing-section-title">${pdf ? '<h2>Usage</h2>' : 'Usage'}</div>
            <div class="billing-detail-grid">
                ${_billingCard('Active Devices', _fmtInt(usage.active_devices))}
                ${_billingCard('Positions', _fmtInt(usage.positions))}
                ${_billingCard('API Calls', _fmtInt(usage.api_calls))}
                ${_billingCard('Usage Events', _fmtInt(Object.keys(usage.events || {}).length))}
            </div>
            ${_billingEventsTable(usage.events || {})}
        </div>

        <div>
            <div class="billing-section-title">${pdf ? '<h2>Draft Billing Lines</h2>' : 'Draft Billing Lines'}</div>
            ${_billingLinesTable(detail.line_items || [], currency)}
        </div>

        <div>
            <div class="billing-section-title">${pdf ? `<h2>${_esc(_billingBreakdownTitle(detail))}</h2>` : _billingBreakdownTitle(detail)}</div>
            ${_billingBreakdownHtml(detail.breakdown || detail.monthly || [], detail.breakdown_grain || 'monthly', currency)}
        </div>`;
}

function _billingCard(label, value) {
    return `<div class="billing-detail-card"><div class="k">${_esc(label)}</div><div class="v">${_esc(value)}</div></div>`;
}

function _billingEventsTable(events) {
    const rows = Object.entries(events);
    if (!rows.length) return '<div class="billing-detail-muted" style="margin-top:0.75rem;">No additional usage events recorded.</div>';
    return `<div style="overflow-x:auto;margin-top:0.75rem;"><table class="devices-table billing-detail-table">
        <thead><tr><th>Metric</th><th>Quantity</th></tr></thead>
        <tbody>${rows.map(([metric, qty]) => `<tr><td>${_esc(metric)}</td><td>${_fmtInt(qty)}</td></tr>`).join('')}</tbody>
    </table></div>`;
}

function _billingLinesTable(lines, currency) {
    if (!lines.length) return '<div class="billing-detail-muted">No draft billing lines for this period.</div>';
    return `<div style="overflow-x:auto;"><table class="devices-table billing-detail-table">
        <thead><tr><th>Description</th><th>Quantity</th><th>Unit</th><th>Billable Units</th><th>Amount</th></tr></thead>
        <tbody>${lines.map(line => `<tr>
            <td>${_esc(line.label || '-')}</td>
            <td>${_fmtInt(line.quantity || 0)}</td>
            <td>${_esc(line.unit || '-')}</td>
            <td>${line.billable_units ? _fmtInt(line.billable_units) : '-'}</td>
            <td>${_fmtMoneyCents(line.amount_display_cents, currency)}</td>
        </tr>`).join('')}</tbody>
    </table></div>`;
}

function _billingBreakdownTitle(detail) {
    return detail.breakdown_grain === 'daily' ? 'Daily Usage' : 'Monthly Breakdown';
}

function _billingBreakdownHtml(items, grain, currency) {
    if (!items.length) return `<div class="billing-detail-muted">No ${grain === 'daily' ? 'daily' : 'monthly'} usage found.</div>`;
    const billingCols = grain === 'daily' ? '' : '<th>Draft Total</th><th>Billing Lines</th>';
    return `<div style="overflow-x:auto;"><table class="devices-table billing-detail-table">
        <thead>
            <tr>
                <th>${grain === 'daily' ? 'Day' : 'Month'}</th>
                <th>Active Devices</th>
                <th>Positions</th>
                <th>API Calls</th>
                ${billingCols}
            </tr>
        </thead>
        <tbody>${items.map(item => `<tr>
            <td><strong>${_esc(item.label || '-')}</strong></td>
            <td>${_fmtInt(item.usage?.active_devices)}</td>
            <td>${_fmtInt(item.usage?.positions)}</td>
            <td>${_fmtInt(item.usage?.api_calls)}</td>
            ${grain === 'daily' ? '' : `<td>${_fmtMoneyCents(item.amount_display_cents, currency)}</td><td>${_billingLineSummary(item.line_items || [], currency)}</td>`}
        </tr>`).join('')}</tbody>
    </table></div>`;
}

function _billingLineSummary(lines, currency) {
    if (!lines.length) return '<span class="billing-detail-muted">No billing lines</span>';
    return lines.map(line => {
        const qty = line.quantity ? ` × ${_fmtInt(line.quantity)}` : '';
        return `<div>${_esc(line.label || '-')}${qty} <span class="billing-detail-muted">(${_fmtMoneyCents(line.amount_display_cents, currency)})</span></div>`;
    }).join('');
}

function _fmtInt(value) {
    return new Intl.NumberFormat().format(Number(value) || 0);
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
    return RoutarioUI.escapeHtml(s);
}

// ══════════════════════════════════════════════════════════════════════════════
// Tab management
// ══════════════════════════════════════════════════════════════════════════════

let _activeTab = 'reports';

function _validReportTab(tab) {
    return ['reports', 'schedules', 'health'].includes(tab);
}

function switchTab(tab, pushState = true) {
    if (tab === 'reports' && !hasPermission('view_reports')) tab = 'health';
    if (tab === 'schedules' && !hasPermission('view_reports')) tab = 'health';
    if (tab === 'health' && !hasPermission('view_health')) tab = 'reports';
    _activeTab = tab;
    RoutarioTabs.activate(_REPORT_TABS, tab);
    _injectNavScheduleAction();
    if (pushState !== false) RoutarioTabs.replaceHash(tab);
    if (tab === 'schedules') _loadSchedules();
    if (tab === 'health') loadHealth();
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
        document.getElementById('exportMenuWrap').style.display  = 'none';
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
    document.getElementById('exportMenuWrap').style.display  = 'none';
    closeExportMenus();
    _reportData = [];
    switchTab('schedules');
}

function _renderRunData(reportType, data) {
    _reportPayload = data || { rows: [], columns: [] };
    _reportData = data.rows || [];
    _sortCol    = _reportPayload.default_sort?.key || null;
    _sortDir    = _reportPayload.default_sort?.dir || 1;
    _renderReport();
}

function exportCsvFromRun() {
    if (!_viewingRunData) return;
    exportCsv();
}

function exportPdfFromRun() {
    if (!_viewingRunData) return;
    exportPdf();
}

// ══════════════════════════════════════════════════════════════════════════════
// Schedules list
// ══════════════════════════════════════════════════════════════════════════════

const _RANGE_LABELS = { last_day: 'Last day', last_7_days: 'Last 7 days', last_14_days: 'Last 14 days', last_30_days: 'Last 30 days', last_calendar_month: 'Last calendar month', last_quarter: 'Last quarter', last_year: 'Last year' };
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
    return RoutarioTables.sortHeader({
        key: col,
        label,
        activeKey: _schedSortCol,
        direction: _schedSortDir,
        onClick: 'sortSchedules',
    });
}

function sortSchedules(col) {
    ({ col: _schedSortCol, dir: _schedSortDir } = RoutarioTables.toggleNumericSort(_schedSortCol, _schedSortDir, col));
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

        return `<tr class="table-row${_expandedScheduleId === s.id ? ' expanded' : ''}" onclick="toggleRunHistory(${s.id}, this)" id="sr-${s.id}">
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
    document.querySelectorAll('.schedules-table tbody tr:not(.run-history-row)').forEach(r => r.classList.remove('expanded'));
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
            <table class="devices-table run-table">
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
    const closeMenu = "document.getElementById('snDropdown').classList.remove('open');document.getElementById('snGearBtn').classList.remove('active');";
    if (_activeTab === 'health') {
        el.innerHTML = `<button class="header-menu-item" onclick="loadHealth();${closeMenu}">
            <span class="header-menu-item-icon"><i class="mdi mdi-refresh" style="font-size:15px;"></i></span>
            <span>Refresh</span>
        </button>`;
        return;
    }
    el.innerHTML = hasPermission('view_reports') ? `<button class="header-menu-item" onclick="openScheduleModal(null);${closeMenu}">
        <span class="header-menu-item-icon"><i class="mdi mdi-calendar-plus" style="font-size:15px;"></i></span>
        <span>New Schedule</span>
    </button>` : '';
}

async function loadHealth() {
    const body = document.getElementById('healthTableBody');
    if (!body) return;
    body.innerHTML = RoutarioTables.stateRow('Loading health checks...', 3);
    try {
        const res = await fetch('/health/ready');
        const data = await res.json();
        _healthRows = Object.entries(data.checks || {}).map(([name, check]) => ({ name, ...check }));
        renderHealthTable();
    } catch (e) {
        body.innerHTML = RoutarioTables.stateRow(_esc(e.message), 3);
    }
}

function renderHealthTable() {
    const body = document.getElementById('healthTableBody');
    if (!body) return;
    const q = (document.getElementById('healthSearch')?.value || '').toLowerCase();
    const rows = _healthRows.filter(row => JSON.stringify(row).toLowerCase().includes(q));
    rows.sort((a, b) => _compareValues(_healthValue(a, _healthSort.col), _healthValue(b, _healthSort.col), _healthSort.dir));
    const count = document.getElementById('healthCount');
    if (count) count.textContent = `${rows.length} check${rows.length !== 1 ? 's' : ''}`;
    _updateSortHeaders('panelHealth', _healthSort);
    body.innerHTML = rows.length ? rows.map(row => `
        <tr>
            <td>${_esc(row.name)}</td>
            <td><span class="proto-badge health-status health-status-${_healthStatus(row)}">${_healthStatus(row)}</span></td>
            <td>${_healthDetails(row)}</td>
        </tr>
    `).join('') : RoutarioTables.stateRow('No health checks match.', 3);
}

function _listenerLabel(listener) {
    if (!listener) return '';
    const transport = listener.protocol_type || listener.type || '';
    const port = listener.port ? `:${listener.port}` : '';
    return [listener.protocol, transport].filter(Boolean).join('/') + port;
}

function _healthDetails(row) {
    if (row.name === 'database') {
        const metrics = [..._latencyMetrics(row), ['DB', row.database_type || '-'], ['Pool', row.pool_class || '-'], ['Pool size', row.pool_size ?? row.size ?? '-'], ['In pool', row.connections_in_pool ?? row.checkedin ?? '-'], ['Checked out', row.current_checked_out ?? row.checkedout ?? '-'], ['Overflow', row.current_overflow ?? row.overflow ?? '-']];
        return _healthBox(metrics, row.error ? [['Error', row.error]] : [], row.error ? 'danger' : '');
    }
    if (row.name === 'disk') {
        const worst = Math.max(...(row.paths || []).map(p => Number(p.used_percent) || 0), 0);
        const metrics = [['Writable', row.ok ? 'yes' : 'no', row.ok ? 'ok' : 'danger'], ['Worst usage', `${worst}%`, worst >= 95 ? 'danger' : worst >= 85 ? 'warn' : 'ok']];
        const lines = (row.paths || []).map(p => [p.label || p.path, `${p.ok ? (p.degraded ? 'degraded' : 'ok') : 'critical'}, used ${p.used_percent == null ? '?' : `${p.used_percent}%`}, free ${p.free_bytes == null ? '-' : _formatBytes(p.free_bytes)}${p.error ? `; ${p.error}` : ''}`]);
        if (row.error) lines.unshift(['Error', row.error]);
        return _healthBox(metrics, lines, row.error ? 'danger' : '');
    }
    if (row.name === 'redis') {
        const metrics = [..._latencyMetrics(row), ['Reachable', row.ok ? 'yes' : 'no', row.ok ? 'ok' : 'info'], ['Pub/sub', row.available ? 'redis' : (row.mode || 'fallback'), row.available ? 'ok' : 'info']];
        const lines = [];
        if (row.error) lines.push(['Ping', row.error]);
        if (row.pubsub_error && row.pubsub_error !== row.error) lines.push(['Pub/sub', row.pubsub_error]);
        return _healthBox(metrics, lines);
    }
    if (row.name === 'valhalla') {
        const enabled = row.enabled !== false && row.optional !== true;
        const metrics = [['Enabled', enabled ? 'yes' : 'no', enabled ? 'ok' : 'info'], ['Reachable', row.available || row.ok ? 'yes' : 'no', row.available || row.ok ? 'ok' : (enabled ? 'danger' : 'info')]];
        const lines = [['URL', row.url || '-'], ['State', row.message || (row.ok ? 'available' : enabled ? 'unreachable' : 'disabled')]];
        if (row.error) lines.push(['Error', row.error]);
        return _healthBox(metrics, lines, row.degraded ? 'warn' : '');
    }
    if (row.error) return _healthBox([], [['Error', row.error]], 'danger');
    if (row.name === 'protocol_listeners') {
        const metrics = [['Active', row.active_protocols?.length || 0], ['Expected', row.expected_listeners?.length || 0], ['Running', row.running_listeners?.filter(l => l.running)?.length || 0]];
        const lines = [];
        if (row.unknown_protocols?.length) lines.push(['Unknown', row.unknown_protocols.join(', ')]);
        if (row.missing_listeners?.length) lines.push(['Missing', row.missing_listeners.map(_listenerLabel).join(', ')]);
        if (row.unhealthy_listeners?.length) lines.push(['Stopped', row.unhealthy_listeners.map(_listenerLabel).join(', ')]);
        if (row.unexpected_listeners?.length) lines.push(['Unexpected', row.unexpected_listeners.map(_listenerLabel).join(', ')]);
        if (row.integration_protocols?.length) lines.push(['Integration-only', row.integration_protocols.join(', ')]);
        if (!lines.length) lines.push(['Listeners', row.running_listeners?.length ? row.running_listeners.map(_listenerLabel).join(', ') : 'none']);
        return _healthBox(metrics, lines);
    }
    if (row.name === 'background_tasks' && row.tasks) {
        const tasks = Object.entries(row.tasks);
        const metrics = [['Running', tasks.filter(([, task]) => task.running).length], ['Total', tasks.length]];
        const lines = tasks.map(([name, task]) => [name, `${task.ok ? 'ok' : 'fail'}, ${task.last_success_age_seconds == null ? 'no successful loop yet' : `${task.last_success_age_seconds}s since success`}${task.last_error ? `; ${task.last_error}` : ''}`]);
        return _healthBox(metrics, lines);
    }
    if (row.name === 'ingestion') {
        return _healthBox([
            ['Active', row.active_devices ?? 0],
            ['Online', row.online_devices ?? 0],
            ['With positions', row.devices_with_positions ?? 0],
            ['Stale >15m', row.stale_over_15m_count ?? 0, row.stale_over_15m_count ? 'warn' : 'ok'],
            ['Never seen', row.never_seen_count ?? 0, row.never_seen_count ? 'warn' : 'ok'],
        ], [['Latest position', row.latest_position_age_seconds == null ? 'none' : `${row.latest_position_age_seconds}s ago`]]);
    }
    if (row.name === 'integration_accounts') {
        if (!row.accounts?.length) return _healthBox([['Accounts', 0]], [['Integrations', 'No active integration accounts']]);
        const errored = row.accounts.filter(a => a.last_error);
        const sample = (errored.length ? errored : row.accounts).slice(0, 5).map(a => [`${a.provider_id}/${a.account_label || 'default'}`, `${a.active_device_count ?? 0} device${a.active_device_count === 1 ? '' : 's'}, ${a.last_auth_at ? `auth ${new Date(a.last_auth_at).toLocaleString()}` : 'not authenticated yet'}${a.last_error ? `; ${a.last_error}` : ''}`]);
        return _healthBox([['Accounts', row.active_accounts ?? 0], ['Errors', row.accounts_with_errors ?? 0, row.accounts_with_errors ? 'danger' : 'ok']], sample);
    }
    if (row.name === 'runtime') {
        return _healthBox([['Version', row.app_version || '-'], ['Commit', row.git_commit || '-'], ['Uptime', `${row.uptime_seconds ?? 0}s`], ['Python', row.python_version || '-'], ['DB', row.database_type || '-']], [['Platform', row.platform || '-']]);
    }
    if (row.degraded) return _healthBox([], [['State', 'degraded']], 'warn');
    return '';
}

function _latencyMetrics(row) {
    return row.latency_ms == null ? [] : [['Latency', `${row.latency_ms} ms`]];
}

function _healthBox(metrics = [], lines = [], tone = '') {
    const metricHtml = metrics.length ? `<div class="health-metrics">${metrics.map(([label, value, metricTone]) => _healthMetric(label, value, metricTone)).join('')}</div>` : '';
    const lineHtml = lines.length ? `<div class="health-lines">${lines.map(([label, value]) => `<div class="health-line"><span class="health-line-label">${_esc(label)}</span><span class="health-line-value">${_esc(value)}</span></div>`).join('')}</div>` : '';
    return `<div class="health-details${tone ? ` health-details-${tone}` : ''}">${metricHtml}${lineHtml}</div>`;
}

function _healthMetric(label, value, tone = '') {
    return `<span class="health-metric${tone ? ` health-chip-${tone}` : ''}"><span>${_esc(label)}</span><strong>${_esc(value)}</strong></span>`;
}

function _formatBytes(bytes) {
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

function _healthValue(row, col) {
    const status = _healthStatus(row);
    return { name: row.name, status, latency: Number(row.latency_ms) || 0, details: row.error || (row.degraded ? 'degraded' : JSON.stringify(row)) }[col];
}

function _healthStatus(row) {
    if (row.degraded) return 'degraded';
    if (row.ok) return 'ok';
    if (row.optional) return 'optional';
    return 'fail';
}

function sortHealth(col) {
    _healthSort = RoutarioTables.toggleTextSort(_healthSort, col);
    renderHealthTable();
}

function _compareValues(a, b, dir = 'asc') {
    const av = a ?? '';
    const bv = b ?? '';
    let result;
    if (typeof av === 'number' && typeof bv === 'number') result = av - bv;
    else result = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    return dir === 'desc' ? -result : result;
}

function _updateSortHeaders(panelId, sortState) {
    RoutarioTables.updateSortHeaders(panelId, sortState);
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
    _sfControlValues = schedule?.options || {};
    _renderSfChannels(schedule?.notification_channels || []);

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

function _renderSfChannels(selected = []) {
    const list = document.getElementById('sfChannelList');
    if (!list) return;
    if (!_notificationChannels.length) {
        list.innerHTML = '<span style="color:var(--text-muted);font-size:0.85rem;">No notification channels configured.</span>';
        return;
    }
    const selectedSet = new Set(selected || []);
    list.innerHTML = _notificationChannels.map(channel => `
        <label class="channel-pill${selectedSet.has(channel.name) ? ' active' : ''}">
            <input type="checkbox" class="sf-channel-cb" value="${_esc(channel.name)}" ${selectedSet.has(channel.name) ? 'checked' : ''} onchange="onSfChannelChange(this)">
            <span>${_esc(channel.name)}</span>
        </label>
    `).join('');
}

function onSfChannelChange(cb) {
    cb.closest('.channel-pill')?.classList.toggle('active', cb.checked);
}

function _getSelectedScheduleChannels() {
    return [...document.querySelectorAll('.sf-channel-cb:checked')].map(cb => cb.value);
}

function onSchedTypeChange() {
    const t      = document.getElementById('sfType').value;
    const def    = _reportDefMap[t] || {};
    const isSens = def.supports_historical_toggle;
    const current = { ..._sfControlValues, ..._getScheduleControlValues() };

    document.getElementById('sfHistGroup').style.display  = isSens ? '' : 'none';
    document.getElementById('sfUserGroup').style.display  = (def.schedule_uses_user_filter && _CAN_SEE_USERS) ? '' : 'none';
    document.getElementById('sfVehWrap').closest('.form-group').style.display = def.schedule_uses_device_filter === false ? 'none' : '';
    _renderScheduleControls(def.schedule_controls?.length ? def.schedule_controls : (def.controls || []), current);

    // Date range: hidden for sensors when not in historical mode
    const needsRange = def.needs_date_range !== false || document.getElementById('sfHistorical').checked;
    document.getElementById('sfDateRangeGroup').style.display = needsRange ? '' : 'none';
}

function onSchedHistChange() {
    onSchedTypeChange();
}

function onScheduleControlChange() {
    _sfControlValues = _getScheduleControlValues();
}

function _renderScheduleControls(controls, current = _sfControlValues) {
    const wrap = document.getElementById('sfControlsGroup');
    if (!wrap) return;
    wrap.innerHTML = _renderControlInputs(controls, current, 'schedule-control', 'onScheduleControlChange()');
    _sfControlValues = _getScheduleControlValues();
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
        options:            _getScheduleControlValues(),
        notification_channels: _getSelectedScheduleChannels(),
        attach_results:     true,
        attach_documents:   true,
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
    closeExportMenus();
    const vw = document.getElementById('sfVehWrap');
    if (vw && !vw.contains(e.target)) vw.classList.remove('open');
    const uw = document.getElementById('sfUserWrap');
    if (uw && !uw.contains(e.target)) uw.classList.remove('open');
});
