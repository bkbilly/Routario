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

    window.RoutarioUI = {
        escapeHtml,
        companyChip,
        deviceChip,
        planChip,
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
