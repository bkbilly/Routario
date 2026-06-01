'use strict';

let _reportData          = [];
let _sortCol             = null;
let _sortDir             = 1;
let _allDevices          = [];
let _selectedIds         = new Set(); // empty = all
let _sensorsHistoryMode  = false;
let _tripRows            = []; // sorted trip rows, for map button index lookup

let _allUsers            = [];
let _selectedUserIds     = new Set(); // empty = all visible users

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
    _updateDescription();
    _injectNavScheduleAction();

    document.addEventListener('click', e => {
        const wrap = document.getElementById('vehSelectWrap');
        if (wrap && !wrap.contains(e.target)) wrap.classList.remove('open');
        const uwrap = document.getElementById('userSelectWrap');
        if (uwrap && !uwrap.contains(e.target)) uwrap.classList.remove('open');
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && document.getElementById('tripMapModal').classList.contains('active')) {
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

function onReportTypeChange() {
    _reportData = [];
    _sensorsHistoryMode = false;
    document.getElementById('reportTable').style.display = 'none';
    document.getElementById('noData').style.display = 'none';
    document.getElementById('summaryBar').style.display = 'none';
    document.getElementById('exportCsvBtn').style.display = 'none';
    const type = document.getElementById('reportType').value;
    const isSensors = type === 'sensors';
    const isAlerts  = type === 'alerts';
    document.getElementById('historyCheckGroup').style.display = isSensors ? '' : 'none';
    document.getElementById('historyCheck').checked = false;
    document.getElementById('dateFromGroup').style.display = isSensors ? 'none' : '';
    document.getElementById('dateToGroup').style.display  = isSensors ? 'none' : '';
    document.getElementById('userSelectGroup').style.display = (isAlerts && _CAN_SEE_USERS) ? '' : 'none';
    _updateDescription();
}

const _REPORT_DESCRIPTIONS = {
    summary: 'Totals per vehicle for the selected period — trips, distance, driving time, and top speed.',
    trips:   'Individual trips with start/end location, distance, duration, and driver. Click any row to view the route on a map.',
    daily:   'All trips aggregated by day — total trips, distance, and driving time per date.',
    drivers: 'Activity per driver for the selected period — trips, distance, driving time, and top speed.',
    sensors: 'Current sensor readings for all vehicles. Enable historical data to view sensor values over a date range.',
    alerts:  'Alert history for the selected period. Admins can filter by user.',
};

function _updateDescription() {
    const type = document.getElementById('reportType').value;
    document.getElementById('reportDescription').textContent = _REPORT_DESCRIPTIONS[type] || '';
}

function onHistoryCheckChange() {
    const checked = document.getElementById('historyCheck').checked;
    document.getElementById('dateFromGroup').style.display = checked ? '' : 'none';
    document.getElementById('dateToGroup').style.display   = checked ? '' : 'none';
}

async function generateReport() {
    const type = document.getElementById('reportType').value;

    if (type === 'alerts') {
        const start = document.getElementById('startDate').value;
        const end   = document.getElementById('endDate').value;
        if (!start || !end) { showAlert('Please select a date range.', 'warning'); return; }

        const params = new URLSearchParams({
            start_date: `${start}T00:00:00`,
            end_date:   `${end}T23:59:59`,
            limit: 2000,
        });
        if (_selectedIds.size)     [..._selectedIds].forEach(id => params.append('device_ids', id));
        if (_selectedUserIds.size) [..._selectedUserIds].forEach(id => params.append('user_ids', id));

        try {
            const res = await apiFetch(`${API_BASE}/alerts/report?${params}`);
            if (!res.ok) { showAlert('Failed to load alerts.', 'error'); return; }
            _reportData = await res.json();
            _sortCol = null;
            _renderAlerts();
        } catch (e) { console.error(e); showAlert('Error generating report.', 'error'); }
        return;
    }

    if (type === 'sensors') {
        _sensorsHistoryMode = document.getElementById('historyCheck').checked;
        try {
            const devRes = await apiFetch(`${API_BASE}/devices`);
            if (!devRes.ok) { showAlert('Failed to load devices.', 'error'); return; }
            const devices = await devRes.json();
            const filtered = _selectedIds.size ? devices.filter(d => _selectedIds.has(d.id)) : devices;

            if (_sensorsHistoryMode) {
                const start = document.getElementById('startDate').value;
                const end   = document.getElementById('endDate').value;
                if (!start || !end) { showAlert('Please select a date range.', 'warning'); return; }
                const results = await Promise.all(filtered.map(async d => {
                    try {
                        const r = await apiFetch(`${API_BASE}/positions/history`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ device_id: d.id, start_time: `${start}T00:00:00`, end_time: `${end}T23:59:59`, max_points: 5000 }),
                        });
                        if (!r.ok) return [];
                        const data = await r.json();
                        return (data.features || []).map(f => ({ ...f.properties, _device: d }));
                    } catch { return []; }
                }));
                _reportData = results.flat();
            } else {
                _reportData = filtered;
            }
            _sortCol = null;
            _sensorsHistoryMode ? _renderSensorsHistory() : _renderSensors();
        } catch (e) { console.error(e); showAlert('Error generating report.', 'error'); }
        return;
    }

    const start = document.getElementById('startDate').value;
    const end   = document.getElementById('endDate').value;
    if (!start || !end) { showAlert('Please select a date range.', 'warning'); return; }

    const deviceParam = _selectedIds.size ? `&device_ids=${[..._selectedIds].join(',')}` : '';

    const endpoint = type === 'summary'
        ? `${API_BASE}/reports/fleet?start_date=${start}T00:00:00&end_date=${end}T23:59:59${deviceParam}`
        : `${API_BASE}/reports/trips?start_date=${start}T00:00:00&end_date=${end}T23:59:59${deviceParam}`;

    try {
        const res = await apiFetch(endpoint);
        if (!res.ok) { showAlert('Failed to load report.', 'error'); return; }
        const data = await res.json();
        _reportData = type === 'summary' ? data.rows : data;
        _sortCol = null;
        _renderReport();
    } catch (e) { console.error(e); alert('Error generating report.'); }
}

function _renderReport() {
    const type    = document.getElementById('reportType').value;
    const table   = document.getElementById('reportTable');
    const noData  = document.getElementById('noData');
    const sumBar  = document.getElementById('summaryBar');
    const expBtn  = document.getElementById('exportCsvBtn');

    if (_reportData.length === 0) {
        table.style.display = 'none';
        noData.style.display = '';
        sumBar.style.display = 'none';
        expBtn.style.display = 'none';
        return;
    }

    if (type === 'summary')      _renderSummary();
    else if (type === 'trips')   _renderTripList();
    else if (type === 'daily')   _renderDaily();
    else if (type === 'drivers') _renderDrivers();

    table.style.display = '';
    noData.style.display = 'none';
    expBtn.style.display = '';
}

// ── Alerts Report ─────────────────────────────────────────────────

const _SEV_COLOR = { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#3b82f6', info: 'var(--text-muted)' };

function _renderAlerts() {
    const table  = document.getElementById('reportTable');
    const head   = document.getElementById('reportHead');
    const tbody  = document.getElementById('reportBody');
    const noData = document.getElementById('noData');
    const sumBar = document.getElementById('summaryBar');
    const expBtn = document.getElementById('exportCsvBtn');

    if (!_reportData.length) {
        table.style.display = 'none';
        noData.style.display = '';
        sumBar.style.display = 'none';
        expBtn.style.display = 'none';
        return;
    }

    const rows = _sortedRows(_reportData, 'created_at', -1);

    const total    = rows.length;
    const unread   = rows.filter(r => !r.is_read).length;
    const critical = rows.filter(r => r.severity === 'critical' || r.severity === 'high').length;
    const byType   = {};
    rows.forEach(r => { byType[r.alert_type] = (byType[r.alert_type] || 0) + 1; });
    const topType  = Object.entries(byType).sort((a, b) => b[1] - a[1])[0];

    sumBar.innerHTML = `
        <div class="summary-card"><div class="val">${total}</div><div class="lbl">Total Alerts</div></div>
        <div class="summary-card"><div class="val" style="color:var(--accent-warning,#eab308);">${unread}</div><div class="lbl">Unread</div></div>
        <div class="summary-card"><div class="val" style="color:#ef4444;">${critical}</div><div class="lbl">Critical / High</div></div>
        ${topType ? `<div class="summary-card"><div class="val" style="font-size:1rem;">${_esc(topType[0])}</div><div class="lbl">Most Frequent (${topType[1]})</div></div>` : ''}`;
    sumBar.style.display = '';

    const showUser = _CAN_SEE_USERS;
    head.innerHTML = `<tr>
        ${_th('created_at', 'Date / Time')}
        ${showUser ? _th('username', 'User') : ''}
        ${_th('device_name', 'Vehicle')}
        ${_th('alert_type', 'Type')}
        ${_th('severity', 'Severity')}
        ${_th('message', 'Message')}
        ${_th('is_read', 'Status')}
    </tr>`;

    tbody.innerHTML = rows.map(r => {
        const color   = _SEV_COLOR[r.severity] || 'var(--text-muted)';
        const sevBadge = `<span style="color:${color};font-weight:600;text-transform:capitalize;">${_esc(r.severity)}</span>`;
        const status  = r.is_read
            ? `<span style="color:var(--text-muted);">Read</span>`
            : `<span style="color:var(--accent-primary);font-weight:600;">Unread</span>`;
        return `<tr>
            <td style="white-space:nowrap;font-family:var(--font-mono);font-size:0.82rem;">${_fmtDatetime(r.created_at)}</td>
            ${showUser ? `<td>${_esc(r.username || '—')}</td>` : ''}
            <td>${_esc(r.device_name || '—')}</td>
            <td style="font-size:0.82rem;">${_esc(r.alert_type)}</td>
            <td>${sevBadge}</td>
            <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${_esc(r.message)}">${_esc(r.message)}</td>
            <td>${status}</td>
        </tr>`;
    }).join('');

    table.style.display = '';
    noData.style.display = 'none';
    expBtn.style.display = '';
}

// ── Fleet Summary ─────────────────────────────────────────────────

function _renderSummary() {
    const rows = _sortedRows(_reportData, _sortCol || 'device_name');
    const head = document.getElementById('reportHead');
    const tbody = document.getElementById('reportBody');
    const sumBar = document.getElementById('summaryBar');

    head.innerHTML = `<tr>
        ${_th('device_name','Vehicle')}
        ${_th('license_plate','Plate')}
        ${_th('driver_name','Driver')}
        ${_th('trips','Trips')}
        ${_th('distance_km','Distance (km)')}
        ${_th('driving_minutes','Drive Time')}
        ${_th('avg_speed','Avg Speed')}
        ${_th('max_speed','Top Speed')}
    </tr>`;

    const totalTrips = rows.reduce((s, r) => s + r.trips, 0);
    const totalDist  = rows.reduce((s, r) => s + r.distance_km, 0);
    const totalMins  = rows.reduce((s, r) => s + r.driving_minutes, 0);
    const topSpeed   = rows.length ? Math.max(...rows.map(r => r.max_speed)) : 0;

    sumBar.innerHTML = `
        <div class="summary-card"><div class="val">${rows.length}</div><div class="lbl">Vehicles</div></div>
        <div class="summary-card"><div class="val">${totalTrips}</div><div class="lbl">Total Trips</div></div>
        <div class="summary-card"><div class="val">${totalDist.toFixed(1)}</div><div class="lbl">Total Distance (km)</div></div>
        <div class="summary-card"><div class="val">${(totalMins/60).toFixed(1)}</div><div class="lbl">Driving Time (h)</div></div>
        <div class="summary-card"><div class="val">${topSpeed.toFixed(0)}</div><div class="lbl">Top Speed (km/h)</div></div>`;
    sumBar.style.display = '';

    tbody.innerHTML = rows.map(r => `<tr>
        <td>${_esc(r.device_name)}</td>
        <td>${_esc(r.license_plate || '—')}</td>
        <td>${_esc(r.driver_name || '—')}</td>
        <td>${r.trips}</td>
        <td>${r.distance_km.toFixed(1)}</td>
        <td>${_fmtDuration(r.driving_minutes)}</td>
        <td>${r.avg_speed.toFixed(1)} km/h</td>
        <td>${r.max_speed.toFixed(1)} km/h</td>
    </tr>`).join('') + `<tr class="total-row">
        <td colspan="3">Total</td>
        <td>${totalTrips}</td>
        <td>${totalDist.toFixed(1)}</td>
        <td>${_fmtDuration(totalMins)}</td>
        <td>—</td>
        <td>${topSpeed.toFixed(0)} km/h</td>
    </tr>`;
}

// ── Trip List ─────────────────────────────────────────────────────

function _renderTripList() {
    _tripRows = _sortedRows(_reportData, _sortCol || 'start_time', -1);
    const rows = _tripRows;
    const head  = document.getElementById('reportHead');
    const tbody = document.getElementById('reportBody');
    const sumBar = document.getElementById('summaryBar');

    head.innerHTML = `<tr>
        ${_th('start_time','Date')}
        ${_th('device_name','Vehicle')}
        ${_th('start_address','From')}
        ${_th('end_address','To')}
        ${_th('distance_km','Distance (km)')}
        ${_th('duration_minutes','Duration')}
        ${_th('avg_speed','Avg Speed')}
        ${_th('max_speed','Top Speed')}
        ${_th('driver_name','Driver')}
    </tr>`;

    const totalTrips = rows.length;
    const totalDist  = rows.reduce((s, r) => s + r.distance_km, 0);
    const totalMins  = rows.reduce((s, r) => s + r.duration_minutes, 0);
    const topSpeed   = rows.length ? Math.max(...rows.map(r => r.max_speed)) : 0;

    sumBar.innerHTML = `
        <div class="summary-card"><div class="val">${totalTrips}</div><div class="lbl">Trips</div></div>
        <div class="summary-card"><div class="val">${totalDist.toFixed(1)}</div><div class="lbl">Total Distance (km)</div></div>
        <div class="summary-card"><div class="val">${(totalMins/60).toFixed(1)}</div><div class="lbl">Driving Time (h)</div></div>
        <div class="summary-card"><div class="val">${topSpeed.toFixed(1)} km/h</div><div class="lbl">Top Speed</div></div>`;
    sumBar.style.display = '';

    tbody.innerHTML = rows.map((r, i) => `<tr style="cursor:pointer;" onclick="showTripMap(${i})">
        <td style="white-space:nowrap;">${_fmtDatetime(r.start_time)}</td>
        <td>${_esc(r.device_name)}${r.license_plate ? `<br><span style="color:var(--text-muted);font-size:0.75rem;">${_esc(r.license_plate)}</span>` : ''}</td>
        <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${_esc(r.start_address||'')}">${_esc(r.start_address || '—')}</td>
        <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${_esc(r.end_address||'')}">${_esc(r.end_address || '—')}</td>
        <td>${r.distance_km.toFixed(1)}</td>
        <td>${_fmtDuration(r.duration_minutes)}</td>
        <td>${r.avg_speed.toFixed(1)} km/h</td>
        <td>${r.max_speed.toFixed(1)} km/h</td>
        <td>${_esc(r.driver_name || '—')}</td>
    </tr>`).join('');
}

// ── Driver Activity ───────────────────────────────────────────────

function _renderDrivers() {
    const byDriver = {};
    for (const r of _reportData) {
        if (!r.driver_name) continue;
        const key = r.driver_name;
        if (!byDriver[key]) byDriver[key] = { driver: key, trips: 0, distance_km: 0, driving_minutes: 0, max_speed: 0, total_avg_speed: 0, vehicles: new Set() };
        byDriver[key].trips++;
        byDriver[key].distance_km    += r.distance_km;
        byDriver[key].driving_minutes += r.duration_minutes;
        byDriver[key].max_speed       = Math.max(byDriver[key].max_speed, r.max_speed);
        byDriver[key].total_avg_speed += r.avg_speed;
        byDriver[key].vehicles.add(r.device_name);
    }

    const rawRows = Object.values(byDriver).map(d => ({
        ...d,
        avg_speed: d.trips ? d.total_avg_speed / d.trips : 0,
        vehicle_count: d.vehicles.size,
        vehicle_list: [...d.vehicles].join(', '),
    }));

    const sortKey = _sortCol || 'driver';
    const rows = rawRows.sort((a, b) => {
        const av = a[sortKey] ?? '', bv = b[sortKey] ?? '';
        return typeof av === 'number' ? (av - bv) * _sortDir : String(av).localeCompare(String(bv)) * _sortDir;
    });

    const head   = document.getElementById('reportHead');
    const tbody  = document.getElementById('reportBody');
    const sumBar = document.getElementById('summaryBar');

    head.innerHTML = `<tr>
        ${_th('driver','Driver')}
        ${_th('trips','Trips')}
        ${_th('distance_km','Distance (km)')}
        ${_th('driving_minutes','Drive Time')}
        ${_th('avg_speed','Avg Speed')}
        ${_th('max_speed','Top Speed')}
        ${_th('vehicle_count','Vehicles')}
    </tr>`;

    const totalTrips = rows.reduce((s, r) => s + r.trips, 0);
    const totalDist  = rows.reduce((s, r) => s + r.distance_km, 0);
    const totalMins  = rows.reduce((s, r) => s + r.driving_minutes, 0);
    const topSpeed   = rows.length ? Math.max(...rows.map(r => r.max_speed)) : 0;

    sumBar.innerHTML = `
        <div class="summary-card"><div class="val">${rows.length}</div><div class="lbl">Drivers</div></div>
        <div class="summary-card"><div class="val">${totalTrips}</div><div class="lbl">Total Trips</div></div>
        <div class="summary-card"><div class="val">${totalDist.toFixed(1)}</div><div class="lbl">Total Distance (km)</div></div>
        <div class="summary-card"><div class="val">${(totalMins/60).toFixed(1)}</div><div class="lbl">Driving Time (h)</div></div>
        <div class="summary-card"><div class="val">${topSpeed.toFixed(1)} km/h</div><div class="lbl">Top Speed</div></div>`;
    sumBar.style.display = '';

    tbody.innerHTML = rows.map(r => `<tr>
        <td>${_esc(r.driver)}</td>
        <td>${r.trips}</td>
        <td>${r.distance_km.toFixed(1)}</td>
        <td>${_fmtDuration(r.driving_minutes)}</td>
        <td>${r.avg_speed.toFixed(1)} km/h</td>
        <td>${r.max_speed.toFixed(1)} km/h</td>
        <td title="${_esc(r.vehicle_list)}">${r.vehicle_count}</td>
    </tr>`).join('') + `<tr class="total-row">
        <td>Total</td>
        <td>${totalTrips}</td>
        <td>${totalDist.toFixed(1)}</td>
        <td>${_fmtDuration(totalMins)}</td>
        <td>—</td>
        <td>${topSpeed.toFixed(1)} km/h</td>
        <td>—</td>
    </tr>`;
}

// ── Daily Activity ────────────────────────────────────────────────

function _renderDaily() {
    // Group trip list data by date
    const byDate = {};
    for (const r of _reportData) {
        const date = r.start_time.slice(0, 10);
        if (!byDate[date]) byDate[date] = { date, trips: 0, distance_km: 0, driving_minutes: 0 };
        byDate[date].trips++;
        byDate[date].distance_km += r.distance_km;
        byDate[date].driving_minutes += r.duration_minutes;
    }

    const sortKey = _sortCol || 'date';
    const dir = _sortCol ? _sortDir : -1;
    const rows = Object.values(byDate).sort((a, b) => {
        const av = a[sortKey] ?? '', bv = b[sortKey] ?? '';
        return typeof av === 'number' ? (av - bv) * dir : String(av).localeCompare(String(bv)) * dir;
    });

    const head  = document.getElementById('reportHead');
    const tbody = document.getElementById('reportBody');
    const sumBar = document.getElementById('summaryBar');

    head.innerHTML = `<tr>
        ${_th('date','Date')}
        ${_th('trips','Trips')}
        ${_th('distance_km','Distance (km)')}
        ${_th('driving_minutes','Drive Time')}
    </tr>`;

    const totalTrips = rows.reduce((s, r) => s + r.trips, 0);
    const totalDist  = rows.reduce((s, r) => s + r.distance_km, 0);
    const totalMins  = rows.reduce((s, r) => s + r.driving_minutes, 0);

    sumBar.innerHTML = `
        <div class="summary-card"><div class="val">${rows.length}</div><div class="lbl">Days</div></div>
        <div class="summary-card"><div class="val">${totalTrips}</div><div class="lbl">Total Trips</div></div>
        <div class="summary-card"><div class="val">${totalDist.toFixed(1)}</div><div class="lbl">Total Distance (km)</div></div>
        <div class="summary-card"><div class="val">${(totalMins/60).toFixed(1)}</div><div class="lbl">Driving Time (h)</div></div>`;
    sumBar.style.display = '';

    tbody.innerHTML = rows.map(r => `<tr>
        <td>${_esc(r.date)}</td>
        <td>${r.trips}</td>
        <td>${r.distance_km.toFixed(1)}</td>
        <td>${_fmtDuration(r.driving_minutes)}</td>
    </tr>`).join('') + `<tr class="total-row">
        <td>Total</td>
        <td>${totalTrips}</td>
        <td>${totalDist.toFixed(1)}</td>
        <td>${_fmtDuration(totalMins)}</td>
    </tr>`;
}

// ── Sorting ───────────────────────────────────────────────────────

function sortReport(col) {
    if (_sortCol === col) _sortDir *= -1;
    else { _sortCol = col; _sortDir = 1; }
    const type = document.getElementById('reportType').value;
    if (type === 'sensors') {
        _sensorsHistoryMode ? _renderSensorsHistory() : _renderSensors();
    } else if (type === 'alerts') {
        _renderAlerts();
    } else {
        _renderReport();
    }
}

// ── Vehicle Sensors ───────────────────────────────────────────────

function _renderSensors() {
    const table  = document.getElementById('reportTable');
    const head   = document.getElementById('reportHead');
    const tbody  = document.getElementById('reportBody');
    const noData = document.getElementById('noData');
    const expBtn = document.getElementById('exportCsvBtn');
    const sumBar = document.getElementById('summaryBar');

    sumBar.style.display = 'none';

    if (!_reportData.length) {
        table.style.display = 'none';
        noData.style.display = '';
        expBtn.style.display = 'none';
        return;
    }

    // Fixed state fields (mapped to actual API field names)
    const STD_FIELDS = [
        { key: 'ignition_on',  label: 'Ignition',    type: 'bool_ign' },
        { key: 'last_speed',   label: 'Speed',        type: 'speed'    },
        { key: 'last_altitude',label: 'Altitude',     type: 'altitude' },
    ];
    const activeStd = STD_FIELDS.filter(f =>
        _reportData.some(d => d.state?.[f.key] != null)
    );

    // Dynamic sensor keys from state.sensors dict — only those with at least one value
    const sensorKeys = [];
    for (const d of _reportData) {
        for (const k of Object.keys(d.state?.sensors || {})) {
            if (!sensorKeys.includes(k)) sensorKeys.push(k);
        }
    }
    sensorKeys.sort();

    // Sort rows
    const sortCol = _sortCol || 'name';
    const sortDir = _sortCol ? _sortDir : 1;
    const rows = [..._reportData].sort((a, b) => {
        let av, bv;
        if (sortCol === 'name' || sortCol === 'license_plate') {
            av = a[sortCol] ?? ''; bv = b[sortCol] ?? '';
        } else if (sortCol === 'current_driver_name') {
            av = a.state?.current_driver_name ?? ''; bv = b.state?.current_driver_name ?? '';
        } else if (sortCol === 'last_update') {
            av = a.state?.last_update ?? ''; bv = b.state?.last_update ?? '';
        } else {
            av = a.state?.[sortCol] ?? ''; bv = b.state?.[sortCol] ?? '';
        }
        return typeof av === 'number' ? (av - bv) * sortDir : String(av).localeCompare(String(bv)) * sortDir;
    });

    head.innerHTML = `<tr>
        ${_th('name', 'Vehicle')}
        ${_th('license_plate', 'Plate')}
        ${_th('current_driver_name', 'Driver')}
        ${_th('last_update', 'Last Seen')}
        ${activeStd.map(f => _th(f.key, f.label)).join('')}
        ${sensorKeys.map(k => `<th>${_esc(k)}</th>`).join('')}
    </tr>`;

    tbody.innerHTML = rows.map(d => {
        const s        = d.state || {};
        const lastSeen = s.last_update ? _fmtDatetime(s.last_update) : '—';

        const stdCells = activeStd.map(f => {
            const v = s[f.key];
            if (v == null) return '<td style="color:var(--text-muted);">—</td>';
            if (f.type === 'bool_ign') {
                const color = v ? 'var(--accent-success)' : 'var(--text-muted)';
                return `<td style="color:${color};">${v ? 'On' : 'Off'}</td>`;
            }
            if (f.type === 'speed')    return `<td style="font-family:var(--font-mono);">${parseFloat(v).toFixed(1)} km/h</td>`;
            if (f.type === 'altitude') return `<td style="font-family:var(--font-mono);">${parseFloat(v).toFixed(0)} m</td>`;
            return `<td style="font-family:var(--font-mono);">${_esc(String(v))}</td>`;
        }).join('');

        const sensorCells = sensorKeys.map(k => {
            const v = s.sensors?.[k];
            if (v == null) return '<td style="color:var(--text-muted);">—</td>';
            if (typeof v === 'boolean') {
                const color = v ? 'var(--accent-success)' : 'var(--text-muted)';
                return `<td style="color:${color};">${v ? 'On' : 'Off'}</td>`;
            }
            return `<td style="font-family:var(--font-mono);font-size:0.82rem;">${_esc(String(v))}</td>`;
        }).join('');

        return `<tr>
            <td><strong>${_esc(d.name)}</strong></td>
            <td style="color:var(--text-secondary);">${_esc(d.license_plate || '—')}</td>
            <td style="color:var(--text-secondary);">${_esc(s.current_driver_name || '—')}</td>
            <td style="white-space:nowrap;color:var(--text-secondary);">${lastSeen}</td>
            ${stdCells}${sensorCells}
        </tr>`;
    }).join('');

    table.style.display = '';
    noData.style.display = 'none';
    expBtn.style.display = '';
}

// ── Vehicle Sensors (Historical) ──────────────────────────────────

function _renderSensorsHistory() {
    const table  = document.getElementById('reportTable');
    const head   = document.getElementById('reportHead');
    const tbody  = document.getElementById('reportBody');
    const noData = document.getElementById('noData');
    const expBtn = document.getElementById('exportCsvBtn');
    const sumBar = document.getElementById('summaryBar');

    sumBar.style.display = 'none';

    if (!_reportData.length) {
        table.style.display = 'none';
        noData.style.display = '';
        expBtn.style.display = 'none';
        return;
    }

    // Collect all sensor keys across all position rows
    const sensorKeys = [];
    for (const p of _reportData) {
        for (const k of Object.keys(p.sensors || {})) {
            if (!sensorKeys.includes(k)) sensorKeys.push(k);
        }
    }
    sensorKeys.sort();

    // Sort rows — default: time descending
    const sortCol = _sortCol || 'time';
    const sortDir = _sortCol ? _sortDir : -1;
    const rows = [..._reportData].sort((a, b) => {
        const av = sortCol === 'vehicle' ? (a._device?.name ?? '') : (a[sortCol] ?? '');
        const bv = sortCol === 'vehicle' ? (b._device?.name ?? '') : (b[sortCol] ?? '');
        return typeof av === 'number' ? (av - bv) * sortDir : String(av).localeCompare(String(bv)) * sortDir;
    });

    head.innerHTML = `<tr>
        ${_th('vehicle', 'Vehicle')}
        ${_th('time', 'Time')}
        ${_th('ignition', 'Ignition')}
        ${_th('speed', 'Speed')}
        ${_th('altitude', 'Altitude')}
        ${sensorKeys.map(k => `<th>${_esc(k)}</th>`).join('')}
    </tr>`;

    tbody.innerHTML = rows.map(p => {
        const ign = p.ignition;
        const ignCell = ign != null
            ? `<td style="color:${ign ? 'var(--accent-success)' : 'var(--text-muted)'};">${ign ? 'On' : 'Off'}</td>`
            : '<td style="color:var(--text-muted);">—</td>';

        const sensorCells = sensorKeys.map(k => {
            const v = p.sensors?.[k];
            if (v == null) return '<td style="color:var(--text-muted);">—</td>';
            if (typeof v === 'boolean') {
                return `<td style="color:${v ? 'var(--accent-success)' : 'var(--text-muted)'};">${v ? 'On' : 'Off'}</td>`;
            }
            return `<td style="font-family:var(--font-mono);font-size:0.82rem;">${_esc(String(v))}</td>`;
        }).join('');

        return `<tr>
            <td><strong>${_esc(p._device.name)}</strong></td>
            <td style="white-space:nowrap;font-family:var(--font-mono);font-size:0.82rem;">${_fmtDatetime(p.time)}</td>
            ${ignCell}
            <td style="font-family:var(--font-mono);">${p.speed != null ? parseFloat(p.speed).toFixed(1) + ' km/h' : '—'}</td>
            <td style="font-family:var(--font-mono);">${p.altitude != null ? parseFloat(p.altitude).toFixed(0) + ' m' : '—'}</td>
            ${sensorCells}
        </tr>`;
    }).join('');

    table.style.display = '';
    noData.style.display = 'none';
    expBtn.style.display = '';
}

function _th(col, label) {
    const active = _sortCol === col;
    const arrow  = active ? (_sortDir === 1 ? ' ▲' : ' ▼') : '';
    return `<th onclick="sortReport('${col}')">${label}<span class="sort-arrow">${arrow}</span></th>`;
}

function _sortedRows(data, defaultCol, defaultDir = 1) {
    const col = _sortCol || defaultCol;
    const dir = _sortCol ? _sortDir : defaultDir;
    return [...data].sort((a, b) => {
        const av = a[col] ?? '', bv = b[col] ?? '';
        return typeof av === 'number' ? (av - bv) * dir : String(av).localeCompare(String(bv)) * dir;
    });
}

// ── CSV export ────────────────────────────────────────────────────

async function exportCsv() {
    const type  = document.getElementById('reportType').value;

    if (type === 'alerts') {
        const start   = document.getElementById('startDate').value;
        const end     = document.getElementById('endDate').value;
        const headers = _CAN_SEE_USERS
            ? ['Date/Time', 'User', 'Vehicle', 'Type', 'Severity', 'Message', 'Status']
            : ['Date/Time', 'Vehicle', 'Type', 'Severity', 'Message', 'Status'];
        const rowFn = r => _CAN_SEE_USERS
            ? [_fmtDatetime(r.created_at), r.username || '', r.device_name || '', r.alert_type, r.severity, r.message, r.is_read ? 'Read' : 'Unread']
            : [_fmtDatetime(r.created_at), r.device_name || '', r.alert_type, r.severity, r.message, r.is_read ? 'Read' : 'Unread'];
        _downloadCsv(headers, _sortedRows(_reportData, 'created_at', -1), rowFn, `alerts_${start}_${end}.csv`);
        return;
    }

    if (type === 'sensors') {
        if (_sensorsHistoryMode) {
            const sensorKeys = [];
            for (const p of _reportData) for (const k of Object.keys(p.sensors || {})) if (!sensorKeys.includes(k)) sensorKeys.push(k);
            sensorKeys.sort();
            const headers = ['Vehicle', 'Time', 'Ignition', 'Speed (km/h)', 'Altitude (m)', ...sensorKeys];
            const rowFn = p => [
                p._device.name,
                p.time ? _fmtDatetime(p.time) : '',
                p.ignition != null ? (p.ignition ? 'On' : 'Off') : '',
                p.speed    != null ? parseFloat(p.speed).toFixed(1) : '',
                p.altitude != null ? parseFloat(p.altitude).toFixed(0) : '',
                ...sensorKeys.map(k => p.sensors?.[k] != null ? String(p.sensors[k]) : ''),
            ];
            const start = document.getElementById('startDate').value;
            const end   = document.getElementById('endDate').value;
            _downloadCsv(headers, _reportData, rowFn, `vehicle_sensors_history_${start}_${end}.csv`);
            return;
        }
        const STD_FIELDS = [
            { key: 'ignition_on', label: 'Ignition' },
            { key: 'last_speed',  label: 'Speed' },
            { key: 'last_altitude', label: 'Altitude' },
        ];
        const activeStd = STD_FIELDS.filter(f => _reportData.some(d => d.state?.[f.key] != null));
        const sensorKeys = [];
        for (const d of _reportData) for (const k of Object.keys(d.state?.sensors || {})) if (!sensorKeys.includes(k)) sensorKeys.push(k);
        sensorKeys.sort();
        const headers = ['Vehicle', 'Plate', 'Driver', 'Last Seen', ...activeStd.map(f => f.label), ...sensorKeys];
        const rowFn = d => {
            const s = d.state || {};
            return [
                d.name, d.license_plate || '', s.current_driver_name || '',
                s.last_update ? _fmtDatetime(s.last_update) : '',
                ...activeStd.map(f => s[f.key] != null ? String(s[f.key]) : ''),
                ...sensorKeys.map(k => s.sensors?.[k] != null ? String(s.sensors[k]) : ''),
            ];
        };
        _downloadCsv(headers, _reportData, rowFn, `vehicle_sensors_${_fmtDate(new Date())}.csv`);
        return;
    }

    const start = document.getElementById('startDate').value;
    const end   = document.getElementById('endDate').value;
    const deviceParam = _selectedIds.size ? `&device_ids=${[..._selectedIds].join(',')}` : '';

    if (type === 'summary') {
        const url = `${API_BASE}/reports/fleet/csv?start_date=${start}T00:00:00&end_date=${end}T23:59:59${deviceParam}`;
        const res = await apiFetch(url);
        if (!res.ok) return;
        const blob = await res.blob();
        _downloadBlob(blob, `fleet_summary_${start}_${end}.csv`);
        return;
    }

    // Client-side CSV for trip list and daily
    let headers, rowFn;
    if (type === 'drivers') {
        const byDriver = {};
        for (const r of _reportData) {
            if (!r.driver_name) continue;
            const key = r.driver_name;
            if (!byDriver[key]) byDriver[key] = { driver: key, trips: 0, distance_km: 0, driving_minutes: 0, max_speed: 0, total_avg: 0, vehicles: new Set() };
            byDriver[key].trips++; byDriver[key].distance_km += r.distance_km;
            byDriver[key].driving_minutes += r.duration_minutes;
            byDriver[key].max_speed = Math.max(byDriver[key].max_speed, r.max_speed);
            byDriver[key].total_avg += r.avg_speed;
            byDriver[key].vehicles.add(r.device_name);
        }
        headers = ['Driver','Trips','Distance (km)','Drive Time (min)','Avg Speed (km/h)','Top Speed (km/h)','Vehicles'];
        const driverRows = Object.values(byDriver).map(d => ({ ...d, avg_speed: d.trips ? d.total_avg / d.trips : 0, vehicle_list: [...d.vehicles].join('; ') }));
        rowFn = r => [r.driver, r.trips, r.distance_km.toFixed(2), r.driving_minutes.toFixed(1), r.avg_speed.toFixed(1), r.max_speed.toFixed(1), r.vehicle_list];
        _downloadCsv(headers, driverRows, rowFn, `driver_activity_${start}_${end}.csv`);
        return;
    } else if (type === 'trips') {
        headers = ['Date','Vehicle','Plate','Driver','From','To','Distance (km)','Duration (min)','Avg Speed (km/h)','Top Speed (km/h)'];
        rowFn = r => [_fmtDatetime(r.start_time), r.device_name, r.license_plate||'', r.driver_name||'', r.start_address||'', r.end_address||'',
                      r.distance_km.toFixed(2), r.duration_minutes.toFixed(1), r.avg_speed.toFixed(1), r.max_speed.toFixed(1)];
    } else {
        headers = ['Date','Trips','Distance (km)','Drive Time (min)'];
        const byDate = {};
        for (const r of _reportData) {
            const d = r.start_time.slice(0,10);
            if (!byDate[d]) byDate[d] = { date: d, trips: 0, distance_km: 0, driving_minutes: 0 };
            byDate[d].trips++; byDate[d].distance_km += r.distance_km; byDate[d].driving_minutes += r.duration_minutes;
        }
        rowFn = r => [r.date, r.trips, r.distance_km.toFixed(2), r.driving_minutes.toFixed(1)];
        const rows = Object.values(byDate).sort((a,b) => a.date.localeCompare(b.date));
        _downloadCsv(headers, rows, rowFn, `fleet_daily_${start}_${end}.csv`);
        return;
    }
    _downloadCsv(headers, _reportData, rowFn, `fleet_trips_${start}_${end}.csv`);
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
    _reportData = data.rows || [];
    _sortCol    = null;
    _sortDir    = 1;

    if (reportType === 'sensors') {
        _sensorsHistoryMode = !!data.historical;
        if (_sensorsHistoryMode) _renderSensorsHistory(); else _renderSensors();
        return;
    }
    if (reportType === 'alerts') { _renderAlerts(); return; }

    // summary / trips / daily / drivers
    const table  = document.getElementById('reportTable');
    const noData = document.getElementById('noData');
    if (!_reportData.length) {
        table.style.display = 'none'; noData.style.display = '';
        document.getElementById('summaryBar').style.display = 'none';
        return;
    }
    if      (reportType === 'summary') _renderSummary();
    else if (reportType === 'trips')   _renderTripList();
    else if (reportType === 'daily')   _renderDaily();
    else if (reportType === 'drivers') _renderDrivers();
    table.style.display  = '';
    noData.style.display = 'none';
}

function exportCsvFromRun() {
    if (!_viewingRunData) return;
    const { reportType, scheduleName, runAt, data } = _viewingRunData;
    const slug = scheduleName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
    const date = runAt.slice(0, 10);

    if (reportType === 'summary') {
        const rows = data.rows || [];
        _downloadCsv(
            ['Vehicle', 'Plate', 'Driver', 'Trips', 'Distance (km)', 'Driving (min)', 'Max Speed (km/h)', 'Avg Speed (km/h)'],
            rows,
            r => [r.device_name, r.license_plate || '', r.driver_name || '', r.trips,
                  r.distance_km, r.driving_minutes, r.max_speed, r.avg_speed],
            `${slug}_${date}.csv`
        );
        return;
    }
    // For other types, delegate to normal exportCsv which uses _reportData
    exportCsv();
}

// ══════════════════════════════════════════════════════════════════════════════
// Schedules list
// ══════════════════════════════════════════════════════════════════════════════

const _TYPE_LABELS  = { summary: 'Fleet Summary', trips: 'Trip List', daily: 'Daily Activity', drivers: 'Driver Activity', sensors: 'Vehicle Sensors', alerts: 'Alerts' };
const _RANGE_LABELS = { last_7_days: 'Last 7 days', last_14_days: 'Last 14 days', last_30_days: 'Last 30 days', last_calendar_month: 'Last calendar month', last_quarter: 'Last quarter', last_year: 'Last year' };
const _DOW          = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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
            (_TYPE_LABELS[s.report_type] || s.report_type).toLowerCase().includes(q) ||
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
        else if (col === 'type')      { av = _TYPE_LABELS[a.report_type] || '';   bv = _TYPE_LABELS[b.report_type] || ''; }
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
        const typeStr = _TYPE_LABELS[s.report_type] || s.report_type;
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
        document.getElementById('sfType').value        = 'summary';
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
    const isSens = t === 'sensors';
    const isAlt  = t === 'alerts';

    document.getElementById('sfHistGroup').style.display  = isSens ? '' : 'none';
    document.getElementById('sfUserGroup').style.display  = (isAlt && _CAN_SEE_USERS) ? '' : 'none';

    // Date range: hidden for sensors when not in historical mode
    const needsRange = !isSens || document.getElementById('sfHistorical').checked;
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

    const needsRange = rtype !== 'sensors' || historical;
    if (needsRange && !dateRange) { showAlert('Date range is required.', 'warning'); return; }

    const body = {
        name,
        report_type:        rtype,
        filter_device_ids:  [..._sfSelectedVehIds],
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
