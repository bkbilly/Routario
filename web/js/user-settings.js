// API_BASE is defined in config.js
const USER_ID          = parseInt(localStorage.getItem('user_id') || 1);
const IS_ADMIN         = localStorage.getItem('is_admin') === 'true';
const IS_COMPANY_ADMIN = localStorage.getItem('is_company_admin') === 'true';
const MY_COMPANY_ID    = parseInt(localStorage.getItem('company_id') || '0') || null;
let channels = [];
let webhooks = [];
let settingsApiKeys = [];
let settingsApiKeyScopesLoaded = false;
let currentSettingsTab = hasPermission('manage_users') ? 'users' : 'notifications';
const SETTINGS_TABS = ['users', 'notifications', 'webhooks', 'apiKeys', 'backups'].map(name => ({
    name,
    panelId: `settings-section-${name}`,
    tabId: 'settingsTab' + name.charAt(0).toUpperCase() + name.slice(1),
}));

function settingsEsc(value) {
    return RoutarioUI.escapeHtml(value);
}

function maskUrl(url) {
    const schemeEnd = url.indexOf('://');
    if (schemeEnd === -1) return url.slice(0, 6) + '....';
    const scheme = url.slice(0, schemeEnd + 3); // e.g. "pbul://"
    return scheme + '....';
}

document.addEventListener('DOMContentLoaded', async () => {
    checkLogin();
    await permissionsReady;
    loadSettings();
    applySettingsPermissions();

    if ((IS_ADMIN || IS_COMPANY_ADMIN) && hasPermission('manage_backups')) {
        const backupsTab = document.getElementById('settingsTabBackups');
        if (backupsTab) backupsTab.style.display = '';
        const backupSection = document.getElementById('backupSection');
        if (backupSection) backupSection.style.display = '';
    }
    if (IS_ADMIN) {
        const ch = document.getElementById('userCompanyHeader');
        if (ch) ch.style.display = '';
    }
    const hash = normalizeSettingsTab(RoutarioTabs.hashValue());
    switchSettingsTab(['users', 'notifications', 'webhooks', 'apiKeys', 'backups'].includes(hash) ? hash : currentSettingsTab, false);
});

document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    closeChannelModal();
    closeWebhookModal();
    closeApiKeyModal();
    closeUserModal();
    usrCloseAssignModal();
    usrCloseNotifyModal();
});

function switchSettingsTab(name, pushState = true) {
    name = normalizeSettingsTab(name);
    const fallback = hasPermission('manage_users') ? 'users' : 'notifications';
    const sections = ['users', 'notifications', 'webhooks', 'apiKeys', 'backups'];
    if (!sections.includes(name)) name = fallback;
    if (name === 'users' && !hasPermission('manage_users')) name = 'notifications';
    if (name === 'backups' && !((IS_ADMIN || IS_COMPANY_ADMIN) && hasPermission('manage_backups'))) name = fallback;
    if (name === 'apiKeys' && !hasPermission('manage_api_keys')) name = fallback;
    currentSettingsTab = name;
    RoutarioTabs.activate(SETTINGS_TABS, name);
    if (pushState) RoutarioTabs.replaceHash(name);
    if (name === 'users') initUsersSection();
    if (name === 'apiKeys') initSettingsApiKeys();
    updateSettingsGearAction(name);
}

function normalizeSettingsTab(name) {
    return name === 'admin' ? 'backups' : name;
}

function applySettingsPermissions() {
    const usersTab = document.getElementById('settingsTabUsers');
    if (usersTab) usersTab.style.display = hasPermission('manage_users') ? '' : 'none';
    const apiTab = document.getElementById('settingsTabApiKeys');
    if (apiTab) apiTab.style.display = hasPermission('manage_api_keys') ? '' : 'none';
    const backupTab = document.getElementById('settingsTabBackups');
    if (backupTab) backupTab.style.display = ((IS_ADMIN || IS_COMPANY_ADMIN) && hasPermission('manage_backups')) ? '' : 'none';
}

function closeSettingsGearMenu() {
    document.getElementById('snDropdown')?.classList.remove('open');
    document.getElementById('snGearBtn')?.classList.remove('active');
}

function updateSettingsGearAction(name = currentSettingsTab) {
    const el = document.getElementById('snSettingsAction');
    if (!el) return;
    const actions = {
        users: hasPermission('manage_users') ? {
            label: 'Add User',
            icon: 'mdi-account-plus',
            fn: 'openUserModal()',
        } : null,
        notifications: {
            label: 'Add Notification Channel',
            icon: 'mdi-bell-plus',
            fn: 'openChannelModal()',
        },
        webhooks: {
            label: 'Add Webhook',
            icon: 'mdi-link-plus',
            fn: 'openWebhookModal()',
        },
        apiKeys: hasPermission('manage_api_keys') ? {
            label: 'Create API Key',
            icon: 'mdi-key-plus',
            fn: 'openApiKeyModal()',
        } : null,
    };
    const action = actions[name];
    const primary = action
        ? `<button class="header-menu-item" onclick="${action.fn}; closeSettingsGearMenu()"><span class="header-menu-item-icon"><i class="mdi ${action.icon}" style="font-size:15px;"></i></span><span>${settingsEsc(action.label)}</span></button>`
        : '';
    const notify = name === 'users' && hasPermission('manage_users')
        ? `<button class="header-menu-item" onclick="usrOpenNotifyModal(); closeSettingsGearMenu()"><span class="header-menu-item-icon"><i class="mdi mdi-bell" style="font-size:15px;"></i></span><span>Send Notification</span></button>`
        : '';
    el.innerHTML = primary + notify;
}

window.addEventListener('hashchange', () => {
    const hash = normalizeSettingsTab(RoutarioTabs.hashValue());
    switchSettingsTab(hash || currentSettingsTab, false);
});

async function loadSettings() {
    try {
        let user = await permissionsReady;
        if (!user) {
            const res = await apiFetch(`${API_BASE}/users/${USER_ID}`);
            if (!res.ok) {
                const error = await res.json();
                throw new Error(error.detail || 'Failed to load user data');
            }
            user = await res.json();
        }

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
    const q = (document.getElementById('webhookSearch')?.value || '').toLowerCase();
    const rows = webhooks.filter(url => url.toLowerCase().includes(q));
    const count = document.getElementById('webhookCount');
    if (count) count.textContent = `${rows.length} webhook${rows.length !== 1 ? 's' : ''}`;
    if (!rows.length) {
        tbody.innerHTML = RoutarioTables.stateRow('No webhooks found.', 2);
        return;
    }
    tbody.innerHTML = rows.map(url => `
        <tr class="device-row">
            <td style="font-family:var(--font-mono);font-size:0.82rem;word-break:break-all;">${settingsEsc(url)}</td>
            <td style="text-align:right;">
                <button type="button" class="btn btn-danger btn-small"
                        onclick="removeWebhook(${webhooks.indexOf(url)})"><i class="mdi mdi-delete"></i> Remove</button>
            </td>
        </tr>
    `).join('');
}

async function addWebhook() {
    const url = document.getElementById('newWebhookUrl').value.trim();
    if (!url) return;
    try { new URL(url); } catch { showAlert('Invalid URL', 'error'); return; }
    if (webhooks.includes(url)) { showAlert('Already added', 'warning'); return; }
    webhooks.push(url);
    document.getElementById('newWebhookUrl').value = '';
    renderWebhooks();
    await saveWebhooks();
    closeWebhookModal();
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

function renderChannels() {
    const body = document.getElementById('channelListBody');
    body.innerHTML = '';
    const q = (document.getElementById('notificationSearch')?.value || '').toLowerCase();
    const rows = channels.filter(channel =>
        (channel.name || '').toLowerCase().includes(q) ||
        (channel.url || '').toLowerCase().includes(q)
    );
    const count = document.getElementById('channelCount');
    if (count) count.textContent = `${rows.length} channel${rows.length !== 1 ? 's' : ''}`;
    
    if (rows.length === 0) {
        body.innerHTML = RoutarioTables.stateRow('No notification channels found.', 3);
        return;
    }
    
    rows.forEach(channel => {
        const index = channels.indexOf(channel);
        const tr = document.createElement('tr');
        tr.className = 'device-row';
        tr.innerHTML = `
            <td class="channel-name-cell"><span class="device-row-name">${settingsEsc(channel.name)}</span></td>
            <td class="channel-url-cell">${settingsEsc(maskUrl(channel.url))}</td>
            <td style="text-align: right;">
                <button type="button" class="btn btn-danger btn-small" onclick="removeChannel(${index})">
                    <i class="mdi mdi-delete"></i> Remove
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
    closeChannelModal();
}

async function removeChannel(index) {
    channels.splice(index, 1);
    renderChannels();

    await saveChannels();
}

function openChannelModal() {
    document.getElementById('newChannelName').value = '';
    document.getElementById('newChannelUrl').value = '';
    document.getElementById('notificationChannelModal').classList.add('active');
    setTimeout(() => document.getElementById('newChannelName')?.focus(), 50);
}

function closeChannelModal() {
    document.getElementById('notificationChannelModal')?.classList.remove('active');
}

function openWebhookModal() {
    document.getElementById('newWebhookUrl').value = '';
    document.getElementById('webhookModal').classList.add('active');
    setTimeout(() => document.getElementById('newWebhookUrl')?.focus(), 50);
}

function closeWebhookModal() {
    document.getElementById('webhookModal')?.classList.remove('active');
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
        nameEl.textContent = 'Choose backup file';
        confirmBtn.style.display = 'none';
        return;
    }
    nameEl.textContent = _restoreFile.name;
    confirmBtn.style.display = 'block';
}

async function confirmRestore() {
    if (!_restoreFile) return;
    if (!confirm(
        'WARNING: This will REPLACE company data with the backup.\n\n' +
        'Other companies and super admin accounts will not be changed.\n\n' +
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
        showAlert(`Restore complete. Backup from ${data.created_at}.`, 'success', 8000);

        // Reset UI
        _restoreFile = null;
        document.getElementById('restoreFileInput').value      = '';
        document.getElementById('restoreFileName').textContent  = 'Choose backup file';
        document.getElementById('restoreConfirmBtn').style.display = 'none';
    } catch (e) {
        showAlert('Restore failed: ' + e.message, 'error');
    } finally {
        btn.disabled    = false;
        btn.innerHTML = '<i class="mdi mdi-database-sync"></i> Restore Company Data';
    }
}

async function settingsJson(url, options = {}) {
    const res = await apiFetch(url, options);
    if (!res.ok) {
        let msg = `Request failed (${res.status})`;
        try { msg = (await res.json()).detail || msg; } catch {}
        throw new Error(Array.isArray(msg) ? msg.map(x => x.msg || JSON.stringify(x)).join(', ') : msg);
    }
    return res.json();
}

async function ensureSettingsApiKeyScopes() {
    if (settingsApiKeyScopesLoaded) return;
    const data = await settingsJson(`${API_BASE}/api-keys/scopes`);
    document.getElementById('settingsApiKeyScopes').innerHTML =
        data.scopes.map(s => `
            <label class="scope-option">
                <input type="checkbox" value="${settingsEsc(s)}" checked>
                <span>${settingsEsc(s)}</span>
            </label>
        `).join('');
    settingsApiKeyScopesLoaded = true;
}

async function initSettingsApiKeys() {
    try {
        await ensureSettingsApiKeyScopes();
        await loadSettingsApiKeys();
    } catch (e) {
        showAlert(e.message, 'error');
    }
}

async function loadSettingsApiKeys() {
    const body = document.getElementById('settingsApiKeyTableBody');
    if (!body) return;
    body.innerHTML = RoutarioTables.stateRow('Loading API keys...', 5);
    settingsApiKeys = (await settingsJson(`${API_BASE}/api-keys`)).filter(k => k.is_active);
    renderSettingsApiKeys();
}

function renderSettingsApiKeys() {
    const body = document.getElementById('settingsApiKeyTableBody');
    if (!body) return;
    const q = (document.getElementById('settingsApiKeySearch')?.value || '').toLowerCase();
    const rows = settingsApiKeys.filter(k =>
        (k.name || '').toLowerCase().includes(q) ||
        (k.key_prefix || '').toLowerCase().includes(q) ||
        (k.scopes || []).join(' ').toLowerCase().includes(q)
    );
    const count = document.getElementById('settingsApiKeyCount');
    if (count) count.textContent = `${rows.length} key${rows.length !== 1 ? 's' : ''}`;
    body.innerHTML = rows.length ? rows.map(k => `
        <tr class="device-row">
            <td><span class="device-row-name">${settingsEsc(k.name)}</span></td>
            <td style="font-family:var(--font-mono);font-size:0.82rem;">${settingsEsc(k.key_prefix)}...</td>
            <td style="font-size:0.82rem;color:var(--text-secondary);">${(k.scopes || []).map(settingsEsc).join(', ') || 'no scopes'}</td>
            <td style="white-space:nowrap;color:var(--text-secondary);font-size:0.82rem;">${k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'Never'}</td>
            <td style="text-align:right;">
                <button type="button" class="btn btn-danger btn-small" onclick="revokeSettingsApiKey(${k.id})"><i class="mdi mdi-key-remove"></i> Revoke</button>
            </td>
        </tr>
    `).join('') : RoutarioTables.stateRow('No active API keys found.', 5);
}

async function openApiKeyModal() {
    try {
        await ensureSettingsApiKeyScopes();
    } catch (e) {
        showAlert(e.message, 'error');
        return;
    }
    document.getElementById('settingsApiKeyName').value = '';
    document.querySelectorAll('#settingsApiKeyScopes input[type="checkbox"]').forEach(cb => { cb.checked = true; });
    document.getElementById('apiKeyModal').classList.add('active');
    setTimeout(() => document.getElementById('settingsApiKeyName')?.focus(), 50);
}

function closeApiKeyModal() {
    document.getElementById('apiKeyModal').classList.remove('active');
}

async function createSettingsApiKey() {
    try {
        const scopes = [...document.querySelectorAll('#settingsApiKeyScopes input:checked')].map(o => o.value);
        if (!scopes.length) throw new Error('Select at least one API scope');
        const key = await settingsJson(`${API_BASE}/api-keys`, {
            method: 'POST',
            body: JSON.stringify({
                name: document.getElementById('settingsApiKeyName').value.trim() || 'API Key',
                scopes,
            }),
        });
        const reveal = document.getElementById('settingsApiKeyReveal');
        reveal.style.display = '';
        reveal.innerHTML = `<strong>Copy now. This key will not be shown again.</strong><br>${settingsEsc(key.key)}`;
        document.getElementById('settingsApiKeyName').value = '';
        closeApiKeyModal();
        await loadSettingsApiKeys();
    } catch (e) {
        showAlert(e.message, 'error');
    }
}

async function revokeSettingsApiKey(id) {
    if (!confirm('Delete this API key? It will stop working immediately.')) return;
    try {
        await settingsJson(`${API_BASE}/api-keys/${id}`, { method: 'DELETE' });
        await loadSettingsApiKeys();
        showAlert('API key deleted', 'success');
    } catch (e) {
        showAlert(e.message, 'error');
    }
}
