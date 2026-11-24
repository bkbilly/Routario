/**
 * Shared UI helpers used across management/report/settings pages.
 */

(function () {
    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, c => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;',
        }[c]));
    }

    function sortHeader({ key, label, activeKey, direction = 1, onClick }) {
        const dir = direction === 'desc' ? -1 : Number(direction) || 1;
        const active = activeKey === key;
        const arrow = active ? (dir === 1 ? ' ▲' : ' ▼') : '';
        const arg = escapeHtml(JSON.stringify(key));
        return `<th data-sort="${escapeHtml(key)}" onclick="${onClick}(${arg})">${escapeHtml(label)}<span class="sort-arrow">${arrow}</span></th>`;
    }

    function updateSortHeaders(root, sortState) {
        const selector = String(root).split(',')
            .map(item => item.trim())
            .filter(Boolean)
            .map(item => {
                const rootSelector = /^[#.[]/.test(item) ? item : `#${item}`;
                return `${rootSelector} th[data-sort]`;
            })
            .join(', ');
        document.querySelectorAll(selector).forEach(th => {
            th.dataset.sortDir = th.dataset.sort === sortState.col ? sortState.dir : '';
        });
    }

    function toggleNumericSort(currentCol, currentDir, nextCol) {
        return {
            col: nextCol,
            dir: currentCol === nextCol ? -currentDir : 1,
        };
    }

    function toggleTextSort(sortState, nextCol) {
        return {
            col: nextCol,
            dir: sortState.col === nextCol && sortState.dir === 'asc' ? 'desc' : 'asc',
        };
    }

    function stateRow(message, colspan, options = {}) {
        const tone = options.tone || 'muted';
        const color = tone === 'danger' || tone === 'error'
            ? 'var(--accent-danger)'
            : `var(--text-${tone})`;
        const padding = options.padding || '2rem';
        return `<tr class="table-state-row"><td colspan="${Number(colspan) || 1}" style="text-align:center;padding:${escapeHtml(padding)};color:${color};">${message}</td></tr>`;
    }

    function syncCardLabels(target) {
        const root = (target && target.querySelectorAll) ? target : document;
        const selector = 'table.devices-table, table.alerts-table, table.command-history-table, table.routes-table, table.settings-table, table.tickets-table, table.company-table, table.schedules-table, table.health-table, table.runtime-log-table, table.report-table, table.billing-detail-table, table.eco-scorecard-table, table.audit-table, table.lb-table';
        const tables = (root.matches && root.matches(selector)) ? [root] : Array.from(root.querySelectorAll(selector));

        tables.forEach(table => {
            const thead = table.querySelector('thead');
            if (!thead) return;
            const ths = Array.from(thead.querySelectorAll('th'));
            if (!ths.length) return;

            // Check if first column is an avatar/icon (empty text or width <= 60px)
            const firstTh = ths[0];
            const isAvatarCol = !firstTh.textContent.trim() || (firstTh.style.width && parseInt(firstTh.style.width, 10) <= 60);

            const rows = table.querySelectorAll('tbody tr');
            rows.forEach(tr => {
                if (tr.classList.contains('log-history-row') || tr.classList.contains('run-history-row')) {
                    return;
                }
                if (tr.classList.contains('table-state-row') || tr.querySelector('td[colspan]')) {
                    tr.classList.add('table-state-row');
                    return;
                }

                if (isAvatarCol) {
                    tr.classList.add('has-avatar-col');
                }

                const tds = Array.from(tr.querySelectorAll('td'));
                if (tds.length === ths.length) {
                    tds.forEach((td, i) => {
                        if (!td.hasAttribute('data-label')) {
                            const header = ths[i].textContent.replace(/[▼▲]/g, '').trim();
                            if (header) td.setAttribute('data-label', header);
                        }
                    });
                } else {
                    // Match against visible THs in case columns were dynamically omitted
                    const visibleThs = ths.filter(th => {
                        const style = window.getComputedStyle(th);
                        return style.display !== 'none';
                    });
                    tds.forEach((td, i) => {
                        if (!td.hasAttribute('data-label')) {
                            const header = visibleThs[i] ? visibleThs[i].textContent.replace(/[▼▲]/g, '').trim() : '';
                            if (header) td.setAttribute('data-label', header);
                        }
                    });
                }

                // Mark action cells vs regular data cells on the last cell
                const lastTd = tds[tds.length - 1];
                if (lastTd) {
                    const label = (lastTd.getAttribute('data-label') || '').toLowerCase();
                    const hasButtons = Boolean(lastTd.querySelector('button, .btn, .tbl-btn, a.btn'));
                    if (hasButtons || label === 'actions' || label === 'action') {
                        lastTd.classList.add('card-actions-cell');
                    } else {
                        lastTd.classList.remove('card-actions-cell');
                    }
                }
            });
        });
    }

    let _syncRaf = null;
    function scheduleSyncCardLabels() {
        if (_syncRaf) return;
        _syncRaf = requestAnimationFrame(() => {
            _syncRaf = null;
            syncCardLabels();
        });
    }

    // Set up observer to automatically label dynamic tables
    if (typeof window !== 'undefined' && typeof MutationObserver !== 'undefined') {
        const _observer = new MutationObserver(mutations => {
            let shouldSync = false;
            for (let i = 0; i < mutations.length; i++) {
                const m = mutations[i];
                if (m.type === 'childList' && m.addedNodes.length > 0) {
                    for (let j = 0; j < m.addedNodes.length; j++) {
                        const n = m.addedNodes[j];
                        if (n.nodeType === 1 && (n.matches?.('tr, tbody, table') || n.querySelector?.('table, tbody, tr'))) {
                            shouldSync = true;
                            break;
                        }
                    }
                }
                if (shouldSync) break;
            }
            if (shouldSync) scheduleSyncCardLabels();
        });

        const _startObserver = () => {
            syncCardLabels();
            if (document.body) {
                _observer.observe(document.body, { childList: true, subtree: true });
            }
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', _startObserver);
        } else {
            _startObserver();
        }
    }

    function hashValue() {
        return window.location.hash.replace('#', '');
    }

    function replaceHash(value) {
        history.replaceState(null, '', `#${value}`);
    }

    function activateTabs(items, activeName) {
        items.forEach(item => {
            const panel = document.getElementById(item.panelId);
            if (panel) panel.style.display = item.name === activeName ? '' : 'none';

            const tab = document.getElementById(item.tabId);
            if (tab) tab.classList.toggle('active', item.name === activeName);
        });
    }

    function companyChip(companyOrName, options = {}) {
        const name = typeof companyOrName === 'object' && companyOrName !== null
            ? companyOrName.name
            : companyOrName;
        if (!name || name === '—' || name === '-') {
            const emptyLabel = options.emptyLabel || '—';
            return `<span class="cmp-empty-text">${escapeHtml(emptyLabel)}</span>`;
        }
        const title = options.title ? escapeHtml(options.title) : escapeHtml(name);
        return `<span class="cmp-chip" title="${title}">` +
            `<i class="mdi mdi-office-building"></i>` +
            `<span class="cmp-chip-text">${escapeHtml(name)}</span>` +
        `</span>`;
    }

    function deviceChip(deviceOrName, options = {}) {
        let name = '';
        let tooltip = '';
        if (typeof deviceOrName === 'object' && deviceOrName !== null) {
            name = deviceOrName.name || '';
            const plate = deviceOrName.license_plate ? ` [${escapeHtml(deviceOrName.license_plate)}]` : '';
            const imei = deviceOrName.imei ? ` · IMEI: ${escapeHtml(deviceOrName.imei)}` : '';
            tooltip = options.title ? escapeHtml(options.title) : `${escapeHtml(name)}${plate}${imei}`;
        } else {
            name = String(deviceOrName || '').trim();
            tooltip = options.title ? escapeHtml(options.title) : escapeHtml(name);
        }

        if (!name || name === '—' || name === '-' || name.toLowerCase() === 'unassigned') {
            const emptyLabel = options.emptyLabel || '—';
            return `<span class="cmp-empty-text">${escapeHtml(emptyLabel)}</span>`;
        }

        return `<span class="cmp-chip" title="${tooltip}">` +
            `<i class="mdi mdi-car"></i>` +
            `<span class="cmp-chip-text">${escapeHtml(name)}</span>` +
        `</span>`;
    }

    function planChip(planOrName, options = {}) {
        let name = '';
        let tooltip = '';
        if (typeof planOrName === 'object' && planOrName !== null) {
            name = planOrName.name || '';
            const base = planOrName.base_price_cents != null
                ? ` · Base: ${(planOrName.base_price_cents / 100).toFixed(2)} ${planOrName.currency || 'EUR'}`
                : '';
            tooltip = options.title ? escapeHtml(options.title) : `${escapeHtml(name)}${base}`;
        } else {
            name = String(planOrName || '').trim();
            tooltip = options.title ? escapeHtml(options.title) : escapeHtml(name);
        }

        if (!name || name === '—' || name === '-') {
            const emptyLabel = options.emptyLabel || 'No active plan';
            return `<span class="cmp-empty-text">${escapeHtml(emptyLabel)}</span>`;
        }

        return `<span class="cmp-chip" title="${tooltip}">` +
            `<i class="mdi mdi-credit-card-outline"></i>` +
            `<span class="cmp-chip-text">${escapeHtml(name)}</span>` +
        `</span>`;
    }

    // ── Shared Global Alerts Drawer ──────────────────────────────────────────
    function _injectAlertsDrawerStyles() {
        if (document.getElementById('routario-alerts-drawer-styles')) return;
        const style = document.createElement('style');
        style.id = 'routario-alerts-drawer-styles';
        style.textContent = `
            .header-alerts-btn { position: relative; }
            .header-alerts-btn.has-alerts {
                border-color: rgba(245, 158, 11, 0.5);
                color: var(--accent-warning, #f59e0b);
            }
            .header-alerts-btn.has-critical-alerts {
                background: rgba(239, 68, 68, 0.12);
                border-color: rgba(239, 68, 68, 0.55);
                color: var(--accent-danger, #ef4444);
            }
            .header-alerts-btn.has-critical-alerts:hover {
                background: rgba(239, 68, 68, 0.2);
                border-color: var(--accent-danger, #ef4444);
                color: var(--accent-danger, #ef4444);
            }
            .alerts-badge-pill,
            .map-ctrl-badge {
                position: absolute;
                top: -4px;
                right: -4px;
                background: var(--accent-danger, #ef4444);
                color: #fff;
                border-radius: 50%;
                min-width: 16px;
                height: 16px;
                padding: 0 3px;
                font-size: 10px;
                font-weight: 700;
                line-height: 16px;
                text-align: center;
                pointer-events: none;
                box-shadow: 0 0 0 2px var(--bg-card, var(--bg-secondary));
                display: none;
            }
            .alerts-badge-pill.visible,
            .map-ctrl-badge.visible {
                display: inline-flex !important;
                align-items: center;
                justify-content: center;
            }
            .modal.alerts-drawer {
                position: fixed;
                inset: 0;
                z-index: 2100;
                display: none;
                justify-content: flex-end;
                align-items: stretch;
                padding: 0;
                background: rgba(0, 0, 0, 0.35);
                backdrop-filter: blur(3px);
            }
            .modal.alerts-drawer.active { display: flex; }
            .modal.alerts-drawer .alerts-drawer-panel {
                width: 440px;
                max-width: 100vw;
                height: 100%;
                max-height: 100vh;
                max-height: 100dvh;
                margin: 0;
                border-radius: 0;
                border-top: none;
                border-right: none;
                border-bottom: none;
                border-left: 1px solid var(--border-color);
                background: var(--bg-secondary);
                display: flex;
                flex-direction: column;
                padding: 1.15rem 1.25rem;
                overflow: hidden;
                box-shadow: -8px 0 32px rgba(0, 0, 0, 0.35);
                transform: translateX(100%);
                transition: transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);
            }
            .modal.alerts-drawer.active .alerts-drawer-panel { transform: translateX(0); }
            .alerts-modal-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                flex-wrap: nowrap;
                gap: 0.5rem;
                padding: 0 0 0.85rem 0;
                margin-bottom: 0.85rem;
                border-bottom: 1px solid var(--border-color);
                flex-shrink: 0;
            }
            .alerts-modal-header .modal-title {
                flex: 1;
                margin: 0;
                font-size: 1.15rem;
                font-weight: 700;
                color: var(--text-primary);
            }
            .alerts-modal-actions {
                display: flex;
                gap: 0.5rem;
                align-items: center;
            }
            .alerts-clear-btn {
                padding: 0.4rem 0.75rem;
                font-size: 0.8rem;
                border-radius: 8px;
                border: 1px solid var(--border-color);
                background: var(--bg-tertiary);
                color: var(--text-primary);
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                gap: 0.35rem;
            }
            .alerts-clear-btn:hover { background: var(--bg-hover); }
            .alerts-drawer-close-btn {
                width: 32px;
                height: 32px;
                border-radius: 8px;
                border: 1px solid var(--border-color);
                background: var(--bg-tertiary);
                color: var(--text-secondary);
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font-size: 1.1rem;
            }
            .alerts-drawer-close-btn:hover {
                color: var(--text-primary);
                background: var(--bg-hover);
            }
            .alerts-tabs {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 0.4rem;
                background: var(--bg-tertiary);
                padding: 0.3rem;
                border-radius: 10px;
                border: 1px solid var(--border-color);
                margin-bottom: 0.85rem;
                flex-shrink: 0;
            }
            .alerts-tab {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 0.4rem;
                padding: 0.48rem 0.75rem;
                border: none;
                border-radius: 7px;
                background: transparent;
                color: var(--text-secondary);
                font-size: 0.84rem;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.18s ease;
            }
            .alerts-tab:hover { color: var(--text-primary); }
            .alerts-tab.active {
                background: var(--bg-card, var(--bg-secondary));
                color: var(--text-primary);
                box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
            }
            .alerts-tab-count {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                min-width: 18px;
                height: 18px;
                padding: 0 5px;
                border-radius: 999px;
                font-size: 0.7rem;
                font-weight: 700;
                background: rgba(59, 130, 246, 0.16);
                color: var(--accent-primary);
            }
            .alerts-filters {
                display: flex;
                flex-direction: column;
                gap: 0.55rem;
                margin-bottom: 0.85rem;
                flex-shrink: 0;
            }
            .alerts-search-wrap {
                position: relative;
                display: flex;
                align-items: center;
            }
            .alerts-search-wrap > .mdi-magnify {
                position: absolute;
                left: 0.75rem;
                color: var(--text-muted);
                font-size: 1rem;
                pointer-events: none;
            }
            .alerts-search-input {
                width: 100%;
                padding: 0.5rem 2rem 0.5rem 2.15rem;
                background: var(--bg-tertiary);
                border: 1px solid var(--border-color);
                border-radius: 8px;
                color: var(--text-primary);
                font-size: 0.84rem;
                transition: border-color 0.18s ease;
            }
            .alerts-search-input:focus { outline: none; border-color: var(--accent-primary); }
            .alerts-search-clear {
                position: absolute;
                right: 0.5rem;
                background: transparent;
                border: none;
                color: var(--text-muted);
                cursor: pointer;
                padding: 0.15rem;
                font-size: 0.95rem;
                display: flex;
                align-items: center;
            }
            .alerts-search-clear:hover { color: var(--text-primary); }
            .alerts-severity-pills {
                display: flex;
                gap: 0.4rem;
                flex-wrap: wrap;
            }
            .alerts-sev-pill {
                padding: 0.26rem 0.65rem;
                border-radius: 999px;
                border: 1px solid var(--border-color);
                background: var(--bg-tertiary);
                color: var(--text-secondary);
                font-size: 0.75rem;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.16s ease;
            }
            .alerts-sev-pill:hover { border-color: var(--text-muted); color: var(--text-primary); }
            .alerts-sev-pill.active {
                background: rgba(59, 130, 246, 0.16);
                border-color: var(--accent-primary);
                color: var(--accent-primary);
            }
            .alerts-sev-pill.sev-critical.active {
                background: rgba(239, 68, 68, 0.16);
                border-color: var(--accent-danger, #ef4444);
                color: var(--accent-danger, #ef4444);
            }
            .alerts-sev-pill.sev-warning.active {
                background: rgba(245, 158, 11, 0.16);
                border-color: var(--accent-warning, #f59e0b);
                color: var(--accent-warning, #f59e0b);
            }
            .alerts-drawer-body {
                flex: 1;
                min-height: 0;
                overflow-y: auto;
                padding-right: 0.15rem;
            }
            .alerts-drawer .alerts-list {
                display: flex;
                flex-direction: column;
                max-height: none;
                overflow-y: visible;
                gap: 0.55rem;
            }
            .alerts-drawer .alert-item {
                background: var(--bg-tertiary);
                border-left: 4px solid var(--accent-primary);
                border-radius: 8px;
                padding: 0.7rem 0.85rem;
                display: flex;
                gap: 0.75rem;
                align-items: flex-start;
                transition: background 0.15s ease;
            }
            .alerts-drawer .alert-item:hover { background: var(--bg-hover); }
            .alerts-drawer .alert-item.warning { border-left-color: var(--accent-warning, #f59e0b); }
            .alerts-drawer .alert-item.critical { border-left-color: var(--accent-danger, #ef4444); }
            .alerts-drawer .alert-icon {
                width: 34px;
                height: 34px;
                border-radius: 8px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 1.05rem;
                flex-shrink: 0;
                margin-top: 0.1rem;
                background: rgba(59, 130, 246, 0.15);
                color: var(--accent-primary);
            }
            .alerts-drawer .alert-item.warning .alert-icon {
                background: rgba(245, 158, 11, 0.15);
                color: var(--accent-warning, #f59e0b);
            }
            .alerts-drawer .alert-item.critical .alert-icon {
                background: rgba(239, 68, 68, 0.15);
                color: var(--accent-danger, #ef4444);
            }
            .alerts-drawer .alert-content { flex: 1; min-width: 0; }
            .alert-meta-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 0.5rem;
                margin-bottom: 0.25rem;
                flex-wrap: wrap;
            }
            .alert-vehicle-tag {
                display: inline-flex;
                align-items: center;
                gap: 0.28rem;
                background: rgba(59, 130, 246, 0.12);
                border: 1px solid rgba(59, 130, 246, 0.25);
                border-radius: 5px;
                padding: 0.1rem 0.45rem;
                font-size: 0.7rem;
                font-weight: 600;
                color: var(--accent-primary);
            }
            .alerts-drawer .alert-time {
                margin-top: 0;
                font-size: 0.7rem;
                color: var(--text-muted);
                font-family: var(--font-mono, monospace);
            }
            .alerts-drawer .alert-title {
                font-size: 0.88rem;
                font-weight: 600;
                color: var(--text-primary);
                margin-bottom: 0.15rem;
            }
            .alerts-drawer .alert-message {
                font-size: 0.8rem;
                color: var(--text-secondary);
                line-height: 1.38;
            }
            .alert-footer-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 0.5rem;
                margin-top: 0.35rem;
                flex-wrap: wrap;
            }
            .alert-map-hint {
                display: inline-flex;
                align-items: center;
                gap: 0.25rem;
                font-size: 0.68rem;
                color: var(--accent-primary);
                opacity: 0.75;
                margin-left: auto;
                transition: opacity 0.15s ease;
            }
            .alert-item.alert-clickable:hover .alert-map-hint { opacity: 1; }
            .alerts-drawer .alert-dismiss {
                background: transparent;
                border: none;
                color: var(--text-muted);
                cursor: pointer;
                padding: 0.25rem;
                font-size: 1.1rem;
                line-height: 1;
            }
            .alerts-drawer .alert-dismiss:hover { color: var(--text-primary); }
        `;
        document.head.appendChild(style);
    }

    function mountAlertsDrawer(options = {}) {
        _injectAlertsDrawerStyles();

        const buttonId = options.buttonId || 'alertsBtn';
        const iconId   = options.iconId   || 'alertsBtnIcon';
        const badgeId  = options.badgeId  || 'alertCount';
        const getDevices = typeof options.getDevices === 'function' ? options.getDevices : null;
        const onAlertClick = typeof options.onAlertClick === 'function' ? options.onAlertClick : null;
        const onAlertsChanged = typeof options.onAlertsChanged === 'function' ? options.onAlertsChanged : null;
        const canViewDashboard = (typeof hasPermission !== 'function') || hasPermission('view_dashboard');

        let drawer = document.getElementById('alertsModal');
        if (!drawer) {
            drawer = document.createElement('div');
            drawer.className = 'modal alerts-drawer';
            drawer.id = 'alertsModal';
            document.body.appendChild(drawer);
        }
        drawer.innerHTML = `
            <div class="modal-content alerts-drawer-panel">
                <div class="modal-header alerts-modal-header">
                    <div style="display:flex; align-items:center; gap:0.6rem;">
                        <i class="mdi mdi-bell-outline" style="font-size:1.25rem; color:var(--accent-primary);"></i>
                        <h2 class="modal-title">Alerts</h2>
                    </div>
                    <div class="alerts-modal-actions">
                        <button type="button" class="alerts-clear-btn" id="alertClearAllBtn" title="Mark all alerts as read">
                            <i class="mdi mdi-broom"></i> Clear All
                        </button>
                        <button type="button" class="alerts-drawer-close-btn" id="alertsDrawerCloseBtn" title="Close">
                            <i class="mdi mdi-close"></i>
                        </button>
                    </div>
                </div>
                <div class="alerts-tabs" role="tablist">
                    <button type="button" class="alerts-tab active" id="alertsTabUnread" role="tab" aria-selected="true">
                        <span>Unread</span>
                        <span class="alerts-tab-count" id="alertsTabUnreadCount">0</span>
                    </button>
                    <button type="button" class="alerts-tab" id="alertsTabHistory" role="tab" aria-selected="false">
                        <i class="mdi mdi-history"></i>
                        <span>History</span>
                    </button>
                </div>
                <div class="alerts-filters">
                    <div class="alerts-search-wrap">
                        <i class="mdi mdi-magnify"></i>
                        <input type="text" id="alertsSearchInput" class="alerts-search-input" placeholder="Filter by vehicle, type, or message...">
                        <button type="button" id="alertsSearchClearBtn" class="alerts-search-clear" title="Clear search" style="display:none;">
                            <i class="mdi mdi-close-circle"></i>
                        </button>
                    </div>
                    <div class="alerts-severity-pills" id="alertsSeverityPills">
                        <button type="button" class="alerts-sev-pill active" data-severity="all">All</button>
                        <button type="button" class="alerts-sev-pill sev-critical" data-severity="critical">Critical</button>
                        <button type="button" class="alerts-sev-pill sev-warning" data-severity="warning">Warning</button>
                        <button type="button" class="alerts-sev-pill sev-info" data-severity="info">Info</button>
                    </div>
                </div>
                <div class="alerts-drawer-body">
                    <div id="alertsUnreadSection">
                        <div class="alerts-list" id="alertsList"></div>
                    </div>
                    <div id="alertsHistorySection" style="display:none;">
                        <div class="alerts-list" id="alertsHistoryList"></div>
                        <div id="alertsHistoryLoadMore" style="display:none; text-align:center; padding-top:0.75rem;">
                            <button type="button" class="alerts-clear-btn" id="alertsHistoryLoadMoreBtn">Load More</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        let alertsData = [];
        let cachedDevicesMap = null;
        let activeTab = 'unread';
        let activeSeverity = 'all';
        let searchQuery = '';
        let historyOffset = 0;
        const HISTORY_PAGE_SIZE = 10;

        async function resolveDevice(deviceId) {
            if (deviceId == null) return null;
            if (getDevices) {
                const list = getDevices();
                if (Array.isArray(list)) return list.find(d => d.id === deviceId) || null;
            }
            if (cachedDevicesMap === null) {
                cachedDevicesMap = {};
                if (typeof apiFetch === 'function' && typeof API_BASE !== 'undefined') {
                    try {
                        const res = await apiFetch(`${API_BASE}/devices`);
                        if (res.ok) {
                            const list = await res.json();
                            if (Array.isArray(list)) list.forEach(d => { cachedDevicesMap[d.id] = d; });
                        }
                    } catch (_) {}
                }
            }
            return cachedDevicesMap[deviceId] || null;
        }

        function resolveDeviceSync(deviceId) {
            if (deviceId == null) return null;
            if (getDevices) {
                const list = getDevices();
                if (Array.isArray(list)) return list.find(d => d.id === deviceId) || null;
            }
            return cachedDevicesMap ? (cachedDevicesMap[deviceId] || null) : null;
        }

        function updateAlertsButtonState(count, hasCritical = false) {
            const btn = document.getElementById(buttonId);
            const badge = document.getElementById(badgeId);
            const icon = document.getElementById(iconId);
            const tabCount = document.getElementById('alertsTabUnreadCount');
            const n = parseInt(count, 10) || 0;

            if (tabCount) tabCount.textContent = n > 99 ? '99+' : String(n);
            if (badge) {
                if (n > 0) {
                    badge.textContent = n > 99 ? '99+' : String(n);
                    badge.style.setProperty('display', 'inline-flex', 'important');
                    badge.classList.add('visible');
                } else {
                    badge.textContent = '0';
                    badge.style.setProperty('display', 'none', 'important');
                    badge.classList.remove('visible');
                }
            }
            if (btn) {
                btn.classList.toggle('has-alerts', n > 0);
                btn.classList.toggle('has-critical-alerts', n > 0 && hasCritical);
            }
            if (icon) {
                icon.className = n > 0 ? (hasCritical ? 'mdi mdi-bell-alert' : 'mdi mdi-bell-ring') : 'mdi mdi-bell-outline';
                icon.style.removeProperty('color');
            }
        }

        function _buildAlertItem(alert, { dimmed = false, dismissable = true } = {}) {
            const icon = typeof getAlertIconHtml === 'function' ? getAlertIconHtml(alert) : '<i class="mdi mdi-bell"></i>';
            const title = typeof getAlertDisplayTitle === 'function'
                ? getAlertDisplayTitle(alert)
                : (alert.alert_type ? alert.alert_type.replace(/_/g, ' ').toUpperCase() : 'Alert');
            const messageText = alert.alert_metadata?.rule_condition || alert.message || '';
            const device = resolveDeviceSync(alert.device_id);
            const emoji = device && typeof VEHICLE_ICONS !== 'undefined'
                ? (VEHICLE_ICONS[device.vehicle_type] || VEHICLE_ICONS['other']).emoji
                : '🚗';
            const vehicleTag = device
                ? `<span class="alert-vehicle-tag">${emoji} ${escapeHtml(device.name)}</span>`
                : '<span></span>';
            const timeText = typeof formatDateToLocal === 'function' ? formatDateToLocal(alert.created_at) : (alert.created_at || '');
            const hasGps = alert.latitude != null && alert.longitude != null && !isNaN(Number(alert.latitude)) && !isNaN(Number(alert.longitude));
            const isClickable = hasGps && (onAlertClick || canViewDashboard);

            const channelStatusList = alert.alert_metadata?.channel_status || alert.channel_status || [];
            const channelStatusHtml = Array.isArray(channelStatusList) && channelStatusList.length > 0
                ? `<div class="alert-channels-status" style="display:flex;flex-wrap:wrap;gap:0.3rem;">
                    ${channelStatusList.map(ch => {
                        const isOk = ch.status === 'sent' || ch.status === 'delivered' || ch.status === 'success';
                        const chIcon = isOk ? 'mdi-check-circle' : 'mdi-alert-circle';
                        const color = isOk ? '#10b981' : '#ef4444';
                        const titleText = ch.error ? `${ch.name}: Failed (${ch.error})` : `${ch.name}: ${ch.status}`;
                        return `<span title="${escapeHtml(titleText)}" style="display:inline-flex;align-items:center;gap:0.25rem;font-size:0.68rem;padding:0.1rem 0.35rem;border-radius:4px;background:rgba(255,255,255,0.06);color:${color};font-weight:600;"><i class="mdi ${chIcon}"></i>${escapeHtml(ch.name)}</span>`;
                    }).join('')}
                   </div>`
                : '';

            const jumpHint = isClickable
                ? `<span class="alert-map-hint"><i class="mdi mdi-map-marker-outline"></i> View on map</span>`
                : '';
            const footerHtml = (channelStatusHtml || jumpHint)
                ? `<div class="alert-footer-row">${channelStatusHtml}${jumpHint}</div>`
                : '';

            const item = document.createElement('div');
            item.className = `alert-item ${alert.severity || 'info'}${isClickable ? ' alert-clickable' : ''}`;
            item.dataset.alertId = String(alert.id);
            item.dataset.severity = (alert.severity || 'info').toLowerCase();
            if (dimmed) item.style.opacity = '0.68';
            if (isClickable) {
                item.style.cursor = 'pointer';
                item.title = 'View alert on map';
                item.addEventListener('click', (e) => {
                    if (e.target.closest('.alert-dismiss')) return;
                    if (onAlertClick) onAlertClick(alert);
                    else window.location.href = `gps-dashboard.html?alert=${encodeURIComponent(alert.id)}`;
                });
            }

            item.innerHTML = `
                <div class="alert-icon">${icon}</div>
                <div class="alert-content">
                    <div class="alert-meta-row">
                        ${vehicleTag}
                        <span class="alert-time">${escapeHtml(timeText)}</span>
                    </div>
                    <div class="alert-title">${escapeHtml(title)}</div>
                    <div class="alert-message">${escapeHtml(messageText)}</div>
                    ${footerHtml}
                </div>
                ${dismissable ? `<button type="button" class="alert-dismiss" title="Dismiss"><i class="mdi mdi-close"></i></button>` : ''}
            `;

            if (dismissable) {
                item.querySelector('.alert-dismiss')?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    dismissAlert(alert.id);
                });
            }
            return item;
        }

        function _updateSeverityCounts() {
            const pills = document.getElementById('alertsSeverityPills');
            if (!pills) return;
            const counts = { all: alertsData.length, critical: 0, warning: 0, info: 0 };
            alertsData.forEach(a => {
                const s = (a.severity || 'info').toLowerCase();
                if (counts[s] !== undefined) counts[s]++;
            });
            const labels = { all: 'All', critical: 'Critical', warning: 'Warning', info: 'Info' };
            pills.querySelectorAll('.alerts-sev-pill').forEach(b => {
                const s = b.dataset.severity;
                b.textContent = counts[s] > 0 ? `${labels[s]} (${counts[s]})` : labels[s];
            });
        }

        function _renderUnread() {
            const list = document.getElementById('alertsList');
            if (!list) return;
            list.innerHTML = '';
            _updateSeverityCounts();

            if (alertsData.length === 0) {
                list.innerHTML = '<div style="text-align:center; padding:2.5rem 1rem; color:var(--text-muted); font-size:0.9rem;"><i class="mdi mdi-check-circle-outline" style="font-size:2rem; display:block; margin-bottom:0.4rem; opacity:0.5;"></i>No unread alerts</div>';
                return;
            }
            const q = searchQuery.toLowerCase();
            const filtered = alertsData.filter(a => {
                if (activeSeverity !== 'all' && (a.severity || 'info').toLowerCase() !== activeSeverity) return false;
                if (q) {
                    const dev = resolveDeviceSync(a.device_id);
                    const devName = dev ? dev.name.toLowerCase() : '';
                    const title = (typeof getAlertDisplayTitle === 'function' ? getAlertDisplayTitle(a) : (a.alert_type || '')).toLowerCase();
                    const msg = (a.alert_metadata?.rule_condition || a.message || '').toLowerCase();
                    if (!devName.includes(q) && !title.includes(q) && !msg.includes(q)) return false;
                }
                return true;
            });
            if (filtered.length === 0) {
                list.innerHTML = '<div style="text-align:center; padding:2rem 1rem; color:var(--text-muted); font-size:0.875rem;">No alerts match the current filter.</div>';
                return;
            }
            filtered.forEach(a => list.appendChild(_buildAlertItem(a)));
        }

        function _filterHistoryDom() {
            const list = document.getElementById('alertsHistoryList');
            if (!list) return;
            const q = searchQuery.toLowerCase();
            list.querySelectorAll('.alert-item').forEach(item => {
                const sevOk = activeSeverity === 'all' || (item.dataset.severity || 'info') === activeSeverity;
                const textOk = !q || item.textContent.toLowerCase().includes(q);
                item.style.display = (sevOk && textOk) ? '' : 'none';
            });
        }

        async function loadAlerts() {
            if (typeof apiFetch !== 'function' || typeof API_BASE === 'undefined') return;
            try {
                if (!getDevices && cachedDevicesMap === null) await resolveDevice(0);
                const res = await apiFetch(`${API_BASE}/alerts?unread_only=true&_t=${Date.now()}`);
                if (!res.ok) return;
                alertsData = await res.json();
                window.loadedAlerts = alertsData;
                const hasCritical = Array.isArray(alertsData) && alertsData.some(a => a.severity === 'critical' || a.severity === 'high');
                updateAlertsButtonState(alertsData.length, hasCritical);
                if (activeTab === 'unread') _renderUnread();
                if (onAlertsChanged) onAlertsChanged(alertsData);
            } catch (e) {
                console.error('Error loading alerts:', e);
            }
        }

        async function loadAlertHistory() {
            if (typeof apiFetch !== 'function' || typeof API_BASE === 'undefined') return;
            try {
                if (!getDevices && cachedDevicesMap === null) await resolveDevice(0);
                const res = await apiFetch(`${API_BASE}/alerts?read_only=true&limit=${HISTORY_PAGE_SIZE + 1}&offset=${historyOffset}`);
                if (!res.ok) return;
                const rows = await res.json();
                const hasMore = rows.length > HISTORY_PAGE_SIZE;
                const toShow = rows.slice(0, HISTORY_PAGE_SIZE);
                const list = document.getElementById('alertsHistoryList');
                if (historyOffset === 0) list.innerHTML = '';
                if (historyOffset === 0 && toShow.length === 0) {
                    list.innerHTML = '<div style="text-align:center; padding:1.5rem; color:var(--text-muted); font-size:0.875rem;">No cleared alerts yet.</div>';
                } else {
                    toShow.forEach(a => list.appendChild(_buildAlertItem(a, { dimmed: true, dismissable: false })));
                    _filterHistoryDom();
                }
                historyOffset += toShow.length;
                document.getElementById('alertsHistoryLoadMore').style.display = hasMore ? 'block' : 'none';
            } catch (e) {
                console.error('Failed to load alert history:', e);
            }
        }

        async function dismissAlert(alertId) {
            try {
                if (typeof handleAlertDismissedLocally === 'function') handleAlertDismissedLocally(alertId, true);
                const res = await apiFetch(`${API_BASE}/alerts/${alertId}/read`, { method: 'POST' });
                if (res.ok) {
                    alertsData = alertsData.filter(a => String(a.id) !== String(alertId));
                    window.loadedAlerts = alertsData;
                    const hasCritical = alertsData.some(a => a.severity === 'critical' || a.severity === 'high');
                    updateAlertsButtonState(alertsData.length, hasCritical);
                    _renderUnread();
                    if (onAlertsChanged) onAlertsChanged(alertsData);
                }
            } catch (_) {}
        }

        async function clearAllAlerts() {
            if (!alertsData.length || !confirm('Mark all alerts as read?')) return;
            if (typeof handleAlertsClearedLocally === 'function') handleAlertsClearedLocally(true);
            try {
                await apiFetch(`${API_BASE}/alerts/read-all`, { method: 'POST' });
            } catch (_) {
                await Promise.all(alertsData.map(a => apiFetch(`${API_BASE}/alerts/${a.id}/read`, { method: 'POST' }).catch(() => {})));
            }
            alertsData = [];
            window.loadedAlerts = [];
            updateAlertsButtonState(0, false);
            _renderUnread();
            if (onAlertsChanged) onAlertsChanged(alertsData);
            if (typeof showAlert === 'function') showAlert({ title: 'Success', message: 'All alerts cleared', type: 'success' });
        }

        function switchTab(tab) {
            activeTab = tab === 'history' ? 'history' : 'unread';
            const isHist = activeTab === 'history';
            document.getElementById('alertsTabUnread')?.classList.toggle('active', !isHist);
            document.getElementById('alertsTabHistory')?.classList.toggle('active', isHist);
            document.getElementById('alertsUnreadSection').style.display = isHist ? 'none' : 'block';
            document.getElementById('alertsHistorySection').style.display = isHist ? 'block' : 'none';
            document.getElementById('alertClearAllBtn').style.display = isHist ? 'none' : '';
            if (isHist) {
                historyOffset = 0;
                document.getElementById('alertsHistoryList').innerHTML = '<div style="text-align:center; padding:1.5rem; color:var(--text-muted); font-size:0.85rem;"><i class="mdi mdi-loading mdi-spin"></i> Loading alert history…</div>';
                loadAlertHistory();
            } else {
                _renderUnread();
            }
        }

        function openAlertsModal() {
            activeSeverity = 'all';
            searchQuery = '';
            const inp = document.getElementById('alertsSearchInput');
            if (inp) inp.value = '';
            document.getElementById('alertsSearchClearBtn').style.display = 'none';
            document.querySelectorAll('#alertsSeverityPills .alerts-sev-pill').forEach(b => {
                b.classList.toggle('active', b.dataset.severity === 'all');
            });
            switchTab('unread');
            loadAlerts();
            drawer.classList.add('active');
        }

        function closeAlertsModal() {
            drawer.classList.remove('active');
        }

        document.getElementById(buttonId)?.addEventListener('click', openAlertsModal);
        document.getElementById('alertsDrawerCloseBtn')?.addEventListener('click', closeAlertsModal);
        document.getElementById('alertClearAllBtn')?.addEventListener('click', clearAllAlerts);
        document.getElementById('alertsTabUnread')?.addEventListener('click', () => switchTab('unread'));
        document.getElementById('alertsTabHistory')?.addEventListener('click', () => switchTab('history'));
        document.getElementById('alertsHistoryLoadMoreBtn')?.addEventListener('click', loadAlertHistory);

        document.getElementById('alertsSearchInput')?.addEventListener('input', (e) => {
            searchQuery = (e.target.value || '').trim();
            document.getElementById('alertsSearchClearBtn').style.display = searchQuery ? 'flex' : 'none';
            if (activeTab === 'unread') _renderUnread();
            else _filterHistoryDom();
        });
        document.getElementById('alertsSearchClearBtn')?.addEventListener('click', () => {
            const inp = document.getElementById('alertsSearchInput');
            if (inp) inp.value = '';
            searchQuery = '';
            document.getElementById('alertsSearchClearBtn').style.display = 'none';
            if (activeTab === 'unread') _renderUnread();
            else _filterHistoryDom();
        });
        document.querySelectorAll('#alertsSeverityPills .alerts-sev-pill').forEach(btn => {
            btn.addEventListener('click', () => {
                activeSeverity = btn.dataset.severity || 'all';
                document.querySelectorAll('#alertsSeverityPills .alerts-sev-pill').forEach(b => {
                    b.classList.toggle('active', b.dataset.severity === activeSeverity);
                });
                if (activeTab === 'unread') _renderUnread();
                else _filterHistoryDom();
            });
        });

        bindModalDismiss(drawer, closeAlertsModal);

        window.loadAlerts = loadAlerts;
        window.openAlertsModal = openAlertsModal;
        window.closeAlertsModal = closeAlertsModal;
        window.clearAllAlerts = clearAllAlerts;
        window.dismissAlert = dismissAlert;
        window.updateAlertsButtonState = updateAlertsButtonState;

        if (options.pollIntervalMs > 0) {
            loadAlerts();
            setInterval(loadAlerts, options.pollIntervalMs);
        }

        return { loadAlerts, openAlertsModal, closeAlertsModal, updateAlertsButtonState };
    }

    window.RoutarioUI = {
        escapeHtml,
        companyChip,
        deviceChip,
        planChip,
    };

    function bindModalDismiss(modalOrId, onClose) {
        const modal = typeof modalOrId === 'string' ? document.getElementById(modalOrId) : modalOrId;
        if (!modal || modal.dataset.dismissBound === 'true') return;
        modal.dataset.dismissBound = 'true';
        const closeFn = typeof onClose === 'function' ? onClose : () => modal.classList.remove('active');

        let backdropDown = false;
        modal.addEventListener('mousedown', (e) => { backdropDown = (e.target === modal); });
        modal.addEventListener('click', (e) => {
            if (backdropDown && e.target === modal) closeFn();
            backdropDown = false;
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.classList.contains('active')) closeFn();
        });
    }

    window.RoutarioAlertsDrawer = {
        mount: mountAlertsDrawer,
    };

    window.RoutarioModals = {
        bindDismiss: bindModalDismiss,
    };

    window.RoutarioTables = {
        stateRow,
        sortHeader,
        toggleNumericSort,
        toggleTextSort,
        updateSortHeaders,
        syncCardLabels,
    };

    window.RoutarioTabs = {
        activate: activateTabs,
        hashValue,
        replaceHash,
    };
})();
