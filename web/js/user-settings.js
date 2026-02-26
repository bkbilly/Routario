// API_BASE is defined in config.js
const USER_ID = parseInt(localStorage.getItem('user_id') || 1);
let channels = [];
let allDevices = [];
let currentUserDevices = new Set();
let currentAssignUserId = null;

// Auth Check
function checkLogin() {
    if (!localStorage.getItem('auth_token')) {
        window.location.href = 'login.html';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    checkLogin();
    loadSettings();
    
    // Check if admin (ID 1 for simplicity)
    if (localStorage.getItem('is_admin') === 'true') {
        document.getElementById('adminPanel').style.display = 'block';
        loadAllUsers();
        loadAllDevices();
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
        
        channels = user.notification_channels || [];
        renderChannels();
        
    } catch (error) {
        console.error('Settings load error:', error);
        showAlert(error.message, 'error');
    }
}

async function loadAllUsers() {
    try {
        const res = await apiFetch(`${API_BASE}/users`);
        if (res.ok) {
            const users = await res.json();
            // Load device counts for each user
            for (const user of users) {
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

function renderUserList(users) {
    const container = document.getElementById('userList');
    container.innerHTML = '';
    
    users.forEach(u => {
        if (u.id === parseInt(localStorage.getItem('user_id'))) return; // Don't allow deleting self/admin from list
        
        const div = document.createElement('div');
        div.className = 'user-list-item';
        
        const deviceCountText = u.deviceCount !== undefined 
            ? `${u.deviceCount} device${u.deviceCount !== 1 ? 's' : ''}`
            : '';

        div.innerHTML = `
            <div class="user-info">
                <span class="user-name">${u.username}</span>
                <span class="user-email">${u.email} · ${deviceCountText}</span>
            </div>
            <div class="user-actions">
                <button type="button" class="btn btn-secondary" style="padding: 0.4rem 0.8rem; font-size: 0.75rem;" onclick="openAssignModal(${u.id}, '${u.username}')">
                    Devices
                </button>
                <button type="button" class="btn btn-secondary" style="padding: 0.4rem 0.8rem; font-size: 0.75rem;" onclick="promptPasswordChange(${u.id})">
                    Password
                </button>
                <button type="button" class="btn btn-danger" style="padding: 0.4rem 0.8rem; font-size: 0.75rem;" onclick="deleteUser(${u.id})">
                    Delete
                </button>
            </div>
        `;
        container.appendChild(div);
    });
}

function renderAssignList() {
    const list = document.getElementById('deviceAssignList');
    const search = document.getElementById('deviceSearch')?.value.toLowerCase() || '';
    list.innerHTML = '';

    allDevices
        .filter(d => d.name.toLowerCase().includes(search) || d.imei.includes(search))
        .forEach(d => {
            const div = document.createElement('div');
            div.className = 'user-list-item';
            div.innerHTML = `
                <div class="user-info">
                    <span class="user-name">${d.name}</span>
                    <span class="user-email">${d.imei}</span>
                </div>
                <label class="toggle-switch">
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

async function openAssignModal(userId, username) {
    currentAssignUserId = userId;
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

function closeAssignModal() {
    document.getElementById('assignModal').classList.remove('active');
}

async function addNewUser() {
    const username = document.getElementById('newUserName').value;
    const email = document.getElementById('newUserEmail').value;
    const password = document.getElementById('newUserPass').value;
    
    if (!username || !email || !password) {
        showAlert('Please fill all fields', 'error');
        return;
    }

    try {
        const res = await apiFetch(`${API_BASE}/users`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username, email, password })
        });
        
        if (res.ok) {
            showAlert('User created', 'success');
            document.getElementById('newUserName').value = '';
            document.getElementById('newUserEmail').value = '';
            document.getElementById('newUserPass').value = '';
            loadAllUsers();
        } else {
            const err = await res.json();
            const message = typeof err.detail === 'string' 
                ? err.detail 
                : Array.isArray(err.detail) 
                    ? err.detail.map(e => e.msg).join(', ') 
                    : 'Error creating user';
            showAlert(message, 'error');
        }
    } catch (e) { showAlert('Connection error', 'error'); }
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
            <td class="channel-url-cell">${channel.url}</td>
            <td style="text-align: right;">
                <button type="button" class="btn btn-danger" style="padding: 0.4rem 0.8rem; font-size: 0.75rem;" onclick="removeChannel(${index})">
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

    const payload = {
        email: document.getElementById('email').value,
        notification_channels: channels 
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

function showAlert(message, type) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast`;
    toast.innerHTML = `
        <div class="toast-icon">${type === 'success' ? '✓' : '✕'}</div>
        <div class="toast-message">${message}</div>
    `;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s reverse forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}