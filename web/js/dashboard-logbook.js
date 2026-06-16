/**
 * dashboard-logbook.js
 * Logbook modal — Entries / Fuel / Maintenance tabs per vehicle.
 */

// ── State ─────────────────────────────────────────────────────────────────────
let _logbookDeviceId  = null;
let _logbookEntries   = [];
let _editingEntryId   = null;

let _fuelLogs         = [];
let _editingFuelLogId = null;

function _lbMoney(amount, digits = 2) {
    return typeof fmtMoney === 'function' ? fmtMoney(amount, userCurrency(), digits) : `€${Number(amount || 0).toFixed(digits)}`;
}

function _lbMoneySnapshot(amount, record, digits = 2) {
    return typeof fmtMoneyAtRate === 'function'
        ? fmtMoneyAtRate(amount, record?.currency || userCurrency(), record?.exchange_rate || 1, digits)
        : _lbMoney(amount, digits);
}

function _lbMoneyInput(amount, digits = 2) {
    return typeof currencyInputValue === 'function' ? currencyInputValue(amount, digits) : (amount ?? '');
}

function _lbMoneyFromInput(id) {
    const value = document.getElementById(id)?.value;
    return typeof currencyInputToBase === 'function' ? currencyInputToBase(value) : (value === '' ? null : Number(value));
}

function _lbApplyCurrencyLabels() {
    const cur = typeof userCurrency === 'function' ? userCurrency() : 'EUR';
    const entryLabel = document.getElementById('lbEntryPriceLabel');
    const fuelLabel = document.getElementById('lbFuelPriceLabel');
    if (entryLabel) entryLabel.textContent = `Price (${cur})`;
    if (fuelLabel) fuelLabel.textContent = `Price per litre (${cur})`;
}

window.addEventListener('routario:currencychange', () => {
    _lbApplyCurrencyLabels();
    if (document.getElementById('logbookModal')?.classList.contains('active')) {
        if (_logbookEntries.length) _renderLogbookTable();
        if (_fuelLogs.length) _renderFuelTable();
    }
    if (document.getElementById('lbEntryModal')?.classList.contains('active')) {
        const entry = _editingEntryId ? _logbookEntries.find(e => e.id === _editingEntryId) : null;
        if (entry?.price != null) document.getElementById('lbEntryPrice').value = _lbMoneyInput(entry.price);
    }
    if (document.getElementById('lbFuelModal')?.classList.contains('active')) {
        const log = _editingFuelLogId ? _fuelLogs.find(l => l.id === _editingFuelLogId) : null;
        if (log?.price_per_liter != null) document.getElementById('lbFuelPrice').value = _lbMoneyInput(log.price_per_liter, 3);
    }
});

document.addEventListener('DOMContentLoaded', () => {
    const tabs = document.querySelector('.lb-tabs-scroll');
    if (!tabs) return;

    tabs.addEventListener('wheel', (event) => {
        if (tabs.scrollWidth <= tabs.clientWidth) return;

        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
            ? event.deltaX
            : event.deltaY;
        if (!delta) return;

        const maxScroll = tabs.scrollWidth - tabs.clientWidth;
        const canScrollLeft = tabs.scrollLeft > 0;
        const canScrollRight = tabs.scrollLeft < maxScroll;
        if ((delta < 0 && !canScrollLeft) || (delta > 0 && !canScrollRight)) return;

        event.preventDefault();
        tabs.scrollLeft += delta;
    }, { passive: false });
});

// ── Open / Close ──────────────────────────────────────────────────────────────
function openLogbookModal(deviceId) {
    _logbookDeviceId = deviceId;
    _editingEntryId  = null;

    const device = devices.find(d => d.id === deviceId);
    const icon   = device ? (VEHICLE_ICONS[device.vehicle_type] || VEHICLE_ICONS['other']).emoji : '🚗';
    const name   = device ? device.name : `Device ${deviceId}`;

    document.getElementById('logbookModalTitle').textContent = `${icon} ${name}`;
    _lbApplyCurrencyLabels();
    closeEntryModal();
    document.getElementById('logbookModal').classList.add('active');

    // Show/hide tabs based on permissions
    const entriesTabBtn = document.getElementById('lbTabEntries');
    const fuelTabBtn    = document.getElementById('lbTabFuel');
    const maintTabBtn   = document.getElementById('lbTabMaintenance');
    if (entriesTabBtn) entriesTabBtn.style.display = hasPermission('manage_logbook')     ? '' : 'none';
    if (fuelTabBtn)    fuelTabBtn.style.display    = hasPermission('manage_fuel')        ? '' : 'none';
    if (maintTabBtn)   maintTabBtn.style.display   = hasPermission('manage_maintenance') ? '' : 'none';

    // Open to the first available tab
    const firstTab = hasPermission('manage_logbook') ? 'entries'
                   : hasPermission('manage_fuel')    ? 'fuel'
                   : 'maintenance';
    switchLbTab(firstTab);
    _lbUpdateMaintenanceTabVisibility(device);
}

function closeLogbookModal() {
    document.getElementById('logbookModal').classList.remove('active');
    _logbookDeviceId = null;
    _editingEntryId  = null;
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchLbTab(tabId, btn) {
    document.querySelectorAll('.lb-tab').forEach(el => el.classList.remove('active'));
    (btn || document.getElementById(`lbTab${tabId.charAt(0).toUpperCase() + tabId.slice(1)}`))?.classList.add('active');

    const entriesTable = document.getElementById('lbEntriesTable');
    const fuelPanel    = document.getElementById('lbPanelFuel');
    const maintPanel   = document.getElementById('lbPanelMaintenance');

    if (entriesTable) entriesTable.style.display = tabId === 'entries' ? '' : 'none';
    if (fuelPanel)    fuelPanel.style.display    = tabId === 'fuel' ? '' : 'none';
    if (maintPanel)   maintPanel.style.display   = tabId === 'maintenance' ? '' : 'none';

    document.getElementById('lbToggleFormBtn').style.display = tabId === 'entries' ? '' : 'none';
    document.getElementById('lbAddFuelBtn').style.display    = tabId === 'fuel' ? '' : 'none';

    if (tabId === 'entries')     _loadLogbookEntries();
    if (tabId === 'fuel')        _loadFuelLogs();
    if (tabId === 'maintenance') _renderMaintenanceStatus();
}

function _lbUpdateMaintenanceTabVisibility(device) {
    const config    = device?.config || {};
    const alertRows = Array.isArray(config.alert_rows) ? config.alert_rows : [];
    const hasMaint  = alertRows.some(r => r.alertKey === 'maintenance_alert');
    const btn = document.getElementById('lbTabMaintenance');
    if (btn) btn.style.display = hasMaint ? '' : 'none';
}

// ── Entry modal ───────────────────────────────────────────────────────────────

function openEntryModal(logId = null) {
    _editingEntryId = logId || null;
    const entry = logId ? _logbookEntries.find(e => e.id === logId) : null;
    const isNew = !entry;

    document.getElementById('lbEntryModalTitle').textContent = isNew ? 'New Entry' : 'Edit Entry';
    document.getElementById('lbEntryError').textContent = '';

    if (isNew) {
        const now = new Date();
        const localIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        document.getElementById('lbEntryDate').value        = localIso;
        document.getElementById('lbEntryDescription').value = '';
        document.getElementById('lbEntryPrice').value       = '';
        document.getElementById('lbEntryFiles').value       = '';

        const device = devices.find(d => d.id === _logbookDeviceId);
        const odo = device?.state?.total_odometer ?? device?.total_odometer ?? '';
        document.getElementById('lbEntryOdometer').value = odo !== '' ? parseFloat(odo).toFixed(1) : '';
    } else {
        document.getElementById('lbEntryDescription').value = entry.description;
        const localIso = new Date(new Date(entry.date).getTime()
            - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        document.getElementById('lbEntryDate').value      = localIso;
        document.getElementById('lbEntryOdometer').value  = entry.odometer ?? '';
        document.getElementById('lbEntryPrice').value     = entry.price != null ? _lbMoneyInput(entry.price) : '';
        document.getElementById('lbEntryFiles').value     = '';
    }

    const saveBtn = document.getElementById('lbEntrySaveBtn');
    saveBtn.disabled = false;
    saveBtn.innerHTML = isNew
        ? '<i class="mdi mdi-plus"></i> Add'
        : '<i class="mdi mdi-content-save"></i> Save';

    document.getElementById('lbEntryDeleteBtn').style.display = isNew ? 'none' : 'inline-flex';
    document.getElementById('lbEntryModal').classList.add('active');
    setTimeout(() => document.getElementById('lbEntryDescription').focus(), 50);
}

function closeEntryModal() {
    document.getElementById('lbEntryModal')?.classList.remove('active');
    _editingEntryId = null;
}

async function _lbEntryDelete() {
    if (!_editingEntryId || !confirm('Delete this logbook entry?')) return;
    const id = _editingEntryId;
    try {
        const res = await apiFetch(
            `${API_BASE}/devices/${_logbookDeviceId}/logbook/${id}`,
            { method: 'DELETE' }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        closeEntryModal();
        _loadLogbookEntries();
    } catch (e) {
        document.getElementById('lbEntryError').textContent = 'Failed to delete: ' + e.message;
    }
}

// ── Entries tab ───────────────────────────────────────────────────────────────

async function _loadLogbookEntries() {
    const tbody = document.getElementById('logbookTableBody');
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-muted);">Loading…</td></tr>`;

    try {
        const res = await apiFetch(`${API_BASE}/devices/${_logbookDeviceId}/logbook`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        _logbookEntries = await res.json();
        _renderLogbookTable();
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--accent-danger);">Failed to load: ${e.message}</td></tr>`;
    }
}

function _renderLogbookTable() {
    const tbody = document.getElementById('logbookTableBody');

    if (!_logbookEntries.length) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:2.5rem;color:var(--text-muted);">
            <div style="font-size:2.5rem;margin-bottom:0.5rem;"><i class="mdi mdi-clipboard-list"></i></div>
            No logbook entries yet. Click <strong>New Entry</strong> to add one.
        </td></tr>`;
        return;
    }

    tbody.innerHTML = _logbookEntries.map(e => {
        const dt      = new Date(e.date);
        const date    = dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        const time    = dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        const odo     = e.odometer != null ? `${parseFloat(e.odometer).toLocaleString()} km` : '—';
        const price   = e.price    != null ? _lbMoneySnapshot(e.price, e) : '—';
        const docHtml = (e.documents || []).length
            ? e.documents.map(d => {
                const raw  = d.split('/').pop();
                const dot  = raw.lastIndexOf('.');
                const ext  = dot !== -1 ? raw.slice(dot) : '';
                const base = dot !== -1 ? raw.slice(0, dot) : raw;
                const label = base.length > 16 ? base.slice(0, 5) + '…' + ext : raw;
                return `<a href="${d}" target="_blank" class="lb-doc-badge" title="${_esc(raw)}"><i class="mdi mdi-paperclip"></i> ${_esc(label)}</a>`;
              }).join('')
            : '—';

        return `<tr class="lb-row" ondblclick="openEntryModal(${e.id})">
            <td style="white-space:nowrap;">${date}<br><span style="color:var(--text-muted);font-size:0.8rem;">${time}</span></td>
            <td><span class="lb-row-name">${_esc(e.description)}</span></td>
            <td style="font-family:var(--font-mono);white-space:nowrap;color:var(--text-secondary);">${odo}</td>
            <td style="white-space:nowrap;color:var(--text-secondary);">${price}</td>
            <td class="lb-docs-cell">${docHtml}</td>
            <td style="white-space:nowrap;text-align:right;">
                <button class="btn btn-secondary lb-tbl-btn" onclick="openEntryModal(${e.id})"><i class="mdi mdi-pencil"></i> Edit</button>
            </td>
        </tr>`;
    }).join('');
}

async function submitLogbookEntry() {
    const errEl = document.getElementById('lbEntryError');
    errEl.textContent = '';

    const description = document.getElementById('lbEntryDescription').value.trim();
    const dateVal     = document.getElementById('lbEntryDate').value;
    const odoVal      = document.getElementById('lbEntryOdometer').value;
    const priceVal    = document.getElementById('lbEntryPrice').value;
    const filesInput  = document.getElementById('lbEntryFiles');

    if (!description) { errEl.textContent = 'Description is required.'; return; }
    if (!dateVal)      { errEl.textContent = 'Date is required.'; return; }

    const fd = new FormData();
    fd.append('description', description);
    fd.append('date', new Date(dateVal).toISOString());
    if (odoVal)   fd.append('odometer', parseFloat(odoVal));
    const priceBase = _lbMoneyFromInput('lbEntryPrice');
    if (priceVal && priceBase != null) fd.append('price', priceBase);
    for (const file of filesInput.files) fd.append('documents', file);

    const btn = document.getElementById('lbEntrySaveBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i> Saving…';

    try {
        const url    = _editingEntryId
            ? `${API_BASE}/devices/${_logbookDeviceId}/logbook/${_editingEntryId}`
            : `${API_BASE}/devices/${_logbookDeviceId}/logbook`;
        const method = _editingEntryId ? 'PUT' : 'POST';

        const token = localStorage.getItem('auth_token');
        const res = await fetch(url, {
            method,
            headers: { 'Authorization': `Bearer ${token}` },
            body: fd,
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }

        closeEntryModal();
        _loadLogbookEntries();
    } catch (e) {
        errEl.textContent = e.message;
    } finally {
        btn.disabled = false;
        btn.innerHTML = _editingEntryId
            ? '<i class="mdi mdi-content-save"></i> Save'
            : '<i class="mdi mdi-plus"></i> Add';
    }
}

async function deleteLogbookEntry(entryId) {
    if (!confirm('Delete this logbook entry?')) return;
    try {
        const res = await apiFetch(
            `${API_BASE}/devices/${_logbookDeviceId}/logbook/${entryId}`,
            { method: 'DELETE' }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        _loadLogbookEntries();
    } catch (e) {
        showAlert('Failed to delete: ' + e.message, 'error');
    }
}

// ── Fuel tab ──────────────────────────────────────────────────────────────────

async function _loadFuelLogs() {
    const tbody = document.getElementById('lbFuelBody');
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-muted);">Loading…</td></tr>`;
    try {
        const res = await apiFetch(`${API_BASE}/devices/${_logbookDeviceId}/fuel`);
        _fuelLogs = res.ok ? await res.json() : [];
    } catch { _fuelLogs = []; }
    _renderFuelTable();
}

function _renderFuelTable() {
    const tbody   = document.getElementById('lbFuelBody');
    const summary = document.getElementById('lbFuelSummary');
    if (!tbody) return;

    if (_fuelLogs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="padding:2rem;text-align:center;color:var(--text-muted);">No fill-ups recorded. Click <strong>Add Fill-up</strong> to start.</td></tr>`;
        if (summary) summary.textContent = '';
        return;
    }

    // L/100km between consecutive full-tank fill-ups
    const sorted = [..._fuelLogs].sort((a, b) => new Date(a.date) - new Date(b.date));
    const consumption = {};
    let lastFull = null;
    for (const log of sorted) {
        if (log.full_tank && lastFull && lastFull.odometer_km != null && log.odometer_km != null) {
            const dist = log.odometer_km - lastFull.odometer_km;
            if (dist > 0) consumption[log.id] = (log.liters / dist * 100).toFixed(1);
        }
        if (log.full_tank) lastFull = log;
    }

    const totalLitres = sorted.reduce((s, l) => s + l.liters, 0);
    const totalCost   = sorted.reduce((s, l) => s + (l.liters * (l.price_per_liter || 0)), 0);
    const avgVals     = Object.values(consumption).map(Number).filter(Boolean);
    const avgCons     = avgVals.length ? (avgVals.reduce((a,b) => a+b) / avgVals.length).toFixed(1) : null;
    if (summary) summary.innerHTML =
        `<strong>${totalLitres.toFixed(1)} L</strong> total` +
        (totalCost > 0 ? ` · <strong>${_lbMoney(totalCost)}</strong> total cost` : '') +
        (avgCons ? ` · <strong>${avgCons} L/100km</strong> avg consumption` : '');

    tbody.innerHTML = [..._fuelLogs]
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .map(log => {
            const dtObj    = new Date(log.date);
            const date     = dtObj.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
            const time     = dtObj.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
            const cons     = consumption[log.id] ? `${consumption[log.id]}` : '—';
            const total    = log.price_per_liter ? _lbMoneySnapshot(log.liters * log.price_per_liter, log) : '—';
            const fullIcon = log.full_tank
                ? `<i class="mdi mdi-check-circle" style="color:var(--accent-success);" title="Full tank"></i>`
                : `<i class="mdi mdi-minus" style="color:var(--text-muted);" title="Partial fill"></i>`;
            return `<tr class="lb-row" ondblclick="openFuelLogModal(${log.id})">
                <td style="white-space:nowrap;">${date}<br><span style="color:var(--text-muted);font-size:0.8rem;">${time}</span></td>
                <td style="text-align:right;font-family:var(--font-mono);">${log.liters.toFixed(2)}</td>
                <td style="text-align:right;font-family:var(--font-mono);color:var(--text-secondary);">${log.odometer_km != null ? Math.round(log.odometer_km).toLocaleString() : '—'}</td>
                <td style="text-align:right;color:var(--text-secondary);">${log.price_per_liter != null ? _lbMoneySnapshot(log.price_per_liter, log, 3) : '—'}</td>
                <td style="text-align:right;color:var(--text-secondary);">${total}</td>
                <td style="text-align:center;">${fullIcon}</td>
                <td style="text-align:right;font-family:var(--font-mono);">${cons}</td>
                <td style="text-align:right;">
                    <button class="btn btn-secondary lb-tbl-btn" onclick="openFuelLogModal(${log.id})"><i class="mdi mdi-pencil"></i> Edit</button>
                </td>
            </tr>`;
        }).join('');
}

function openFuelLogModal(logId = null) {
    _editingFuelLogId = logId || null;
    const log = logId ? _fuelLogs.find(l => l.id === logId) : null;
    const isNew = !log;

    document.getElementById('lbFuelModalTitle').textContent = isNew ? 'Add Fill-up' : 'Edit Fill-up';
    _lbApplyCurrencyLabels();
    document.getElementById('lbFuelLogId').value      = log?.id || '';
    document.getElementById('lbFuelLiters').value     = log?.liters ?? '';
    document.getElementById('lbFuelPrice').value      = log?.price_per_liter != null ? _lbMoneyInput(log.price_per_liter, 3) : '';
    document.getElementById('lbFuelOdometer').value   = log?.odometer_km ?? '';
    document.getElementById('lbFuelFullTank').checked = log?.full_tank ?? true;
    document.getElementById('lbFuelNotes').value      = log?.notes || '';

    const device = devices.find(d => d.id === _logbookDeviceId);
    const defaultOdo = isNew ? (device?.state?.total_odometer ?? '') : '';
    if (isNew && defaultOdo !== '') document.getElementById('lbFuelOdometer').value = Math.round(defaultOdo);

    const dt = log?.date
        ? new Date(log.date).toISOString().slice(0, 16)
        : new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    document.getElementById('lbFuelDate').value = dt;

    document.getElementById('lbFuelDeleteBtn').style.display = isNew ? 'none' : 'inline-flex';
    document.getElementById('lbFuelModal').classList.add('active');
}

function closeFuelLogModal() {
    document.getElementById('lbFuelModal').classList.remove('active');
    _editingFuelLogId = null;
}

async function saveFuelLog() {
    const liters = parseFloat(document.getElementById('lbFuelLiters').value);
    if (!liters || liters <= 0) { document.getElementById('lbFuelLiters').focus(); return; }

    const dateVal = document.getElementById('lbFuelDate').value;
    if (!dateVal) { document.getElementById('lbFuelDate').focus(); return; }

    const payload = {
        date:            new Date(dateVal).toISOString(),
        liters,
        odometer_km:     parseFloat(document.getElementById('lbFuelOdometer').value) || null,
        price_per_liter: _lbMoneyFromInput('lbFuelPrice'),
        full_tank:       document.getElementById('lbFuelFullTank').checked,
        notes:           document.getElementById('lbFuelNotes').value.trim() || null,
    };

    try {
        const logId = document.getElementById('lbFuelLogId').value;
        const url   = logId
            ? `${API_BASE}/devices/${_logbookDeviceId}/fuel/${logId}`
            : `${API_BASE}/devices/${_logbookDeviceId}/fuel`;
        const res = await apiFetch(url, {
            method:  logId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
        });
        if (!res.ok) throw new Error((await res.json()).detail || 'Save failed');
        closeFuelLogModal();
        await _loadFuelLogs();
    } catch (e) { showAlert(e.message, 'error'); }
}

async function deleteFuelLog() {
    const logId = document.getElementById('lbFuelLogId').value;
    if (!logId || !confirm('Delete this fill-up?')) return;
    try {
        await apiFetch(`${API_BASE}/devices/${_logbookDeviceId}/fuel/${logId}`, { method: 'DELETE' });
        closeFuelLogModal();
        await _loadFuelLogs();
    } catch { showAlert('Delete failed', 'error'); }
}

// ── Maintenance tab ───────────────────────────────────────────────────────────

function _renderMaintenanceStatus() {
    const device    = devices.find(d => d.id === _logbookDeviceId);
    const odometer  = device?.state?.total_odometer ?? 0;
    const config    = device?.config || {};
    const alertRows = Array.isArray(config.alert_rows) ? config.alert_rows : [];
    const maintRows = alertRows.filter(r => r.alertKey === 'maintenance_alert');
    const container = document.getElementById('lbMaintenanceList');
    if (!container) return;

    if (maintRows.length === 0) {
        container.innerHTML = `<p style="color:var(--text-muted);font-size:0.875rem;">
            No maintenance alerts configured. Add one from Device Management → Alerts.</p>`;
        return;
    }

    container.innerHTML = maintRows.map(row => {
        const p     = row.params || {};
        const label = p.custom_label || (p.maintenance_type || 'service').replace(/_/g, ' ')
                        .replace(/\b\w/g, c => c.toUpperCase());
        const mode  = p.tracking_mode || 'km';
        const parts = [];

        if (mode === 'km' || mode === 'both') {
            const nextKm    = parseFloat(p.next_service_km || 0);
            const remaining = nextKm - odometer;
            const status    = remaining <= 0 ? 'due' : remaining <= parseFloat(p.warning_km || 500) ? 'warn' : 'ok';
            const colour    = status === 'due' ? 'var(--accent-danger)' : status === 'warn' ? '#f59e0b' : 'var(--accent-success)';
            parts.push(`<span style="color:${colour};font-weight:600;">
                ${remaining <= 0 ? 'OVERDUE' : Math.round(remaining) + ' km remaining'}
            </span> <span style="color:var(--text-muted);font-size:0.8rem;">(due at ${Math.round(nextKm).toLocaleString()} km)</span>`);
        }

        if (mode === 'days' || mode === 'both') {
            const nextDate = p.next_service_date ? new Date(p.next_service_date) : null;
            if (nextDate) {
                const daysLeft = Math.round((nextDate - new Date()) / 86400000);
                const status   = daysLeft <= 0 ? 'due' : daysLeft <= parseInt(p.warning_days || 14) ? 'warn' : 'ok';
                const colour   = status === 'due' ? 'var(--accent-danger)' : status === 'warn' ? '#f59e0b' : 'var(--accent-success)';
                const humanDays = d => d === 1 ? '1 day' : d < 7 ? `${d} days` : d < 30 ? (w => w === 1 ? '1 week' : `${w} weeks`)(Math.round(d / 7)) : (m => m === 1 ? '1 month' : `${m} months`)(Math.round(d / 30));
                parts.push(`<span style="color:${colour};font-weight:600;">
                    ${daysLeft <= 0 ? 'OVERDUE' : humanDays(daysLeft) + ' remaining'}
                </span> <span style="color:var(--text-muted);font-size:0.8rem;">(due ${nextDate.toLocaleDateString()})</span>`);
            }
        }

        return `
        <div class="lb-maint-card">
            <div class="lb-maint-body">
                <i class="mdi mdi-wrench" style="font-size:1.4rem;color:var(--text-muted);flex-shrink:0;"></i>
                <div style="flex:1;min-width:0;">
                    <div style="font-weight:600;margin-bottom:0.25rem;">${_esc(label)}</div>
                    <div style="font-size:0.85rem;">${parts.join('<br>')}</div>
                </div>
            </div>
            <button type="button" class="btn btn-secondary" style="font-size:0.8rem;white-space:nowrap;"
                onclick="lbLogMaintenanceService(${JSON.stringify(row.uid || row.alertKey)}, ${device.id})">
                <i class="mdi mdi-check"></i> Log Service
            </button>
        </div>`;
    }).join('');
}

async function lbLogMaintenanceService(uid, deviceId) {
    const device = devices.find(d => d.id === deviceId);
    if (!device) return;

    const config    = device.config || {};
    const alertRows = Array.isArray(config.alert_rows) ? config.alert_rows : [];
    const row       = alertRows.find(r => (r.uid || r.alertKey) == uid);
    if (!row) return;

    const odometer     = device.state?.total_odometer ?? 0;
    const intervalKm   = parseFloat(row.params?.interval_km   || 5000);
    const intervalDays = parseInt(row.params?.interval_days   || 180);
    const mode         = row.params?.tracking_mode || 'km';

    if (mode === 'km' || mode === 'both')
        row.params.next_service_km = Math.round(odometer + intervalKm);

    if (mode === 'days' || mode === 'both') {
        const d = new Date(); d.setDate(d.getDate() + intervalDays);
        row.params.next_service_date = d.toISOString().split('T')[0];
    }

    try {
        const payload = {
            imei:              device.imei,
            name:              device.name,
            protocol:          device.protocol,
            vehicle_type:      device.vehicle_type,
            license_plate:     device.license_plate,
            custom_attributes: device.custom_attributes,
            company_id:        device.company_id,
            config,
        };
        const res = await apiFetch(`${API_BASE}/devices/${deviceId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error('Save failed');
        if (typeof loadDevices === 'function') loadDevices();
        showAlert('Service logged and saved.', 'success');
    } catch (e) {
        showAlert('Failed to save: ' + e.message, 'error');
    }

    _renderMaintenanceStatus();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
