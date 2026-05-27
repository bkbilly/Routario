// API_BASE is defined in config.js
const USER_ID          = parseInt(localStorage.getItem('user_id') || 1);
const IS_ADMIN         = localStorage.getItem('is_admin') === 'true';
const IS_COMPANY_ADMIN = localStorage.getItem('is_company_admin') === 'true';
const MY_COMPANY_ID    = parseInt(localStorage.getItem('company_id') || '0') || null;
let channels = [];
let webhooks = [];

function maskUrl(url) {
    const schemeEnd = url.indexOf('://');
    if (schemeEnd === -1) return url.slice(0, 6) + '....';
    const scheme = url.slice(0, schemeEnd + 3); // e.g. "pbul://"
    return scheme + '....';
}

document.addEventListener('DOMContentLoaded', () => {
    checkLogin();
    loadSettings();

    if (IS_ADMIN || IS_COMPANY_ADMIN) {
        document.getElementById('adminPanel').style.display = 'block';
        const backupSection = document.getElementById('backupSection');
        if (backupSection) backupSection.style.display = IS_ADMIN ? '' : 'none';
        const companyLink = document.getElementById('companyMgmtLink');
        if (companyLink) companyLink.style.display = IS_ADMIN ? '' : 'none';
    } else {
        document.getElementById('accountInfoCard').style.display = '';
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


