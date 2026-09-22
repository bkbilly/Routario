/**
 * Plugins Management UI Component
 * Handles installed plugins, repositories, catalog store, live usage modal, and hot-loading actions.
 */

function escapeHtml(str) {
    if (typeof RoutarioUI !== 'undefined' && RoutarioUI.escapeHtml) {
        return RoutarioUI.escapeHtml(str);
    }
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function showToast(message, type = 'success', duration = 3000) {
    if (typeof showAlert === 'function') {
        showAlert(message, type, duration);
    } else {
        alert(message);
    }
}

let _installedPlugins = [];
let _pluginCatalog = [];
let _pluginRepositories = [];
let _pluginCatalogFilter = 'all';

async function initPluginsSection() {
    await loadInstalledPlugins();
}

// ── 1. Installed Plugins ────────────────────────────────────────────────────────

async function loadInstalledPlugins() {
    const tbody = document.getElementById('pluginsTableBody');
    if (!tbody) return;

    tbody.innerHTML = `
        <tr>
            <td colspan="6" style="text-align:center;padding:2.5rem;color:var(--text-muted);">
                <div class="loading" style="margin:0 auto 0.75rem;"></div>
                Loading installed plugins…
            </td>
        </tr>
    `;

    try {
        const res = await apiFetch('/api/plugins/installed');
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
        _installedPlugins = await res.json();
        renderInstalledPlugins();
    } catch (e) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align:center;padding:2.5rem;color:var(--accent-danger);">
                    <i class="mdi mdi-alert-circle" style="font-size:24px;display:block;margin-bottom:0.5rem;"></i>
                    Failed to load plugins: ${escapeHtml(e.message)}
                </td>
            </tr>
        `;
    }
}

function renderInstalledPlugins() {
    filterInstalledPlugins();
}

function filterInstalledPlugins() {
    const tbody = document.getElementById('pluginsTableBody');
    const countEl = document.getElementById('pluginsCount');
    const restartBanner = document.getElementById('pluginRestartBanner');
    const searchVal = (document.getElementById('pluginSearch')?.value || '').toLowerCase().trim();

    if (!tbody) return;

    let hasRestartNeeded = false;
    for (const plugin of _installedPlugins) {
        if (plugin.requires_restart) hasRestartNeeded = true;
    }
    if (restartBanner) {
        restartBanner.style.display = hasRestartNeeded ? 'flex' : 'none';
    }

    if (!_installedPlugins.length) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align:center;padding:3rem;color:var(--text-muted);">
                    <i class="mdi mdi-puzzle-outline" style="font-size:40px;display:block;margin-bottom:0.75rem;opacity:0.4;"></i>
                    No plugins installed yet. Open the top-right settings menu and click <strong>Browse Store</strong> to discover and install plugins.
                </td>
            </tr>
        `;
        if (countEl) countEl.textContent = '0 plugins';
        return;
    }

    const filtered = _installedPlugins.filter(plugin => {
        if (!searchVal) return true;
        const m = plugin.manifest || {};
        const comp = plugin.components || { protocols: [], alerts: [], reports: [], integrations: [] };
        const cats = Array.isArray(m.categories) ? m.categories : (m.category ? [m.category] : []);
        const text = [
            plugin.id,
            m.name,
            m.description,
            m.author,
            ...cats,
            ...(comp.protocols || []),
            ...(comp.alerts || []),
            ...(comp.reports || []),
            ...(comp.integrations || []),
        ].filter(Boolean).join(' ').toLowerCase();
        return text.includes(searchVal);
    });

    if (countEl) {
        countEl.textContent = searchVal
            ? `${filtered.length} of ${_installedPlugins.length} ${_installedPlugins.length === 1 ? 'plugin' : 'plugins'}`
            : `${_installedPlugins.length} ${_installedPlugins.length === 1 ? 'plugin' : 'plugins'}`;
    }

    if (!filtered.length) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align:center;padding:3rem;color:var(--text-muted);">
                    <i class="mdi mdi-magnify" style="font-size:36px;display:block;margin-bottom:0.5rem;opacity:0.4;"></i>
                    No installed plugins match your search.
                </td>
            </tr>
        `;
        return;
    }

    let html = '';
    for (const plugin of filtered) {
        const m = plugin.manifest || {};
        const usage = plugin.usage || { in_use: false, summary_text: 'Not in use' };

        // Components badges
        const comp = plugin.components || { protocols: [], alerts: [], reports: [], integrations: [] };
        const compBadges = [];
        if (comp.protocols && comp.protocols.length) compBadges.push(`<span class="badge badge-info" title="Protocols: ${comp.protocols.join(', ')}"><i class="mdi mdi-antenna"></i> Protocol</span>`);
        if (comp.alerts && comp.alerts.length) compBadges.push(`<span class="badge badge-warning" title="Alerts: ${comp.alerts.join(', ')}"><i class="mdi mdi-bell-alert"></i> Alert</span>`);
        if (comp.reports && comp.reports.length) compBadges.push(`<span class="badge badge-success" title="Reports: ${comp.reports.join(', ')}"><i class="mdi mdi-file-chart"></i> Report</span>`);
        if (comp.integrations && comp.integrations.length) compBadges.push(`<span class="badge badge-primary" title="Integrations: ${comp.integrations.join(', ')}"><i class="mdi mdi-cloud-sync"></i> Integration</span>`);

        const iconHtml = m.icon_url 
            ? `<img src="${escapeHtml(m.icon_url)}" style="width:28px;height:28px;border-radius:6px;object-fit:cover;" alt="icon">`
            : `<div style="width:32px;height:32px;border-radius:8px;background:rgba(60,152,254,0.15);color:var(--accent-primary);display:flex;align-items:center;justify-content:center;font-size:18px;"><i class="mdi ${escapeHtml(m.icon || 'mdi-puzzle')}"></i></div>`;

        // Usage Pill
        const usageBadge = usage.in_use
            ? `<button class="btn-usage-pill active" onclick="openPluginUsageModal('${escapeHtml(plugin.id)}')"><i class="mdi mdi-check-circle"></i> ${escapeHtml(usage.summary_text)}</button>`
            : `<button class="btn-usage-pill" onclick="openPluginUsageModal('${escapeHtml(plugin.id)}')"><i class="mdi mdi-minus-circle-outline"></i> Not in use</button>`;

        // Update badge
        const updateHtml = plugin.update_available
            ? `<button class="btn btn-small btn-warning" style="margin-left:0.5rem;padding:0.25rem 0.55rem;font-size:0.75rem;" onclick="updatePlugin('${escapeHtml(plugin.id)}')"><i class="mdi mdi-arrow-up-bold-circle"></i> Update to v${escapeHtml(plugin.update_available)}</button>`
            : '';

        const toggleTitle = usage.in_use
            ? 'Cannot disable plugin while it is currently in use'
            : (plugin.enabled ? 'Enabled (Click to disable)' : 'Disabled (Click to enable)');

        const uninstallBtn = usage.in_use
            ? `<button class="icon-btn icon-btn-danger" disabled title="Cannot uninstall while in use (${escapeHtml(usage.summary_text)})" style="opacity:0.35;cursor:not-allowed;">
                    <i class="mdi mdi-delete-outline"></i>
               </button>`
            : `<button class="icon-btn icon-btn-danger" title="Uninstall Plugin" onclick="confirmUninstallPlugin('${escapeHtml(plugin.id)}', '${escapeHtml(m.name || plugin.id)}', false)">
                    <i class="mdi mdi-delete-outline"></i>
               </button>`;

        html += `
            <tr id="plugin-row-${escapeHtml(plugin.id)}">
                <td style="width:48px;">${iconHtml}</td>
                <td>
                    <div style="font-weight:600;color:var(--text-primary);display:flex;align-items:center;gap:0.4rem;">
                        ${escapeHtml(m.name || plugin.id)}
                        <span style="font-size:0.75rem;font-family:var(--font-mono);color:var(--text-muted);">v${escapeHtml(m.version || '1.0.0')}</span>
                        ${updateHtml}
                    </div>
                    <div style="font-size:0.8rem;color:var(--text-muted);margin-top:0.25rem;line-height:1.45;">
                        ${escapeHtml(m.description || 'No description provided')}
                    </div>
                    <div style="font-size:0.75rem;color:var(--text-secondary);margin-top:0.35rem;display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap;">
                        <span>Author: <strong>${escapeHtml(m.author || 'Unknown')}</strong></span>
                    </div>
                </td>
                <td>
                    <div style="display:flex;flex-wrap:wrap;gap:0.3rem;">
                        ${compBadges.length ? compBadges.join('') : '<span style="color:var(--text-muted);font-size:0.8rem;">None detected</span>'}
                    </div>
                </td>
                <td>${usageBadge}</td>
                <td style="text-align:center;">
                    <label class="toggle-switch ${usage.in_use ? 'disabled' : ''}" title="${toggleTitle}">
                        <input type="checkbox" ${plugin.enabled ? 'checked' : ''} ${usage.in_use ? 'disabled' : ''} onchange="togglePlugin('${escapeHtml(plugin.id)}', this.checked)">
                        <span class="toggle-slider"></span>
                    </label>
                </td>
                <td style="text-align:center;">
                    <div style="display:flex;align-items:center;justify-content:center;gap:0.35rem;">
                        ${uninstallBtn}
                    </div>
                </td>
            </tr>
        `;
    }

    tbody.innerHTML = html;
}

// ── 2. Hot-Toggle Plugin (Enable / Disable) ────────────────────────────────────

async function togglePlugin(pluginId, enabled) {
    try {
        const res = await apiFetch(`/api/plugins/${encodeURIComponent(pluginId)}/toggle`, {
            method: 'POST',
            body: JSON.stringify({ enabled }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
        const updated = await res.json();
        const idx = _installedPlugins.findIndex(p => p.id === pluginId);
        if (idx !== -1) _installedPlugins[idx] = updated;
        renderInstalledPlugins();
        showToast(`Plugin '${updated.manifest.name || pluginId}' ${enabled ? 'enabled' : 'disabled'} live.`);
    } catch (e) {
        showToast(`Failed to toggle plugin: ${e.message}`, 'error');
        await loadInstalledPlugins();
    }
}

// ── 3. Live Usage Modal ─────────────────────────────────────────────────────────

async function openPluginUsageModal(pluginId) {
    const plugin = _installedPlugins.find(p => p.id === pluginId);
    if (!plugin) return;

    const modal = document.getElementById('pluginUsageModal');
    const titleEl = document.getElementById('pluginUsageTitle');
    const bodyEl = document.getElementById('pluginUsageBody');

    if (!modal || !bodyEl) return;

    titleEl.textContent = `Usage Details: ${plugin.manifest.name || plugin.id}`;
    bodyEl.innerHTML = `
        <div style="text-align:center;padding:2rem;color:var(--text-muted);">
            <div class="loading" style="margin:0 auto 0.75rem;"></div>
            Fetching live usage data…
        </div>
    `;
    modal.classList.add('active');

    try {
        const res = await apiFetch(`/api/plugins/${encodeURIComponent(pluginId)}/usage`);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
        const usage = await res.json();

        let html = '';

        // Summary banner
        html += `
            <div style="background:var(--bg-subtle, rgba(255,255,255,0.03));border:1px solid var(--border-color);border-radius:8px;padding:0.9rem 1.1rem;margin-bottom:1.25rem;">
                <div style="font-size:0.9rem;font-weight:600;color:var(--text-primary);margin-bottom:0.25rem;">
                    <i class="mdi mdi-chart-donut" style="color:var(--accent-primary);margin-right:0.35rem;"></i> Status Summary
                </div>
                <div style="font-size:0.85rem;color:var(--text-secondary);">${escapeHtml(usage.summary_text)}</div>
            </div>
        `;

        // 1. Devices section
        if (usage.devices && usage.devices.length) {
            html += `
                <div style="margin-bottom:1.25rem;">
                    <h4 style="font-size:0.875rem;font-weight:700;color:var(--text-primary);margin:0 0 0.5rem 0;">
                        <i class="mdi mdi-antenna" style="color:var(--accent-primary);margin-right:0.3rem;"></i> Active Devices (${usage.devices.length})
                    </h4>
                    <div style="max-height:160px;overflow-y:auto;border:1px solid var(--border-color);border-radius:6px;">
                        <table class="devices-table" style="font-size:0.8rem;">
                            <thead>
                                <tr><th>Device</th><th>IMEI</th><th>Protocol</th><th>Company</th><th>Users</th></tr>
                            </thead>
                            <tbody>
                                ${usage.devices.map(d => `
                                    <tr>
                                        <td><strong>${escapeHtml(d.name)}</strong></td>
                                        <td style="font-family:var(--font-mono);">${escapeHtml(d.imei)}</td>
                                        <td><span class="badge badge-info">${escapeHtml(d.protocol || '')}</span></td>
                                        <td>${escapeHtml(d.company_name || '-')}</td>
                                        <td>${escapeHtml((d.user_names || []).join(', ') || '-')}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
        }

        // 2. Alert Rules section
        if (usage.alert_rules && usage.alert_rules.length) {
            html += `
                <div style="margin-bottom:1.25rem;">
                    <h4 style="font-size:0.875rem;font-weight:700;color:var(--text-primary);margin:0 0 0.5rem 0;">
                        <i class="mdi mdi-bell-alert" style="color:var(--accent-warning);margin-right:0.3rem;"></i> Configured Alert Rules (${usage.alert_rules.length})
                    </h4>
                    <div style="max-height:160px;overflow-y:auto;border:1px solid var(--border-color);border-radius:6px;">
                        <table class="devices-table" style="font-size:0.8rem;">
                            <thead>
                                <tr><th>Device</th><th>Alert Rule</th><th>Company</th><th>Users</th></tr>
                            </thead>
                            <tbody>
                                ${usage.alert_rules.map(a => `
                                    <tr>
                                        <td><strong>${escapeHtml(a.device_name)}</strong></td>
                                        <td><span class="badge badge-warning">${escapeHtml(a.alert_key)}</span></td>
                                        <td>${escapeHtml(a.company_name || '-')}</td>
                                        <td>${escapeHtml((a.user_names || []).join(', ') || '-')}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
        }

        // 3. Report Schedules section
        if (usage.report_schedules && usage.report_schedules.length) {
            html += `
                <div style="margin-bottom:1.25rem;">
                    <h4 style="font-size:0.875rem;font-weight:700;color:var(--text-primary);margin:0 0 0.5rem 0;">
                        <i class="mdi mdi-file-chart" style="color:var(--accent-success);margin-right:0.3rem;"></i> Scheduled Reports (${usage.report_schedules.length})
                    </h4>
                    <div style="max-height:140px;overflow-y:auto;border:1px solid var(--border-color);border-radius:6px;">
                        <table class="devices-table" style="font-size:0.8rem;">
                            <thead>
                                <tr><th>Schedule Name</th><th>Report Type</th><th>User</th></tr>
                            </thead>
                            <tbody>
                                ${usage.report_schedules.map(r => `
                                    <tr>
                                        <td><strong>${escapeHtml(r.schedule_name || 'Scheduled Report')}</strong></td>
                                        <td><span class="badge badge-success">${escapeHtml(r.report_type)}</span></td>
                                        <td>${escapeHtml(r.user_name || '-')}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
        }

        // 4. Integrations section
        if (usage.integrations && usage.integrations.length) {
            html += `
                <div style="margin-bottom:1.25rem;">
                    <h4 style="font-size:0.875rem;font-weight:700;color:var(--text-primary);margin:0 0 0.5rem 0;">
                        <i class="mdi mdi-cloud-sync" style="color:var(--accent-primary);margin-right:0.3rem;"></i> Integration Accounts (${usage.integrations.length})
                    </h4>
                    <div style="max-height:140px;overflow-y:auto;border:1px solid var(--border-color);border-radius:6px;">
                        <table class="devices-table" style="font-size:0.8rem;">
                            <thead>
                                <tr><th>Account</th><th>Provider ID</th><th>Owner</th><th>Linked Devices</th></tr>
                            </thead>
                            <tbody>
                                ${usage.integrations.map(i => `
                                    <tr>
                                        <td><strong>${escapeHtml(i.account_label || 'Default')}</strong></td>
                                        <td><span class="badge badge-primary">${escapeHtml(i.provider_id)}</span></td>
                                        <td>${escapeHtml(i.user_name || '-')}</td>
                                        <td>${i.device_count} devices</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
        }

        if (!usage.in_use) {
            html += `
                <div style="text-align:center;padding:1.5rem;color:var(--text-muted);font-size:0.85rem;">
                    <i class="mdi mdi-information-outline" style="font-size:24px;display:block;margin-bottom:0.5rem;"></i>
                    This plugin is not currently referenced by any active devices, alerts, or report schedules. It is safe to disable or uninstall.
                </div>
            `;
        }

        bodyEl.innerHTML = html;
    } catch (e) {
        bodyEl.innerHTML = `
            <div style="text-align:center;padding:2rem;color:var(--accent-danger);">
                Failed to load usage data: ${escapeHtml(e.message)}
            </div>
        `;
    }
}

function closePluginUsageModal() {
    document.getElementById('pluginUsageModal')?.classList.remove('active');
}

// ── 4. Repositories Management Modal ──────────────────────────────────────────

async function openPluginRepoModal() {
    const modal = document.getElementById('pluginRepoModal');
    if (!modal) return;
    modal.classList.add('active');
    const errEl = document.getElementById('repoErrorMsg');
    if (errEl) errEl.style.display = 'none';
    const urlInput = document.getElementById('repoUrlInput');
    if (urlInput) urlInput.value = '';
    await loadPluginRepositories();
}

function closePluginRepoModal() {
    document.getElementById('pluginRepoModal')?.classList.remove('active');
    // If catalog modal is currently open, refresh catalog so new repositories reflect immediately
    if (document.getElementById('pluginCatalogModal')?.classList.contains('active')) {
        loadPluginCatalog();
    }
}

async function loadPluginRepositories() {
    const listEl = document.getElementById('pluginRepoList');
    if (!listEl) return;

    listEl.innerHTML = `
        <div style="text-align:center;padding:1.5rem;color:var(--text-muted);">
            <div class="loading" style="margin:0 auto 0.5rem;"></div>
            Loading repositories…
        </div>
    `;

    try {
        const res = await apiFetch('/api/plugins/repositories');
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
        _pluginRepositories = await res.json();
        renderPluginRepositories();
    } catch (e) {
        listEl.innerHTML = `<div style="color:var(--accent-danger);padding:1rem;">Failed to load repositories: ${escapeHtml(e.message)}</div>`;
    }
}

function renderPluginRepositories() {
    const listEl = document.getElementById('pluginRepoList');
    if (!listEl) return;

    if (!_pluginRepositories.length) {
        listEl.innerHTML = '<div style="color:var(--text-muted);padding:1rem;text-align:center;">No repositories configured.</div>';
        return;
    }

    let html = '';
    for (const repo of _pluginRepositories) {
        const displayUrl = repo.url || repo.manifest_url || '';
        html += `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:0.75rem 1rem;background:var(--bg-subtle, rgba(255,255,255,0.03));border:1px solid var(--border-color);border-radius:8px;margin-bottom:0.5rem;">
                <div style="overflow:hidden;text-overflow:ellipsis;padding-right:0.5rem;">
                    <div style="font-weight:600;font-size:0.875rem;color:var(--text-primary);display:flex;align-items:center;gap:0.4rem;">
                        ${escapeHtml(repo.name)}
                        <span style="font-size:0.75rem;color:var(--text-muted);font-family:var(--font-mono);">(${repo.plugin_count || 0} plugins)</span>
                    </div>
                    <div style="font-size:0.75rem;color:var(--text-muted);font-family:var(--font-mono);margin-top:0.2rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(displayUrl)}">
                        ${escapeHtml(displayUrl)}
                    </div>
                    ${repo.error ? `<div style="font-size:0.75rem;color:var(--accent-danger);margin-top:0.2rem;"><i class="mdi mdi-alert-circle"></i> ${escapeHtml(repo.error)}</div>` : ''}
                </div>
                <div>
                    <button class="icon-btn icon-btn-danger" title="Remove Repository" onclick="deletePluginRepo('${escapeHtml(repo.id)}')">
                        <i class="mdi mdi-delete-outline"></i>
                    </button>
                </div>
            </div>
        `;
    }
    listEl.innerHTML = html;
}

async function submitAddPluginRepo() {
    const urlInput = document.getElementById('repoUrlInput');
    const btn = document.getElementById('btnAddRepoSubmit');
    const errEl = document.getElementById('repoErrorMsg');

    const url = (urlInput?.value || '').trim();

    if (!url) {
        if (errEl) {
            errEl.textContent = 'Repository URL is required.';
            errEl.style.display = 'block';
        }
        return;
    }

    if (errEl) errEl.style.display = 'none';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span class="loading" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:0.3rem;"></span> Validating…`;
    }

    try {
        const res = await apiFetch('/api/plugins/repositories', {
            method: 'POST',
            body: JSON.stringify({ url }),
        });

        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.detail || `HTTP ${res.status}`);
        }

        showToast(`Repository '${data.name}' added successfully (${data.plugin_count} plugins found).`);
        if (urlInput) urlInput.value = '';
        await loadPluginRepositories();
    } catch (e) {
        if (errEl) {
            errEl.textContent = e.message;
            errEl.style.display = 'block';
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<i class="mdi mdi-plus"></i> Add`;
        }
    }
}

async function deletePluginRepo(repoId) {
    if (!confirm('Are you sure you want to remove this repository?')) return;
    try {
        const res = await apiFetch(`/api/plugins/repositories/${encodeURIComponent(repoId)}`, {
            method: 'DELETE',
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
        showToast('Repository removed.');
        await loadPluginRepositories();
    } catch (e) {
        showToast(`Failed to remove repository: ${e.message}`, 'error');
    }
}

// ── 5. Plugin Store / Catalog Modal ──────────────────────────────────────────

async function openPluginCatalogModal() {
    const modal = document.getElementById('pluginCatalogModal');
    if (!modal) return;
    modal.classList.add('active');
    document.getElementById('catalogSearchInput').value = '';
    _pluginCatalogFilter = 'all';
    await loadPluginCatalog();
}

function closePluginCatalogModal() {
    document.getElementById('pluginCatalogModal')?.classList.remove('active');
}

async function loadPluginCatalog() {
    const gridEl = document.getElementById('pluginCatalogGrid');
    if (!gridEl) return;

    gridEl.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--text-muted);">
            <div class="loading" style="margin:0 auto 0.75rem;"></div>
            Fetching plugins catalog from all configured repositories…
        </div>
    `;

    try {
        const res = await apiFetch('/api/plugins/catalog');
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
        _pluginCatalog = await res.json();
        renderPluginCatalog();
    } catch (e) {
        gridEl.innerHTML = `
            <div style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--accent-danger);">
                <i class="mdi mdi-alert-circle" style="font-size:28px;display:block;margin-bottom:0.5rem;"></i>
                Failed to fetch catalog: ${escapeHtml(e.message)}
            </div>
        `;
    }
}

function filterPluginCatalog(category) {
    _pluginCatalogFilter = category || 'all';
    document.querySelectorAll('.catalog-filter-btn').forEach(b => {
        b.classList.toggle('active', (b.dataset.cat || '').toLowerCase() === _pluginCatalogFilter.toLowerCase());
    });
    renderPluginCatalog();
}

function renderPluginCatalog() {
    const gridEl = document.getElementById('pluginCatalogGrid');
    const searchVal = (document.getElementById('catalogSearchInput')?.value || '').toLowerCase().trim();

    if (!gridEl) return;

    const installedMap = new Map(_installedPlugins.map(p => [p.id, p]));

    let filtered = _pluginCatalog.filter(p => {
        let catMatch = _pluginCatalogFilter === 'all';
        const cats = (Array.isArray(p.categories) && p.categories.length 
            ? p.categories 
            : (p.category ? [p.category] : [])).map(c => String(c).toLowerCase());

        if (!catMatch) {
            const filterNorm = _pluginCatalogFilter.toLowerCase().replace(/s$/, ''); // e.g. "protocol", "alert", "report", "integration"
            catMatch = cats.some(c => c.includes(filterNorm) || filterNorm.includes(c.replace(/s$/, '')));
        }
        const textMatch = !searchVal 
            || (p.name || '').toLowerCase().includes(searchVal)
            || (p.description || '').toLowerCase().includes(searchVal)
            || (p.id || '').toLowerCase().includes(searchVal)
            || (p.author || '').toLowerCase().includes(searchVal)
            || cats.some(c => c.includes(searchVal));
        return catMatch && textMatch;
    });

    if (!_pluginCatalog.length) {
        gridEl.innerHTML = `
            <div style="grid-column:1/-1;text-align:center;padding:3.5rem 2rem;color:var(--text-muted);">
                <i class="mdi mdi-storefront-outline" style="font-size:38px;display:block;margin-bottom:0.75rem;opacity:0.4;"></i>
                <div style="font-size:0.95rem;font-weight:600;color:var(--text-primary);margin-bottom:0.35rem;">No plugins available in repositories</div>
                <div style="font-size:0.85rem;color:var(--text-secondary);max-width:440px;margin:0 auto;">
                    Configure external Git repositories via <strong>Manage Repositories</strong> or upload custom plugin ZIP archives from the settings menu.
                </div>
            </div>
        `;
        return;
    }

    if (!filtered.length) {
        gridEl.innerHTML = `
            <div style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--text-muted);">
                <i class="mdi mdi-magnify" style="font-size:32px;display:block;margin-bottom:0.5rem;opacity:0.4;"></i>
                No plugins match your search or filter criteria.
            </div>
        `;
        return;
    }

    let html = '';
    for (const p of filtered) {
        const installed = installedMap.get(p.id);
        const isInstalled = !!installed;
        const hasUpdate = isInstalled && installed.manifest.version !== p.version;

        let actionBtn = '';
        if (hasUpdate) {
            actionBtn = `<button class="btn btn-small btn-warning" onclick="installFromCatalog('${escapeHtml(p.id)}')"><i class="mdi mdi-arrow-up-bold-circle"></i> Update to v${escapeHtml(p.version)}</button>`;
        } else if (isInstalled) {
            actionBtn = `<button class="btn btn-small" style="background:rgba(16,185,129,0.15);color:var(--accent-success);border:1px solid rgba(16,185,129,0.3);" disabled><i class="mdi mdi-check"></i> Installed</button>`;
        } else {
            actionBtn = `<button class="btn btn-small btn-primary" onclick="installFromCatalog('${escapeHtml(p.id)}')"><i class="mdi mdi-download"></i> Install</button>`;
        }

        const iconHtml = p.icon_url 
            ? `<div class="plugin-catalog-icon"><img src="${escapeHtml(p.icon_url)}" alt="icon"></div>`
            : `<div class="plugin-catalog-icon"><i class="mdi ${escapeHtml(p.icon || 'mdi-puzzle')}"></i></div>`;

        const cats = Array.isArray(p.categories) && p.categories.length 
            ? p.categories 
            : (p.category ? [p.category] : []);
        
        const catBadgesHtml = cats.map(c => {
            const clower = String(c).toLowerCase();
            let label = clower.charAt(0).toUpperCase() + clower.slice(1);
            let catClass = 'cat-protocol';
            let iconClass = 'mdi-antenna';
            if (clower.includes('alert')) {
                catClass = 'cat-alert';
                iconClass = 'mdi-bell-alert';
            } else if (clower.includes('report')) {
                catClass = 'cat-report';
                iconClass = 'mdi-file-chart';
            } else if (clower.includes('integration')) {
                catClass = 'cat-integration';
                iconClass = 'mdi-cloud-sync';
            }
            return `<span class="plugin-cat-badge ${catClass}"><i class="mdi ${iconClass}"></i> ${escapeHtml(label)}</span>`;
        }).join(' ');

        html += `
            <div class="plugin-catalog-card">
                <div class="plugin-catalog-card-header">
                    ${iconHtml}
                    <div style="flex:1;overflow:hidden;min-width:0;">
                        <div class="plugin-catalog-card-title" title="${escapeHtml(p.name)}">
                            ${escapeHtml(p.name)}
                        </div>
                        <div class="plugin-catalog-card-meta">
                            <span>v${escapeHtml(p.version || '1.0.0')}</span> • <span>${escapeHtml(p.author || 'Community')}</span>
                        </div>
                    </div>
                </div>

                <div class="plugin-catalog-card-desc">
                    ${escapeHtml(p.description || 'No description available.')}
                </div>

                <div class="plugin-catalog-card-footer">
                    <div class="plugin-catalog-card-badges">
                        ${catBadgesHtml || '<span class="plugin-cat-badge">General</span>'}
                    </div>
                    ${actionBtn}
                </div>
            </div>
        `;
    }

    gridEl.innerHTML = html;
}

async function installFromCatalog(pluginId, clickedBtn = null) {
    const btn = clickedBtn || (typeof window !== 'undefined' && window.event ? window.event.currentTarget : null);
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span class="loading" style="width:13px;height:13px;display:inline-block;vertical-align:middle;margin-right:0.25rem;"></span> Installing…`;
    }

    try {
        const res = await apiFetch('/api/plugins/install', {
            method: 'POST',
            body: JSON.stringify({ plugin_id: pluginId }),
        });

        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.detail || `HTTP ${res.status}`);
        }

        showToast(`Plugin '${data.manifest.name || pluginId}' installed and hot-loaded!`);
        await loadInstalledPlugins();
        renderPluginCatalog();
    } catch (e) {
        showToast(`Installation failed: ${e.message}`, 'error');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<i class="mdi mdi-download"></i> Install`;
        }
    }
}

async function updatePlugin(pluginId) {
    await installFromCatalog(pluginId);
}

// ── 6. Uninstall Plugin ────────────────────────────────────────────────────────

async function confirmUninstallPlugin(pluginId, pluginName, inUse) {
    if (inUse) {
        showToast(`Cannot uninstall '${pluginName}' while it is currently in use. Please remove or reassign associated devices, alerts, or reports first.`, 'warning');
        return;
    }

    const warning = `Are you sure you want to uninstall '${pluginName}'?`;
    if (!confirm(warning)) return;

    try {
        const res = await apiFetch(`/api/plugins/${encodeURIComponent(pluginId)}/uninstall`, {
            method: 'POST',
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
        showToast(`Plugin '${pluginName}' uninstalled successfully.`);
        await loadInstalledPlugins();
    } catch (e) {
        showToast(`Failed to uninstall plugin: ${e.message}`, 'error');
    }
}

// ── 7. Upload Plugin ZIP ───────────────────────────────────────────────────────

function triggerUploadPluginZip() {
    const input = document.getElementById('pluginZipFileInput');
    if (input) input.click();
}

async function handlePluginZipSelected(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.zip')) {
        showToast('Please select a valid .zip archive.', 'error');
        return;
    }

    const formData = new FormData();
    formData.append('file', file);

    showToast('Uploading and installing plugin ZIP…');

    try {
        const res = await apiFetch('/api/plugins/upload', {
            method: 'POST',
            body: formData,
        });
        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.detail || `HTTP ${res.status}`);
        }
        showToast(`Plugin '${data.manifest.name || data.id}' uploaded and hot-loaded successfully!`);
        await loadInstalledPlugins();
    } catch (e) {
        showToast(`Upload failed: ${e.message}`, 'error');
    } finally {
        event.target.value = '';
    }
}
