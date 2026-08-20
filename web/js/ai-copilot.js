let _aiChatHistory = [];
let _copilotTableCache = [];
let _copilotCodeBlockCache = [];

function openAiCopilotModal() {
    const modal = document.getElementById('aiCopilotModal');
    if (modal) {
        modal.classList.add('active');
        setTimeout(() => document.getElementById('aiCopilotInput')?.focus(), 50);
    }
}

function closeAiCopilotModal() {
    document.getElementById('aiCopilotModal')?.classList.remove('active');
}

function sendAiCopilotChip(promptText) {
    const input = document.getElementById('aiCopilotInput');
    if (input) {
        input.value = promptText;
        autoResizeAiCopilotInput(input);
        input.focus();
    }
}

function autoResizeAiCopilotInput(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
    if (el.scrollHeight > 140) {
        el.style.overflowY = 'auto';
    } else {
        el.style.overflowY = 'hidden';
    }
}

function onAiCopilotInputKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendAiCopilotMessage();
    }
}

async function sendAiCopilotMessage() {
    const input = document.getElementById('aiCopilotInput');
    const thread = document.getElementById('aiCopilotChatThread');
    const sendBtn = document.getElementById('aiCopilotSendBtn');
    if (!input || !thread) return;

    const userText = input.value.trim();
    if (!userText) return;

    // Append User Message Bubble
    thread.insertAdjacentHTML('beforeend', `
        <div class="ai-chat-msg ai-msg-user" style="display:flex;gap:0.6rem;justify-content:flex-end;align-items:flex-start;">
            <div style="background:var(--accent-primary);color:#fff;border-radius:12px;padding:0.75rem 1rem;font-size:0.88rem;max-width:85%;line-height:1.5;">
                ${escapeHtml(userText)}
            </div>
        </div>
    `);
    input.value = '';
    autoResizeAiCopilotInput(input);
    thread.scrollTop = thread.scrollHeight;

    // Append Loading Indicator
    const loadingId = 'aiLoading_' + Date.now();
    thread.insertAdjacentHTML('beforeend', `
        <div id="${loadingId}" class="ai-chat-msg ai-msg-bot" style="display:flex;gap:0.6rem;align-items:flex-start;">
            <div style="width:32px;height:32px;border-radius:50%;background:rgba(99,102,241,0.15);color:var(--accent-primary);display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0;">
                <i class="mdi mdi-robot-excited"></i>
            </div>
            <div style="background:var(--bg-card);border:1px solid var(--border-color);border-radius:12px;padding:0.75rem 1rem;font-size:0.88rem;color:var(--text-muted);">
                <i class="mdi mdi-loading mdi-spin"></i> Analyzing fleet telemetry...
            </div>
        </div>
    `);
    thread.scrollTop = thread.scrollHeight;

    if (sendBtn) sendBtn.disabled = true;

    try {
        const fetchFunc = typeof apiFetch === 'function' ? apiFetch : fetch;
        const res = await fetchFunc('/api/llm/chat', {
            method: 'POST',
            body: JSON.stringify({
                prompt: userText,
                history: _aiChatHistory,
            }),
        });

        const loadingEl = document.getElementById(loadingId);
        if (loadingEl) loadingEl.remove();

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.detail || `Server returned ${res.status}`);
        }

        const data = await res.json();
        const responseText = data.response || 'No response returned.';

        // Remember conversation turns
        _aiChatHistory.push({ role: 'user', content: userText });
        _aiChatHistory.push({ role: 'assistant', content: responseText });

        const formattedText = renderMarkdown(responseText);

        thread.insertAdjacentHTML('beforeend', `
            <div class="ai-chat-msg ai-msg-bot" style="display:flex;gap:0.6rem;align-items:flex-start;">
                <div style="width:32px;height:32px;border-radius:50%;background:rgba(99,102,241,0.15);color:var(--accent-primary);display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0;">
                    <i class="mdi mdi-robot-excited"></i>
                </div>
                <div style="background:var(--bg-card);border:1px solid var(--border-color);border-radius:12px;padding:0.75rem 1rem;font-size:0.88rem;color:var(--text-primary);max-width:85%;line-height:1.5;">
                    ${formattedText}
                </div>
            </div>
        `);
    } catch (err) {
        const loadingEl = document.getElementById(loadingId);
        if (loadingEl) loadingEl.remove();

        thread.insertAdjacentHTML('beforeend', `
            <div class="ai-chat-msg ai-msg-bot" style="display:flex;gap:0.6rem;align-items:flex-start;">
                <div style="width:32px;height:32px;border-radius:50%;background:rgba(239,68,68,0.15);color:var(--accent-danger);display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0;">
                    <i class="mdi mdi-alert-circle"></i>
                </div>
                <div style="background:var(--bg-card);border:1px solid var(--accent-danger);border-radius:12px;padding:0.75rem 1rem;font-size:0.88rem;color:var(--accent-danger);max-width:85%;line-height:1.5;">
                    Error: ${escapeHtml(err.message)}
                </div>
            </div>
        `);
    } finally {
        if (sendBtn) sendBtn.disabled = false;
        thread.scrollTop = thread.scrollHeight;
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    })[m]);
}

function _formatTableCellContent(str) {
    if (!str) return '';
    let html = escapeHtml(str);
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/`(.*?)`/g, '<code style="background:var(--bg-secondary);padding:2px 4px;border-radius:3px;font-family:monospace;font-size:0.85em;">$1</code>');
    return html;
}

function buildHtmlTable(rows) {
    if (!rows.length) return '';
    let header = rows[0];
    let body = rows.slice(1);

    let ths = header.map(h => `<th style="padding:0.55rem 0.75rem;border:1px solid var(--border-color);background:var(--bg-secondary);text-align:left;font-weight:600;font-size:0.82rem;">${_formatTableCellContent(h)}</th>`).join('');
    let trs = body.map(row => {
        let tds = row.map(c => `<td style="padding:0.45rem 0.75rem;border:1px solid var(--border-color);font-size:0.84rem;">${_formatTableCellContent(c)}</td>`).join('');
        return `<tr>${tds}</tr>`;
    }).join('');

    let tableHtml = `<div style="overflow-x:auto;margin:0.75rem 0;"><table style="width:100%;border-collapse:collapse;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-card);"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;
    let key = `__COPILOT_TABLE_${_copilotTableCache.length}__`;
    _copilotTableCache.push(tableHtml);
    return key;
}

function renderMarkdown(text) {
    if (!text) return '';
    _copilotTableCache = [];
    _copilotCodeBlockCache = [];

    // 1. Extract fenced code blocks
    let str = text.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        let codeHtml = `<pre style="background:var(--bg-secondary);border:1px solid var(--border-color);padding:0.75rem 1rem;border-radius:8px;overflow-x:auto;font-family:monospace;font-size:0.85rem;line-height:1.45;margin:0.75rem 0;"><code class="language-${escapeHtml(lang)}">${escapeHtml(code.trim())}</code></pre>`;
        let key = `__COPILOT_CODE_${_copilotCodeBlockCache.length}__`;
        _copilotCodeBlockCache.push(codeHtml);
        return key;
    });

    // 2. Parse Markdown tables
    let lines = str.split('\n');
    let out = [];
    let inTable = false;
    let tableRows = [];

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (line.startsWith('|') && line.endsWith('|')) {
            if (line.replace(/[\s|:-]/g, '') === '') continue;
            inTable = true;
            let cells = line.split('|').slice(1, -1).map(c => c.trim());
            tableRows.push(cells);
        } else {
            if (inTable) {
                out.push(buildHtmlTable(tableRows));
                inTable = false;
                tableRows = [];
            }
            out.push(line);
        }
    }
    if (inTable && tableRows.length) {
        out.push(buildHtmlTable(tableRows));
    }

    let html = out.join('\n');
    html = escapeHtml(html);

    // 3. Headers
    html = html.replace(/^#### (.*$)/gim, '<h4 style="font-size:0.95rem;color:var(--accent-primary);margin-top:0.85rem;margin-bottom:0.3rem;font-weight:600;">$1</h4>');
    html = html.replace(/^### (.*$)/gim, '<h3 style="font-size:1.02rem;color:var(--accent-primary);margin-top:1rem;margin-bottom:0.4rem;font-weight:600;">$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2 style="font-size:1.1rem;color:var(--text-primary);margin-top:1.2rem;margin-bottom:0.5rem;font-weight:600;border-bottom:1px solid var(--border-color);padding-bottom:0.3rem;">$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1 style="font-size:1.2rem;color:var(--text-primary);margin-bottom:0.6rem;font-weight:700;">$1</h1>');

    // 4. Blockquotes
    html = html.replace(/^\s*&gt;\s+(.*$)/gim, '<blockquote style="border-left:3px solid var(--accent-primary);margin:0.5rem 0;padding:0.4rem 0.8rem;background:var(--bg-secondary);color:var(--text-muted);font-style:italic;border-radius:0 4px 4px 0;">$1</blockquote>');

    // 5. Horizontal rules
    html = html.replace(/^---$/gim, '<hr style="border:none;border-top:1px solid var(--border-color);margin:1rem 0;">');

    // 6. Bold, Italics, Links
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:var(--accent-primary);text-decoration:underline;">$1</a>');

    // 7. Bullet & Numbered lists
    html = html.replace(/^\s*[\-\*]\s+(.*$)/gim, '<li style="margin-left:1.2rem;margin-bottom:0.25rem;">$1</li>');
    html = html.replace(/^\s*(\d+)\.\s+(.*$)/gim, '<li style="margin-left:1.2rem;margin-bottom:0.25rem;">$2</li>');
    html = html.replace(/(<li.*?>.*?<\/li>\n?)+/g, '<ul style="margin:0.5rem 0;padding-left:0.5rem;">$&</ul>');

    // 8. Inline code
    html = html.replace(/`(.*?)`/g, '<code style="background:var(--bg-secondary);padding:2px 5px;border-radius:4px;font-family:monospace;font-size:0.85em;">$1</code>');

    // 9. Restore placeholders
    html = html.replace(/__COPILOT_TABLE_(\d+)__/g, (m, idx) => _copilotTableCache[idx] || '');
    html = html.replace(/__COPILOT_CODE_(\d+)__/g, (m, idx) => _copilotCodeBlockCache[idx] || '');

    // 10. Clean up newlines around block-level HTML elements
    html = html.replace(/\n?(<\/?(h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|div|hr)[^>]*>)\n?/gi, '$1');

    // 11. Replace remaining newlines with single <br>
    html = html.replace(/\n+/g, '<br>');
    return html;
}

// Show AI Copilot button if user has permission AND global llm_enabled is true
document.addEventListener('DOMContentLoaded', async () => {
    try {
        const wrap = document.getElementById('dashboardAiCopilotWrap');
        if (!wrap) return;
        const permsStr = localStorage.getItem('user_permissions') || '[]';
        const perms = JSON.parse(permsStr);
        const isAdmin = localStorage.getItem('is_admin') === 'true';
        const hasPerm = isAdmin || perms.includes('llm');

        if (!hasPerm) {
            wrap.style.display = 'none';
            return;
        }

        const fetchFunc = typeof apiFetch === 'function' ? apiFetch : fetch;
        const res = await fetchFunc('/api/system-settings/public').catch(() => null);

        if (res && res.ok) {
            const data = await res.json();
            if (data.llm_enabled) {
                wrap.style.display = '';
            } else {
                wrap.style.display = 'none';
            }
        } else {
            wrap.style.display = 'none';
        }
    } catch (e) {
        const wrap = document.getElementById('dashboardAiCopilotWrap');
        if (wrap) wrap.style.display = 'none';
    }
});
