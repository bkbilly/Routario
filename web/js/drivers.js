'use strict';

const _drvIsAdmin = localStorage.getItem('is_admin') === 'true';

let _drivers       = [];
let _devices       = [];
let _companies     = [];
let _editingDriver = null;
let _drvSortCol    = 'name';
let _drvSortDir    = 1;

let _drvSectionInitialized = false;

async function initDriversSection() {
    if (_drvSectionInitialized) {
        if (hasPermission('manage_drivers')) _loadDrivers();
        return;
    }
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

window.addEventListener('routario:users-updated', () => {
    if (_drvSectionInitialized && hasPermission('manage_drivers')) {
        _loadDrivers();
    }
});

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
        d.name.toLowerCase().includes(query)
    )].sort((a, b) => {
        let av, bv;
        switch (_drvSortCol) {
            case 'company': av = _companies.find(c => c.id === d.company_id)?.name || ''; bv = _companies.find(c => c.id === b.company_id)?.name || ''; break;
            case 'vehicle': av = (_assignedDevice(a.id)?.name || ''); bv = (_assignedDevice(b.id)?.name || ''); break;
            default:        av = a.name || ''; bv = b.name || '';
        }
        return av.toLowerCase() < bv.toLowerCase() ? -_drvSortDir : av.toLowerCase() > bv.toLowerCase() ? _drvSortDir : 0;
    });

    document.getElementById('driverCount').textContent = `${list.length} driver${list.length !== 1 ? 's' : ''}`;

    const tbody = document.getElementById('driversTableBody');
    if (list.length === 0) {
        tbody.innerHTML = RoutarioTables.stateRow('<div style="font-size:2.5rem;margin-bottom:0.75rem;">&#128100;</div>No drivers found', _drvIsAdmin ? 4 : 3, { padding: '3rem' });
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
            ${_drvIsAdmin ? `<td style="color:var(--text-secondary);font-size:0.85rem;">${_esc(company)}</td>` : '<td style="display:none;"></td>'}
            <td>${assigned ? `<span style="font-size:0.85rem;">${assignedEmoji} ${_esc(assigned.name)}</span>` : '<span style="color:var(--text-muted);">—</span>'}</td>
            <td style="text-align:right;white-space:nowrap;">
                <button class="btn btn-secondary tbl-btn" onclick="openDriverAssignModal(${d.id})" title="Assign vehicle"><i class="mdi mdi-car"></i> <span class="drv-btn-label">Assign</span></button>
                <button class="btn btn-secondary tbl-btn" onclick="openDriverModal(${d.id})" title="Edit driver"><i class="mdi mdi-pencil"></i> <span class="drv-btn-label">Edit</span></button>
            </td>
        </tr>`;
    }).join('');
}

function filterDrivers() { _render(); }

function sortDrivers(col) {
    ({ col: _drvSortCol, dir: _drvSortDir } = RoutarioTables.toggleNumericSort(_drvSortCol, _drvSortDir, col));
    RoutarioTables.updateSortHeaders('#section-drivers, body > .container', {
        col,
        dir: _drvSortDir === 1 ? 'asc' : 'desc',
    });
    _render();
}

// ── Auto-Assignment Mode & Clear Descriptions ────────────────────
const DRIVER_MODE_DESCRIPTIONS = {
    '': 'Auto-assignment is disabled. Drivers must be assigned to vehicles manually.',
    'one_time': 'Assigns the driver immediately when the rule matches. The assignment stays active until cleared by the condition below.',
    'continuous': 'The driver remains assigned only while the rule condition is actively met (e.g., Bluetooth beacon in range). Automatically unassigns if the rule stops matching.'
};

const DRIVER_CLEAR_DESCRIPTIONS = {
    'never': 'The assignment is never automatically cleared. It remains active until manually changed or overwritten.',
    'ignition_off': 'Automatically clears the driver assignment as soon as the vehicle ignition is turned off.',
    'trip_end': 'Automatically clears the driver assignment when the vehicle completes and finalizes its trip.',
    'rule_stops': 'Automatically clears the driver assignment when the continuous rule condition ceases to match (after the grace period).'
};

function _updateDriverModeDescription() {
    const mode = document.getElementById('driverAssignMode')?.value ?? '';
    const descEl = document.getElementById('driverModeHelp');
    if (descEl) {
        descEl.textContent = DRIVER_MODE_DESCRIPTIONS[mode] || '';
    }
}

function _updateDriverClearDescription() {
    const clear = document.getElementById('driverAssignClear')?.value ?? '';
    const descEl = document.getElementById('driverClearHelp');
    if (descEl) {
        descEl.textContent = DRIVER_CLEAR_DESCRIPTIONS[clear] || '';
    }
}

// ── Company Change Handler (Auto-filter vehicles) ────────────────
function onDriverCompanyChange() {
    const sel = document.getElementById('driverCompanySelect');
    const compId = sel?.value ? parseInt(sel.value, 10) : null;
    const checkedIds = [...document.querySelectorAll('#driverVehiclesList .drv-vehicle-cb:checked')]
        .map(cb => parseInt(cb.value, 10));
    _buildVehicleList(checkedIds, compId);
}

// ── Vehicle List Builder ──────────────────────────────────────────
function _buildVehicleList(selectedVehicleIds, companyIdOverride = undefined) {
    const list = document.getElementById('driverVehiclesList');
    if (!list) return;
    list.innerHTML = '';

    let targetCompanyId = undefined;
    if (companyIdOverride !== undefined) {
        targetCompanyId = companyIdOverride;
    } else if (_drvIsAdmin) {
        const compVal = document.getElementById('driverCompanySelect')?.value;
        if (compVal) {
            targetCompanyId = parseInt(compVal, 10);
        } else if (_editingDriver && _editingDriver.company_id !== undefined) {
            targetCompanyId = _editingDriver.company_id;
        } else {
            targetCompanyId = null;
        }
    }

    let visibleDevices = _devices;
    if (_drvIsAdmin) {
        if (targetCompanyId) {
            visibleDevices = _devices.filter(d => d.company_id === targetCompanyId);
        } else if (targetCompanyId === null && document.getElementById('driverCompanySelect')?.value === "") {
            visibleDevices = _devices.filter(d => !d.company_id);
        }
    }

    if (visibleDevices.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.style.cssText = 'color:var(--text-muted);font-size:0.8rem;padding:0.4rem 0;font-style:italic;';
        emptyDiv.textContent = 'No vehicles available for this company';
        list.appendChild(emptyDiv);
        return;
    }

    const allCb = document.getElementById('driverVehiclesAll');
    const isAllChecked = allCb ? allCb.checked : false;

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
        if (isAllChecked) {
            cb.disabled = true;
        } else if (selectedVehicleIds && selectedVehicleIds.includes(d.id)) {
            cb.checked = true;
        }
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
    if (mode === 'continuous') {
        sel.innerHTML = '<option value="rule_stops">When rule stops matching</option>';
        sel.value = 'rule_stops';
        sel.disabled = true;
        _updateGraceVisibility();
        _updateDriverClearDescription();
        return;
    }

    sel.disabled = false;
    sel.innerHTML = `
        <option value="never">Never</option>
        <option value="ignition_off">On ignition off</option>
        <option value="trip_end">On trip end</option>
    `;
    // Restore previous selection if still valid
    if ([...sel.options].some(o => o.value === current)) {
        sel.value = current;
    } else {
        sel.value = 'never';
    }
    _updateGraceVisibility();
    _updateDriverClearDescription();
}

function _updateGraceVisibility() {
    const mode  = document.getElementById('driverAssignMode')?.value;
    const grp   = document.getElementById('driverGraceGroup');
    if (grp) grp.style.display = mode === 'continuous' ? '' : 'none';
}

function onDriverModeChange() {
    const mode = document.getElementById('driverAssignMode')?.value;
    _updateClearOptions(mode);
    _updateDriverModeDescription();
}

function onDriverClearChange() {
    _updateGraceVisibility();
    _updateDriverClearDescription();
}

function onDriverVehiclesAllChange() {
    const allCb = document.getElementById('driverVehiclesAll');
    const cbs   = document.querySelectorAll('#driverVehiclesList .drv-vehicle-cb');
    cbs.forEach(cb => {
        cb.disabled = allCb.checked;
        if (allCb.checked) cb.checked = false;
    });
}

function _adjustDriverRuleHeight() {
    const el = document.getElementById('driverAssignRule');
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) {
        el.style.height = Math.max(el.scrollHeight, 54) + 'px';
    }
}

// ── Driver Modal ──────────────────────────────────────────────────
function openDriverModal(driverId = null) {
    _editingDriver = driverId ? _drivers.find(d => d.id === driverId) : null;
    const isNew    = !_editingDriver;
    const isUser   = !!_editingDriver?.user_id;

    document.getElementById('driverModalTitle').textContent = isNew ? 'Add Driver' : 'Edit Driver';
    document.getElementById('driverName').value  = _editingDriver?.name  || '';
    document.getElementById('driverNotes').value = _editingDriver?.notes || '';

    // User-linked drivers: name is read-only, no delete
    document.getElementById('driverName').disabled = isUser;
    document.getElementById('deleteDriverBtn').style.display = (isNew || isUser) ? 'none' : 'inline-flex';

    const userNote = document.getElementById('driverUserNote');
    if (userNote) userNote.style.display = isUser ? '' : 'none';

    let initialCompanyId = _editingDriver?.company_id ?? null;
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
            initialCompanyId = sel.value ? parseInt(sel.value, 10) : null;
        }
    }

    // ── Auto-assignment fields ────────────────────────────────────
    const rule  = _editingDriver?.assignment_rule  || '';
    const mode  = _editingDriver?.assignment_mode  || '';
    const clear = mode === 'continuous' ? 'rule_stops' : (_editingDriver?.assignment_clear || 'never');
    const grace = _editingDriver?.assignment_grace_period ?? '';
    const vehicles = _editingDriver?.assignment_vehicles || null; // null = all

    const ruleEl = document.getElementById('driverAssignRule');
    if (ruleEl) {
        ruleEl.value = rule;
        ruleEl.style.height = 'auto';
    }
    document.getElementById('driverAssignMode').value  = mode;
    document.getElementById('driverAssignGrace').value = grace;

    // Build vehicle list filtered by the driver's company
    _buildVehicleList(vehicles, initialCompanyId);

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

    // Set descriptions for Mode and Clear When
    _updateDriverModeDescription();
    _updateDriverClearDescription();

    document.getElementById('driverModal').classList.add('active');

    // Recalculate height after modal is active and laid out in the DOM
    _adjustDriverRuleHeight();
    requestAnimationFrame(_adjustDriverRuleHeight);
    setTimeout(_adjustDriverRuleHeight, 50);
}

function closeDriverModal() {
    document.getElementById('driverModal').classList.remove('active');
    document.getElementById('driverName').disabled = false;
    const ruleEl = document.getElementById('driverAssignRule');
    if (ruleEl) {
        ruleEl.value = '';
        ruleEl.style.height = 'auto';
    }
    _editingDriver = null;
}

async function saveDriver() {
    const name = document.getElementById('driverName').value.trim();
    if (!name) { document.getElementById('driverName').focus(); return; }
    const isEdit = !!_editingDriver;

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
        notes:                   document.getElementById('driverNotes').value.trim() || null,
        assignment_rule:         assignRule,
        assignment_vehicles:     assignVehicles,
        assignment_mode:         assignMode,
        assignment_grace_period: assignGrace,
        assignment_clear:        assignClear,
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
        showAlert(isEdit ? 'Driver updated' : 'Driver added', 'success');
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

// ── Separate Vehicle Assignment Modal ────────────────────────────
let _assigningDriverId = null;

function openDriverAssignModal(driverId) {
    const driver = _drivers.find(d => d.id === driverId);
    if (!driver) return;
    _assigningDriverId = driverId;

    const nameEl = document.getElementById('assignModalDriverName');
    if (nameEl) nameEl.textContent = driver.name;

    const compEl = document.getElementById('assignModalCompanyName');
    if (compEl) {
        if (_drvIsAdmin) {
            const comp = _companies.find(c => c.id === driver.company_id);
            compEl.textContent = comp ? `Company: ${comp.name}` : 'No company';
            compEl.style.display = '';
        } else {
            compEl.style.display = 'none';
        }
    }

    // Filter vehicles by the driver's company
    const vehicleSel = document.getElementById('driverAssignVehicleSelect');
    if (vehicleSel) {
        vehicleSel.innerHTML = '<option value="">— Unassigned —</option>';

        let visibleDevices = _devices;
        if (_drvIsAdmin && driver.company_id) {
            visibleDevices = _devices.filter(d => d.company_id === driver.company_id);
        } else if (_drvIsAdmin && !driver.company_id) {
            visibleDevices = _devices.filter(d => !d.company_id);
        }

        const currentlyAssigned = _assignedDevice(driverId);

        visibleDevices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.id;
            const emoji = (VEHICLE_ICONS[d.vehicle_type] || VEHICLE_ICONS['other']).emoji;
            const otherDriverId = d.state?.current_driver_id;
            let extra = '';
            if (otherDriverId && otherDriverId !== driverId) {
                const otherDriver = _drivers.find(dr => dr.id === otherDriverId);
                extra = otherDriver ? ` (Currently with ${otherDriver.name})` : ' (Assigned)';
            }
            opt.textContent = `${emoji} ${d.name}` + (d.license_plate ? ` (${d.license_plate})` : '') + extra;
            if (currentlyAssigned?.id === d.id) opt.selected = true;
            vehicleSel.appendChild(opt);
        });
    }

    document.getElementById('driverAssignModal')?.classList.add('active');
}

function closeDriverAssignModal() {
    document.getElementById('driverAssignModal')?.classList.remove('active');
    _assigningDriverId = null;
}

async function saveDriverAssignment() {
    if (!_assigningDriverId) return;
    const driverId = _assigningDriverId;
    const driver = _drivers.find(d => d.id === driverId);
    const newDeviceId = parseInt(document.getElementById('driverAssignVehicleSelect')?.value) || null;
    const prevDevice = _assignedDevice(driverId);
    const prevDeviceId = prevDevice?.id || null;

    if (newDeviceId === prevDeviceId) {
        closeDriverAssignModal();
        return;
    }

    try {
        if (prevDeviceId) {
            await apiFetch(`${API_BASE}/drivers/assign?device_id=${prevDeviceId}`, { method: 'POST' });
        }
        if (newDeviceId) {
            await apiFetch(`${API_BASE}/drivers/assign?device_id=${newDeviceId}&driver_id=${driverId}`, { method: 'POST' });
        }

        // Notify GPS dashboard tabs in the same browser immediately
        try {
            const bc = new BroadcastChannel('routario_driver_updates');
            if (prevDeviceId) {
                bc.postMessage({ device_id: prevDeviceId, current_driver_id: null, current_driver_name: null });
            }
            if (newDeviceId) {
                bc.postMessage({ device_id: newDeviceId, current_driver_id: driverId, current_driver_name: driver?.name });
            }
            bc.close();
        } catch (_) {}

        closeDriverAssignModal();
        await _loadDevices();
        _render();
        showAlert(newDeviceId ? 'Vehicle assigned successfully' : 'Vehicle unassigned', 'success');
    } catch (e) {
        showAlert(e.message || 'Assignment failed', 'error');
    }
}

function _esc(s) {
    return RoutarioUI.escapeHtml(s);
}

// Window bindings
window.initDriversSection = initDriversSection;
window.filterDrivers = filterDrivers;
window.sortDrivers = sortDrivers;
window.openDriverModal = openDriverModal;
window.closeDriverModal = closeDriverModal;
window.saveDriver = saveDriver;
window.deleteDriver = deleteDriver;
window.openDriverAssignModal = openDriverAssignModal;
window.closeDriverAssignModal = closeDriverAssignModal;
window.saveDriverAssignment = saveDriverAssignment;
window.onDriverCompanyChange = onDriverCompanyChange;
window.onDriverModeChange = onDriverModeChange;
window.onDriverClearChange = onDriverClearChange;
window.onDriverVehiclesAllChange = onDriverVehiclesAllChange;
window._adjustDriverRuleHeight = _adjustDriverRuleHeight;
