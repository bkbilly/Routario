// API_BASE is defined in config.js
const USER_ID          = parseInt(localStorage.getItem('user_id') || 1);
const IS_ADMIN         = localStorage.getItem('is_admin') === 'true';
const IS_COMPANY_ADMIN = localStorage.getItem('is_company_admin') === 'true';
const MY_COMPANY_ID    = parseInt(localStorage.getItem('company_id') || '0') || null;
let channels = [];
let webhooks = [];
let allUsers = [];
let allDevices = [];
let allCompanies = [];
let currentUserDevices = new Set();
let currentAssignUserId = null;
let currentAssignCompanyId = null;
let pendingCoAdminUserId = null;
let pendingCoAdminUsername = '';
let pendingCompanyAssignRole = 'company_admin';
let rolePopupUserId = null;
let rolePopupCurrentRole = null;
let rolePopupUsername = '';
let rolePopupCompanyId = null;

function maskUrl(url) {
    const schemeEnd = url.indexOf('://');
    if (schemeEnd === -1) return url.slice(0, 6) + '....';
    const scheme = url.slice(0, schemeEnd + 3); // e.g. "pbul://"
    return scheme + '....';
}

document.addEventListener('DOMContentLoaded', () => {
    checkLogin();
    loadSettings();
    
    document.addEventListener('click', e => {
        const popup = document.getElementById('rolePopup');
        if (popup && popup.style.display !== 'none' && !popup.contains(e.target)) {
            closeRolePopup();
        }
    });

    if (IS_ADMIN || IS_COMPANY_ADMIN) {
        document.getElementById('adminPanel').style.display = 'block';
        // Backup/restore and Companies link only for super admins
        const backupSection = document.getElementById('backupSection');
        if (backupSection) backupSection.style.display = IS_ADMIN ? '' : 'none';
        const companyLink = document.getElementById('companyMgmtLink');
        if (companyLink) companyLink.style.display = IS_ADMIN ? '' : 'none';
        loadAllDevices();

        if (IS_ADMIN) {
            const roleSelect = document.getElementById('newUserRole');
            const opt = document.createElement('option');
            opt.value = 'super_admin';
            opt.textContent = 'Super Admin';
            roleSelect.appendChild(opt);
            document.getElementById('newUserCompanyGroup').style.display = '';
            loadAllCompanies().then(() => loadAllUsers());
        } else {
            loadAllUsers();
        }

        const formGrid = document.querySelector('.admin-user-form-grid');
        if (formGrid) {
            formGrid.addEventListener('keydown', e => {
                if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
                    e.preventDefault();
                    addNewUser();
                }
            });
        }
    }
});

async function loadSettings() {
    try {
        const res = await apiFetch(`${API_BASE}/users/${USER_ID}`);
        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.detail || 'Failed to load user data');
        }
        
        const user = await res.json();
        
        document.getElementById('username').value = user.username || '';
        document.getElementById('email').value = user.email || '';
        document.getElementById('unitSystem').value = user.units || 'metric';
        webhooks = user.webhook_urls || [];
        renderWebhooks();

        channels = user.notification_channels || [];
        renderChannels();
        
    } catch (error) {
        console.error('Settings load error:', error);
        showAlert(error.message, 'error');
    }
}

function renderWebhooks() {
    const tbody = document.getElementById('webhookListBody');
    if (!webhooks.length) {
        tbody.innerHTML = `<tr><td colspan="2" style="color:var(--text-muted);padding:1rem 0;">No webhooks configured.</td></tr>`;
        return;
    }
    tbody.innerHTML = webhooks.map((url, i) => `
        <tr>
            <td style="font-family:monospace;font-size:0.8rem;word-break:break-all;">${url}</td>
            <td style="text-align:right;">
                <button class="btn btn-danger"
                        onclick="removeWebhook(${i})">Remove</button>
            </td>
        </tr>
    `).join('');
}

function addWebhook() {
    const url = document.getElementById('newWebhookUrl').value.trim();
    if (!url) return;
    try { new URL(url); } catch { showAlert('Invalid URL', 'error'); return; }
    if (webhooks.includes(url)) { showAlert('Already added', 'warning'); return; }
    webhooks.push(url);
    document.getElementById('newWebhookUrl').value = '';
    renderWebhooks();
    saveWebhooks();
}

function removeWebhook(index) {
    webhooks.splice(index, 1);
    renderWebhooks();
    saveWebhooks();
}

async function saveWebhooks() {
    try {
        const res = await apiFetch(`${API_BASE}/users/${USER_ID}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ webhook_urls: webhooks }),
        });
        if (res.ok) showAlert('Webhooks saved', 'success');
        else { const err = await res.json(); throw new Error(err.detail || 'Failed to save'); }
    } catch (e) {
        showAlert(e.message, 'error');
    }
}

async function loadAllUsers() {
    try {
        const res = await apiFetch(`${API_BASE}/users`);
        if (res.ok) {
            const users = await res.json();
            // Load device counts for non-admin users only
            for (const user of users) {
                if (user.is_admin || user.is_company_admin) continue;
                try {
                    const deviceRes = await apiFetch(`${API_BASE}/users/${user.id}/devices`);
                    if (deviceRes.ok) {
                        user.deviceCount = (await deviceRes.json()).length;
                    } else {
                        user.deviceCount = 0;
                    }
                } catch {
                    user.deviceCount = 0;
                }
            }
            allUsers = users;
            renderUserList(users);
        }
    } catch (e) { console.error("Failed to load users", e); }
}

async function loadAllDevices() {
    try {
        const res = await apiFetch(`${API_BASE}/devices/all`);
        if (res.ok) allDevices = await res.json();
    } catch (e) { console.error("Failed to load devices", e); }
}

async function loadAllCompanies() {
    try {
        const res = await apiFetch(`${API_BASE}/companies`);
        if (res.ok) {
            allCompanies = await res.json();
            populateCompanyDropdowns();
        }
    } catch (e) { console.error("Failed to load companies", e); }
}

function onNewUserRoleChange() {
    if (!IS_ADMIN) return;
    const role = document.getElementById('newUserRole').value;
    document.getElementById('newUserCompanyGroup').style.display = role === 'super_admin' ? 'none' : '';
}

function populateCompanyDropdowns() {
    const options = '<option value="">— Select Company —</option>' +
        allCompanies.map(c => `<option value="${c.id}">${c.name.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</option>`).join('');
    const sel1 = document.getElementById('newUserCompany');
    const sel2 = document.getElementById('coAdminCompanySelect');
    if (sel1) sel1.innerHTML = options;
    if (sel2) sel2.innerHTML = options;
}

function renderUserList(users) {
    const container = document.getElementById('userList');
    const countLabel = document.getElementById('userCountLabel');
    if (countLabel) countLabel.textContent = `${users.length} user${users.length !== 1 ? 's' : ''}`;
    container.innerHTML = '';

    users.forEach(u => {
        if (u.id === parseInt(localStorage.getItem('user_id'))) return;
        const div = document.createElement('div');
        div.className = 'user-list-item';
        const badges = [];
        if (IS_ADMIN && !u.is_admin && u.company_id) {
            const co = allCompanies.find(c => c.id === u.company_id);
            if (co) badges.push(co.name);
        }
        if (u.is_admin) badges.push('Super Admin');
        else if (u.is_company_admin) badges.push('Company Admin');
        if (u.deviceCount !== undefined && !u.is_admin && !u.is_company_admin)
            badges.push(`${u.deviceCount} device${u.deviceCount !== 1 ? 's' : ''}`);
        const esc = u.username.replace(/'/g, "\\'");
        const roleLabel = u.is_admin ? 'Super Admin' : u.is_company_admin ? 'Company Admin' : 'User';
        const roleBtnClass = u.is_admin ? 'btn-warning' : 'btn-secondary';
        div.innerHTML = `
            <div class="user-info">
                <span class="user-name">${u.username}</span>
                <span class="user-email">${u.email}${badges.length ? ' · ' + badges.join(' · ') : ''}</span>
            </div>
            <div class="user-actions">
                ${IS_ADMIN
                    ? `<button type="button" class="btn ${roleBtnClass}"
                           onclick="openRolePopup(event,${u.id},'${esc}',${u.is_admin},${u.is_company_admin},${u.company_id || null})">
                           ${roleLabel} &#9660;</button>`
                    : (!u.is_admin
                        ? `<button type="button" class="btn ${u.is_company_admin ? 'btn-warning' : 'btn-secondary'}"
                               onclick="toggleCompanyAdmin(${u.id},${u.is_company_admin},'${esc}',${u.company_id || null})">
                               ${u.is_company_admin ? 'Revoke Admin' : 'Make Admin'}</button>`
                        : '')}
                ${!u.is_admin && !u.is_company_admin ? `<button type="button" class="btn btn-secondary"
                        onclick="openAssignModal(${u.id}, '${u.username}', ${u.company_id || null})">
                    Devices
                </button>` : ''}
                <button type="button" class="btn btn-secondary"
                        onclick="promptPasswordChange(${u.id})">
                    Password
                </button>
                ${IS_ADMIN ? `<button type="button" class="btn btn-secondary"
                        onclick="loginAsUser(${u.id}, '${u.username}')">
                    Login As
                </button>` : ''}
                <button type="button" class="btn btn-secondary"
                        onclick="openNotifyModal(${u.id})">
                    Notify
                </button>
                <button type="button" class="btn btn-danger"
                        onclick="deleteUser(${u.id})">
                    Delete
                </button>
            </div>`;
        container.appendChild(div);
    });
}

async function toggleAdmin(userId, currentlyAdmin) {
    const action = currentlyAdmin ? 'revoke admin from' : 'grant admin to';
    if (!confirm(`Are you sure you want to ${action} this user?`)) return;
    try {
        const res = await apiFetch(`${API_BASE}/users/${userId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_admin: !currentlyAdmin }),
        });
        if (res.ok) {
            showAlert(`Admin status updated`, 'success');
            loadAllUsers();
        } else {
            const err = await res.json();
            showAlert(err.detail || 'Failed to update admin status', 'error');
        }
    } catch (e) { showAlert('Error updating admin status', 'error'); }
}

async function toggleCompanyAdmin(userId, currentlyCompanyAdmin, username, currentCompanyId) {
    if (!currentlyCompanyAdmin) {
        openCompanySelectModal(userId, username, 'company_admin', currentCompanyId);
        return;
    }
    if (!confirm(`Revoke company admin from "${username}"?`)) return;
    try {
        const res = await apiFetch(`${API_BASE}/users/${userId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_company_admin: false }),
        });
        if (res.ok) {
            showAlert('Company admin revoked', 'success');
            loadAllUsers();
        } else {
            const err = await res.json();
            showAlert(err.detail || 'Failed to update', 'error');
        }
    } catch (e) { showAlert('Error updating company admin status', 'error'); }
}

function openRolePopup(event, userId, username, isUserAdmin, isUserCompanyAdmin, currentCompanyId) {
    event.stopPropagation();
    rolePopupUserId = userId;
    rolePopupUsername = username;
    rolePopupCurrentRole = isUserAdmin ? 'super_admin' : isUserCompanyAdmin ? 'company_admin' : 'user';
    rolePopupCompanyId = currentCompanyId || null;

    document.getElementById('rolePopupHeader').textContent = username;
    const options = [
        { role: 'user',          label: 'Regular User',  icon: '&#128100;' },
        { role: 'company_admin', label: 'Company Admin', icon: '&#127970;' },
        { role: 'super_admin',   label: 'Super Admin',   icon: '&#128737;&#65039;' },
    ];
    document.getElementById('rolePopupOptions').innerHTML = options.map(o =>
        `<button class="role-popup-option${o.role === rolePopupCurrentRole ? ' active' : ''}"
                 onclick="selectRole('${o.role}')">${o.icon} ${o.label}</button>`
    ).join('');

    const rect = event.currentTarget.getBoundingClientRect();
    const popup = document.getElementById('rolePopup');
    popup.style.visibility = 'hidden';
    popup.style.display = 'block';
    requestAnimationFrame(() => {
        const pw = popup.offsetWidth;
        const ph = popup.offsetHeight;
        let top = rect.bottom + 6;
        let left = rect.right - pw;
        if (left < 8) left = 8;
        if (top + ph > window.innerHeight - 8) top = rect.top - ph - 6;
        popup.style.top = `${top}px`;
        popup.style.left = `${left}px`;
        popup.style.visibility = '';
    });
}

function closeRolePopup() {
    const popup = document.getElementById('rolePopup');
    if (popup) popup.style.display = 'none';
    rolePopupUserId = null;
    rolePopupCurrentRole = null;
    rolePopupUsername = '';
    rolePopupCompanyId = null;
}

async function selectRole(role) {
    const userId = rolePopupUserId;
    const username = rolePopupUsername;
    const fromRole = rolePopupCurrentRole;
    const companyId = rolePopupCompanyId;
    closeRolePopup();

    if (role === fromRole) return;

    if (role === 'super_admin') {
        if (!confirm(`Grant super admin to "${username}"?`)) return;
        await _applyRole(userId, { is_admin: true, is_company_admin: false });
    } else if (role === 'company_admin') {
        openCompanySelectModal(userId, username, 'company_admin', companyId);
    } else {
        openCompanySelectModal(userId, username, 'user', companyId);
    }
}

async function _applyRole(userId, payload) {
    try {
        const res = await apiFetch(`${API_BASE}/users/${userId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (res.ok) {
            showAlert('Role updated', 'success');
            loadAllUsers();
        } else {
            const err = await res.json();
            showAlert(err.detail || 'Failed to update role', 'error');
        }
    } catch (e) { showAlert('Error updating role', 'error'); }
}

function openCompanySelectModal(userId, username, role, currentCompanyId) {
    pendingCoAdminUserId = userId;
    pendingCoAdminUsername = username || '';
    pendingCompanyAssignRole = role || 'company_admin';
    populateCompanyDropdowns();
    const label = pendingCompanyAssignRole === 'company_admin' ? 'Company Admin' : 'Regular User';
    document.getElementById('coAdminUsername').textContent = `${username || 'this user'} as ${label}`;
    document.getElementById('coAdminCompanySelect').value = currentCompanyId ? String(currentCompanyId) : '';
    document.getElementById('companySelectModal').classList.add('active');
}

function closeCompanySelectModal() {
    document.getElementById('companySelectModal').classList.remove('active');
    pendingCoAdminUserId = null;
    pendingCoAdminUsername = '';
}

async function confirmMakeCoAdmin() {
    const companyId = parseInt(document.getElementById('coAdminCompanySelect').value) || null;
    if (!companyId) { showAlert('Please select a company', 'error'); return; }
    try {
        const res = await apiFetch(`${API_BASE}/users/${pendingCoAdminUserId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_admin: false, is_company_admin: pendingCompanyAssignRole === 'company_admin', company_id: companyId }),
        });
        if (res.ok) {
            showAlert(pendingCompanyAssignRole === 'company_admin' ? 'Company admin assigned' : 'User updated', 'success');
            closeCompanySelectModal();
            loadAllUsers();
        } else {
            const err = await res.json();
            showAlert(err.detail || 'Failed to update', 'error');
        }
    } catch (e) { showAlert('Error updating company admin status', 'error'); }
}

async function loginAsUser(userId, username) {
    if (!confirm(`Login as "${username}"? You can return to your admin account from the dashboard.`)) return;
    try {
        const res = await apiFetch(`${API_BASE}/users/${userId}/impersonate`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json();
            showAlert(err.detail || 'Failed to impersonate user', 'error');
            return;
        }
        const data = await res.json();
        // Save admin session so we can restore it later
        localStorage.setItem('impersonating_admin_token',    localStorage.getItem('auth_token'));
        localStorage.setItem('impersonating_admin_user_id',  localStorage.getItem('user_id'));
        localStorage.setItem('impersonating_admin_username', localStorage.getItem('username'));
        // Switch to target user
        localStorage.setItem('auth_token',       data.access_token);
        localStorage.setItem('user_id',          data.user_id);
        localStorage.setItem('username',         data.username);
        localStorage.setItem('is_admin',         data.is_admin);
        localStorage.setItem('is_company_admin', data.is_company_admin || false);
        localStorage.setItem('company_id',       data.company_id ?? '');
        window.location.href = 'gps-dashboard.html';
    } catch (e) { showAlert('Error during impersonation', 'error'); }
}

function renderAssignList() {
    const list = document.getElementById('deviceAssignList');
    const search = document.getElementById('deviceSearch')?.value.toLowerCase() || '';
    list.innerHTML = '';

    allDevices
        .filter(d => !currentAssignCompanyId || d.company_id === currentAssignCompanyId)
        .filter(d => d.name.toLowerCase().includes(search) || d.imei.includes(search))
        .forEach(d => {
            const div = document.createElement('div');
            div.className = 'user-list-item';
            div.innerHTML = `
                <div class="user-info">
                    <span class="user-name">${d.name}</span>
                    <span class="user-email">${d.imei}</span>
                </div>
                <label class="switch">
                    <input type="checkbox" ${currentUserDevices.has(d.id) ? 'checked' : ''} onchange="toggleAssignment(${d.id}, this.checked)">
                    <span class="slider round"></span>
                </label>
            `;
            list.appendChild(div);
        });
}

function filterDeviceList() { renderAssignList(); }

async function toggleAssignment(deviceId, assign) {
    const action = assign ? 'add' : 'remove';
    try {
        const res = await apiFetch(`${API_BASE}/users/${currentAssignUserId}/devices?device_id=${deviceId}&action=${action}`, { method: 'POST' });
        if (res.ok) {
            if (assign) currentUserDevices.add(deviceId);
            else currentUserDevices.delete(deviceId);
        } else {
            showAlert("Failed to update assignment", "error");
            renderAssignList();
        }
    } catch (e) {
        console.error(e);
        showAlert("Error updating assignment", "error");
        renderAssignList();
    }
}

async function openAssignModal(userId, username, companyId) {
    currentAssignUserId = userId;
    currentAssignCompanyId = companyId || null;
    document.getElementById('assignUserName').textContent = username;
    try {
        const res = await apiFetch(`${API_BASE}/users/${userId}/devices`);
        if (res.ok) {
            const userDevices = await res.json();
            currentUserDevices = new Set(userDevices.map(d => d.id));
        }
    } catch (e) { console.error(e); }
    renderAssignList();
    document.getElementById('assignModal').classList.add('active');
}

async function closeAssignModal() {
    document.getElementById('assignModal').classList.remove('active');
    currentAssignCompanyId = null;
    await loadAllUsers();
}

function formatUserError(e) {
    const fieldMap = { username: 'Username', email: 'Email', password: 'Password', company_id: 'Company' };
    const field = Array.isArray(e.loc) ? e.loc.filter(p => p !== 'body').join('.') : '';
    const label = fieldMap[field] || field;

    if (e.type === 'string_pattern_mismatch' || (e.msg || '').includes('pattern')) {
        return field === 'email' ? 'Please enter a valid email address' : `${label || 'A field'} has an invalid format`;
    }
    if (e.type === 'string_too_short') {
        return `${label || 'A field'} must be at least ${e.ctx?.min_length ?? '?'} characters`;
    }
    if (e.type === 'string_too_long') {
        return `${label || 'A field'} must be at most ${e.ctx?.max_length ?? '?'} characters`;
    }
    if (e.type === 'missing') {
        return `${label || 'A required field'} is missing`;
    }
    return label ? `${label}: ${e.msg}` : e.msg;
}

async function addNewUser() {
    const username = document.getElementById('newUserName').value.trim();
    const email    = document.getElementById('newUserEmail').value.trim();
    const password = document.getElementById('newUserPass').value;
    const role     = document.getElementById('newUserRole').value;

    if (!username) { showAlert('Username is required', 'error'); return; }
    if (!email)    { showAlert('Email is required', 'error'); return; }
    if (!password) { showAlert('Password is required', 'error'); return; }

    const payload = { username, email, password };

    if (role === 'super_admin') {
        payload.is_admin = true;
    } else if (role === 'company_admin') {
        payload.is_company_admin = true;
        if (IS_ADMIN) {
            const companyId = parseInt(document.getElementById('newUserCompany').value) || null;
            if (!companyId) { showAlert('Please select a company for the Company Admin', 'error'); return; }
            payload.company_id = companyId;
        }
    } else {
        if (IS_ADMIN) {
            const companyId = parseInt(document.getElementById('newUserCompany').value) || null;
            if (!companyId) { showAlert('Please select a company for the user', 'error'); return; }
            payload.company_id = companyId;
        }
    }

    try {
        const res = await apiFetch(`${API_BASE}/users`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
        });

        if (res.ok) {
            showAlert('User created successfully', 'success');
            document.getElementById('newUserName').value  = '';
            document.getElementById('newUserEmail').value = '';
            document.getElementById('newUserPass').value  = '';
            document.getElementById('newUserRole').value  = 'user';
            if (IS_ADMIN) {
                document.getElementById('newUserCompany').value = '';
                document.getElementById('newUserCompanyGroup').style.display = '';
            }
            loadAllUsers();
        } else {
            const err = await res.json();
            let message;
            if (Array.isArray(err.detail)) {
                message = err.detail.map(formatUserError).join('\n');
            } else {
                message = err.detail || 'Failed to create user';
            }
            showAlert(message, 'error');
        }
    } catch (e) { showAlert('Connection error — could not reach the server', 'error'); }
}


async function deleteUser(id) {
    if (!confirm('Are you sure you want to delete this user?')) return;
    try {
        const res = await apiFetch(`${API_BASE}/users/${id}`, { method: 'DELETE' });
        if (res.ok) {
            showAlert('User deleted', 'success');
            loadAllUsers();
        }
    } catch (e) { showAlert('Error deleting user', 'error'); }
}

async function promptPasswordChange(id) {
    const newPass = prompt("Enter new password for user:");
    if (!newPass) return;
    
    try {
        const res = await apiFetch(`${API_BASE}/users/${id}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ password: newPass })
        });
        if (res.ok) showAlert('Password updated', 'success');
        else showAlert('Failed to update password', 'error');
    } catch (e) { showAlert('Error', 'error'); }
}

function renderChannels() {
    const body = document.getElementById('channelListBody');
    body.innerHTML = '';
    
    if (channels.length === 0) {
        body.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 2rem;">No notification channels configured.</td></tr>';
        return;
    }
    
    channels.forEach((channel, index) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="channel-name-cell">${channel.name}</td>
            <td class="channel-url-cell">${maskUrl(channel.url)}</td>
            <td style="text-align: right;">
                <button type="button" class="btn btn-danger" onclick="removeChannel(${index})">
                    Remove
                </button>
            </td>
        `;
        body.appendChild(tr);
    });
}

async function saveChannels() {
    try {
        const res = await apiFetch(`${API_BASE}/users/${USER_ID}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notification_channels: channels }),
        });
        if (res.ok) {
            showAlert('Channel saved', 'success');
        } else {
            const err = await res.json();
            throw new Error(err.detail || 'Failed to save channels');
        }
    } catch (error) {
        console.error('Save channels error:', error);
        showAlert(error.message, 'error');
        await loadSettings(); // restore consistent state on failure
    }
}

async function addChannel() {
    const nameInput = document.getElementById('newChannelName');
    const urlInput  = document.getElementById('newChannelUrl');
    
    const name = nameInput.value.trim();
    const url  = urlInput.value.trim();
    
    if (!name || !url) {
        showAlert('Please provide both name and URL', 'error');
        return;
    }
    
    channels.push({ name, url });
    nameInput.value = '';
    urlInput.value  = '';
    renderChannels();

    await saveChannels();
}

async function removeChannel(index) {
    channels.splice(index, 1);
    renderChannels();

    await saveChannels();
}

async function saveSettings(e) {
    e.preventDefault();
    const btn = document.getElementById('saveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving Settings...';

    const selectedUnits = document.getElementById('unitSystem').value;
    const payload = {
        email: document.getElementById('email').value,
        notification_channels: channels,
        units: selectedUnits,
    };

    const password = document.getElementById('password').value;
    if (password) {
        payload.password = password;
    }

    try {
        const res = await apiFetch(`${API_BASE}/users/${USER_ID}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            showAlert('Profile updated successfully', 'success');
            localStorage.setItem('units', selectedUnits);
            document.getElementById('password').value = '';
        } else {
            const err = await res.json();
            throw new Error(err.detail || 'Failed to update settings');
        }
    } catch (error) {
        console.error('Save settings error:', error);
        showAlert(error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save Profile Changes';
    }
}


// Show backup panel for admins
if (localStorage.getItem('is_admin') === 'true') {
    const bp = document.getElementById('backupPanel');
    if (bp) bp.style.display = 'block';
}

async function downloadBackup() {
    const btn = document.getElementById('backupDownloadBtn');
    btn.disabled    = true;
    btn.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i> Preparing…';
    try {
        const res = await apiFetch(`${API_BASE}/admin/backup/download`);
        if (!res.ok) throw new Error('Failed to generate backup');
        const blob     = await res.blob();
        const url      = URL.createObjectURL(blob);
        const filename = res.headers.get('Content-Disposition')
            ?.match(/filename=(.+)/)?.[1] || 'routario_backup.tar.gz';
        const a  = document.createElement('a');
        a.href   = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        showAlert('Backup downloaded successfully', 'success');
    } catch (e) {
        showAlert('Backup failed: ' + e.message, 'error');
    } finally {
        btn.disabled    = false;
        btn.innerHTML = '<i class="mdi mdi-download"></i> Download Backup';
    }
}

let _restoreFile = null;

function handleRestoreFile(input) {
    _restoreFile = input.files[0];
    const nameEl = document.getElementById('restoreFileName');
    const confirmBtn = document.getElementById('restoreConfirmBtn');
    if (!_restoreFile) {
        nameEl.textContent = 'No file selected';
        confirmBtn.style.display = 'none';
        return;
    }
    nameEl.textContent = _restoreFile.name;
    confirmBtn.style.display = 'block';
}

async function confirmRestore() {
    if (!_restoreFile) return;
    if (!confirm(
        'WARNING: This will REPLACE all data with the backup.\n\n' +
        'The platform will need to be restarted after restore.\n\n' +
        'Are you absolutely sure?'
    )) return;

    const btn = document.getElementById('restoreConfirmBtn');
    btn.disabled    = true;
    btn.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i> Restoring…';

    try {
        const form = new FormData();
        form.append('file', _restoreFile);
        const token = localStorage.getItem('auth_token');
        const res   = await fetch(`${API_BASE}/admin/backup/restore`, {
            method:  'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body:    form,
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || 'Restore failed');
        }
        const data = await res.json();
        showAlert(`Restore complete. Backup from ${data.created_at}. Please restart the server.`, 'success');

        // Reset UI
        _restoreFile = null;
        document.getElementById('restoreFileInput').value      = '';
        document.getElementById('restoreFileName').textContent  = '';
        document.getElementById('restoreConfirmBtn').style.display = 'none';
    } catch (e) {
        showAlert('Restore failed: ' + e.message, 'error');
    } finally {
        btn.disabled    = false;
        btn.innerHTML = '<i class="mdi mdi-alert"></i> Restore — this will overwrite all data';
    }
}

// ── Notify User ───────────────────────────────────────────────────────────────

let _notifySelected = new Set();

function _renderNotifyUserList(filter = '') {
    const list = document.getElementById('notifyUserList');
    const lower = filter.toLowerCase();
    const me = parseInt(localStorage.getItem('user_id'));
    const candidates = allUsers.filter(u => u.id !== me);
    const filtered = lower
        ? candidates.filter(u => u.username.toLowerCase().includes(lower) || (u.email || '').toLowerCase().includes(lower))
        : candidates;

    if (!filtered.length) {
        list.innerHTML = `<div class="notify-user-empty">No users found.</div>`;
        return;
    }

    const allChecked = filtered.every(u => _notifySelected.has(u.id));
    list.innerHTML = `
        <label class="notify-user-item notify-select-all">
            <input type="checkbox" id="notifySelectAll" ${allChecked ? 'checked' : ''} onchange="_toggleSelectAllNotify(this.checked)">
            <span>Select all${filtered.length < candidates.length ? ` filtered (${filtered.length})` : ` (${filtered.length})`}</span>
        </label>
        <div class="notify-user-grid">
        ${filtered.map(u => `
        <label class="notify-user-item">
            <input type="checkbox" class="notify-user-cb" value="${u.id}" ${_notifySelected.has(u.id) ? 'checked' : ''} onchange="_onNotifyCbChange(this)">
            <span class="notify-user-info">
                <span class="notify-user-name">${_esc(u.username)}</span>
                <span class="notify-user-email">${u.is_admin ? 'Admin' : u.is_company_admin ? 'Company Admin' : 'User'}</span>
            </span>
        </label>`).join('')}
        </div>`;
}

function _onNotifyCbChange(cb) {
    const id = parseInt(cb.value);
    cb.checked ? _notifySelected.add(id) : _notifySelected.delete(id);
    _updateSelectAllState();
    _updateNotifyCount();
}

function _toggleSelectAllNotify(checked) {
    document.querySelectorAll('.notify-user-cb').forEach(cb => {
        cb.checked = checked;
        const id = parseInt(cb.value);
        checked ? _notifySelected.add(id) : _notifySelected.delete(id);
    });
    _updateNotifyCount();
}

function _updateSelectAllState() {
    const all  = document.querySelectorAll('.notify-user-cb');
    const nChecked = [...all].filter(cb => cb.checked).length;
    const sel = document.getElementById('notifySelectAll');
    if (!sel) return;
    sel.indeterminate = nChecked > 0 && nChecked < all.length;
    sel.checked = all.length > 0 && nChecked === all.length;
}

function _updateNotifyCount() {
    const el = document.getElementById('notifySelectedCount');
    if (!el) return;
    const n = _notifySelected.size;
    el.textContent = n > 0 ? `${n} selected` : '';
}

function filterNotifyUsers() {
    _renderNotifyUserList(document.getElementById('notifyUserSearch').value.trim());
}

function openNotifyModal(userId) {
    _notifySelected = new Set([userId]);
    document.getElementById('notifyUserSearch').value = '';
    document.getElementById('notifyTitle').value = '';
    document.getElementById('notifyMessage').value = '';
    _renderNotifyUserList();
    _updateNotifyCount();
    document.getElementById('notifyUserModal').classList.add('active');
}

function closeNotifyModal() {
    document.getElementById('notifyUserModal').classList.remove('active');
}

async function sendNotification() {
    const title   = document.getElementById('notifyTitle').value.trim();
    const message = document.getElementById('notifyMessage').value.trim();
    const userIds = [..._notifySelected];

    if (!userIds.length) { showAlert('Select at least one recipient.', 'warning'); return; }
    if (!title || !message) { showAlert('Title and message are required.', 'warning'); return; }

    const btn = document.getElementById('notifySendBtn');
    btn.disabled = true;
    btn.textContent = 'Sending...';
    try {
        const results = await Promise.all(userIds.map(id =>
            apiFetch(`${API_BASE}/users/${id}/notify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, message }),
            }).then(r => r.json()).catch(() => ({ error: true }))
        ));
        const noPush = results.filter(r => !r.error && !r.push_delivered).length;
        const failed = results.filter(r => r.error).length;
        if (failed) {
            showAlert(`Sent to ${userIds.length - failed} user(s). ${failed} failed.`, 'error', 5000);
        } else if (noPush) {
            showAlert(`Sent to ${userIds.length} user(s). ${noPush} have no push notifications enabled.`, 'warning', 6000);
        } else {
            showAlert(`Notification sent to ${userIds.length} user(s).`, 'success');
        }
        closeNotifyModal();
    } catch (e) {
        showAlert('Error sending notification.', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Send';
    }
}

