// ================================================================
//  company-management.js
// ================================================================

let companies    = [];
let cmpAllCompanies = [];
let cmpAllUsers     = [];
let cmpAllDevices   = [];
let cmpBillingPlans = [];

let companySortCol         = 'name';
let companySortDir         = 1;

let editingCompanyId       = null;
let companyUserIds         = new Set();
let companyDeviceIds       = new Set();
let companyAdminUserIds    = new Set();

function formatDate(str) {
    if (!str) return '—';
    if (!str.includes('Z') && !str.includes('+')) str += 'Z';
    return new Date(str).toLocaleDateString();
}

let _cmpSectionInitialized = false;

async function initCompanySection() {
    if (_cmpSectionInitialized) return;
    _cmpSectionInitialized = true;
    if (localStorage.getItem('is_admin') !== 'true') return;
    await Promise.all([loadCompanies(), loadAllUsers(), loadAllDevices(), loadCompanyBillingPlans()]);
}

// ── Loaders ───────────────────────────────────────────────────────

async function loadCompanies() {
    try {
        const res = await apiFetch(`${API_BASE}/companies`);
        if (!res.ok) throw new Error(`${res.status}`);
        companies    = await res.json();
        cmpAllCompanies = [...companies];
        filterCompanies();
    } catch (e) {
        showAlert('Failed to load companies', 'error');
        console.error(e);
    }
}

async function loadAllUsers() {
    try {
        const res = await apiFetch(`${API_BASE}/users`);
        if (res.ok) cmpAllUsers = (await res.json()).filter(u => !u.is_admin);
    } catch (e) { console.error(e); }
}

async function loadAllDevices() {
    try {
        const res = await apiFetch(`${API_BASE}/devices/all`);
        if (res.ok) cmpAllDevices = await res.json();
    } catch (e) { console.error(e); }
}

async function loadCompanyBillingPlans() {
    try {
        const res = await apiFetch(`${API_BASE}/billing/plans`);
        if (res.ok) cmpBillingPlans = await res.json();
    } catch (e) { console.error(e); }
}

// ── Table ─────────────────────────────────────────────────────────

function sortCompanies(col) {
    if (companySortCol === col) {
        companySortDir = -companySortDir;
    } else {
        companySortCol = col;
        companySortDir = 1;
    }
    updateCompanySortHeaders();
    filterCompanies();
}

function updateCompanySortHeaders() {
    document.querySelectorAll('.company-table th[data-sort]').forEach(th => {
        th.dataset.sortDir = th.dataset.sort === companySortCol
            ? (companySortDir === 1 ? 'asc' : 'desc') : '';
    });
}

function _companySortValue(c, col) {
    switch (col) {
        case 'name':    return (c.name || '').toLowerCase();
        case 'users':   return c.user_count ?? -Infinity;
        case 'devices': return c.device_count ?? -Infinity;
        case 'billing': return (_companyBillingPlanName(c) || '').toLowerCase();
        case 'created': return c.created_at ? new Date(c.created_at).getTime() : -Infinity;
        default:        return '';
    }
}

function _companyBillingPlanName(company) {
    return cmpBillingPlans.find(p => Number(p.id) === Number(company.billing_plan_id))?.name || '';
}

function filterCompanies() {
    const q = (document.getElementById('companySearch').value || '').toLowerCase().trim();
    const filtered = q ? cmpAllCompanies.filter(c => c.name.toLowerCase().includes(q)) : cmpAllCompanies;
    const sorted = [...filtered].sort((a, b) => {
        const av = _companySortValue(a, companySortCol);
        const bv = _companySortValue(b, companySortCol);
        if (av < bv) return -companySortDir;
        if (av > bv) return companySortDir;
        return 0;
    });
    renderTable(sorted);
}

function renderTable(list) {
    const tbody = document.getElementById('companiesTableBody');
    const count = document.getElementById('companiesCount');
    count.textContent = `${list.length} compan${list.length !== 1 ? 'ies' : 'y'}`;

    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:3rem;color:var(--text-muted);">
            <div style="font-size:2.5rem;margin-bottom:0.75rem;">&#127970;</div>No companies found</td></tr>`;
        return;
    }

    tbody.innerHTML = list.map(c => `
        <tr class="device-row" ondblclick="openEditModal(${c.id})" style="cursor:pointer;">
            <td><span class="device-row-name">${_esc(c.name)}</span></td>
            <td style="text-align:center;font-family:var(--font-mono);">${c.user_count ?? 0}</td>
            <td style="text-align:center;font-family:var(--font-mono);">${c.device_count ?? 0}</td>
            <td>${c.billing_plan_id ? `<span class="proto-badge">${_esc(_companyBillingPlanName(c) || 'Assigned')}</span>` : '<span style="color:var(--text-muted);">No active plan</span>'}</td>
            <td style="font-size:0.85rem;color:var(--text-secondary);">${formatDate(c.created_at)}</td>
            <td style="text-align:right;white-space:nowrap;">
                <button class="btn btn-secondary tbl-btn" onclick="openEditModal(${c.id})"><i class="mdi mdi-pencil"></i> Edit</button>
            </td>
        </tr>`).join('');
}

// ── Modal ─────────────────────────────────────────────────────────

function switchTab(tabId, btn) {
    const modal = document.getElementById('companyModal');
    modal.querySelectorAll('.modal-tab-content').forEach(el => el.classList.remove('active'));
    modal.querySelectorAll('.modal-tab').forEach(el => el.classList.remove('active'));
    document.getElementById(`tab-cmp-${tabId}`)?.classList.add('active');
    (btn || modal.querySelector(`.modal-tab[data-tab="cmp-${tabId}"]`))?.classList.add('active');
    if (tabId === 'users')   renderUserTab();
    if (tabId === 'devices') renderDeviceTab();
}

function openAddCompanyModal() {
    editingCompanyId = null;
    document.getElementById('cmpModalTitle').textContent     = 'Add Company';
    document.getElementById('companyName').value          = '';
    document.getElementById('companyAppName').value       = '';
    document.getElementById('companyLoginSlug').value     = '';
    updateBrandingPreview(null);
    document.getElementById('deleteCompanyBtn').style.display = 'none';
    document.getElementById('cmpUsersTabBtn').style.display  = 'none';
    document.getElementById('cmpDevicesTabBtn').style.display = 'none';
    document.getElementById('companyBrandingControls').style.display = 'none';
    switchTab('general');
    document.getElementById('companyModal').classList.add('active');
}

async function openEditModal(companyId) {
    editingCompanyId = companyId;
    const c = companies.find(x => x.id === companyId);
    if (!c) return;

    document.getElementById('cmpModalTitle').textContent     = `Edit — ${c.name}`;
    document.getElementById('companyName').value          = c.name;
    document.getElementById('companyAppName').value       = c.app_name || '';
    document.getElementById('companyLoginSlug').value     = c.login_slug || '';
    updateBrandingPreview(c);
    document.getElementById('deleteCompanyBtn').style.display = 'inline-flex';
    document.getElementById('cmpUsersTabBtn').style.display  = '';
    document.getElementById('cmpDevicesTabBtn').style.display = '';
    document.getElementById('companyBrandingControls').style.display = '';

    // Load current company memberships
    const [userRes, deviceRes] = await Promise.all([
        apiFetch(`${API_BASE}/companies/${companyId}/users`),
        apiFetch(`${API_BASE}/companies/${companyId}/devices`),
    ]);
    if (userRes.ok) {
        const users = await userRes.json();
        companyUserIds      = new Set(users.map(u => u.id));
        companyAdminUserIds = new Set(users.filter(u => u.is_company_admin).map(u => u.id));
    }
    if (deviceRes.ok) {
        const devices = await deviceRes.json();
        companyDeviceIds = new Set(devices.map(d => d.id));
    }

    switchTab('general');
    document.getElementById('companyModal').classList.add('active');
}

function closeCompanyModal() {
    document.getElementById('companyModal').classList.remove('active');
}

// ── Save / Delete ─────────────────────────────────────────────────

async function saveCompany() {
    const name = document.getElementById('companyName').value.trim();
    const appName = document.getElementById('companyAppName').value.trim();
    const loginSlug = document.getElementById('companyLoginSlug').value.trim().toLowerCase();
    if (!name) { showAlert('Company name is required', 'error'); return; }

    const saveBtn  = document.getElementById('saveCompanyBtn');
    const saveText = document.getElementById('saveText');
    const saveLoad = document.getElementById('saveLoading');
    saveBtn.disabled       = true;
    saveText.style.display = 'none';
    saveLoad.style.display = 'inline-block';

    try {
        const url    = editingCompanyId ? `${API_BASE}/companies/${editingCompanyId}` : `${API_BASE}/companies`;
        const method = editingCompanyId ? 'PUT' : 'POST';
        const res = await apiFetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, app_name: appName || null, login_slug: loginSlug || null }),
        });
        if (res.ok) {
            showAlert(editingCompanyId ? 'Company updated' : 'Company created', 'success');
            const saved = await res.json();
            if (saved?.id === parseInt(localStorage.getItem('company_id') || '0', 10)) applyCompanyBranding(saved.id);
            closeCompanyModal();
            await loadCompanies();
        } else {
            const err = await res.json();
            showAlert(err.detail || 'Failed to save', 'error');
        }
    } catch (e) { showAlert('Error saving company', 'error'); }
    finally {
        saveBtn.disabled       = false;
        saveText.style.display = 'inline';
        saveLoad.style.display = 'none';
    }
}

function updateBrandingPreview(company) {
    const version = company?.branding_version || 1;
    const iconPreview = document.getElementById('companyIconPreview');
    const badgePreview = document.getElementById('companyBadgePreview');
    if (iconPreview) {
        iconPreview.src = company?.icon_url
            ? `${company.icon_url}${company.icon_url.includes('?') ? '&' : '?'}preview=${version}`
            : '/icons/icon-192.png';
    }
    if (badgePreview) {
        badgePreview.src = company?.badge_url
            ? `${company.badge_url}${company.badge_url.includes('?') ? '&' : '?'}preview=${version}`
            : '/icons/badge-96.png';
    }
}

async function uploadCompanyBranding(kind) {
    if (!editingCompanyId) return;
    const input = document.getElementById(kind === 'badge' ? 'companyBadgeFile' : 'companyIconFile');
    const file = input?.files?.[0];
    if (!file) return;

    const form = new FormData();
    form.append('file', file);
    try {
        const res = await apiFetch(`${API_BASE}/companies/${editingCompanyId}/branding/${kind}`, {
            method: 'POST',
            body: form,
        });
        input.value = '';
        if (!res.ok) {
            const err = await res.json();
            showAlert(err.detail || 'Failed to upload image', 'error');
            return;
        }
        const updated = await res.json();
        companies = companies.map(c => c.id === updated.id ? { ...c, ...updated } : c);
        cmpAllCompanies = cmpAllCompanies.map(c => c.id === updated.id ? { ...c, ...updated } : c);
        updateBrandingPreview(updated);
        if (updated.id === parseInt(localStorage.getItem('company_id') || '0', 10)) applyCompanyBranding(updated.id);
        showAlert(kind === 'badge' ? 'Badge updated' : 'App icon updated', 'success');
    } catch (e) {
        showAlert('Error uploading image', 'error');
    }
}

async function resetCompanyBranding(kind) {
    if (!editingCompanyId) return;
    try {
        const res = await apiFetch(`${API_BASE}/companies/${editingCompanyId}/branding/${kind}`, { method: 'DELETE' });
        if (!res.ok) {
            const err = await res.json();
            showAlert(err.detail || 'Failed to reset image', 'error');
            return;
        }
        const updated = await res.json();
        companies = companies.map(c => c.id === updated.id ? { ...c, ...updated } : c);
        cmpAllCompanies = cmpAllCompanies.map(c => c.id === updated.id ? { ...c, ...updated } : c);
        updateBrandingPreview(updated);
        if (updated.id === parseInt(localStorage.getItem('company_id') || '0', 10)) applyCompanyBranding(updated.id);
        showAlert(kind === 'badge' ? 'Badge reset to default' : 'App icon reset to default', 'success');
    } catch (e) {
        showAlert('Error resetting image', 'error');
    }
}

async function deleteCurrentCompany() {
    if (!editingCompanyId) return;
    const c = companies.find(x => x.id === editingCompanyId);
    if (!confirm(`Delete company "${c?.name || ''}"?\n\nUsers and devices will be unlinked but not deleted.`)) return;
    try {
        const res = await apiFetch(`${API_BASE}/companies/${editingCompanyId}`, { method: 'DELETE' });
        if (res.ok) {
            showAlert('Company deleted', 'success');
            closeCompanyModal();
            await loadCompanies();
        } else {
            const err = await res.json();
            showAlert(err.detail || 'Failed to delete', 'error');
        }
    } catch (e) { showAlert('Error deleting company', 'error'); }
}

async function confirmDelete(companyId, name) {
    if (!confirm(`Delete company "${name}"?\n\nUsers and devices will be unlinked but not deleted.`)) return;
    try {
        const res = await apiFetch(`${API_BASE}/companies/${companyId}`, { method: 'DELETE' });
        if (res.ok) {
            showAlert('Company deleted', 'success');
            await loadCompanies();
        } else {
            const err = await res.json();
            showAlert(err.detail || 'Failed to delete', 'error');
        }
    } catch (e) { showAlert('Error deleting company', 'error'); }
}

// ── Users Tab ─────────────────────────────────────────────────────

function filterUserTab() { renderUserTab(); }

function renderUserTab() {
    const list  = document.getElementById('userTabList');
    const query = (document.getElementById('userTabSearch')?.value || '').toLowerCase().trim();
    const filtered = cmpAllUsers.filter(u =>
        !query ||
        (u.username || '').toLowerCase().includes(query) ||
        (u.email    || '').toLowerCase().includes(query)
    );
    if (!filtered.length) {
        list.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted);">No users found.</div>';
        return;
    }
    list.innerHTML = '';
    filtered.forEach(u => {
        const inCompany  = companyUserIds.has(u.id);
        const isCoAdmin  = companyAdminUserIds.has(u.id);
        const div = document.createElement('div');
        div.className = 'co-user-row';
        div.innerHTML = `
            <div class="co-user-info">
                <div class="co-user-name">${_esc(u.username)}</div>
                <div class="co-user-email">${_esc(u.email || '')}</div>
            </div>
            <div class="co-user-actions">
                <button type="button"
                    class="co-admin-pill${isCoAdmin && inCompany ? ' active' : ''}"
                    ${!inCompany ? 'disabled' : ''}
                    onclick="toggleCompanyAdmin(${u.id}, ${!(isCoAdmin && inCompany)})"
                    title="${isCoAdmin && inCompany ? 'Revoke company admin' : 'Make company admin'}">
                    Company Admin
                </button>
                <label class="toggle-switch">
                    <input type="checkbox" ${inCompany ? 'checked' : ''}
                        onchange="toggleUserMembership(${u.id}, this.checked)">
                    <span class="toggle-slider"></span>
                </label>
            </div>`;
        list.appendChild(div);
    });
}

async function toggleUserMembership(userId, add) {
    const action = add ? 'add' : 'remove';
    try {
        const res = await apiFetch(
            `${API_BASE}/companies/${editingCompanyId}/users?user_id=${userId}&action=${action}`,
            { method: 'POST' }
        );
        if (res.ok) {
            if (add) companyUserIds.add(userId);
            else { companyUserIds.delete(userId); companyAdminUserIds.delete(userId); }
            renderUserTab();
        } else {
            showAlert('Failed to update membership', 'error');
            renderUserTab();
        }
    } catch (e) { showAlert('Error updating membership', 'error'); renderUserTab(); }
}

async function toggleCompanyAdmin(userId, makeAdmin) {
    try {
        const res = await apiFetch(`${API_BASE}/users/${userId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_company_admin: makeAdmin }),
        });
        if (res.ok) {
            if (makeAdmin) companyAdminUserIds.add(userId);
            else companyAdminUserIds.delete(userId);
            renderUserTab();
        } else {
            showAlert('Failed to update admin status', 'error');
            renderUserTab();
        }
    } catch (e) { showAlert('Error updating admin status', 'error'); renderUserTab(); }
}

// ── Devices Tab ───────────────────────────────────────────────────

function filterDeviceTab() { renderDeviceTab(); }

function renderDeviceTab() {
    const list  = document.getElementById('deviceTabList');
    const query = (document.getElementById('deviceTabSearch')?.value || '').toLowerCase().trim();
    const filtered = cmpAllDevices.filter(d =>
        !query ||
        (d.name          || '').toLowerCase().includes(query) ||
        (d.imei          || '').toLowerCase().includes(query) ||
        (d.license_plate || '').toLowerCase().includes(query)
    );
    if (!filtered.length) {
        list.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted);">No devices found.</div>';
        return;
    }
    list.innerHTML = '';
    filtered.forEach(d => {
        const inCompany = companyDeviceIds.has(d.id);
        const div = document.createElement('div');
        div.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:0.6rem 0.8rem;background:var(--bg-tertiary);border-radius:8px;gap:0.75rem;';
        div.innerHTML = `
            <div style="flex:1;min-width:0;">
                <div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(d.name)}</div>
                <div style="font-size:0.8rem;color:var(--text-muted);font-family:var(--font-mono);">${_esc(d.imei)}${d.license_plate ? ' · ' + _esc(d.license_plate) : ''}</div>
            </div>
            <label class="toggle-switch" style="flex-shrink:0;">
                <input type="checkbox" ${inCompany ? 'checked' : ''}
                    onchange="toggleDeviceMembership(${d.id}, this.checked)">
                <span class="toggle-slider"></span>
            </label>`;
        list.appendChild(div);
    });
}

async function toggleDeviceMembership(deviceId, add) {
    const action = add ? 'add' : 'remove';
    try {
        const res = await apiFetch(
            `${API_BASE}/companies/${editingCompanyId}/devices?device_id=${deviceId}&action=${action}`,
            { method: 'POST' }
        );
        if (res.ok) {
            if (add) companyDeviceIds.add(deviceId);
            else companyDeviceIds.delete(deviceId);
            renderDeviceTab();
        } else {
            showAlert('Failed to update device assignment', 'error');
            renderDeviceTab();
        }
    } catch (e) { showAlert('Error updating device assignment', 'error'); renderDeviceTab(); }
}

// ── Toast ─────────────────────────────────────────────────────────
