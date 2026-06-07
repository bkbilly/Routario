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
    if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
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
    const loginSlug = localStorage.getItem('company_login_slug');
    const slugCompanyId = localStorage.getItem('company_login_slug_company_id');
    const currentCompanyId = localStorage.getItem('company_id');
    const loginUrl = loginSlug && slugCompanyId && currentCompanyId && slugCompanyId === currentCompanyId
        ? `/login/${encodeURIComponent(loginSlug)}`
        : '/login.html';
    ['auth_token','user_id','username','is_admin','units','is_company_admin','company_id',
     'permissions',
     'impersonating_admin_token','impersonating_admin_user_id','impersonating_admin_username']
        .forEach(k => localStorage.removeItem(k));
    window.location.href = loginUrl;
}

function checkLogin() {
    if (!localStorage.getItem('auth_token')) window.location.href = 'login.html';
}

function _setHeadLink(rel, href) {
    let link = document.querySelector(`link[rel="${rel}"]`);
    if (!link) {
        link = document.createElement('link');
        link.rel = rel;
        document.head.appendChild(link);
    }
    link.href = href;
}

function _defaultTitleForPage() {
    const title = document.documentElement.dataset.defaultTitle || document.title || 'Routario';
    return title.includes(' - Routario') ? title.replace(' - Routario', '') : title.replace('Routario', '').trim();
}

async function applyCompanyBranding(companyId = localStorage.getItem('company_id')) {
    const cid = parseInt(companyId || '0', 10) || null;
    if (!cid) return;
    if (!document.documentElement.dataset.defaultTitle) {
        document.documentElement.dataset.defaultTitle = document.title || 'Routario';
    }

    const base = `/branding/company/${cid}`;
    _setHeadLink('manifest', `/manifest.json?company_id=${cid}`);
    _setHeadLink('icon', `${base}/favicon.ico`);
    _setHeadLink('apple-touch-icon', `${base}/apple-touch-icon.png`);

    try {
        const res = await fetch(`${base}/metadata`);
        if (!res.ok) return;
        const meta = await res.json();
        const version = meta.branding_version || 1;
        if (meta.login_slug) {
            localStorage.setItem('company_login_slug', meta.login_slug);
            localStorage.setItem('company_login_slug_company_id', String(cid));
        } else {
            localStorage.removeItem('company_login_slug');
            localStorage.removeItem('company_login_slug_company_id');
        }
        _setHeadLink('manifest', `/manifest.json?company_id=${cid}&v=${version}`);
        if (meta.icon_url) {
            _setHeadLink('icon', `${base}/favicon.ico?v=${version}`);
            _setHeadLink('apple-touch-icon', `${base}/apple-touch-icon.png?v=${version}`);
            document.querySelectorAll('.logo-icon').forEach(img => { img.src = `${base}/icon-192.png?v=${version}`; });
        } else {
            document.querySelectorAll('.logo-icon').forEach(img => { img.src = '/icons/icon-192.png'; });
        }
        if (meta.app_name) {
            const page = _defaultTitleForPage();
            document.title = page ? `${page} - ${meta.app_name}` : meta.app_name;
            const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
            if (appleTitle) appleTitle.content = meta.app_name;
            document.querySelectorAll('.logo-text').forEach(el => { el.textContent = meta.app_name; });
        } else {
            document.title = document.documentElement.dataset.defaultTitle || document.title;
            const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
            if (appleTitle) appleTitle.content = 'Routario';
            document.querySelectorAll('.logo-text').forEach(el => { el.textContent = 'Routario'; });
        }
    } catch {
        // Branding is cosmetic; keep the default Routario assets if it fails.
    }
}

async function applyCompanyLoginBranding(companySlug) {
    const slug = String(companySlug || '').trim().toLowerCase();
    if (!slug) return null;
    if (!document.documentElement.dataset.defaultTitle) {
        document.documentElement.dataset.defaultTitle = document.title || 'Routario';
    }

    try {
        const res = await fetch(`/branding/login/${encodeURIComponent(slug)}/metadata`);
        if (!res.ok) return null;
        const meta = await res.json();
        if (!meta.company_id) return null;
        if (meta.login_slug) {
            localStorage.setItem('company_login_slug', meta.login_slug);
            localStorage.setItem('company_login_slug_company_id', String(meta.company_id));
        }

        const version = meta.branding_version || 1;
        const base = `/branding/company/${meta.company_id}`;
        _setHeadLink('manifest', `/manifest.json?company_slug=${encodeURIComponent(slug)}&v=${version}`);

        if (meta.icon_url) {
            _setHeadLink('icon', `${base}/favicon.ico?v=${version}`);
            _setHeadLink('apple-touch-icon', `${base}/apple-touch-icon.png?v=${version}`);
            document.querySelectorAll('.logo-icon').forEach(img => { img.src = `${base}/icon-192.png?v=${version}`; });
        }
        if (meta.app_name) {
            const page = _defaultTitleForPage();
            document.title = page ? `${page} - ${meta.app_name}` : meta.app_name;
            const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
            if (appleTitle) appleTitle.content = meta.app_name;
            document.querySelectorAll('.logo-text').forEach(el => { el.textContent = meta.app_name; });
        }
        return meta;
    } catch {
        return null;
    }
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
// effect without requiring a logout.  Resolves with the user object (or null)
// so callers can reuse the data without a second fetch.
const permissionsReady = (function () {
    const token  = localStorage.getItem('auth_token');
    const userId = localStorage.getItem('user_id');
    if (!token || !userId) return Promise.resolve(null);
    return fetch(`${API_BASE}/users/${userId}`, {
        headers: { Authorization: `Bearer ${token}` },
    })
    .then(r => {
        if (r.status === 401) { handleLogout(); return null; }
        return r.ok ? r.json() : null;
    })
    .then(user => {
        if (!user) return null;
        if (Array.isArray(user.permissions))
            localStorage.setItem('permissions', JSON.stringify(user.permissions));
        if (user.is_admin !== undefined)
            localStorage.setItem('is_admin', user.is_admin);
        if (user.is_company_admin !== undefined)
            localStorage.setItem('is_company_admin', user.is_company_admin);
        if (user.company_id !== undefined)
            localStorage.setItem('company_id', user.company_id ?? '');
        if (user.units)
            localStorage.setItem('units', user.units);
        applyCompanyBranding(user.company_id);
        return user;
    })
    .catch(() => null); // network failure: use cached value
})();

if (localStorage.getItem('company_id')) {
    applyCompanyBranding();
}
