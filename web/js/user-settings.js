// API_BASE is defined in config.js
const USER_ID          = parseInt(localStorage.getItem('user_id') || 1);
const IS_ADMIN         = localStorage.getItem('is_admin') === 'true';
const IS_COMPANY_ADMIN = localStorage.getItem('is_company_admin') === 'true';
const MY_COMPANY_ID    = parseInt(localStorage.getItem('company_id') || '0') || null;
let channels = [];
let webhooks = [];
let settingsApiKeyScopesLoaded = false;
let settingsMfaSetupPending = false;

function settingsEsc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
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

    if (IS_ADMIN || IS_COMPANY_ADMIN) {
        const adminTab = document.getElementById('settingsTabAdmin');
        if (adminTab) adminTab.style.display = '';
        const backupSection = document.getElementById('backupSection');
        if (backupSection) backupSection.style.display = IS_ADMIN ? '' : 'none';
        const companyLink = document.getElementById('companyMgmtLink');
        if (companyLink) companyLink.style.display = IS_ADMIN ? '' : 'none';
    }
    const hash = window.location.hash.replace('#', '');
    switchSettingsTab(['profile', 'notifications', 'webhooks', 'apiKeys', 'mfa', 'admin'].includes(hash) ? hash : 'profile', false);
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeApiKeyModal();
});

function switchSettingsTab(name, pushState = true) {
    const sections = ['profile', 'notifications', 'webhooks', 'apiKeys', 'mfa', 'admin'];
    if (!sections.includes(name)) name = 'profile';
    if (name === 'admin' && !(IS_ADMIN || IS_COMPANY_ADMIN)) name = 'profile';
    if (name === 'apiKeys' && !hasPermission('manage_api_keys')) name = 'profile';
    if (name === 'mfa' && !hasPermission('manage_mfa')) name = 'profile';
    sections.forEach(section => {
        const panel = document.getElementById(`settings-section-${section}`);
        if (panel) panel.style.display = section === name ? '' : 'none';
        const tab = document.getElementById('settingsTab' + section.charAt(0).toUpperCase() + section.slice(1));
        if (tab) tab.classList.toggle('active', section === name);
    });
    if (pushState) history.replaceState(null, '', '#' + name);
    if (name === 'apiKeys') initSettingsApiKeys();
    if (name === 'mfa') initSettingsMfa();
}

function applySettingsPermissions() {
    const apiTab = document.getElementById('settingsTabApiKeys');
    if (apiTab) apiTab.style.display = hasPermission('manage_api_keys') ? '' : 'none';
    const mfaTab = document.getElementById('settingsTabMfa');
    if (mfaTab) mfaTab.style.display = hasPermission('manage_mfa') ? '' : 'none';
}

window.addEventListener('hashchange', () => {
    const hash = window.location.hash.replace('#', '');
    switchSettingsTab(hash || 'profile', false);
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
        showAlert(`Restore complete. Backup from ${data.created_at}. Please restart the server.`, 'success', 8000);

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

async function settingsJson(url, options = {}) {
    const res = await apiFetch(url, options);
    if (!res.ok) {
        let msg = `Request failed (${res.status})`;
        try { msg = (await res.json()).detail || msg; } catch {}
        throw new Error(Array.isArray(msg) ? msg.map(x => x.msg || JSON.stringify(x)).join(', ') : msg);
    }
    return res.json();
}

async function initSettingsApiKeys() {
    try {
        if (!settingsApiKeyScopesLoaded) {
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
        await loadSettingsApiKeys();
    } catch (e) {
        showAlert(e.message, 'error');
    }
}

async function loadSettingsApiKeys() {
    const body = document.getElementById('settingsApiKeyTableBody');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="5" style="color:var(--text-muted);padding:1rem 0;text-align:center;">Loading API keys...</td></tr>';
    const keys = (await settingsJson(`${API_BASE}/api-keys`)).filter(k => k.is_active);
    body.innerHTML = keys.length ? keys.map(k => `
        <tr>
            <td>${settingsEsc(k.name)}</td>
            <td style="font-family:var(--font-mono);font-size:0.82rem;">${settingsEsc(k.key_prefix)}...</td>
            <td style="font-size:0.82rem;color:var(--text-secondary);">${(k.scopes || []).map(settingsEsc).join(', ') || 'no scopes'}</td>
            <td style="white-space:nowrap;color:var(--text-secondary);font-size:0.82rem;">${k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'Never'}</td>
            <td style="text-align:right;">
                <button type="button" class="btn btn-danger btn-small" onclick="revokeSettingsApiKey(${k.id})"><i class="mdi mdi-key-remove"></i> Revoke</button>
            </td>
        </tr>
    `).join('') : '<tr><td colspan="5" style="color:var(--text-muted);padding:1rem 0;text-align:center;">No active API keys.</td></tr>';
}

function openApiKeyModal() {
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

async function initSettingsMfa() {
    try {
        const s = await settingsJson(`${API_BASE}/mfa/status`);
        document.getElementById('settingsMfaStatus').innerHTML =
            `<div class="settings-list-item">MFA is <strong>${s.enabled ? 'enabled' : 'disabled'}</strong>.</div>`;
        renderSettingsMfaControls(Boolean(s.enabled));
    } catch (e) {
        showAlert(e.message, 'error');
    }
}

function renderSettingsMfaControls(enabled) {
    const setupBtn = document.getElementById('settingsMfaSetupBtn');
    const enableBtn = document.getElementById('settingsMfaEnableBtn');
    const disableBtn = document.getElementById('settingsMfaDisableBtn');
    const codeGroup = document.getElementById('settingsMfaCodeGroup');
    const codeLabel = document.getElementById('settingsMfaCodeLabel');
    const setupBox = document.getElementById('settingsMfaSetupBox');

    if (enabled) {
        settingsMfaSetupPending = false;
        setupBtn.style.display = 'none';
        enableBtn.style.display = 'none';
        disableBtn.style.display = 'inline-flex';
        codeGroup.style.display = '';
        codeLabel.textContent = 'Authenticator or Recovery Code';
        if (setupBox) setupBox.style.display = 'none';
    } else {
        setupBtn.style.display = 'inline-flex';
        enableBtn.style.display = settingsMfaSetupPending ? 'inline-flex' : 'none';
        disableBtn.style.display = 'none';
        codeGroup.style.display = settingsMfaSetupPending ? '' : 'none';
        codeLabel.textContent = 'Authenticator Code';
    }
}

async function setupSettingsMfa() {
    try {
        const data = await settingsJson(`${API_BASE}/mfa/setup`, { method: 'POST' });
        settingsMfaSetupPending = true;
        const box = document.getElementById('settingsMfaSetupBox');
        box.style.display = '';
        box.innerHTML = `<div id="settingsMfaQr"></div><strong>Secret:</strong><br>${settingsEsc(data.secret)}<br><br><strong>Recovery Codes:</strong><br>${data.recovery_codes.map(settingsEsc).join('<br>')}`;
        const qrEl = document.getElementById('settingsMfaQr');
        if (window.QRCode && qrEl) {
            new QRCode(qrEl, { text: data.provisioning_uri, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
        } else if (qrEl) {
            qrEl.textContent = data.provisioning_uri;
        }
        renderSettingsMfaControls(false);
    } catch (e) {
        showAlert(e.message, 'error');
    }
}

async function enableSettingsMfa() {
    try {
        await settingsJson(`${API_BASE}/mfa/enable`, {
            method: 'POST',
            body: JSON.stringify({ code: document.getElementById('settingsMfaCode').value }),
        });
        showAlert('MFA enabled', 'success');
        settingsMfaSetupPending = false;
        document.getElementById('settingsMfaCode').value = '';
        await initSettingsMfa();
    } catch (e) {
        showAlert(e.message, 'error');
    }
}

async function disableSettingsMfa() {
    try {
        await settingsJson(`${API_BASE}/mfa/disable`, {
            method: 'POST',
            body: JSON.stringify({ code: document.getElementById('settingsMfaCode').value }),
        });
        showAlert('MFA disabled', 'success');
        settingsMfaSetupPending = false;
        document.getElementById('settingsMfaCode').value = '';
        document.getElementById('settingsMfaSetupBox').style.display = 'none';
        await initSettingsMfa();
    } catch (e) {
        showAlert(e.message, 'error');
    }
}
