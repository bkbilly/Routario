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