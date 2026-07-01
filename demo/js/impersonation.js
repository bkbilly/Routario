function returnToAdmin() {
    const token    = localStorage.getItem('impersonating_admin_token');
    const userId   = localStorage.getItem('impersonating_admin_user_id');
    const username = localStorage.getItem('impersonating_admin_username');
    if (!token) return;
    localStorage.setItem('auth_token',        token);
    localStorage.setItem('user_id',           userId);
    localStorage.setItem('username',          username);
    localStorage.setItem('is_admin',          'true');
    localStorage.setItem('is_company_admin',  'false');
    localStorage.setItem('company_id',        '');
    localStorage.removeItem('impersonating_admin_token');
    localStorage.removeItem('impersonating_admin_user_id');
    localStorage.removeItem('impersonating_admin_username');
    window.location.reload();
}

document.addEventListener('DOMContentLoaded', () => {
    if (!localStorage.getItem('impersonating_admin_token')) return;

    const username = localStorage.getItem('username') || 'user';

    const banner = document.createElement('div');
    banner.id = 'impersonationBanner';
    banner.style.cssText = [
        'display:flex', 'background:#d97706', 'color:#fff',
        'padding:0.5rem 1rem', 'text-align:center', 'gap:1rem',
        'align-items:center', 'justify-content:center',
        'font-size:0.875rem', 'position:relative', 'z-index:9999',
    ].join(';');
    banner.innerHTML = `
        <span>You are viewing as "${username}"</span>
        <button onclick="returnToAdmin()" style="background:#fff;color:#d97706;border:none;border-radius:4px;padding:0.25rem 0.75rem;font-weight:600;cursor:pointer;">
            Return to Admin
        </button>
    `;
    document.body.insertBefore(banner, document.body.firstChild);
    document.documentElement.style.setProperty('--banner-height', banner.offsetHeight + 'px');
});
