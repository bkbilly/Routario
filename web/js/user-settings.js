// API_BASE is defined in config.js
const USER_ID          = parseInt(localStorage.getItem('user_id') || 1);
const IS_ADMIN         = localStorage.getItem('is_admin') === 'true';
const IS_COMPANY_ADMIN = localStorage.getItem('is_company_admin') === 'true';
const MY_COMPANY_ID    = parseInt(localStorage.getItem('company_id') || '0') || null;
let channels = [];
let webhooks = [];
let profileUser = null;
let passkeys = [];
let profileMfaSetupPending = false;
let settingsApiKeys = [];
let settingsApiKeyScopesLoaded = false;
let notificationSort = { col: 'name', dir: 1 };
let webhookSort = { col: 'url', dir: 1 };
let settingsApiKeySort = { col: 'name', dir: 1 };
let currentSettingsTab = 'profile';
const SETTINGS_TABS = ['profile', 'users', 'webhooks', 'apiKeys', 'backups'].map(name => ({
    name,
    panelId: `settings-section-${name}`,
    tabId: 'settingsTab' + name.charAt(0).toUpperCase() + name.slice(1),
}));

function settingsEsc(value) {
    return RoutarioUI.escapeHtml(value);
}

function settingsCompareValues(a, b, dir = 1) {
    const av = a === null || a === undefined || a === '' ? null : a;
    const bv = b === null || b === undefined || b === '' ? null : b;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;

    if (av instanceof Date || bv instanceof Date) {
        const at = av instanceof Date ? av.getTime() : new Date(av).getTime();
        const bt = bv instanceof Date ? bv.getTime() : new Date(bv).getTime();
        return ((Number.isNaN(at) ? 0 : at) - (Number.isNaN(bt) ? 0 : bt)) * dir;
    }

    if (typeof av === 'number' && typeof bv === 'number') {
        return (av - bv) * dir;
    }

    return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * dir;
}

function settingsToggleSort(sortState, col) {
    return RoutarioTables.toggleNumericSort(sortState.col, sortState.dir, col);
}

function sortNotificationChannels(col) {
    notificationSort = settingsToggleSort(notificationSort, col);
    renderChannels();
}

function sortWebhooks(col) {
    webhookSort = settingsToggleSort(webhookSort, col);
    renderWebhooks();
}

function sortSettingsApiKeys(col) {
    settingsApiKeySort = settingsToggleSort(settingsApiKeySort, col);
    renderSettingsApiKeys();
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
    switchSettingsTab(['profile', 'users', 'webhooks', 'apiKeys', 'backups'].includes(hash) ? hash : currentSettingsTab, false);
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
    const fallback = 'profile';
    const sections = ['profile', 'users', 'webhooks', 'apiKeys', 'backups'];
    if (!sections.includes(name)) name = fallback;
    if (name === 'users' && !hasPermission('manage_users')) name = fallback;
    if (name === 'backups' && !((IS_ADMIN || IS_COMPANY_ADMIN) && hasPermission('manage_backups'))) name = fallback;
    if (name === 'apiKeys' && !hasPermission('manage_api_keys')) name = fallback;
    currentSettingsTab = name;
    RoutarioTabs.activate(SETTINGS_TABS, name);
    if (pushState) RoutarioTabs.replaceHash(name);
    if (name === 'profile') initProfileSection();
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

        profileUser = user;
        renderProfile();

        webhooks = user.webhook_urls || [];
        renderWebhooks();

        channels = user.notification_channels || [];
        renderChannels();

    } catch (error) {
        console.error('Settings load error:', error);
        showAlert(error.message, 'error');
    }
}

function renderProfile() {
    if (!profileUser) return;
    document.getElementById('profileUsername').value = profileUser.username || '';
    document.getElementById('profileEmail').value = profileUser.email || '';
    document.getElementById('profilePassword').value = '';
    document.getElementById('profileUnits').value = profileUser.units || 'metric';
    renderProfileCurrencyOptions(profileUser.currency || 'EUR');
    const supported = Boolean(window.PublicKeyCredential);
    const note = document.getElementById('passkeySupportNote');
    const btn = document.getElementById('passkeyRegisterBtn');
    if (note) note.style.display = supported ? 'none' : '';
    if (btn) btn.disabled = !supported;
}

function renderProfileCurrencyOptions(selected = 'EUR') {
    const select = document.getElementById('profileCurrency');
    if (!select) return;
    const options = typeof CURRENCY_OPTIONS !== 'undefined' ? CURRENCY_OPTIONS : [['EUR', 'Euro (€)']];
    select.innerHTML = options.map(([code, label]) => `<option value="${settingsEsc(code)}" ${code === selected ? 'selected' : ''}>${settingsEsc(label)}</option>`).join('');
}

window.addEventListener('routario:currencyrateschange', () => {
    const select = document.getElementById('profileCurrency');
    if (select) renderProfileCurrencyOptions(select.value || 'EUR');
});

async function initProfileSection() {
    renderProfile();
    await initProfileMfaPanel();
    await loadPasskeys();
}

async function saveProfile() {
    const payload = {
        email: document.getElementById('profileEmail').value.trim(),
        units: document.getElementById('profileUnits').value,
        currency: document.getElementById('profileCurrency').value,
    };
    const password = document.getElementById('profilePassword').value;
    if (password) payload.password = password;

    const btn = document.getElementById('profileSaveBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i> Saving';
    try {
        const saved = await settingsJson(`${API_BASE}/users/${USER_ID}`, {
            method: 'PUT',
            body: JSON.stringify(payload),
        });
        profileUser = saved;
        localStorage.setItem('units', saved.units || payload.units);
        localStorage.setItem('currency', saved.currency || payload.currency);
        window.dispatchEvent(new Event('routario:currencychange'));
        renderProfile();
        showAlert('Profile saved', 'success');
    } catch (e) {
        showAlert(e.message || 'Profile save failed', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="mdi mdi-content-save"></i> Save Profile';
    }
}

function b64urlToBuffer(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from(raw, c => c.charCodeAt(0)).buffer;
}

function bufferToB64url(buffer) {
    const bytes = new Uint8Array(buffer || []);
    let raw = '';
    bytes.forEach(b => { raw += String.fromCharCode(b); });
    return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function parsePasskeyOptions(optionsJson, mode) {
    const options = typeof optionsJson === 'string' ? JSON.parse(optionsJson) : optionsJson;
    options.challenge = b64urlToBuffer(options.challenge);
    if (mode === 'create') {
        options.user.id = b64urlToBuffer(options.user.id);
        options.excludeCredentials = (options.excludeCredentials || []).map(c => ({ ...c, id: b64urlToBuffer(c.id) }));
    } else {
        options.allowCredentials = (options.allowCredentials || []).map(c => ({ ...c, id: b64urlToBuffer(c.id) }));
    }
    return options;
}

function passkeyCredentialToJson(credential) {
    const response = credential.response;
    const data = {
        id: credential.id,
        rawId: bufferToB64url(credential.rawId),
        type: credential.type,
        clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
        response: {
            clientDataJSON: bufferToB64url(response.clientDataJSON),
        },
    };
    if (credential.authenticatorAttachment) data.authenticatorAttachment = credential.authenticatorAttachment;
    if (response.attestationObject) data.response.attestationObject = bufferToB64url(response.attestationObject);
    if (response.authenticatorData) data.response.authenticatorData = bufferToB64url(response.authenticatorData);
    if (response.signature) data.response.signature = bufferToB64url(response.signature);
    if (response.userHandle) data.response.userHandle = bufferToB64url(response.userHandle);
    return data;
}

async function loadPasskeys() {
    const list = document.getElementById('passkeyList');
    if (!list) return;
    list.innerHTML = '<div class="profile-passkey-state">Loading passkeys...</div>';
    try {
        passkeys = await settingsJson(`${API_BASE}/passkeys`);
        renderPasskeys();
    } catch (e) {
        list.innerHTML = `<div class="profile-passkey-state">${settingsEsc(e.message || 'Unable to load passkeys')}</div>`;
    }
}

function renderPasskeys() {
    const list = document.getElementById('passkeyList');
    if (!list) return;
    if (!passkeys.length) {
        list.innerHTML = '<div class="profile-passkey-state">No passkeys registered.</div>';
        return;
    }
    list.innerHTML = passkeys.map(k => `
        <div class="profile-passkey-row">
            <div class="profile-passkey-info">
                <div class="profile-passkey-name">${settingsEsc(k.name || 'Passkey')}</div>
                <div class="profile-passkey-meta">Last used: ${k.last_used_at ? formatDateToLocal(k.last_used_at) : 'Never'}</div>
            </div>
            <div class="profile-passkey-actions">
                <button type="button" class="btn btn-secondary btn-small" onclick="renamePasskey(${k.id})" title="Rename"><i class="mdi mdi-pencil"></i></button>
                <button type="button" class="btn btn-danger btn-small" onclick="deletePasskey(${k.id})" title="Remove"><i class="mdi mdi-delete"></i></button>
            </div>
        </div>
    `).join('');
}

async function registerPasskey() {
    if (!window.PublicKeyCredential) {
        showAlert('Passkeys are not supported by this browser', 'error');
        return;
    }
    const name = prompt('Name this passkey', navigator.userAgent.includes('Mobile') ? 'Mobile passkey' : 'Passkey');
    if (name === null) return;
    const btn = document.getElementById('passkeyRegisterBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i> Waiting';
    try {
        const challenge = await settingsJson(`${API_BASE}/passkeys/register/options`, { method: 'POST' });
        const credential = await navigator.credentials.create({
            publicKey: parsePasskeyOptions(challenge.options, 'create'),
        });
        await settingsJson(`${API_BASE}/passkeys/register/verify`, {
            method: 'POST',
            body: JSON.stringify({
                state: challenge.state,
                credential: passkeyCredentialToJson(credential),
                name: name.trim() || null,
            }),
        });
        showAlert('Passkey added', 'success');
        await loadPasskeys();
    } catch (e) {
        showAlert(e.name === 'NotAllowedError' ? 'Passkey registration was cancelled' : (e.message || 'Passkey registration failed'), 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="mdi mdi-fingerprint"></i> Add Passkey';
    }
}

async function deletePasskey(id) {
    if (!confirm('Remove this passkey?')) return;
    try {
        await settingsJson(`${API_BASE}/passkeys/${id}`, { method: 'DELETE' });
        await loadPasskeys();
        showAlert('Passkey removed', 'success');
    } catch (e) {
        showAlert(e.message || 'Unable to remove passkey', 'error');
    }
}

async function renamePasskey(id) {
    const key = passkeys.find(k => k.id === id);
    const name = prompt('Passkey name', key?.name || 'Passkey');
    if (name === null) return;
    try {
        await settingsJson(`${API_BASE}/passkeys/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ name: name.trim() || 'Passkey' }),
        });
        await loadPasskeys();
        showAlert('Passkey renamed', 'success');
    } catch (e) {
        showAlert(e.message || 'Unable to rename passkey', 'error');
    }
}

async function initProfileMfaPanel() {
    profileMfaSetupPending = false;
    document.getElementById('profileMfaSetupBox').style.display = 'none';
    document.getElementById('profileMfaSetupBox').innerHTML = '';
    document.getElementById('profileMfaCode').value = '';
    renderProfileMfaControls(false, true, 'Loading MFA status...');
    try {
        const status = await settingsJson(`${API_BASE}/mfa/status`);
        renderProfileMfaControls(Boolean(status.enabled));
    } catch (e) {
        renderProfileMfaControls(false, true, e.message || 'Unable to load MFA status');
    }
}

function renderProfileMfaControls(enabled, disabled = false, message = null) {
    const statusEl = document.getElementById('profileMfaStatus');
    const codeGroup = document.getElementById('profileMfaCodeGroup');
    const codeLabel = document.getElementById('profileMfaCodeLabel');
    const setupBtn = document.getElementById('profileMfaSetupBtn');
    const enableBtn = document.getElementById('profileMfaEnableBtn');
    const disableBtn = document.getElementById('profileMfaDisableBtn');
    const setupBox = document.getElementById('profileMfaSetupBox');
    if (!statusEl || !codeGroup || !setupBtn || !enableBtn || !disableBtn) return;

    statusEl.textContent = message || (enabled ? 'MFA is enabled for your account.' : 'MFA is not enabled for your account.');
    setupBtn.disabled = disabled;
    enableBtn.disabled = disabled;
    disableBtn.disabled = disabled;
    setupBtn.style.display = !enabled ? 'inline-flex' : 'none';
    enableBtn.style.display = !enabled && profileMfaSetupPending ? 'inline-flex' : 'none';
    disableBtn.style.display = enabled ? 'inline-flex' : 'none';
    codeGroup.style.display = ((!enabled && profileMfaSetupPending) || enabled) ? '' : 'none';
    codeLabel.textContent = enabled ? 'Authenticator or Recovery Code' : 'Authenticator Code';
    if (enabled && setupBox) setupBox.style.display = 'none';
}

async function profileSetupMfa() {
    try {
        const data = await settingsJson(`${API_BASE}/mfa/setup`, { method: 'POST' });
        const box = document.getElementById('profileMfaSetupBox');
        box.style.display = '';
        box.innerHTML = `
            <div id="profileMfaQr" style="display:flex;justify-content:center;margin-bottom:0.75rem;"></div>
            <div style="font-size:0.78rem;color:var(--text-secondary);font-family:var(--font-sans);margin-bottom:0.35rem;">Recovery codes</div>
            <div>${(data.recovery_codes || []).map(settingsEsc).join('<br>')}</div>
        `;
        if (window.QRCode && data.provisioning_uri) {
            new QRCode(document.getElementById('profileMfaQr'), {
                text: data.provisioning_uri,
                width: 160,
                height: 160,
                colorDark: '#111827',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.H,
            });
        }
        profileMfaSetupPending = true;
        document.getElementById('profileMfaCode').value = '';
        renderProfileMfaControls(false);
    } catch (e) {
        showAlert(e.message || 'MFA setup failed', 'error');
    }
}

async function profileEnableMfa() {
    const code = document.getElementById('profileMfaCode').value.trim();
    if (!code) {
        document.getElementById('profileMfaCode').focus();
        return;
    }
    try {
        await settingsJson(`${API_BASE}/mfa/enable`, {
            method: 'POST',
            body: JSON.stringify({ code }),
        });
        showAlert('MFA enabled', 'success');
        await initProfileMfaPanel();
    } catch (e) {
        showAlert(e.message || 'MFA enable failed', 'error');
    }
}

async function profileDisableMfa() {
    const code = document.getElementById('profileMfaCode').value.trim();
    if (!code) {
        document.getElementById('profileMfaCode').focus();
        return;
    }
    try {
        await settingsJson(`${API_BASE}/mfa/disable`, {
            method: 'POST',
            body: JSON.stringify({ code }),
        });
        showAlert('MFA disabled', 'success');
        await initProfileMfaPanel();
    } catch (e) {
        showAlert(e.message || 'MFA disable failed', 'error');
    }
}

function renderWebhooks() {
    const tbody = document.getElementById('webhookListBody');
    if (!tbody) return;
    const q = (document.getElementById('webhookSearch')?.value || '').toLowerCase();
    const rows = webhooks
        .filter(url => url.toLowerCase().includes(q))
        .sort((a, b) => settingsCompareValues(a, b, webhookSort.dir));
    const count = document.getElementById('webhookCount');
    if (count) count.textContent = `${rows.length} webhook${rows.length !== 1 ? 's' : ''}`;
    RoutarioTables.updateSortHeaders('settings-section-webhooks', {
        col: webhookSort.col,
        dir: webhookSort.dir === 1 ? 'asc' : 'desc',
    });
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
    if (!body) return;
    body.innerHTML = '';
    const q = (document.getElementById('notificationSearch')?.value || '').toLowerCase();
    const rows = channels
        .filter(channel =>
            (channel.name || '').toLowerCase().includes(q) ||
            (channel.url || '').toLowerCase().includes(q)
        )
        .sort((a, b) => settingsCompareValues(a[notificationSort.col], b[notificationSort.col], notificationSort.dir));
    const count = document.getElementById('channelCount');
    if (count) count.textContent = `${rows.length} channel${rows.length !== 1 ? 's' : ''}`;
    RoutarioTables.updateSortHeaders('settings-section-notifications', {
        col: notificationSort.col,
        dir: notificationSort.dir === 1 ? 'asc' : 'desc',
    });
    
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
            <td class="channel-url-cell">${settingsEsc(channel.url)}</td>
            <td style="text-align: right;">
                <button type="button" class="btn btn-secondary btn-small" id="channelTestBtn${index}" onclick="testChannel(${index})">
                    <i class="mdi mdi-send-check"></i> Test
                </button>
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

async function testChannel(index) {
    const channel = channels[index];
    if (!channel) return;

    const btn = document.getElementById(`channelTestBtn${index}`);
    const original = btn?.innerHTML;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i> Testing';
    }

    try {
        const res = await apiFetch(`${API_BASE}/users/${USER_ID}/notifications/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: channel.name, url: channel.url }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to send test notification');
        }
        showAlert('Test notification sent', 'success');
    } catch (error) {
        console.error('Test notification error:', error);
        showAlert(error.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    }
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
    const rows = settingsApiKeys
        .filter(k =>
            (k.name || '').toLowerCase().includes(q) ||
            (k.key_prefix || '').toLowerCase().includes(q) ||
            (k.scopes || []).join(' ').toLowerCase().includes(q)
        )
        .sort((a, b) => settingsCompareValues(settingsApiKeySortValue(a), settingsApiKeySortValue(b), settingsApiKeySort.dir));
    const count = document.getElementById('settingsApiKeyCount');
    if (count) count.textContent = `${rows.length} key${rows.length !== 1 ? 's' : ''}`;
    RoutarioTables.updateSortHeaders('settings-section-apiKeys', {
        col: settingsApiKeySort.col,
        dir: settingsApiKeySort.dir === 1 ? 'asc' : 'desc',
    });
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

function settingsApiKeySortValue(key) {
    if (settingsApiKeySort.col === 'prefix') return key.key_prefix || '';
    if (settingsApiKeySort.col === 'scopes') return (key.scopes || []).join(', ');
    if (settingsApiKeySort.col === 'last_used') return key.last_used_at ? new Date(key.last_used_at) : null;
    return key.name || '';
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
