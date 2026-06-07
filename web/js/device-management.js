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
let sortCol              = 'name';
let sortDir              = 1; // 1 = asc, -1 = desc
let userChannels         = [];
let editingDeviceId      = null;

// Alerts tab
let alertRows            = [];
let editingAlertUid      = null;
let uidCounter           = 0;
let cachedGeofenceOptions = [];  // { value, label } for current device
let cachedDriverOptions   = [];  // { value, label } — loaded once per modal open
let ALERT_TYPES     = {};
let protocolInfo = {};

// Raw data tab
let rawData            = [];
let currentPage        = 1;
const itemsPerPage     = 50;
let currentRawDeviceId = null;

// Users tab
let allUsers                = [];
let allUsersLoaded          = false;
let allUsersLoadPromise     = null;
let allUsersLoadFailed      = false;
let notifyUsersResolvePromise = null;
let notifyUserLoadPromises  = new Map();
let notifyUserLoadFailedIds = new Set();
let deviceAlertUsers        = [];
let deviceAssignedUserIds   = new Set();

// Companies
let allCompanies            = [];

// Unsaved-changes guard
let _deviceModalSnapshot    = null;

// ── Constants ────────────────────────────────────────────────────
const DAYS             = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_PROTOCOL = 'teltonika';
const DEFAULT_TYPE     = 'car';
const isAdmin          = localStorage.getItem('is_admin') === 'true';
const isCompanyAdmin   = localStorage.getItem('is_company_admin') === 'true';
const hasAdminAccess   = isAdmin || isCompanyAdmin;

// ── Helpers ───────────────────────────────────────────────────────
function nextUid() { return ++uidCounter; }
function pad(n)    { return String(n).padStart(2, '0'); }

function _toId(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
}

function _idSet(values) {
    return new Set((values || []).map(_toId).filter(id => id !== null));
}

function _sameId(a, b) {
    const aid = _toId(a);
    const bid = _toId(b);
    return aid !== null && bid !== null && aid === bid;
}

function _mergeUsersIntoCache(users) {
    (users || []).forEach(u => {
        if (!u || _toId(u.id) === null) return;
        const existing = allUsers.find(a => _sameId(a.id, u.id));
        if (existing) Object.assign(existing, u);
        else allUsers.push(u);
    });
}

function _findUserById(id) {
    return allUsers.find(u => _sameId(u.id, id))
        || deviceAlertUsers.find(u => _sameId(u.id, id))
        || null;
}

function _hasUnresolvedNotifyUsers() {
    return _missingNotifyUserIds().length > 0;
}

function _missingNotifyUserIds() {
    const missing = new Set();
    alertRows.forEach(row => {
        (row.notify_user_ids || []).forEach(id => {
            const numericId = _toId(id);
            if (numericId !== null && !_findUserById(numericId) && !notifyUserLoadFailedIds.has(numericId)) {
                missing.add(numericId);
            }
        });
    });
    return [...missing];
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
let _devSectionInitialized = false;

async function initDeviceSection() {
    if (_devSectionInitialized) return;
    _devSectionInitialized = true;

    document.querySelectorAll('button[onclick*="openAddDeviceModal"]').forEach(btn => {
        btn.style.display = (hasAdminAccess && hasPermission('edit_devices')) ? '' : 'none';
    });

    const usersTabBtn = document.getElementById('usersTabBtn');
    if (usersTabBtn) usersTabBtn.style.display = 'none';

    if (isAdmin) {
        document.querySelector('.devices-table')?.classList.add('show-company-col');
        document.getElementById('deviceCompanyGroup').style.display = '';
        loadAllCompanies();
    }

    await Promise.all([
        loadAlertTypes(),
        loadAvailableProtocols(),
        loadUserChannels(),
        loadDevices(),
        ...((isAdmin || (isCompanyAdmin && hasPermission('manage_users'))) ? [loadAllUsers()] : []),
    ]);
    populateAddAlertDropdown();
}

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
        const fetchList = [
            apiFetch(`${API_BASE}/protocols`),
            apiFetch(`${API_BASE}/integrations/providers`),
            ...(hasPermission('manage_integrations') ? [apiFetch(`${API_BASE}/integrations/accounts`)] : []),
        ];
        const [protoRes, intgRes, accountsRes] = await Promise.all(fetchList);

        const data           = protoRes.ok    ? await protoRes.json()    : { protocols: [], protocol_info: {} };
        protocolInfo         = data.protocol_info || {};
        integrationProviders = intgRes.ok      ? await intgRes.json()     : [];
        integrationAccounts  = (accountsRes?.ok)  ? await accountsRes.json() : [];
        availableProtocols   = data.protocols || [];

        const sel = document.getElementById('deviceProtocol');
        if (!sel) return;
        sel.innerHTML = '<option value="">-- Select Protocol --</option>';

        const nativeNames = {
            teltonika: 'Teltonika', gt06: 'GT06 / Concox', osmand: 'OsmAnd',
            flespi: 'Flespi', totem: 'Totem', tk103: 'TK103', gps103: 'GPS103', h02: 'H02',
        };
        const nativeGroup = document.createElement('optgroup');
        nativeGroup.label = 'Native (direct connection)';
        [...availableProtocols].sort().forEach(p => {
            const opt  = document.createElement('option');
            opt.value  = p;
            const info = protocolInfo[p] || {};
            const port = info.port ? ` :${info.port}` : '';
            const type = info.protocol_types?.includes('udp') && info.protocol_types?.includes('tcp')
                ? ' TCP/UDP' : info.protocol_types?.[0]?.toUpperCase() || 'TCP';
            const label = nativeNames[p] || (p.charAt(0).toUpperCase() + p.slice(1));
            opt.textContent = `${label} — port ${info.port || '?'} ${type}`;
            nativeGroup.appendChild(opt);
        });
        sel.appendChild(nativeGroup);

        if (integrationProviders.length) {
            const canManage = hasPermission('manage_integrations');
            const intgGroup = document.createElement('optgroup');
            intgGroup.label = 'External Integrations';
            integrationProviders.forEach(p => {
                const opt               = document.createElement('option');
                opt.value               = p.provider_id;
                opt.textContent         = p.display_name;
                opt.dataset.integration = 'true';
                opt.disabled            = !canManage;
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
        if (typeof permissionsReady !== 'undefined') {
            const currentUser = await permissionsReady;
            if (_sameId(currentUser?.id, userId)) {
                userChannels = currentUser.notification_channels || [];
                return;
            }
        }
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
        devices.sort((a, b) => a.name.localeCompare(b.name));
        allDevices = [...devices];
        const canSendCmds = hasPermission('send_commands');
        devices.forEach(d => {
            d.supports_commands = canSendCmds && (protocolInfo[d.protocol]?.supports_commands ?? false);
        });
        renderDeviceTable(devices);
        _updateClipsTabVisibility();
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

async function _loadDriverOptions() {
    try {
        const res = await apiFetch(`${API_BASE}/drivers`);
        if (!res.ok) return [];
        const drivers = await res.json();
        return [
            { value: '', label: '— Any driver —' },
            ...drivers.map(d => ({ value: String(d.id), label: d.name })),
        ];
    } catch { return []; }
}

// ── Device Table ──────────────────────────────────────────────────
function sortDevices(col) {
    if (sortCol === col) {
        sortDir = -sortDir;
    } else {
        sortCol = col;
        sortDir = 1;
    }
    updateSortHeaders();
    filterDevices();
}

function updateSortHeaders() {
    document.querySelectorAll('.devices-table th[data-sort]').forEach(th => {
        const col = th.dataset.sort;
        th.dataset.sortDir = col === sortCol ? (sortDir === 1 ? 'asc' : 'desc') : '';
    });
}

function _deviceSortValue(d, col) {
    switch (col) {
        case 'name':      return (d.name || '').toLowerCase();
        case 'protocol':  return (d.protocol || '').toLowerCase();
        case 'plate':     return (d.license_plate || '').toLowerCase();
        case 'company':   return (allCompanies.find(c => c.id === d.company_id)?.name || '').toLowerCase();
        case 'last_seen': return d.state?.last_update ? new Date(d.state.last_update).getTime() : -Infinity;
        case 'odometer':  return d.state?.total_odometer ?? -Infinity;
        default:          return '';
    }
}

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
    const sorted = [...filtered].sort((a, b) => {
        const av = _deviceSortValue(a, sortCol);
        const bv = _deviceSortValue(b, sortCol);
        if (av < bv) return -sortDir;
        if (av > bv) return sortDir;
        return 0;
    });
    renderDeviceTable(sorted);
}

function renderDeviceTable(list) {
    const tbody = document.getElementById('devicesTableBody');
    const count = document.getElementById('devicesCount');
    count.textContent = `${list.length} device${list.length !== 1 ? 's' : ''}`;

    if (!list.length) {
        tbody.innerHTML = `
            <tr><td colspan="7" style="text-align:center;padding:3rem;color:var(--text-muted);">
                <div style="font-size:2.5rem;margin-bottom:0.75rem;"><i class="mdi mdi-antenna"></i></div>
                No devices found
            </td></tr>`;
        return;
    }

    tbody.innerHTML = list.map(d => {
        const icon        = (VEHICLE_ICONS[d.vehicle_type] || VEHICLE_ICONS['other']).emoji;
        const lastSeen    = d.state?.last_update ? formatDateToLocal(d.state.last_update) : '—';
        const odometer    = d.state?.total_odometer != null ? fmtOdometer(d.state.total_odometer) : '—';
        const plate       = d.license_plate || '—';
        const cmds        = d.supports_commands !== false && hasPermission('send_commands');
        const companyName = allCompanies.find(c => c.id === d.company_id)?.name || '—';

        return `
        <tr class="device-row" ondblclick="openDeviceModal(${d.id},'general')">
            <td style="text-align:center;font-size:1.25rem;">${icon}</td>
            <td>
                <span class="device-row-name">${_esc(d.name)}</span>
                <div class="device-row-imei">${_esc(d.imei)}</div>
            </td>
            <td>${protoBadgeHtml(d.protocol)}</td>
            <td>${_esc(plate)}</td>
            <td class="company-col" style="font-size:0.85rem;color:var(--text-secondary);">${_esc(companyName)}</td>
            <td style="font-size:0.85rem;color:var(--text-secondary);">${lastSeen}</td>
            <td style="font-family:var(--font-mono);font-size:0.85rem;">${odometer}</td>
            <td style="text-align:right;white-space:nowrap;">
                ${cmds ? `<button class="btn btn-secondary tbl-btn" onclick="openDeviceModal(${d.id},'commands')" title="Commands"><i class="mdi mdi-antenna"></i></button>` : ''}
                <button class="btn btn-secondary tbl-btn" onclick="openDeviceModal(${d.id},'general')"><i class="mdi mdi-pencil"></i> Edit</button>
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
    const commandTabsBar = document.getElementById('commandTabsBar');
    if (commandTabsBar) commandTabsBar.style.display = tabId === 'commands' ? 'flex' : 'none';
    if (tabId !== 'commands') { clearInterval(commandHistoryInterval); commandHistoryInterval = null; }
    if (tabId === 'rawdata'  && editingDeviceId) loadRawDataForModal(editingDeviceId);
    if (tabId === 'users'    && editingDeviceId) loadUsersForDevice(editingDeviceId);
    if (tabId === 'commands' && editingDeviceId) {
        currentCommandDeviceId = editingDeviceId;
        currentCommandDevice   = devices.find(d => d.id === editingDeviceId);
        switchCommandTab('send');
        loadAvailableCommands();
    }
}

// ── Open / Close Device Modal ─────────────────────────────────────
function openAddDeviceModal() {
    if (!hasAdminAccess || !hasPermission('edit_devices')) return;
    editingDeviceId = null;

    document.getElementById('modalTitle').textContent        = 'Add New Device';
    document.getElementById('submitText').textContent        = 'Add Device';
    document.getElementById('submitIcon').className         = 'mdi mdi-plus';
    document.getElementById('deleteDeviceBtn').style.display = 'none';
    const usersTabBtnAdd = document.getElementById('usersTabBtn');
    if (usersTabBtnAdd) usersTabBtnAdd.style.display = 'none';
    const commandsTabBtnAdd = document.getElementById('commandsTabBtn');
    if (commandsTabBtnAdd) commandsTabBtnAdd.style.display = 'none';
    const rawDataTabBtnAdd = document.querySelector('.modal-tab[data-tab="rawdata"]');
    if (rawDataTabBtnAdd) rawDataTabBtnAdd.style.display = hasPermission('view_history') ? '' : 'none';
    const alertsTabBtnAdd = document.querySelector('.modal-tab[data-tab="alerts"]');
    if (alertsTabBtnAdd) alertsTabBtnAdd.style.display = hasPermission('manage_alerts') ? '' : 'none';
    document.getElementById('deviceForm').reset();
    document.getElementById('deviceProtocol').value          = '';
    document.getElementById('currentOdometer').value         = '0.0';
    document.getElementById('offlineTimeoutHours').value     = '24';

    populateVehicleTypeSelect(document.getElementById('vehicleType'), DEFAULT_TYPE);

    const panel = document.getElementById('integrationFieldsPanel');
    if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
    const imeiInput = document.getElementById('deviceImei');
    if (imeiInput) { imeiInput.required = true; imeiInput.closest('.form-group').style.display = ''; imeiInput.disabled = false; }
    document.getElementById('deviceProtocol').disabled = false;

    if (isAdmin) populateDeviceCompanySelect();

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
    deviceAlertUsers = [];

    document.getElementById('modalTitle').textContent        = 'Edit Device';
    document.getElementById('submitText').textContent        = 'Save';
    document.getElementById('submitIcon').className         = 'mdi mdi-content-save';
    document.getElementById('deleteDeviceBtn').style.display = hasAdminAccess ? 'inline-flex' : 'none';
    const usersTabBtnEdit = document.getElementById('usersTabBtn');
    if (usersTabBtnEdit) usersTabBtnEdit.style.display = ((isCompanyAdmin || (isAdmin && d.company_id)) && hasPermission('manage_users')) ? '' : 'none';
    const commandsTabBtnEdit = document.getElementById('commandsTabBtn');
    if (commandsTabBtnEdit) commandsTabBtnEdit.style.display = (d.supports_commands && hasPermission('send_commands')) ? '' : 'none';
    const rawDataTabBtnEdit = document.querySelector('.modal-tab[data-tab="rawdata"]');
    if (rawDataTabBtnEdit) rawDataTabBtnEdit.style.display = hasPermission('view_history') ? '' : 'none';
    const alertsTabBtnEdit = document.querySelector('.modal-tab[data-tab="alerts"]');
    if (alertsTabBtnEdit) alertsTabBtnEdit.style.display = hasPermission('manage_alerts') ? '' : 'none';
    deviceAssignedUserIds = new Set();

    document.getElementById('deviceName').value          = d.name;
    document.getElementById('deviceImei').value          = d.imei;
    document.getElementById('deviceProtocol').value      = d.protocol || DEFAULT_PROTOCOL;
    document.getElementById('licensePlate').value        = d.license_plate || '';
    renderCustomAttributes(d.custom_attributes || {});
    if (isAdmin) populateDeviceCompanySelect(d.company_id);
    document.getElementById('currentOdometer').value     =
        d.state?.total_odometer != null ? toDisplayDist(d.state.total_odometer) : '0.0';
    document.getElementById('offlineTimeoutHours').value =
        d.config?.offline_timeout_hours ?? 24;
    document.getElementById('tripMergeGapMinutes').value =
        d.config?.trip_merge_gap_minutes ?? 0;
    document.getElementById('deviceHasCamera').checked =
        d.config?.has_camera ?? false;

    const imeiEl     = document.getElementById('deviceImei');
    const protocolEl = document.getElementById('deviceProtocol');
    imeiEl.disabled     = !hasAdminAccess || !hasPermission('edit_devices');
    protocolEl.disabled = !hasAdminAccess || !hasPermission('edit_devices');
    // Lock protocol when it is an integration and the user can't manage integrations
    if (!hasPermission('manage_integrations') && integrationProviders.some(p => p.provider_id === d.protocol)) {
        protocolEl.disabled = true;
    }

    document.getElementById('deleteDeviceBtn').style.display = (hasAdminAccess && hasPermission('edit_devices')) ? 'inline-flex' : 'none';
    document.getElementById('submitBtn').style.display       = '';

    populateVehicleTypeSelect(document.getElementById('vehicleType'), d.vehicle_type || DEFAULT_TYPE);

    restoreIntegrationFields(d);
    if (!d.config?.integration?.provider) onProtocolChange();

    loadGeofencesForDevice(d.id).then(opts => {
        cachedGeofenceOptions = opts;
        renderAlertsTable();
    });
    _loadDriverOptions().then(opts => {
        cachedDriverOptions = opts;
        renderAlertsTable();
    });
    // Ensure the current user is always resolvable in the notify-users lookup
    const _myId = parseInt(localStorage.getItem('user_id'), 10);
    const _myName = localStorage.getItem('username');
    if (_myId && _myName && !allUsers.some(u => _sameId(u.id, _myId))) {
        allUsers.push({ id: _myId, username: _myName });
    }
    if (isCompanyAdmin && !allUsersLoaded) loadDeviceAlertUsers(d.id);
    loadAlertsFromConfig(d.config || {});
    switchModalTab(startTab);
    refreshNativeEventAlerts();
    document.getElementById('deviceModal').classList.add('active');
    _deviceModalSnapshot = _snapshotDeviceModal();
}

function _snapshotDeviceModal() {
    return JSON.stringify({
        name:         document.getElementById('deviceName')?.value,
        imei:         document.getElementById('deviceImei')?.value,
        protocol:     document.getElementById('deviceProtocol')?.value,
        plate:        document.getElementById('licensePlate')?.value,
        vehicleType:  document.getElementById('vehicleType')?.value,
        odometer:     document.getElementById('currentOdometer')?.value,
        offline:      document.getElementById('offlineTimeoutHours')?.value,
        mergeGap:     document.getElementById('tripMergeGapMinutes')?.value,
        customAttrs:  readCustomAttributes(),
        alertRows:    alertRows,
    });
}

function closeDeviceModal(force = false) {
    if (!force && _deviceModalSnapshot && _snapshotDeviceModal() !== _deviceModalSnapshot) {
        if (!confirm('You have unsaved changes. Discard them?')) return;
    }
    _deviceModalSnapshot = null;
    document.getElementById('deviceModal').classList.remove('active');
    clearInterval(commandHistoryInterval);
    commandHistoryInterval = null;
}

function editDevice(id)       { openDeviceModal(id, 'general'); }
function openRawDataModal(id) { openDeviceModal(id, 'rawdata'); }

// ── Commands Tab ──────────────────────────────────────────────────
function openCommandModal(deviceId) {
    openDeviceModal(deviceId, 'commands');
}

// ── Custom Attributes ─────────────────────────────────────────────
function renderCustomAttributes(attrs) {
    const list = document.getElementById('customAttributesList');
    if (!list) return;
    list.innerHTML = '';
    Object.entries(attrs).forEach(([k, v]) => _addCustomAttributeRow(k, v));
}

function addCustomAttribute() {
    _addCustomAttributeRow('', '');
}

function _addCustomAttributeRow(key, value) {
    const list = document.getElementById('customAttributesList');
    if (!list) return;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:0.4rem;align-items:center;';
    row.innerHTML = `
        <input type="text" class="form-input custom-attr-key"   placeholder="Key"   value="${_escAttr(key)}"   style="flex:1;">
        <input type="text" class="form-input custom-attr-value" placeholder="Value" value="${_escAttr(value)}" style="flex:2;">
        <button type="button" class="btn btn-danger" style="padding:0.35rem 0.6rem;" onclick="this.closest('div').remove()"><i class="mdi mdi-close"></i></button>`;
    list.appendChild(row);
    row.querySelector('.custom-attr-key').focus();
}

function _escAttr(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}
function _escAttrJson(v) {
    return JSON.stringify(v).replace(/"/g,'&quot;');
}

function readCustomAttributes() {
    const result = {};
    document.querySelectorAll('#customAttributesList > div').forEach(row => {
        const k = row.querySelector('.custom-attr-key')?.value.trim();
        const v = row.querySelector('.custom-attr-value')?.value.trim();
        if (k) result[k] = v ?? '';
    });
    return result;
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
        newConfig.trip_merge_gap_minutes = parseInt(document.getElementById('tripMergeGapMinutes').value) || 0;
        newConfig.has_camera             = document.getElementById('deviceHasCamera').checked;

        const isIntg     = _isIntegrationSelected();
        const providerId = document.getElementById('deviceProtocol').value;
        const deviceName = document.getElementById('deviceName').value.trim();
        const rawImei    = document.getElementById('deviceImei').value.trim();

        if (!deviceName) {
            showAlert({ title: 'Device name required', message: 'Please enter a device name before saving.', type: 'error' });
            return;
        }

        if (!providerId) {
            showAlert({ title: 'Protocol required', message: 'Please select a protocol before saving.', type: 'error' });
            return;
        }

        if (!isIntg && !rawImei) {
            showAlert({ title: 'IMEI required', message: 'Please enter a device identifier before saving.', type: 'error' });
            return;
        }

        const provider   = isIntg ? integrationProviders.find(p => p.provider_id === providerId) : null;

        if (isIntg && provider) {
            if (!hasAdminAccess) {
                // Non-admins cannot edit integration credentials — preserve as-is
                newConfig.integration = existingConfig.integration || {};
            } else {
                const existingIntegration = existingConfig.integration || {};
                const isExistingIntegration = editingDeviceId && existingIntegration.provider === providerId;
                const existingSel  = document.getElementById('intgAccountSelect');
                const accountId    = existingSel?.value ? parseInt(existingSel.value) : null;
                const account      = accountId ? integrationAccounts.find(a => a.id === accountId) : null;
                const accountLabel = account?.account_label
                    ?? document.getElementById('intgAccountLabel')?.value?.trim() ?? '';
                const remoteId     = document.getElementById('intgRemoteId')?.value?.trim() ?? '';
                const preservingExistingUnlabelledIntegration =
                    isExistingIntegration && !accountId && !accountLabel;

                if (!accountId && !preservingExistingUnlabelledIntegration) {
                    if (!accountLabel) {
                        showAlert({ title: 'Account label required', message: 'Enter an integration account label before saving.', type: 'error' });
                        return;
                    }
                    const missingCredential = (provider.fields || []).find(f =>
                        f.required && !document.getElementById(`intgField_${f.key}`)?.value?.trim()
                    );
                    if (missingCredential) {
                        showAlert({ title: 'Missing credentials', message: `Fill in ${missingCredential.label} before saving.`, type: 'error' });
                        return;
                    }
                }

                if (!accountId && accountLabel) {
                    const createdAccountId = await _ensureAccount(provider);
                    if (!createdAccountId) return;
                }

                newConfig.integration = {
                    provider:      providerId,
                    account_label: accountLabel,
                    remote_id:     remoteId,
                };
            }
        }

        let imei = rawImei;
        if (isIntg && !imei) {
            const remoteId = newConfig.integration?.remote_id || Date.now();
            imei = `EXT-${providerId}-${remoteId}`.slice(0, 64);
        }

        const payload = {
            name:          deviceName,
            imei,
            protocol:      providerId,
            vehicle_type:  document.getElementById('vehicleType').value    || DEFAULT_TYPE,
            license_plate:     document.getElementById('licensePlate').value || null,
            custom_attributes: readCustomAttributes(),
            config:        newConfig,
        };
        if (isAdmin) {
            const companyId = parseInt(document.getElementById('deviceCompany').value) || null;
            payload.company_id = companyId;
        }

        let response;
        if (editingDeviceId) {
            const odoDisplay = parseFloat(document.getElementById('currentOdometer').value) || null;
            const odo = odoDisplay !== null ? fromDisplayDist(odoDisplay) : null;
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
            _deviceModalSnapshot = null;
            closeDeviceModal(true);
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
    if (!editingDeviceId || !hasAdminAccess) return;
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
    sel.innerHTML = '<option value="">Select an alert to add…</option>';

    // Custom rule option
    const customGrp = document.createElement('optgroup');
    customGrp.label = 'Custom';
    const customOpt = document.createElement('option');
    customOpt.value       = '__custom__';
    customOpt.textContent = '★ Custom Rule';
    customGrp.appendChild(customOpt);
    sel.appendChild(customGrp);

    // System alerts group
    const sysGrp = document.createElement('optgroup');
    sysGrp.label = 'System Alerts';
    for (const [key, def] of Object.entries(ALERT_TYPES)) {
        const opt       = document.createElement('option');
        opt.value       = key;
        opt.textContent = `${def.icon || ''} ${def.label}`.trim();
        sysGrp.appendChild(opt);
    }
    sel.appendChild(sysGrp);

}

// Called when the add-alert dropdown changes
function onAddAlertSelectChange() {
    const sel = document.getElementById('addAlertSelect');
    const customFields = document.getElementById('customRuleFields');
    if (!customFields) return;

    if (sel.value === '__custom__') {
        customFields.style.display = 'flex';
        document.getElementById('newRuleName').focus();
    } else {
        customFields.style.display = 'none';
        // Clear the custom fields when switching away
        document.getElementById('newRuleName').value = '';
        document.getElementById('newRuleCond').value = '';
    }
}

function addSelectedAlert() {
    const sel = document.getElementById('addAlertSelect');
    const val = sel.value;
    if (!val) return;

    if (val === '__custom__') {
        addCustomRule();
        return;
    }

    if (val.startsWith('__native__:')) {
        try {
            const eventDef = JSON.parse(val.slice('__native__:'.length));
            const _curUid = parseInt(localStorage.getItem('user_id'), 10);
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
                notify_user_ids: [_curUid],
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
    const currentUserId = parseInt(localStorage.getItem('user_id'), 10);
    alertRows.push({ uid: nextUid(), alertKey: val, params, channels: [], schedule: null, notify_user_ids: [currentUserId] });
    renderAlertsTable();
    sel.value = '';
}

function addCustomRule() {
    const nameEl = document.getElementById('newRuleName');
    const ruleEl = document.getElementById('newRuleCond');
    const name   = nameEl.value.trim();
    const rule   = ruleEl.value.trim();
    if (!name || !rule) {
        // Highlight missing fields
        if (!name) nameEl.style.borderColor = 'var(--accent-danger)';
        if (!rule) ruleEl.style.borderColor = 'var(--accent-danger)';
        setTimeout(() => {
            nameEl.style.borderColor = '';
            ruleEl.style.borderColor = '';
        }, 1500);
        return;
    }
    const currentUserId = parseInt(localStorage.getItem('user_id'), 10);
    alertRows.push({ uid: nextUid(), alertKey: '__custom__', name, rule, channels: [], schedule: null, duration: null, notify_user_ids: [currentUserId] });
    nameEl.value = '';
    ruleEl.value = '';
    // Reset dropdown and hide custom fields
    const sel = document.getElementById('addAlertSelect');
    sel.value = '';
    const customFields = document.getElementById('customRuleFields');
    if (customFields) customFields.style.display = 'none';
    renderAlertsTable();
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

    // Insert native events
    addSel.appendChild(grp);
}

function removeAlertRow(uid) {
    alertRows = alertRows.filter(r => r.uid !== uid);
    renderAlertsTable();
}

function renderAlertsTable() {
    const tbody    = document.getElementById('alertsTableBody');
    const emptyRow = document.getElementById('alertsEmptyRow');
    if (!tbody) return;
    if (hasAdminAccess && _hasUnresolvedNotifyUsers() && !notifyUsersResolvePromise) {
        notifyUsersResolvePromise = resolveMissingNotifyUsers()
            .then(renderAlertsTable)
            .finally(() => { notifyUsersResolvePromise = null; });
    }
    const notifyHdr = document.getElementById('alertsNotifyUsersHeader');
    if (notifyHdr) notifyHdr.style.display = hasAdminAccess ? '' : 'none';
    const emptyCell = emptyRow?.querySelector('td');
    if (emptyCell) emptyCell.colSpan = hasAdminAccess ? 7 : 6;
    tbody.querySelectorAll('tr.alert-data-row').forEach(r => r.remove());
    if (!alertRows.length) { if (emptyRow) emptyRow.style.display = ''; return; }

    const _uid = parseInt(localStorage.getItem('user_id'), 10);
    let visibleRows;
    if (isAdmin) {
        visibleRows = alertRows;
    } else if (isCompanyAdmin) {
        visibleRows = alertRows;
    } else {
        visibleRows = alertRows.filter(r => !r.notify_user_ids || _idSet(r.notify_user_ids).has(_uid));
    }

    if (!visibleRows.length) { if (emptyRow) emptyRow.style.display = ''; return; }
    if (emptyRow) emptyRow.style.display = 'none';

    visibleRows.forEach((row, idx) => {
        const isCustom = row.alertKey === '__custom__';
        const def      = isCustom ? null : ALERT_TYPES[row.alertKey];

        const isDeviceEvent = row.alertKey === 'device_event';

        const label = isCustom
            ? `<span class="custom-alert-module"><span class="custom-alert-module-title"><i class="mdi mdi-lightning-bolt"></i> ${_esc(row.name)}</span></span>`
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
                <small style="color:var(--text-muted);margin-right:0.2rem;">key:</small>
                ${_esc(row.params?.sensor_key || '')}
            </span>
            <span class="alert-threshold-badge" style="margin-left:0.3rem;">
                <small style="color:var(--text-muted);margin-right:0.2rem;">trigger:</small>
                ${_esc(String(tv))}
            </span>${durBadge}`;
        } else {
            const visibleFields = (def?.fields || []).filter(f => {
                if (f.field_type === 'checkbox') return false;
                if (!f.show_if) return true;
                const cur = String(row.params?.[f.show_if.key] ?? '');
                return f.show_if.values
                    ? f.show_if.values.map(String).includes(cur)
                    : cur === String(f.show_if.value);
            });
            const badges = visibleFields.map(f => {
                const val = row.params?.[f.key];
                if (val == null || val === '') return null;
                let display = val;
                if (f.field_type === 'select' || f.field_type === 'driver_select') {
                    const options = f.field_type === 'driver_select' ? cachedDriverOptions
                        : f.key === 'geofence_id' ? cachedGeofenceOptions
                        : (f.options || []);
                    const opt = options.find(o => String(o.value) === String(val));
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

        let notifyUsersCell = '';
        if (hasAdminAccess) {
            const ids = row.notify_user_ids;
            if (!ids || ids.length === 0) {
                notifyUsersCell = `<td><span style="color:var(--text-muted);font-size:0.8rem;">${!ids ? 'All' : 'None'}</span></td>`;
            } else {
                const visibleUsers = ids
                    .map(id => {
                        const user = _findUserById(id);
                        return user || { id, username: (allUsersLoaded || allUsersLoadFailed) ? `User #${id}` : 'Loading...' };
                    });
                notifyUsersCell = `<td><div style="display:flex;flex-wrap:wrap;gap:0.3rem;">${
                    visibleUsers.map(u => `<span class="channel-pill active" style="pointer-events:none;font-size:0.75rem;">${_esc(u.username)}</span>`).join('')
                }</div></td>`;
            }
        }

        const tr       = document.createElement('tr');
        tr.className   = 'alert-data-row';
        tr.dataset.uid = row.uid;
        tr.style.cursor = 'pointer';
        tr.ondblclick  = () => openAlertEditor(row.uid);
        tr.innerHTML   = `
            <td style="color:var(--text-muted);font-size:0.82rem;">${idx + 1}</td>
            <td><span class="alert-type-label ${isCustom ? 'custom' : 'system'}">${label}</span></td>
            <td><div style="display:flex;flex-wrap:wrap;gap:0.3rem;">${thresh}</div></td>
            <td><div style="display:flex;flex-wrap:wrap;gap:0.3rem;">${chHtml}</div></td>
            ${notifyUsersCell}
            <td>${schedHtml}</td>
            <td style="text-align:center;white-space:nowrap;">
                <button type="button" class="btn btn-secondary tbl-btn" onclick="openAlertEditor(${row.uid})"><i class="mdi mdi-pencil"></i></button>
                <button type="button" class="btn btn-danger    tbl-btn" onclick="removeAlertRow(${row.uid})"><i class="mdi mdi-close"></i></button>
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
    let def        = isCustom ? null : ALERT_TYPES[row.alertKey];

    // Patch geofence options dynamically before rendering
    if (def?.fields?.some(f => f.key === 'geofence_id') && editingDeviceId) {
        const geofenceOptions = await loadGeofencesForDevice(editingDeviceId);
        def = {
            ...def,
            fields: def.fields.map(f =>
                f.key === 'geofence_id' ? { ...f, options: geofenceOptions } : f
            ),
        };
    }

    // Patch driver_select fields dynamically before rendering
    if (def?.fields?.some(f => f.field_type === 'driver_select')) {
        const driverOptions = await _loadDriverOptions();
        def = {
            ...def,
            fields: def.fields.map(f =>
                f.field_type === 'driver_select'
                    ? { ...f, field_type: 'select', options: driverOptions }
                    : f
            ),
        };
    }

    document.getElementById('alertEditorTitle').textContent =
        isCustom ? `Edit Custom Rule — ${row.name}` : `Edit ${def?.label || row.alertKey}`;

    let fieldsHtml = '';

    if (!isCustom && def?.fields?.length) {
        for (const f of def.fields) {
            const v = row.params?.[f.key] ?? f.default;
            let inputHtml = '';

            if (f.field_type === 'number') {
                const isSpeedField = f.unit === 'km/h';
                const isDistField  = f.unit === 'km';
                const displayVal   = v == null ? '' :
                    isSpeedField ? toDisplaySpeed(v) :
                    isDistField  ? toDisplayDist(v)  : v;
                const displayUnit  = isSpeedField ? speedUnit() :
                    isDistField  ? distUnit()    : (f.unit || '');
                const unitAttr     = isSpeedField ? 'data-unit-type="speed"' :
                    isDistField  ? 'data-unit-type="dist"'  : '';
                inputHtml = `<div style="display:flex;align-items:center;gap:0.75rem;">
                    <input type="number" class="form-input alert-param-input" data-param-key="${f.key}" ${unitAttr}
                           value="${displayVal}"
                           ${f.min_value != null ? `min="${f.min_value}"` : ''}
                           ${f.max_value != null ? `max="${f.max_value}"` : ''}
                           style="max-width:140px;">
                    ${displayUnit ? `<span style="color:var(--text-muted);">${_esc(displayUnit)}</span>` : ''}
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
                const opts = (f.options || []).map(o => {
                    const preset = o.threshold != null ? ` data-threshold="${o.threshold}"` : '';
                    return `<option value="${_esc(o.value)}"${o.value == v ? ' selected' : ''}${preset}>${_esc(o.label)}</option>`;
                }).join('');
                const updatesAttr = f.updates_field ? ` data-updates-field="${_esc(f.updates_field)}"` : '';
                inputHtml = `<select class="form-input alert-param-input" data-param-key="${f.key}"${updatesAttr}>${opts}</select>`;
            } else if (f.field_type === 'date') {
                inputHtml = `<input type="date" class="form-input alert-param-input" data-param-key="${_esc(f.key)}" value="${_esc(v || '')}">`;
            }

            const showIfAttr = f.show_if
                ? ` data-show-if-key="${_esc(f.show_if.key)}" ` + (
                    f.show_if.values
                        ? `data-show-if-vals='${JSON.stringify(f.show_if.values)}'`
                        : `data-show-if-val="${_esc(String(f.show_if.value))}"`)
                : '';
            const _siCurrent = f.show_if
                ? String(row.params?.[f.show_if.key] ?? def.fields.find(x => x.key === f.show_if.key)?.default)
                : '';
            const showIfHidden = f.show_if
                ? (f.show_if.values
                    ? !f.show_if.values.map(String).includes(_siCurrent)
                    : _siCurrent !== String(f.show_if.value))
                : false;
            const groupStyle = `margin-bottom:1rem;${showIfHidden ? 'display:none;' : ''}`;

            if (f.field_type !== 'checkbox') {
                fieldsHtml += `<div class="form-group" style="${groupStyle}"${showIfAttr}>
                    <label class="form-label">${_esc(f.label)}</label>
                    ${inputHtml}
                    ${f.help_text ? `<div class="form-help">${_esc(f.help_text)}</div>` : ''}
                </div>`;
            } else {
                fieldsHtml += `<div class="form-group" style="${groupStyle}"${showIfAttr}>${inputHtml}</div>`;
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

    let notifyUsersHtml = '';
    if (hasAdminAccess && editingDeviceId) {
        try {
            const currentUserId = parseInt(localStorage.getItem('user_id'), 10);
            let deviceUsers = [];
            let allFetched = [];

            if (isAdmin) {
                await loadAllUsers();
                allFetched = allUsers;
                deviceUsers = allFetched;
            } else {
                const res = await apiFetch(`${API_BASE}/devices/${editingDeviceId}/users`);
                deviceUsers = res.ok ? await res.json() : [];
                deviceUsers = deviceUsers.filter(u => !u.is_admin);
            }
            _mergeUsersIntoCache(deviceUsers);

            // Always include the current user
            if (!deviceUsers.some(u => _sameId(u.id, currentUserId))) {
                deviceUsers.unshift({ id: currentUserId, username: localStorage.getItem('username') || 'me' });
            }

            // Always include users already in notify_user_ids (e.g. creator outside the company filter)
            const existingIds = (row.notify_user_ids ?? []).map(_toId).filter(id => id !== null);
            for (const uid of existingIds) {
                if (!deviceUsers.some(u => _sameId(u.id, uid))) {
                    const known = allFetched.find(u => _sameId(u.id, uid)) || _findUserById(uid);
                    if (known) deviceUsers.push(known);
                }
            }

            // Merge fetched users into allUsers so renderAlertsTable can show names
            (allFetched.length ? allFetched : deviceUsers).forEach(u => {
                if (!allUsers.some(a => _sameId(a.id, u.id))) allUsers.push(u);
            });
            renderAlertsTable();

            // Default selection: existing notify_user_ids, no fallback to current user
            const selectedIds = _idSet(existingIds);
            // IDs not shown as checkboxes (out-of-scope admins, etc.) — preserve on save
            const hiddenIds = existingIds.filter(id => !deviceUsers.some(u => _sameId(u.id, id)));
            const pills = deviceUsers.map(u =>
                `<label class="channel-pill${selectedIds.has(_toId(u.id)) ? ' active' : ''}">
                    <input type="checkbox" class="editor-notify-user-cb" value="${u.id}"${selectedIds.has(_toId(u.id)) ? ' checked' : ''}>
                    ${_esc(u.username)}${_sameId(u.id, currentUserId) ? ' (you)' : ''}
                </label>`
            ).join('');
            notifyUsersHtml = `<div class="form-group">
                <label class="form-label">Notify Users</label>
                <input type="hidden" id="alertEditorHiddenNotifyIds" value="${_escAttrJson(hiddenIds)}">
                <div style="display:flex;flex-wrap:wrap;gap:0.4rem;">${pills}</div>
            </div>`;
        } catch (e) { console.error('Failed to load device users:', e); }
    }

    document.getElementById('alertEditorBody').innerHTML = `
        <div class="alert-editor-grid">
            <div class="alert-editor-left">
                <div style="display:flex;flex-direction:column;gap:0.25rem;">
                    ${def?.description ? `<p style="color:var(--text-muted);font-size:0.85rem;margin:0 0 1rem;">${_esc(def.description)}</p>` : ''}
                    ${fieldsHtml}
                </div>
            </div>
            <div class="alert-editor-right">
                <div class="form-group">
                    <label class="form-label">Notify Via</label>
                    <div style="display:flex;flex-wrap:wrap;gap:0.4rem;">${chHtml}</div>
                </div>
                ${notifyUsersHtml}
                <div class="form-group" style="margin-top:1.25rem;">
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
                </div>
            </div>
        </div>`;

    const durCb  = document.getElementById('editor-duration-enabled');
    const durInp = document.getElementById('editor-duration-input');
    if (durCb && durInp) durCb.addEventListener('change', () => { durInp.disabled = !durCb.checked; });

    document.querySelectorAll('#editor-day-picker .day-pill').forEach(pill => {
        const cb = pill.querySelector('input');
        if (!cb) return;
        pill.classList.toggle('active', cb.checked);
        pill.addEventListener('click', (e) => { e.preventDefault(); cb.checked = !cb.checked; pill.classList.toggle('active', cb.checked); });
    });
    document.querySelectorAll('#alertEditorBody .channel-pill').forEach(pill => {
        const cb = pill.querySelector('input');
        if (!cb) return;
        pill.addEventListener('click', (e) => { e.preventDefault(); cb.checked = !cb.checked; pill.classList.toggle('active', cb.checked); });
    });
    document.querySelectorAll('#alertEditorBody .alert-param-input[data-updates-field]').forEach(sel => {
        sel.addEventListener('change', () => {
            const preset = sel.options[sel.selectedIndex]?.dataset?.threshold;
            if (preset == null) return;
            const target = document.querySelector(
                `#alertEditorBody .alert-param-input[data-param-key="${sel.dataset.updatesField}"]`
            );
            if (target) target.value = preset;
        });
    });
    const applyShowIf = () => {
        document.querySelectorAll('#alertEditorBody .form-group[data-show-if-key]').forEach(group => {
            const ctrl = document.querySelector(
                `#alertEditorBody .alert-param-input[data-param-key="${group.dataset.showIfKey}"]`
            );
            let show;
            if (group.dataset.showIfVals) {
                show = ctrl && JSON.parse(group.dataset.showIfVals).includes(ctrl.value);
            } else {
                show = ctrl && ctrl.value === group.dataset.showIfVal;
            }
            group.style.display = show ? '' : 'none';
        });
    };
    document.querySelectorAll('#alertEditorBody .alert-param-input').forEach(inp => {
        inp.addEventListener('change', applyShowIf);
    });
    applyShowIf();

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
            if (input.type === 'checkbox') {
                row.params[key] = input.checked;
            } else if (input.type === 'number') {
                const v = parseFloat(input.value);
                if (!isNaN(v)) {
                    const unitType = input.dataset.unitType;
                    row.params[key] = unitType === 'speed' ? fromDisplaySpeed(v)
                                    : unitType === 'dist'  ? fromDisplayDist(v)
                                    : v;
                }
            } else {
                row.params[key] = input.value;
            }
        });
    }

    row.channels = [];
    document.querySelectorAll('.editor-channel-cb:checked').forEach(cb => row.channels.push(cb.value));

    const notifyUserCbs = document.querySelectorAll('.editor-notify-user-cb');
    if (notifyUserCbs.length > 0) {
        const selected = [];
        notifyUserCbs.forEach(cb => { if (cb.checked) selected.push(parseInt(cb.value, 10)); });
        const hiddenEl = document.getElementById('alertEditorHiddenNotifyIds');
        const preserved = hiddenEl ? JSON.parse(hiddenEl.value || '[]') : [];
        row.notify_user_ids = [...new Set([...selected, ...preserved])];
    }

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
//  USERS TAB
// ================================================================

async function loadAllUsers() {
    if (allUsersLoaded) return allUsers;
    if (allUsersLoadPromise) return allUsersLoadPromise;

    allUsersLoadPromise = (async () => {
        try {
            const res = await apiFetch(`${API_BASE}/users`);
            if (res.ok) {
                allUsers = await res.json();
                allUsersLoaded = true;
                allUsersLoadFailed = false;
                if (document.getElementById('deviceModal')?.classList.contains('active')) {
                    renderAlertsTable();
                }
            } else {
                allUsersLoadFailed = true;
            }
        } catch (e) {
            allUsersLoadFailed = true;
            console.error('Failed to load users:', e);
        } finally {
            allUsersLoadPromise = null;
        }
        return allUsers;
    })();

    return allUsersLoadPromise;
}

async function loadNotifyUserById(userId) {
    const id = _toId(userId);
    if (id === null || _findUserById(id)) return _findUserById(id);
    if (notifyUserLoadFailedIds.has(id)) return null;
    if (notifyUserLoadPromises.has(id)) return notifyUserLoadPromises.get(id);

    const promise = (async () => {
        try {
            const res = await apiFetch(`${API_BASE}/users/${id}`);
            if (!res.ok) {
                notifyUserLoadFailedIds.add(id);
                return null;
            }
            const user = await res.json();
            _mergeUsersIntoCache([user]);
            return user;
        } catch (e) {
            notifyUserLoadFailedIds.add(id);
            console.error(`Failed to load notify user ${id}:`, e);
            return null;
        } finally {
            notifyUserLoadPromises.delete(id);
        }
    })();

    notifyUserLoadPromises.set(id, promise);
    return promise;
}

async function loadMissingNotifyUsers() {
    const ids = _missingNotifyUserIds();
    if (!ids.length) return [];
    return Promise.all(ids.map(loadNotifyUserById));
}

async function resolveMissingNotifyUsers() {
    if (isAdmin && !allUsersLoaded && !allUsersLoadFailed) {
        await loadAllUsers();
    }
    if (!_hasUnresolvedNotifyUsers()) return [];
    return loadMissingNotifyUsers();
}

async function loadDeviceAlertUsers(deviceId) {
    try {
        const res = await apiFetch(`${API_BASE}/devices/${deviceId}/users`);
        if (!res.ok) return;
        deviceAlertUsers = await res.json();
        _mergeUsersIntoCache(deviceAlertUsers);
        if (editingDeviceId === deviceId) renderAlertsTable();
    } catch (e) { console.error('Failed to load device alert users:', e); }
}

async function loadAllCompanies() {
    try {
        const res = await apiFetch(`${API_BASE}/companies`);
        if (res.ok) {
            allCompanies = await res.json();
            populateDeviceCompanySelect();
        }
    } catch (e) { console.error('Failed to load companies:', e); }
}

function onDeviceCompanyChange() {
    const companyId = parseInt(document.getElementById('deviceCompany').value) || null;
    const usersTabBtn = document.getElementById('usersTabBtn');
    if (usersTabBtn) usersTabBtn.style.display = companyId ? '' : 'none';
    if (!companyId && document.querySelector('.modal-tab.active')?.dataset.tab === 'users') {
        switchModalTab('general');
    }
    renderUsersTab();
}

function populateDeviceCompanySelect(selectedId) {
    const sel = document.getElementById('deviceCompany');
    if (!sel) return;
    sel.innerHTML = '<option value="">— None —</option>' +
        allCompanies.map(c => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${_esc(c.name)}</option>`).join('');
}

async function loadUsersForDevice(deviceId) {
    try {
        const res = await apiFetch(`${API_BASE}/devices/${deviceId}/users`);
        deviceAssignedUserIds = res.ok
            ? new Set((await res.json()).map(u => u.id))
            : new Set();
    } catch (e) { deviceAssignedUserIds = new Set(); }
    renderUsersTab();
}

function filterUsersTab() { renderUsersTab(); }

function renderUsersTab() {
    const list = document.getElementById('usersAssignList');
    if (!list) return;
    const query = (document.getElementById('usersTabSearch')?.value || '').toLowerCase().trim();
    const myCompanyId = isCompanyAdmin
        ? (parseInt(localStorage.getItem('company_id')) || null)
        : (parseInt(document.getElementById('deviceCompany')?.value) || null);
    const filtered = allUsers.filter(u =>
        !u.is_admin &&
        !u.is_company_admin &&
        (!myCompanyId || u.company_id === myCompanyId) &&
        (!query ||
            (u.username || '').toLowerCase().includes(query) ||
            (u.email    || '').toLowerCase().includes(query)
        )
    );
    if (!filtered.length) {
        list.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted);">No users found.</div>';
        return;
    }
    list.innerHTML = '';
    filtered.forEach(u => {
        const assigned = deviceAssignedUserIds.has(u.id);
        const div = document.createElement('div');
        div.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:0.6rem 0.8rem;background:var(--bg-tertiary);border-radius:8px;';
        div.innerHTML = `
            <div>
                <div style="font-weight:500;">${_esc(u.username)}</div>
                <div style="font-size:0.8rem;color:var(--text-muted);">${_esc(u.email || '')}</div>
            </div>
            <label class="toggle-switch">
                <input type="checkbox" ${assigned ? 'checked' : ''} onchange="toggleUserAssignment(${u.id}, this.checked)">
                <span class="toggle-slider"></span>
            </label>`;
        list.appendChild(div);
    });
}

async function toggleUserAssignment(userId, assign) {
    const action = assign ? 'add' : 'remove';
    try {
        const res = await apiFetch(
            `${API_BASE}/devices/${editingDeviceId}/users?user_id=${userId}&action=${action}`,
            { method: 'POST' }
        );
        if (res.ok) {
            if (assign) deviceAssignedUserIds.add(userId);
            else deviceAssignedUserIds.delete(userId);
        } else {
            showAlert('Failed to update user assignment', 'error');
            renderUsersTab();
        }
    } catch (e) {
        showAlert('Error updating user assignment', 'error');
        renderUsersTab();
    }
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
            <td>${p.speed != null ? fmtSpeed(p.speed) : '—'}</td>
            <td>${p.course != null ? p.course.toFixed(0) + '°' : '—'}</td>
            <td>${p.satellites != null ? p.satellites : '—'}</td>
            <td>${fmtAlt(p.altitude || 0)}</td>
            <td>${p.ignition === true ? '<span style="color:var(--accent-success);font-weight:600;">ON</span>' : p.ignition === false ? '<span style="color:var(--accent-danger);font-weight:600;">OFF</span>' : '<span style="color:var(--text-muted);">—</span>'}</td>
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
//  ALERTS MODAL SHIMS
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
            const iconCls = alert.type === 'speeding' ? 'mdi-lightning-bolt' : alert.type === 'offline' ? 'mdi-wifi-off' : 'mdi-bell';
            const item = document.createElement('div');
            item.className = `alert-item ${alert.severity}`;
            item.innerHTML = `
                <div class="alert-icon"><i class="mdi ${iconCls}"></i></div>
                <div class="alert-content">
                    <div class="alert-title">${alert.type}</div>
                    <div class="alert-message">${alert.message}</div>
                    <div class="alert-time">${formatDateToLocal(alert.created_at)}</div>
                </div>
                <button class="alert-dismiss" onclick="dismissAlert(${alert.id})"><i class="mdi mdi-close"></i></button>`;
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

// ── Dashcam Clips ─────────────────────────────────────────────────────────────

const EVENT_TYPE_LABELS = {
    manual: { label: 'Manual', color: '#6b7280' },
    harsh_brake: { label: 'Harsh Brake', color: '#f59e0b' },
    harsh_accel: { label: 'Harsh Accel', color: '#f59e0b' },
    harsh_corner: { label: 'Harsh Corner', color: '#f59e0b' },
    collision: { label: 'Collision', color: '#ef4444' },
    overspeeding: { label: 'Overspeeding', color: '#3b82f6' },
    jamming: { label: 'Jamming', color: '#8b5cf6' },
};

let _allClips = [];
let _clipsDeviceId = null;

function _updateClipsTabVisibility() {
    const hasCamera = devices.some(d => d.config?.has_camera);
    const btn = document.getElementById('mgmtTabClips');
    if (btn) btn.style.display = (hasCamera && hasPermission('view_history')) ? '' : 'none';
}

function initClipsSection() {
    const cameraDevices = devices.filter(d => d.config?.has_camera);
    const sel = document.getElementById('clipsDeviceSelect');
    if (!sel) return;
    sel.innerHTML = cameraDevices.map(d => `<option value="${d.id}">${_esc(d.name)}</option>`).join('');
    if (cameraDevices.length) {
        _clipsDeviceId = cameraDevices[0].id;
        loadClipsForDevice(_clipsDeviceId);
    } else {
        document.getElementById('clipsGrid').innerHTML =
            '<div style="text-align:center;padding:2rem;color:var(--text-muted);">No dashcam devices configured.</div>';
    }
}

function loadClipsForSection() {
    const sel = document.getElementById('clipsDeviceSelect');
    if (!sel) return;
    _clipsDeviceId = parseInt(sel.value, 10);
    loadClipsForDevice(_clipsDeviceId);
}

async function loadClipsForDevice(deviceId) {
    const grid = document.getElementById('clipsGrid');
    grid.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted);">Loading clips…</div>';
    try {
        const res = await apiFetch(`${API_BASE}/dashcam/clips?device_id=${deviceId}`);
        if (!res.ok) throw new Error();
        _allClips = await res.json();
        renderClipsGrid(_allClips);
    } catch {
        grid.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--accent-danger);">Failed to load clips.</div>';
    }
}

function applyClipsFilter() {
    const et = document.getElementById('clipsEventFilter').value;
    const cam = document.getElementById('clipsCameraFilter').value;
    const filtered = _allClips.filter(c =>
        (!et || c.event_type === et) && (!cam || c.camera === cam)
    );
    renderClipsGrid(filtered);
}

function renderClipsGrid(clips) {
    const grid = document.getElementById('clipsGrid');
    if (!clips.length) {
        grid.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted);"><i class="mdi mdi-video-off" style="font-size:2rem;display:block;margin-bottom:0.5rem;"></i>No clips found</div>';
        return;
    }
    grid.innerHTML = clips.map(c => {
        const ev = EVENT_TYPE_LABELS[c.event_type] || { label: c.event_type, color: '#6b7280' };
        const thumb = c.thumbnail_path
            ? `<img src="/api/dashcam/clips/${c.id}/thumbnail" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentElement.innerHTML='<i class=\\'mdi mdi-video\\' style=\\'font-size:2rem;color:var(--text-muted)\\'></i>'">`
            : '<i class="mdi mdi-video" style="font-size:2rem;color:var(--text-muted);"></i>';
        const speed = c.speed != null ? `${Number(c.speed).toFixed(0)} km/h` : '';
        const size = c.file_size ? `${(c.file_size / 1024 / 1024).toFixed(1)} MB` : '';
        return `
            <div class="clip-card" onclick="openClipPlayer(${c.id}, '${ev.label}', '${formatDateToLocal(c.timestamp)}', '${c.camera}', '${speed}')">
                <div class="clip-thumb">${thumb}</div>
                <div class="clip-info">
                    <span class="clip-event-badge" style="background:${ev.color}20;color:${ev.color};border-color:${ev.color}40;">${ev.label}</span>
                    <span class="clip-camera-badge">${c.camera}</span>
                    <div class="clip-time">${formatDateToLocal(c.timestamp)}</div>
                    ${speed ? `<div class="clip-meta">${speed}${size ? ' · ' + size : ''}</div>` : ''}
                </div>
                ${hasAdminAccess ? `<button class="clip-delete-btn" onclick="event.stopPropagation();deleteClip(${c.id})" title="Delete"><i class="mdi mdi-delete"></i></button>` : ''}
            </div>`;
    }).join('');
}

async function openClipPlayer(clipId, eventLabel, time, camera, speed) {
    const modal = document.getElementById('clipPlayerModal');
    const video = document.getElementById('clipPlayerVideo');
    const meta  = document.getElementById('clipPlayerMeta');
    document.getElementById('clipPlayerTitle').textContent = eventLabel;
    video.src = `/api/dashcam/clips/${clipId}/video`;
    meta.innerHTML = [
        `<span><i class="mdi mdi-clock-outline"></i> ${time}</span>`,
        `<span><i class="mdi mdi-video"></i> ${camera}</span>`,
        speed ? `<span><i class="mdi mdi-speedometer"></i> ${speed}</span>` : '',
    ].filter(Boolean).join('');
    modal.style.display = 'flex';
    video.play().catch(() => {});
}

function closeClipPlayer() {
    const modal = document.getElementById('clipPlayerModal');
    const video = document.getElementById('clipPlayerVideo');
    video.pause();
    video.src = '';
    modal.style.display = 'none';
}

async function deleteClip(clipId) {
    if (!confirm('Delete this clip?')) return;
    const res = await apiFetch(`${API_BASE}/dashcam/clips/${clipId}`, { method: 'DELETE' });
    if (res.ok || res.status === 204) {
        _allClips = _allClips.filter(c => c.id !== clipId);
        applyClipsFilter();
    } else {
        showAlert({ title: 'Error', message: 'Failed to delete clip.', type: 'error' });
    }
}
