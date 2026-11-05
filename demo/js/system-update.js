/**
 * web/js/system-update.js - Routario System Version & Web-Triggered Update Flow
 */

'use strict';

const SystemUpdateManager = {
    cachedInfo: null,
    pollingInterval: null,
    isUpdating: false,

    async fetchVersion(check = false) {
        try {
            const url = `${API_BASE}/system/version${check ? '?check=true' : ''}`;
            const res = await apiFetch(url);
            if (!res.ok) {
                throw new Error(`Failed to fetch version (HTTP ${res.status})`);
            }
            this.cachedInfo = await res.json();
            return this.cachedInfo;
        } catch (err) {
            console.error('[SystemUpdate] Version check error:', err);
            return null;
        }
    },

    escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    formatMarkdown(md) {
        if (!md) return '<p style="color:var(--text-muted);font-style:italic;">No release notes provided.</p>';
        if (typeof marked !== 'undefined' && typeof marked.parse === 'function') {
            try {
                return marked.parse(md, { gfm: true, breaks: true });
            } catch (err) {
                console.warn('[SystemUpdate] marked.parse failed, using fallback:', err);
            }
        }
        let html = this.escapeHtml(md);
        // Headers
        html = html.replace(/^#### (.*$)/gim, '<h4>$1</h4>');
        html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
        html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
        html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
        // Bold & Italic
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
        // Inline code
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        // Bullet lists
        html = html.replace(/^\s*[-*]\s+(.*$)/gim, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>)/gims, '<ul>$1</ul>');
        // Links
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:var(--accent-primary);">$1</a>');
        // Paragraph line breaks
        html = html.replace(/\n\n/g, '<br><br>');
        return html;
    },

    renderCard(containerId) {
        const container = document.getElementById(containerId);
        if (!container || !this.cachedInfo) return;

        const info = this.cachedInfo;
        const cur = info.current_version || '2026.10.0';
        const lat = info.latest_version || cur;
        const hasUpdate = Boolean(info.update_available);
        const dep = info.deployment || {};
        const commit = (info.version_details && info.version_details.commit) || '';
        const newerCount = info.newer_count || (hasUpdate ? 1 : 0);

        const statusPill = hasUpdate
            ? `<span class="version-pill version-pill-update"><i class="mdi mdi-arrow-up-bold-circle"></i> Update Available: v${this.escapeHtml(lat)}${newerCount > 1 ? ` (${newerCount} releases)` : ''}</span>`
            : `<span class="version-pill version-pill-ok"><i class="mdi mdi-check-circle"></i> Up to date</span>`;

        const updateBtn = hasUpdate
            ? `<button type="button" class="btn btn-primary" onclick="openSystemUpdateModal()"><i class="mdi mdi-arrow-up-bold-circle"></i> Update to v${this.escapeHtml(lat)}</button>`
            : `<button type="button" class="btn btn-secondary" onclick="openSystemUpdateModal()"><i class="mdi mdi-information-outline"></i> Version Details</button>`;

        container.innerHTML = `
            <div class="system-update-card ${hasUpdate ? 'has-update' : ''}">
                <div class="system-update-info">
                    <div class="system-update-icon">
                        <i class="mdi ${hasUpdate ? 'mdi-cellphone-arrow-down' : 'mdi-check-decagram'}"></i>
                    </div>
                    <div class="system-update-text">
                        <h3>
                            <span>Routario Telematics Platform</span>
                            <span class="version-pill version-pill-current">v${this.escapeHtml(cur)}</span>
                            ${statusPill}
                        </h3>
                        <div class="system-update-meta">
                            <span><i class="mdi mdi-source-commit"></i> ${commit ? `Commit ${this.escapeHtml(commit)}` : 'Release build'}</span>
                            <span>•</span>
                            <span><i class="mdi mdi-server"></i> ${this.escapeHtml(dep.description || 'Production')}</span>
                            ${info.commits_behind > 0 ? `<span>•</span><span style="color:var(--accent-warning);font-weight:600;">${info.commits_behind} commit${info.commits_behind === 1 ? '' : 's'} behind main</span>` : ''}
                        </div>
                    </div>
                </div>
                <div class="system-update-actions">
                    <button type="button" class="btn btn-secondary" id="systemUpdateCheckBtn" onclick="checkSystemVersion(true)" title="Check GitHub for newer releases">
                        <i class="mdi mdi-refresh"></i> Check for Updates
                    </button>
                    ${updateBtn}
                </div>
            </div>
        `;
    },

    ensureModal() {
        if (document.getElementById('systemUpdateModal')) return;

        const modalHtml = `
            <div class="modal" id="systemUpdateModal">
                <div class="modal-content update-modal-card">
                    <div class="update-modal-header">
                        <div style="display:flex;align-items:center;gap:0.6rem;">
                            <i class="mdi mdi-arrow-up-bold-circle-outline" style="font-size:1.4rem;color:var(--accent-primary);"></i>
                            <h2 style="font-size:1.15rem;margin:0;font-weight:700;">System Update &amp; Maintenance</h2>
                        </div>
                        <button type="button" class="modal-close" onclick="closeSystemUpdateModal()"><i class="mdi mdi-close"></i></button>
                    </div>

                    <div class="update-modal-body" id="updateModalBody">
                        <!-- Loaded dynamically in showModalContent() -->
                    </div>

                    <div class="update-modal-footer" id="updateModalFooter">
                        <button type="button" class="btn btn-secondary" onclick="closeSystemUpdateModal()">Close</button>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
    },

    showModalContent() {
        const body = document.getElementById('updateModalBody');
        const footer = document.getElementById('updateModalFooter');
        if (!body || !footer) return;

        const info = this.cachedInfo || {
            current_version: '2026.10.0',
            latest_version: '2026.10.0',
            update_available: false,
            deployment: { mode: 'git', can_auto_update: true },
        };

        const cur = info.current_version;
        const lat = info.latest_version;
        const hasUpdate = Boolean(info.update_available);
        const dep = info.deployment || {};

        let actionBtn = '';
        if (hasUpdate && dep.can_auto_update) {
            actionBtn = `
                <button type="button" class="btn btn-primary" id="startUpdateBtn" onclick="SystemUpdateManager.startUpdate()">
                    <i class="mdi mdi-download"></i> Install Update &amp; Restart
                </button>
            `;
        } else if (hasUpdate && !dep.can_auto_update) {
            actionBtn = `
                <button type="button" class="btn btn-secondary" onclick="SystemUpdateManager.copyManualCommand()">
                    <i class="mdi mdi-content-copy"></i> Copy Update Command
                </button>
            `;
        } else if (dep.can_auto_update) {
            actionBtn = `
                <button type="button" class="btn btn-secondary" onclick="checkSystemVersion(true)">
                    <i class="mdi mdi-refresh"></i> Force Re-check
                </button>
            `;
        }

        let dockerNotice = '';
        if (dep.is_docker && !dep.can_auto_update) {
            dockerNotice = `
                <div style="background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.25);border-radius:10px;padding:1rem;">
                    <div style="font-weight:600;margin-bottom:0.4rem;color:var(--text-primary);display:flex;align-items:center;gap:0.4rem;">
                        <i class="mdi mdi-docker" style="font-size:1.2rem;color:#38bdf8;"></i> Docker Deployment
                    </div>
                    <p style="margin:0 0 0.65rem 0;font-size:0.84rem;color:var(--text-secondary);">
                        To update your Docker container image to the latest release, run the following command on your host:
                    </p>
                    <div class="update-command-box">
                        <span id="updateManualCmdText">${this.escapeHtml(dep.manual_command || 'docker compose pull && docker compose up -d')}</span>
                        <button type="button" class="btn btn-secondary btn-small" onclick="SystemUpdateManager.copyManualCommand()" title="Copy command">
                            <i class="mdi mdi-content-copy"></i>
                        </button>
                    </div>
                </div>
            `;
        }

        // Collect all newer releases to display
        const releasesToDisplay = (info.newer_releases && info.newer_releases.length > 0)
            ? info.newer_releases
            : [{
                tag: lat,
                name: info.release_name || lat,
                html_url: info.release_url,
                published_at: info.published_at,
                body: info.release_notes || '',
            }];

        const newerCount = info.newer_count || (hasUpdate ? 1 : 0);
        const headerTitle = newerCount > 1
            ? `Release Notes (${newerCount} Updates Included)`
            : `Release Notes (${this.escapeHtml(releasesToDisplay[0]?.name || lat)})`;

        const releaseCardsHtml = releasesToDisplay.map((rel, index) => {
            const isLatestTarget = (index === 0 && hasUpdate);
            const pubDate = rel.published_at ? new Date(rel.published_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
            return `
                <div class="release-version-card ${isLatestTarget ? 'is-latest' : ''}">
                    <div class="release-version-header">
                        <div class="release-version-title">
                            <span class="version-pill ${isLatestTarget ? 'version-pill-current' : 'version-pill-ok'}">v${this.escapeHtml(rel.tag)}</span>
                            <span>${this.escapeHtml(rel.name && rel.name !== rel.tag ? rel.name : '')}</span>
                            ${isLatestTarget ? '<span class="version-pill version-pill-update" style="font-size:0.7rem;">Target Version</span>' : ''}
                        </div>
                        <div style="display:flex;align-items:center;gap:0.75rem;">
                            ${pubDate ? `<span class="release-version-date"><i class="mdi mdi-calendar"></i> ${this.escapeHtml(pubDate)}</span>` : ''}
                            ${rel.html_url ? `<a href="${this.escapeHtml(rel.html_url)}" target="_blank" rel="noopener" class="btn btn-secondary btn-small" style="font-size:0.75rem;padding:0.2rem 0.5rem;"><i class="mdi mdi-open-in-new"></i> GitHub</a>` : ''}
                        </div>
                    </div>
                    <div class="release-markdown-body">
                        ${this.formatMarkdown(rel.body)}
                    </div>
                </div>
            `;
        }).join('');

        body.innerHTML = `
            <div class="update-comparison-box">
                <div class="comp-item">
                    <div class="lbl">Installed Version</div>
                    <div style="font-weight:700;font-size:1.15rem;font-family:var(--font-mono, monospace);color:var(--text-primary);">
                        v${this.escapeHtml(cur)}
                    </div>
                </div>
                <div class="comp-arrow"><i class="mdi mdi-arrow-right"></i></div>
                <div class="comp-item">
                    <div class="lbl">Target Version</div>
                    <div style="font-weight:700;font-size:1.15rem;font-family:var(--font-mono, monospace);color:${hasUpdate ? 'var(--accent-warning)' : 'var(--accent-success)'};">
                        v${this.escapeHtml(lat)}
                    </div>
                </div>
            </div>

            ${dockerNotice}

            <div>
                <div style="font-weight:600;margin-bottom:0.6rem;font-size:0.92rem;color:var(--text-primary);display:flex;align-items:center;justify-content:space-between;">
                    <span>${headerTitle}</span>
                    ${newerCount > 1 ? `<span class="version-pill version-pill-update" style="font-size:0.75rem;"><i class="mdi mdi-layers-triple"></i> ${newerCount} updates ahead</span>` : ''}
                </div>
                <div class="release-notes-box">
                    ${releaseCardsHtml}
                </div>
            </div>

            <div id="updateTerminalContainer" style="display:none;">
                <div class="update-terminal-wrap">
                    <div class="update-terminal-header">
                        <span id="terminalStageLabel">Preparing update...</span>
                        <span id="terminalProgressLabel">0%</span>
                    </div>
                    <div class="update-progress-container">
                        <div class="update-progress-bar" id="updateProgressBar"></div>
                    </div>
                    <div class="update-terminal-body" id="updateTerminalLogs">
                        <div class="update-terminal-line">[Initializing update runner...]</div>
                    </div>
                </div>
            </div>
        `;

        footer.innerHTML = `
            <button type="button" class="btn btn-secondary" onclick="closeSystemUpdateModal()">Close</button>
            ${actionBtn}
        `;
    },

    copyManualCommand() {
        const cmd = document.getElementById('updateManualCmdText')?.textContent || 'docker compose pull && docker compose up -d';
        navigator.clipboard.writeText(cmd).then(() => {
            if (typeof showAlert === 'function') showAlert('Command copied to clipboard!', 'success');
        }).catch(() => {
            if (typeof showAlert === 'function') showAlert(cmd, 'info');
        });
    },

    async startUpdate() {
        if (!confirm('This will update Routario to the latest release and restart the server. Connected GPS devices will briefly reconnect. Proceed?')) {
            return;
        }

        const btn = document.getElementById('startUpdateBtn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i> Updating...';
        }

        const terminalContainer = document.getElementById('updateTerminalContainer');
        if (terminalContainer) terminalContainer.style.display = 'block';

        try {
            const res = await apiFetch(`${API_BASE}/system/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ target_version: this.cachedInfo?.latest_version || 'latest' }),
            });

            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.detail || `Update request failed with HTTP ${res.status}`);
            }

            this.isUpdating = true;
            this.pollProgress();
        } catch (err) {
            if (typeof showAlert === 'function') showAlert(err.message, 'error');
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="mdi mdi-alert-circle"></i> Retry Update';
            }
        }
    },

    pollProgress() {
        if (this.pollingInterval) clearInterval(this.pollingInterval);

        this.pollingInterval = setInterval(async () => {
            try {
                const res = await apiFetch(`${API_BASE}/system/update/status`);
                if (!res.ok) return;
                const status = await res.json();

                const stageEl = document.getElementById('terminalStageLabel');
                const progressEl = document.getElementById('terminalProgressLabel');
                const barEl = document.getElementById('updateProgressBar');
                const logsEl = document.getElementById('updateTerminalLogs');

                if (stageEl) stageEl.textContent = status.stage || status.status;
                if (progressEl) progressEl.textContent = `${status.progress || 0}%`;
                if (barEl) barEl.style.width = `${status.progress || 0}%`;

                if (logsEl && Array.isArray(status.logs)) {
                    logsEl.innerHTML = status.logs.map(line => `<div class="update-terminal-line">${this.escapeHtml(line)}</div>`).join('');
                    logsEl.scrollTop = logsEl.scrollHeight;
                }

                if (status.status === 'restarting') {
                    clearInterval(this.pollingInterval);
                    this.pollReconnection();
                } else if (status.status === 'failed') {
                    clearInterval(this.pollingInterval);
                    this.isUpdating = false;
                    if (typeof showAlert === 'function') showAlert(status.error || 'Update failed', 'error');
                }
            } catch (e) {
                // Network disconnect is expected when server restarts
            }
        }, 1000);
    },

    pollReconnection() {
        const stageEl = document.getElementById('terminalStageLabel');
        const logsEl = document.getElementById('updateTerminalLogs');
        const barEl = document.getElementById('updateProgressBar');

        if (stageEl) stageEl.textContent = 'Server restarting... Waiting for reconnection';
        if (barEl) barEl.style.width = '100%';
        if (logsEl) {
            logsEl.innerHTML += '<div class="update-terminal-line" style="color:#a7f3d0;">[Restart triggered] Pinging healthcheck endpoint...</div>';
            logsEl.scrollTop = logsEl.scrollHeight;
        }

        let attempts = 0;
        const checkInterval = setInterval(async () => {
            attempts++;
            try {
                const res = await fetch('/api/health/live', { cache: 'no-store' });
                if (res.ok) {
                    clearInterval(checkInterval);
                    if (logsEl) {
                        logsEl.innerHTML += '<div class="update-terminal-line" style="color:#4ade80;">[ONLINE] Routario restarted successfully! Reloading...</div>';
                        logsEl.scrollTop = logsEl.scrollHeight;
                    }
                    setTimeout(() => {
                        window.location.reload();
                    }, 1500);
                }
            } catch (err) {
                // Still restarting
            }
            if (attempts > 90) {
                clearInterval(checkInterval);
                if (typeof showAlert === 'function') showAlert('Server restart took longer than expected. Please refresh manually.', 'warning');
            }
        }, 2000);
    },
};

// Global helpers
window.openSystemUpdateModal = async function() {
    SystemUpdateManager.ensureModal();
    if (!SystemUpdateManager.cachedInfo) {
        await SystemUpdateManager.fetchVersion(false);
    }
    SystemUpdateManager.showModalContent();
    document.getElementById('systemUpdateModal')?.classList.add('active');
};

window.closeSystemUpdateModal = function() {
    if (SystemUpdateManager.isUpdating) {
        if (!confirm('An update is currently running. Are you sure you want to close this window?')) return;
    }
    document.getElementById('systemUpdateModal')?.classList.remove('active');
};

window.checkSystemVersion = async function(force = true) {
    const btn = document.getElementById('systemUpdateCheckBtn');
    let originalHtml = '';
    if (btn) {
        originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i> Checking...';
    }

    const info = await SystemUpdateManager.fetchVersion(force);

    if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
    }

    if (info) {
        SystemUpdateManager.renderCard('systemUpdateCardContainer');
        if (document.getElementById('systemUpdateModal')?.classList.contains('active')) {
            SystemUpdateManager.showModalContent();
        }
        if (force && typeof showAlert === 'function') {
            if (info.update_available) {
                showAlert(`New update available: v${info.latest_version}!`, 'warning');
            } else {
                showAlert(`Routario is up to date (v${info.current_version}).`, 'success');
            }
        }
    }
};

// Auto-run when DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
    const isAdmin = localStorage.getItem('is_admin') === 'true';
    const container = document.getElementById('systemUpdateCardContainer');
    if (isAdmin && container) {
        const info = await SystemUpdateManager.fetchVersion(false);
        if (info) SystemUpdateManager.renderCard('systemUpdateCardContainer');
    }
});
