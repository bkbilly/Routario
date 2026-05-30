'use strict';

const _drvIsAdmin = localStorage.getItem('is_admin') === 'true';

let _drivers       = [];
let _devices       = [];
let _companies     = [];
let _editingDriver = null;
let _assignDriver  = null;
let _drvSortCol    = 'name';
let _drvSortDir    = 1;

let _drvSectionInitialized = false;

async function initDriversSection() {
    if (_drvSectionInitialized) return;
    _drvSectionInitialized = true;
    if (!hasPermission('manage_drivers')) return;
    await _loadDevices();
    if (_drvIsAdmin) {
        await _loadCompanies();
        const hdr = document.getElementById('driverCompanyHeader');
        if (hdr) hdr.style.display = '';
    }
    await _loadDrivers();
}

async function _loadCompanies() {
    try {
        const res = await apiFetch(`${API_BASE}/companies`);
        if (res.ok) _companies = await res.json();
    } catch (e) { console.error(e); }
}

async function _loadDrivers() {
    try {
        const res = await apiFetch(`${API_BASE}/drivers`);
        if (res.ok) _drivers = await res.json();
    } catch (e) { console.error(e); }
    _render();
}

async function _loadDevices() {
    try {
        const res = await apiFetch(`${API_BASE}/devices`);
        if (res.ok) _devices = await res.json();
    } catch (e) { console.error(e); }
}

function _currentDriverIdForDevice(deviceId) {
    const d = _devices.find(d => d.id === deviceId);
    return d?.state?.current_driver_id ?? null;
}

function _assignedDevice(driverId) {
    return _devices.find(d => d.state?.current_driver_id === driverId) ?? null;
}

function _render() {
    const query = (document.getElementById('driverSearch')?.value ?? '').toLowerCase();
    const list = [..._drivers.filter(d =>
        d.name.toLowerCase().includes(query) ||
        (d.phone || '').toLowerCase().includes(query) ||
        (d.license_number || '').toLowerCase().includes(query)
    )].sort((a, b) => {
        let av, bv;
        switch (_drvSortCol) {
            case 'phone':   av = a.phone || ''; bv = b.phone || ''; break;
            case 'licence': av = a.license_number || ''; bv = b.license_number || ''; break;
            case 'company': av = _companies.find(c => c.id === a.company_id)?.name || ''; bv = _companies.find(c => c.id === b.company_id)?.name || ''; break;
            case 'vehicle': av = (_assignedDevice(a.id)?.name || ''); bv = (_assignedDevice(b.id)?.name || ''); break;
            default:        av = a.name || ''; bv = b.name || '';
        }
        return av.toLowerCase() < bv.toLowerCase() ? -_drvSortDir : av.toLowerCase() > bv.toLowerCase() ? _drvSortDir : 0;
    });

    document.getElementById('driverCount').textContent = `${list.length} driver${list.length !== 1 ? 's' : ''}`;

    const tbody = document.getElementById('driversTableBody');
    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:3rem;color:var(--text-muted);">
            <div style="font-size:2.5rem;margin-bottom:0.75rem;">&#128100;</div>No drivers found</td></tr>`;
        return;
    }

    tbody.innerHTML = list.map(d => {
        const assigned = _assignedDevice(d.id);
        const company  = _drvIsAdmin ? (_companies.find(c => c.id === d.company_id)?.name || '—') : null;
        const assignedEmoji = assigned ? (VEHICLE_ICONS[assigned.vehicle_type] || VEHICLE_ICONS['other']).emoji : '';
        const isUser = !!d.user_id;
        const nameBadge = isUser
            ? `<span style="font-size:0.68rem;font-weight:600;padding:0.1rem 0.4rem;border-radius:4px;background:rgba(99,102,241,0.15);color:#818cf8;margin-left:0.4rem;">USER</span>`
            : '';
        return `
        <tr class="device-row" ondblclick="openDriverModal(${d.id})" style="cursor:pointer;">
            <td><span class="device-row-name">${_esc(d.name)}</span>${nameBadge}</td>
            <td style="color:var(--text-secondary);">${_esc(d.phone || '—')}</td>
            <td style="font-family:var(--font-mono);font-size:0.85rem;">${_esc(d.license_number || '—')}</td>
            ${_drvIsAdmin ? `<td style="color:var(--text-secondary);font-size:0.85rem;">${_esc(company)}</td>` : '<td style="display:none;"></td>'}
            <td>${assigned ? `<span style="font-size:0.85rem;">${assignedEmoji} ${_esc(assigned.name)}</span>` : '<span style="color:var(--text-muted);">—</span>'}</td>
            <td style="text-align:right;white-space:nowrap;">
                <button class="btn btn-secondary tbl-btn" onclick="openAssignModal(${d.id})"><i class="mdi mdi-car-key"></i> <span class="drv-btn-label">Assign</span></button>
                <button class="btn btn-secondary tbl-btn" onclick="openDriverModal(${d.id})"><i class="mdi mdi-pencil"></i> <span class="drv-btn-label">Edit</span></button>
            </td>
        </tr>`;
    }).join('');
}

function filterDrivers() { _render(); }

function sortDrivers(col) {
    if (_drvSortCol === col) _drvSortDir = -_drvSortDir;
    else { _drvSortCol = col; _drvSortDir = 1; }
    document.querySelectorAll('#section-drivers .devices-table th[data-sort]').forEach(th => {
        th.dataset.sortDir = th.dataset.sort === col ? (_drvSortDir === 1 ? 'asc' : 'desc') : '';
    });
    _render();
}

// ── Driver Modal ──────────────────────────────────────────────────

function _buildVehicleList(selectedVehicleIds) {
    const list = document.getElementById('driverVehiclesList');
    if (!list) return;
    list.innerHTML = '';

    // Filter devices by the editing driver's company when admin, or all devices for company admin
    let visibleDevices = _devices;
    if (_drvIsAdmin && _editingDriver?.company_id) {
        visibleDevices = _devices.filter(d => d.company_id === _editingDriver.company_id);
    } else if (_drvIsAdmin && !_editingDriver) {
        // new driver — show all devices; company filter applied after company is selected
        visibleDevices = _devices;
    }

    visibleDevices.forEach(d => {
        const emoji = (VEHICLE_ICONS[d.vehicle_type] || VEHICLE_ICONS['other']).emoji;
        const label = document.createElement('label');
        label.style.cssText = 'display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer;padding:0.2rem 0;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = d.id;
        cb.dataset.vehicleId = d.id;
        cb.style.cursor = 'pointer';
        cb.className = 'drv-vehicle-cb';
        if (selectedVehicleIds && selectedVehicleIds.includes(d.id)) cb.checked = true;
        const span = document.createElement('span');
        span.style.color = 'var(--text-secondary)';
        span.textContent = `${emoji} ${d.name}` + (d.license_plate ? ` (${d.license_plate})` : '');
        label.appendChild(cb);
        label.appendChild(span);
        list.appendChild(label);
    });
}

function _updateClearOptions(mode) {
    const sel = document.getElementById('driverAssignClear');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = `
        <option value="never">Never</option>
        <option value="ignition_off">On ignition off</option>
        <option value="trip_end">On trip end</option>
        ${mode === 'continuous' ? '<option value="rule_stops">When rule stops matching</option>' : ''}
    `;
    // Restore previous selection if still valid
    if ([...sel.options].some(o => o.value === current)) sel.value = current;
    _updateGraceVisibility();
}

function _updateGraceVisibility() {
    const mode  = document.getElementById('driverAssignMode')?.value;
    const clear = document.getElementById('driverAssignClear')?.value;
    const grp   = document.getElementById('driverGraceGroup');
    if (grp) grp.style.display = (mode === 'continuous' && clear === 'rule_stops') ? '' : 'none';
}

function onDriverModeChange() {
    const mode = document.getElementById('driverAssignMode')?.value;
    _updateClearOptions(mode);
}

function onDriverClearChange() {
    _updateGraceVisibility();
}

function onDriverVehiclesAllChange() {
    const allCb = document.getElementById('driverVehiclesAll');
    const cbs   = document.querySelectorAll('#driverVehiclesList .drv-vehicle-cb');
    cbs.forEach(cb => {
        cb.disabled = allCb.checked;
        if (allCb.checked) cb.checked = false;
    });
}

function openDriverModal(driverId = null) {
    _editingDriver = driverId ? _drivers.find(d => d.id === driverId) : null;
    const isNew    = !_editingDriver;
    const isUser   = !!_editingDriver?.user_id;

    document.getElementById('driverModalTitle').textContent = isNew ? 'Add Driver' : 'Edit Driver';
    document.getElementById('driverName').value    = _editingDriver?.name    || '';
    document.getElementById('driverPhone').value   = _editingDriver?.phone   || '';
    document.getElementById('driverLicence').value = _editingDriver?.license_number || '';
    document.getElementById('driverNotes').value   = _editingDriver?.notes   || '';

    // User-linked drivers: name and licence are read-only, no delete
    document.getElementById('driverName').disabled = isUser;
    document.getElementById('deleteDriverBtn').style.display = (isNew || isUser) ? 'none' : 'inline-flex';

    const userNote = document.getElementById('driverUserNote');
    if (userNote) userNote.style.display = isUser ? '' : 'none';

    const companyGroup = document.getElementById('driverCompanyGroup');
    if (_drvIsAdmin && companyGroup) {
        companyGroup.style.display = isUser ? 'none' : '';
        if (!isUser) {
            const sel = document.getElementById('driverCompanySelect');
            sel.innerHTML = '<option value="">— No company —</option>';
            _companies.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id;
                opt.textContent = c.name;
                if (c.id === _editingDriver?.company_id) opt.selected = true;
                sel.appendChild(opt);
            });
        }
    }

    // ── Auto-assignment fields ────────────────────────────────────
    const rule  = _editingDriver?.assignment_rule  || '';
    const mode  = _editingDriver?.assignment_mode  || '';
    const clear = _editingDriver?.assignment_clear || 'never';
    const grace = _editingDriver?.assignment_grace_period ?? '';
    const vehicles = _editingDriver?.assignment_vehicles || null; // null = all

    document.getElementById('driverAssignRule').value  = rule;
    document.getElementById('driverAssignMode').value  = mode;
    document.getElementById('driverAssignGrace').value = grace;

    // Build vehicle list
    _buildVehicleList(vehicles);

    // Set "All" checkbox: checked when vehicles is null/empty
    const allCb = document.getElementById('driverVehiclesAll');
    const hasSpecific = vehicles && vehicles.length > 0;
    allCb.checked = !hasSpecific;
    // Disable individual checkboxes if "All" is checked
    document.querySelectorAll('#driverVehiclesList .drv-vehicle-cb').forEach(cb => {
        cb.disabled = allCb.checked;
    });

    // Populate clear options for the current mode then set value
    _updateClearOptions(mode);
    document.getElementById('driverAssignClear').value = clear;
    _updateGraceVisibility();

    document.getElementById('driverModal').classList.add('active');
}

function closeDriverModal() {
    document.getElementById('driverModal').classList.remove('active');
    document.getElementById('driverName').disabled = false;
    _editingDriver = null;
}

async function saveDriver() {
    const name = document.getElementById('driverName').value.trim();
    if (!name) { document.getElementById('driverName').focus(); return; }

    // Collect assignment vehicles
    const allCb   = document.getElementById('driverVehiclesAll');
    let assignVehicles = null;
    if (!allCb.checked) {
        const checked = [...document.querySelectorAll('#driverVehiclesList .drv-vehicle-cb:checked')];
        assignVehicles = checked.length > 0 ? checked.map(cb => parseInt(cb.value)) : null;
    }

    const assignMode  = document.getElementById('driverAssignMode').value || null;
    const assignClear = document.getElementById('driverAssignClear').value || null;
    const assignRule  = document.getElementById('driverAssignRule').value.trim() || null;
    const graceRaw    = document.getElementById('driverAssignGrace').value;
    const assignGrace = graceRaw !== '' ? parseInt(graceRaw) : null;

    const payload = {
        name,
        phone:                 document.getElementById('driverPhone').value.trim() || null,
        license_number:        document.getElementById('driverLicence').value.trim() || null,
        notes:                 document.getElementById('driverNotes').value.trim() || null,
        assignment_rule:       assignRule,
        assignment_vehicles:   assignVehicles,
        assignment_mode:       assignMode,
        assignment_grace_period: assignGrace,
        assignment_clear:      assignClear,
    };
    if (_drvIsAdmin) {
        const cid = parseInt(document.getElementById('driverCompanySelect')?.value);
        payload.company_id = cid || null;
    }

    try {
        let res;
        if (_editingDriver) {
            res = await apiFetch(`${API_BASE}/drivers/${_editingDriver.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        } else {
            res = await apiFetch(`${API_BASE}/drivers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        }
        if (!res.ok) throw new Error((await res.json()).detail || 'Save failed');
        closeDriverModal();
        await _loadDrivers();
    } catch (e) { showAlert(e.message || 'Save failed', 'error'); }
}

async function deleteDriver() {
    if (!_editingDriver) return;
    if (!confirm(`Delete driver "${_editingDriver.name}"?`)) return;
    try {
        const res = await apiFetch(`${API_BASE}/drivers/${_editingDriver.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Delete failed');
        closeDriverModal();
        await _loadDrivers();
    } catch (e) { showAlert(e.message || 'Delete failed', 'error'); }
}

// ── Assign Modal ──────────────────────────────────────────────────

function openAssignModal(driverId) {
    _assignDriver = _drivers.find(d => d.id === driverId);
    if (!_assignDriver) return;

    document.getElementById('assignDriverName').textContent = _assignDriver.name;

    const sel = document.getElementById('assignDeviceSelect');
    const currentDevice = _assignedDevice(driverId);
    const visibleDevices = (_drvIsAdmin && _assignDriver.company_id)
        ? _devices.filter(d => d.company_id === _assignDriver.company_id)
        : _devices;
    sel.innerHTML = '<option value="">— Unassign —</option>';
    visibleDevices.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id;
        const emoji = (VEHICLE_ICONS[d.vehicle_type] || VEHICLE_ICONS['other']).emoji;
        opt.textContent = `${emoji} ${d.name}` + (d.license_plate ? ` (${d.license_plate})` : '');
        if (currentDevice?.id === d.id) opt.selected = true;
        sel.appendChild(opt);
    });

    document.getElementById('assignModal').classList.add('active');
}

function closeAssignModal() {
    document.getElementById('assignModal').classList.remove('active');
    _assignDriver = null;
}

async function confirmAssign() {
    if (!_assignDriver) return;
    const deviceId = parseInt(document.getElementById('assignDeviceSelect').value) || null;
    try {
        const prev = _assignedDevice(_assignDriver.id);
        if (prev && prev.id !== deviceId) {
            await apiFetch(`${API_BASE}/drivers/assign?device_id=${prev.id}`, { method: 'POST' });
        }
        if (deviceId) {
            await apiFetch(`${API_BASE}/drivers/assign?device_id=${deviceId}&driver_id=${_assignDriver.id}`, { method: 'POST' });
        } else if (!prev) {
            // Explicit unassign when no previous assignment either (no-op but still reload)
        }
        closeAssignModal();
        await _loadDevices();
        await _loadDrivers();
    } catch (e) { showAlert('Assignment failed.', 'error'); }
}

function _esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
