'use strict';

const _simIsAdmin = localStorage.getItem('is_admin') === 'true';

let _simCards           = [];
let _simProviders       = [];
let _simDevices         = [];
let _simCompanies       = [];
let _editingSimCard     = null;
let _simSortCol         = 'phone_number';
let _simSortDir         = 1;
let _simSectionInitialized = false;

async function initSimCardsSection() {
    if (_simSectionInitialized) {
        _renderSimTable();
        return;
    }
    _simSectionInitialized = true;
    if (!hasPermission('manage_sim_cards')) return;

    await Promise.all([
        _loadSimProviders(),
        _loadSimDevices(),
        _simIsAdmin ? _loadSimCompanies() : Promise.resolve(),
    ]);

    if (_simIsAdmin) {
        const hdr = document.getElementById('simCompanyHeader');
        if (hdr) hdr.style.display = '';
    }

    RoutarioTables.updateSortHeaders('#section-sim_cards', {
        col: _simSortCol,
        dir: _simSortDir === 1 ? 'asc' : 'desc',
    });

    await _loadSimCards();
}

async function _loadSimProviders() {
    try {
        const res = await apiFetch(`${API_BASE}/sim-cards/providers`);
        if (res.ok) _simProviders = await res.json();
    } catch (e) {
        console.error('Failed to load SIM providers:', e);
    }
}

async function _loadSimCompanies() {
    try {
        const res = await apiFetch(`${API_BASE}/companies`);
        if (res.ok) _simCompanies = await res.json();
    } catch (e) {
        console.error('Failed to load companies for SIM cards:', e);
    }
}

async function _loadSimDevices() {
    try {
        const res = await apiFetch(`${API_BASE}/devices`);
        if (res.ok) _simDevices = await res.json();
    } catch (e) {
        console.error('Failed to load devices for SIM cards:', e);
    }
}

async function _loadSimCards() {
    const tbody = document.getElementById('simCardsTableBody');
    if (tbody && !_simCards.length) {
        tbody.innerHTML = `<tr><td colspan="${_simIsAdmin ? 9 : 8}" style="text-align:center;padding:3rem;color:var(--text-muted);"><div class="loading" style="margin:0 auto 1rem;"></div>Loading SIM cards…</td></tr>`;
    }
    try {
        const res = await apiFetch(`${API_BASE}/sim-cards`);
        if (res.ok) _simCards = await res.json();
    } catch (e) {
        console.error('Failed to load SIM cards:', e);
    }
    _renderSimTable();
}

function filterSimCards() {
    _renderSimTable();
}

function sortSimCards(col) {
    ({ col: _simSortCol, dir: _simSortDir } = RoutarioTables.toggleNumericSort(_simSortCol, _simSortDir, col));
    RoutarioTables.updateSortHeaders('#section-sim_cards', {
        col,
        dir: _simSortDir === 1 ? 'asc' : 'desc',
    });
    _renderSimTable();
}

function _renderProviderBadge(providerId) {
    if (!providerId) {
        return `<span class="badge" style="background:rgba(148,163,184,0.12);color:var(--text-muted);border:1px solid rgba(148,163,184,0.28);font-size:0.78rem;padding:0.2rem 0.55rem;border-radius:6px;font-weight:500;">Manual</span>`;
    }

    const provObj = _simProviders.find(p => p.provider_id === providerId);
    const provName = provObj ? provObj.display_name : providerId;

    if (providerId === 'iotsim_gr') {
        return `<span class="badge" style="background:rgba(14,165,233,0.12);color:#0284c7;border:1px solid rgba(14,165,233,0.28);font-size:0.78rem;padding:0.2rem 0.55rem;border-radius:6px;font-weight:600;">${RoutarioUI.escapeHtml(provName)}</span>`;
    }
    if (providerId === 'thingsmobile') {
        return `<span class="badge" style="background:rgba(249,115,22,0.12);color:#ea580c;border:1px solid rgba(249,115,22,0.28);font-size:0.78rem;padding:0.2rem 0.55rem;border-radius:6px;font-weight:600;">${RoutarioUI.escapeHtml(provName)}</span>`;
    }
    if (providerId === '1nce' || providerId === 'once') {
        return `<span class="badge" style="background:rgba(99,102,241,0.12);color:#4f46e5;border:1px solid rgba(99,102,241,0.28);font-size:0.78rem;padding:0.2rem 0.55rem;border-radius:6px;font-weight:600;">1NCE</span>`;
    }

    const palettes = [
        { bg: 'rgba(99,102,241,0.12)', color: '#6366f1', border: 'rgba(99,102,241,0.28)' },
        { bg: 'rgba(16,185,129,0.12)', color: '#059669', border: 'rgba(16,185,129,0.28)' },
        { bg: 'rgba(236,72,153,0.12)', color: '#db2777', border: 'rgba(236,72,153,0.28)' },
        { bg: 'rgba(168,85,247,0.12)', color: '#9333ea', border: 'rgba(168,85,247,0.28)' },
    ];
    let hash = 0;
    for (let i = 0; i < providerId.length; i++) hash = (hash << 5) - hash + providerId.charCodeAt(i);
    const pal = palettes[Math.abs(hash) % palettes.length];

    return `<span class="badge" style="background:${pal.bg};color:${pal.color};border:1px solid ${pal.border};font-size:0.78rem;padding:0.2rem 0.55rem;border-radius:6px;font-weight:600;">${RoutarioUI.escapeHtml(provName)}</span>`;
}

function _renderSimTable() {
    const query = (document.getElementById('simCardSearch')?.value ?? '').toLowerCase().trim();
    const list = [..._simCards.filter(s =>
        (s.phone_number || '').toLowerCase().includes(query) ||
        (s.account_label || '').toLowerCase().includes(query) ||
        (s.provider_id || '').toLowerCase().includes(query) ||
        (s.device_name || '').toLowerCase().includes(query)
    )].sort((a, b) => {
        let av = '', bv = '';
        switch (_simSortCol) {
            case 'account_label':     av = a.account_label || ''; bv = b.account_label || ''; break;
            case 'provider':          av = a.provider_id || ''; bv = b.provider_id || ''; break;
            case 'expiry_date':       av = a.expiry_date || ''; bv = b.expiry_date || ''; break;
            case 'company':           av = _simCompanies.find(c => c.id === a.company_id)?.name || ''; bv = _simCompanies.find(c => c.id === b.company_id)?.name || ''; break;
            case 'device':            av = a.device_name || ''; bv = b.device_name || ''; break;
            default:                  av = a.phone_number || ''; bv = b.phone_number || '';
        }
        return av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' }) * _simSortDir;
    });

    const countEl = document.getElementById('simCardCount');
    if (countEl) countEl.textContent = `${list.length} SIM card${list.length !== 1 ? 's' : ''}`;

    const colSpan = _simIsAdmin ? 7 : 6;
    const tbody = document.getElementById('simCardsTableBody');
    if (!tbody) return;

    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${colSpan}" style="text-align:center;padding:3rem;color:var(--text-muted);"><div style="font-size:2.5rem;margin-bottom:0.75rem;"><i class="mdi mdi-sim"></i></div>No SIM cards found</td></tr>`;
        return;
    }

    tbody.innerHTML = list.map(s => {
        const comp = _simCompanies.find(c => c.id === s.company_id);
        const compName = comp ? comp.name : (s.company_id ? `Company #${s.company_id}` : '—');
        const devHtml = s.device_name
            ? `<span style="display:inline-flex;align-items:center;gap:0.4rem;font-weight:500;"><i class="mdi mdi-car"></i> ${RoutarioUI.escapeHtml(s.device_name)}</span>`
            : `<span style="color:var(--text-muted);font-style:italic;">— Unassigned —</span>`;

        const expHtml = s.expiry_date
            ? `<span style="font-size:0.85rem;color:var(--text-secondary);">${RoutarioUI.escapeHtml(formatDateValue(s.expiry_date))}</span>`
            : `<span style="color:var(--text-muted);">—</span>`;

        return `<tr class="table-row" ondblclick="openEditSimCardModal(${s.id})" style="cursor:pointer;" title="Double-click to edit">
            <td style="font-weight:600;color:var(--text-primary);">${RoutarioUI.escapeHtml(s.account_label || s.phone_number || '—')}</td>
            <td>${_renderProviderBadge(s.provider_id)}</td>
            <td style="font-family:var(--font-mono);font-size:0.88rem;font-weight:600;">${RoutarioUI.escapeHtml(s.phone_number)}</td>
            <td>${expHtml}</td>
            ${_simIsAdmin ? `<td style="font-size:0.85rem;color:var(--text-secondary);">${RoutarioUI.escapeHtml(compName)}</td>` : ''}
            <td>${devHtml}</td>
            <td style="text-align:center;white-space:nowrap;">
                <button class="btn btn-secondary tbl-btn" onclick="openEditSimCardModal(${s.id})" title="Edit SIM Card"><i class="mdi mdi-pencil"></i></button>
            </td>
        </tr>`;
    }).join('');
}

// ── Modal Handling ───────────────────────────────────────────────

function isSimDateFormatDefault() {
    const df = localStorage.getItem('date_format') || 'auto';
    return df === 'auto';
}

function _getDateFormatPlaceholder() {
    const fmt = localStorage.getItem('date_format') || 'auto';
    if (fmt === 'YYYY-MM-DD' || fmt === 'DD/MM/YYYY' || fmt === 'MM/DD/YYYY' || fmt === 'DD.MM.YYYY') {
        return fmt;
    }
    return 'YYYY-MM-DD';
}

function initSimDateInput() {
    const isDef = isSimDateFormatDefault();
    const el = document.getElementById('simExpiryDate');
    if (!el) return;
    const wrap = el.closest('.datetime-picker-wrap');
    if (isDef) {
        el.type = 'date';
        if (wrap) wrap.classList.add('is-native');
    } else {
        el.type = 'text';
        if (wrap) wrap.classList.remove('is-native');
        el.placeholder = _getDateFormatPlaceholder();
    }
}

function setSimInputDate(date) {
    const el = document.getElementById('simExpiryDate');
    if (!el) return;
    if (!date) {
        el.value = '';
        el.dataset.iso = '';
        const picker = document.getElementById('simExpiryDatePicker');
        if (picker) picker.value = '';
        return;
    }
    const d = _parseDate(date);
    if (!d || isNaN(d.getTime())) {
        el.value = String(date);
        return;
    }
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    el.dataset.iso = ymd;
    const isDef = isSimDateFormatDefault();
    const wrap = el.closest('.datetime-picker-wrap');
    if (isDef) {
        if (el.type !== 'date') el.type = 'date';
        if (wrap) wrap.classList.add('is-native');
        el.value = ymd;
    } else {
        if (el.type !== 'text') el.type = 'text';
        if (wrap) wrap.classList.remove('is-native');
        el.value = typeof formatDateValue === 'function' ? formatDateValue(d) : ymd;
        const picker = document.getElementById('simExpiryDatePicker');
        if (picker) picker.value = ymd;
    }
}

function getSimInputIso() {
    const el = document.getElementById('simExpiryDate');
    if (!el) return null;
    if (el.type === 'date' && el.value) {
        return el.value;
    }
    if (el.dataset.iso) {
        return el.dataset.iso;
    }
    const val = (el.value || '').trim();
    if (!val) return null;
    const parsed = typeof parseUserDateTime === 'function' ? parseUserDateTime(val) : _parseDate(val);
    if (parsed && !isNaN(parsed.getTime())) {
        return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
    }
    return val;
}

function openAddSimCardModal() {
    _editingSimCard = null;
    document.getElementById('simCardModalTitle').textContent = 'Add SIM Card';
    document.getElementById('simSubmitBtnText').textContent = 'Add SIM Card';
    document.getElementById('simDeleteBtn').style.display = 'none';

    document.getElementById('simAccountLabel').value = '';
    document.getElementById('simPhoneNumber').value = '';
    document.getElementById('simPlanName').value = '';
    document.getElementById('simBalance').value = '';
    document.getElementById('simRemainingDataMb').value = '';
    document.getElementById('simCurrency').value = 'EUR';

    initSimDateInput();
    setSimInputDate(null);

    // Populate Provider Select with optional manual/none choice
    const provSel = document.getElementById('simProviderSelect');
    provSel.innerHTML = '<option value="">— None (Manual SIM) —</option>' +
        _simProviders.map(p => `<option value="${p.provider_id}">${RoutarioUI.escapeHtml(p.display_name)}</option>`).join('');
    provSel.value = '';

    // Populate Company Select
    if (_simIsAdmin) {
        const compGrp = document.getElementById('simCompanyGroup');
        if (compGrp) compGrp.style.display = '';
        const compSel = document.getElementById('simCompanySelect');
        compSel.innerHTML = '<option value="">— None / Global —</option>' +
            _simCompanies.map(c => `<option value="${c.id}">${RoutarioUI.escapeHtml(c.name)}</option>`).join('');
        compSel.value = '';
    }

    _populateSimDeviceSelect(null, null);
    onSimProviderChange();

    document.getElementById('simRemoteFetchGroup').style.display = 'none';
    document.getElementById('simTestResult').style.display = 'none';
    document.getElementById('simCardModal').classList.add('active');
}

function openEditSimCardModal(simId) {
    const s = _simCards.find(x => x.id === simId);
    if (!s) return;
    _editingSimCard = s;

    document.getElementById('simCardModalTitle').textContent = 'Edit SIM Card';
    document.getElementById('simSubmitBtnText').textContent = 'Save Changes';
    document.getElementById('simDeleteBtn').style.display = 'inline-flex';

    document.getElementById('simAccountLabel').value = s.account_label || '';
    document.getElementById('simPhoneNumber').value = s.phone_number || '';
    document.getElementById('simPlanName').value = s.plan_name || '';
    document.getElementById('simBalance').value = s.balance != null ? s.balance : '';
    document.getElementById('simRemainingDataMb').value = s.remaining_data_mb != null ? s.remaining_data_mb : '';
    document.getElementById('simCurrency').value = s.currency || 'EUR';

    initSimDateInput();
    setSimInputDate(s.expiry_date);

    const provSel = document.getElementById('simProviderSelect');
    provSel.innerHTML = '<option value="">— None (Manual SIM) —</option>' +
        _simProviders.map(p => `<option value="${p.provider_id}"${p.provider_id === s.provider_id ? ' selected' : ''}>${RoutarioUI.escapeHtml(p.display_name)}</option>`).join('');
    provSel.value = s.provider_id || '';

    if (_simIsAdmin) {
        const compGrp = document.getElementById('simCompanyGroup');
        if (compGrp) compGrp.style.display = '';
        const compSel = document.getElementById('simCompanySelect');
        compSel.innerHTML = '<option value="">— None / Global —</option>' +
            _simCompanies.map(c => `<option value="${c.id}"${c.id === s.company_id ? ' selected' : ''}>${RoutarioUI.escapeHtml(c.name)}</option>`).join('');
        compSel.value = s.company_id ? String(s.company_id) : '';
    }

    _populateSimDeviceSelect(s.device_id, s.company_id);
    onSimProviderChange(s.credentials || {});

    document.getElementById('simRemoteFetchGroup').style.display = 'none';
    document.getElementById('simTestResult').style.display = 'none';
    document.getElementById('simCardModal').classList.add('active');
}

function closeSimCardModal() {
    document.getElementById('simCardModal').classList.remove('active');
    _editingSimCard = null;
}

function _populateSimDeviceSelect(selectedDeviceId = null, companyId = null) {
    const devSel = document.getElementById('simAssignedDevice');
    if (!devSel) return;

    let targetComp = companyId;
    if (targetComp == null) {
        if (_simIsAdmin) {
            const compSelVal = document.getElementById('simCompanySelect')?.value;
            targetComp = compSelVal ? parseInt(compSelVal, 10) : null;
        } else {
            targetComp = parseInt(localStorage.getItem('company_id'), 10) || null;
        }
    }

    const filteredDevs = _simDevices.filter(d => {
        if (targetComp && d.company_id && d.company_id !== targetComp) return false;
        return true;
    });

    devSel.innerHTML = '<option value="">— Unassigned —</option>' +
        filteredDevs.map(d => `<option value="${d.id}"${d.id === selectedDeviceId ? ' selected' : ''}>${RoutarioUI.escapeHtml(d.name)}${d.license_plate ? ' (' + RoutarioUI.escapeHtml(d.license_plate) + ')' : ''}</option>`).join('');
}

function onSimCompanyChange() {
    const compSelVal = document.getElementById('simCompanySelect')?.value;
    const compId = compSelVal ? parseInt(compSelVal, 10) : null;
    _populateSimDeviceSelect(null, compId);
}

function onSimProviderChange(existingCreds = null) {
    const provId = document.getElementById('simProviderSelect')?.value;
    const provider = _simProviders.find(p => p.provider_id === provId);
    const container = document.getElementById('simProviderFields');
    const testBtn = document.getElementById('simTestBtn');
    const fetchBtn = document.getElementById('simFetchBtn');
    const resultEl = document.getElementById('simTestResult');
    const fetchGrp = document.getElementById('simRemoteFetchGroup');
    const planRow = document.getElementById('simPlanFieldsRow');
    const balRow = document.getElementById('simBalanceFieldsRow');
    const isManual = !provId;

    if (planRow) planRow.style.display = isManual ? 'flex' : 'none';
    if (balRow) balRow.style.display = isManual ? 'flex' : 'none';

    if (!provider || !provId) {
        if (container) container.innerHTML = '';
        if (testBtn) testBtn.style.display = 'none';
        if (fetchBtn) fetchBtn.style.display = 'none';
        if (resultEl) resultEl.style.display = 'none';
        if (fetchGrp) fetchGrp.style.display = 'none';
        return;
    }

    if (testBtn) testBtn.style.display = 'inline-flex';
    if (fetchBtn) fetchBtn.style.display = 'inline-flex';

    if (container) {
        const creds = existingCreds || _editingSimCard?.credentials || {};
        container.innerHTML = (provider.fields || []).map(f => {
            const val = creds[f.key] != null ? creds[f.key] : (f.default || '');
            const inputType = f.field_type === 'password' ? 'password' : 'text';
            return `
                <div class="form-group" style="margin-bottom:0.85rem;">
                    <label class="form-label">${RoutarioUI.escapeHtml(f.label)} ${f.required ? '<span style="color:var(--color-danger,#ef4444)">*</span>' : ''}</label>
                    <input type="${inputType}" id="simCred_${f.key}" class="form-input" placeholder="${RoutarioUI.escapeHtml(f.placeholder || '')}" value="${RoutarioUI.escapeHtml(String(val))}">
                    ${f.help_text ? `<span style="font-size:0.75rem;color:var(--text-muted);display:block;margin-top:0.25rem;">${RoutarioUI.escapeHtml(f.help_text)}</span>` : ''}
                </div>
            `;
        }).join('');
    }
}

function _getSimCredentialsFromForm() {
    const provId = document.getElementById('simProviderSelect')?.value;
    const provider = _simProviders.find(p => p.provider_id === provId);
    if (!provider) return {};

    const creds = {};
    for (const f of (provider.fields || [])) {
        const el = document.getElementById(`simCred_${f.key}`);
        if (el) creds[f.key] = el.value.trim();
    }
    return creds;
}

async function testSimConnection() {
    const provId = document.getElementById('simProviderSelect')?.value;
    if (!provId) return;

    const creds = _getSimCredentialsFromForm();
    const btn = document.getElementById('simTestBtn');
    const testText = document.getElementById('simTestText');
    const testLoad = document.getElementById('simTestLoading');
    const testIcon = document.getElementById('simTestIcon');
    const resultEl = document.getElementById('simTestResult');

    if (btn) btn.disabled = true;
    if (testText) testText.textContent = 'Testing…';
    if (testIcon) testIcon.style.display = 'none';
    if (testLoad) testLoad.style.display = 'inline-block';

    if (resultEl) {
        resultEl.style.display = 'block';
        resultEl.className = 'badge';
        resultEl.style.background = 'rgba(99,102,241,0.12)';
        resultEl.style.color = 'var(--accent-primary,#6366f1)';
        resultEl.textContent = 'Testing connection…';
    }

    try {
        const res = await apiFetch(`${API_BASE}/sim-cards/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider_id: provId, credentials: creds }),
        });
        const data = await res.json();
        if (data.ok) {
            resultEl.style.background = 'rgba(34,197,94,0.15)';
            resultEl.style.color = 'var(--color-success,#22c55e)';
            resultEl.textContent = `✓ ${data.message || 'Connection successful'}`;
        } else {
            resultEl.style.background = 'rgba(239,68,68,0.15)';
            resultEl.style.color = 'var(--color-danger,#ef4444)';
            resultEl.textContent = `✗ ${data.message || 'Connection failed'}`;
        }
    } catch (e) {
        resultEl.style.background = 'rgba(239,68,68,0.15)';
        resultEl.style.color = 'var(--color-danger,#ef4444)';
        resultEl.textContent = `✗ ${e.message}`;
    } finally {
        if (btn) btn.disabled = false;
        if (testText) testText.textContent = 'Test Connection';
        if (testIcon) testIcon.style.display = '';
        if (testLoad) testLoad.style.display = 'none';
    }
}

async function fetchRemoteSims() {
    const provId = document.getElementById('simProviderSelect')?.value;
    if (!provId) return;

    const creds = _getSimCredentialsFromForm();
    const btn = document.getElementById('simFetchBtn');
    const fetchText = document.getElementById('simFetchText');
    const fetchLoad = document.getElementById('simFetchLoading');
    const fetchIcon = document.getElementById('simFetchIcon');
    const fetchGrp = document.getElementById('simRemoteFetchGroup');
    const sel = document.getElementById('simRemotePickerSelect');

    if (btn) btn.disabled = true;
    if (fetchText) fetchText.textContent = 'Fetching SIMs…';
    if (fetchIcon) fetchIcon.style.display = 'none';
    if (fetchLoad) fetchLoad.style.display = 'inline-block';

    try {
        const res = await apiFetch(`${API_BASE}/sim-cards/fetch-remote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider_id: provId, credentials: creds }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to fetch SIMs');
        }
        const remoteSims = await res.json();
        if (!remoteSims.length) {
            showAlert('No active SIM cards found on this account', 'warning');
            return;
        }

        fetchGrp.style.display = 'block';
        sel.innerHTML = '<option value="">— Select Remote SIM to auto-fill —</option>' +
            remoteSims.map((s, idx) => {
                const balPart = s.balance != null ? ` - ${s.balance} ${s.currency || 'EUR'}` : '';
                const dataPart = s.remaining_data_mb != null ? ` [${s.remaining_data_mb} MB left]` : '';
                return `<option value="${idx}">${RoutarioUI.escapeHtml(s.phone_number)}${s.plan_name ? ' (' + RoutarioUI.escapeHtml(s.plan_name) + ')' : ''}${balPart}${dataPart}</option>`;
            }).join('');

        sel.onchange = () => {
            const chosen = remoteSims[parseInt(sel.value)];
            if (chosen) {
                document.getElementById('simPhoneNumber').value = chosen.phone_number || '';
                if (chosen.plan_name) document.getElementById('simPlanName').value = chosen.plan_name;
                if (chosen.balance != null) document.getElementById('simBalance').value = chosen.balance;
                if (chosen.remaining_data_mb != null) document.getElementById('simRemainingDataMb').value = chosen.remaining_data_mb;
                if (chosen.currency) document.getElementById('simCurrency').value = chosen.currency;
                if (chosen.expiry_date) setSimInputDate(chosen.expiry_date);
            }
        };
        showAlert(`Discovered ${remoteSims.length} SIM card(s) from provider.`, 'success');
    } catch (e) {
        showAlert(e.message, 'error');
    } finally {
        if (btn) btn.disabled = false;
        if (fetchText) fetchText.textContent = 'Fetch Remote SIMs';
        if (fetchIcon) fetchIcon.style.display = '';
        if (fetchLoad) fetchLoad.style.display = 'none';
    }
}

async function saveSimCard(event) {
    if (event) event.preventDefault();

    const provId = document.getElementById('simProviderSelect')?.value.trim() || null;
    const phoneNumber = document.getElementById('simPhoneNumber')?.value.trim();
    let accountLabel = document.getElementById('simAccountLabel')?.value.trim();
    const credentials = _getSimCredentialsFromForm();

    if (!phoneNumber) {
        showAlert('Please enter a phone number / MSISDN', 'error');
        return;
    }
    if (!accountLabel) {
        accountLabel = phoneNumber;
    }

    const balRaw = document.getElementById('simBalance')?.value.trim();
    const balance = (balRaw !== '' && balRaw !== undefined && !isNaN(Number(balRaw))) ? parseFloat(balRaw) : null;

    const remDataRaw = document.getElementById('simRemainingDataMb')?.value.trim();
    const remaining_data_mb = (remDataRaw !== '' && remDataRaw !== undefined && !isNaN(Number(remDataRaw))) ? parseFloat(remDataRaw) : null;

    const payload = {
        provider_id: provId,
        account_label: accountLabel,
        credentials: credentials,
        phone_number: phoneNumber,
        plan_name: document.getElementById('simPlanName')?.value.trim() || null,
        balance: balance,
        remaining_data_mb: remaining_data_mb,
        currency: document.getElementById('simCurrency')?.value.trim() || 'EUR',
        expiry_date: getSimInputIso(),
        device_id: parseInt(document.getElementById('simAssignedDevice')?.value) || null,
    };

    if (_simIsAdmin) {
        const compSelVal = document.getElementById('simCompanySelect')?.value;
        payload.company_id = compSelVal ? parseInt(compSelVal, 10) : null;
    }

    const submitBtn = document.getElementById('simSubmitBtn');
    if (submitBtn) submitBtn.disabled = true;

    try {
        let res;
        if (_editingSimCard) {
            res = await apiFetch(`${API_BASE}/sim-cards/${_editingSimCard.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        } else {
            res = await apiFetch(`${API_BASE}/sim-cards`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        }

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to save SIM card');
        }

        showAlert(_editingSimCard ? 'SIM card updated' : 'SIM card created', 'success');
        closeSimCardModal();
        await _loadSimCards();
    } catch (e) {
        showAlert(e.message, 'error');
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}

async function deleteSimCard(simId) {
    if (!confirm('Are you sure you want to delete this SIM card?')) return;
    try {
        const res = await apiFetch(`${API_BASE}/sim-cards/${simId}`, { method: 'DELETE' });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to delete SIM card');
        }
        showAlert('SIM card deleted', 'success');
        if (_editingSimCard && _editingSimCard.id === simId) {
            closeSimCardModal();
        }
        await _loadSimCards();
    } catch (e) {
        showAlert(e.message, 'error');
    }
}

function openSimDatePicker(inputId) {
    const picker = document.getElementById(inputId + 'Picker');
    if (!picker) return;
    const currentIso = getSimInputIso();
    const d = currentIso ? _parseDate(currentIso) : new Date();
    if (d && !isNaN(d.getTime())) {
        picker.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    if (typeof picker.showPicker === 'function') {
        try {
            picker.showPicker();
            return;
        } catch (_) {}
    }
    picker.focus();
    picker.click();
}
window.openSimDatePicker = openSimDatePicker;

document.addEventListener('DOMContentLoaded', () => {
    const pickerEl = document.getElementById('simExpiryDatePicker');
    if (pickerEl) {
        pickerEl.addEventListener('change', () => {
            if (pickerEl.value) {
                setSimInputDate(pickerEl.value);
            }
        });
    }
    const inputEl = document.getElementById('simExpiryDate');
    if (inputEl) {
        inputEl.addEventListener('input', () => {
            inputEl.dataset.iso = '';
        });
        inputEl.addEventListener('change', () => {
            const val = inputEl.value.trim();
            if (val) {
                const parsed = typeof parseUserDateTime === 'function' ? parseUserDateTime(val) : _parseDate(val);
                if (parsed) {
                    setSimInputDate(parsed);
                }
            }
        });
    }
});
