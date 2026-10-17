function _getImpersonationStack() {
    let stack = [];
    try {
        stack = JSON.parse(localStorage.getItem('impersonation_stack') || '[]');
        if (!Array.isArray(stack)) stack = [];
    } catch (_) {
        stack = [];
    }
    if (stack.length === 0 && localStorage.getItem('impersonating_admin_token')) {
        stack.push({
            auth_token:       localStorage.getItem('impersonating_admin_token'),
            user_id:          localStorage.getItem('impersonating_admin_user_id'),
            username:         localStorage.getItem('impersonating_admin_username'),
            is_admin:         'true',
            is_company_admin: 'false',
            company_id:       '',
            permissions:      '[]',
        });
    }
    return stack;
}

function returnToAdmin() {
    const stack = _getImpersonationStack();
    if (stack.length === 0) return;

    const prev = stack.pop();

    localStorage.setItem('auth_token',        prev.auth_token);
    localStorage.setItem('user_id',           prev.user_id);
    localStorage.setItem('username',          prev.username);
    localStorage.setItem('is_admin',          prev.is_admin != null ? String(prev.is_admin) : 'false');
    localStorage.setItem('is_company_admin',  prev.is_company_admin != null ? String(prev.is_company_admin) : 'false');
    localStorage.setItem('company_id',        prev.company_id ?? '');
    localStorage.setItem('permissions',       prev.permissions || '[]');

    if (stack.length > 0) {
        localStorage.setItem('impersonation_stack', JSON.stringify(stack));
        localStorage.setItem('impersonating_admin_token',    stack[0].auth_token);
        localStorage.setItem('impersonating_admin_user_id',  stack[0].user_id);
        localStorage.setItem('impersonating_admin_username', stack[0].username);
    } else {
        localStorage.removeItem('impersonation_stack');
        localStorage.removeItem('impersonating_admin_token');
        localStorage.removeItem('impersonating_admin_user_id');
        localStorage.removeItem('impersonating_admin_username');
    }

    window.location.reload();
}

document.addEventListener('DOMContentLoaded', () => {
    const stack = _getImpersonationStack();
    if (stack.length === 0) return;

    const username = localStorage.getItem('username') || 'user';
    const returnTarget = stack[stack.length - 1];
    const returnLabel = returnTarget?.username ? `Return to ${returnTarget.username}` : 'Return to Admin';

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
            ${returnLabel}
        </button>
    `;
    document.body.insertBefore(banner, document.body.firstChild);
    document.documentElement.style.setProperty('--banner-height', banner.offsetHeight + 'px');
});
