// ================================================================
//  device-management.js
//  Core: state, loaders, device table, modal, form submit,
//        alerts system, raw data tab.
//  Depends on: config.js, vehicle-icons.js,
//              device-management-integrations.js (loaded after this)
// ================================================================

// ── State ────────────────────────────────────────────────────────
let availableProtocols   = [];
let integrationProviders = [];
let integrationAccounts  = [];
let devices              = [];
let allDevices           = [];
let userChannels         = [];
let editingDeviceId      = null;

// Alerts tab
let alertRows       = [];
let editingAlertUid = null;
let uidCounter      = 0;
let ALERT_TYPES     = {};
let protocolInfo = {};

// Raw data tab
let rawData            = [];
let currentPage        = 1;
const itemsPerPage     = 50;
let currentRawDeviceId = null;

// ── Constants ────────────────────────────────────────────────────
const DAYS             = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_PROTOCOL = 'teltonika';
const DEFAULT_TYPE     = 'car';
const isAdmin          = localStorage.getItem('is_admin') === 'true';

// ── Helpers ───────────────────────────────────────────────────────
function checkLogin() {
    if (!localStorage.getItem('auth_token')) window.location.href = 'login.html';
}
function nextUid() { return ++uidCounter; }
function pad(n)    { return String(n).padStart(2, '0'); }

function formatDateToLocal(str) {
    if (!str) return 'Never';
    if (!str.includes('Z') && !str.includes('+')) str += 'Z';
    return new Date(str).toLocaleString();
}

function _esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function protoBadgeHtml(protocol) {
    const hue = [...protocol].reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
    const style = [
        `color: hsl(${hue}, 70%, 65%)`,
        `background: hsl(${hue}, 70%, 65%, 0.12)`,
        `border: 1px solid hsl(${hue}, 70%, 65%, 0.30)`,
    ].join(';');
    return `<span class="proto-badge" style="${style}">${_esc(protocol)}</span>`;
}

// ── Boot ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    checkLogin();

    const addBtn = document.querySelector('button[onclick="openAddDeviceModal()"]');
    if (addBtn) addBtn.style.display = isAdmin ? '' : 'none';

    await loadAlertTypes();
    await loadAvailableProtocols();   // also loads integration providers + accounts
    await loadUserChannels();
    await loadDevices();
    populateAddAlertDropdown();

    // Escape key closes any open modal
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        ['deviceModal', 'alertEditorModal', 'commandModal'].forEach(id => {
            document.getElementById(id)?.classList.remove('active');
        });
    });
});

// ── API Loaders ───────────────────────────────────────────────────
async function loadAlertTypes() {
    try {
        const res = await apiFetch(`${API_BASE}/alerts/types`);
        if (res.ok) {
            ALERT_TYPES = await res.json();
            populateAddAlertDropdown();
        }
    } catch (e) { console.error('Failed to load alert types:', e); }
}

async function loadAvailableProtocols() {
    try {
        const [protoRes, intgRes, accountsRes] = await Promise.all([
            apiFetch(`${API_BASE}/protocols`),
            apiFetch(`${API_BASE}/integrations/providers`),
            apiFetch(`${API_BASE}/integrations/accounts`),
        ]);

        const data           = protoRes.ok    ? await protoRes.json()    : { protocols: [], protocol_info: {} };
        protocolInfo         = data.protocol_info || {};
        integrationProviders = intgRes.ok      ? await intgRes.json()     : [];
        integrationAccounts  = accountsRes.ok  ? await accountsRes.json() : [];
        availableProtocols   = data.protocols || [];

        const sel = document.getElementById('deviceProtocol');
        if (!sel) return;
        sel.innerHTML = '<option value="">-- Select Protocol --</option>';

        // Native protocols
        const nativeNames = {
            teltonika: 'Teltonika', gt06: 'GT06 / Concox', osmand: 'OsmAnd',
            flespi: 'Flespi', totem: 'Totem', tk103: 'TK103', gps103: 'GPS103', h02: 'H02',
        };
        const nativeGroup = document.createElement('optgroup');
        nativeGroup.label = 'Native (direct connection)';
        [...availableProtocols].sort().forEach(p => {
            const opt       = document.createElement('option');
            opt.value       = p;
            opt.textContent = nativeNames[p] || (p.charAt(0).toUpperCase() + p.slice(1));
            nativeGroup.appendChild(opt);
        });
        sel.appendChild(nativeGroup);

        // External integrations
        if (integrationProviders.length) {
            const intgGroup = document.createElement('optgroup');
            intgGroup.label = 'External Integrations';
            integrationProviders.forEach(p => {
                const opt               = document.createElement('option');
                opt.value               = p.provider_id;
                opt.textContent         = p.display_name;
                opt.dataset.integration = 'true';
                intgGroup.appendChild(opt);
            });
            sel.appendChild(intgGroup);
        }

        sel.addEventListener('change', () => {
            onProtocolChange();
            refreshNativeEventAlerts();
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
        devices    = await res.json();
        allDevices = [...devices];

        await Promise.all(devices.map(async device => {
            try {
                const sr = await apiFetch(`${API_BASE}/devices/${device.id}/state`);
                if (sr.ok) device.state = await sr.json();
            } catch { /* ignore */ }
            try {
                const cr = await apiFetch(`${API_BASE}/devices/${device.id}/command-support`);
                device.supports_commands = cr.ok ? (await cr.json()).supports_commands : false;
            } catch { device.supports_commands = false; }
        }));

        devices.sort((a, b) => a.name.localeCompare(b.name));
        allDevices = [...devices];
        renderDeviceTable(devices);
    } catch (e) {
        showAlert('Failed to load devices', 'error');
        console.error(e);
    }
}

async function loadGeofencesForDevice(deviceId) {
    try {
        const res = await apiFetch(`${API_BASE}/geofences?device_id=${deviceId}`);
        if (!res.ok) return [];
        return (await res.json()).map(g => ({ value: String(g.id), label: g.name }));
    } catch { return []; }
}

// ── Device Table ──────────────────────────────────────────────────
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
    renderDeviceTable([...filtered].sort((a, b) => a.name.localeCompare(b.name)));
}

function renderDeviceTable(list) {
    const tbody = document.getElementById('devicesTableBody');
    const count = document.getElementById('devicesCount');
    count.textContent = `${list.length} device${list.length !== 1 ? 's' : ''}`;

    if (!list.length) {
        tbody.innerHTML = `
            <tr><td colspan="7" style="text-align:center;padding:3rem;color:var(--text-muted);">
                <div style="font-size:2.5rem;margin-bottom:0.75rem;">📡</div>
                No devices found
            </td></tr>`;
        return;
    }

    tbody.innerHTML = list.map(d => {
        const icon     = (VEHICLE_ICONS[d.vehicle_type] || VEHICLE_ICONS['other']).emoji;
        const lastSeen = d.state?.last_update ? formatDateToLocal(d.state.last_update) : '—';
        const odometer = d.state?.total_odometer != null ? `${d.state.total_odometer.toFixed(0)} km` : '—';
        const plate    = d.license_plate || '—';
        const cmds     = d.supports_commands !== false;

        return `
        <tr class="device-row" ondblclick="openDeviceModal(${d.id},'general')">
            <td style="text-align:center;font-size:1.25rem;">${icon}</td>
            <td>
                <span class="device-row-name">${_esc(d.name)}</span>
                <div class="device-row-imei">${_esc(d.imei)}</div>
            </td>
            <td>${protoBadgeHtml(d.protocol)}</td>
            <td>${_esc(plate)}</td>
            <td style="font-size:0.85rem;color:var(--text-secondary);">${lastSeen}</td>
            <td style="font-family:var(--font-mono);font-size:0.85rem;">${odometer}</td>
            <td style="text-align:right;white-space:nowrap;">
                ${cmds ? `<button class="btn btn-secondary tbl-btn" onclick="openCommandModal(${d.id})">📡</button>` : ''}
                <button class="btn btn-secondary tbl-btn" onclick="openDeviceModal(${d.id},'general')">✏️ Edit</button>
            </td>
        </tr>`;
    }).join('');
}

// ── Modal Tab Switcher ────────────────────────────────────────────
function switchModalTab(tabId, btn) {
    document.querySelectorAll('.modal-tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.modal-tab').forEach(el => el.classList.remove('active'));
    document.getElementById(`tab-${tabId}`)?.classList.add('active');
    (btn || document.querySelector(`.modal-tab[data-tab="${tabId}"]`))?.classList.add('active');
    if (tabId === 'rawdata' && editingDeviceId) loadRawDataForModal(editingDeviceId);
}

// ── Open / Close Device Modal ─────────────────────────────────────
function openAddDeviceModal() {
    if (!isAdmin) return;
    editingDeviceId = null;

    document.getElementById('modalTitle').textContent        = 'Add New Device';
    document.getElementById('submitText').textContent        = 'Add Device';
    document.getElementById('deleteDeviceBtn').style.display = 'none';
    document.getElementById('deviceForm').reset();
    document.getElementById('deviceProtocol').value          = DEFAULT_PROTOCOL;
    document.getElementById('currentOdometer').value         = '0.0';
    document.getElementById('offlineTimeoutHours').value     = '24';

    populateVehicleTypeSelect(document.getElementById('vehicleType'), DEFAULT_TYPE);

    // Reset integration panel
    const panel = document.getElementById('integrationFieldsPanel');
    if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
    const imeiInput = document.getElementById('deviceImei');
    if (imeiInput) { imeiInput.required = true; imeiInput.closest('.form-group').style.display = ''; }

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

    document.getElementById('modalTitle').textContent        = 'Edit Device';
    document.getElementById('submitText').textContent        = 'Save Changes';
    document.getElementById('deleteDeviceBtn').style.display = isAdmin ? 'inline-flex' : 'none';

    document.getElementById('deviceName').value          = d.name;
    document.getElementById('deviceImei').value          = d.imei;
    document.getElementById('deviceProtocol').value      = d.protocol || DEFAULT_PROTOCOL;
    document.getElementById('licensePlate').value        = d.license_plate || '';
    document.getElementById('vin').value                 = d.vin || '';
    document.getElementById('currentOdometer').value     =
        d.state?.total_odometer != null ? d.state.total_odometer.toFixed(1) : '0.0';
    document.getElementById('offlineTimeoutHours').value =
        d.config?.offline_timeout_hours ?? 24;

    populateVehicleTypeSelect(document.getElementById('vehicleType'), d.vehicle_type || DEFAULT_TYPE);

    // Restore integration fields if this is an integration device
    restoreIntegrationFields(d);
    if (!d.config?.integration?.provider) onProtocolChange();

    loadAlertsFromConfig(d.config || {});
    switchModalTab(startTab);
    refreshNativeEventAlerts();
    document.getElementById('deviceModal').classList.add('active');
}

function closeDeviceModal() {
    document.getElementById('deviceModal').classList.remove('active');
}

function editDevice(id)       { openDeviceModal(id, 'general'); }
function openRawDataModal(id) { openDeviceModal(id, 'rawdata'); }

// ── Commands Modal ────────────────────────────────────────────────
function openCommandModal(deviceId) {
    currentCommandDeviceId = deviceId;
    currentCommandDevice   = devices.find(d => d.id == deviceId);
    if (!currentCommandDevice) return;
    document.getElementById('commandDeviceName').textContent = currentCommandDevice.name;
    document.getElementById('commandModal').classList.add('active');
    switchCommandTab('send');
    loadAvailableCommands();
}

// ── Form Submit ───────────────────────────────────────────────────
async function handleSubmit(event) {
    event.preventDefault();
    const submitBtn  = document.getElementById('submitBtn');
    const submitText = document.getElementById('submitText');
    const submitLoad = document.getElementById('submitLoading');
    submitBtn.disabled       = true;
    submitText.style.display = 'none';
    submitLoad.style.display = 'inline-block';

    try {
        const existingConfig = editingDeviceId
            ? (devices.find(d => d.id === editingDeviceId)?.config || {})
            : {};

        const newConfig = buildConfigFromAlertRows(existingConfig);
        newConfig.sensors                = existingConfig.sensors     || {};
        newConfig.maintenance            = existingConfig.maintenance || {};
        newConfig.speed_duration_seconds = existingConfig.speed_duration_seconds || 30;
        newConfig.offline_timeout_hours  = parseInt(document.getElementById('offlineTimeoutHours').value) || 24;

        // ── Integration config ────────────────────────────────────
        const isIntg     = _isIntegrationSelected();
        const providerId = document.getElementById('deviceProtocol').value;
        const provider   = isIntg ? integrationProviders.find(p => p.provider_id === providerId) : null;

        if (isIntg && provider) {
            const existingSel  = document.getElementById('intgAccountSelect');
            const accountId    = existingSel?.value ? parseInt(existingSel.value) : null;
            const account      = accountId ? integrationAccounts.find(a => a.id === accountId) : null;
            const accountLabel = account?.account_label
                ?? document.getElementById('intgAccountLabel')?.value?.trim() ?? '';
            const remoteId     = document.getElementById('intgRemoteId')?.value?.trim() ?? '';

            if (!accountId && accountLabel) {
                await _ensureAccount(provider);
            }

            newConfig.integration = {
                provider:      providerId,
                account_label: accountLabel,
                remote_id:     remoteId,
            };
        }

        // Auto-generate IMEI for integrations
        let imei = document.getElementById('deviceImei').value.trim();
        if (isIntg && !imei) {
            const remoteId = newConfig.integration?.remote_id || Date.now();
            imei = `EXT-${providerId}-${remoteId}`.slice(0, 20);
        }

        const payload = {
            name:          document.getElementById('deviceName').value.trim(),
            imei,
            protocol:      providerId || DEFAULT_PROTOCOL,
            vehicle_type:  document.getElementById('vehicleType').value    || DEFAULT_TYPE,
            license_plate: document.getElementById('licensePlate').value   || null,
            vin:           document.getElementById('vin').value            || null,
            config:        newConfig,
        };

        let response;
        if (editingDeviceId) {
            const odo = parseFloat(document.getElementById('currentOdometer').value) || null;
            const url = `${API_BASE}/devices/${editingDeviceId}${odo !== null ? `?new_odometer=${odo}` : ''}`;
            response  = await apiFetch(url, {
                method:  'PUT',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(payload),
            });
        } else {
            response = await apiFetch(`${API_BASE}/devices`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(payload),
            });
        }

        if (response.ok) {
            showAlert(editingDeviceId ? 'Device updated' : 'Device added', 'success');
            closeDeviceModal();
            await loadDevices();
        } else {
            const err = await response.json();
            showAlert(err.detail || 'Failed to save device', 'error');
        }
    } catch (e) {
        showAlert('Failed to save device', 'error');
        console.error(e);
    } finally {
        submitBtn.disabled       = false;
        submitText.style.display = 'inline';
        submitLoad.style.display = 'none';
    }
}

// ── Delete Device ─────────────────────────────────────────────────
async function deleteCurrentDevice() {
    if (!editingDeviceId || !isAdmin) return;
    const d = devices.find(x => x.id === editingDeviceId);
    if (!confirm(`Delete "${d?.name || 'this device'}"?\n\nThis cannot be undone.`)) return;
    try {
        const res = await apiFetch(`${API_BASE}/devices/${editingDeviceId}`, { method: 'DELETE' });
        if (res.ok) {
            showAlert('Device deleted', 'success');
            closeDeviceModal();
            await loadDevices();
        } else {
            const err = await res.json();
            showAlert(err.detail || 'Failed to delete device', 'error');
        }
    } catch (e) { showAlert('Failed to delete device', 'error'); }
}

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
            if (config[key] != null)
                alertRows.push({ uid: nextUid(), alertKey: key, value: config[key], channels: ch[key] || [], schedule: null });
        }
        (config.custom_rules || []).forEach(r => {
            const obj = typeof r === 'string' ? { name: 'Custom Alert', rule: r, channels: [] } : r;
            alertRows.push({ uid: nextUid(), alertKey: '__custom__', name: obj.name, rule: obj.rule, channels: obj.channels || [], schedule: null });
        });
    }
    renderAlertsTable();
    populateAddAlertDropdown();
}

function populateAddAlertDropdown() {
    const sel = document.getElementById('addAlertSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">Select a system alert…</option>';
    const grp   = document.createElement('optgroup');
    grp.label   = 'System Alerts';
    for (const [key, def] of Object.entries(ALERT_TYPES)) {
        const opt       = document.createElement('option');
        opt.value       = key;
        opt.textContent = `${def.icon || '🔔'} ${def.label}`;
        grp.appendChild(opt);
    }
    sel.appendChild(grp);
}

function refreshNativeEventAlerts() {
    const protocol = document.getElementById('deviceProtocol').value;
    const events   = protocolInfo[protocol]?.native_events || [];

    const existing = document.getElementById('nativeEventsOptgroup');
    if (existing) existing.remove();
    if (!events.length) return;

    const addSel = document.getElementById('addAlertSelect');
    const grp    = document.createElement('optgroup');
    grp.id       = 'nativeEventsOptgroup';
    grp.label    = 'Device Native Events';

    events.forEach(ev => {
        const opt       = document.createElement('option');
        opt.value       = `__native__:${JSON.stringify(ev)}`;
        opt.textContent = ev.label;
        grp.appendChild(opt);
    });

    addSel.appendChild(grp);
}

function addSelectedAlert() {
    const sel = document.getElementById('addAlertSelect');
    const val = sel.value;
    if (!val) return;

    if (val.startsWith('__native__:')) {
        try {
            const eventDef = JSON.parse(val.slice('__native__:'.length));
            alertRows.push({
                uid:      nextUid(),
                alertKey: 'device_event',
                params: {
                    sensor_key:     eventDef.key,
                    trigger_value:  eventDef.trigger_value  ?? '',
                    trigger_values: eventDef.trigger_values ?? [],
                    event_label:    eventDef.label.replace(/^[\p{Emoji}\s]+/u, '').trim(),
                    event_icon:     (eventDef.label.match(/^\p{Emoji}/u) || ['📡'])[0],
                    severity:       eventDef.severity,
                },
                channels: [],
                schedule: null,
            });
        } catch(e) {
            console.error('Failed to parse native event def', e);
        }
        renderAlertsTable();
        sel.value = '';
        return;
    }

    const def = ALERT_TYPES[val];
    if (!def) return;
    const params = {};
    (def.fields || []).forEach(f => { params[f.key] = f.default; });
    alertRows.push({ uid: nextUid(), alertKey: val, params, channels: [], schedule: null });
    renderAlertsTable();
    sel.value = '';
}

function addCustomRule() {
    const nameEl = document.getElementById('newRuleName');
    const ruleEl = document.getElementById('newRuleCond');
    const name   = nameEl.value.trim();
    const rule   = ruleEl.value.trim();
    if (!name || !rule) return;
    alertRows.push({ uid: nextUid(), alertKey: '__custom__', name, rule, channels: [], schedule: null, duration: null });
    nameEl.value = '';
    ruleEl.value = '';
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
    if (!alertRows.length) { if (emptyRow) emptyRow.style.display = ''; return; }
    if (emptyRow) emptyRow.style.display = 'none';

    alertRows.forEach((row, idx) => {
        const isCustom = row.alertKey === '__custom__';
        const def      = isCustom ? null : ALERT_TYPES[row.alertKey];

        const isDeviceEvent = row.alertKey === 'device_event';

        const label = isCustom
            ? `<span class="custom-alert-module"><span class="custom-alert-module-title">⚡ ${_esc(row.name)}</span></span>`
            : isDeviceEvent
            ? `<span class="alert-type-label system">${_esc(row.params?.event_icon || '📡')} ${_esc(row.params?.event_label || row.params?.sensor_key || 'Device Event')}</span>`
            : (def?.icon ? `${def.icon} ` : '') + _esc(def?.label || row.alertKey);

        let thresh;
        if (isCustom) {
            const durBadge = row.duration
                ? `<span class="alert-threshold-badge" style="margin-left:0.3rem;">
                       <small style="color:var(--text-muted);margin-right:0.2rem;">for:</small>
                       ${row.duration}s
                   </span>`
                : '';
            thresh = `<span class="alert-threshold-badge">
                <small style="color:var(--text-muted);margin-right:0.2rem;">condition:</small>
                ${row.rule}
            </span>${durBadge}`;
        } else if (isDeviceEvent) {
            const tv = row.params?.trigger_values?.length
                ? row.params.trigger_values.join(', ')
                : row.params?.trigger_value || 'any';
            const durBadge = row.duration
                ? `<span class="alert-threshold-badge" style="margin-left:0.3rem;">
                       <small style="color:var(--text-muted);margin-right:0.2rem;">for:</small>
                       ${row.duration}s
                   </span>`
                : '';
            thresh = `<span class="alert-threshold-badge">
                <small style="color:var(--text-muted);margin-right:0.2rem;">trigger:</small>
                ${_esc(String(tv))}
            </span>${durBadge}`;
        } else {
            const visibleFields = (def?.fields || []).filter(f => f.field_type !== 'checkbox');
            const badges = visibleFields.map(f => {
                const val = row.params?.[f.key];
                if (val == null || val === '') return null;
                let display = val;
                if (f.field_type === 'select' && f.options?.length) {
                    const opt = f.options.find(o => String(o.value) === String(val));
                    if (opt) display = opt.label;
                }
                return `<span class="alert-threshold-badge">
                    <small style="color:var(--text-muted);margin-right:0.2rem;">${f.label}:</small>
                    ${display}${f.unit ? ` <small>${f.unit}</small>` : ''}
                </span>`;
            }).filter(Boolean);
            thresh = badges.length
                ? badges.join(' ')
                : `<span style="color:var(--text-muted);font-size:0.8rem;">—</span>`;
        }

        const chHtml = (row.channels || []).length
            ? row.channels.map(c => `<span class="channel-pill active" style="pointer-events:none;">${_esc(c)}</span>`).join('')
            : `<span style="color:var(--text-muted);font-size:0.8rem;">None</span>`;

        const sched    = row.schedule;
        const schedHtml = sched?.days?.length
            ? `<span class="schedule-badge">${sched.days.map(d => DAYS[d]).join(', ')}<br>
               <small>${pad(sched.hourStart ?? 0)}:00–${pad(sched.hourEnd ?? 23)}:59</small></span>`
            : `<span style="color:var(--text-muted);font-size:0.8rem;">Always</span>`;

        const tr       = document.createElement('tr');
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
                <button type="button" class="btn btn-danger    tbl-btn" onclick="removeAlertRow(${row.uid})">✕</button>
            </td>`;
        tbody.appendChild(tr);
    });
}

// ── Alert Editor ──────────────────────────────────────────────────
async function openAlertEditor(uid) {
    const row = alertRows.find(r => r.uid === uid);
    if (!row) return;
    editingAlertUid = uid;

    const isCustom = row.alertKey === '__custom__';
    const isDeviceEvent = row.alertKey === 'device_event';
    const def      = isCustom ? null : ALERT_TYPES[row.alertKey];

    document.getElementById('alertEditorTitle').textContent =
        isCustom ? `Edit Custom Rule — ${row.name}` : `Edit ${def?.label || row.alertKey}`;

    let fieldsHtml = '';

    if (!isCustom && def?.fields?.length) {
        for (const f of def.fields) {
            const v = row.params?.[f.key] ?? f.default;
            let inputHtml = '';

            if (f.field_type === 'number') {
                inputHtml = `<div style="display:flex;align-items:center;gap:0.75rem;">
                    <input type="number" class="form-input alert-param-input" data-param-key="${f.key}"
                           value="${v ?? ''}"
                           ${f.min_value != null ? `min="${f.min_value}"` : ''}
                           ${f.max_value != null ? `max="${f.max_value}"` : ''}
                           style="max-width:140px;">
                    ${f.unit ? `<span style="color:var(--text-muted);">${_esc(f.unit)}</span>` : ''}
                </div>`;
            } else if (f.field_type === 'text') {
                inputHtml = `<input type="text" class="form-input alert-param-input"
                    data-param-key="${f.key}" value="${_esc(v ?? '')}">`;
            } else if (f.field_type === 'checkbox') {
                inputHtml = `<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;">
                    <input type="checkbox" class="alert-param-input" data-param-key="${f.key}"
                           ${v ? 'checked' : ''} style="width:auto;">
                    <span style="font-size:0.875rem;">${_esc(f.label)}</span>
                </label>`;
            } else if (f.field_type === 'select') {
                const opts = (f.options || []).map(o =>
                    `<option value="${_esc(o.value)}"${o.value == v ? ' selected' : ''}>${_esc(o.label)}</option>`
                ).join('');
                inputHtml = `<select class="form-input alert-param-input" data-param-key="${f.key}">${opts}</select>`;
            }

            if (f.field_type !== 'checkbox') {
                fieldsHtml += `<div class="form-group" style="margin-bottom:1rem;">
                    <label class="form-label">${_esc(f.label)}</label>
                    ${inputHtml}
                    ${f.help_text ? `<div class="form-help">${_esc(f.help_text)}</div>` : ''}
                </div>`;
            } else {
                fieldsHtml += `<div class="form-group" style="margin-bottom:1rem;">${inputHtml}</div>`;
            }
        }
    }

    if (isCustom) {
        const durEnabled = row.duration != null;
        const durVal     = row.duration ?? 60;
        fieldsHtml = `
        <div class="form-group" style="margin-bottom:1rem;">
            <label class="form-label">Rule Name</label>
            <input type="text" class="form-input" id="editor-custom-name" value="${_esc(row.name || '')}">
        </div>
        <div class="form-group" style="margin-bottom:1rem;">
            <label class="form-label">Condition</label>
            <input type="text" class="form-input" id="editor-custom-rule" value="${_esc(row.rule || '')}">
            <div class="form-help">e.g. <code>speed &gt; 90 and ignition</code></div>
        </div>
        <div class="form-group" style="margin-bottom:1rem;">
            <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;margin-bottom:0.5rem;">
                <input type="checkbox" id="editor-duration-enabled" ${durEnabled ? 'checked' : ''} style="width:auto;">
                <span class="form-label" style="margin:0;">Require sustained condition</span>
            </label>
            <div style="display:flex;align-items:center;gap:0.5rem;">
                <input type="number" class="form-input" id="editor-duration-input"
                       value="${durVal}" min="1" style="max-width:100px;" ${durEnabled ? '' : 'disabled'}>
                <span style="color:var(--text-muted);">seconds</span>
            </div>
        </div>`;
        // Wire the checkbox
        setTimeout(() => {
            const cb = document.getElementById('editor-duration-enabled');
            const in_ = document.getElementById('editor-duration-input');
            if (cb && in_) cb.addEventListener('change', () => { in_.disabled = !cb.checked; });
        }, 0);
    } else if (isDeviceEvent) {
        const durEnabled = row.duration != null;
        const durVal     = row.duration ?? 30;
        fieldsHtml = `
        <div class="form-group" style="margin-bottom:1rem;">
            <label class="form-label">Event</label>
            <input type="text" class="form-input" value="${_esc(row.params?.event_label || row.params?.sensor_key || '')}" disabled style="opacity:0.6;">
        </div>
        <div class="form-group" style="margin-bottom:1rem;">
            <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;margin-bottom:0.5rem;">
                <input type="checkbox" id="editor-duration-enabled" ${durEnabled ? 'checked' : ''} style="width:auto;">
                <span class="form-label" style="margin:0;">Require sustained condition</span>
            </label>
            <div style="display:flex;align-items:center;gap:0.5rem;">
                <input type="number" class="form-input" id="editor-duration-input"
                       value="${durVal}" min="1" style="max-width:100px;" ${durEnabled ? '' : 'disabled'}>
                <span style="color:var(--text-muted);">seconds</span>
            </div>
        </div>`;
        setTimeout(() => {
            const cb  = document.getElementById('editor-duration-enabled');
            const inp = document.getElementById('editor-duration-input');
            if (cb && inp) cb.addEventListener('change', () => { inp.disabled = !cb.checked; });
        }, 0);
    }

    const activeDays = row.schedule?.days || [];
    const hourStart  = row.schedule?.hourStart ?? 0;
    const hourEnd    = row.schedule?.hourEnd   ?? 23;

    const dayPickerHtml = DAYS.map((day, i) => `
        <label class="day-pill${activeDays.includes(i) ? ' active' : ''}">
            <input type="checkbox" value="${i}"${activeDays.includes(i) ? ' checked' : ''}> ${day}
        </label>`).join('');

    const hourOpts    = sel => Array.from({ length: 24 }, (_, h) =>
        `<option value="${h}"${h === sel ? ' selected' : ''}>${pad(h)}:00</option>`).join('');
    const hourEndOpts = Array.from({ length: 24 }, (_, h) =>
        `<option value="${h}"${h === hourEnd ? ' selected' : ''}>${pad(h)}:59</option>`).join('');

    const chHtml = userChannels.length
        ? userChannels.map(c => `
            <label class="channel-pill${(row.channels || []).includes(c.name) ? ' active' : ''}">
                <input type="checkbox" class="editor-channel-cb" value="${_esc(c.name)}"${(row.channels || []).includes(c.name) ? ' checked' : ''}>
                ${_esc(c.name)}
            </label>`).join('')
        : '<span style="color:var(--text-muted);font-size:0.875rem;">No notification channels configured.</span>';

    document.getElementById('alertEditorBody').innerHTML = `
        <div style="display:flex;flex-direction:column;gap:0.25rem;">
            ${def?.description ? `<p style="color:var(--text-muted);font-size:0.85rem;margin:0 0 1rem;">${_esc(def.description)}</p>` : ''}
            ${fieldsHtml}
        </div>
        <div class="form-group" style="margin-top:1.25rem;">
            <label class="form-label">Notify Via</label>
            <div style="display:flex;flex-wrap:wrap;gap:0.4rem;">${chHtml}</div>
        </div>
        <div class="form-group">
            <label class="form-label">Schedule
                <span style="font-weight:400;color:var(--text-muted);"> (no days = always active)</span>
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
                    <select class="form-input" id="editor-hour-end"   style="width:100px;">${hourEndOpts}</select>
                </div>
            </div>
        </div>`;

    document.querySelectorAll('#editor-day-picker .day-pill').forEach(pill => {
        const cb = pill.querySelector('input');
        if (!cb) return;
        pill.classList.toggle('active', cb.checked);
        pill.addEventListener('click', () => { cb.checked = !cb.checked; pill.classList.toggle('active', cb.checked); });
    });
    document.querySelectorAll('#alertEditorBody .channel-pill').forEach(pill => {
        const cb = pill.querySelector('input');
        if (!cb) return;
        pill.addEventListener('click', () => { cb.checked = !cb.checked; pill.classList.toggle('active', cb.checked); });
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
    const isDeviceEvent = row.alertKey === 'device_event';

    if (isCustom) {
        const n   = document.getElementById('editor-custom-name')?.value.trim();
        const r   = document.getElementById('editor-custom-rule')?.value.trim();
        if (n) row.name = n;
        if (r) row.rule = r;
        const durEnabled = document.getElementById('editor-duration-enabled')?.checked;
        const durVal     = parseInt(document.getElementById('editor-duration-input')?.value);
        row.duration     = durEnabled && !isNaN(durVal) && durVal > 0 ? durVal : null;
    } else if (isDeviceEvent) {
        const durEnabled = document.getElementById('editor-duration-enabled')?.checked;
        const durVal     = parseInt(document.getElementById('editor-duration-input')?.value);
        row.duration     = durEnabled && !isNaN(durVal) && durVal > 0 ? durVal : null;
    } else {
        if (!row.params) row.params = {};
        document.querySelectorAll('#alertEditorBody .alert-param-input').forEach(input => {
            const key = input.dataset.paramKey;
            if (!key) return;
            if (input.type === 'checkbox')     row.params[key] = input.checked;
            else if (input.type === 'number')  { const v = parseFloat(input.value); if (!isNaN(v)) row.params[key] = v; }
            else                               row.params[key] = input.value;
        });
    }

    row.channels = [];
    document.querySelectorAll('.editor-channel-cb:checked').forEach(cb => row.channels.push(cb.value));

    const activeDays = [];
    document.querySelectorAll('#editor-day-picker input:checked').forEach(cb => activeDays.push(parseInt(cb.value)));
    const hs   = parseInt(document.getElementById('editor-hour-start').value);
    const he   = parseInt(document.getElementById('editor-hour-end').value);
    row.schedule = activeDays.length ? { days: activeDays.sort((a, b) => a - b), hourStart: hs, hourEnd: he } : null;

    closeAlertEditor();
    renderAlertsTable();
}

function buildConfigFromAlertRows(existing = {}) {
    const config = { ...existing, alert_rows: [], alert_channels: {}, custom_rules: [] };
    ['speed_tolerance', 'idle_timeout_minutes', 'offline_timeout_hours',
     'towing_threshold_meters', 'speed_duration_seconds'].forEach(k => delete config[k]);
    alertRows.forEach(row => {
        config.alert_rows.push({ ...row });
        if (row.alertKey === '__custom__')
            config.custom_rules.push({ name: row.name, rule: row.rule, channels: row.channels || [] });
        else
            config.alert_channels[row.alertKey] = row.channels || [];
    });
    return config;
}

// ================================================================
//  RAW DATA TAB
// ================================================================

async function loadRawDataForModal(deviceId) {
    currentRawDeviceId = deviceId;
    currentPage        = 1;
    const tbody        = document.getElementById('rawDataBody');
    tbody.innerHTML    = '<tr><td colspan="10" style="text-align:center;padding:2rem;">Loading…</td></tr>';

    const end = new Date();
    try {
        const start24h = new Date(end - 86_400_000);
        const res24h   = await apiFetch(`${API_BASE}/positions/history`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ device_id: deviceId, start_time: start24h.toISOString(), end_time: end.toISOString(), max_points: 5000, order: 'desc' }),
        });
        if (!res24h.ok) throw new Error(`${res24h.status}`);
        rawData = (await res24h.json()).features || [];

        if (!rawData.length) {
            const start30d = new Date(end - 86_400_000 * 30);
            const res30d   = await apiFetch(`${API_BASE}/positions/history`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ device_id: deviceId, start_time: start30d.toISOString(), end_time: end.toISOString(), max_points: 150, order: 'desc' }),
            });
            if (!res30d.ok) throw new Error(`${res30d.status}`);
            rawData = (await res30d.json()).features || [];
        }
        renderRawDataPage();
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--accent-danger);">Failed to load: ${e.message}</td></tr>`;
    }
}

function changeRawDataPage(delta) {
    const max   = Math.ceil(rawData.length / itemsPerPage) || 1;
    currentPage = Math.max(1, Math.min(max, currentPage + delta));
    renderRawDataPage();
}

function renderRawDataPage() {
    const tbody = document.getElementById('rawDataBody');
    const slice = rawData.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);
    tbody.innerHTML = '';

    if (!slice.length) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:2rem;color:var(--text-muted);">No data available.</td></tr>';
        return;
    }

    slice.forEach(feat => {
        const p       = feat.properties || feat;
        const coords  = feat.geometry?.coordinates || [p.longitude, p.latitude];
        const sensors = { ...(p.sensors || {}) };
        delete sensors.raw;
        const attrStr = Object.entries(sensors)
            .map(([k, v]) => {
                if (k === 'beacon_ids' && Array.isArray(v)) {
                    const summary = v.map(b => `${b.id}${b.rssi !== undefined ? ` (${b.rssi}dBm)` : ''}`).join(', ');
                    return `${k}: [${summary}]`;
                }
                if (Array.isArray(v) || (v !== null && typeof v === 'object')) return `${k}:${JSON.stringify(v)}`;
                return `${k}:${v}`;
            })
            .join(' | ');

        const gpsTime    = formatDateToLocal(p.time);
        const serverTime = p.server_time ? formatDateToLocal(p.server_time) : '—';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="white-space:nowrap;">${gpsTime}</td>
            <td style="white-space:nowrap;color:var(--text-muted);font-size:0.8em;">${serverTime}</td>
            <td>${coords[1].toFixed(5)}</td>
            <td>${coords[0].toFixed(5)}</td>
            <td>${(p.speed  || 0).toFixed(1)} km/h</td>
            <td>${(p.course || 0).toFixed(0)}°</td>
            <td>${p.satellites || 0}</td>
            <td>${(p.altitude  || 0).toFixed(0)} m</td>
            <td>${p.ignition ? 'ON' : 'OFF'}</td>
            <td style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono);font-size:0.72rem;"
                title="${_esc(attrStr)}">${_esc(attrStr)}</td>`;
        tbody.appendChild(tr);
    });

    const max = Math.ceil(rawData.length / itemsPerPage) || 1;
    document.getElementById('pageInfo').textContent = `Page ${currentPage} of ${max}`;
    document.getElementById('prevPageBtn').disabled = currentPage === 1;
    document.getElementById('nextPageBtn').disabled = currentPage === max;
}

// ================================================================
//  ALERTS MODAL SHIMS (device-management page compatibility)
// ================================================================
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
            const icon = alert.type === 'speeding' ? '⚡' : alert.type === 'offline' ? '📴' : '🔔';
            const item = document.createElement('div');
            item.className = `alert-item ${alert.severity}`;
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
    try {
        const r = await apiFetch(`${API_BASE}/alerts/${id}/read`, { method: 'POST' });
        if (r.ok) loadAlerts();
    } catch { /* ignore */ }
}

function openAlertsModal()  { loadAlerts(); document.getElementById('alertsModal')?.classList.add('active'); }
function closeAlertsModal() { document.getElementById('alertsModal')?.classList.remove('active'); }

async function clearAllAlerts() {
    if (!loadedAlerts.length || !confirm('Mark all alerts as read?')) return;
    for (const a of loadedAlerts) {
        try { await apiFetch(`${API_BASE}/alerts/${a.id}/read`, { method: 'POST' }); } catch { /* ignore */ }
    }
    loadAlerts();
    showAlert('All alerts cleared', 'success');
}

function showAlert(message, type) {
    const el = document.createElement('div');
    el.className = `alert alert-${type}`;
    el.innerHTML = `<span>${type === 'success' ? '✅' : '❌'} ${message}</span>`;
    document.getElementById('alertContainer')?.appendChild(el);
    setTimeout(() => el.remove(), 4000);
}