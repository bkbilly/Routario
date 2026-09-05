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
        message          = messageOrData.message || '';
        title            = messageOrData.title   || null;
        resolvedType     = messageOrData.type    || type;
        resolvedDuration = messageOrData.duration || duration;
    } else if (Array.isArray(messageOrData)) {
        message = messageOrData.map(e => (typeof e === 'object' ? (e.msg || JSON.stringify(e)) : String(e))).join('\n');
    } else {
        message = String(messageOrData ?? '');
    }

    // Auto-scale display duration for long or multi-line messages so users have time to read
    let finalDuration = resolvedDuration;
    if (message.includes('\n') || message.length > 80) {
        const calculated = Math.max(8000, Math.min(25000, message.length * 50));
        finalDuration = resolvedDuration === 3000 ? calculated : Math.max(resolvedDuration, calculated);
    }

    const icons = { success: 'mdi-check-circle', error: 'mdi-close-circle', warning: 'mdi-alert', info: 'mdi-information' };
    const icon  = icons[resolvedType] || 'mdi-information';

    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        container.id = 'toastContainer';
        document.body.appendChild(container);
    }

    const safeTitle = title ? String(title).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').trim() : null;
    const safeMsg   = String(message).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').trim().replace(/\n/g, '<br>');

    const toast = document.createElement('div');
    toast.className = `toast toast-${resolvedType}`;
    toast.innerHTML = `<div class="toast-icon"><i class="mdi ${icon}"></i></div><div class="toast-content">${safeTitle ? `<div class="toast-title">${safeTitle}</div>` : ''}<div class="toast-message">${safeMsg}</div></div><button class="toast-close" onclick="this.closest('.toast').remove()" aria-label="Dismiss"><i class="mdi mdi-close"></i></button>`;
    container.appendChild(toast);

    setTimeout(() => {
        if (!toast.isConnected) return;
        toast.style.animation = 'slideInRight 0.3s reverse forwards';
        setTimeout(() => toast.remove(), 300);
    }, finalDuration);
}

function hasPermission(perm) {
    if (localStorage.getItem('is_admin') === 'true') return true;
    try {
        return JSON.parse(localStorage.getItem('permissions') || '[]').includes(perm);
    } catch { return false; }
}

/**
 * Apply light or dark theme across the application.
 * @param {string} theme - 'light' or 'dark'
 */
function applyTheme(theme) {
    const activeTheme = (theme === 'light') ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', activeTheme);
    if (activeTheme === 'light') {
        document.documentElement.classList.add('light-theme');
        if (document.body) document.body.classList.add('light-theme');
    } else {
        document.documentElement.classList.remove('light-theme');
        if (document.body) document.body.classList.remove('light-theme');
    }
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
        metaThemeColor.setAttribute('content', activeTheme === 'light' ? '#f1f3f7' : '#170b1c');
    }
    window.dispatchEvent(new CustomEvent('routario:themechange', { detail: { theme: activeTheme } }));
}

// Immediately apply saved or default theme
applyTheme(localStorage.getItem('theme') || 'dark');

function handleLogout() {
    const loginSlug = localStorage.getItem('company_login_slug');
    const slugCompanyId = localStorage.getItem('company_login_slug_company_id');
    const currentCompanyId = localStorage.getItem('company_id');
    const loginUrl = loginSlug && slugCompanyId && currentCompanyId && slugCompanyId === currentCompanyId
        ? `/login/${encodeURIComponent(loginSlug)}`
        : '/login.html';
    ['auth_token','user_id','username','is_admin','units','currency','theme','is_company_admin','company_id',
     'permissions',
     'impersonation_stack',
     'impersonating_admin_token','impersonating_admin_user_id','impersonating_admin_username']
        .forEach(k => localStorage.removeItem(k));
    applyTheme('dark');
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

function _parseDate(val) {
    if (!val) return null;
    if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
    if (typeof val === 'number') {
        const d = new Date(val < 1e11 ? val * 1000 : val);
        return isNaN(d.getTime()) ? null : d;
    }
    let str = String(val).trim();
    if (!str) return null;
    if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(str)) str += 'Z';
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
}

function formatDateValue(val, format = null) {
    const d = _parseDate(val);
    if (!d) return val ? String(val) : 'N/A';

    const fmt = format || localStorage.getItem('date_format') || 'auto';
    const tz = localStorage.getItem('timezone');

    let year, month, day;
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz || undefined,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(d);
        const map = {};
        parts.forEach(({ type, value }) => { map[type] = value; });
        year = map.year;
        month = map.month;
        day = map.day;
    } catch (_) {
        year = String(d.getFullYear());
        month = String(d.getMonth() + 1).padStart(2, '0');
        day = String(d.getDate()).padStart(2, '0');
    }

    if (fmt === 'YYYY-MM-DD') return `${year}-${month}-${day}`;
    if (fmt === 'DD/MM/YYYY') return `${day}/${month}/${year}`;
    if (fmt === 'MM/DD/YYYY') return `${month}/${day}/${year}`;
    if (fmt === 'DD.MM.YYYY') return `${day}.${month}.${year}`;

    try {
        return d.toLocaleDateString(undefined, {
            timeZone: tz || undefined,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
    } catch (_) {
        return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
    }
}

function formatTimeValue(val, { withSeconds = false, format = null } = {}) {
    const d = _parseDate(val);
    if (!d) return val ? String(val) : 'N/A';

    const fmt = format || localStorage.getItem('time_format') || 'auto';
    const tz = localStorage.getItem('timezone');

    const opts = {
        minute: '2-digit',
        ...(withSeconds ? { second: '2-digit' } : {})
    };
    if (tz) {
        try { opts.timeZone = tz; } catch (_) {}
    }

    if (fmt === '12h') {
        opts.hour = 'numeric';
        opts.hour12 = true;
        return d.toLocaleTimeString(undefined, opts);
    }
    if (fmt === '24h') {
        opts.hour = '2-digit';
        opts.hour12 = false;
        return d.toLocaleTimeString(undefined, opts);
    }

    opts.hour = '2-digit';
    return d.toLocaleTimeString(undefined, opts);
}

function formatDateTimeValue(val, { withSeconds = false, dateFormat = null, timeFormat = null } = {}) {
    const d = _parseDate(val);
    if (!d) return val ? String(val) : 'N/A';
    return `${formatDateValue(d, dateFormat)} ${formatTimeValue(d, { withSeconds, format: timeFormat })}`;
}

function formatDateToLocal(str, { withSeconds = false } = {}) {
    if (!str) return 'N/A';
    const d = _parseDate(str);
    if (!d) return String(str);
    return formatDateTimeValue(d, { withSeconds });
}

function formatDateToLocalSplit(str, { withSeconds = true } = {}) {
    if (!str) return 'N/A';
    const d = _parseDate(str);
    if (!d) return String(str);
    const dateStr = formatDateValue(d);
    const timeStr = formatTimeValue(d, { withSeconds });
    return `<div style="font-weight:600;">${dateStr}</div><div style="font-size:0.75rem;color:var(--text-muted);">${timeStr}</div>`;
}

function parseUserDateTime(str) {
    if (!str) return null;
    str = String(str).trim();
    if (!str) return null;

    const fmt = localStorage.getItem('date_format') || 'auto';

    const ymdMatch = /^(\d{4})[-\/\.](\d{1,2})[-\/\.](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(am|pm))?)?$/i.exec(str);
    if (ymdMatch) {
        let [, year, month, day, hr, min, sec, ampm] = ymdMatch;
        let h = hr ? parseInt(hr, 10) : 0;
        const m = min ? parseInt(min, 10) : 0;
        const s = sec ? parseInt(sec, 10) : 0;
        if (ampm) {
            ampm = ampm.toLowerCase();
            if (ampm === 'pm' && h < 12) h += 12;
            if (ampm === 'am' && h === 12) h = 0;
        }
        return new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10), h, m, s);
    }

    const dmyMatch = /^(\d{1,2})[-\/\.](\d{1,2})[-\/\.](\d{4})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(am|pm))?)?$/i.exec(str);
    if (dmyMatch) {
        let [, p1, p2, year, hr, min, sec, ampm] = dmyMatch;
        const p1Num = parseInt(p1, 10);
        const p2Num = parseInt(p2, 10);
        let day, month;
        if (fmt === 'MM/DD/YYYY') {
            month = p1Num - 1;
            day = p2Num;
        } else {
            day = p1Num;
            month = p2Num - 1;
        }
        let h = hr ? parseInt(hr, 10) : 0;
        const m = min ? parseInt(min, 10) : 0;
        const s = sec ? parseInt(sec, 10) : 0;
        if (ampm) {
            ampm = ampm.toLowerCase();
            if (ampm === 'pm' && h < 12) h += 12;
            if (ampm === 'am' && h === 12) h = 0;
        }
        return new Date(parseInt(year, 10), month, day, h, m, s);
    }

    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
}

window.formatDateValue = formatDateValue;
window.formatTimeValue = formatTimeValue;
window.formatDateTimeValue = formatDateTimeValue;
window.formatDateToLocal = formatDateToLocal;
window.formatDateToLocalSplit = formatDateToLocalSplit;
window.parseUserDateTime = parseUserDateTime;

async function syncUserTimezone(user = null) {
    const token = localStorage.getItem('auth_token');
    const userId = localStorage.getItem('user_id');
    if (!token || !userId || typeof Intl === 'undefined') return;

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timezone || timezone === localStorage.getItem('timezone')) return;
    if (user?.timezone === timezone) {
        localStorage.setItem('timezone', timezone);
        return;
    }

    try {
        const res = await apiFetch(`${API_BASE}/users/${userId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ timezone }),
        });
        if (res.ok) localStorage.setItem('timezone', timezone);
    } catch {
        // Timezone is a convenience value; keep the app working if sync fails.
    }
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
        if (user.currency)
            localStorage.setItem('currency', user.currency);
        if (user.theme) {
            localStorage.setItem('theme', user.theme);
            applyTheme(user.theme);
        }
        if (user.sidebar_compact !== undefined) {
            localStorage.setItem('sidebar_compact', user.sidebar_compact ? 'true' : 'false');
            applySidebarCompact(user.sidebar_compact);
        }
        if (user.time_format !== undefined)
            localStorage.setItem('time_format', user.time_format || 'auto');
        if (user.date_format !== undefined)
            localStorage.setItem('date_format', user.date_format || 'auto');
        if (user.timezone)
            localStorage.setItem('timezone', user.timezone);
        applyCompanyBranding(user.company_id);
        syncUserTimezone(user);
        return user;
    })
    .catch(() => null); // network failure: use cached value
})();

function applySidebarCompact(compact) {
    const isCompact = compact === true || compact === 'true';
    if (document.body) document.body.classList.toggle('sidebar-compact', isCompact);
    const dashboard = document.querySelector('.dashboard');
    if (dashboard) dashboard.classList.toggle('sidebar-compact', isCompact);
}
window.applySidebarCompact = applySidebarCompact;

if (localStorage.getItem('sidebar_compact') === 'true') {
    if (document.body) document.body.classList.add('sidebar-compact');
    else document.addEventListener('DOMContentLoaded', () => document.body?.classList.add('sidebar-compact'));
}

if (localStorage.getItem('company_id')) {
    applyCompanyBranding();
}
