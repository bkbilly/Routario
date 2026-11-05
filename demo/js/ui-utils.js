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
        return `<tr><td colspan="${Number(colspan) || 1}" style="text-align:center;padding:${escapeHtml(padding)};color:${color};">${message}</td></tr>`;
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
    };

    window.RoutarioTabs = {
        activate: activateTabs,
        hashValue,
        replaceHash,
    };
})();
