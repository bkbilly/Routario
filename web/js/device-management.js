// ================================================================
//  device-management.js
// ================================================================

let availableProtocols = [];
let devices            = [];
let userChannels       = [];
let editingDeviceId    = null;
let allDevices         = [];      // unfiltered master list for search

// Alerts: array-based so same type can be added multiple times
let alertRows       = [];
let editingAlertUid = null;
let uidCounter      = 0;

// Raw data
let rawData            = [];
let currentPage        = 1;
const itemsPerPage     = 50;
let currentRawDeviceId = null;

// ── Constants ────────────────────────────────────────────────────

const VEHICLE_ICONS = {
    arrow:'▲',
    car:'🚗',
    truck:'🚛',
    van:'🚐',
    motorcycle:'🏍️',
    bus:'🚌',
    person:'🚶',
    airplane:'✈️',
    bicycle:'🚲',
    boat:'🚢',
    scooter:'🛴',
    tractor:'🚜',
    other:'📦',
};

let ALERT_TYPES = {};

async function loadAlertTypes() {
    const res = await apiFetch(`${API_BASE}/alerts/types`);
    ALERT_TYPES = await res.json();
    populateAddAlertDropdown(); // re-render once loaded
}


const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DEFAULT_PROTOCOL = 'teltonika';
const DEFAULT_TYPE     = 'car';
const isAdmin = localStorage.getItem('is_admin') === 'true';


// ── Boot ─────────────────────────────────────────────────────────

function checkLogin() {
    if (!localStorage.getItem('auth_token')) window.location.href = 'login.html';
}

document.addEventListener('DOMContentLoaded', async () => {
    const addBtn = document.querySelector('button[onclick="openAddDeviceModal()"]');
    if (addBtn) addBtn.style.display = isAdmin ? '' : 'none';

    checkLogin();
    await loadAlertTypes();
    await loadAvailableProtocols();
    await loadUserChannels();
    await loadDevices();
    populateAddAlertDropdown();
});

// ── Loaders ──────────────────────────────────────────────────────

async function loadAvailableProtocols() {
    try {
        const res = await apiFetch(`${API_BASE}/protocols`);
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const data         = await res.json();
        availableProtocols = data.protocols || [];

        const sel = document.getElementById('deviceProtocol');
        if (!sel) return;
        sel.innerHTML = '<option value="">-- Select Protocol --</option>';
        const names = {
            teltonika:'Teltonika', gt06:'GT06 / Concox', osmand:'OsmAnd',
            flespi:'Flespi', totem:'Totem', tk103:'TK103', gps103:'GPS103', h02:'H02'
        };
        [...availableProtocols].sort().forEach(p => {
            const opt = document.createElement('option');
            opt.value       = p;
            opt.textContent = names[p] || (p.charAt(0).toUpperCase() + p.slice(1));
            sel.appendChild(opt);
        });
    } catch (e) {
        console.error('Error loading protocols:', e);
        showAlert('Failed to load protocols from server', 'error');
    }
}

async function loadUserChannels() {
    try {
        const userId = localStorage.getItem('user_id') || 1;
        const res    = await apiFetch(`${API_BASE}/users/${userId}`);
        if (!res.ok) throw new Error();
        const user   = await res.json();
        userChannels = user.notification_channels || [];
    } catch (e) { console.error('Error loading channels:', e); }
}

async function loadDevices() {
    try {
        const userId = localStorage.getItem('user_id') || 1;
        const res    = await apiFetch(`${API_BASE}/devices?user_id=${userId}&_t=${Date.now()}`);
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        devices     = await res.json();
        allDevices  = devices;

        for (const device of devices) {
            try {
                const sr = await apiFetch(`${API_BASE}/devices/${device.id}/state`);
                if (sr.ok) device.state = await sr.json();
            } catch (e) { /* ignore */ }
            try {
                const cr = await apiFetch(`${API_BASE}/devices/${device.id}/command-support`);
                device.supports_commands = cr.ok ? (await cr.json()).supports_commands : false;
            } catch (e) { device.supports_commands = false; }
        }

        renderDeviceTable(devices);
    } catch (e) {
        showAlert('Failed to load devices', 'error');
        console.error(e);
    }
}

// ── Device Table ─────────────────────────────────────────────────

function filterDevices() {
    const q = (document.getElementById('deviceSearch').value || '').toLowerCase().trim();
    const filtered = q
        ? allDevices.filter(d =>
            (d.name          || '').toLowerCase().includes(q) ||
            (d.imei          || '').toLowerCase().includes(q) ||
            (d.license_plate || '').toLowerCase().includes(q) ||
            (d.protocol      || '').toLowerCase().includes(q) ||
            (d.vehicle_type  || '').toLowerCase().includes(q))
        : allDevices;
    renderDeviceTable(filtered);
}

function renderDeviceTable(list) {
    const tbody = document.getElementById('devicesTableBody');
    const count = document.getElementById('devicesCount');
    count.textContent = `${list.length} device${list.length !== 1 ? 's' : ''}`;

    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:3rem;color:var(--text-muted);">
            <div style="font-size:2.5rem;margin-bottom:0.75rem;">📡</div>
            No devices found
        </td></tr>`;
        return;
    }

    tbody.innerHTML = list.map(d => {
        const icon       = VEHICLE_ICONS[d.vehicle_type] || '📦';
        const isOnline   = d.state?.is_online;
        const lastUpdate = d.state?.last_update ? formatDateToLocal(d.state.last_update) : '—';
        const odometer   = d.state?.total_odometer != null ? `${d.state.total_odometer.toFixed(0)} km` : '—';
        const plate      = d.license_plate || '—';
        const proto      = d.protocol ? (d.protocol.charAt(0).toUpperCase() + d.protocol.slice(1)) : '—';
        const cmds       = d.supports_commands !== false;

        return `<tr class="device-row" ondblclick="openDeviceModal(${d.id},'general')">
            <td style="text-align:center;font-size:1.2rem;">${icon}</td>
            <td><span class="device-row-name">${d.name}</span><div class="device-row-imei">${d.imei}</div></td>
            <td><span style="font-family:var(--font-mono);font-size:0.8rem;">${d.imei}</span></td>
            <td><span class="proto-badge">${proto}</span></td>
            <td>${plate}</td>
            <td>
                <span class="status-dot ${d.is_active ? (isOnline ? 'online' : 'active') : 'inactive'}"></span>
                ${d.is_active ? (isOnline ? 'Online' : 'Active') : 'Inactive'}
            </td>
            <td style="font-size:0.85rem;color:var(--text-secondary);">${lastUpdate}</td>
            <td style="font-family:var(--font-mono);font-size:0.85rem;">${odometer}</td>
            <td style="text-align:right;white-space:nowrap;">
                ${cmds ? `<button class="btn btn-secondary tbl-btn" onclick="openCommandModal(${d.id})">📡</button>` : ''}
                <button class="btn btn-secondary tbl-btn" onclick="openDeviceModal(${d.id},'general')">✏️ Edit</button>
            </td>
        </tr>`;
    }).join('');
}

// ── Helpers ───────────────────────────────────────────────────────

function formatDateToLocal(str) {
    if (!str) return 'Never';
    if (!str.includes('Z') && !str.includes('+')) str += 'Z';
    return new Date(str).toLocaleString();
}
function nextUid() { return ++uidCounter; }
function pad(n)    { return String(n).padStart(2, '0'); }

// ── Modal Tab Switcher ────────────────────────────────────────────

function switchModalTab(tabId, btn) {
    document.querySelectorAll('.modal-tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.modal-tab').forEach(el => el.classList.remove('active'));
    document.getElementById(`tab-${tabId}`).classList.add('active');
    (btn || document.querySelector(`.modal-tab[data-tab="${tabId}"]`))?.classList.add('active');
    if (tabId === 'rawdata' && editingDeviceId) loadRawDataForModal(editingDeviceId);
}

async function loadGeofencesForDevice(deviceId) {
    try {
        const res = await apiFetch(`${API_BASE}/geofences?device_id=${deviceId}`);
        if (!res.ok) return [];
        const geofences = await res.json();
        return geofences.map(g => ({ value: String(g.id), label: g.name }));
    } catch (e) {
        console.error('Failed to load geofences:', e);
        return [];
    }
}

// ── Open / Close Device Modal ─────────────────────────────────────

function openAddDeviceModal() {
    editingDeviceId = null;
    document.getElementById('modalTitle').textContent  = 'Add New Device';
    document.getElementById('submitText').textContent   = 'Add Device';
    document.getElementById('deviceForm').reset();
    document.getElementById('deviceProtocol').value    = DEFAULT_PROTOCOL;
    document.getElementById('currentOdometer').value   = '0.0';
    document.getElementById('deleteDeviceBtn').style.display = 'none';
    alertRows = [];
    renderAlertsTable();
    populateAddAlertDropdown();
    switchModalTab('general');
    document.getElementById('deviceModal').classList.add('active');
}

function openDeviceModal(deviceId, startTab = 'general') {
    const d = devices.find(x => x.id == deviceId);
    if (!d) return;
    editingDeviceId = d.id;

    document.getElementById('modalTitle').textContent  = 'Edit Device';
    document.getElementById('submitText').textContent   = 'Save Changes';
    document.getElementById('deleteDeviceBtn').style.display = 'block';

    document.getElementById('deviceName').value      = d.name;
    document.getElementById('deviceImei').value      = d.imei;
    document.getElementById('deviceProtocol').value  = d.protocol || DEFAULT_PROTOCOL;
    document.getElementById('vehicleType').value     = d.vehicle_type || '';
    document.getElementById('licensePlate').value    = d.license_plate || '';
    document.getElementById('vin').value             = d.vin || '';
    document.getElementById('currentOdometer').value = d.state?.total_odometer != null ? d.state.total_odometer.toFixed(1) : '0.0';
    document.getElementById('offlineTimeoutHours').value = 24;

    const config = d.config || {};

    loadAlertsFromConfig(config);
    switchModalTab(startTab);
    document.getElementById('deviceModal').classList.add('active');
}

// Shims for backward-compat calls from card buttons
function editDevice(id)       { openDeviceModal(id, 'general'); }
function openRawDataModal(id) { openDeviceModal(id, 'rawdata'); }

function closeDeviceModal() {
    document.getElementById('deviceModal').classList.remove('active');
}

// ── Commands Modal ────────────────────────────────────────────────
// currentCommandDeviceId and currentCommandDevice are declared in device-commands.js

function openCommandModal(deviceId) {
    currentCommandDeviceId = deviceId;
    currentCommandDevice   = devices.find(d => d.id == deviceId);
    if (!currentCommandDevice) return;
    document.getElementById('commandDeviceName').textContent = currentCommandDevice.name;
    document.getElementById('commandModal').classList.add('active');
    switchCommandTab('send');
    loadAvailableCommands();
}

// closeCommandModal is defined in device-commands.js

// switchCommandTab and switchCommandSubtab are defined in device-commands.js

// ================================================================
//  ALERTS SYSTEM
// ================================================================

function loadAlertsFromConfig(config) {
    alertRows = [];
    if (Array.isArray(config.alert_rows)) {
        config.alert_rows.forEach(r => alertRows.push({ ...r, uid: nextUid() }));
    } else {
        const ch = config.alert_channels || {};
        for (const [key] of Object.entries(ALERT_TYPES)) {
            if (config[key] != null) {
                alertRows.push({ uid:nextUid(), alertKey:key, value:config[key], channels:ch[key]||[], schedule:null });
            }
        }
        (config.custom_rules || []).forEach(r => {
            const obj = typeof r === 'string' ? { name:'Custom Alert', rule:r, channels:[] } : r;
            alertRows.push({ uid:nextUid(), alertKey:'__custom__', name:obj.name, rule:obj.rule, channels:obj.channels||[], schedule:null });
        });
    }
    renderAlertsTable();
    populateAddAlertDropdown();
}

function populateAddAlertDropdown() {
    const sel = document.getElementById('addAlertSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">Select a system alert&#8230;</option>';
    const grp = document.createElement('optgroup');
    grp.label = 'System Alerts';
    for (const [key, def] of Object.entries(ALERT_TYPES)) {
        const opt = document.createElement('option');
        opt.value = key; opt.textContent = def.label;
        grp.appendChild(opt);
    }
    sel.appendChild(grp);
}

function addSelectedAlert() {
    const sel = document.getElementById('addAlertSelect');
    const val = sel.value;
    if (!val) return;
    const def = ALERT_TYPES[val];
    if (!def) return;

    // Build default params from field definitions
    const params = {};
    (def.fields || []).forEach(f => { params[f.key] = f.default; });

    alertRows.push({ uid: nextUid(), alertKey: val, params, channels: [], schedule: null });
    renderAlertsTable();
    sel.value = '';
}

function addCustomRule() {
    const nameEl = document.getElementById('newRuleName');
    const ruleEl = document.getElementById('newRuleCond');
    const name = nameEl.value.trim(), rule = ruleEl.value.trim();
    if (!name || !rule) return;
    alertRows.push({ uid:nextUid(), alertKey:'__custom__', name, rule, channels:[], schedule:null });
    nameEl.value = ''; ruleEl.value = '';
    renderAlertsTable();
}

function removeAlertRow(uid) {
    alertRows = alertRows.filter(r => r.uid !== uid);
    renderAlertsTable();
}

function renderAlertsTable() {
    const tbody    = document.getElementById('alertsTableBody');
    const emptyRow = document.getElementById('alertsEmptyRow');
    if (!tbody) return;
    tbody.querySelectorAll('tr.alert-data-row').forEach(r => r.remove());
    if (!alertRows.length) { emptyRow.style.display = ''; return; }
    emptyRow.style.display = 'none';

    alertRows.forEach((row, idx) => {
        const isCustom = row.alertKey === '__custom__';
        const def      = isCustom ? null : ALERT_TYPES[row.alertKey];
        const label    = isCustom
            ? `⚡ ${row.name}`
            : (def?.icon ? `${def.icon} ${def.label}` : def?.label) || row.alertKey;

        // Threshold column: all fields except checkboxes
        let thresh;
        if (isCustom) {
            thresh = `<span style="font-family:var(--font-mono);font-size:0.73rem;color:var(--text-muted);word-break:break-all;">${row.rule}</span>`;
        } else {
            const visibleFields = (def?.fields || []).filter(f => f.field_type !== 'checkbox');
            if (visibleFields.length) {
                thresh = visibleFields.map(f => {
                    const val = row.params?.[f.key];
                    if (val == null || val === '') return null;

                    // For select fields, show the option label instead of the raw value
                    let display = val;
                    if (f.field_type === 'select' && f.options?.length) {
                        const opt = f.options.find(o => String(o.value) === String(val));
                        if (opt) display = opt.label;
                    }

                    return `<span class="alert-threshold-badge">
                        <small style="color:var(--text-muted);margin-right:0.2rem;">${f.label}:</small>
                        ${display}
                        ${f.unit ? `<small>${f.unit}</small>` : ''}
                    </span>`;
                }).filter(Boolean).join(' ');
            }
            if (!thresh) thresh = `<span style="color:var(--text-muted);font-size:0.8rem;">—</span>`;
        }

        const chHtml = row.channels?.length
            ? row.channels.map(c => `<span class="channel-pill active" style="pointer-events:none;">${c}</span>`).join('')
            : `<span style="color:var(--text-muted);font-size:0.8rem;">None</span>`;

        const sched = row.schedule;
        let schedHtml = `<span style="color:var(--text-muted);font-size:0.8rem;">Always</span>`;
        if (sched?.days?.length) {
            const daysStr = sched.days.map(d => DAYS[d]).join(', ');
            schedHtml = `<span class="schedule-badge">${daysStr}<br><small>${pad(sched.hourStart ?? 0)}:00–${pad(sched.hourEnd ?? 23)}:59</small></span>`;
        }

        const tr = document.createElement('tr');
        tr.className   = 'alert-data-row';
        tr.dataset.uid = row.uid;
        tr.innerHTML   = `
            <td style="color:var(--text-muted);font-size:0.82rem;">${idx + 1}</td>
            <td><span class="alert-type-label ${isCustom ? 'custom' : 'system'}">${label}</span></td>
            <td><div style="display:flex;flex-wrap:wrap;gap:0.3rem;">${thresh}</div></td>
            <td><div style="display:flex;flex-wrap:wrap;gap:0.3rem;">${chHtml}</div></td>
            <td>${schedHtml}</td>
            <td style="text-align:center;white-space:nowrap;">
                <button type="button" class="btn btn-secondary tbl-btn" onclick="openAlertEditor(${row.uid})">✏️</button>
                <button type="button" class="btn btn-danger tbl-btn"    onclick="removeAlertRow(${row.uid})">✕</button>
            </td>`;
        tbody.appendChild(tr);
    });
}

// ── Alert Editor ──────────────────────────────────────────────────

function renderAlertsTable() {
    const tbody    = document.getElementById('alertsTableBody');
    const emptyRow = document.getElementById('alertsEmptyRow');
    if (!tbody) return;
    tbody.querySelectorAll('tr.alert-data-row').forEach(r => r.remove());
    if (!alertRows.length) { emptyRow.style.display = ''; return; }
    emptyRow.style.display = 'none';

    alertRows.forEach((row, idx) => {
        const isCustom = row.alertKey === '__custom__';
        const def      = isCustom ? null : ALERT_TYPES[row.alertKey];
        const label    = isCustom
            ? `<span class="custom-alert-module">
                   <span class="custom-alert-module-title">⚡ ${row.name}</span>
                   <span class="custom-alert-module-cond">${row.rule}</span>
               </span>`
            : (def?.icon ? `${def.icon} ${def.label}` : def?.label) || row.alertKey;

        // Threshold column: all fields except checkboxes
        let thresh;
        if (isCustom) {
            thresh = `<span style="color:var(--text-muted);font-size:0.8rem;">—</span>`;
        } else {
            const visibleFields = (def?.fields || []).filter(f => f.field_type !== 'checkbox');
            if (visibleFields.length) {
                thresh = visibleFields.map(f => {
                    const val = row.params?.[f.key];
                    if (val == null || val === '') return null;

                    // For select fields, show the option label instead of the raw value
                    let display = val;
                    if (f.field_type === 'select' && f.options?.length) {
                        const opt = f.options.find(o => String(o.value) === String(val));
                        if (opt) display = opt.label;
                    }

                    return `<span class="alert-threshold-badge">
                        <small style="color:var(--text-muted);margin-right:0.2rem;">${f.label}:</small>
                        ${display}
                        ${f.unit ? `<small>${f.unit}</small>` : ''}
                    </span>`;
                }).filter(Boolean).join(' ');
            }
            if (!thresh) thresh = `<span style="color:var(--text-muted);font-size:0.8rem;">—</span>`;
        }

        const chHtml = row.channels?.length
            ? row.channels.map(c => `<span class="channel-pill active" style="pointer-events:none;">${c}</span>`).join('')
            : `<span style="color:var(--text-muted);font-size:0.8rem;">None</span>`;

        const sched = row.schedule;
        let schedHtml = `<span style="color:var(--text-muted);font-size:0.8rem;">Always</span>`;
        if (sched?.days?.length) {
            const daysStr = sched.days.map(d => DAYS[d]).join(', ');
            schedHtml = `<span class="schedule-badge">${daysStr}<br><small>${pad(sched.hourStart ?? 0)}:00–${pad(sched.hourEnd ?? 23)}:59</small></span>`;
        }

        const tr = document.createElement('tr');
        tr.className   = 'alert-data-row';
        tr.dataset.uid = row.uid;
        tr.innerHTML   = `
            <td style="color:var(--text-muted);font-size:0.82rem;">${idx + 1}</td>
            <td>${isCustom
                ? label
                : `<span class="alert-type-label system">${label}</span>`
            }</td>
            <td><div style="display:flex;flex-wrap:wrap;gap:0.3rem;">${thresh}</div></td>
            <td><div style="display:flex;flex-wrap:wrap;gap:0.3rem;">${chHtml}</div></td>
            <td>${schedHtml}</td>
            <td style="text-align:center;white-space:nowrap;">
                <button type="button" class="btn btn-secondary tbl-btn" onclick="openAlertEditor(${row.uid})">✏️</button>
                <button type="button" class="btn btn-danger tbl-btn"    onclick="removeAlertRow(${row.uid})">✕</button>
            </td>`;
        tbody.appendChild(tr);
    });
}

// ── 3. Replace openAlertEditor() ─────────────────────────────────

async function openAlertEditor(uid) {
    const row = alertRows.find(r => r.uid === uid);
    if (!row) return;
    editingAlertUid = uid;

    const isCustom = row.alertKey === '__custom__';
    const def      = isCustom ? null : ALERT_TYPES[row.alertKey];

    document.getElementById('alertEditorTitle').textContent =
        isCustom ? `Edit Custom Rule — ${row.name}` : `Edit ${def?.label || row.alertKey}`;

    // ── Build dynamic fields HTML ────────────────────────────
    let fieldsHtml = '';

    if (!isCustom && def?.fields?.length) {
        for (const f of def.fields) {
            const currentVal = row.params?.[f.key] ?? f.default;

            let inputHtml = '';

            if (f.field_type === 'number') {
                inputHtml = `
                    <div style="display:flex;align-items:center;gap:0.75rem;">
                        <input type="number" class="form-input alert-param-input"
                               data-param-key="${f.key}"
                               value="${currentVal ?? ''}"
                               min="${f.min_value}" max="${f.max_value}"
                               style="max-width:140px;">
                        ${f.unit ? `<span style="color:var(--text-muted);">${f.unit}</span>` : ''}
                    </div>`;

            } else if (f.field_type === 'text') {           // ← NEW CASE
                inputHtml = `
                    <input type="text" class="form-input alert-param-input"
                           data-param-key="${f.key}"
                           value="${currentVal ?? ''}"
                           placeholder="${f.help_text || ''}"
                           style="max-width:280px;">`;

            } else if (f.field_type === 'checkbox') {
                inputHtml = `
                    <label class="toggle-label" style="display:inline-flex;align-items:center;gap:0.6rem;cursor:pointer;">
                        <input type="checkbox" class="alert-param-input"
                               data-param-key="${f.key}"
                               ${currentVal ? 'checked' : ''}>
                        <span style="font-size:0.875rem;color:var(--text-secondary);">${f.label}</span>
                    </label>`;

            } else if (f.field_type === 'select') {
                let options = f.options || [];
                if (f.key === 'geofence_id' && editingDeviceId) {
                    options = await loadGeofencesForDevice(editingDeviceId);
                }
                const optHtml = options.map(o =>
                    `<option value="${o.value}" ${String(currentVal) === String(o.value) ? 'selected' : ''}>${o.label}</option>`
                ).join('');
                inputHtml = `
                    <select class="form-input alert-param-input" data-param-key="${f.key}" style="max-width:280px;">
                        <option value="">— Select —</option>
                        ${optHtml}
                    </select>`;
            }

            // For checkbox the label is inline; skip the outer label
            if (f.field_type === 'checkbox') {
                fieldsHtml += `
                    <div class="form-group">
                        ${inputHtml}
                        ${f.help_text ? `<div class="form-help">${f.help_text}</div>` : ''}
                    </div>`;
            } else {
                fieldsHtml += `
                    <div class="form-group">
                        <label class="form-label">${f.label}</label>
                        ${inputHtml}
                        ${f.help_text ? `<div class="form-help">${f.help_text}</div>` : ''}
                    </div>`;
            }
        }
    } else if (isCustom) {
        fieldsHtml = `
            <div class="form-group">
                <label class="form-label">Rule Name</label>
                <input type="text" class="form-input" id="editor-custom-name" value="${row.name || ''}">
            </div>
            <div class="form-group">
                <label class="form-label">Condition</label>
                <input type="text" class="form-input" id="editor-custom-rule" value="${row.rule || ''}">
            </div>`;
    }

    // ── Schedule section ─────────────────────────────────────
    const sched      = row.schedule || {};
    const activeDays = sched.days   || [];
    const hourStart  = sched.hourStart ?? 0;
    const hourEnd    = sched.hourEnd   ?? 23;

    const dayPickerHtml = DAYS.map((day, i) => `
        <label class="day-pill${activeDays.includes(i) ? ' active' : ''}">
            <input type="checkbox" value="${i}"${activeDays.includes(i) ? ' checked' : ''}> ${day}
        </label>`).join('');

    const hourOpts    = (sel) => Array.from({ length: 24 }, (_, h) =>
        `<option value="${h}"${h === sel ? ' selected' : ''}>${pad(h)}:00</option>`).join('');
    const hourEndOpts = Array.from({ length: 24 }, (_, h) =>
        `<option value="${h}"${h === hourEnd ? ' selected' : ''}>${pad(h)}:59</option>`).join('');

    // ── Notification channels ────────────────────────────────
    const chHtml = userChannels.length
        ? userChannels.map(c => `
            <label class="channel-pill${(row.channels || []).includes(c.name) ? ' active' : ''}">
                <input type="checkbox" class="editor-channel-cb" value="${c.name}"${(row.channels || []).includes(c.name) ? ' checked' : ''}>
                ${c.name}
            </label>`).join('')
        : '<span style="color:var(--text-muted);font-size:0.875rem;">No notification channels configured.</span>';

    document.getElementById('alertEditorBody').innerHTML = `
        <div style="display:flex;flex-direction:column;gap:0.25rem;">
            ${def?.description ? `<p style="color:var(--text-muted);font-size:0.85rem;margin:0 0 1rem;">${def.description}</p>` : ''}
            ${fieldsHtml}
        </div>

        <div class="form-group" style="margin-top:1.25rem;">
            <label class="form-label">Notify Via</label>
            <div style="display:flex;flex-wrap:wrap;gap:0.4rem;">${chHtml}</div>
        </div>

        <div class="form-group">
            <label class="form-label">
                Schedule
                <span style="font-weight:400;color:var(--text-muted);"> (no days selected = always active)</span>
            </label>
            <div style="margin-bottom:0.75rem;">
                <div style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:0.5rem;font-weight:600;">Active Days</div>
                <div class="day-picker" id="editor-day-picker">${dayPickerHtml}</div>
            </div>
            <div style="display:flex;gap:1rem;flex-wrap:wrap;">
                <div>
                    <label class="form-label" style="font-size:0.78rem;">From</label>
                    <select class="form-input" id="editor-hour-start" style="width:100px;">${hourOpts(hourStart)}</select>
                </div>
                <div>
                    <label class="form-label" style="font-size:0.78rem;">Until</label>
                    <select class="form-input" id="editor-hour-end" style="width:100px;">${hourEndOpts}</select>
                </div>
            </div>
        </div>`;

    // Wire up day pills
    document.querySelectorAll('#editor-day-picker .day-pill').forEach(pill => {
        const cb = pill.querySelector('input');
        if (!cb) return;
        pill.classList.toggle('active', cb.checked);
        pill.addEventListener('click', () => {
            cb.checked = !cb.checked;
            pill.classList.toggle('active', cb.checked);
        });
    });

    // Wire up channel pills
    document.querySelectorAll('#alertEditorBody .channel-pill').forEach(pill => {
        const cb = pill.querySelector('input');
        if (!cb) return;
        pill.addEventListener('click', () => {
            cb.checked = !cb.checked;
            pill.classList.toggle('active', cb.checked);
        });
    });

    document.getElementById('alertEditorModal').classList.add('active');
}

function closeAlertEditor() {
    document.getElementById('alertEditorModal').classList.remove('active');
    editingAlertUid = null;
}

function saveAlertFromEditor() {
    const row = alertRows.find(r => r.uid === editingAlertUid);
    if (!row) return;

    const isCustom = row.alertKey === '__custom__';

    if (isCustom) {
        const n = document.getElementById('editor-custom-name')?.value.trim();
        const r = document.getElementById('editor-custom-rule')?.value.trim();
        if (n) row.name = n;
        if (r) row.rule = r;
    } else {
        // Collect all param inputs
        if (!row.params) row.params = {};
        document.querySelectorAll('#alertEditorBody .alert-param-input').forEach(input => {
            const key = input.dataset.paramKey;
            if (!key) return;
            if (input.type === 'checkbox') {
                row.params[key] = input.checked;
            } else if (input.type === 'number') {
                const v = parseFloat(input.value);
                if (!isNaN(v)) row.params[key] = v;
            } else {
                row.params[key] = input.value;
            }
        });
    }

    // Channels
    row.channels = [];
    document.querySelectorAll('.editor-channel-cb:checked').forEach(cb => row.channels.push(cb.value));

    // Schedule
    const activeDays = [];
    document.querySelectorAll('#editor-day-picker input:checked').forEach(cb => activeDays.push(parseInt(cb.value)));
    const hs = parseInt(document.getElementById('editor-hour-start').value);
    const he = parseInt(document.getElementById('editor-hour-end').value);
    row.schedule = activeDays.length ? { days: activeDays.sort((a, b) => a - b), hourStart: hs, hourEnd: he } : null;

    closeAlertEditor();
    renderAlertsTable();
}

// ── Build config from alertRows ───────────────────────────────────

function buildConfigFromAlertRows(existing = {}) {
    const config = {
        ...existing,
        alert_rows:     [],
        alert_channels: {},
        custom_rules:   [],
    };

    // Remove old flat alert keys so they don't linger
    const legacyKeys = ['speed_tolerance', 'idle_timeout_minutes', 'offline_timeout_hours', 'towing_threshold_meters', 'speed_duration_seconds'];
    legacyKeys.forEach(k => delete config[k]);

    alertRows.forEach(row => {
        config.alert_rows.push({ ...row });

        if (row.alertKey === '__custom__') {
            config.custom_rules.push({ name: row.name, rule: row.rule, channels: row.channels || [] });
        } else {
            // Keep alert_channels for notification dispatch compatibility
            config.alert_channels[row.alertKey] = row.channels || [];
        }
    });

    return config;
}

// ── Form Submit (saves General + Alerts together) ─────────────────

async function handleSubmit(event) {
    event.preventDefault();
    const submitBtn  = document.getElementById('submitBtn');
    const submitText = document.getElementById('submitText');
    const submitLoad = document.getElementById('submitLoading');
    submitBtn.disabled = true; submitText.style.display = 'none'; submitLoad.style.display = 'inline-block';

    let existingConfig = {};
    if (editingDeviceId) {
        existingConfig = devices.find(d => d.id === editingDeviceId)?.config || {};
    }
    const newConfig = buildConfigFromAlertRows(existingConfig);
    newConfig.speed_duration_seconds = existingConfig.speed_duration_seconds || 30;
    newConfig.sensors     = existingConfig.sensors || {};
    newConfig.offline_timeout_hours = parseInt(document.getElementById('offlineTimeoutHours').value) || 24;
    newConfig.maintenance = existingConfig.maintenance || {};

    const payload = {
        name:          document.getElementById('deviceName').value,
        imei:          document.getElementById('deviceImei').value,
        protocol:      document.getElementById('deviceProtocol').value || DEFAULT_PROTOCOL,
        vehicle_type:  document.getElementById('vehicleType').value    || DEFAULT_TYPE,
        license_plate: document.getElementById('licensePlate').value   || null,
        vin:           document.getElementById('vin').value            || null,
        config:        newConfig
    };

    try {
        let response;
        if (editingDeviceId) {
            const odo = parseFloat(document.getElementById('currentOdometer').value) || null;
            const url = `${API_BASE}/devices/${editingDeviceId}${odo !== null ? `?new_odometer=${odo}` : ''}`;
            response = await apiFetch(url, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        } else {
            response = await apiFetch(`${API_BASE}/devices`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        }

        if (response.ok) {
            showAlert(editingDeviceId ? 'Device updated' : 'Device added', 'success');
            closeDeviceModal();
            await loadDevices();
        } else {
            const err = await response.json();
            showAlert(err.detail || 'Failed to save', 'error');
        }
    } catch (e) {
        showAlert('Failed to save device', 'error');
    } finally {
        submitBtn.disabled = false; submitText.style.display = 'inline'; submitLoad.style.display = 'none';
    }
}

// ── Delete ────────────────────────────────────────────────────────

async function deleteCurrentDevice() {
    if (!editingDeviceId) return;
    const d = devices.find(x => x.id === editingDeviceId);
    if (!confirm(`Delete "${d?.name || 'this device'}"?\n\nThis cannot be undone.`)) return;
    try {
        const res = await apiFetch(`${API_BASE}/devices/${editingDeviceId}`, { method:'DELETE' });
        if (res.ok) {
            showAlert('Device deleted', 'success');
            closeDeviceModal();
            await loadDevices();
        } else {
            const err = await res.json();
            showAlert(err.detail || 'Failed to delete', 'error');
        }
    } catch (e) { showAlert('Failed to delete device', 'error'); }
}

// ── Raw Data ──────────────────────────────────────────────────────

async function loadRawDataForModal(deviceId) {
    currentRawDeviceId = deviceId;
    currentPage = 1;
    const tbody = document.getElementById('rawDataBody');
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:2rem;">Loading&#8230;</td></tr>';
    const end = new Date(), start = new Date(end - 86400000);
    try {
        const res = await apiFetch(`${API_BASE}/positions/history`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ device_id:deviceId, start_time:start.toISOString(), end_time:end.toISOString(), max_points:1000, order:'desc' })
        });
        if (!res.ok) throw new Error(`${res.status}`);
        rawData = (await res.json()).features || [];
        renderRawDataPage();
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--accent-danger);">Failed to load: ${e.message}</td></tr>`;
    }
}

function changeRawDataPage(delta) {
    const max = Math.ceil(rawData.length / itemsPerPage) || 1;
    currentPage = Math.max(1, Math.min(max, currentPage + delta));
    renderRawDataPage();
}

function renderRawDataPage() {
    const tbody = document.getElementById('rawDataBody');
    const slice = rawData.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);
    tbody.innerHTML = '';
    if (!slice.length) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:2rem;color:var(--text-muted);">No data available for the last 24 hours.</td></tr>';
        return;
    }
    slice.forEach(feat => {
        const p      = feat.properties || feat;
        const coords = feat.geometry?.coordinates || [p.longitude, p.latitude];
        const sensors = { ...(p.sensors || {}) }; delete sensors.raw;
        const attrStr = Object.entries(sensors).map(([k,v]) => `${k}:${v}`).join('|');
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${p.time ? new Date(p.time).toLocaleString() : 'N/A'}</td>
            <td>${coords[1].toFixed(5)}</td>
            <td>${coords[0].toFixed(5)}</td>
            <td>${(p.speed||0).toFixed(1)} km/h</td>
            <td>${(p.course||0).toFixed(0)}°</td>
            <td>${p.satellites||0}</td>
            <td>${(p.altitude||0).toFixed(0)} m</td>
            <td>${p.ignition?'ON':'OFF'}</td>
            <td style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono);font-size:0.72rem;" title="${attrStr}">${attrStr}</td>`;
        tbody.appendChild(tr);
    });
    const max = Math.ceil(rawData.length / itemsPerPage) || 1;
    document.getElementById('pageInfo').textContent  = `Page ${currentPage} of ${max}`;
    document.getElementById('prevPageBtn').disabled  = currentPage === 1;
    document.getElementById('nextPageBtn').disabled  = currentPage === max;
}

// ── Toast ─────────────────────────────────────────────────────────

function showAlert(message, type) {
    const el = document.createElement('div');
    el.className = `alert alert-${type}`;
    el.innerHTML = `<span>${type === 'success' ? '✅' : '❌'} ${message}</span>`;
    document.getElementById('alertContainer').appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

// ── Dashboard alert modal shims ───────────────────────────────────

let loadedAlerts = [];

async function loadAlerts() {
    try {
        const res = await apiFetch(`${API_BASE}/alerts?unread=true&limit=50`);
        if (!res.ok) return;
        loadedAlerts = await res.json();
        const list = document.getElementById('alertsList');
        if (!list) return;
        list.innerHTML = '';
        loadedAlerts.forEach(alert => {
            const item = document.createElement('div');
            item.className = `alert-item ${alert.severity}`;
            const icon = alert.type === 'speeding' ? '⚡' : alert.type === 'offline' ? '📴' : '🔔';
            item.innerHTML = `
                <div class="alert-icon">${icon}</div>
                <div class="alert-content">
                    <div class="alert-title">${alert.type}</div>
                    <div class="alert-message">${alert.message}</div>
                    <div class="alert-time">${formatDateToLocal(alert.created_at)}</div>
                </div>
                <button class="alert-dismiss" onclick="dismissAlert(${alert.id})">✕</button>`;
            list.appendChild(item);
        });
    } catch (e) { console.error('Error loading alerts:', e); }
}

async function dismissAlert(id) {
    try { const r = await apiFetch(`${API_BASE}/alerts/${id}/read`, {method:'POST'}); if (r.ok) loadAlerts(); } catch(e){}
}
function openAlertsModal()  { loadAlerts(); document.getElementById('alertsModal')?.classList.add('active'); }
function closeAlertsModal() { document.getElementById('alertsModal')?.classList.remove('active'); }
async function clearAllAlerts() {
    if (!loadedAlerts.length || !confirm('Mark all alerts as read?')) return;
    for (const a of loadedAlerts) try { await apiFetch(`${API_BASE}/alerts/${a.id}/read`, {method:'POST'}); } catch(e){}
    loadAlerts(); showAlert('All alerts cleared', 'success');
}