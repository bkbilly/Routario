'use strict';

const NOTIFICATION_USER_ID = parseInt(localStorage.getItem('user_id') || '1', 10);

let channels = [];
let notificationSort = { col: 'name', dir: 1 };
let notificationsLoaded = false;

let editingChannelIndex = -1;

function notificationEsc(value) {
    return RoutarioUI.escapeHtml(value);
}

function notificationCompareValues(a, b, dir = 1) {
    const av = a === null || a === undefined || a === '' ? null : a;
    const bv = b === null || b === undefined || b === '' ? null : b;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * dir;
}

function sortNotificationChannels(col) {
    notificationSort = RoutarioTables.toggleNumericSort(notificationSort.col, notificationSort.dir, col);
    renderChannels();
}

function generateChannelId() {
    return 'nc_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}

async function initNotificationsSection() {
    if (notificationsLoaded) {
        renderChannels();
        return;
    }

    const body = document.getElementById('channelListBody');
    if (body) body.innerHTML = RoutarioTables.stateRow('Loading notification channels...', 3);

    try {
        const res = await apiFetch(`${API_BASE}/users/${NOTIFICATION_USER_ID}`);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to load notification channels');
        }
        const user = await res.json();
        channels = (user.notification_channels || []).map(ch => ({
            id: ch.id || generateChannelId(),
            name: ch.name || '',
            url: ch.url || ''
        }));
        notificationsLoaded = true;
        renderChannels();
    } catch (error) {
        console.error('Notification channel load error:', error);
        showAlert(error.message, 'error');
        if (body) body.innerHTML = RoutarioTables.stateRow('Failed to load notification channels.', 3);
    }
}

function renderChannels() {
    const body = document.getElementById('channelListBody');
    if (!body) return;

    const q = (document.getElementById('notificationSearch')?.value || '').toLowerCase();
    const rows = channels
        .filter(channel =>
            (channel.name || '').toLowerCase().includes(q) ||
            (channel.url || '').toLowerCase().includes(q)
        )
        .sort((a, b) => notificationCompareValues(a[notificationSort.col], b[notificationSort.col], notificationSort.dir));

    const count = document.getElementById('channelCount');
    if (count) count.textContent = `${rows.length} channel${rows.length !== 1 ? 's' : ''}`;

    RoutarioTables.updateSortHeaders('section-notifications', {
        col: notificationSort.col,
        dir: notificationSort.dir === 1 ? 'asc' : 'desc',
    });

    if (!rows.length) {
        body.innerHTML = RoutarioTables.stateRow('No notification channels found.', 3);
        return;
    }

    body.innerHTML = rows.map(channel => {
        const index = channels.indexOf(channel);
        return `
            <tr class="device-row" ondblclick="openChannelModal(${index})" style="cursor:pointer;" title="Double-click to edit channel">
                <td class="channel-name-cell"><span class="device-row-name">${notificationEsc(channel.name)}</span></td>
                <td class="channel-url-cell">${notificationEsc(channel.url)}</td>
                <td style="text-align:right;">
                    <button type="button" class="btn btn-secondary btn-small" onclick="openChannelModal(${index}); event.stopPropagation();">
                        <i class="mdi mdi-pencil"></i> Edit
                    </button>
                    <button type="button" class="btn btn-secondary btn-small" id="channelTestBtn${index}" onclick="testChannel(${index}); event.stopPropagation();">
                        <i class="mdi mdi-send-check"></i> Test
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

async function saveChannels() {
    try {
        const res = await apiFetch(`${API_BASE}/users/${NOTIFICATION_USER_ID}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notification_channels: channels }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to save channels');
        }
        if (typeof permissionsReady !== 'undefined') {
            permissionsReady.then(u => { if (u) u.notification_channels = channels; }).catch(() => {});
        }
        window.dispatchEvent(new CustomEvent('routario:notification-channels-updated', { detail: channels }));
        showAlert('Channel saved', 'success');
    } catch (error) {
        console.error('Save channels error:', error);
        showAlert(error.message, 'error');
        notificationsLoaded = false;
        await initNotificationsSection();
    }
}

async function saveChannelFromModal() {
    const nameInput = document.getElementById('newChannelName');
    const urlInput = document.getElementById('newChannelUrl');
    const name = nameInput ? nameInput.value.trim() : '';
    const url = urlInput ? urlInput.value.trim() : '';

    if (!name || !url) {
        showAlert('Please provide both name and URL', 'error');
        return;
    }

    if (editingChannelIndex >= 0 && editingChannelIndex < channels.length) {
        const existingId = channels[editingChannelIndex].id || generateChannelId();
        channels[editingChannelIndex] = { id: existingId, name, url };
    } else {
        channels.push({ id: generateChannelId(), name, url });
    }

    if (nameInput) nameInput.value = '';
    if (urlInput) urlInput.value = '';
    renderChannels();
    await saveChannels();
    closeChannelModal();
}

async function addChannel() {
    await saveChannelFromModal();
}

async function deleteChannelFromModal() {
    if (editingChannelIndex < 0 || editingChannelIndex >= channels.length) return;
    if (!confirm('Are you sure you want to remove this notification channel?')) return;

    channels.splice(editingChannelIndex, 1);
    renderChannels();
    await saveChannels();
    closeChannelModal();
}

async function removeChannel(index) {
    if (!confirm('Are you sure you want to remove this notification channel?')) return;
    channels.splice(index, 1);
    renderChannels();
    await saveChannels();
}

async function testChannel(index) {
    const channel = channels[index];
    if (!channel) return;

    const btn = document.getElementById(`channelTestBtn${index}`);
    const original = btn?.innerHTML;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i> Testing';
    }

    try {
        const res = await apiFetch(`${API_BASE}/users/${NOTIFICATION_USER_ID}/notifications/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: channel.name, url: channel.url }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to send test notification');
        }
        showAlert('Test notification sent', 'success');
    } catch (error) {
        console.error('Test notification error:', error);
        showAlert(error.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    }
}

function openChannelModal(index = -1) {
    editingChannelIndex = typeof index === 'number' ? index : -1;
    const modalTitle = document.getElementById('notificationChannelModalTitle');
    const nameInput = document.getElementById('newChannelName');
    const urlInput = document.getElementById('newChannelUrl');
    const deleteBtn = document.getElementById('deleteChannelBtn');
    const saveLabel = document.getElementById('saveChannelLabel');
    const saveIcon = document.getElementById('saveChannelIcon');

    if (editingChannelIndex >= 0 && channels[editingChannelIndex]) {
        const channel = channels[editingChannelIndex];
        if (modalTitle) modalTitle.textContent = 'Edit Notification Channel';
        if (nameInput) nameInput.value = channel.name || '';
        if (urlInput) urlInput.value = channel.url || '';
        if (saveLabel) saveLabel.textContent = 'Save Channel';
        if (saveIcon) saveIcon.className = 'mdi mdi-content-save';
        if (deleteBtn) deleteBtn.style.display = 'inline-flex';
    } else {
        if (modalTitle) modalTitle.textContent = 'Add Notification Channel';
        if (nameInput) nameInput.value = '';
        if (urlInput) urlInput.value = '';
        if (saveLabel) saveLabel.textContent = 'Add Channel';
        if (saveIcon) saveIcon.className = 'mdi mdi-plus';
        if (deleteBtn) deleteBtn.style.display = 'none';
    }

    document.getElementById('notificationChannelModal')?.classList.add('active');
    setTimeout(() => nameInput?.focus(), 50);
}

function closeChannelModal() {
    editingChannelIndex = -1;
    document.getElementById('notificationChannelModal')?.classList.remove('active');
}
