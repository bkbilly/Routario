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
let smtpEnabled          = false;
let voipEnabled          = false;

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

// Companies & SIM cards
let allCompanies            = [];
let allSimCards             = [];

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

function _canViewUserChannel(targetUser, currentUserId) {
    if (!targetUser) return false;
    if (currentUserId && _sameId(targetUser.id, currentUserId)) return true;
    if (isAdmin) return true;
    if (targetUser.is_admin) return false;
    if (!isCompanyAdmin && targetUser.is_company_admin) return false;
    return true;
}

function _getVisibleNotificationChannels(currentUserId) {
    const channels = [];
    (userChannels || []).forEach(uc => {
        if (uc && (uc.id || uc.name)) {
            channels.push({
                id: uc.id,
                name: uc.name,
                isOtherUser: false,
                username: ''
            });
        }
    });
    [...allUsers, ...deviceAlertUsers].forEach(u => {
        if (!_canViewUserChannel(u, currentUserId)) return;
        const isOther = !_sameId(u.id, currentUserId);
        (u.notification_channels || []).forEach(nc => {
            if (nc && (nc.id || nc.name)) {
                const key = nc.id || nc.name;
                if (!channels.some(ac => (ac.id || ac.name) === key)) {
                    channels.push({
                        id: nc.id,
                        name: nc.name,
                        isOtherUser: isOther,
                        username: u.username || ''
                    });
                }
            }
        });
    });
    return channels;
}

function _hasUnresolvedNotifyUsers() {
    return _missingNotifyUserIds().length > 0;
}

function _missingNotifyUserIds() {
    if (isCompanyAdmin && (allUsersLoaded || allUsersLoadFailed)) return [];
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
        btn.style.display = hasPermission('edit_devices') ? '' : 'none';
    });

    const usersTabBtn = document.getElementById('usersTabBtn');
    if (usersTabBtn) usersTabBtn.style.display = 'none';

    if (isAdmin) {
        document.querySelector('.devices-table')?.classList.add('show-company-col');
        document.getElementById('deviceCompanyGroup').style.display = '';
    }

    await Promise.all([
        loadAlertTypes(),
        loadPublicSettings(),
        loadAvailableProtocols(),
        loadUserChannels(),
        loadDevices(),
        loadSimCards(),
        ...(isAdmin ? [loadAllCompanies()] : []),
        loadAllUsers(),
    ]);
    populateAddAlertDropdown();
}

// ── API Loaders ───────────────────────────────────────────────────
async function loadPublicSettings(signal = null) {
    try {
        const res = await apiFetch(`${API_BASE}/system-settings/public`, signal ? { signal } : {});
        if (res.ok) {
            const data = await res.json();
            smtpEnabled = data.smtp_enabled === true || String(data.smtp_enabled).toLowerCase() === 'true' || data.smtp_enabled === 1;
            voipEnabled = data.voip_enabled === true || String(data.voip_enabled).toLowerCase() === 'true' || data.voip_enabled === 1;
            if (typeof window !== 'undefined') {
                window.smtpEnabled = smtpEnabled;
                window.voipEnabled = voipEnabled;
            }
        }
    } catch (e) {
        if (e.name === 'AbortError') throw e;
        console.warn('Public settings load failed:', e);
    }
}

if (typeof window !== 'undefined' && !window.syncPublicSystemSettings) {
    window.syncPublicSystemSettings = loadPublicSettings;
}

function isEmailNotificationAvailable() {
    return smtpEnabled === true || (typeof window !== 'undefined' && window.smtpEnabled === true);
}

function isVoipNotificationAvailable() {
    return voipEnabled === true || (typeof window !== 'undefined' && window.voipEnabled === true);
}

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

async function loadUserChannels(forceRefresh = false) {
    try {
        const userId = localStorage.getItem('user_id') || 1;
        if (!forceRefresh && typeof permissionsReady !== 'undefined') {
            const currentUser = await permissionsReady;
            if (_sameId(currentUser?.id, userId) && Array.isArray(currentUser?.notification_channels) && currentUser.notification_channels.length > 0) {
                userChannels = currentUser.notification_channels;
                return;
            }
        }
        const res    = await apiFetch(`${API_BASE}/users/${userId}`);
        if (!res.ok) throw new Error();
        const user   = await res.json();
        userChannels = user.notification_channels || [];
        if (typeof permissionsReady !== 'undefined') {
            permissionsReady.then(u => { if (u) u.notification_channels = userChannels; }).catch(() => {});
        }
    } catch (e) { console.error('Error loading channels:', e); }
}

window.addEventListener('routario:notification-channels-updated', (evt) => {
    if (Array.isArray(evt.detail)) {
        userChannels = evt.detail;
        if (typeof permissionsReady !== 'undefined') {
            permissionsReady.then(u => { if (u) u.notification_channels = userChannels; }).catch(() => {});
        }
        if (typeof renderAlertsTable === 'function') {
            renderAlertsTable();
        }
    }
});

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
    ({ col: sortCol, dir: sortDir } = RoutarioTables.toggleNumericSort(sortCol, sortDir, col));
    updateSortHeaders();
    filterDevices();
}

function updateSortHeaders() {
    RoutarioTables.updateSortHeaders('#section-devices, body > .container', {
        col: sortCol,
        dir: sortDir === 1 ? 'asc' : 'desc',
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
        tbody.innerHTML = RoutarioTables.stateRow('<div style="font-size:2.5rem;margin-bottom:0.75rem;"><i class="mdi mdi-antenna"></i></div>No devices found', 7, { padding: '3rem' });
        return;
    }

    tbody.innerHTML = list.map(d => {
        const icon        = (VEHICLE_ICONS[d.vehicle_type] || VEHICLE_ICONS['other']).emoji;
        const lastSeen    = d.state?.last_update ? formatDateToLocalSplit(d.state.last_update) : '—';
        const odometer    = d.state?.total_odometer != null ? fmtOdometer(d.state.total_odometer) : '—';
        const plate       = d.license_plate || '—';
        const cmds        = d.supports_commands !== false && hasPermission('send_commands');
        const companyName = allCompanies.find(c => _sameId(c.id, d.company_id))?.name || '—';
        const canEdit     = hasPermission('edit_devices');

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
            <td style="font-size:0.85rem;color:var(--text-secondary);white-space:nowrap;">${lastSeen}</td>
            <td style="font-family:var(--font-mono);font-size:0.85rem;">${odometer}</td>
            <td style="text-align:right;white-space:nowrap;">
                ${cmds ? `<button class="btn btn-secondary tbl-btn" onclick="openDeviceModal(${d.id},'commands')" title="Commands"><i class="mdi mdi-antenna"></i></button>` : ''}
                <button class="btn btn-secondary tbl-btn" onclick="openDeviceModal(${d.id},'general')"><i class="mdi mdi-${canEdit ? 'pencil' : 'eye'}"></i> <span class="drv-btn-label">${canEdit ? 'Edit' : 'View'}</span></button>
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
function setDeviceModalTitle(device = null) {
    const title = document.getElementById('modalTitle');
    if (!title) return;
    if (!device) {
        title.textContent = 'Add New Device';
        return;
    }
    const cfg = VEHICLE_ICONS[device.vehicle_type] || VEHICLE_ICONS.other;
    title.innerHTML = `
        <span style="display:inline-flex;align-items:center;gap:0.55rem;min-width:0;">
            <span aria-hidden="true" style="font-size:1.25rem;line-height:1;">${cfg.emoji}</span>
            <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(device.name)}</span>
        </span>
    `;
}

function openAddDeviceModal() {
    if (!hasPermission('edit_devices')) return;
    editingDeviceId = null;

    setDeviceModalTitle();
    document.getElementById('submitText').textContent        = 'Add Device';
    document.getElementById('submitIcon').className         = 'mdi mdi-plus';
    document.getElementById('deleteDeviceBtn').style.display = 'none';
    document.getElementById('submitBtn').style.display       = '';
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

    ['deviceName', 'licensePlate', 'vehicleType', 'currentOdometer', 'offlineTimeoutHours', 'tripMergeGapMinutes', 'deviceHasCamera'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = false;
    });

    populateVehicleTypeSelect(document.getElementById('vehicleType'), DEFAULT_TYPE);

    const panel = document.getElementById('integrationFieldsPanel');
    if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
    const imeiInput = document.getElementById('deviceImei');
    if (imeiInput) { imeiInput.required = true; imeiInput.closest('.form-group').style.display = ''; imeiInput.disabled = false; }
    document.getElementById('deviceProtocol').disabled = false;

    if (isAdmin) populateDeviceCompanySelect();
    populateDeviceSimCardSelect(null, null, isAdmin ? null : (parseInt(localStorage.getItem('company_id')) || null));

    loadPublicSettings().then(() => {
        if (typeof renderAlertsTable === 'function') renderAlertsTable();
    });

    alertRows = [];
    renderAlertsTable();
    populateAddAlertDropdown();
    populateAlertProfileDeviceSelect();
    const exportBtnAdd = document.getElementById('exportDeviceProfileBtn');
    if (exportBtnAdd) exportBtnAdd.style.display = 'none';
    switchModalTab('general');
    document.getElementById('deviceModal').classList.add('active');
}

function openDeviceModal(deviceId, startTab = 'general') {
    const d = devices.find(x => x.id == deviceId);
    if (!d) return;
    editingDeviceId = d.id;
    deviceAlertUsers = [];

    if (typeof syncPublicSystemSettings === 'function') {
        syncPublicSystemSettings().then(() => {
            if (typeof renderAlertsTable === 'function') renderAlertsTable();
        });
    }
    const canEditDevice = hasPermission('edit_devices');
    setDeviceModalTitle(d);
    document.getElementById('submitText').textContent        = 'Save';
    document.getElementById('submitIcon').className         = 'mdi mdi-content-save';
    document.getElementById('deleteDeviceBtn').style.display = canEditDevice ? 'inline-flex' : 'none';
    document.getElementById('submitBtn').style.display       = canEditDevice ? '' : 'none';
    const exportBtnEdit = document.getElementById('exportDeviceProfileBtn');
    if (exportBtnEdit) exportBtnEdit.style.display = 'inline-flex';
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
    populateDeviceSimCardSelect(d.sim_card_id, d.id, d.company_id);
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
    imeiEl.disabled     = !canEditDevice;
    protocolEl.disabled = !canEditDevice;
    // Lock protocol when it is an integration and the user can't manage integrations
    if (!hasPermission('manage_integrations') && integrationProviders.some(p => p.provider_id === d.protocol)) {
        protocolEl.disabled = true;
    }

    ['deviceName', 'licensePlate', 'vehicleType', 'currentOdometer', 'offlineTimeoutHours', 'tripMergeGapMinutes', 'deviceHasCamera'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !canEditDevice;
    });

    populateVehicleTypeSelect(document.getElementById('vehicleType'), d.vehicle_type || DEFAULT_TYPE);

    restoreIntegrationFields(d);
    if (!d.config?.integration?.provider) onProtocolChange();

    // Ensure the current user is always resolvable in the notify-users lookup
    const _myId = parseInt(localStorage.getItem('user_id'), 10);
    const _myName = localStorage.getItem('username');
    if (_myId && _myName && !allUsers.some(u => _sameId(u.id, _myId))) {
        allUsers.push({ id: _myId, username: _myName });
    }

    loadAlertsFromConfig(d.config || {});

    loadGeofencesForDevice(d.id).then(opts => {
        cachedGeofenceOptions = opts;
        renderAlertsTable();
    });
    _loadDriverOptions().then(opts => {
        cachedDriverOptions = opts;
        renderAlertsTable();
    });
    if (!allUsersLoaded) {
        loadAllUsers().then(() => renderAlertsTable());
    }
    populateAlertProfileDeviceSelect();
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
        simCard:      document.getElementById('deviceSimCard')?.value,
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
    if (event) event.preventDefault();
    if (!hasPermission('edit_devices')) return;

    const activeTab = document.querySelector('.modal-tab.active')?.getAttribute('data-tab');
    if (activeTab === 'commands') {
        sendCommand();
        return;
    }

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
            sim_card_id:   parseInt(document.getElementById('deviceSimCard')?.value) || null,
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

const deviceCommandSupportCache = {};

async function fetchDeviceCommandSupport(deviceId) {
    if (!deviceId) return { supports_commands: false, available_commands: [] };
    if (deviceCommandSupportCache[deviceId]) {
        return deviceCommandSupportCache[deviceId];
    }
    try {
        const res = await apiFetch(`${API_BASE}/devices/${deviceId}/command-support`);
        if (!res.ok) return { supports_commands: false, available_commands: [] };
        const data = await res.json();
        deviceCommandSupportCache[deviceId] = data;
        return data;
    } catch (e) {
        console.error('Failed to fetch command support:', e);
        return { supports_commands: false, available_commands: [] };
    }
}

function formatCommandLabel(cmdKey, supportData = {}) {
    if (!cmdKey || cmdKey === 'disabled') return 'Disabled';
    if (cmdKey.startsWith('user_cmd:')) {
        const id = cmdKey.split(':')[1];
        const u = (supportData.user_commands || []).find(c => String(c.id) === String(id));
        return u ? u.name : `User Cmd #${id}`;
    }
    if (cmdKey.startsWith('saved:')) {
        const id = cmdKey.split(':')[1];
        const s = (supportData.saved_commands || []).find(c => String(c.id) === String(id));
        return s ? s.name : `Saved Cmd #${id}`;
    }
    if (cmdKey.startsWith('setting:')) {
        const rawName = cmdKey.replace('setting:', '');
        return rawName.charAt(0).toUpperCase() + rawName.slice(1).replace(/_/g, ' ');
    }
    const knownLabels = {
        cut_engine: 'Cut Engine',
        resume_engine: 'Resume Engine',
        engine_stop: 'Engine Stop',
        engine_resume: 'Engine Resume',
        reboot: 'Reboot Device',
        reset: 'Reset Device',
        interval: 'Change Tracking Interval',
        custom: 'Custom Command',
    };
    if (knownLabels[cmdKey]) return knownLabels[cmdKey];
    return cmdKey.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

function populateAlertEditorCommandSelect(selectEl, supportData, currentVal) {
    if (!selectEl) return;
    selectEl.innerHTML = '';

    const disabledOpt = document.createElement('option');
    disabledOpt.value = 'disabled';
    disabledOpt.textContent = 'Disabled';
    if (!currentVal || currentVal === 'disabled') disabledOpt.selected = true;
    selectEl.appendChild(disabledOpt);

    if (!supportData || !supportData.supports_commands) return;

    // 1. User Defined Commands
    const userCmds = supportData.user_commands || [];
    if (userCmds.length > 0) {
        const userGrp = document.createElement('optgroup');
        userGrp.label = 'User Defined Commands';
        userCmds.forEach(uc => {
            const val = `user_cmd:${uc.id}`;
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = uc.name;
            if (currentVal === val) opt.selected = true;
            userGrp.appendChild(opt);
        });
        selectEl.appendChild(userGrp);
    }

    // 2. Integration Saved Commands
    const savedCmds = supportData.saved_commands || [];
    if (savedCmds.length > 0) {
        const savedGrp = document.createElement('optgroup');
        savedGrp.label = 'Saved Commands';
        savedCmds.forEach(sc => {
            const val = `saved:${sc.id}`;
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = sc.name;
            if (currentVal === val) opt.selected = true;
            savedGrp.appendChild(opt);
        });
        selectEl.appendChild(savedGrp);
    }

    // 3. Standard / Protocol Commands & Settings
    const available = supportData.available_commands || [];
    const standardCmds = available.filter(cmd => cmd !== 'custom' && !cmd.startsWith('saved:'));
    if (standardCmds.length > 0) {
        const stdGrp = document.createElement('optgroup');
        stdGrp.label = 'Device Settings & Commands';
        standardCmds.forEach(cmd => {
            const opt = document.createElement('option');
            opt.value = cmd;
            opt.textContent = formatCommandLabel(cmd, supportData);
            if (currentVal === cmd) opt.selected = true;
            stdGrp.appendChild(opt);
        });
        selectEl.appendChild(stdGrp);
    }

    // 4. Custom Command Option
    if (available.includes('custom') || (!userCmds.length && !savedCmds.length && !standardCmds.length)) {
        const customGrp = document.createElement('optgroup');
        customGrp.label = 'Custom Command';
        const customOpt = document.createElement('option');
        customOpt.value = 'custom';
        customOpt.textContent = 'Custom Command';
        if (currentVal === 'custom') customOpt.selected = true;
        customGrp.appendChild(customOpt);
        selectEl.appendChild(customGrp);
    }
}

// ================================================================
//  ALERTS SYSTEM
// ================================================================

function loadAlertsFromConfig(config) {
    alertRows = [];
    if (Array.isArray(config.alert_rows)) {
        config.alert_rows.forEach(r => alertRows.push(_alertRowWithFreshUid(r)));
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

function _cloneAlertRow(row) {
    return JSON.parse(JSON.stringify(row || {}));
}

function _alertRowWithFreshUid(row) {
    const clone = _cloneAlertRow(row);
    clone.uid = nextUid();
    return clone;
}

function _alertRowsForProfile(rows = alertRows) {
    return rows.map(row => {
        const clone = _cloneAlertRow(row);
        delete clone.uid;
        return clone;
    });
}

function _userLabelForExport(id) {
    const user = _findUserById(id);
    return user?.username || user?.email || null;
}

async function _ensureUsersForAlertProfileRows(rows = alertRows) {
    const myId = parseInt(localStorage.getItem('user_id'), 10);
    const myName = localStorage.getItem('username');
    if (myId && myName && !_findUserById(myId)) {
        _mergeUsersIntoCache([{ id: myId, username: myName }]);
    }

    if (hasAdminAccess) await loadAllUsers();

    const ids = new Set();
    rows.forEach(row => (row.notify_user_ids || []).forEach(id => {
        const numericId = _toId(id);
        if (numericId !== null && !_userLabelForExport(numericId)) ids.add(numericId);
    }));
    if (ids.size) await Promise.all([...ids].map(loadNotifyUserById));
}

async function _alertRowsForExport(rows = alertRows) {
    await _ensureUsersForAlertProfileRows(rows);
    return rows.map(row => {
        const clone = _cloneAlertRow(row);
        delete clone.uid;
        if (Array.isArray(clone.notify_user_ids)) {
            clone.notify_users = clone.notify_user_ids
                .map(_toId)
                .filter(id => id !== null)
                .map(_userLabelForExport)
                .filter(Boolean);
        }
        delete clone.notify_user_ids;
        return clone;
    });
}

function _findUserByNameOrEmail(value) {
    const needle = String(value || '').trim().toLowerCase();
    if (!needle) return null;
    return [...allUsers, ...deviceAlertUsers].find(u =>
        String(u.username || '').trim().toLowerCase() === needle ||
        String(u.email || '').trim().toLowerCase() === needle
    ) || null;
}

async function _resolveImportedAlertProfileUsers(rows) {
    const clonedRows = _alertRowsForProfile(rows);
    clonedRows.forEach(row => { delete row.notify_user_ids; });
    const needsNames = clonedRows.some(row => Array.isArray(row.notify_users) || Array.isArray(row.notify_usernames));
    if (!needsNames) return clonedRows;

    const myId = parseInt(localStorage.getItem('user_id'), 10);
    const myName = localStorage.getItem('username');
    if (myId && myName && !_findUserById(myId)) {
        _mergeUsersIntoCache([{ id: myId, username: myName }]);
    }
    if (hasAdminAccess) await loadAllUsers();

    clonedRows.forEach(row => {
        const names = row.notify_users || row.notify_usernames;
        if (!Array.isArray(names)) return;
        const ids = names
            .map(_findUserByNameOrEmail)
            .filter(Boolean)
            .map(u => _toId(u.id))
            .filter(id => id !== null);
        row.notify_user_ids = [...new Set(ids)];
        delete row.notify_users;
        delete row.notify_usernames;
    });
    return clonedRows;
}

function _alertProfileFromConfig(config = {}) {
    if (Array.isArray(config.alert_rows)) {
        return _alertRowsForProfile(config.alert_rows);
    }

    const rows = [];
    const ch = config.alert_channels || {};
    for (const [key] of Object.entries(ALERT_TYPES)) {
        if (config[key] != null) {
            rows.push({ alertKey: key, value: config[key], channels: ch[key] || [], schedule: null });
        }
    }
    (config.custom_rules || []).forEach(r => {
        const obj = typeof r === 'string' ? { name: 'Custom Alert', rule: r, channels: [] } : r;
        rows.push({ alertKey: '__custom__', name: obj.name, rule: obj.rule, channels: obj.channels || [], schedule: null });
    });
    return rows;
}

function _devicesWithAlertProfiles() {
    return devices
        .map(d => ({ device: d, rows: _alertProfileFromConfig(d.config || {}) }))
        .filter(item => item.device.id !== editingDeviceId && item.rows.length > 0)
        .sort((a, b) => String(a.device.name || '').localeCompare(String(b.device.name || '')));
}

function populateAlertProfileDeviceSelect() {
    renderAlertProfileDevicePicker();
}

function closeAlertProfileMenu() {
    const menu = document.getElementById('alertProfileMenu');
    const trigger = document.querySelector('.alert-profile-trigger');
    menu?.classList.remove('open');
    if (menu) {
        menu.style.left = '';
        menu.style.top = '';
    }
    trigger?.setAttribute('aria-expanded', 'false');
}

function positionAlertProfileMenu(trigger, menu) {
    const margin = 12;
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const width = menuRect.width || Math.min(320, window.innerWidth - margin * 2);
    const left = Math.min(
        Math.max(margin, triggerRect.right - width),
        window.innerWidth - width - margin
    );
    const top = Math.min(
        triggerRect.bottom + 6,
        window.innerHeight - menuRect.height - margin
    );
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(margin, top)}px`;
}

function repositionAlertProfileMenu() {
    const menu = document.getElementById('alertProfileMenu');
    const trigger = document.querySelector('.alert-profile-trigger');
    if (!menu?.classList.contains('open') || !trigger) return;
    positionAlertProfileMenu(trigger, menu);
}

function toggleAlertProfileMenu(event) {
    event?.stopPropagation();
    const menu = document.getElementById('alertProfileMenu');
    const trigger = event?.currentTarget || document.querySelector('.alert-profile-trigger');
    if (!menu) return;
    const isOpen = menu.classList.toggle('open');
    trigger?.setAttribute('aria-expanded', String(isOpen));
    if (isOpen && trigger) positionAlertProfileMenu(trigger, menu);
}

document.addEventListener('click', (event) => {
    if (!event.target.closest?.('.alert-profile-menu-wrap')) closeAlertProfileMenu();
});
window.addEventListener('resize', repositionAlertProfileMenu);
window.addEventListener('scroll', repositionAlertProfileMenu, true);

function _validAlertProfileRows(rows) {
    if (!Array.isArray(rows)) {
        showAlert({ title: 'Invalid alert profile', message: 'The selected file does not contain alert rows.', type: 'error' });
        return null;
    }
    return rows.filter(row => row && typeof row === 'object' && row.alertKey);
}

function _applyAlertRowsFromProfile(rows, sourceLabel, mode = 'replace') {
    const validRows = _validAlertProfileRows(rows);
    if (!validRows) return false;

    const newRows = validRows.map(_alertRowWithFreshUid);
    alertRows = mode === 'append' ? [...alertRows, ...newRows] : newRows;
    renderAlertsTable();
    populateAddAlertDropdown();
    refreshNativeEventAlerts();
    const verb = mode === 'append' ? 'appended' : 'loaded';
    showAlert({ title: 'Alert profile loaded', message: `${newRows.length} alert${newRows.length === 1 ? '' : 's'} ${verb}${sourceLabel ? ` from ${sourceLabel}` : ''}. Save the device to apply them.`, type: 'success' });
    return true;
}

function openAlertProfileMergeChoice(rows, sourceLabel, onDone) {
    const validRows = _validAlertProfileRows(rows);
    if (!validRows) return;

    if (!alertRows.length) {
        if (_applyAlertRowsFromProfile(validRows, sourceLabel, 'replace') && typeof onDone === 'function') onDone();
        return;
    }

    let modal = document.getElementById('alertProfileMergeModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'alertProfileMergeModal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width:460px;height:auto;">
                <div class="modal-header">
                    <h2 class="modal-title">Apply Alert Profile</h2>
                    <button type="button" class="modal-close" onclick="closeAlertProfileMergeChoice()"><i class="mdi mdi-close"></i></button>
                </div>
                <div class="modal-scrollable" style="padding:1rem 1.25rem;">
                    <div id="alertProfileMergeMessage" style="color:var(--text-secondary);line-height:1.5;"></div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" onclick="closeAlertProfileMergeChoice()">Cancel</button>
                    <button type="button" class="btn btn-secondary" onclick="applyPendingAlertProfile('append')"><i class="mdi mdi-plus"></i> Append</button>
                    <button type="button" class="btn btn-primary" onclick="applyPendingAlertProfile('replace')"><i class="mdi mdi-swap-horizontal"></i> Replace</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
    }

    window.pendingAlertProfile = { rows: validRows, sourceLabel, onDone };
    const message = document.getElementById('alertProfileMergeMessage');
    if (message) {
        message.textContent = `This device already has ${alertRows.length} alert${alertRows.length === 1 ? '' : 's'}. ${validRows.length} alert${validRows.length === 1 ? '' : 's'} will be applied${sourceLabel ? ` from ${sourceLabel}` : ''}.`;
    }
    modal.classList.add('active');
}

function closeAlertProfileMergeChoice() {
    window.pendingAlertProfile = null;
    document.getElementById('alertProfileMergeModal')?.classList.remove('active');
}

function applyPendingAlertProfile(mode) {
    const pending = window.pendingAlertProfile;
    if (!pending) return;
    if (_applyAlertRowsFromProfile(pending.rows, pending.sourceLabel, mode) && typeof pending.onDone === 'function') {
        pending.onDone();
    }
    closeAlertProfileMergeChoice();
}

function openAlertProfileDevicePicker() {
    closeAlertProfileMenu();
    const candidates = _devicesWithAlertProfiles();
    if (!candidates.length) {
        showAlert({ title: 'No source devices', message: 'No other devices have configured alerts to copy.', type: 'warning' });
        return;
    }

    let modal = document.getElementById('alertProfileDevicePickerModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'alertProfileDevicePickerModal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width:560px;height:auto;max-height:85vh;">
                <div class="modal-header">
                    <h2 class="modal-title">Copy Alerts From Device</h2>
                    <button type="button" class="modal-close" onclick="closeAlertProfileDevicePicker()"><i class="mdi mdi-close"></i></button>
                </div>
                <div class="modal-scrollable" style="padding:1rem 1.25rem;">
                    <input type="text" class="form-input" id="alertProfileDeviceSearch" placeholder="Search devices..." oninput="renderAlertProfileDevicePicker()" style="margin-bottom:0.75rem;">
                    <div class="alert-profile-device-list" id="alertProfileDeviceList"></div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" onclick="closeAlertProfileDevicePicker()">Cancel</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
    }

    modal.classList.add('active');
    renderAlertProfileDevicePicker();
    setTimeout(() => document.getElementById('alertProfileDeviceSearch')?.focus(), 0);
}

function closeAlertProfileDevicePicker() {
    document.getElementById('alertProfileDevicePickerModal')?.classList.remove('active');
}

function renderAlertProfileDevicePicker() {
    const list = document.getElementById('alertProfileDeviceList');
    if (!list) return;

    const q = (document.getElementById('alertProfileDeviceSearch')?.value || '').trim().toLowerCase();
    const rows = _devicesWithAlertProfiles().filter(({ device }) => {
        const haystack = [device.name, device.imei, device.license_plate, device.protocol]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
        return !q || haystack.includes(q);
    });

    if (!rows.length) {
        list.innerHTML = '<div style="padding:1rem;text-align:center;color:var(--text-muted);">No matching devices.</div>';
        return;
    }

    list.innerHTML = rows.map(({ device, rows }) => `
        <button type="button" class="alert-profile-device-option" onclick="copyAlertsFromDeviceId(${device.id})">
            <span style="min-width:0;">
                <span class="alert-profile-device-name">${_esc(device.name || `Device ${device.id}`)}</span>
                <span class="alert-profile-device-meta">${_esc([device.license_plate, device.protocol].filter(Boolean).join(' · ') || device.imei || '')}</span>
            </span>
            <span class="alert-profile-device-meta">${rows.length} alert${rows.length === 1 ? '' : 's'}</span>
        </button>
    `).join('');
}

function copyAlertsFromDeviceId(sourceId) {
    const source = devices.find(d => d.id === sourceId);
    if (!source) return;

    const rows = _alertProfileFromConfig(source.config || {});
    if (!rows.length) {
        showAlert({ title: 'No alerts to copy', message: `${source.name || 'The selected device'} has no configured alerts.`, type: 'warning' });
        return;
    }

    openAlertProfileMergeChoice(rows, source.name || `Device ${source.id}`, closeAlertProfileDevicePicker);
}

async function exportDeviceProfile() {
    closeAlertProfileMenu();
    const d = editingDeviceId ? devices.find(x => x.id === editingDeviceId) : null;

    const deviceName = document.getElementById('deviceName')?.value?.trim() || d?.name || 'device';
    const imei = document.getElementById('deviceImei')?.value?.trim() || d?.imei || null;
    const protocol = document.getElementById('deviceProtocol')?.value || d?.protocol || DEFAULT_PROTOCOL;
    const vehicleType = document.getElementById('vehicleType')?.value || d?.vehicle_type || DEFAULT_TYPE;
    const licensePlate = document.getElementById('licensePlate')?.value?.trim() || d?.license_plate || null;
    const customAttributes = readCustomAttributes();

    const companyIdEl = document.getElementById('deviceCompany');
    const companyId = companyIdEl ? (parseInt(companyIdEl.value, 10) || null) : (d?.company_id || null);
    const companyObj = companyId ? (companies || []).find(c => c.id === companyId) : null;
    const companyName = companyObj ? companyObj.name : null;

    const currentOdoVal = document.getElementById('currentOdometer')?.value;
    const currentOdoDist = (currentOdoVal != null && currentOdoVal !== '') ? fromDisplayDist(parseFloat(currentOdoVal) || 0) : (d?.state?.total_odometer ?? 0.0);

    const existingConfig = d?.config || {};

    const profile = {
        type: 'routario-device-profile',
        version: 2,
        exported_at: new Date().toISOString(),
        device: {
            name: deviceName,
            imei: imei,
            protocol: protocol,
            company_id: companyId,
            company_name: companyName,
            vehicle_type: vehicleType,
            license_plate: licensePlate,
            odometer: currentOdoDist,
            custom_attributes: customAttributes,
        },
        config: {
            offline_timeout_hours: parseInt(document.getElementById('offlineTimeoutHours')?.value) || existingConfig.offline_timeout_hours || 24,
            trip_merge_gap_minutes: parseInt(document.getElementById('tripMergeGapMinutes')?.value) || existingConfig.trip_merge_gap_minutes || 0,
            has_camera: document.getElementById('deviceHasCamera')?.checked ?? (existingConfig.has_camera || false),
            speed_tolerance: existingConfig.speed_tolerance ?? null,
            speed_duration_seconds: existingConfig.speed_duration_seconds ?? 30,
            idle_timeout_minutes: existingConfig.idle_timeout_minutes ?? null,
            towing_threshold_meters: existingConfig.towing_threshold_meters ?? null,
            integration: existingConfig.integration || null,
            sensors: existingConfig.sensors || {},
            maintenance: existingConfig.maintenance || {},
            user_commands: existingConfig.user_commands || [],
            alert_rows: await _alertRowsForExport(),
        }
    };

    const jsonStr = JSON.stringify([profile], null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const link = document.createElement('a');
    const safeName = deviceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'device';
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = `${safeName}-device-profile.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showAlert({ title: 'Profile Exported', message: `Exported complete device profile for "${deviceName}".`, type: 'success' });
}

function triggerImportDeviceJson() {
    let input = document.getElementById('importDeviceJsonFileInput');
    if (!input) {
        input = document.createElement('input');
        input.type = 'file';
        input.id = 'importDeviceJsonFileInput';
        input.accept = 'application/json,.json';
        input.style.display = 'none';
        input.onchange = handleImportDeviceJsonFile;
        document.body.appendChild(input);
    }
    input.click();
}

async function handleImportDeviceJsonFile(event) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
        try {
            const rawData = reader.result;
            const parsed = JSON.parse(rawData);

            let profiles = [];
            if (Array.isArray(parsed)) {
                profiles = parsed;
            } else if (Array.isArray(parsed.devices)) {
                profiles = parsed.devices;
            } else if (parsed && typeof parsed === 'object') {
                profiles = [parsed];
            }

            if (!profiles.length) {
                showAlert({ title: 'Import Failed', message: 'No valid device profiles found in the JSON file.', type: 'error' });
                return;
            }

            // Extract & normalize devices to be imported
            const itemsToImport = [];
            for (let i = 0; i < profiles.length; i++) {
                const item = profiles[i];
                const dev = item.device || item;
                const cfg = item.config || dev.config || {};

                const name = (dev.name || dev.device_name || `Imported Device #${i + 1}`).trim();
                const imei = (dev.imei || dev.device_imei || '').trim();
                const protocol = dev.protocol || dev.provider || DEFAULT_PROTOCOL;
                const vehicleType = dev.vehicle_type || DEFAULT_TYPE;
                const licensePlate = dev.license_plate || null;
                const customAttributes = dev.custom_attributes || {};
                const companyId = dev.company_id || null;

                if (!imei) {
                    showAlert({ title: 'Import Failed', message: `Device "${name}" (item #${i + 1}) is missing a required IMEI identifier. No devices were added.`, type: 'error' });
                    return;
                }

                itemsToImport.push({
                    name,
                    imei,
                    protocol,
                    vehicle_type: vehicleType,
                    license_plate: licensePlate,
                    custom_attributes: customAttributes,
                    company_id: companyId,
                    config: cfg,
                });
            }

            // Check for duplicates within the file itself
            const fileImeiSet = new Set();
            for (const item of itemsToImport) {
                const lowerImei = item.imei.toLowerCase();
                if (fileImeiSet.has(lowerImei)) {
                    showAlert({ title: 'Import Failed', message: `The import file contains duplicate IMEI "${item.imei}". No devices were added.`, type: 'error' });
                    return;
                }
                fileImeiSet.add(lowerImei);
            }

            // Check against existing devices in the system
            const existingImeis = new Map();
            (devices || []).forEach(d => {
                if (d.imei) existingImeis.set(String(d.imei).trim().toLowerCase(), d);
            });

            const conflictingDevices = [];
            for (const item of itemsToImport) {
                const match = existingImeis.get(item.imei.toLowerCase());
                if (match) {
                    conflictingDevices.push({ imei: item.imei, name: item.name, existingName: match.name });
                }
            }

            if (conflictingDevices.length > 0) {
                const conflictList = conflictingDevices.map(c => `• "${c.name}" (IMEI: ${c.imei})`).join('\n');
                showAlert({
                    title: 'Import Cancelled: Devices Already Exist',
                    message: `The following device(s) are already registered in the system:\n${conflictList}\n\nNo devices were added. Please remove existing devices or edit the JSON before importing.`,
                    type: 'error',
                    duration: 15000,
                });
                return;
            }

            // Create all devices via API
            let importedCount = 0;
            for (const item of itemsToImport) {
                const payload = {
                    name: item.name,
                    imei: item.imei,
                    protocol: item.protocol,
                    vehicle_type: item.vehicle_type,
                    license_plate: item.license_plate,
                    custom_attributes: item.custom_attributes,
                    config: item.config,
                };
                if (item.company_id && isAdmin) payload.company_id = item.company_id;

                const res = await apiFetch(`${API_BASE}/devices`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });

                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.detail || `Failed to create device "${item.name}"`);
                }
                importedCount++;
            }

            await loadDevices();
            showAlert({
                title: 'Import Successful',
                message: `Successfully imported ${importedCount} device(s).`,
                type: 'success',
            });
        } catch (e) {
            console.error('Failed to import devices from JSON:', e);
            showAlert({ title: 'Import Failed', message: e.message || 'An error occurred while importing devices.', type: 'error' });
        } finally {
            input.value = '';
        }
    };

    reader.onerror = () => {
        showAlert({ title: 'Import Failed', message: 'Failed to read the selected file.', type: 'error' });
        input.value = '';
    };
    reader.readAsText(file);
}

function importAlertProfileFile(event) {
    closeAlertProfileMenu();
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
        try {
            const parsed = JSON.parse(reader.result);

            const item = (Array.isArray(parsed) && parsed.length > 0 && (parsed[0].device || parsed[0].config))
                ? parsed[0]
                : parsed;

            const dev = item.device || item;
            const cfg = item.config || dev.config || item;

            // 1. If general options exist in profile, apply them to the form inputs
            if (dev.vehicle_type && document.getElementById('vehicleType')) {
                document.getElementById('vehicleType').value = dev.vehicle_type;
            }
            if (dev.license_plate !== undefined && document.getElementById('licensePlate')) {
                document.getElementById('licensePlate').value = dev.license_plate || '';
            }
            if (dev.custom_attributes && typeof dev.custom_attributes === 'object') {
                renderCustomAttributes(dev.custom_attributes);
            }

            if (cfg.offline_timeout_hours != null && document.getElementById('offlineTimeoutHours')) {
                document.getElementById('offlineTimeoutHours').value = cfg.offline_timeout_hours;
            }
            if (cfg.trip_merge_gap_minutes != null && document.getElementById('tripMergeGapMinutes')) {
                document.getElementById('tripMergeGapMinutes').value = cfg.trip_merge_gap_minutes;
            }
            if (cfg.has_camera != null && document.getElementById('deviceHasCamera')) {
                document.getElementById('deviceHasCamera').checked = Boolean(cfg.has_camera);
            }

            // 2. Extract alert_rows
            const rows = Array.isArray(item.alert_rows)
                ? item.alert_rows
                : Array.isArray(cfg.alert_rows)
                ? cfg.alert_rows
                : (Array.isArray(parsed) && parsed.every(r => r.alertKey || r.alert_type))
                ? parsed
                : _alertProfileFromConfig(cfg);

            const resolvedRows = await _resolveImportedAlertProfileUsers(rows);

            openAlertProfileMergeChoice(resolvedRows, dev.name || item.device_name || file.name, () => {
                showAlert({ title: 'Profile Imported', message: `Device profile loaded successfully from ${file.name}.`, type: 'success' });
            });
        } catch (e) {
            console.error('Import error:', e);
            showAlert({ title: 'Import failed', message: 'Choose a valid Routario device profile JSON file.', type: 'error' });
        } finally {
            input.value = '';
        }
    };
    reader.onerror = () => {
        showAlert({ title: 'Import failed', message: 'The selected file could not be read.', type: 'error' });
        input.value = '';
    };
    reader.readAsText(file);
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

    const _curUid = parseInt(localStorage.getItem('user_id'), 10) || null;

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
                duration: null,
                notify_user_ids: _curUid ? [_curUid] : null,
                send_push: true,
                send_email: false,
                send_voip: false,
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
    alertRows.push({ uid: nextUid(), alertKey: val, params, channels: [], schedule: null, notify_user_ids: _curUid ? [_curUid] : null, send_push: true, send_email: false, send_voip: false });
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
    const _curUid = parseInt(localStorage.getItem('user_id'), 10) || null;
    alertRows.push({ uid: nextUid(), alertKey: '__custom__', name, rule, channels: [], schedule: null, duration: null, notify_user_ids: _curUid ? [_curUid] : null, send_push: true, send_email: false, send_voip: false });
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

        const activePills = [];
        if (row.send_push !== false) {
            activePills.push(`<span class="channel-pill active" title="Web Push Notification Enabled" style="pointer-events:none;"><i class="mdi mdi-cellphone-arrow-down"></i> Push</span>`);
        }
        if (isEmailNotificationAvailable() && row.send_email === true) {
            activePills.push(`<span class="channel-pill active" title="System Email Notification Enabled" style="pointer-events:none;"><i class="mdi mdi-email-outline"></i> Email</span>`);
        }
        if (isVoipNotificationAvailable() && row.send_voip === true) {
            activePills.push(`<span class="channel-pill active" title="VoIP Voice Call Alarm Enabled" style="pointer-events:none;"><i class="mdi mdi-phone-in-talk"></i> Voice Call</span>`);
        }
        if (Array.isArray(row.channels)) {
            const currentUserId = parseInt(localStorage.getItem('user_id'), 10);
            const visibleChannels = _getVisibleNotificationChannels(currentUserId);
            row.channels.forEach(c => {
                const found = visibleChannels.find(ac => ac.id === c || ac.name === c);
                if (!found) return; // Do not show channels that belong to parent / higher hierarchy users
                const chName = found.name || found.id || c;
                const displayName = (found.isOtherUser && found.username) ? `${chName} (${found.username})` : chName;
                activePills.push(`<span class="channel-pill active" style="pointer-events:none;">${_esc(displayName)}</span>`);
            });
        }
        if (row.action_command && row.action_command !== 'disabled') {
            const cachedSupport = editingDeviceId ? deviceCommandSupportCache[editingDeviceId] : null;
            const cmdLabel = formatCommandLabel(row.action_command, cachedSupport || {});
            activePills.push(`<span class="channel-pill active" title="Automated Device Command" style="pointer-events:none; border-color:rgba(99,102,241,0.5);"><i class="mdi mdi-console"></i> ${_esc(cmdLabel)}</span>`);
        }
        const chHtml = activePills.length
            ? activePills.join('')
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
                        if (user) {
                            if (!isAdmin && user.is_admin) return null;
                            return user;
                        }
                        const numId = _toId(id);
                        if (isAdmin && (allUsersLoaded || allUsersLoadFailed || (numId !== null && notifyUserLoadFailedIds.has(numId)))) {
                            return { id, username: `User #${id}` };
                        }
                        return null;
                    })
                    .filter(Boolean);

                if (visibleUsers.length === 0) {
                    notifyUsersCell = `<td><span style="color:var(--text-muted);font-size:0.8rem;">None</span></td>`;
                } else {
                    notifyUsersCell = `<td><div style="display:flex;flex-wrap:wrap;gap:0.3rem;">${
                        visibleUsers.map(u => `<span class="channel-pill active" style="pointer-events:none;font-size:0.75rem;">${_esc(u.username)}</span>`).join('')
                    }</div></td>`;
                }
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
                <button type="button" class="btn btn-secondary tbl-btn" title="View Alert History & Test Trigger" onclick="openAlertHistoryForAlert(${row.uid})"><i class="mdi mdi-history"></i></button>
                <button type="button" class="btn btn-secondary tbl-btn" title="Edit Alert" onclick="openAlertEditor(${row.uid})"><i class="mdi mdi-pencil"></i></button>
                <button type="button" class="btn btn-danger    tbl-btn" title="Delete Alert" onclick="removeAlertRow(${row.uid})"><i class="mdi mdi-close"></i></button>
            </td>`;
        tbody.appendChild(tr);
    });
}

// ── Alert Rule History & Manual Test Modal ─────────────────────────────────
let currentHistoryAlertUid = null;

function openAlertHistoryForAlert(uid) {
    const row = alertRows.find(r => r.uid === uid);
    if (!row) return;
    currentHistoryAlertUid = uid;

    const isCustom = row.alertKey === '__custom__';
    const def = isCustom ? null : ALERT_TYPES[row.alertKey];
    const isDeviceEvent = row.alertKey === 'device_event';
    const alertTitle = isCustom
        ? (row.name || 'Custom Rule')
        : isDeviceEvent
        ? (row.params?.event_label || row.params?.sensor_key || 'Device Event')
        : (def?.label || row.alertKey);

    const device = devices.find(d => d.id === editingDeviceId);
    const devName = device ? device.name : (editingDeviceId ? `Device #${editingDeviceId}` : 'New Vehicle');

    let modal = document.getElementById('alertRuleHistoryModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'alertRuleHistoryModal';
        modal.style.zIndex = '10050';
        modal.innerHTML = `
            <div class="modal-content" style="max-width:960px;width:95%;height:auto;max-height:86vh;display:flex;flex-direction:column;border-radius:16px;box-shadow:0 20px 40px rgba(0,0,0,0.45);">
                <div class="modal-header" style="padding:1.1rem 1.4rem;border-bottom:1px solid var(--border-color);">
                    <div>
                        <h2 class="modal-title" style="display:flex;align-items:center;gap:0.5rem;" id="alertRuleHistoryTitle">
                            <i class="mdi mdi-history" style="color:var(--accent-primary);"></i>
                            <span>Alert History</span>
                        </h2>
                        <div id="alertRuleHistorySubtitle" style="display:flex;align-items:center;gap:0.5rem;font-size:0.82rem;color:var(--text-muted);margin-top:0.35rem;"></div>
                    </div>
                    <button type="button" class="modal-close" onclick="closeAlertRuleHistoryModal()"><i class="mdi mdi-close"></i></button>
                </div>

                <div style="padding:0.85rem 1.4rem;background:var(--bg-tertiary);border-bottom:1px solid var(--border-color);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;">
                    <div style="display:flex;align-items:center;gap:0.5rem;font-size:0.84rem;color:var(--text-secondary);">
                        <i class="mdi mdi-broadcast" style="color:var(--accent-primary);font-size:1.1rem;"></i>
                        <span>Trigger a real-time test alert across all configured channels & recipients.</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:0.5rem;">
                        <button type="button" class="btn btn-primary" id="btnTriggerTestAlert" onclick="triggerTestAlertForCurrentRule()" style="font-size:0.84rem;padding:0.42rem 0.95rem;font-weight:600;">
                            <i class="mdi mdi-bell-ring-outline"></i> Trigger Test Alert
                        </button>
                        <button type="button" class="btn btn-secondary" onclick="loadAlertRuleHistoryData()" title="Refresh history" style="font-size:0.84rem;padding:0.42rem 0.75rem;">
                            <i class="mdi mdi-refresh"></i> Refresh
                        </button>
                    </div>
                </div>

                <div class="modal-scrollable" style="padding:1.2rem 1.4rem;flex:1;overflow-y:auto;">
                    <div id="alertRuleHistoryLoading" style="text-align:center;padding:3rem;color:var(--text-muted);">
                        <i class="mdi mdi-loading mdi-spin" style="font-size:2rem;color:var(--accent-primary);margin-bottom:0.5rem;display:inline-block;"></i>
                        <div style="font-size:0.9rem;">Loading alert history...</div>
                    </div>
                    <div id="alertRuleHistoryEmpty" style="display:none;text-align:center;padding:3.5rem 2rem;color:var(--text-muted);background:var(--bg-secondary);border:1px dashed var(--border-color);border-radius:12px;">
                        <i class="mdi mdi-bell-off-outline" style="font-size:2.8rem;opacity:0.45;margin-bottom:0.75rem;display:inline-block;color:var(--text-secondary);"></i>
                        <div style="font-weight:600;font-size:1rem;color:var(--text-primary);margin-bottom:0.35rem;">No alert history recorded yet</div>
                        <div style="font-size:0.85rem;color:var(--text-secondary);">Click <strong>"Trigger Test Alert"</strong> above to dispatch and verify notifications.</div>
                    </div>
                    <div class="alerts-table-wrap" id="alertRuleHistoryTableWrap" style="display:none;border:1px solid var(--border-color);border-radius:12px;overflow:hidden;background:var(--bg-secondary);">
                        <table class="alert-history-table raw-data-table" id="alertRuleHistoryTable" style="width:100%;">
                            <thead>
                                <tr>
                                    <th style="width:145px;">Date / Time</th>
                                    <th style="width:105px;">Severity</th>
                                    <th>Message</th>
                                    <th style="width:250px;">Channels Triggered</th>
                                    <th style="width:85px;text-align:center;">Status</th>
                                </tr>
                            </thead>
                            <tbody id="alertRuleHistoryTableBody"></tbody>
                        </table>
                    </div>
                </div>

                <div class="modal-footer" style="padding:0.85rem 1.4rem;border-top:1px solid var(--border-color);">
                    <button type="button" class="btn btn-secondary" onclick="closeAlertRuleHistoryModal()">Close</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
    }

    const titleEl = document.getElementById('alertRuleHistoryTitle');
    if (titleEl) {
        titleEl.innerHTML = `
            <i class="mdi mdi-history" style="color:var(--accent-primary);"></i>
            <span>${_esc(alertTitle)} History</span>
        `;
    }
    const subEl = document.getElementById('alertRuleHistorySubtitle');
    if (subEl) {
        subEl.innerHTML = `
            <span style="background:var(--bg-hover);border:1px solid var(--border-color);padding:0.15rem 0.5rem;border-radius:6px;font-size:0.78rem;font-weight:600;color:var(--text-primary);"><i class="mdi mdi-car"></i> ${_esc(devName)}</span>
            <span style="background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.25);padding:0.15rem 0.5rem;border-radius:6px;font-size:0.78rem;font-weight:600;color:var(--accent-primary);"><i class="mdi mdi-bell-ring-outline"></i> ${_esc(alertTitle)}</span>
        `;
    }

    modal.classList.add('active');
    loadAlertRuleHistoryData();
}

function closeAlertRuleHistoryModal() {
    currentHistoryAlertUid = null;
    document.getElementById('alertRuleHistoryModal')?.classList.remove('active');
}
window.closeAlertRuleHistoryModal = closeAlertRuleHistoryModal;

async function loadAlertRuleHistoryData() {
    const row = alertRows.find(r => r.uid === currentHistoryAlertUid);
    if (!row) return;

    const loadingEl = document.getElementById('alertRuleHistoryLoading');
    const emptyEl   = document.getElementById('alertRuleHistoryEmpty');
    const wrapEl    = document.getElementById('alertRuleHistoryTableWrap');
    const tableEl   = document.getElementById('alertRuleHistoryTable');
    const tbody     = document.getElementById('alertRuleHistoryTableBody');

    if (loadingEl) loadingEl.style.display = 'block';
    if (emptyEl) emptyEl.style.display = 'none';
    if (wrapEl) wrapEl.style.display = 'none';
    if (tableEl) tableEl.style.display = 'none';

    try {
        const isCustom = row.alertKey === '__custom__';
        const alertType = isCustom ? 'custom' : row.alertKey;
        const deviceId = editingDeviceId;

        let url = `${API_BASE}/alerts/report?limit=100`;
        if (deviceId) url += `&device_ids=${deviceId}`;
        if (alertType) url += `&alert_type=${encodeURIComponent(alertType)}`;

        const res = await apiFetch(url);
        if (!res.ok) throw new Error('Failed to load alert history');
        let data = await res.json();

        // If custom alert, filter by rule_name if set
        if (isCustom && row.name && Array.isArray(data)) {
            data = data.filter(a => {
                const meta = a.alert_metadata || {};
                return meta.rule_name === row.name || a.message?.includes(row.name);
            });
        }

        if (loadingEl) loadingEl.style.display = 'none';

        if (!data || !data.length) {
            if (emptyEl) emptyEl.style.display = 'block';
            if (wrapEl) wrapEl.style.display = 'none';
            if (tableEl) tableEl.style.display = 'none';
            return;
        }

        if (emptyEl) emptyEl.style.display = 'none';
        if (wrapEl) wrapEl.style.display = 'block';
        if (tableEl) tableEl.style.display = 'table';
        if (tbody) {
            tbody.innerHTML = data.map(item => {
                let ts = '—';
                if (item.created_at) {
                    const raw = String(item.created_at);
                    const dtObj = new Date(raw.endsWith('Z') || raw.includes('+') ? raw : raw + 'Z');
                    if (!isNaN(dtObj.getTime())) {
                        const datePart = typeof formatDateValue === 'function' ? formatDateValue(dtObj) : dtObj.toLocaleDateString();
                        const timePart = typeof formatTimeValue === 'function' ? formatTimeValue(dtObj, { withSeconds: true }) : dtObj.toLocaleTimeString();
                        ts = `<span style="display:block;font-weight:600;color:var(--text-primary);font-size:0.84rem;">${_esc(datePart)}</span><span style="display:block;color:var(--text-muted);font-size:0.75rem;">${_esc(timePart)}</span>`;
                    }
                }
                const sev = (item.severity || 'warning').toLowerCase();
                const sevClass = (sev === 'critical' || sev === 'high') ? 'sev-critical' : (sev === 'warning' ? 'sev-warning' : 'sev-info');
                const isRead = item.is_read
                    ? '<span class="badge" style="background:rgba(255,255,255,0.05);color:var(--text-muted);border:1px solid var(--border-color);font-size:0.72rem;padding:0.2rem 0.55rem;border-radius:6px;font-weight:500;">Read</span>'
                    : '<span class="badge" style="background:rgba(59,130,246,0.12);color:var(--accent-primary);border:1px solid rgba(59,130,246,0.28);font-size:0.72rem;padding:0.2rem 0.55rem;border-radius:6px;font-weight:700;">Unread</span>';

                // Format channel badges matching the enhanced design
                const channelStatuses = item.channel_status || item.alert_metadata?.channel_status || [];
                let chHtml = '';
                if (channelStatuses && channelStatuses.length) {
                    chHtml = channelStatuses.map(ch => {
                        const name = ch.name || 'Channel';
                        const nameLower = name.toLowerCase();
                        let icon = 'mdi-bullhorn-outline';
                        if (nameLower.includes('push')) icon = 'mdi-bell-ring-outline';
                        else if (nameLower.includes('email') || nameLower.includes('mail')) icon = 'mdi-email-outline';
                        else if (nameLower.includes('voip') || nameLower.includes('call') || nameLower.includes('phone') || nameLower.includes('sip')) icon = 'mdi-phone-in-talk-outline';
                        else if (nameLower.includes('telegram')) icon = 'mdi-telegram';
                        else if (nameLower.includes('discord')) icon = 'mdi-discord';
                        else if (nameLower.includes('slack')) icon = 'mdi-slack';
                        else if (nameLower.includes('webhook')) icon = 'mdi-webhook';

                        const isOk = ch.status === 'sent' || ch.status === 'delivered' || ch.status === 'success';
                        const isSkipped = ch.status === 'skipped';
                        const stateClass = isOk ? 'sent' : (isSkipped ? 'skipped' : 'failed');
                        const stateIcon = isOk ? 'mdi-check' : (isSkipped ? 'mdi-minus' : 'mdi-close');

                        let titleText = `${name}: ${ch.status || 'unknown'}`;
                        if (ch.error) titleText += ` (${ch.error})`;

                        return `<span class="alert-hist-channel-badge ${stateClass}" title="${_esc(titleText)}"><i class="mdi ${icon}"></i> <span>${_esc(name)}</span> <i class="mdi ${stateIcon}" style="font-size:0.7rem;opacity:0.85;"></i></span>`;
                    }).join(' ');
                } else {
                    chHtml = '<span style="color:var(--text-muted);font-size:0.78rem;">—</span>';
                }

                return `
                    <tr>
                        <td style="white-space:nowrap;line-height:1.35;">${ts}</td>
                        <td><span class="severity-badge ${sevClass}" style="font-size:0.72rem;padding:0.2rem 0.55rem;text-transform:capitalize;font-weight:700;">${_esc(sev)}</span></td>
                        <td style="font-size:0.85rem;color:var(--text-primary);max-width:280px;line-height:1.45;word-break:break-word;font-weight:500;">${_esc(item.message || '')}</td>
                        <td><div style="display:flex;flex-wrap:wrap;gap:0.3rem;">${chHtml}</div></td>
                        <td style="text-align:center;">${isRead}</td>
                    </tr>
                `;
            }).join('');
        }
    } catch (err) {
        if (loadingEl) loadingEl.style.display = 'none';
        if (emptyEl) {
            emptyEl.style.display = 'block';
            emptyEl.innerHTML = `<span style="color:var(--accent-danger);">Failed to load history: ${_esc(err.message)}</span>`;
        }
    }
}

async function triggerTestAlertForCurrentRule() {
    const row = alertRows.find(r => r.uid === currentHistoryAlertUid);
    if (!row) return;

    if (!editingDeviceId) {
        showAlert({ title: 'Device not saved', message: 'Please save the vehicle before triggering test alerts.', type: 'warning' });
        return;
    }

    const btn = document.getElementById('btnTriggerTestAlert');
    const originalText = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i> Dispatching...';
    }

    try {
        const isCustom = row.alertKey === '__custom__';
        const isDeviceEvent = row.alertKey === 'device_event';
        const alertType = isCustom ? 'custom' : row.alertKey;
        const ruleName = isCustom
            ? row.name
            : isDeviceEvent
            ? (row.params?.event_label || row.params?.sensor_key || 'Device Event')
            : (ALERT_TYPES[row.alertKey]?.label || row.alertKey);

        let ruleParams = row.params ? { ...row.params } : (row.value != null ? { value: row.value } : {});
        if (row.alertKey === 'geofence_alert' || ruleParams.geofence_id) {
            const foundGf = cachedGeofenceOptions.find(o => String(o.value) === String(ruleParams.geofence_id));
            if (foundGf && foundGf.label) {
                ruleParams.geofence_name = foundGf.label;
            }
        }

        const payload = {
            device_id: editingDeviceId,
            alert_type: alertType,
            rule_name: ruleName,
            severity: row.severity || 'warning',
            params: ruleParams,
            channels: row.channels || [],
            notify_user_ids: row.notify_user_ids || null,
            send_push: row.send_push !== false,
            send_email: row.send_email === true,
            send_voip: row.send_voip === true,
        };

        const res = await apiFetch(`${API_BASE}/alerts/test-trigger`, {
            method: 'POST',
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Test alert dispatch failed');
        }

        const result = await res.json();
        showAlert('Test alert triggered and dispatched successfully!', 'success');

        // Refresh history table
        await loadAlertRuleHistoryData();
    } catch (err) {
        showAlert(err.message || 'Failed to trigger test alert', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
}

function renderAlertEditorCommandOptions(cmdKey, supportData, currentPayload = '') {
    const box = document.getElementById('editor-command-params-box');
    if (!box) return;

    if (!cmdKey || cmdKey === 'disabled') {
        box.style.display = 'none';
        box.innerHTML = '';
        return;
    }

    const info = (supportData?.command_info || {})[cmdKey] || {};
    const hasFields = info.fields && Array.isArray(info.fields) && info.fields.length > 0;
    const requiresParams = info.requires_params || cmdKey === 'custom' || cmdKey.startsWith('setting:');

    if (!requiresParams && !hasFields) {
        box.style.display = 'none';
        box.innerHTML = '';
        return;
    }

    box.style.display = 'block';
    if (hasFields) {
        let fieldsHtml = `<div style="font-size:0.82rem;font-weight:600;margin-bottom:0.5rem;color:var(--text-secondary);">Command Options & Parameters</div>`;
        info.fields.forEach(f => {
            let val = f.default ?? '';
            if (currentPayload) {
                try {
                    const parsed = JSON.parse(currentPayload);
                    if (parsed && typeof parsed === 'object' && parsed[f.key] !== undefined) {
                        val = parsed[f.key];
                    } else {
                        val = currentPayload;
                    }
                } catch(e) {
                    val = currentPayload;
                }
            }
            fieldsHtml += `
                <div style="margin-bottom:0.5rem;">
                    <label class="form-label" style="font-size:0.78rem;">${_esc(f.label || f.key)}${f.required ? ' *' : ''}</label>
                    <input type="text" class="form-input editor-cmd-param-field" data-key="${_esc(f.key)}" value="${_esc(String(val))}" placeholder="${_esc(f.placeholder || '')}">
                    ${f.help_text ? `<div class="form-help" style="font-size:0.75rem;">${_esc(f.help_text)}</div>` : ''}
                </div>
            `;
        });
        box.innerHTML = fieldsHtml;
    } else {
        box.innerHTML = `
            <div style="margin-top:0.5rem;">
                <label class="form-label" style="font-size:0.82rem;">Command Payload / Parameters</label>
                <input type="text" id="editor-action-command-payload" class="form-input" value="${_esc(currentPayload || '')}" placeholder="Enter command parameters or payload string">
                ${info.description ? `<div class="form-help" style="font-size:0.75rem;">${_esc(info.description)}</div>` : ''}
            </div>
        `;
    }
}

// ── Alert Editor ──────────────────────────────────────────────────
async function openAlertEditor(uid) {
    if (typeof syncPublicSystemSettings === 'function') {
        await syncPublicSystemSettings();
    } else {
        await loadPublicSettings();
    }
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

    const pushPillHtml = `
        <label class="channel-pill${row.send_push !== false ? ' active' : ''}">
            <input type="checkbox" id="editor-send-push" ${row.send_push !== false ? 'checked' : ''}>
            <i class="mdi mdi-cellphone-arrow-down"></i> Push
        </label>
    `;

    const isEmailAvailable = isEmailNotificationAvailable();
    const emailPillHtml = isEmailAvailable ? `
        <label class="channel-pill${row.send_email === true ? ' active' : ''}">
            <input type="checkbox" id="editor-send-email" ${row.send_email === true ? 'checked' : ''}>
            <i class="mdi mdi-email-outline"></i> Email
        </label>
    ` : '';

    const isVoipAvailable = isVoipNotificationAvailable();
    const voipPillHtml = isVoipAvailable ? `
        <label class="channel-pill${row.send_voip === true ? ' active' : ''}">
            <input type="checkbox" id="editor-send-voip" ${row.send_voip === true ? 'checked' : ''}>
            <i class="mdi mdi-phone-in-talk"></i> Voice Call
        </label>
    ` : '';

    const selectedCh = row.channels || [];
    const currentUserId = parseInt(localStorage.getItem('user_id'), 10);
    const visibleChannels = _getVisibleNotificationChannels(currentUserId);

    // Channels on this alert that are NOT visible to current user (i.e. belongs to parent)
    // are preserved so saving the alert doesn't drop them.
    const hiddenChannels = selectedCh.filter(chKey =>
        !visibleChannels.some(c => (c.id || c.name) === chKey || (c.name && c.name === chKey))
    );

    const userChannelPills = visibleChannels.map(c => {
        const key = c.id || c.name;
        const isChecked = selectedCh.includes(key) || (c.name && selectedCh.includes(c.name));
        const baseName = c.name || key;
        const displayName = (c.isOtherUser && c.username) ? `${baseName} (${c.username})` : baseName;
        return `
        <label class="channel-pill${isChecked ? ' active' : ''}">
            <input type="checkbox" class="editor-channel-cb" value="${_esc(key)}"${isChecked ? ' checked' : ''}>
            ${_esc(displayName)}
        </label>`;
    }).join('');

    const totalChannelCount = 1 + (isEmailAvailable ? 1 : 0) + (isVoipAvailable ? 1 : 0) + visibleChannels.length;
    const channelSearchHtml = totalChannelCount >= 6 ? `
        <div style="position:relative;margin-bottom:0.5rem;">
            <input type="search" class="form-input" id="alertEditorChannelSearch" placeholder="Search channels..." oninput="filterAlertEditorChannels()" style="padding:0.35rem 0.65rem 0.35rem 2rem;font-size:0.8rem;width:100%;">
            <i class="mdi mdi-magnify" style="position:absolute;left:0.65rem;top:50%;transform:translateY(-50%);color:var(--text-muted);font-size:1rem;pointer-events:none;"></i>
        </div>` : '';

    const chHtml = pushPillHtml + emailPillHtml + voipPillHtml + userChannelPills +
        `<input type="hidden" id="alertEditorHiddenChannels" value="${_escAttrJson(hiddenChannels)}">`;

    let notifyUsersHtml = '';
    if (hasAdminAccess && editingDeviceId) {
        try {
            const currentUserId = parseInt(localStorage.getItem('user_id'), 10);
            const fetchedUsers = await loadAllUsers();

            const userMap = new Map();
            (fetchedUsers || []).forEach(u => {
                if (!isAdmin && u.is_admin) return;
                userMap.set(_toId(u.id), u);
            });

            const curUser = _findUserById(currentUserId);
            if (currentUserId && (isAdmin || !curUser?.is_admin) && !userMap.has(currentUserId)) {
                userMap.set(currentUserId, { id: currentUserId, username: localStorage.getItem('username') || 'me' });
            }

            const existingIds = (row.notify_user_ids ?? []).map(_toId).filter(id => id !== null);
            for (const uid of existingIds) {
                if (!userMap.has(uid)) {
                    const known = _findUserById(uid);
                    if (known && (isAdmin || !known.is_admin)) userMap.set(uid, known);
                }
            }

            const deviceUsers = Array.from(userMap.values());
            _mergeUsersIntoCache(deviceUsers);
            deviceUsers.forEach(u => {
                if (!allUsers.some(a => _sameId(a.id, u.id))) allUsers.push(u);
            });

            // Default selection: if notify_user_ids is null/undefined (All mode), select all; otherwise select specified IDs
            const isAllMode = row.notify_user_ids == null;
            const selectedIds = isAllMode ? new Set(deviceUsers.map(u => _toId(u.id))) : _idSet(existingIds);
            const hiddenIds = existingIds.filter(id => {
                const user = _findUserById(id);
                if (!isAdmin && user?.is_admin) return false;
                return !deviceUsers.some(u => _sameId(u.id, id));
            });

            const pills = deviceUsers.map(u =>
                `<label class="channel-pill${selectedIds.has(_toId(u.id)) ? ' active' : ''}">
                    <input type="checkbox" class="editor-notify-user-cb" value="${u.id}"${selectedIds.has(_toId(u.id)) ? ' checked' : ''}>
                    ${_esc(u.username)}${_sameId(u.id, currentUserId) ? ' (you)' : ''}
                </label>`
            ).join('');

            const userSearchHtml = deviceUsers.length >= 6 ? `
                <div style="position:relative;margin-bottom:0.5rem;">
                    <input type="search" class="form-input" id="alertEditorUserSearch" placeholder="Search users..." oninput="filterAlertEditorUsers()" style="padding:0.35rem 0.65rem 0.35rem 2rem;font-size:0.8rem;width:100%;">
                    <i class="mdi mdi-magnify" style="position:absolute;left:0.65rem;top:50%;transform:translateY(-50%);color:var(--text-muted);font-size:1rem;pointer-events:none;"></i>
                </div>` : '';

            notifyUsersHtml = `<div class="form-group">
                <label class="form-label">Notify Users</label>
                <input type="hidden" id="alertEditorHiddenNotifyIds" value="${_escAttrJson(hiddenIds)}">
                ${userSearchHtml}
                <div id="alertEditorUsersList" style="display:flex;flex-wrap:wrap;gap:0.4rem;max-height:180px;overflow-y:auto;padding:2px 0;">${pills}</div>
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
                    <label class="form-label">Notify Via Channels</label>
                    ${channelSearchHtml}
                    <div id="alertEditorChannelsList" style="display:flex;flex-wrap:wrap;gap:0.4rem;max-height:180px;overflow-y:auto;padding:2px 0;">${chHtml}</div>
                </div>
                ${notifyUsersHtml}
                <div class="form-group" id="editor-command-group" style="margin-top:1.25rem; display:none;">
                    <label class="form-label"><i class="mdi mdi-console"></i> Execute Device Command</label>
                    <select class="form-input" id="editor-action-command">
                        <option value="disabled"${!row.action_command || row.action_command === 'disabled' ? ' selected' : ''}>Disabled</option>
                        <option value="" disabled>Loading commands...</option>
                    </select>
                    <div id="editor-command-params-box" style="display:none; margin-top:0.75rem;"></div>
                    <div class="form-help" style="margin-top:0.25rem;">Automatically send this command to the device when this alert triggers.</div>
                </div>
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

    if (editingDeviceId) {
        fetchDeviceCommandSupport(editingDeviceId).then(supportData => {
            const group = document.getElementById('editor-command-group');
            const select = document.getElementById('editor-action-command');
            if (!group || !select) return;

            if (supportData && supportData.supports_commands) {
                group.style.display = '';
                populateAlertEditorCommandSelect(select, supportData, row.action_command);

                const updateParamsUI = () => {
                    renderAlertEditorCommandOptions(select.value, supportData, row.action_command_payload);
                };

                select.onchange = updateParamsUI;
                updateParamsUI();
            } else {
                group.style.display = 'none';
            }
        });
    }

    const durCb  = document.getElementById('editor-duration-enabled');
    const durInp = document.getElementById('editor-duration-input');
    if (durCb && durInp) durCb.addEventListener('change', () => { durInp.disabled = !durCb.checked; });

    document.querySelectorAll('#editor-day-picker .day-pill').forEach(pill => {
        const cb = pill.querySelector('input');
        if (!cb) return;
        pill.classList.toggle('active', cb.checked);
        cb.addEventListener('change', () => { pill.classList.toggle('active', cb.checked); });
    });
    document.querySelectorAll('#alertEditorBody .channel-pill').forEach(pill => {
        const cb = pill.querySelector('input');
        if (!cb) return;
        cb.addEventListener('change', () => { pill.classList.toggle('active', cb.checked); });
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

function filterAlertEditorChannels() {
    const q = (document.getElementById('alertEditorChannelSearch')?.value || '').trim().toLowerCase();
    const container = document.getElementById('alertEditorChannelsList');
    if (!container) return;
    let visibleCount = 0;
    container.querySelectorAll('.channel-pill').forEach(pill => {
        const text = (pill.textContent || '').trim().toLowerCase();
        const match = !q || text.includes(q);
        pill.style.display = match ? '' : 'none';
        if (match) visibleCount++;
    });
    let noMatch = document.getElementById('alertEditorNoChannels');
    if (visibleCount === 0 && q) {
        if (!noMatch) {
            noMatch = document.createElement('div');
            noMatch.id = 'alertEditorNoChannels';
            noMatch.style.cssText = 'color:var(--text-muted);font-size:0.8rem;padding:0.3rem 0;';
            noMatch.textContent = 'No matching channels';
            container.appendChild(noMatch);
        }
        noMatch.style.display = '';
    } else if (noMatch) {
        noMatch.style.display = 'none';
    }
}

function filterAlertEditorUsers() {
    const q = (document.getElementById('alertEditorUserSearch')?.value || '').trim().toLowerCase();
    const container = document.getElementById('alertEditorUsersList');
    if (!container) return;
    let visibleCount = 0;
    container.querySelectorAll('.channel-pill').forEach(pill => {
        const text = (pill.textContent || '').trim().toLowerCase();
        const match = !q || text.includes(q);
        pill.style.display = match ? '' : 'none';
        if (match) visibleCount++;
    });
    let noMatch = document.getElementById('alertEditorNoUsers');
    if (visibleCount === 0 && q) {
        if (!noMatch) {
            noMatch = document.createElement('div');
            noMatch.id = 'alertEditorNoUsers';
            noMatch.style.cssText = 'color:var(--text-muted);font-size:0.8rem;padding:0.3rem 0;';
            noMatch.textContent = 'No matching users';
            container.appendChild(noMatch);
        }
        noMatch.style.display = '';
    } else if (noMatch) {
        noMatch.style.display = 'none';
    }
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

    const sendPushCb = document.getElementById('editor-send-push');
    if (sendPushCb) {
        row.send_push = sendPushCb.checked;
    }

    const isEmailAvailable = isEmailNotificationAvailable();
    const sendEmailCb = document.getElementById('editor-send-email');
    if (sendEmailCb && isEmailAvailable) {
        row.send_email = sendEmailCb.checked;
    } else {
        row.send_email = false;
    }

    const isVoipAvailable = isVoipNotificationAvailable();
    const sendVoipCb = document.getElementById('editor-send-voip');
    if (sendVoipCb && isVoipAvailable) {
        row.send_voip = sendVoipCb.checked;
    } else {
        row.send_voip = false;
    }

    const actionCmdSel = document.getElementById('editor-action-command');
    if (actionCmdSel) {
        const val = actionCmdSel.value;
        row.action_command = (val && val !== 'disabled') ? val : null;

        const payloadInp = document.getElementById('editor-action-command-payload');
        const paramFields = document.querySelectorAll('.editor-cmd-param-field');
        if (paramFields.length > 0) {
            const paramsObj = {};
            paramFields.forEach(inp => {
                if (inp.dataset.key) paramsObj[inp.dataset.key] = inp.value;
            });
            row.action_command_payload = JSON.stringify(paramsObj);
        } else if (payloadInp) {
            row.action_command_payload = payloadInp.value.trim() || null;
        } else {
            row.action_command_payload = null;
        }
    }

    row.channels = [];
    document.querySelectorAll('.editor-channel-cb:checked').forEach(cb => row.channels.push(cb.value));
    const hiddenChEl = document.getElementById('alertEditorHiddenChannels');
    const preservedCh = hiddenChEl ? JSON.parse(hiddenChEl.value || '[]') : [];
    row.channels = [...new Set([...row.channels, ...preservedCh])];

    const notifyUserCbs = document.querySelectorAll('.editor-notify-user-cb');
    if (notifyUserCbs.length > 0) {
        const selected = [];
        notifyUserCbs.forEach(cb => { if (cb.checked) selected.push(parseInt(cb.value, 10)); });
        const hiddenEl = document.getElementById('alertEditorHiddenNotifyIds');
        const preserved = hiddenEl ? JSON.parse(hiddenEl.value || '[]') : [];
        if (selected.length === notifyUserCbs.length && preserved.length === 0) {
            row.notify_user_ids = null;
        } else {
            row.notify_user_ids = [...new Set([...selected, ...preserved])];
        }
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
    const isEmailAvailable = isEmailNotificationAvailable();
    const isVoipAvailable = isVoipNotificationAvailable();
    alertRows.forEach(row => {
        const rowCopy = { ...row };
        if (!isEmailAvailable) {
            rowCopy.send_email = false;
        }
        if (!isVoipAvailable) {
            rowCopy.send_voip = false;
        }
        config.alert_rows.push(rowCopy);
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

async function loadAllUsers(force = false) {
    if (!force && allUsersLoaded) return allUsers;
    if (allUsersLoadPromise) return allUsersLoadPromise;

    allUsersLoadPromise = (async () => {
        try {
            const res = await apiFetch(`${API_BASE}/users`);
            if (res.ok) {
                const fetched = await res.json();
                allUsers = Array.isArray(fetched) ? fetched : [];
                allUsersLoaded = true;
                allUsersLoadFailed = false;
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
    if (isCompanyAdmin || allUsersLoaded || notifyUserLoadFailedIds.has(id)) {
        notifyUserLoadFailedIds.add(id);
        return null;
    }
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



async function loadAllCompanies() {
    if (!isAdmin) return;
    try {
        const res = await apiFetch(`${API_BASE}/companies`);
        if (res.ok) {
            allCompanies = await res.json();
            populateDeviceCompanySelect();
            if (allCompanies.length > 0) {
                document.querySelector('.devices-table')?.classList.add('show-company-col');
            }
            if (typeof filterDevices === 'function') {
                filterDevices();
            } else if (typeof renderDeviceTable === 'function') {
                renderDeviceTable(devices);
            }
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
    populateDeviceSimCardSelect(null, editingDeviceId, companyId);
}

function populateDeviceCompanySelect(selectedId) {
    const sel = document.getElementById('deviceCompany');
    if (!sel) return;
    sel.innerHTML = '<option value="">— None —</option>' +
        allCompanies.map(c => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${_esc(c.name)}</option>`).join('');
}

async function loadSimCards() {
    try {
        const res = await apiFetch(`${API_BASE}/sim-cards`);
        if (res.ok) {
            allSimCards = await res.json();
        }
    } catch (e) {
        allSimCards = [];
    }
}

function populateDeviceSimCardSelect(selectedSimId = null, currentDeviceId = null, companyId = null) {
    const sel = document.getElementById('deviceSimCard');
    if (!sel) return;

    // Filter SIM cards:
    // 1. Must match target company (if specified)
    // 2. Either unassigned (device_id == null) OR assigned to this current device
    const targetComp = companyId != null ? parseInt(companyId, 10) : null;
    const available = allSimCards.filter(s => {
        if (targetComp && s.company_id && s.company_id !== targetComp) return false;
        if (!s.device_id) return true;
        if (currentDeviceId && s.device_id === currentDeviceId) return true;
        if (selectedSimId && s.id === selectedSimId) return true;
        return false;
    });

    sel.innerHTML = '<option value="">— None (No SIM assigned) —</option>' +
        available.map(s => {
            const isSel = (selectedSimId && s.id === selectedSimId) || (currentDeviceId && s.device_id === currentDeviceId);
            const label = `${_esc(s.phone_number)} (${_esc(s.provider_id)}${s.plan_name ? ' - ' + _esc(s.plan_name) : ''})`;
            return `<option value="${s.id}"${isSel ? ' selected' : ''}>${label}</option>`;
        }).join('');
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
    const deviceObj = editingDeviceId ? devices.find(d => _sameId(d.id, editingDeviceId)) : null;
    const devCompanyId = deviceObj?.company_id || (parseInt(document.getElementById('deviceCompany')?.value) || null);
    const targetCompanyId = isCompanyAdmin
        ? (parseInt(localStorage.getItem('company_id')) || devCompanyId)
        : devCompanyId;

    const filtered = allUsers.filter(u =>
        (!targetCompanyId || _sameId(u.company_id, targetCompanyId) || u.is_admin) &&
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
    tbody.innerHTML    = '<tr><td colspan="11" style="text-align:center;padding:2rem;">Loading…</td></tr>';

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
        tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--accent-danger);">Failed to load: ${e.message}</td></tr>`;
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
        tbody.innerHTML = RoutarioTables.stateRow('No data available.', 11);
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

        const gpsTime    = formatDateToLocalSplit(p.time);
        const serverTime = p.server_time ? formatDateToLocalSplit(p.server_time) : '—';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="white-space:nowrap;">${gpsTime}</td>
            <td style="white-space:nowrap;">${serverTime}</td>
            <td>${coords[1].toFixed(5)}</td>
            <td>${coords[0].toFixed(5)}</td>
            <td>${p.speed != null ? fmtSpeed(p.speed) : '—'}</td>
            <td>${p.course != null ? p.course.toFixed(0) + '°' : '—'}</td>
            <td>${p.satellites != null ? p.satellites : '—'}</td>
            <td>${fmtAlt(p.altitude || 0)}</td>
            <td>${p.ignition === true ? '<span style="color:var(--accent-success);font-weight:600;">ON</span>' : p.ignition === false ? '<span style="color:var(--accent-danger);font-weight:600;">OFF</span>' : '<span style="color:var(--text-muted);">—</span>'}</td>
            <td>${p.driver_name ? _esc(p.driver_name) : '—'}</td>
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
