/**
 * settings-nav.js
 * Shared settings gear-menu for device-management, company-management, and user-settings.
 * Matches the dashboard dropdown style exactly.
 */

(function () {
    const path        = window.location.pathname;
    const hash        = window.location.hash;
    const isManagement = path.includes('management');
    const isUsers     = isManagement && hash.includes('users');
    const isDrivers   = path.includes('drivers') || (isManagement && hash.includes('drivers') && !isUsers);
    const isCompanies = path.includes('company-management') || (isManagement && hash.includes('companies'));
    const isReports   = path.includes('reports');
    const isDevices   = path.includes('device-management') || (isManagement && !isCompanies && !isDrivers && !isUsers);
    const isSettings  = path.includes('user-settings');

    const pageTitle = isManagement ? 'Management'
                    : isReports ? 'Fleet Reports'
                    : isSettings ? 'User Settings'
                    : 'Management';

    const isAdmin        = localStorage.getItem('is_admin') === 'true';
    const isCompanyAdmin = localStorage.getItem('is_company_admin') === 'true';
    const username       = localStorage.getItem('username') || 'User';
    const roleLabel      = isAdmin ? 'Super Admin' : isCompanyAdmin ? 'Company Admin' : 'User';

    // ── Styles (mirrors dashboard.css header-menu classes) ────────────────────
    const style = document.createElement('style');
    style.textContent = `
        .settings-nav {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.75rem;
            position: sticky;
            top: 0;
            z-index: 100;
            background: var(--bg-primary);
            padding: 1rem 0;
            margin-bottom: 1rem;
            transition: background 0.2s ease, box-shadow 0.2s ease;
        }
        .settings-nav.scrolled {
            background: rgba(10, 14, 26, 0.7);
            backdrop-filter: blur(6px);
            -webkit-backdrop-filter: blur(6px);
            box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
        }
        .settings-nav-title {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            padding: 0 0.5rem;
        }
        .settings-nav-title span {
            display: inline-block;
            font-size: 1.5rem;
            font-weight: 800;
            background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        .settings-nav-right {
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }
        .settings-nav-home {
            width: 38px;
            height: 38px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: var(--bg-tertiary);
            border: 1px solid var(--border-color);
            border-radius: 10px;
            color: var(--text-secondary);
            font-size: 1.1rem;
            cursor: pointer;
            transition: all var(--transition-base);
            flex-shrink: 0;
        }
        .settings-nav-home:hover {
            background: var(--bg-hover);
            border-color: var(--accent-primary);
            color: var(--accent-primary);
        }
        .header-gear-btn {
            width: 38px;
            height: 38px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: var(--bg-tertiary);
            border: 1px solid var(--border-color);
            border-radius: 10px;
            color: var(--text-secondary);
            cursor: pointer;
            transition: all var(--transition-base);
            flex-shrink: 0;
        }
        .header-gear-btn:hover,
        .header-gear-btn.active {
            background: var(--bg-hover);
            border-color: var(--accent-primary);
            color: var(--accent-primary);
        }
        .header-gear-btn.active svg {
            animation: sn-spin 3s linear infinite;
        }
        @keyframes sn-spin {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
        }
        .header-menu-wrap {
            position: relative;
        }
        .header-menu-dropdown {
            display: none;
            position: absolute;
            top: calc(100% + 10px);
            right: 0;
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 14px;
            padding: 0.4rem;
            min-width: 220px;
            box-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04);
            z-index: 1002;
            flex-direction: column;
            gap: 0.1rem;
            opacity: 0;
            transform: translateY(-6px) scale(0.97);
            transform-origin: top right;
            transition: opacity 0.15s ease, transform 0.15s ease;
            pointer-events: none;
        }
        .header-menu-dropdown.open {
            display: flex;
            opacity: 1;
            transform: translateY(0) scale(1);
            pointer-events: auto;
            animation: sn-menuIn 0.15s ease forwards;
        }
        @keyframes sn-menuIn {
            from { opacity: 0; transform: translateY(-6px) scale(0.97); }
            to   { opacity: 1; transform: translateY(0)    scale(1);    }
        }
        .header-menu-user {
            display: flex;
            align-items: center;
            gap: 0.65rem;
            padding: 0.6rem 0.75rem 0.7rem;
        }
        .header-menu-avatar {
            width: 34px;
            height: 34px;
            border-radius: 50%;
            background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            color: white;
        }
        .header-menu-user-info {
            display: flex;
            flex-direction: column;
            gap: 0.1rem;
            min-width: 0;
        }
        .header-menu-username {
            font-size: 0.875rem;
            font-weight: 700;
            color: var(--text-primary);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .header-menu-role {
            font-size: 0.72rem;
            color: var(--text-muted);
            font-weight: 500;
        }
        .header-menu-item {
            display: flex;
            align-items: center;
            gap: 0.6rem;
            padding: 0.575rem 0.75rem;
            border-radius: 9px;
            font-family: var(--font-display);
            font-size: 0.875rem;
            font-weight: 500;
            color: var(--text-primary);
            text-decoration: none;
            background: transparent;
            border: none;
            cursor: pointer;
            transition: background var(--transition-fast), color var(--transition-fast);
            width: 100%;
            text-align: left;
        }
        .header-menu-item:hover {
            background: var(--bg-hover);
        }
        .header-menu-item-icon {
            width: 28px;
            height: 28px;
            border-radius: 7px;
            background: var(--bg-tertiary);
            border: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            color: var(--text-secondary);
            transition: background var(--transition-fast), color var(--transition-fast);
        }
        .header-menu-item:hover .header-menu-item-icon {
            background: rgba(59,130,246,0.15);
            border-color: rgba(59,130,246,0.3);
            color: var(--accent-primary);
        }
        .header-menu-item.active-page .header-menu-item-icon {
            background: rgba(59,130,246,0.15);
            border-color: rgba(59,130,246,0.3);
            color: var(--accent-primary);
        }
        .header-menu-item.active-page {
            color: var(--accent-primary);
        }
        .header-menu-chevron {
            margin-left: auto;
            color: var(--text-muted);
            opacity: 0;
            transform: translateX(-4px);
            transition: opacity var(--transition-fast), transform var(--transition-fast);
        }
        .header-menu-item:hover .header-menu-chevron {
            opacity: 1;
            transform: translateX(0);
        }
        .header-menu-divider {
            height: 1px;
            background: var(--border-color);
            margin: 0.3rem 0.5rem;
        }
        .header-menu-danger {
            color: var(--accent-danger);
        }
        .header-menu-danger:hover {
            background: rgba(239,68,68,0.1);
            color: var(--accent-danger);
        }
        .header-menu-danger:hover .header-menu-item-icon {
            background: rgba(239,68,68,0.15);
            border-color: rgba(239,68,68,0.3);
            color: var(--accent-danger);
        }
    `;
    document.head.appendChild(style);

    // ── Chevron SVG helper ────────────────────────────────────────────────────
    const chevron = `<svg class="header-menu-chevron" xmlns="http://www.w3.org/2000/svg" width="13" height="13"
        viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;

    // ── Nav HTML (built in DOMContentLoaded so hasPermission() is available) ──
    function _buildNav() {
    const nav = document.createElement('div');
    nav.className = 'settings-nav';
    nav.innerHTML = `
        <button class="settings-nav-home" onclick="history.back()" title="Go back">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 18 9 12 15 6"/>
            </svg>
        </button>
        <span class="settings-nav-title"><span>${pageTitle}</span></span>
        <div class="settings-nav-right">
        <div class="header-menu-wrap">
            <button class="header-gear-btn" id="snGearBtn" title="Settings">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06
                             a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09
                             A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83
                             l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09
                             A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83
                             l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09
                             a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83
                             l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09
                             a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
            </button>
            <div class="header-menu-dropdown" id="snDropdown">
                <div class="header-menu-user">
                    <div class="header-menu-avatar">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                            <circle cx="12" cy="7" r="4"/>
                        </svg>
                    </div>
                    <div class="header-menu-user-info">
                        <span class="header-menu-username">${username}</span>
                        <span class="header-menu-role">${roleLabel}</span>
                    </div>
                </div>

                <div class="header-menu-divider"></div>

                <button class="header-menu-item" onclick="location.replace('gps-dashboard.html')">
                    <span class="header-menu-item-icon">
                        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                            <polyline points="9 22 9 12 15 12 15 22"/>
                        </svg>
                    </span>
                    <span>Dashboard</span>
                    ${chevron}
                </button>

                ${(typeof hasPermission === 'undefined' || hasPermission('view_management'))
                    ? `<a href="management.html" class="header-menu-item${isManagement ? ' active-page' : ''}">
                        <span class="header-menu-item-icon">
                            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none"
                                 stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="5" y="2" width="14" height="20" rx="2"/>
                                <line x1="12" y1="18" x2="12" y2="18"/>
                            </svg>
                        </span>
                        <span>Management</span>${chevron}
                       </a>`
                    : ''
                }

                ${(typeof hasPermission === 'function' && hasPermission('view_reports'))
                    ? `<a href="reports.html" class="header-menu-item${isReports ? ' active-page' : ''}">
                        <span class="header-menu-item-icon"><i class="mdi mdi-chart-bar" style="font-size:15px;"></i></span>
                        <span>Fleet Reports</span>${chevron}
                       </a>`
                    : ''}

                <a href="user-settings.html" class="header-menu-item${isSettings ? ' active-page' : ''}">
                    <span class="header-menu-item-icon">
                        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="3"/>
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06
                                     a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09
                                     A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83
                                     l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09
                                     A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83
                                     l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09
                                     a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83
                                     l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09
                                     a1.65 1.65 0 0 0-1.51 1z"/>
                        </svg>
                    </span>
                    <span>User Settings</span>
                    ${chevron}
                </a>

                ${isManagement ? `<div class="header-menu-divider"></div><div id="snAddAction"></div><div id="snNotifyAction"></div>` : ''}

                <div class="header-menu-divider"></div>

                ${isSettings ? `<button class="header-menu-item" onclick="_clearAppCache()">
                    <span class="header-menu-item-icon">
                        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/>
                            <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
                        </svg>
                    </span>
                    <span>Clear Cache</span>
                </button>
                <div class="header-menu-divider"></div>` : ''}

                <button class="header-menu-item header-menu-danger" onclick="handleLogout()">
                    <span class="header-menu-item-icon">
                        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                            <polyline points="16 17 21 12 16 7"/>
                            <line x1="21" y1="12" x2="9" y2="12"/>
                        </svg>
                    </span>
                    <span>Sign Out</span>
                </button>
            </div>
        </div>
        </div>
    `;
    return nav;
    } // end _buildNav

    async function _clearAppCache() {
        try {
            if ('caches' in window) {
                const keys = await caches.keys();
                await Promise.all(keys.map(k => caches.delete(k)));
            }
            if ('serviceWorker' in navigator) {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map(r => r.unregister()));
            }
        } catch (e) { /* ignore */ }
        location.reload(true);
    }

    // ── Toggle logic ──────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', async () => {
        await permissionsReady;
        const nav = _buildNav();
        const container = document.querySelector('.container');
        if (container) container.insertBefore(nav, container.firstChild);

        const btn      = document.getElementById('snGearBtn');
        const dropdown = document.getElementById('snDropdown');

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = dropdown.classList.contains('open');
            dropdown.classList.toggle('open');
            btn.classList.toggle('active', !isOpen);
        });

        document.addEventListener('click', (e) => {
            if (!dropdown.contains(e.target) && !btn.contains(e.target)) {
                dropdown.classList.remove('open');
                btn.classList.remove('active');
            }
        });

        window.addEventListener('scroll', () => {
            nav.classList.toggle('scrolled', window.scrollY > 0);
        }, { passive: true });
    });
})();
