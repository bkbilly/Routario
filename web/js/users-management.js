'use strict';

const _usrIsAdmin        = localStorage.getItem('is_admin') === 'true';
const _usrIsCompanyAdmin = localStorage.getItem('is_company_admin') === 'true';
const _usrMyId           = parseInt(localStorage.getItem('user_id'), 10);

let _usrUsers     = [];
let _usrCompanies = [];
let _usrDevices   = [];
let _usrEditing   = null;
let _usrSortCol   = 'username';
let _usrSortDir   = 1;

let _usrAssignUserId    = null;
let _usrAssignCompanyId = null;
let _usrAssignedDevices = new Set();

document.addEventListener('DOMContentLoaded', async () => {
    if (_usrIsAdmin) await _usrLoadCompanies();
    await Promise.all([_usrLoad(), _usrLoadDevices()]);
});

async function _usrLoad() {
    try {
        const res = await apiFetch(`${API_BASE}/users`);
        if (res.ok) _usrUsers = await res.json();
    } catch (e) { console.error(e); }
    _usrRender();
}

async function _usrLoadDevices() {
    try {
        const res = await apiFetch(`${API_BASE}/devices`);
        if (res.ok) _usrDevices = await res.json();
    } catch (e) { console.error(e); }
}

async function _usrLoadCompanies() {
    try {
        const res = await apiFetch(`${API_BASE}/companies`);
        if (res.ok) _usrCompanies = await res.json();
    } catch (e) { console.error(e); }
}

function _usrRender() {
    const query = (document.getElementById('userSearch')?.value || '').toLowerCase();
    const list  = [..._usrUsers.filter(u =>
        u.username.toLowerCase().includes(query) ||
        u.email.toLowerCase().includes(query)
    )].sort((a, b) => {
        let av, bv;
        switch (_usrSortCol) {
            case 'email':   av = a.email || ''; bv = b.email || ''; break;
            case 'company': av = _usrCompanies.find(c => c.id === a.company_id)?.name || ''; bv = _usrCompanies.find(c => c.id === b.company_id)?.name || ''; break;
            case 'role':    av = a.is_admin ? 0 : a.is_company_admin ? 1 : 2; bv = b.is_admin ? 0 : b.is_company_admin ? 1 : 2;
                            return (av - bv) * _usrSortDir;
            case 'created': av = a.created_at || ''; bv = b.created_at || ''; break;
            default:        av = a.username || ''; bv = b.username || '';
        }
        return av < bv ? -_usrSortDir : av > bv ? _usrSortDir : 0;
    });

    document.getElementById('userCount').textContent = `${list.length} user${list.length !== 1 ? 's' : ''}`;

    const tbody = document.getElementById('usersTableBody');
    if (!list.length) {
        const cols = _usrIsAdmin ? 6 : 5;
        tbody.innerHTML = `<tr><td colspan="${cols}" style="text-align:center;padding:3rem;color:var(--text-muted);">
            <div style="font-size:2.5rem;margin-bottom:0.75rem;">&#128100;</div>No users found</td></tr>`;
        return;
    }

    tbody.innerHTML = list.map(u => {
        const isMe      = u.id === _usrMyId;
        const roleBadge = u.is_admin
            ? `<span class="proto-badge" style="background:rgba(168,85,247,0.15);color:#a855f7;">Super Admin</span>`
            : u.is_company_admin
            ? `<span class="proto-badge" style="background:rgba(59,130,246,0.15);color:var(--accent-primary);">Company Admin</span>`
            : `<span style="color:var(--text-muted);font-size:0.82rem;">User</span>`;
        const companyCell = _usrIsAdmin
            ? `<td style="color:var(--text-secondary);font-size:0.85rem;">${_usrEsc(_usrCompanies.find(c => c.id === u.company_id)?.name || '—')}</td>`
            : '';
        const canImpersonate = !isMe && (
            _usrIsAdmin ||
            (_usrIsCompanyAdmin && !u.is_admin)
        );
        const _sb = 'style="font-size:0.78rem;padding:0.3rem 0.6rem;"';
        const _ib = 'style="font-size:0.78rem;padding:0.3rem 0.45rem;"';
        const impersonateBtn = canImpersonate
            ? `<button class="btn btn-secondary" ${_sb} onclick="usrImpersonate(${u.id})"><i class="mdi mdi-account-switch"></i> Login As</button>`
            : '';
        const assignBtn = !isMe && !u.is_admin && !u.is_company_admin
            ? `<button class="btn btn-secondary" ${_sb} onclick="usrOpenAssignModal(${u.id})"><i class="mdi mdi-devices"></i> Devices</button>`
            : '';

        return `<tr class="device-row" ondblclick="openUserModal(${u.id})" style="cursor:pointer;">
            <td>
                <span class="device-row-name">${_usrEsc(u.username)}</span>
                ${isMe ? `<span style="font-size:0.7rem;color:var(--accent-primary);font-weight:600;margin-left:0.35rem;">YOU</span>` : ''}
            </td>
            <td style="color:var(--text-secondary);font-size:0.85rem;">${_usrEsc(u.email)}</td>
            ${companyCell}
            <td>${roleBadge}</td>
            <td style="color:var(--text-secondary);font-size:0.82rem;white-space:nowrap;">${new Date(u.created_at).toLocaleDateString()}</td>
            <td style="white-space:nowrap;text-align:right;">
                ${assignBtn}
                ${impersonateBtn}
                <button class="btn btn-secondary" ${_ib} onclick="openUserModal(${u.id})" title="Edit"><i class="mdi mdi-pencil"></i></button>
            </td>
        </tr>`;
    }).join('');
}

function filterUsers() { _usrRender(); }

function sortUsers(col) {
    if (_usrSortCol === col) _usrSortDir = -_usrSortDir;
    else { _usrSortCol = col; _usrSortDir = 1; }
    document.querySelectorAll('#section-users .devices-table th[data-sort]').forEach(th => {
        th.dataset.sortDir = th.dataset.sort === col ? (_usrSortDir === 1 ? 'asc' : 'desc') : '';
    });
    _usrRender();
}

// ── User Modal ────────────────────────────────────────────────────

function openUserModal(userId = null) {
    _usrEditing = userId ? _usrUsers.find(u => u.id === userId) : null;
    const isNew = !_usrEditing;

    document.getElementById('userModalTitle').textContent = isNew ? 'Add User' : 'Edit User';

    const usernameEl = document.getElementById('userModalUsername');
    usernameEl.value    = _usrEditing?.username || '';
    usernameEl.readOnly = !isNew;
    usernameEl.style.opacity = isNew ? '' : '0.6';

    document.getElementById('userModalEmail').value    = _usrEditing?.email || '';
    document.getElementById('userModalPassword').value = '';
    document.getElementById('userPasswordLabel').textContent = isNew ? 'Password *' : 'Password (leave blank to keep)';
    document.getElementById('userModalUnits').value = _usrEditing?.units || 'metric';

    const roleSelect = document.getElementById('userModalRole');
    roleSelect.innerHTML = _usrIsAdmin
        ? `<option value="user">User</option>
           <option value="company_admin">Company Admin</option>
           <option value="admin">Super Admin</option>`
        : `<option value="user">User</option>
           <option value="company_admin">Company Admin</option>`;
    if (_usrEditing) {
        roleSelect.value = _usrEditing.is_admin ? 'admin' : _usrEditing.is_company_admin ? 'company_admin' : 'user';
    }
    const isMe = _usrEditing?.id === _usrMyId;
    roleSelect.disabled = isMe;
    roleSelect.style.opacity = isMe ? '0.6' : '';

    if (_usrIsAdmin) {
        const sel = document.getElementById('userModalCompany');
        sel.innerHTML = '<option value="">— Select company —</option>';
        _usrCompanies.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.name;
            if (c.id === _usrEditing?.company_id) opt.selected = true;
            sel.appendChild(opt);
        });
    }
    onUserRoleChange();

    document.getElementById('userDeleteBtn').style.display =
        (isNew || _usrEditing?.id === _usrMyId) ? 'none' : 'inline-flex';
    document.getElementById('userModal').classList.add('active');
}

function onUserRoleChange() {
    if (!_usrIsAdmin) return;
    const role = document.getElementById('userModalRole').value;
    const group = document.getElementById('userModalCompanyGroup');
    if (group) group.style.display = role === 'admin' ? 'none' : '';
}

function closeUserModal() {
    document.getElementById('userModal').classList.remove('active');
    _usrEditing = null;
}

async function saveUser() {
    const username = document.getElementById('userModalUsername').value.trim();
    const email    = document.getElementById('userModalEmail').value.trim();
    const password = document.getElementById('userModalPassword').value;
    const role     = document.getElementById('userModalRole').value;
    const isNew    = !_usrEditing;

    if (isNew && !username) { document.getElementById('userModalUsername').focus(); return; }
    if (!email)             { document.getElementById('userModalEmail').focus();    return; }
    if (isNew && !password) { document.getElementById('userModalPassword').focus(); return; }

    let companyId = null;
    if (_usrIsAdmin && role !== 'admin') {
        companyId = parseInt(document.getElementById('userModalCompany')?.value) || null;
        if (!companyId) { document.getElementById('userModalCompany').focus(); return; }
    }

    const isMe = !isNew && _usrEditing?.id === _usrMyId;
    const units = document.getElementById('userModalUnits').value;
    const payload = {
        email,
        units,
        ...(!isMe && { is_admin: role === 'admin', is_company_admin: role === 'company_admin' }),
        company_id: companyId,
    };
    if (password) payload.password = password;
    if (isNew)    payload.username = username;

    const btn = document.getElementById('userSaveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
        const res = await apiFetch(
            isNew ? `${API_BASE}/users` : `${API_BASE}/users/${_usrEditing.id}`,
            { method: isNew ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
        );
        if (!res.ok) throw new Error((await res.json()).detail || 'Save failed');
        closeUserModal();
        await _usrLoad();
    } catch (e) {
        alert(e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save';
    }
}

async function usrDelete(userId) {
    const u = _usrUsers.find(u => u.id === userId);
    if (!u || !confirm(`Delete user "${u.username}"?`)) return;
    try {
        const res = await apiFetch(`${API_BASE}/users/${userId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).detail || 'Delete failed');
        if (_usrEditing?.id === userId) closeUserModal();
        await _usrLoad();
    } catch (e) { alert(e.message); }
}

async function usrImpersonate(userId) {
    const u = _usrUsers.find(u => u.id === userId);
    if (!u || !confirm(`Login as "${u.username}"? You can return to your admin account from the dashboard.`)) return;
    try {
        const res = await apiFetch(`${API_BASE}/users/${userId}/impersonate`, { method: 'POST' });
        if (!res.ok) throw new Error((await res.json()).detail || 'Impersonation failed');
        const data = await res.json();
        localStorage.setItem('impersonating_admin_token',    localStorage.getItem('auth_token'));
        localStorage.setItem('impersonating_admin_user_id',  localStorage.getItem('user_id'));
        localStorage.setItem('impersonating_admin_username', localStorage.getItem('username'));
        localStorage.setItem('auth_token',       data.access_token);
        localStorage.setItem('user_id',          data.user_id);
        localStorage.setItem('username',         data.username);
        localStorage.setItem('is_admin',         data.is_admin);
        localStorage.setItem('is_company_admin', data.is_company_admin || false);
        localStorage.setItem('company_id',       data.company_id ?? '');
        window.location.href = 'gps-dashboard.html';
    } catch (e) { alert(e.message); }
}

// ── Device Assignment ─────────────────────────────────────────────

async function usrOpenAssignModal(userId) {
    const u = _usrUsers.find(u => u.id === userId);
    if (!u) return;
    _usrAssignUserId    = userId;
    _usrAssignCompanyId = u.company_id || null;
    document.getElementById('userAssignName').textContent = u.username;
    document.getElementById('userDeviceSearch').value = '';
    try {
        const res = await apiFetch(`${API_BASE}/users/${userId}/devices`);
        if (res.ok) _usrAssignedDevices = new Set((await res.json()).map(d => d.id));
    } catch (e) { console.error(e); }
    _usrRenderAssignList();
    document.getElementById('userAssignModal').classList.add('active');
}

function usrCloseAssignModal() {
    document.getElementById('userAssignModal').classList.remove('active');
    _usrAssignUserId = null;
    _usrAssignCompanyId = null;
}

function _usrRenderAssignList() {
    const search  = (document.getElementById('userDeviceSearch')?.value || '').toLowerCase();
    const devices = _usrDevices
        .filter(d => !_usrAssignCompanyId || d.company_id === _usrAssignCompanyId)
        .filter(d => d.name.toLowerCase().includes(search) || (d.imei || '').toLowerCase().includes(search));
    const list = document.getElementById('userDeviceAssignList');
    if (!devices.length) {
        list.innerHTML = `<div style="color:var(--text-muted);font-size:0.875rem;padding:0.5rem 0;">No devices found.</div>`;
        return;
    }
    list.innerHTML = devices.map(d => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:0.6rem 0.75rem;background:var(--bg-tertiary);border-radius:8px;gap:0.75rem;">
            <div style="min-width:0;">
                <div style="font-weight:500;font-size:0.875rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_usrEsc(d.name)}</div>
                <div style="font-size:0.78rem;color:var(--text-muted);font-family:var(--font-mono);">${_usrEsc(d.imei || '')}</div>
            </div>
            <label class="toggle-switch">
                <input type="checkbox" ${_usrAssignedDevices.has(d.id) ? 'checked' : ''}
                    onchange="_usrToggleAssignment(${d.id}, this.checked)">
                <span class="toggle-slider"></span>
            </label>
        </div>`).join('');
}

function usrFilterDeviceList() { _usrRenderAssignList(); }

async function _usrToggleAssignment(deviceId, assign) {
    const action = assign ? 'add' : 'remove';
    try {
        const res = await apiFetch(`${API_BASE}/users/${_usrAssignUserId}/devices?device_id=${deviceId}&action=${action}`, { method: 'POST' });
        if (res.ok) {
            if (assign) _usrAssignedDevices.add(deviceId);
            else        _usrAssignedDevices.delete(deviceId);
        } else {
            _usrRenderAssignList();
        }
    } catch (e) { console.error(e); _usrRenderAssignList(); }
}

// ── Notify User ───────────────────────────────────────────────────

let _usrNotifySelected = new Set();

function usrOpenNotifyModal(userId = null) {
    _usrNotifySelected = userId ? new Set([userId]) : new Set();
    document.getElementById('userNotifySearch').value  = '';
    document.getElementById('userNotifyTitle').value   = '';
    document.getElementById('userNotifyMessage').value = '';
    _usrRenderNotifyList();
    _usrUpdateNotifyCount();
    document.getElementById('userNotifyModal').classList.add('active');
}

function usrCloseNotifyModal() {
    document.getElementById('userNotifyModal').classList.remove('active');
}

function usrFilterNotifyUsers() {
    _usrRenderNotifyList(document.getElementById('userNotifySearch').value.trim());
}

function _usrRenderNotifyList(filter = '') {
    const lower      = filter.toLowerCase();
    const candidates = _usrUsers;
    const filtered   = lower
        ? candidates.filter(u => u.username.toLowerCase().includes(lower) || (u.email || '').toLowerCase().includes(lower))
        : candidates;

    const list = document.getElementById('userNotifyList');
    if (!filtered.length) {
        list.innerHTML = `<div style="color:var(--text-muted);font-size:0.875rem;padding:0.35rem 0;">No users found.</div>`;
        return;
    }

    const allChecked = filtered.every(u => _usrNotifySelected.has(u.id));
    list.innerHTML = `
        <label style="display:flex;align-items:center;gap:0.5rem;padding:0.4rem 0.6rem;border-radius:6px;cursor:pointer;border-bottom:1px solid var(--border-color);margin-bottom:0.2rem;">
            <input type="checkbox" id="usrNotifySelectAll" ${allChecked ? 'checked' : ''} onchange="_usrToggleSelectAll(this.checked)" style="accent-color:var(--accent-primary);">
            <span style="font-size:0.82rem;color:var(--text-muted);">Select all${filtered.length < candidates.length ? ` filtered (${filtered.length})` : ` (${filtered.length})`}</span>
        </label>
        ${filtered.map(u => `
        <label style="display:flex;align-items:center;gap:0.5rem;padding:0.35rem 0.6rem;border-radius:6px;cursor:pointer;">
            <input type="checkbox" class="usrNotifyCb" value="${u.id}" ${_usrNotifySelected.has(u.id) ? 'checked' : ''} onchange="_usrOnNotifyCbChange(this)" style="accent-color:var(--accent-primary);flex-shrink:0;">
            <div>
                <div style="font-size:0.875rem;font-weight:500;">${_usrEsc(u.username)}${u.id === _usrMyId ? `<span style="font-size:0.7rem;color:var(--accent-primary);font-weight:600;margin-left:0.35rem;">YOU</span>` : ''}</div>
                <div style="font-size:0.75rem;color:var(--text-muted);">${_usrEsc(u.email)}</div>
            </div>
        </label>`).join('')}`;
}

function _usrOnNotifyCbChange(cb) {
    const id = parseInt(cb.value);
    cb.checked ? _usrNotifySelected.add(id) : _usrNotifySelected.delete(id);
    _usrUpdateSelectAllState();
    _usrUpdateNotifyCount();
}

function _usrToggleSelectAll(checked) {
    document.querySelectorAll('.usrNotifyCb').forEach(cb => {
        cb.checked = checked;
        const id = parseInt(cb.value);
        checked ? _usrNotifySelected.add(id) : _usrNotifySelected.delete(id);
    });
    _usrUpdateNotifyCount();
}

function _usrUpdateSelectAllState() {
    const all      = document.querySelectorAll('.usrNotifyCb');
    const nChecked = [...all].filter(cb => cb.checked).length;
    const sel      = document.getElementById('usrNotifySelectAll');
    if (!sel) return;
    sel.indeterminate = nChecked > 0 && nChecked < all.length;
    sel.checked       = all.length > 0 && nChecked === all.length;
}

function _usrUpdateNotifyCount() {
    const el = document.getElementById('userNotifyCount');
    if (!el) return;
    const n = _usrNotifySelected.size;
    el.textContent = n > 0 ? `${n} selected` : '';
}

async function usrSendNotification() {
    const title   = document.getElementById('userNotifyTitle').value.trim();
    const message = document.getElementById('userNotifyMessage').value.trim();
    const userIds = [..._usrNotifySelected];
    if (!userIds.length) { alert('Select at least one recipient.'); return; }
    if (!title || !message) return;
    const btn = document.getElementById('userNotifySendBtn');
    btn.disabled    = true;
    btn.textContent = 'Sending…';
    try {
        const results = await Promise.all(userIds.map(id =>
            apiFetch(`${API_BASE}/users/${id}/notify`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ title, message }),
            }).then(r => r.json()).catch(() => ({ error: true }))
        ));
        const failed = results.filter(r => r.error).length;
        if (failed) alert(`Sent to ${userIds.length - failed} user(s). ${failed} failed.`);
        usrCloseNotifyModal();
    } catch (e) { alert(e.message); }
    finally {
        btn.disabled    = false;
        btn.textContent = 'Send';
    }
}

function _usrEsc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
