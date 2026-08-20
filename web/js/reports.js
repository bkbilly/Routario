'use strict';

let _reportData          = [];
let _reportPayload       = null;
let _lastReportPdfUrl    = null;
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
let _reportRenderToken   = 0;
let _healthRows          = [];
let _healthSort          = { col: 'name', dir: 'asc' };
let _runtimeLogRows      = [];
let _runtimeLogCounts    = {};
let _runtimeLogLevelFilter = '';
let _runtimeLogWs        = null;
let _runtimeLogReconnect = null;
let _billingDetail       = null;
let _billingDetailPdfUrl = null;
let _selectedBillingKey  = null;
let _sfControlValues     = {};
let _notificationChannels = [];
let _scheduleTriggerDefs = [];
let _scheduleTriggerMap  = {};
let _sfTriggerOptions    = {};
let _scheduleGeofenceOptions = null;
let _lastScheduleTrigger = null;
let _scheduleTriggerRenderToken = 0;
const _REPORT_TABS = [
    { name: 'reports', panelId: 'panelReports', tabId: 'tabReports' },
    { name: 'schedules', panelId: 'panelSchedules', tabId: 'tabSchedules' },
    { name: 'health', panelId: 'panelHealth', tabId: 'tabHealth' },
    { name: 'logs', panelId: 'panelLogs', tabId: 'tabLogs' },
];

const _IS_ADMIN         = localStorage.getItem('is_admin') === 'true';
const _IS_COMPANY_ADMIN = localStorage.getItem('is_company_admin') === 'true';
const _CAN_SEE_USERS    = _IS_ADMIN || _IS_COMPANY_ADMIN;
const _CAN_SEE_LOGS     = _IS_ADMIN;

document.addEventListener('DOMContentLoaded', async () => {
    checkLogin();
    await permissionsReady;
    if (!hasPermission('view_reports') && !hasPermission('view_health') && !_CAN_SEE_LOGS) {
        window.location.href = 'gps-dashboard.html';
        return;
    }

    document.getElementById('tabReports').style.display = hasPermission('view_reports') ? '' : 'none';
    document.getElementById('tabSchedules').style.display = hasPermission('view_reports') ? '' : 'none';
    document.getElementById('tabHealth').style.display = hasPermission('view_health') ? '' : 'none';
    document.getElementById('tabLogs').style.display = _CAN_SEE_LOGS ? '' : 'none';

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
        await _loadScheduleTriggers();
        _updateDescription();
    }
    _injectNavScheduleAction();
    const hash = RoutarioTabs.hashValue();
    switchTab(_validReportTab(hash) ? hash : hasPermission('view_reports') ? 'reports' : hasPermission('view_health') ? 'health' : 'logs', false);

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

document.addEventListener('input', e => {
    if (e.target?.closest?.('#schedModal')) _clearScheduleValidation();
});

document.addEventListener('change', e => {
    if (e.target?.closest?.('#schedModal')) _clearScheduleValidation();
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
        if (!res.ok) return;
        _reportDefs = await res.json();

        // Add AI Custom Report definition if user has llm permission
        try {
            const perms = JSON.parse(localStorage.getItem('user_permissions') || '[]');
            const isAdmin = localStorage.getItem('is_admin') === 'true';
            if (isAdmin || perms.includes('llm')) {
                _reportDefs.push({
                    key: 'ai_custom',
                    label: '✨ AI Custom Report',
                    description: 'Generate an AI-driven customized analytics report using your specified query prompt.',
                    supports_vehicle_filter: true,
                    needs_date_range: true,
                });
            }
        } catch (err) {}

        _reportDefMap = Object.fromEntries(_reportDefs.map(d => [d.key, d]));
        _populateReportSelect('reportType', _reportDefs);
        _populateReportSelect('sfType', _reportDefs.filter(d => d.schedule_supported !== false));
        _syncReportFilters();
        _updateDescription();
    } catch (e) {
        console.error(e);
        _reportDefs = [];
        showAlert('Failed to load report types.', 'error');
    }
    _populateReportSelect('reportType', _reportDefs);
    _populateReportSelect('sfType', _reportDefs.filter(d => d.schedule_supported !== false));
    _syncReportFilters();
}

async function _loadScheduleTriggers() {
    try {
        const res = await apiFetch(`${API_BASE}/report-schedules/triggers`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        _scheduleTriggerDefs = await res.json();
    } catch (e) {
        console.error(e);
        _scheduleTriggerDefs = [];
        showAlert('Failed to load schedule triggers.', 'error');
    }
    _scheduleTriggerMap = Object.fromEntries(_scheduleTriggerDefs.map(d => [d.value, d]));
    _populateScheduleTriggerSelect();
}

function _populateScheduleTriggerSelect() {
    const select = document.getElementById('sfTriggerType');
    if (!select) return;
    const current = select.value || 'time';
    select.disabled = !_scheduleTriggerDefs.length;
    const grouped = _scheduleTriggerDefs.reduce((acc, d) => {
        const label = d.source === 'alert' ? 'Alerts' : d.source === 'route' ? 'Routes' : 'Schedule';
        (acc[label] ||= []).push(d);
        return acc;
    }, {});
    select.innerHTML = _scheduleTriggerDefs.length
        ? Object.entries(grouped).map(([label, defs]) =>
            `<optgroup label="${_esc(label)}">${
                defs.map(d => `<option value="${_esc(d.value)}">${_esc(`${d.icon || ''} ${d.label}`.trim())}</option>`).join('')
            }</optgroup>`
        ).join('')
        : '<option value="">Triggers unavailable</option>';
    if (_scheduleTriggerDefs.some(d => d.value === current)) select.value = current;
    else if (_scheduleTriggerDefs.some(d => d.value === 'time')) select.value = 'time';
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

    const aiGroup = document.getElementById('aiReportPromptGroup');
    if (aiGroup) aiGroup.style.display = (type === 'ai_custom') ? '' : 'none';

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

function _getReportControlValues() {
    const values = {};
    document.querySelectorAll('.report-control').forEach(el => {
        values[el.dataset.key] = el.value;
    });
    return values;
}

function _getReportControlValue(key) {
    const el = document.querySelector(`.report-control[data-key="${CSS.escape(key)}"]`);
    return el ? el.value : undefined;
}

function _cleanMarkdownFromText(str) {
    if (!str) return '';
    return str.replace(/\*\*(.*?)\*\*/g, '$1')
              .replace(/\*(.*?)\*/g, '$1')
              .replace(/`(.*?)`/g, '$1');
}

function _parseMarkdownTablesToReportPayload(text) {
    if (!text) return null;
    const lines = text.split('\n');
    let tableRows = [];

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (line.startsWith('|') && line.endsWith('|')) {
            if (line.replace(/[\s|:-]/g, '') === '') continue;
            let cells = line.split('|').slice(1, -1).map(c => c.trim());
            tableRows.push(cells);
        }
    }

    if (tableRows.length < 2) return null;

    const headers = tableRows[0];
    const dataRows = tableRows.slice(1);

    const columns = headers.map((h, idx) => ({
        key: `col_${idx}`,
        label: _cleanMarkdownFromText(h) || `Column ${idx + 1}`
    }));

    const rows = dataRows.map(row => {
        const rowObj = {};
        columns.forEach((col, idx) => {
            rowObj[col.key] = row[idx] !== undefined ? _cleanMarkdownFromText(row[idx]) : '';
        });
        return rowObj;
    });

    return { columns, rows };
}

function _formatAiTableCellContent(str) {
    if (!str) return '';
    let html = _esc(str);
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/`(.*?)`/g, '<code style="background:var(--bg-secondary);padding:2px 4px;border-radius:3px;font-family:monospace;font-size:0.85em;">$1</code>');
    return html;
}

let _aiReportTableCache = [];
function _buildAiReportHtmlTable(rows) {
    if (!rows.length) return '';
    let header = rows[0];
    let body = rows.slice(1);

    let ths = header.map(h => `<th style="padding:0.6rem 0.85rem;border:1px solid var(--border-color);background:var(--bg-secondary);text-align:left;font-weight:600;font-size:0.85rem;">${_formatAiTableCellContent(h)}</th>`).join('');
    let trs = body.map(row => {
        let tds = row.map(c => `<td style="padding:0.5rem 0.85rem;border:1px solid var(--border-color);font-size:0.86rem;">${_formatAiTableCellContent(c)}</td>`).join('');
        return `<tr>${tds}</tr>`;
    }).join('');

    let tableHtml = `<div style="overflow-x:auto;margin:1rem 0;"><table style="width:100%;border-collapse:collapse;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-card);"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;
    let key = `__AI_REPORT_TABLE_${_aiReportTableCache.length}__`;
    _aiReportTableCache.push(tableHtml);
    return key;
}

function _renderAiReportMarkdown(reportText) {
    const table = document.getElementById('reportTable');
    const noData = document.getElementById('noData');
    const summary = document.getElementById('summaryBar');
    const exportWrap = document.getElementById('exportMenuWrap');
    const card = document.getElementById('aiReportResultCard');

    if (noData) noData.style.display = 'none';
    if (summary) summary.style.display = 'none';

    const parsedPayload = _parseMarkdownTablesToReportPayload(reportText);

    if (parsedPayload && parsedPayload.rows.length > 0) {
        _reportPayload = {
            columns: parsedPayload.columns,
            rows: parsedPayload.rows,
            type: 'ai_custom',
            csv_filename: 'ai_custom_report.csv'
        };
        _reportData = parsedPayload.rows;
        _viewingRunData = true;
        _renderReport();
    } else {
        if (table) table.style.display = 'none';
        if (exportWrap) exportWrap.style.display = 'none';
    }

    _aiReportTableCache = [];
    let lines = (reportText || '').split('\n');
    let out = [];
    let inTable = false;
    let tableRows = [];

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (line.startsWith('|') && line.endsWith('|')) {
            if (line.replace(/[\s|:-]/g, '') === '') {
                continue;
            }
            inTable = true;
            let cells = line.split('|').slice(1, -1).map(c => c.trim());
            tableRows.push(cells);
        } else {
            if (inTable) {
                out.push(_buildAiReportHtmlTable(tableRows));
                inTable = false;
                tableRows = [];
            }
            out.push(line);
        }
    }
    if (inTable && tableRows.length) {
        out.push(_buildAiReportHtmlTable(tableRows));
    }

    let html = out.join('\n');
    html = _esc(html);

    // Headers
    html = html.replace(/^### (.*$)/gim, '<h3 style="font-size:1.1rem;color:var(--accent-primary);margin-top:1.25rem;margin-bottom:0.5rem;">$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2 style="font-size:1.25rem;color:var(--text-primary);margin-top:1.5rem;margin-bottom:0.75rem;border-bottom:1px solid var(--border-color);padding-bottom:0.4rem;">$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1 style="font-size:1.4rem;color:var(--text-primary);margin-bottom:1rem;">$1</h1>');

    // Bold & Italics
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

    // Bullet points
    html = html.replace(/^\s*-\s+(.*$)/gim, '• $1<br>');

    // Code blocks
    html = html.replace(/`(.*?)`/g, '<code style="background:var(--bg-secondary);padding:2px 5px;border-radius:4px;font-family:monospace;font-size:0.85em;">$1</code>');

    // Restore table placeholders
    html = html.replace(/__AI_REPORT_TABLE_(\d+)__/g, (match, idx) => {
        return _aiReportTableCache[idx] || '';
    });

    // Clean up newlines around block-level HTML elements
    html = html.replace(/\n?(<\/?(h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|div|hr)[^>]*>)\n?/gi, '$1');
    html = html.replace(/\n+/g, '<br>');

    if (card) {
        card.style.display = '';
        card.innerHTML = `
            <div style="background:var(--bg-card);border:1px solid var(--border-color);border-radius:12px;padding:1.75rem 2.25rem;text-align:left;max-width:960px;margin:0 auto;line-height:1.6;font-size:0.92rem;color:var(--text-primary);box-shadow:0 4px 12px rgba(0,0,0,0.05);">
                <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:1rem;color:var(--accent-primary);font-weight:600;font-size:0.95rem;">
                    <i class="mdi mdi-sparkles"></i> AI Fleet Custom Analysis & Recommendations
                </div>
                ${html}
            </div>
        `;
    }
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
    _lastReportPdfUrl = null;
    _selectedBillingKey = null;
    _billingDetail = null;
    _billingDetailPdfUrl = null;
    _sensorsHistoryMode = false;
    document.getElementById('reportTable').style.display = 'none';
    document.getElementById('noData').style.display = 'none';
    const card = document.getElementById('aiReportResultCard');
    if (card) card.style.display = 'none';
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
    _lastReportPdfUrl = null;
    _selectedBillingKey = null;
    _billingDetail = null;
    _billingDetailPdfUrl = null;
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

    if (type === 'ai_custom') {
        const prompt = document.getElementById('aiReportPrompt')?.value.trim();
        if (!prompt) { showAlert('Please enter an AI Report Prompt.', 'warning'); return; }
        const card = document.getElementById('aiReportResultCard');
        const noData = document.getElementById('noData');
        const table = document.getElementById('reportTable');
        const summary = document.getElementById('summaryBar');
        const exportWrap = document.getElementById('exportMenuWrap');

        if (table) table.style.display = 'none';
        if (noData) noData.style.display = 'none';
        if (summary) summary.style.display = 'none';
        if (exportWrap) exportWrap.style.display = 'none';
        if (card) card.style.display = 'none';

        try {
            _setReportLoading(true);
            await _nextFrame();
            const res = await apiFetch(`${API_BASE}/llm/report`, {
                method: 'POST',
                body: JSON.stringify({
                    prompt: prompt,
                    device_ids: _selectedIds.size ? [..._selectedIds] : null,
                    start_time: start ? `${start}T00:00:00` : null,
                    end_time: end ? `${end}T23:59:59` : null,
                }),
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.detail || `Server returned HTTP ${res.status}`);
            }
            const data = await res.json();
            _renderAiReportMarkdown(data.report);
        } catch (e) {
            console.error('AI Report Error:', e);
            showAlert(e.message || 'Error generating AI report.', 'error');
            if (card) {
                card.style.display = '';
                card.innerHTML = `
                    <div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);border-radius:12px;padding:1.5rem 2rem;max-width:850px;margin:0 auto;text-align:center;color:var(--accent-danger);">
                        <i class="mdi mdi-alert-circle-outline" style="font-size:2rem;display:block;margin-bottom:0.5rem;"></i>
                        <strong style="font-size:1.05rem;">AI Report Generation Failed</strong>
                        <p style="margin:0.5rem 0 0 0;font-size:0.9rem;opacity:0.9;">${_esc(e.message)}</p>
                    </div>
                `;
            }
        } finally {
            _setReportLoading(false);
        }
        return;
    }
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
    const pdfEndpoint = `${API_BASE}/reports/${encodeURIComponent(type)}/pdf${params.toString() ? `?${params}` : ''}`;

    try {
        _setReportLoading(true);
        await _nextFrame();
        const res = await apiFetch(endpoint);
        if (!res.ok) { showAlert('Failed to load report.', 'error'); return; }
        const data = await res.json();
        _reportPayload = Array.isArray(data) ? { rows: data, columns: [] } : data;
        _reportData = _reportPayload.rows || [];
        if (def.supports_driver_filter) _mergeDriversFromTrips(_reportData);
        _sortCol = _reportPayload.default_sort?.key || null;
        _sortDir = _reportPayload.default_sort?.dir || 1;
        _lastReportPdfUrl = pdfEndpoint;
        await _renderReport();
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

function _nextFrame() {
    return new Promise(resolve => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
        else setTimeout(resolve, 0);
    });
}

async function _renderReport() {
    const token = ++_reportRenderToken;
    const table   = document.getElementById('reportTable');
    const noData  = document.getElementById('noData');
    const sumBar  = document.getElementById('summaryBar');
    const expWrap = document.getElementById('exportMenuWrap');
    const head    = document.getElementById('reportHead');
    const body    = document.getElementById('reportBody');
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

    await _nextFrame();
    if (token !== _reportRenderToken) return;

    const sort = _sortCol ? { key: _sortCol, dir: _sortDir } : (payload.default_sort || {});
    const rows = _sortedRowsBy(_reportData, sort.key || columns[0]?.key, sort.dir || 1);
    _tripRows = rows;

    _renderSummaryCards(payload.summary || []);
    head.innerHTML = `<tr>${columns.map(c => _th(c.key, c.label)).join('')}</tr>`;
    body.innerHTML = '';
    table.style.display = '';
    noData.style.display = 'none';
    expWrap.style.display = 'inline-flex';

    const chunkSize = rows.length > 1000 ? 100 : 250;
    for (let start = 0; start < rows.length; start += chunkSize) {
        if (token !== _reportRenderToken) return;
        body.insertAdjacentHTML(
            'beforeend',
            rows.slice(start, start + chunkSize)
                .map((row, offset) => _renderGenericRow(row, columns, payload.row_action, start + offset))
                .join('')
        );
        await _nextFrame();
    }

    if (token !== _reportRenderToken) return;
    if (payload.total_row) body.insertAdjacentHTML('beforeend', _renderTotalRow(payload.total_row, columns));
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
    const rawVal = col.title_key ? row[col.title_key] : row[col.key];
    const titleText = rawVal !== null && rawVal !== undefined && rawVal !== '' ? String(rawVal) : '';
    const title = titleText ? ` title="${_esc(titleText)}"` : '';
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
    if (col.type === 'channel_status') {
        if (!value || !Array.isArray(value) || value.length === 0) {
            return '<span style="color:var(--text-muted);font-size:0.78rem;">—</span>';
        }
        return value.map(ch => {
            const isOk = ch.status === 'sent' || ch.status === 'delivered' || ch.status === 'success';
            const icon = isOk ? 'mdi-check-circle' : 'mdi-alert-circle';
            const color = isOk ? 'var(--accent-success, #10b981)' : 'var(--accent-danger, #ef4444)';
            const titleText = ch.error ? `${ch.name}: Failed (${ch.error})` : `${ch.name}: ${ch.status}`;
            return `<span title="${_esc(titleText)}" style="display:inline-flex;align-items:center;gap:0.25rem;font-size:0.72rem;padding:0.12rem 0.4rem;border-radius:4px;background:rgba(255,255,255,0.06);color:${color};margin:0.1rem;font-weight:600;"><i class="mdi ${icon}"></i>${_esc(ch.name)}</span>`;
        }).join(' ');
    }
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
    if (_viewingRunData) {
        _exportPayloadPdf(_reportPayload, _reportData, _reportDefMap[_reportPayload.type]?.label || 'Report');
        return;
    }
    if (!_lastReportPdfUrl) {
        showAlert('Generate the report again before exporting PDF.', 'warning');
        return;
    }
    _downloadStyledReportPdf(_lastReportPdfUrl);
}

async function _downloadStyledReportPdf(url) {
    try {
        const res = await apiFetch(url);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to export PDF');
        }
        const blob = await res.blob();
        const disposition = res.headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="?([^"]+)"?/i);
        _downloadBlob(blob, match?.[1] || 'report.pdf');
    } catch (error) {
        console.error(error);
        showAlert(error.message || 'Failed to export PDF', 'error');
    }
}

async function _exportPayloadPdf(payload, data, title = 'Report') {
    const columns = (payload.columns || []).filter(c => c.csv !== false && c.hidden !== true);
    const sort = _sortCol ? { key: _sortCol, dir: _sortDir } : (payload.default_sort || {});
    const rows = _sortedRowsBy(data || [], sort.key || columns[0]?.key, sort.dir || 1);
    try {
        const res = await apiFetch(`${API_BASE}/reports/export/pdf`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title,
                report_type: payload.type || 'report',
                payload: { ...payload, rows },
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to export PDF');
        }
        const blob = await res.blob();
        const disposition = res.headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="?([^"]+)"?/i);
        _downloadBlob(blob, match?.[1] || 'report.pdf');
    } catch (error) {
        console.error(error);
        showAlert(error.message || 'Failed to export PDF', 'error');
    }
}

function _plainValue(value, col = {}) {
    if (value === null || value === undefined) return '';
    if (col.type === 'datetime' || col.type === 'datetime_split') return _fmtDatetime(value);
    if (col.type === 'duration_minutes') return String(value);
    if (col.type === 'currency_cents') return String((Number(value) || 0) / 100);
    if (col.type === 'bool_on') return value ? 'On' : 'Off';
    if (col.type === 'bool_active') return value ? 'Active' : 'Missing';
    if (col.type === 'read_status') return value ? 'Read' : 'Unread';
    if (col.type === 'channel_status') {
        if (!value || !Array.isArray(value) || value.length === 0) return '—';
        return value.map(ch => `${ch.name}: ${ch.status}`).join('; ');
    }
    if (Array.isArray(value)) return value.join('; ');
    let valStr = String(value);
    if (valStr.length >= 16 && valStr.includes('T') && /^\d{4}-\d{2}-\d{2}/.test(valStr)) {
        valStr = valStr.replace('T', ' ');
    }
    return valStr;
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
    _billingDetailPdfUrl = null;
    if (pdfBtn) pdfBtn.disabled = true;
    modal.classList.add('active');

    try {
        const params = new URLSearchParams({ company_id: String(companyId), period });
        const res = await apiFetch(`${API_BASE}/reports/billing/details?${params}`);
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        _billingDetail = await res.json();
        _billingDetailPdfUrl = `${API_BASE}/reports/billing/details/pdf?${params}`;
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

async function exportBillingDetailPdf() {
    if (!_billingDetailPdfUrl) return;
    const btn = document.getElementById('billingPdfBtn');
    const original = btn?.innerHTML;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i> Exporting';
    }
    try {
        await _downloadStyledReportPdf(_billingDetailPdfUrl);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    }
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
    const str = String(iso).replace('T', ' ');
    const d = new Date(iso);
    if (isNaN(d.getTime())) return str;
    return d.toLocaleString(undefined, { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }).replace('T', ' ');
}

function _fmtDatetimeSplit(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
        const parts = String(iso).replace('T', ' ').split(' ');
        return `<span style="display:block;">${_esc(parts[0])}</span><span style="display:block;color:var(--text-muted);">${_esc(parts[1] || '')}</span>`;
    }
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
    return ['reports', 'schedules', 'health', 'logs'].includes(tab);
}

function switchTab(tab, pushState = true) {
    if (tab === 'reports' && !hasPermission('view_reports')) tab = 'health';
    if (tab === 'schedules' && !hasPermission('view_reports')) tab = 'health';
    if (tab === 'health' && !hasPermission('view_health')) tab = 'reports';
    if (tab === 'logs' && !_CAN_SEE_LOGS) tab = hasPermission('view_reports') ? 'reports' : 'health';
    _activeTab = tab;
    RoutarioTabs.activate(_REPORT_TABS, tab);
    _injectNavScheduleAction();
    if (pushState !== false) RoutarioTabs.replaceHash(tab);
    if (tab === 'schedules') _loadSchedules();
    if (tab === 'health') loadHealth();
    if (tab === 'logs') initRuntimeLogs();
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
    if ((s.trigger_type || 'time') !== 'time') {
        const triggerKey = s.trigger_options?.alert_key;
        const def = triggerKey ? _scheduleTriggerMap[triggerKey] : _scheduleTriggerDefs.find(d => d.alert_type === s.trigger_type);
        return def ? `${def.icon || ''} ${def.label}`.trim() : s.trigger_type;
    }
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
                        <td style="white-space:nowrap;">${_fmtDatetimeSplit(r.run_at)}</td>
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

let _runtimeLogDebugMode = false;

async function fetchRuntimeLogDebugMode() {
    try {
        const res = await apiFetch(`${API_BASE}/runtime-logs/debug-mode`);
        if (res.ok) {
            const data = await res.json();
            _runtimeLogDebugMode = !!data.enabled;
            if (_activeTab === 'logs') _injectNavScheduleAction();
        }
    } catch (e) {
        console.warn('Failed to fetch debug mode status', e);
    }
}

async function toggleRuntimeLogDebugMode() {
    const nextState = !_runtimeLogDebugMode;
    try {
        const res = await apiFetch(`${API_BASE}/runtime-logs/debug-mode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: nextState })
        });
        if (res.ok) {
            const data = await res.json();
            _runtimeLogDebugMode = !!data.enabled;
            showAlert(`Debug mode ${_runtimeLogDebugMode ? 'enabled' : 'disabled'}`, 'info');
            _injectNavScheduleAction();
            await refreshRuntimeLogs();
        } else {
            const err = await res.json().catch(() => ({}));
            showAlert(err.detail || 'Failed to toggle debug mode', 'error');
        }
    } catch (e) {
        showAlert('Failed to toggle debug mode', 'error');
    }
}

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
    if (_activeTab === 'logs') {
        const debugLabel = _runtimeLogDebugMode ? 'Disable Debug Mode' : 'Enable Debug Mode';
        const debugIcon = _runtimeLogDebugMode ? 'mdi-bug' : 'mdi-bug-outline';
        el.innerHTML = `
            <button class="header-menu-item" onclick="toggleRuntimeLogDebugMode();${closeMenu}">
                <span class="header-menu-item-icon"><i class="mdi ${debugIcon}" style="font-size:15px;"></i></span>
                <span>${debugLabel}</span>
            </button>
        `;
        return;
    }
    el.innerHTML = hasPermission('view_reports') ? `<button class="header-menu-item" onclick="openScheduleModal(null);${closeMenu}">
        <span class="header-menu-item-icon"><i class="mdi mdi-calendar-plus" style="font-size:15px;"></i></span>
        <span>New Schedule</span>
    </button>` : '';
}

async function initRuntimeLogs() {
    if (!_CAN_SEE_LOGS) return;
    await fetchRuntimeLogDebugMode();
    await refreshRuntimeLogs();
    connectRuntimeLogWebSocket();
}

async function refreshRuntimeLogs() {
    const body = document.getElementById('runtimeLogTableBody');
    if (body) body.innerHTML = RoutarioTables.stateRow('Loading runtime logs...', 4);
    try {
        const res = await apiFetch(`${API_BASE}/runtime-logs?limit=1000`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        _runtimeLogRows = data.records || [];
        _runtimeLogCounts = data.counts || {};
        renderRuntimeLogs();
    } catch (e) {
        if (body) body.innerHTML = RoutarioTables.stateRow(_esc(e.message), 4);
    }
}

function connectRuntimeLogWebSocket() {
    if (!_CAN_SEE_LOGS) return;
    if (_runtimeLogWs && (_runtimeLogWs.readyState === WebSocket.OPEN || _runtimeLogWs.readyState === WebSocket.CONNECTING)) return;
    if (_runtimeLogReconnect) {
        clearTimeout(_runtimeLogReconnect);
        _runtimeLogReconnect = null;
    }
    const token = localStorage.getItem('auth_token');
    if (!token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    _runtimeLogWs = new WebSocket(`${proto}://${location.host}/api/runtime-logs/ws?token=${encodeURIComponent(token)}&limit=1000`);
    _runtimeLogWs.onmessage = event => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'runtime_log_snapshot') {
                _runtimeLogRows = data.records || [];
                _runtimeLogCounts = data.counts || {};
            } else if (data.type === 'runtime_log' && data.record) {
                _runtimeLogRows.push(data.record);
                if (_runtimeLogRows.length > 1000) _runtimeLogRows = _runtimeLogRows.slice(-1000);
                _runtimeLogCounts = data.counts || _runtimeLogCounts;
            }
            renderRuntimeLogs();
        } catch (e) {
            console.warn('Runtime log WS parse failed', e);
        }
    };
    _runtimeLogWs.onclose = () => {
        if (_activeTab !== 'logs') return;
        _runtimeLogReconnect = setTimeout(connectRuntimeLogWebSocket, 3000);
    };
}

function renderRuntimeLogs() {
    renderRuntimeLogSummary();
    const body = document.getElementById('runtimeLogTableBody');
    if (!body) return;
    const q = (document.getElementById('runtimeLogSearch')?.value || '').toLowerCase().trim();
    const level = _runtimeLogLevelFilter;
    const rows = _runtimeLogRows
        .filter(row => !level || row.level === level)
        .filter(row => {
            if (!q) return true;
            return [row.timestamp, row.level, row.logger, row.module, row.function, row.message, row.exception]
                .some(value => String(value || '').toLowerCase().includes(q));
        })
        .slice()
        .reverse();
    const count = document.getElementById('runtimeLogCount');
    if (count) {
        const levelLabel = _runtimeLogLevelLabel(level);
        count.textContent = `${rows.length} ${levelLabel ? `${levelLabel} ` : ''}log${rows.length === 1 ? '' : 's'}`;
    }
    body.innerHTML = rows.length ? rows.map(row => `
        <tr>
            <td style="white-space:nowrap;">${_logTime(row.timestamp)}</td>
            <td><span class="proto-badge health-status ${_logLevelClass(row.level)}">${_esc(row.level || '-')}</span></td>
            <td>
                <div style="font-weight:700;color:var(--text-primary);">${_esc(row.logger || '-')}</div>
                <div style="color:var(--text-muted);font-size:0.75rem;">${_esc([row.module, row.function, row.line].filter(Boolean).join(':'))}</div>
            </td>
            <td>
                <div class="runtime-log-message">${_esc(row.message || '')}</div>
                ${row.exception ? `<div class="runtime-log-exception">${_esc(row.exception)}</div>` : ''}
            </td>
        </tr>
    `).join('') : RoutarioTables.stateRow('No runtime logs match.', 4);
}

function setRuntimeLogLevelFilter(level) {
    _runtimeLogLevelFilter = level || '';
    renderRuntimeLogs();
}

function _updateRuntimeLogCountsFromRows() {
    const counts = { total: _runtimeLogRows.length, debug: 0, info: 0, warning: 0, error: 0, critical: 0 };
    for (const r of _runtimeLogRows) {
        const lvl = (r.level || '').toLowerCase();
        if (lvl in counts) counts[lvl]++;
    }
    _runtimeLogCounts = counts;
}

function renderRuntimeLogSummary() {
    const el = document.getElementById('runtimeLogSummary');
    if (!el) return;
    _updateRuntimeLogCountsFromRows();
    const items = [
        ['total', 'Total'],
        ['debug', 'Debug'],
        ['info', 'Info'],
        ['warning', 'Warnings'],
        ['error', 'Errors'],
        ['critical', 'Critical'],
    ];
    el.innerHTML = items.map(([key, label]) => `
        <button type="button"
                class="log-summary-card log-tone-${_esc(key)} ${Number(_runtimeLogCounts[key] || 0) > 0 ? 'has-logs' : ''} ${(_runtimeLogLevelFilter || 'total') === key ? 'active' : ''}"
                onclick="setRuntimeLogLevelFilter('${key === 'total' ? '' : _esc(key)}')">
            <div class="val">${Number(_runtimeLogCounts[key] || 0)}</div>
            <div class="lbl">${_esc(label)}</div>
        </button>
    `).join('');
}

function _logTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '-' : _fmtDatetimeSplit(value);
}

function _logLevelClass(level) {
    if (level === 'critical' || level === 'error') return 'health-status-fail';
    if (level === 'warning') return 'health-status-degraded';
    if (level === 'info') return 'health-status-ok';
    if (level === 'debug') return 'log-level-debug';
    return 'health-status-optional';
}

function _runtimeLogLevelLabel(level) {
    const labels = {
        debug: 'debug',
        info: 'info',
        warning: 'warning',
        error: 'error',
        critical: 'critical',
    };
    return labels[level] || '';
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
        const metrics = [..._latencyMetrics(row), ['DB', row.database_type || '-'], ['Storage', row.storage_human || '-'], ['Pool', row.pool_class || '-'], ['Pool size', row.pool_size ?? row.size ?? '-'], ['In pool', row.connections_in_pool ?? row.checkedin ?? '-'], ['Checked out', row.current_checked_out ?? row.checkedout ?? '-'], ['Overflow', row.current_overflow ?? row.overflow ?? '-']];
        return _healthBox(metrics, row.error ? [['Error', row.error]] : [], row.error ? 'danger' : '');
    }
    if (row.name === 'disk') {
        const worst = Math.max(...(row.paths || []).map(p => Number(p.used_percent) || 0), 0);
        const metrics = [
            ['Writable', row.ok ? 'yes' : 'no', row.ok ? 'ok' : 'danger'],
            ['Uploads size', row.uploads_size_human || '-'],
            ['Worst usage', `${worst}%`, worst >= 95 ? 'danger' : worst >= 85 ? 'warn' : 'ok'],
        ];
        const lines = (row.paths || []).map(p => {
            const used = p.used_percent == null ? '?' : `${p.used_percent}%`;
            const free = p.free_bytes == null ? '-' : _formatBytes(p.free_bytes);
            const folderSize = p.dir_size_human ? `, size ${p.dir_size_human}` : '';
            const state = p.ok ? (p.degraded ? 'degraded' : 'ok') : 'critical';
            const error = p.error ? `; ${p.error}` : '';
            return [p.label || p.path, `${state}${folderSize}, used ${used}, free ${free}${error}`];
        });
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
    if (row.name === 'geocoding') {
        const enabled = row.enabled !== false;
        const metrics = [['Enabled', enabled ? 'yes' : 'no', enabled ? 'ok' : 'info'], ['Provider', row.provider || 'nominatim', 'info'], ['Active', row.initialized ? 'yes' : 'no', row.initialized ? 'ok' : 'danger']];
        const lines = [['State', row.message || (enabled ? 'active' : 'disabled')]];
        return _healthBox(metrics, lines);
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
    if (row.enabled === false) return 'disabled';
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

function _defaultScheduleReportType() {
    const currentType = document.getElementById('reportType')?.value || '';
    const currentDef = _reportDefMap[currentType];
    if (currentDef && currentDef.schedule_supported !== false) return currentType;
    return _reportDefs.find(d => d.schedule_supported !== false)?.key || '';
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
    _sfTriggerOptions = schedule?.trigger_options || {};
    _lastScheduleTrigger = schedule?.trigger_type || 'time';
    _renderSfChannels(schedule?.notification_channels || []);

    if (schedule) {
        document.getElementById('sfName').value        = schedule.name;
        document.getElementById('sfType').value        = schedule.report_type;
        document.getElementById('sfHistorical').checked = schedule.sensors_historical;
        document.getElementById('sfDateRange').value   = schedule.date_range || 'last_30_days';
        document.getElementById('sfTriggerType').value  = _scheduleTriggerValue(schedule);
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
        document.getElementById('sfType').value        = _defaultScheduleReportType();
        document.getElementById('sfHistorical').checked = false;
        document.getElementById('sfDateRange').value   = 'last_30_days';
        document.getElementById('sfTriggerType').value  = 'time';
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
    await onSchedTriggerChange();
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
    _updateScheduleVehicleVisibility(def);
    _renderScheduleControls(def.schedule_controls?.length ? def.schedule_controls : (def.controls || []), current);

    // Date range: hidden for sensors when not in historical mode
    const needsRange = def.needs_date_range !== false || document.getElementById('sfHistorical').checked;
    document.getElementById('sfDateRangeGroup').style.display = needsRange ? '' : 'none';
}

function _isScheduleEventTrigger() {
    return (document.getElementById('sfTriggerType')?.value || 'time') !== 'time';
}

function _updateScheduleVehicleVisibility(def = null) {
    const reportDef = def || _reportDefMap[document.getElementById('sfType')?.value] || {};
    const group = document.getElementById('sfVehWrap')?.closest('.form-group');
    if (!group) return;
    group.style.display = _isScheduleEventTrigger() || reportDef.schedule_uses_device_filter !== false ? '' : 'none';
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
    const trigger = document.getElementById('sfTriggerType')?.value || 'time';
    const f = document.getElementById('sfFreq').value;
    document.getElementById('sfDowGroup').style.display = trigger === 'time' && f === 'weekly'  ? '' : 'none';
    document.getElementById('sfDomGroup').style.display = trigger === 'time' && f === 'monthly' ? '' : 'none';
}

async function onSchedTriggerChange() {
    const trigger = document.getElementById('sfTriggerType')?.value || 'time';
    if (_lastScheduleTrigger !== null && _lastScheduleTrigger !== trigger) {
        _sfTriggerOptions = {};
    }
    _lastScheduleTrigger = trigger;
    const isTime = trigger === 'time';
    document.querySelectorAll('.sf-time-field').forEach(el => { el.style.display = isTime ? '' : 'none'; });
    await _renderScheduleTriggerOptions(trigger);
    _updateScheduleVehicleVisibility();
    _updateSfVehLabel();
    onSchedFreqChange();
}

function _clearScheduleValidation() {
    const error = document.getElementById('schedFormError');
    if (error) {
        error.style.display = 'none';
        error.innerHTML = '';
    }
    document.querySelectorAll('#schedModal .invalid').forEach(el => el.classList.remove('invalid'));
}

function _showScheduleValidation(message, input = null) {
    const error = document.getElementById('schedFormError');
    if (error) {
        error.innerHTML = `<i class="mdi mdi-alert-circle" style="font-size:1rem;line-height:1.2;"></i><span>${_esc(message)}</span>`;
        error.style.display = 'flex';
        error.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    if (input) {
        input.classList.add('invalid');
        input.focus?.();
    }
    showAlert(message, 'warning');
}

function _selectedScheduleTrigger() {
    const trigger = document.getElementById('sfTriggerType')?.value || 'time';
    return _scheduleTriggerMap[trigger] || null;
}

function _selectedScheduleAlertDef() {
    const trigger = _selectedScheduleTrigger();
    return trigger?.source === 'alert' ? trigger : null;
}

async function _loadScheduleGeofenceOptions() {
    if (_scheduleGeofenceOptions) return _scheduleGeofenceOptions;
    try {
        const res = await apiFetch(`${API_BASE}/geofences`);
        _scheduleGeofenceOptions = res.ok
            ? (await res.json()).map(g => ({ value: String(g.id), label: g.name }))
            : [];
    } catch {
        _scheduleGeofenceOptions = [];
    }
    return _scheduleGeofenceOptions;
}

async function _patchScheduleAlertDef(def) {
    if (!def) return null;
    let fields = def.fields || [];
    if (fields.some(f => f.key === 'geofence_id')) {
        const geofenceOptions = await _loadScheduleGeofenceOptions();
        fields = fields.map(f => f.key === 'geofence_id' ? { ...f, options: geofenceOptions } : f);
    }
    if (fields.some(f => f.field_type === 'driver_select')) {
        const driverOptions = _allDrivers.map(d => ({ value: String(d.id), label: d.name }));
        fields = fields.map(f => f.field_type === 'driver_select' ? { ...f, field_type: 'select', options: driverOptions } : f);
    }
    return { ...def, fields };
}

async function _renderScheduleTriggerOptions(trigger) {
    const wrap = document.getElementById('sfTriggerOptionsGroup');
    if (!wrap) return;
    const renderToken = ++_scheduleTriggerRenderToken;
    wrap.innerHTML = '';
    const triggerDef = _scheduleTriggerMap[trigger];
    if (!triggerDef || triggerDef.source !== 'alert') {
        _sfTriggerOptions = {};
        return;
    }

    _sfTriggerOptions.alert_key = triggerDef.key || triggerDef.value;
    const def = await _patchScheduleAlertDef(triggerDef);
    if (
        renderToken !== _scheduleTriggerRenderToken ||
        (document.getElementById('sfTriggerType')?.value || 'time') !== trigger
    ) {
        return;
    }

    wrap.innerHTML = `
        ${def?.description ? `<p class="sched-trigger-description">${_esc(def.description)}</p>` : ''}
        ${_renderScheduleTriggerFields(def)}
    `;
    _bindScheduleTriggerFieldBehavior();
}

function _defaultTriggerValue(trigger, field) {
    const params = _sfTriggerOptions.params || {};
    if (params[field.key] !== undefined) return params[field.key];
    if (field.key === 'event_type' && trigger === 'geofence_enter') return 'enter';
    if (field.key === 'event_type' && trigger === 'geofence_exit') return 'exit';
    return field.default;
}

function _renderScheduleTriggerFields(def) {
    if (!def?.fields?.length) return '';
    const trigger = document.getElementById('sfTriggerType')?.value || 'time';
    return def.fields.map(f => {
        const fieldType = f.field_type || 'number';
        const v = _defaultTriggerValue(trigger, f);
        const requiredAttr = f.required ? ' required' : '';
        const metaAttrs = ` data-param-label="${_esc(f.label)}" data-param-required="${f.required ? '1' : '0'}"`;
        let input = '';
        if (fieldType === 'number') {
            const isSpeedField = f.unit === 'km/h';
            const isDistField = f.unit === 'km';
            const displayVal = v == null ? '' : isSpeedField ? toDisplaySpeed(v) : isDistField ? toDisplayDist(v) : v;
            const displayUnit = isSpeedField ? speedUnit() : isDistField ? distUnit() : (f.unit || '');
            const unitAttr = isSpeedField ? 'data-unit-type="speed"' : isDistField ? 'data-unit-type="dist"' : '';
            input = `<div style="display:flex;align-items:center;gap:0.75rem;">
                <input type="number" class="form-input schedule-trigger-param" data-param-key="${_esc(f.key)}" ${metaAttrs} ${unitAttr}${requiredAttr}
                       value="${_esc(displayVal ?? '')}"
                       ${f.min_value != null ? `min="${_esc(f.min_value)}"` : ''}
                       ${f.max_value != null ? `max="${_esc(f.max_value)}"` : ''}
                       style="max-width:140px;">
                ${displayUnit ? `<span style="color:var(--text-muted);">${_esc(displayUnit)}</span>` : ''}
            </div>`;
        } else if (fieldType === 'text') {
            input = `<input type="text" class="form-input schedule-trigger-param" data-param-key="${_esc(f.key)}" ${metaAttrs}${requiredAttr} value="${_esc(v ?? '')}">`;
        } else if (fieldType === 'checkbox') {
            input = `<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;">
                <input type="checkbox" class="schedule-trigger-param" data-param-key="${_esc(f.key)}" ${metaAttrs}${requiredAttr} ${v ? 'checked' : ''} style="width:auto;">
                <span style="font-size:0.875rem;">${_esc(f.label)}${f.required ? '<span class="sched-required-mark">*</span>' : ''}</span>
            </label>`;
        } else if (fieldType === 'select') {
            const opts = (f.options || []).map(o => {
                const preset = o.threshold != null ? ` data-threshold="${_esc(o.threshold)}"` : '';
                return `<option value="${_esc(o.value)}"${String(o.value) === String(v) ? ' selected' : ''}${preset}>${_esc(o.label)}</option>`;
            }).join('');
            const placeholder = f.required && (v === undefined || v === null || v === '')
                ? `<option value="" selected disabled>Select ${_esc(f.label.toLowerCase())}</option>`
                : '';
            const updatesAttr = f.updates_field ? ` data-updates-field="${_esc(f.updates_field)}"` : '';
            input = `<select class="form-input schedule-trigger-param" data-param-key="${_esc(f.key)}" ${metaAttrs}${requiredAttr}${updatesAttr}>${placeholder}${opts}</select>`;
        } else if (fieldType === 'date') {
            input = `<input type="date" class="form-input schedule-trigger-param" data-param-key="${_esc(f.key)}" ${metaAttrs}${requiredAttr} value="${_esc(v || '')}">`;
        } else {
            return '';
        }

        const showIfAttr = f.show_if
            ? ` data-show-if-key="${_esc(f.show_if.key)}" ` + (
                f.show_if.values
                    ? `data-show-if-vals='${JSON.stringify(f.show_if.values)}'`
                    : `data-show-if-val="${_esc(String(f.show_if.value))}"`)
            : '';
        const groupStyle = _scheduleTriggerFieldVisible(def, f) ? '' : ' style="display:none;"';
        return fieldType === 'checkbox'
            ? `<div class="form-group"${showIfAttr}${groupStyle}>${input}</div>`
            : `<div class="form-group"${showIfAttr}${groupStyle}>
                <label class="form-label">${_esc(f.label)}${f.required ? '<span class="sched-required-mark">*</span>' : ''}</label>
                ${input}
                ${f.help_text ? `<div class="form-help">${_esc(f.help_text)}</div>` : ''}
            </div>`;
    }).join('');
}

function _scheduleTriggerFieldVisible(def, field) {
    if (!field.show_if) return true;
    const source = def?.fields?.find(f => f.key === field.show_if.key);
    const params = _sfTriggerOptions.params || {};
    const current = String(params[field.show_if.key] ?? source?.default ?? '');
    if (field.show_if.values) return field.show_if.values.map(String).includes(current);
    return current === String(field.show_if.value);
}

function _bindScheduleTriggerFieldBehavior() {
    const applyShowIf = () => {
        document.querySelectorAll('#sfTriggerOptionsGroup .form-group[data-show-if-key]').forEach(group => {
            const ctrl = document.querySelector(`#sfTriggerOptionsGroup .schedule-trigger-param[data-param-key="${group.dataset.showIfKey}"]`);
            let show = true;
            if (group.dataset.showIfVals) show = ctrl && JSON.parse(group.dataset.showIfVals).map(String).includes(String(ctrl.value));
            else if (group.dataset.showIfVal !== undefined) show = ctrl && String(ctrl.value) === group.dataset.showIfVal;
            group.style.display = show ? '' : 'none';
        });
    };
    document.querySelectorAll('#sfTriggerOptionsGroup .schedule-trigger-param').forEach(input => {
        const clearInvalid = () => input.classList.remove('invalid');
        input.addEventListener('input', clearInvalid);
        input.addEventListener('change', () => {
            clearInvalid();
            if (input.dataset.updatesField) {
                const preset = input.options?.[input.selectedIndex]?.dataset?.threshold;
                const target = document.querySelector(`#sfTriggerOptionsGroup .schedule-trigger-param[data-param-key="${input.dataset.updatesField}"]`);
                if (preset != null && target) target.value = preset;
            }
            applyShowIf();
        });
    });
    applyShowIf();
}

function _validateScheduleTriggerRequiredFields() {
    const trigger = document.getElementById('sfTriggerType')?.value || 'time';
    if (trigger === 'time') return true;

    for (const input of document.querySelectorAll('#sfTriggerOptionsGroup .schedule-trigger-param[data-param-required="1"]')) {
        const group = input.closest('.form-group');
        if (group && group.style.display === 'none') continue;

        const value = input.type === 'checkbox' ? input.checked : String(input.value ?? '').trim();
        const missing = input.type === 'checkbox' ? !value : value === '';
        if (!missing) continue;

        _showScheduleValidation(`${input.dataset.paramLabel || 'This field'} is required.`, input);
        return false;
    }

    return true;
}

function _getScheduleTriggerOptions() {
    const trigger = document.getElementById('sfTriggerType')?.value || 'time';
    if (trigger === 'time') return {};
    const def = _selectedScheduleAlertDef();
    const params = {};
    document.querySelectorAll('#sfTriggerOptionsGroup .schedule-trigger-param').forEach(input => {
        const key = input.dataset.paramKey;
        if (!key) return;
        if (input.type === 'checkbox') {
            params[key] = input.checked;
        } else if (input.type === 'number') {
            const v = parseFloat(input.value);
            if (!isNaN(v)) {
                const unitType = input.dataset.unitType;
                params[key] = unitType === 'speed' ? fromDisplaySpeed(v)
                            : unitType === 'dist' ? fromDisplayDist(v)
                            : v;
            }
        } else {
            params[key] = input.value;
        }
    });
    return def ? { alert_key: def.key || def.value, params } : {};
}

function _scheduleTriggerValue(schedule) {
    if (!schedule || (schedule.trigger_type || 'time') === 'time') return 'time';
    const key = schedule.trigger_options?.alert_key;
    if (key && _scheduleTriggerMap[key]) return key;
    const match = _scheduleTriggerDefs.find(d => d.source === 'alert' && d.alert_type === schedule.trigger_type);
    return match?.value || 'time';
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
    if (_sfSelectedVehIds.size === 0) {
        lbl.textContent = 'All vehicles';
        return;
    }
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
    _clearScheduleValidation();

    const nameInput = document.getElementById('sfName');
    const name = nameInput.value.trim();
    if (!name) {
        _showScheduleValidation('Schedule Name is required.', nameInput);
        return;
    }

    const rtype      = document.getElementById('sfType').value;
    const historical = document.getElementById('sfHistorical').checked;
    const dateRange  = document.getElementById('sfDateRange').value;
    const freq       = document.getElementById('sfFreq').value;
    const runTime    = document.getElementById('sfTime').value;
    const trigger    = document.getElementById('sfTriggerType').value || 'time';
    const keep       = parseInt(document.getElementById('sfKeep').value);

    if (!rtype) {
        _showScheduleValidation('Report Type is required.', document.getElementById('sfType'));
        return;
    }
    if (trigger === 'time' && !runTime) {
        _showScheduleValidation('Run Time is required.', document.getElementById('sfTime'));
        return;
    }
    if (!_scheduleTriggerMap[trigger]) {
        _showScheduleValidation('Trigger is required.', document.getElementById('sfTriggerType'));
        return;
    }
    if (!_validateScheduleTriggerRequiredFields()) return;
    if (isNaN(keep) || keep < 1 || keep > 100) {
        _showScheduleValidation('Keep Last N Runs must be between 1 and 100.', document.getElementById('sfKeep'));
        return;
    }

    const def = _reportDefMap[rtype] || {};
    const needsRange = def.needs_date_range !== false || historical;
    if (needsRange && !dateRange) {
        _showScheduleValidation('Date Range is required.', document.getElementById('sfDateRange'));
        return;
    }

    const body = {
        name,
        report_type:        rtype,
        filter_device_ids:  trigger === 'time' && def.schedule_uses_device_filter === false ? [] : [..._sfSelectedVehIds],
        filter_user_ids:    [..._sfSelectedUserIds],
        options:            _getScheduleControlValues(),
        notification_channels: _getSelectedScheduleChannels(),
        attach_results:     true,
        attach_documents:   true,
        sensors_historical: historical,
        date_range:         needsRange ? dateRange : null,
        trigger_type:       trigger === 'time' ? 'time' : _scheduleTriggerMap[trigger]?.alert_type,
        trigger_options:    _getScheduleTriggerOptions(),
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
