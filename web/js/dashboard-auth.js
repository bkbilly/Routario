/**
 * dashboard-auth.js
 * Authentication and user session functions.
 */

// Login Check Function
function checkLogin() {
    const token = localStorage.getItem('auth_token');
    const userId = localStorage.getItem('user_id');
    
    if (!token || !userId) {
        window.location.href = 'login.html';
    } else {
        currentUser = { id: userId };
    }
}

// Logout Function
function handleLogout() {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('user_id');
    localStorage.removeItem('username');
    localStorage.removeItem('is_admin');
    localStorage.removeItem('impersonating_admin_token');
    localStorage.removeItem('impersonating_admin_user_id');
    localStorage.removeItem('impersonating_admin_username');
    window.location.href = 'login.html';
}

function returnToAdmin() {
    const token    = localStorage.getItem('impersonating_admin_token');
    const userId   = localStorage.getItem('impersonating_admin_user_id');
    const username = localStorage.getItem('impersonating_admin_username');
    if (!token) return;
    localStorage.setItem('auth_token', token);
    localStorage.setItem('user_id',    userId);
    localStorage.setItem('username',   username);
    localStorage.setItem('is_admin',   'true');
    localStorage.removeItem('impersonating_admin_token');
    localStorage.removeItem('impersonating_admin_user_id');
    localStorage.removeItem('impersonating_admin_username');
    window.location.reload();
}

function initImpersonationBanner() {
    const adminToken = localStorage.getItem('impersonating_admin_token');
    const banner     = document.getElementById('impersonationBanner');
    if (!banner) return;
    if (adminToken) {
        const username = localStorage.getItem('username') || 'user';
        document.getElementById('impersonationLabel').textContent =
            `You are viewing as "${username}"`;
        banner.style.display = 'flex';
    }
}

document.addEventListener('DOMContentLoaded', initImpersonationBanner);