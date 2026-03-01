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
    window.location.href = 'login.html';
}