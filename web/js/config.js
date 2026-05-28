// Global Configuration
// Change 'localhost' to your server IP if accessing from another machine
const API_BASE = '/api';
const WS_BASE_URL = `ws${location.protocol === 'https:' ? 's' : ''}://${location.host}/ws/`;

/**
 * Drop-in replacement for fetch() that automatically:
 *  - Attaches the Authorization: Bearer <token> header
 *  - Redirects to login if the server returns 401
 *
 * Usage: exactly like fetch(), e.g.
 *   const res = await apiFetch(`${API_BASE}/devices`);
 *   const res = await apiFetch(`${API_BASE}/users`, { method: 'POST', body: JSON.stringify(data) });
 */
async function apiFetch(url, options = {}) {
    const token = localStorage.getItem('auth_token');

    const headers = {
        ...(options.headers || {}),
    };

    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    // Only set Content-Type to JSON if there's a body and it hasn't been set already
    if (options.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, { ...options, headers });

    if (response.status === 401) {
        // Token expired or invalid — send back to login
        localStorage.removeItem('auth_token');
        localStorage.removeItem('user_id');
        localStorage.removeItem('username');
        localStorage.removeItem('is_admin');
        localStorage.removeItem('is_company_admin');
        localStorage.removeItem('company_id');
        window.location.href = 'login.html';
        return response; // won't reach, but keeps return type consistent
    }

    return response;
}

/**
 * Show a toast notification.
 * Accepts either showAlert(message, type, duration)
 * or showAlert({ title, message, type, duration }).
 */
function showAlert(messageOrData, type = 'info', duration = 3000) {
    let title = null, message, resolvedType = type, resolvedDuration = duration;

    if (messageOrData && typeof messageOrData === 'object') {
        message         = messageOrData.message || '';
        title           = messageOrData.title   || null;
        resolvedType    = messageOrData.type     || type;
        resolvedDuration = messageOrData.duration || duration;
    } else if (Array.isArray(messageOrData)) {
        message = messageOrData.map(e => e.msg || JSON.stringify(e)).join(', ');
    } else {
        message = String(messageOrData ?? '');
    }

    const icons = { success: 'mdi-check-circle', error: 'mdi-close-circle', warning: 'mdi-alert', info: 'mdi-information' };
    const icon  = icons[resolvedType] || 'mdi-information';

    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${resolvedType}`;
    toast.innerHTML = `
        <div class="toast-icon"><i class="mdi ${icon}"></i></div>
        <div class="toast-content">
            ${title ? `<div class="toast-title">${title}</div>` : ''}
            <div class="toast-message">${message}</div>
        </div>
        <button class="toast-close" onclick="this.closest('.toast').remove()" aria-label="Dismiss"><i class="mdi mdi-close"></i></button>
    `;
    container.appendChild(toast);

    setTimeout(() => {
        if (!toast.isConnected) return;
        toast.style.animation = 'slideInRight 0.3s reverse forwards';
        setTimeout(() => toast.remove(), 300);
    }, resolvedDuration);
}

function hasPermission(perm) {
    if (localStorage.getItem('is_admin') === 'true') return true;
    try {
        return JSON.parse(localStorage.getItem('permissions') || '[]').includes(perm);
    } catch { return false; }
}

function handleLogout() {
    ['auth_token','user_id','username','is_admin','units','is_company_admin','company_id',
     'permissions',
     'impersonating_admin_token','impersonating_admin_user_id','impersonating_admin_username']
        .forEach(k => localStorage.removeItem(k));
    window.location.href = 'login.html';
}

function checkLogin() {
    if (!localStorage.getItem('auth_token')) window.location.href = 'login.html';
}

function _esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDateToLocal(str) {
    if (!str) return 'N/A';
    if (!str.includes('Z') && !str.includes('+')) str += 'Z';
    return new Date(str).toLocaleString();
}

// Refresh permissions from the server on every page load so changes take
// effect without requiring a logout.  Resolves immediately when not logged in.
const permissionsReady = (function () {
    const token  = localStorage.getItem('auth_token');
    const userId = localStorage.getItem('user_id');
    if (!token || !userId) return Promise.resolve();
    return fetch(`${API_BASE}/users/${userId}`, {
        headers: { Authorization: `Bearer ${token}` },
    })
    .then(r => {
        if (r.status === 401) { handleLogout(); return null; }
        return r.ok ? r.json() : null;
    })
    .then(user => {
        if (!user) return;
        if (Array.isArray(user.permissions))
            localStorage.setItem('permissions', JSON.stringify(user.permissions));
        if (user.is_admin !== undefined)
            localStorage.setItem('is_admin', user.is_admin);
        if (user.is_company_admin !== undefined)
            localStorage.setItem('is_company_admin', user.is_company_admin);
        if (user.units)
            localStorage.setItem('units', user.units);
    })
    .catch(() => {}); // network failure: use cached value
})();