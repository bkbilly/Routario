'use strict';

const _usrIsAdmin        = localStorage.getItem('is_admin') === 'true';
const _usrIsCompanyAdmin = localStorage.getItem('is_company_admin') === 'true';
const _usrMyId           = parseInt(localStorage.getItem('user_id'), 10);

let _usrUsers     = [];
let _usrCompanies = [];
let _usrDevices   = [];
let _usrEditing   = null;
let _usrMfaSetupPending = false;
let _usrPasskeys = [];
let _usrSortCol   = 'username';
let _usrSortDir   = 1;

let _usrAssignUserId    = null;
let _usrAssignCompanyId = null;
let _usrAssignedDevices = new Set();

// Permission groups definition (mirrors backend PERMISSION_GROUPS)
const PERMISSION_GROUPS = [
    { label: 'Devices & Integrations', perms: [['view_devices','View Devices'],['edit_devices','Edit Devices'],['send_commands','Send Commands'],['manage_integrations','Manage Integrations']] },
    { label: 'Monitoring & Reports', perms: [['manage_alerts','Manage Alerts'],['manage_geofences','Manage Geofences'],['view_history','View History'],['view_reports','View Reports']] },
    { label: 'Fleet Operations', perms: [['manage_drivers','Manage Drivers'],['manage_fuel','Manage Fuel'],['manage_maintenance','Manage Maintenance'],['manage_logbook','Manage Logbook'],['manage_routes','Manage Routes']] },
    { label: 'Communication & Sharing', perms: [['voice_ptt','Voice PTT'],['live_share','Live Share']] },
    { label: 'Administration', perms: [['view_management','View Management'],['manage_users','Manage Users'],['view_audit','View Audit Log'],['view_health','View Health Checks']] },
    { label: 'Account Tools', perms: [['manage_api_keys','Manage API Keys'],['manage_mfa',"Manage Users' MFA"],['manage_backups','Backup & Restore']] },
];
const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap(g => g.perms.map(p => p[0]));

let _usrSectionInitialized = false;

async function initUsersSection() {
    if (_usrSectionInitialized) return;
    _usrSectionInitialized = true;
    if (!hasPermission('manage_users')) return;
    if (_usrIsAdmin) await _usrLoadCompanies();
    await Promise.all([_usrLoad(), _usrLoadDevices()]);
}

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

/** Return the set of permissions the currently-logged-in user can grant. */
function _callerPermissions() {
    if (_usrIsAdmin) return new Set(ALL_PERMISSIONS);
    const me = _usrUsers.find(u => u.id === _usrMyId);
    return new Set((me?.permissions || []).filter(p => ALL_PERMISSIONS.includes(p)));
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
        tbody.innerHTML = RoutarioTables.stateRow('<div style="font-size:2.5rem;margin-bottom:0.75rem;">&#128100;</div>No users found', cols, { padding: '3rem' });
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
    ({ col: _usrSortCol, dir: _usrSortDir } = RoutarioTables.toggleNumericSort(_usrSortCol, _usrSortDir, col));
    RoutarioTables.updateSortHeaders('#section-users, #settings-section-users', {
        col,
        dir: _usrSortDir === 1 ? 'asc' : 'desc',
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
    usrRenderCurrencyOptions(_usrEditing?.currency || 'EUR');
    document.getElementById('userModalCurrency').value = _usrEditing?.currency || 'EUR';

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
    _usrRenderPermissions();
    usrInitMfaPanel();
    usrInitPasskeysPanel();

    document.getElementById('userDeleteBtn').style.display =
        (isNew || _usrEditing?.id === _usrMyId) ? 'none' : 'inline-flex';
    document.getElementById('userModal').classList.add('active');
}

function usrRenderCurrencyOptions(selected = 'EUR') {
    const select = document.getElementById('userModalCurrency');
    if (!select) return;
    const options = typeof CURRENCY_OPTIONS !== 'undefined' ? CURRENCY_OPTIONS : [['EUR', 'Euro (€)']];
    select.innerHTML = options.map(([code, label]) => `<option value="${code}" ${code === selected ? 'selected' : ''}>${label}</option>`).join('');
}

window.addEventListener('routario:currencyrateschange', () => {
    const select = document.getElementById('userModalCurrency');
    if (select) usrRenderCurrencyOptions(select.value || 'EUR');
});

function _usrRenderPermissions() {
    const container = document.getElementById('userModalPermissions');
    const hintEl    = document.getElementById('userModalPermHint');
    const role      = document.getElementById('userModalRole')?.value;

    const fieldsCol = document.getElementById('userModalBody')?.firstElementChild;
    // Super admins have implicit full access — no checklist needed
    if (role === 'admin') {
        document.getElementById('userModalPermissionsGroup').style.display = 'none';
        if (fieldsCol) fieldsCol.style.gridColumn = '1 / -1';
        return;
    }
    document.getElementById('userModalPermissionsGroup').style.display = '';
    if (fieldsCol) fieldsCol.style.gridColumn = '';

    const callerPerms   = _callerPermissions();
    const editPerms     = new Set((_usrEditing?.permissions || (_usrEditing ? [] : [...callerPerms])).filter(p => ALL_PERMISSIONS.includes(p)));
    const isEditingSelf = !_usrIsAdmin && _usrEditing?.id === _usrMyId;

    if (_usrIsAdmin) {
        hintEl.textContent = '';
    } else if (isEditingSelf) {
        hintEl.textContent = 'Your permissions are managed by your administrator';
    } else {
        hintEl.textContent = 'Limited to your own permissions';
    }

    // Permissions that don't apply to regular users
    const adminOnlyPerms = new Set(['manage_users', 'edit_devices', 'manage_integrations', 'view_management', 'manage_routes', 'view_audit', 'view_health', 'manage_mfa', 'manage_backups']);
    const isUserRole = role === 'user';

    container.innerHTML = PERMISSION_GROUPS.map(group => {
        const rows = group.perms
            .filter(([key]) => !(isUserRole && adminOnlyPerms.has(key)))
            .map(([key, label]) => {
                const canGrant  = callerPerms.has(key) && !isEditingSelf;
                const isChecked = editPerms.has(key);
                const disabled  = !canGrant ? 'disabled' : '';
                const opacity   = !canGrant ? 'opacity:0.4;' : '';
                return `<label style="display:flex;align-items:center;gap:0.5rem;cursor:${canGrant ? 'pointer' : 'default'};${opacity}">
                    <input type="checkbox" class="usr-perm-cb" data-perm="${key}"
                        ${isChecked ? 'checked' : ''} ${disabled}
                        style="accent-color:var(--accent-primary);width:14px;height:14px;flex-shrink:0;">
                    <span style="font-size:0.85rem;">${label}</span>
                </label>`;
            }).join('');

        if (!rows) return '';
        return `<div>
            <div style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:0.35rem;">${group.label}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.2rem 0.5rem;">${rows}</div>
        </div>`;
    }).join('');
}

function onUserRoleChange() {
    const role  = document.getElementById('userModalRole').value;
    if (_usrIsAdmin) {
        const group = document.getElementById('userModalCompanyGroup');
        if (group) group.style.display = role === 'admin' ? 'none' : '';
    }
    _usrRenderPermissions();
}

function closeUserModal() {
    document.getElementById('userModal').classList.remove('active');
    _usrEditing = null;
    _usrMfaSetupPending = false;
}

async function _usrJson(url, options = {}) {
    const res = await apiFetch(url, options);
    if (!res.ok) {
        let detail = `Request failed (${res.status})`;
        try {
            detail = (await res.json()).detail || detail;
        } catch (_) {}
        throw new Error(Array.isArray(detail) ? detail.map(_usrFmtError).join(', ') : detail);
    }
    return res.json();
}

async function usrInitMfaPanel() {
    const group = document.getElementById('userModalMfaGroup');
    if (!group) return;
    _usrMfaSetupPending = false;
    document.getElementById('userModalMfaSetupBox').style.display = 'none';
    document.getElementById('userModalMfaSetupBox').innerHTML = '';
    document.getElementById('userModalMfaCode').value = '';

    if (!_usrEditing || !hasPermission('manage_mfa')) {
        group.style.display = 'none';
        return;
    }

    group.style.display = '';
    _usrRenderMfaControls(false, true, 'Loading MFA status...');
    try {
        const status = await _usrJson(`${API_BASE}/mfa/users/${_usrEditing.id}/status`);
        _usrRenderMfaControls(Boolean(status.enabled));
    } catch (e) {
        _usrRenderMfaControls(false, true, e.message || 'Unable to load MFA status');
    }
}

function _usrRenderMfaControls(enabled, disabled = false, message = null) {
    const isSelf = _usrEditing?.id === _usrMyId;
    const statusEl = document.getElementById('userModalMfaStatus');
    const codeGroup = document.getElementById('userModalMfaCodeGroup');
    const codeLabel = document.getElementById('userModalMfaCodeLabel');
    const setupBtn = document.getElementById('userModalMfaSetupBtn');
    const enableBtn = document.getElementById('userModalMfaEnableBtn');
    const disableBtn = document.getElementById('userModalMfaDisableBtn');
    const setupBox = document.getElementById('userModalMfaSetupBox');

    statusEl.textContent = message || (enabled ? 'MFA is enabled for this user.' : 'MFA is not enabled for this user.');
    setupBtn.disabled = disabled;
    enableBtn.disabled = disabled;
    disableBtn.disabled = disabled;

    setupBtn.style.display = !enabled ? 'inline-flex' : 'none';
    enableBtn.style.display = !enabled && _usrMfaSetupPending ? 'inline-flex' : 'none';
    disableBtn.style.display = enabled ? 'inline-flex' : 'none';
    codeGroup.style.display = ((!enabled && _usrMfaSetupPending) || (enabled && isSelf)) ? '' : 'none';
    codeLabel.textContent = enabled && isSelf ? 'Authenticator or Recovery Code' : 'Authenticator Code';
    if (enabled) setupBox.style.display = 'none';
}

async function usrSetupMfa() {
    if (!_usrEditing) return;
    try {
        const data = await _usrJson(`${API_BASE}/mfa/users/${_usrEditing.id}/setup`, { method: 'POST' });
        const box = document.getElementById('userModalMfaSetupBox');
        box.style.display = '';
        box.innerHTML = `
            <div id="userModalMfaQr" style="display:flex;justify-content:center;margin-bottom:0.75rem;"></div>
            <div style="font-size:0.78rem;color:var(--text-secondary);font-family:var(--font-sans);margin-bottom:0.35rem;">Recovery codes</div>
            <div>${(data.recovery_codes || []).map(_usrEsc).join('<br>')}</div>
        `;
        if (window.QRCode && data.provisioning_uri) {
            new QRCode(document.getElementById('userModalMfaQr'), {
                text: data.provisioning_uri,
                width: 160,
                height: 160,
                colorDark: '#111827',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.H,
            });
        }
        _usrMfaSetupPending = true;
        document.getElementById('userModalMfaCode').value = '';
        _usrRenderMfaControls(false);
    } catch (e) {
        showAlert(e.message || 'MFA setup failed', 'error');
    }
}

async function usrEnableMfa() {
    if (!_usrEditing) return;
    const code = document.getElementById('userModalMfaCode').value.trim();
    if (!code) {
        document.getElementById('userModalMfaCode').focus();
        return;
    }
    try {
        await _usrJson(`${API_BASE}/mfa/users/${_usrEditing.id}/enable`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
        });
        showAlert('MFA enabled', 'success');
        await usrInitMfaPanel();
    } catch (e) {
        showAlert(e.message || 'MFA enable failed', 'error');
    }
}

async function usrDisableMfa() {
    if (!_usrEditing) return;
    const code = document.getElementById('userModalMfaCode').value.trim();
    try {
        await _usrJson(`${API_BASE}/mfa/users/${_usrEditing.id}/disable`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: code || null }),
        });
        showAlert('MFA disabled', 'success');
        await usrInitMfaPanel();
    } catch (e) {
        showAlert(e.message || 'MFA disable failed', 'error');
    }
}

async function usrInitPasskeysPanel() {
    const group = document.getElementById('userModalPasskeyGroup');
    const status = document.getElementById('userModalPasskeyStatus');
    const addBtn = document.getElementById('userModalPasskeyAddBtn');
    const list = document.getElementById('userModalPasskeyList');
    if (!group || !status || !addBtn || !list) return;

    _usrPasskeys = [];
    list.innerHTML = '';
    if (!_usrEditing) {
        group.style.display = 'none';
        return;
    }

    group.style.display = '';
    status.textContent = 'Loading passkeys...';
    addBtn.style.display = _usrEditing.id === _usrMyId ? 'inline-flex' : 'none';
    addBtn.disabled = !window.PublicKeyCredential;

    try {
        _usrPasskeys = await _usrJson(`${API_BASE}/passkeys/users/${_usrEditing.id}`);
        _usrRenderPasskeys();
    } catch (e) {
        status.textContent = e.message || 'Unable to load passkeys';
    }
}

function _usrRenderPasskeys() {
    const status = document.getElementById('userModalPasskeyStatus');
    const list = document.getElementById('userModalPasskeyList');
    if (!status || !list) return;
    status.textContent = `${_usrPasskeys.length} passkey${_usrPasskeys.length !== 1 ? 's' : ''}`;
    if (!_usrPasskeys.length) {
        list.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;">No passkeys registered.</div>';
        return;
    }
    list.innerHTML = _usrPasskeys.map(k => `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;padding:0.55rem 0.65rem;background:var(--bg-tertiary);border-radius:8px;">
            <div style="min-width:0;">
                <div style="font-weight:600;font-size:0.86rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_usrEsc(k.name || 'Passkey')}</div>
                <div style="font-size:0.75rem;color:var(--text-muted);">Last used: ${k.last_used_at ? formatDateToLocal(k.last_used_at) : 'Never'}</div>
            </div>
            <div style="display:flex;gap:0.4rem;flex-shrink:0;">
                <button type="button" class="btn btn-secondary btn-small" onclick="usrRenamePasskey(${k.id})" title="Rename"><i class="mdi mdi-pencil"></i></button>
                <button type="button" class="btn btn-danger btn-small" onclick="usrDeletePasskey(${k.id})" title="Remove"><i class="mdi mdi-delete"></i></button>
            </div>
        </div>
    `).join('');
}

async function usrRegisterPasskey() {
    if (!_usrEditing || _usrEditing.id !== _usrMyId) return;
    if (!window.PublicKeyCredential) {
        showAlert('Passkeys are not supported by this browser', 'error');
        return;
    }
    if (typeof parsePasskeyOptions !== 'function' || typeof passkeyCredentialToJson !== 'function') {
        showAlert('Passkey tools are not ready', 'error');
        return;
    }
    const name = prompt('Name this passkey', navigator.userAgent.includes('Mobile') ? 'Mobile passkey' : 'Passkey');
    if (name === null) return;
    const btn = document.getElementById('userModalPasskeyAddBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i>';
    try {
        const challenge = await _usrJson(`${API_BASE}/passkeys/register/options`, { method: 'POST' });
        const credential = await navigator.credentials.create({
            publicKey: parsePasskeyOptions(challenge.options, 'create'),
        });
        await _usrJson(`${API_BASE}/passkeys/register/verify`, {
            method: 'POST',
            body: JSON.stringify({
                state: challenge.state,
                credential: passkeyCredentialToJson(credential),
                name: name.trim() || null,
            }),
        });
        showAlert('Passkey added', 'success');
        await usrInitPasskeysPanel();
    } catch (e) {
        showAlert(e.name === 'NotAllowedError' ? 'Passkey registration was cancelled' : (e.message || 'Passkey registration failed'), 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="mdi mdi-fingerprint"></i> Add';
    }
}

async function usrRenamePasskey(id) {
    if (!_usrEditing) return;
    const key = _usrPasskeys.find(k => k.id === id);
    const name = prompt('Passkey name', key?.name || 'Passkey');
    if (name === null) return;
    try {
        await _usrJson(`${API_BASE}/passkeys/users/${_usrEditing.id}/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ name: name.trim() || 'Passkey' }),
        });
        showAlert('Passkey renamed', 'success');
        await usrInitPasskeysPanel();
    } catch (e) {
        showAlert(e.message || 'Unable to rename passkey', 'error');
    }
}

async function usrDeletePasskey(id) {
    if (!_usrEditing || !confirm('Remove this passkey?')) return;
    try {
        await _usrJson(`${API_BASE}/passkeys/users/${_usrEditing.id}/${id}`, { method: 'DELETE' });
        showAlert('Passkey removed', 'success');
        await usrInitPasskeysPanel();
    } catch (e) {
        showAlert(e.message || 'Unable to remove passkey', 'error');
    }
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
    const currency = document.getElementById('userModalCurrency').value;

    // Collect permissions from checkboxes (only when not super admin role)
    // Company admins cannot change their own permissions — leave them untouched
    let permissions = null;
    if (role !== 'admin' && !(isMe && !_usrIsAdmin)) {
        permissions = [...document.querySelectorAll('.usr-perm-cb:checked:not(:disabled)')].map(cb => cb.dataset.perm);
    }

    const payload = {
        email,
        units,
        currency,
        ...(!isMe && { is_admin: role === 'admin', is_company_admin: role === 'company_admin' }),
        company_id: companyId,
        ...(permissions !== null && { permissions }),
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
        if (!res.ok) {
            const data   = await res.json();
            const detail = data.detail;
            if (Array.isArray(detail)) {
                detail.forEach(e => showAlert(_usrFmtError(e), 'error', 6000));
            } else {
                showAlert(detail || 'Save failed', 'error');
            }
        } else {
            const saved = await res.json();
            if (saved.id === _usrMyId) {
                localStorage.setItem('units', saved.units || units);
                localStorage.setItem('currency', saved.currency || currency);
                window.dispatchEvent(new Event('routario:currencychange'));
            }
            showAlert(isNew ? 'User created' : 'User updated', 'success');
            closeUserModal();
            await _usrLoad();
        }
    } catch (e) {
        showAlert(e.message || 'Save failed', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save';
    }
}

function _usrFmtError(e) {
    const fieldLabels = {
        email: 'Email', password: 'Password', username: 'Username',
        company_id: 'Company', permissions: 'Permissions',
        is_admin: 'Role', is_company_admin: 'Role',
    };
    const field = e.loc ? fieldLabels[e.loc[e.loc.length - 1]] || e.loc[e.loc.length - 1] : null;
    let msg = e.msg || 'Invalid value';
    if (/pattern/i.test(msg))          msg = 'Invalid format';
    else if (/at least (\d+) char/i.test(msg)) msg = msg.replace(/String should have at least (\d+) characters?/i, 'Must be at least $1 characters');
    else if (msg === 'Field required')  msg = 'Required';
    return field ? `${field}: ${msg}` : msg;
}

async function usrDelete(userId) {
    const u = _usrUsers.find(u => u.id === userId);
    if (!u || !confirm(`Delete user "${u.username}"?`)) return;
    try {
        const res = await apiFetch(`${API_BASE}/users/${userId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).detail || 'Delete failed');
        if (_usrEditing?.id === userId) closeUserModal();
        await _usrLoad();
    } catch (e) { showAlert(e.message || 'Delete failed', 'error'); }
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
        localStorage.setItem('permissions',      JSON.stringify(data.permissions || []));
        window.location.href = 'gps-dashboard.html';
    } catch (e) { showAlert(e.message || 'Impersonation failed', 'error'); }
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
    if (!userIds.length) { showAlert('Select at least one recipient.', 'warning'); return; }
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
            }).then(async r => r.ok ? r.json().catch(() => ({})) : ({ error: true })).catch(() => ({ error: true }))
        ));
        const failed = results.filter(r => r.error).length;
        const pushMissing = results.filter(r => !r.error && r.push_delivered === false).length;
        if (failed) showAlert(`Sent to ${userIds.length - failed} user(s). ${failed} failed.`, 'warning');
        else if (pushMissing) showAlert(`Notification sent. Push was not delivered to ${pushMissing} user(s).`, 'warning');
        else showAlert(`Notification sent to ${userIds.length} user(s).`, 'success');
        usrCloseNotifyModal();
    } catch (e) { showAlert(e.message || 'Send failed', 'error'); }
    finally {
        btn.disabled    = false;
        btn.textContent = 'Send';
    }
}

function _usrEsc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
