/**
 * dashboard-logbook.js
 * Logbook modal — per-vehicle service / maintenance records.
 *
 * Public API:
 *   openLogbookModal(deviceId)   — open the modal for a device
 *   closeLogbookModal()          — close it
 */

// ── State ─────────────────────────────────────────────────────────────────────
let _logbookDeviceId  = null;
let _logbookEntries   = [];
let _editingEntryId   = null;

// ── Open / Close ──────────────────────────────────────────────────────────────
function openLogbookModal(deviceId) {
    _logbookDeviceId = deviceId;
    _editingEntryId  = null;

    const device = devices.find(d => d.id === deviceId);
    const icon   = device ? (VEHICLE_ICONS[device.vehicle_type] || VEHICLE_ICONS['other']).emoji : '🚗';
    const name   = device ? device.name : `Device ${deviceId}`;

    document.getElementById('logbookModalTitle').textContent = `${icon} ${name} — Logbook`;

    // Always start with form collapsed
    _collapseLogbookForm();

    document.getElementById('logbookModal').classList.add('active');
    _loadLogbookEntries();
}

function closeLogbookModal() {
    document.getElementById('logbookModal').classList.remove('active');
    _logbookDeviceId = null;
    _editingEntryId  = null;
}

// ── Form collapse / expand ────────────────────────────────────────────────────
function _collapseLogbookForm() {
    document.getElementById('logbookFormPanel').style.display = 'none';
    document.getElementById('lbToggleFormBtn').textContent    = '➕ New Entry';
    _editingEntryId = null;
}

function toggleLogbookForm() {
    const panel = document.getElementById('logbookFormPanel');
    const isHidden = panel.style.display === 'none';
    if (isHidden) {
        panel.style.display = 'block';
        document.getElementById('lbToggleFormBtn').textContent = '✕ Cancel';
        const device = devices.find(d => d.id === _logbookDeviceId);
        _prefillLogbookForm(device);
        document.getElementById('lbDescription').focus();
    } else {
        _collapseLogbookForm();
    }
}

// ── Pre-fill form defaults ────────────────────────────────────────────────────
function _prefillLogbookForm(device) {
    const now = new Date();
    const localIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
        .toISOString().slice(0, 16);
    document.getElementById('lbDate').value = localIso;

    const odo = device?.state?.total_odometer ?? device?.total_odometer ?? '';
    document.getElementById('lbOdometer').value = odo !== '' ? parseFloat(odo).toFixed(1) : '';

    document.getElementById('lbDescription').value      = '';
    document.getElementById('lbPrice').value            = '';
    document.getElementById('lbFiles').value            = '';
    document.getElementById('lbFormError').textContent  = '';
    _editingEntryId = null;
    const submitBtn = document.getElementById('lbSubmitBtn');
    submitBtn.disabled    = false;
    submitBtn.textContent = '➕ Add Entry';
    document.getElementById('lbCancelEditBtn').style.display = 'none';
}

// ── Load entries ──────────────────────────────────────────────────────────────
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

// ── Render table ──────────────────────────────────────────────────────────────
function _renderLogbookTable() {
    const tbody = document.getElementById('logbookTableBody');

    if (!_logbookEntries.length) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:2.5rem;color:var(--text-muted);">
            <div style="font-size:2.5rem;margin-bottom:0.5rem;">📋</div>
            No logbook entries yet. Click <strong>New Entry</strong> to add one.
        </td></tr>`;
        return;
    }

    tbody.innerHTML = _logbookEntries.map(e => {
        const date    = new Date(e.date).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
        const odo     = e.odometer != null ? `${parseFloat(e.odometer).toLocaleString()} km` : '—';
        const price   = e.price    != null ? `€${parseFloat(e.price).toFixed(2)}` : '—';
        const docHtml = (e.documents || []).length
            ? e.documents.map(d => {
                const raw  = d.split('/').pop();
                const dot  = raw.lastIndexOf('.');
                const ext  = dot !== -1 ? raw.slice(dot) : '';
                const base = dot !== -1 ? raw.slice(0, dot) : raw;
                const label = base.length > 16 ? base.slice(0, 5) + '…' + ext : raw;
                return `<a href="${d}" target="_blank" class="lb-doc-badge" title="${_escHtml(raw)}">📎 ${_escHtml(label)}</a>`;
              }).join('')
            : '—';

        return `<tr>
            <td style="white-space:nowrap;">${date}</td>
            <td>${_escHtml(e.description)}</td>
            <td style="font-family:var(--font-mono);white-space:nowrap;">${odo}</td>
            <td style="white-space:nowrap;">${price}</td>
            <td class="lb-docs-cell">${docHtml}</td>
            <td style="white-space:nowrap;text-align:right;">
                <button class="btn btn-secondary tbl-btn" onclick="startEditLogbookEntry(${e.id})">✏️</button>
                <button class="btn btn-secondary tbl-btn" onclick="deleteLogbookEntry(${e.id})" style="color:var(--accent-danger);">🗑️</button>
            </td>
        </tr>`;
    }).join('');
}

// ── Submit (add / update) ─────────────────────────────────────────────────────
async function submitLogbookEntry() {
    const errEl = document.getElementById('lbFormError');
    errEl.textContent = '';

    const description = document.getElementById('lbDescription').value.trim();
    const dateVal     = document.getElementById('lbDate').value;
    const odoVal      = document.getElementById('lbOdometer').value;
    const priceVal    = document.getElementById('lbPrice').value;
    const filesInput  = document.getElementById('lbFiles');

    if (!description) { errEl.textContent = 'Description is required.'; return; }
    if (!dateVal)      { errEl.textContent = 'Date is required.'; return; }

    const fd = new FormData();
    fd.append('description', description);
    fd.append('date', new Date(dateVal).toISOString());
    if (odoVal)   fd.append('odometer', parseFloat(odoVal));
    if (priceVal) fd.append('price',    parseFloat(priceVal));
    for (const file of filesInput.files) fd.append('documents', file);

    const btn = document.getElementById('lbSubmitBtn');
    btn.disabled = true;
    btn.textContent = _editingEntryId ? '💾 Saving…' : '⏳ Adding…';

    try {
        const url    = _editingEntryId
            ? `${API_BASE}/devices/${_logbookDeviceId}/logbook/${_editingEntryId}`
            : `${API_BASE}/devices/${_logbookDeviceId}/logbook`;
        const method = _editingEntryId ? 'PUT' : 'POST';

        // Do NOT set Content-Type — browser sets multipart boundary automatically
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

        _collapseLogbookForm();
        _loadLogbookEntries();
    } catch (e) {
        errEl.textContent = e.message;
    } finally {
        btn.disabled = false;
        btn.textContent = _editingEntryId ? '💾 Save Changes' : '➕ Add Entry';
    }
}

// ── Edit ──────────────────────────────────────────────────────────────────────
function startEditLogbookEntry(entryId) {
    const entry = _logbookEntries.find(e => e.id === entryId);
    if (!entry) return;
    _editingEntryId = entryId;

    // Show the form panel
    const panel = document.getElementById('logbookFormPanel');
    panel.style.display = 'block';
    document.getElementById('lbToggleFormBtn').textContent = '✕ Cancel';

    document.getElementById('lbDescription').value = entry.description;
    const localIso = new Date(new Date(entry.date).getTime()
        - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    document.getElementById('lbDate').value      = localIso;
    document.getElementById('lbOdometer').value  = entry.odometer ?? '';
    document.getElementById('lbPrice').value     = entry.price ?? '';
    document.getElementById('lbFiles').value     = '';
    document.getElementById('lbFormError').textContent = '';

    document.getElementById('lbSubmitBtn').textContent         = '💾 Save Changes';
    document.getElementById('lbCancelEditBtn').style.display   = 'inline-block';

    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cancelEditLogbookEntry() {
    _collapseLogbookForm();
}

// ── Delete ────────────────────────────────────────────────────────────────────
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
        alert('Failed to delete: ' + e.message);
    }
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function _escHtml(str) {
    return String(str)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}