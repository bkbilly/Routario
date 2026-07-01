'use strict';
/* ================================================================
   Voice PTT — map-ctrl-bar trigger + tabbed modal
   Requires: config.js (API_BASE, apiFetch)
   ================================================================ */

(function () {
    const _myId     = parseInt(localStorage.getItem('user_id'), 10);
    const _isAdmin  = localStorage.getItem('is_admin') === 'true';
    const _isCAdmin = localStorage.getItem('is_company_admin') === 'true';
    const _canDel   = _isAdmin || _isCAdmin;

    let _ws           = null;
    let _wsRetryTimer = null;
    let _modalOpen    = false;

    let _users      = [];
    let _recipients = [];
    let _messages   = [];

    let _unreadIds    = new Set();   // IDs of messages not yet seen
    let _unreadFilter = false;       // true = history filtered to unread only

    let _histSearch  = '';
    let _histSortCol = 'created_at';
    let _histSortDir = -1;   // -1 = newest first
    let _histPage    = 1;
    let _histPages   = 1;
    let _histTotal   = 0;
    const _PAGE_SIZE = 20;

    let _recording     = false;
    let _mediaRecorder = null;
    let _stopTimer     = null;

    const _incoming = {};   // sessionId -> { senderName, chunks[] }

    let _playingId    = null;
    let _playingAudio = null;

    // ── CSS ───────────────────────────────────────────────────────

    function _injectCss() {
        if (document.getElementById('ptt-css')) return;
        const l = Object.assign(document.createElement('link'), {
            id: 'ptt-css', rel: 'stylesheet', href: 'css/voice-ptt.css',
        });
        document.head.appendChild(l);
    }

    // ── Trigger button ────────────────────────────────────────────
    // On dashboard: append to .map-ctrl-group as another map-ctrl-bar.

    function _injectButton() {
        const btnHtml = `
            <button class="map-ctrl-btn" id="pttTriggerBtn" onclick="pttToggleModal()" title="Voice PTT">
                <i class="mdi mdi-microphone-message" style="font-size:15px;"></i>
                <span class="map-ctrl-badge" id="pttBadge" style="display:none;"></span>
            </button>`;

        const ctrlGroup = document.querySelector('.map-ctrl-group');
        if (!ctrlGroup) return;
        const bar = document.createElement('div');
        bar.className = 'map-ctrl-bar';
        bar.innerHTML = btnHtml;
        const routesBar = document.getElementById('dashboardRoutesBtn')?.closest('.map-ctrl-bar');
        if (routesBar && routesBar.parentElement === ctrlGroup) {
            ctrlGroup.insertBefore(bar, routesBar);
        } else {
            ctrlGroup.appendChild(bar);
        }
    }

    // ── Modal ─────────────────────────────────────────────────────

    function _injectModal() {
        const el = document.createElement('div');
        el.className = 'modal';
        el.id        = 'pttModal';
        el.innerHTML = `
            <div class="modal-content" style="max-width:560px;height:auto;max-height:80vh;">
                <div class="modal-header">
                    <h2 class="modal-title">
                        <i class="mdi mdi-microphone-message" style="color:var(--accent-primary,#3b82f6);margin-right:0.4rem;font-size:1.1rem;"></i>
                        Voice
                    </h2>
                    <button class="modal-close" onclick="pttCloseModal()"><i class="mdi mdi-close"></i></button>
                </div>
                <div class="ptt-modal-tabs">
                    <button class="ptt-modal-tab active" id="pttTabTalkBtn" onclick="pttSwitchTab('talk')">
                        <i class="mdi mdi-microphone"></i> Talk
                    </button>
                    <button class="ptt-modal-tab" id="pttTabHistoryBtn" onclick="pttSwitchTab('history')">
                        <i class="mdi mdi-history"></i> History
                        <span id="pttHistoryBadge" style="display:none;margin-left:0.3rem;background:var(--accent-danger,#ef4444);color:#fff;border-radius:50%;min-width:16px;height:16px;padding:0 3px;font-size:10px;font-weight:700;line-height:16px;text-align:center;display:none;"></span>
                    </button>
                </div>

                <!-- Talk tab -->
                <div class="ptt-tab-content active" id="pttTabTalk">
                    <div class="ptt-to-section">
                        <div class="ptt-to-label" id="pttToLabel">To</div>
                        <input type="text" class="ptt-to-search" id="pttUserSearch"
                            placeholder="Search users…" oninput="pttFilterUsers()">
                        <div class="ptt-user-list" id="pttUserList">
                            <div style="text-align:center;padding:0.5rem;color:var(--text-muted,#6b7280);font-size:0.8rem;">Loading…</div>
                        </div>
                    </div>
                    <div class="ptt-center">
                        <div class="ptt-wave" id="pttWave">
                            <span></span><span></span><span></span><span></span>
                            <span></span><span></span><span></span>
                        </div>
                        <button class="ptt-talk-btn" id="pttTalkBtn"
                            onmousedown="pttStartTx()" onmouseup="pttStopTx()"
                            ontouchstart="pttStartTx(event)" ontouchend="pttStopTx(event)">
                            <i class="mdi mdi-microphone"></i>
                        </button>
                        <div class="ptt-status" id="pttStatus">Hold to Talk</div>
                    </div>
                </div>

                <!-- History tab -->
                <div class="ptt-tab-content" id="pttTabHistory">
                    <div class="ptt-hist-toolbar">
                        <div style="display:flex;gap:0.4rem;align-items:center;">
                            <input type="text" class="ptt-hist-search" id="pttHistSearch"
                                placeholder="Search…" oninput="pttHistFilter()" style="flex:1;">
                            <button class="ptt-read-all-btn" onclick="pttReadAll()" title="Mark all as read">
                                <i class="mdi mdi-check-all"></i>
                            </button>
                            ${_isAdmin ? `<button class="ptt-read-all-btn" onclick="pttDeleteAll()" title="Delete all messages" style="color:var(--accent-danger,#ef4444)"><i class="mdi mdi-delete-sweep"></i></button>` : ''}
                        </div>
                        <div id="pttUnreadChip" class="ptt-unread-chip" style="display:none;">
                            <i class="mdi mdi-filter"></i> Unread only
                            <button onclick="pttClearUnreadFilter()" title="Show all"><i class="mdi mdi-close"></i></button>
                        </div>
                    </div>
                    <div class="ptt-history" id="pttHistory">
                        <table class="ptt-hist-table">
                            <thead>
                                <tr>
                                    <th onclick="pttHistSort('created_at')">Date <span id="pttSortArrow-created_at">↓</span></th>
                                    <th onclick="pttHistSort('sender_name')">From <span id="pttSortArrow-sender_name"></span></th>
                                    <th>To</th>
                                    <th onclick="pttHistSort('duration_seconds')">Dur <span id="pttSortArrow-duration_seconds"></span></th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody id="pttHistBody">
                                <tr><td colspan="5" class="ptt-hist-empty">No messages yet</td></tr>
                            </tbody>
                        </table>
                        <div id="pttPagination" style="display:none;flex-direction:row;justify-content:center;align-items:center;gap:0.5rem;padding:0.5rem 0.5rem 0;border-top:1px solid var(--border-color,#374151);">
                            <button id="pttPagePrev" class="ptt-read-all-btn" title="Previous page"><i class="mdi mdi-chevron-left"></i></button>
                            <span id="pttPageInfo" style="font-size:0.8rem;color:var(--text-secondary,#9ca3af);min-width:80px;text-align:center;"></span>
                            <button id="pttPageNext" class="ptt-read-all-btn" title="Next page"><i class="mdi mdi-chevron-right"></i></button>
                        </div>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(el);

        // Toast
        const toast = document.createElement('div');
        toast.id        = 'pttToast';
        toast.className = 'ptt-toast';
        toast.innerHTML = `
            <span class="ptt-toast-icon"><i class="mdi mdi-microphone-message"></i></span>
            <div class="ptt-toast-info">
                <div class="ptt-toast-sender" id="pttToastSender"></div>
                <div class="ptt-toast-status"  id="pttToastStatus"></div>
            </div>`;
        document.body.appendChild(toast);
    }

    // ── WebSocket ─────────────────────────────────────────────────

    function _connect() {
        const token = localStorage.getItem('auth_token');
        if (!token) return;
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        _ws = new WebSocket(`${proto}://${location.host}/api/voice/ws?token=${encodeURIComponent(token)}`);
        _ws.binaryType = 'arraybuffer';
        _ws.onopen    = () => clearTimeout(_wsRetryTimer);
        _ws.onmessage = (e) => typeof e.data === 'string' ? _onJson(JSON.parse(e.data)) : _onChunk(e.data);
        _ws.onclose   = () => { _ws = null; _wsRetryTimer = setTimeout(_connect, 4000); };
        _ws.onerror   = () => _ws?.close();
    }

    function _send(data)   { if (_ws?.readyState === WebSocket.OPEN) _ws.send(JSON.stringify(data)); }
    function _sendBin(buf) { if (_ws?.readyState === WebSocket.OPEN) _ws.send(buf); }

    // ── Incoming ──────────────────────────────────────────────────

    function _onJson(data) {
        if (data.type === 'message_read') {
            const m = _messages.find(x => x.id === data.message_id);
            if (m) { m.is_read = true; _unreadIds.delete(data.message_id); _updateBadge(); _renderHistory(); }
            return;
        }
        if (data.type === 'read_all') {
            _messages.forEach(m => { m.is_read = true; });
            _unreadIds.clear();
            _unreadFilter = false;
            _updateBadge();
            _renderHistory();
            return;
        }
        if (data.type === 'transmitting') {
            _incoming[data.session_id] = { senderName: data.sender_name, chunks: [] };
            _showToast(data.sender_name, 'Transmitting…');
        } else if (data.type === 'done') {
            const sess = _incoming[data.session_id];
            const heardLive = !!(sess?.chunks?.length);
            if (sess) {
                _playBlob(sess.chunks, data.sender_name, data.duration);
                delete _incoming[data.session_id];
            }
            const prevIds = new Set(_messages.map(m => m.id));
            _histPage = 1;
            _loadMessages().then(() => {
                if (heardLive) {
                    // Mark any newly appeared messages as read (user heard them live)
                    const liveIds = new Set(_messages.filter(m => !prevIds.has(m.id) && m.sender_id !== _myId).map(m => m.id));
                    if (liveIds.size) _loadMessages(liveIds);
                }
            });
        }
    }

    function _onChunk(buf) {
        const arr  = new Uint8Array(buf);
        const pipe = arr.indexOf(0x7C);
        if (pipe < 0) return;
        const sid  = new TextDecoder().decode(arr.slice(0, pipe));
        const sess = _incoming[sid];
        if (sess) sess.chunks.push(arr.slice(pipe + 1));
    }

    function _playBeep(onDone) {
        try {
            const ctx  = new (window.AudioContext || window.webkitAudioContext)();
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type      = 'sine';
            osc.frequency.setValueAtTime(1200, ctx.currentTime);
            osc.frequency.linearRampToValueAtTime(900, ctx.currentTime + 0.12);
            gain.gain.setValueAtTime(0.25, ctx.currentTime);
            gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.15);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.15);
            osc.onended = () => { ctx.close(); onDone(); };
        } catch (_) {
            onDone();
        }
    }

    function _playBlob(chunks, senderName, duration) {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const url  = URL.createObjectURL(blob);
        _showToast(senderName, `${_fmtDur(duration)} · playing`);
        _playBeep(() => {
            const audio = new Audio(url);
            audio.play().catch(() => {});
            audio.onended = () => { URL.revokeObjectURL(url); _hideToast(); };
        });
    }

    // ── Toast ─────────────────────────────────────────────────────

    let _toastTimer = null;
    function _showToast(sender, status) {
        const t = document.getElementById('pttToast');
        if (!t) return;
        document.getElementById('pttToastSender').textContent = sender;
        document.getElementById('pttToastStatus').textContent = status;
        // Make it display:flex first, then fade in on next frame so the transition fires
        t.style.display = 'flex';
        requestAnimationFrame(() => {
            requestAnimationFrame(() => t.classList.add('visible'));
        });
        clearTimeout(_toastTimer);
        _toastTimer = setTimeout(_hideToast, 7000);
    }
    function _hideToast() {
        const t = document.getElementById('pttToast');
        if (!t) return;
        t.classList.remove('visible');
        // Hide after transition ends so it doesn't linger in the layout
        setTimeout(() => { if (!t.classList.contains('visible')) t.style.display = 'none'; }, 220);
    }

    // ── Badge ─────────────────────────────────────────────────────

    function _updateBadge() {
        const b = document.getElementById('pttBadge');
        if (!b) return;
        const n = _unreadIds.size;
        b.textContent   = n > 99 ? '99+' : n;
        b.style.display = n ? 'block' : 'none';
    }

    // ── Modal open/close ──────────────────────────────────────────

    window.pttToggleModal = function () {
        _openModal();
    };

    function _openModal() {
        _modalOpen = true;
        const hadUnread = _unreadIds.size > 0;
        document.getElementById('pttModal').classList.add('active');
        _histPage = 1;
        _loadUsers();
        _loadMessages().then(() => {
            if (hadUnread) {
                pttSwitchTab('history');
            }
        });
    }

    window.pttCloseModal = function () {
        _modalOpen = false;
        document.getElementById('pttModal').classList.remove('active');
    };

    window.pttSwitchTab = function (tab) {
        document.querySelectorAll('.ptt-modal-tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.ptt-tab-content').forEach(c => c.classList.remove('active'));
        document.getElementById(`pttTab${tab.charAt(0).toUpperCase() + tab.slice(1)}Btn`).classList.add('active');
        document.getElementById(`pttTab${tab.charAt(0).toUpperCase() + tab.slice(1)}`).classList.add('active');
    };

    // ── Recipient toggle list ─────────────────────────────────────

    window.pttFilterUsers = function () {
        _renderUserList(document.getElementById('pttUserSearch')?.value.trim().toLowerCase() || '');
    };

    function _renderUserList(q) {
        const list     = document.getElementById('pttUserList');
        if (!list) return;
        const filtered = q ? _users.filter(u => u.username.toLowerCase().includes(q)) : _users;
        if (!filtered.length) {
            list.innerHTML = '<div style="text-align:center;padding:0.5rem;color:var(--text-muted,#6b7280);font-size:0.8rem;">No users</div>';
            return;
        }
        list.innerHTML = filtered.map(u => `
            <div class="ptt-user-row">
                <span class="ptt-user-name">${_esc(u.username)}${u.is_admin ? '<span class="ptt-user-badge">ADMIN</span>' : ''}</span>
                <label class="ptt-toggle">
                    <input type="checkbox" ${_recipients.includes(u.id) ? 'checked' : ''}
                        onchange="pttToggleRecipient(${u.id}, this.checked)">
                    <span class="ptt-toggle-slider"></span>
                </label>
            </div>`).join('');
    }

    window.pttToggleRecipient = function (uid, checked) {
        if (checked) { if (!_recipients.includes(uid)) _recipients.push(uid); }
        else { _recipients = _recipients.filter(x => x !== uid); }
        _updateToLabel();
    };

    function _updateToLabel() {
        const el = document.getElementById('pttToLabel');
        if (!el) return;
        const total = _users.length;
        if (!_recipients.length) {
            el.textContent = total ? `To — Everyone (${total})` : 'To';
        } else {
            el.textContent = `To — ${_recipients.length} of ${total} selected`;
        }
    }

    // ── PTT recording ─────────────────────────────────────────────

    window.pttStartTx = function (e) {
        if (e) e.preventDefault();
        clearTimeout(_stopTimer);
        _stopTimer = null;
        if (_recording) return;
        navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(stream => {
            _send({ type: 'start', recipients: _recipients });
            _recording = true;
            document.getElementById('pttTalkBtn')?.classList.add('recording');
            document.getElementById('pttWave')?.classList.add('active');
            _setStatus('Transmitting…', 'tx');

            _mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
            _mediaRecorder.ondataavailable = (ev) => {
                if (ev.data?.size > 0) ev.data.arrayBuffer().then(_sendBin);
            };
            _mediaRecorder.start(300);
        }).catch(() => _setStatus('Mic access denied', ''));
    };

    window.pttStopTx = function (e) {
        if (e) e.preventDefault();
        if (!_recording) return;
        _stopTimer = setTimeout(() => {
            _stopTimer = null;
            _recording = false;
            _mediaRecorder?.stop();
            _mediaRecorder?.stream?.getTracks().forEach(t => t.stop());
            _mediaRecorder = null;
            _send({ type: 'end' });
            document.getElementById('pttTalkBtn')?.classList.remove('recording');
            document.getElementById('pttWave')?.classList.remove('active');
            _setStatus('Hold to Talk', '');
            setTimeout(() => { _histPage = 1; _loadMessages(); }, 600);
        }, 500);
    };

    function _setStatus(text, cls) {
        const el = document.getElementById('pttStatus');
        if (!el) return;
        el.textContent = text;
        el.className   = `ptt-status ${cls}`;
    }

    // ── History ───────────────────────────────────────────────────

    async function _loadUsers() {
        try {
            const res = await apiFetch(`${API_BASE}/voice/users`);
            if (res.ok) { _users = await res.json(); _renderUserList(''); _updateToLabel(); }
        } catch (_) {}
    }

    async function _loadMessages(markLiveRead = null) {
        try {
            const res = await apiFetch(`${API_BASE}/voice/messages?page=${_histPage}&page_size=${_PAGE_SIZE}`);
            if (!res.ok) return;
            const data    = await res.json();
            const newList = data.items;
            _histPages = data.pages;
            _histTotal = data.total;

            if (markLiveRead?.size) {
                newList.forEach(m => { if (markLiveRead.has(m.id)) m.is_read = true; });
                markLiveRead.forEach(id =>
                    apiFetch(`${API_BASE}/voice/messages/${id}/read`, { method: 'POST' }).catch(() => {})
                );
            }
            _messages = newList;
            // Merge unread IDs: add newly seen unread, remove ones now marked read
            newList.forEach(m => {
                if (!m.is_read && m.sender_id !== _myId) _unreadIds.add(m.id);
                else _unreadIds.delete(m.id);
            });
            _updateBadge();
            _renderHistory();
        } catch (_) {}
    }

    window.pttHistFilter = function () {
        _histSearch = document.getElementById('pttHistSearch')?.value.trim().toLowerCase() || '';
        _renderHistory();
    };

    window.pttClearUnreadFilter = function () {
        _unreadFilter = false;
        _renderHistory();
    };

    window.pttReadAll = async function () {
        _messages.forEach(m => { m.is_read = true; });
        _unreadIds.clear();
        _unreadFilter = false;
        _updateBadge();
        _renderHistory();
        apiFetch(`${API_BASE}/voice/messages/read-all`, { method: 'POST' }).catch(() => {});
    };

    window.pttHistSort = function (col) {
        if (_histSortCol === col) { _histSortDir = -_histSortDir; }
        else { _histSortCol = col; _histSortDir = col === 'created_at' ? -1 : 1; }
        _renderHistory();
    };

    window.pttHistGotoPage = function (p) {
        if (p < 1 || p > _histPages) return;
        _histPage = p;
        _loadMessages();
    };

    window.pttDeleteAll = async function () {
        if (!confirm('Delete ALL voice messages? This cannot be undone.')) return;
        try {
            const res = await apiFetch(`${API_BASE}/voice/messages`, { method: 'DELETE' });
            if (res.ok) {
                _messages  = [];
                _histPage  = 1;
                _histPages = 1;
                _histTotal = 0;
                _unreadIds.clear();
                _updateBadge();
                _renderHistory();
            }
        } catch (_) {}
    };

    function _renderHistory() {
        const tbody = document.getElementById('pttHistBody');
        if (!tbody) return;

        // Unread chip visibility
        const chip = document.getElementById('pttUnreadChip');
        if (chip) chip.style.display = _unreadFilter ? '' : 'none';

        // Update sort arrows
        ['created_at', 'sender_name', 'duration_seconds'].forEach(c => {
            const el = document.getElementById(`pttSortArrow-${c}`);
            if (!el) return;
            el.textContent = _histSortCol === c ? (_histSortDir === 1 ? '↑' : '↓') : '';
        });

        let list = [..._messages];

        // Unread filter
        if (_unreadFilter && _unreadIds.size) {
            list = list.filter(m => _unreadIds.has(m.id));
        }

        // Search filter
        if (_histSearch) {
            list = list.filter(m => {
                const to = !m.recipient_ids.length ? 'everyone'
                    : m.recipient_ids.map(id => _users.find(u => u.id === id)?.username || '').join(' ').toLowerCase();
                return m.sender_name.toLowerCase().includes(_histSearch) || to.includes(_histSearch);
            });
        }

        // Sort
        list.sort((a, b) => {
            const av = a[_histSortCol] ?? '';
            const bv = b[_histSortCol] ?? '';
            return av < bv ? -_histSortDir : av > bv ? _histSortDir : 0;
        });

        // Pagination controls
        const pagEl  = document.getElementById('pttPagination');
        const infoEl = document.getElementById('pttPageInfo');
        const prevEl = document.getElementById('pttPagePrev');
        const nextEl = document.getElementById('pttPageNext');
        if (pagEl)  pagEl.style.display  = _histPages > 1 ? 'flex' : 'none';
        if (infoEl) infoEl.textContent   = `Page ${_histPage} of ${_histPages}`;
        if (prevEl) { prevEl.disabled = _histPage <= 1;          prevEl.onclick = () => pttHistGotoPage(_histPage - 1); }
        if (nextEl) { nextEl.disabled = _histPage >= _histPages; nextEl.onclick = () => pttHistGotoPage(_histPage + 1); }

        if (!list.length) {
            tbody.innerHTML = `<tr><td colspan="5" class="ptt-hist-empty">${_histSearch ? 'No results' : 'No messages yet'}</td></tr>`;
            return;
        }

        tbody.innerHTML = list.map(m => {
            const isPlaying = _playingId === m.id;
            const isMe    = m.sender_id === _myId;
            const toLabel = !m.recipient_ids.length
                ? `Everyone (${_users.length || '?'})`
                : m.recipient_ids.map(id => id === _myId ? 'You' : (_users.find(u => u.id === id)?.username || `#${id}`)).join(', ');
            const dt   = new Date(m.created_at);
            const date = dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            const time = dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
            const unread = _unreadIds.has(m.id);
            return `
            <tr${unread ? ' class="ptt-row-unread"' : ''}>
                <td class="ptt-td-date">${date}<br><span style="color:var(--text-muted,#6b7280)">${time}</span></td>
                <td class="ptt-td-from">${unread ? '<span class="ptt-dot"></span>' : ''}${_esc(m.sender_name)}${isMe ? ' <span class="ptt-you">YOU</span>' : ''}</td>
                <td class="ptt-td-to">${_esc(toLabel)}</td>
                <td class="ptt-td-dur">${_fmtDur(m.duration_seconds)}</td>
                <td class="ptt-td-act">
                    <button class="ptt-play-btn${isPlaying ? ' playing' : ''}" id="pttPlay-${m.id}" onclick="pttPlayMsg(${m.id})" title="${isPlaying ? 'Stop' : 'Play'}">
                        <i class="mdi mdi-${isPlaying ? 'stop' : 'play'}" id="pttPlayIcon-${m.id}"></i>
                    </button>
                    ${_canDel ? `<button class="ptt-del-btn" onclick="pttDelMsg(${m.id})" title="Delete"><i class="mdi mdi-delete"></i></button>` : ''}
                </td>
            </tr>`;
        }).join('');
    }

    window.pttPlayMsg = async function (id) {
        // Stop previous
        if (_playingAudio) {
            _playingAudio.pause();
            _playingAudio = null;
            const _prevIcon = document.getElementById(`pttPlayIcon-${_playingId}`); if (_prevIcon) { _prevIcon.classList.remove('mdi-stop'); _prevIcon.classList.add('mdi-play'); }
            document.getElementById(`pttPlay-${_playingId}`)?.classList.remove('playing');
            _clearProgressBar(_playingId);
            if (_playingId === id) { _playingId = null; return; }
        }
        _playingId = id;
        const _curIcon = document.getElementById(`pttPlayIcon-${id}`);
        if (_curIcon) { _curIcon.classList.remove('mdi-play'); _curIcon.classList.add('mdi-stop'); }
        document.getElementById(`pttPlay-${id}`)?.classList.add('playing');

        try {
            const res = await apiFetch(`${API_BASE}/voice/messages/${id}/audio`);
            if (!res.ok) {
                _resetPlayBtn(id);
                _playingId = null;
                const msg = res.status === 404 ? 'Audio file not found' : 'Failed to load audio';
                if (typeof showAlert === 'function') showAlert(msg, 'error');
                return;
            }
            const blob  = await res.blob();
            const url   = URL.createObjectURL(blob);
            const audio = new Audio(url);
            _playingAudio = audio;
            audio.play().catch(() => {
                _resetPlayBtn(id);
                _clearProgressBar(id);
                _playingId    = null;
                _playingAudio = null;
                URL.revokeObjectURL(url);
                if (typeof showAlert === 'function') showAlert('Could not play audio', 'error');
            });
            const knownDur = _messages.find(m => m.id === id)?.duration_seconds || 0;
            audio.ontimeupdate = () => {
                const dur = (knownDur > 0) ? knownDur : (isFinite(audio.duration) ? audio.duration : 0);
                if (!dur) return;
                const pct = Math.min(100, Math.round((audio.currentTime / dur) * 100));
                const row = document.getElementById(`pttPlay-${id}`)?.closest('tr');
                if (row) { row.classList.add('ptt-row-playing'); row.style.setProperty('--ptt-prog', `${pct}%`); }
            };
            // Mark as read when playback starts — update in-place, no full re-render
            apiFetch(`${API_BASE}/voice/messages/${id}/read`, { method: 'POST' }).then(() => {
                const m = _messages.find(x => x.id === id);
                if (m && !m.is_read) {
                    m.is_read = true;
                    _unreadIds.delete(id);
                    _updateBadge();
                    // Remove unread styling from this row only
                    const row = document.getElementById(`pttPlay-${id}`)?.closest('tr');
                    if (row) {
                        row.classList.remove('ptt-row-unread');
                        row.querySelector('.ptt-dot')?.remove();
                    }
                }
            }).catch(() => {});
            audio.onended = () => { URL.revokeObjectURL(url); _resetPlayBtn(id); _clearProgressBar(id); _playingId = null; _playingAudio = null; };
        } catch (_) {
            _resetPlayBtn(id);
            _playingId = null;
            if (typeof showAlert === 'function') showAlert('Error loading audio', 'error');
        }
    };

    function _clearProgressBar(id) {
        const row = document.getElementById(`pttPlay-${id}`)?.closest('tr');
        if (row) { row.classList.remove('ptt-row-playing'); row.style.removeProperty('--ptt-prog'); }
    }

    function _resetPlayBtn(id) {
        const icon = document.getElementById(`pttPlayIcon-${id}`);
        if (icon) { icon.classList.remove('mdi-stop'); icon.classList.add('mdi-play'); }
        document.getElementById(`pttPlay-${id}`)?.classList.remove('playing');
    }

    window.pttDelMsg = async function (id) {
        if (!confirm('Delete this voice message?')) return;
        try {
            const res = await apiFetch(`${API_BASE}/voice/messages/${id}`, { method: 'DELETE' });
            if (res.ok) { _messages = _messages.filter(m => m.id !== id); _renderHistory(); }
        } catch (_) {}
    };

    // ── Helpers ───────────────────────────────────────────────────

    function _fmtDur(s) {
        s = Math.round(s || 0);
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
    function _esc(s) {
        return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ── Init ──────────────────────────────────────────────────────

    document.addEventListener('DOMContentLoaded', async () => {
        if (!localStorage.getItem('auth_token')) return;
        await permissionsReady;
        if (typeof hasPermission === 'function' && !hasPermission('voice_ptt')) return;
        _injectCss();
        _injectButton();
        _injectModal();
        _connect();
        _loadMessages();   // populate unread badge on page load
    });
})();
