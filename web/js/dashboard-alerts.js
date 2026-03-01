/**
 * dashboard-alerts.js
 * Alert loading, dismissal, toast notifications.
 */

async function loadAlerts() {
    try {
        const userId = localStorage.getItem('user_id');
        const response = await apiFetch(`${API_BASE}/alerts?unread_only=true`);
        loadedAlerts = await response.json();

        const countEl = document.getElementById('alertCount');
        if (loadedAlerts.length > 0) {
            countEl.textContent = loadedAlerts.length;
            countEl.style.display = 'inline';
        } else {
            countEl.textContent = '0';
            countEl.style.display = 'inline'; // Always show 0 if loaded
        }

        const list = document.getElementById('alertsList');
        list.innerHTML = '';

        if (loadedAlerts.length === 0) {
            list.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-muted);">No alerts</div>';
            return;
        }

        loadedAlerts.forEach(alert => {
            const item = document.createElement('div');
            item.className = `alert-item ${alert.severity}`;
            const icon = { 'speeding': '⚡', 'geofence_enter': '📍', 'geofence_exit': '🚪', 'offline': '📡', 'towing': '🚨' }[alert.alert_type] || '🔔';

            let title, messageText;
            if (alert.alert_type === 'custom' && alert.alert_metadata?.rule_name) {
                title       = alert.alert_metadata.rule_name;
                messageText = alert.alert_metadata.rule_condition || alert.message;
            } else {
                title       = alert.alert_type.replace(/_/g, ' ').toUpperCase();
                messageText = alert.message;
            }

            const device = devices.find(d => d.id === alert.device_id);
            const vehicleTag = device
                ? `<span style="
                    display:inline-flex; align-items:center; gap:0.3rem;
                    background:rgba(59,130,246,0.12); border:1px solid rgba(59,130,246,0.25);
                    border-radius:5px; padding:0.15rem 0.5rem;
                    font-size:0.7rem; font-weight:600; color:var(--accent-primary);
                    margin-bottom:0.3rem;"
                  >${(VEHICLE_ICONS[device.vehicle_type] || VEHICLE_ICONS['other']).emoji} ${device.name}</span>`
                : '';

            item.innerHTML = `
                <div class="alert-icon">${icon}</div>
                <div class="alert-content">
                    ${vehicleTag}
                    <div class="alert-title">${title}</div>
                    <div class="alert-message">${messageText}</div>
                    <div class="alert-time">${formatDateToLocal(alert.created_at)}</div>
                </div>
                <button class="alert-dismiss" onclick="dismissAlert(${alert.id})">✕</button>
            `;

            list.appendChild(item);
        });
        applyDeviceAlertHighlights();
    } catch (error) {
        console.error('Error loading alerts:', error);
    }
}

function applyDeviceAlertHighlights() {
    // Collect device IDs that have unread alerts
    const alertDeviceIds = new Set(
        loadedAlerts
            .filter(a => a.device_id != null)
            .map(a => a.device_id)
    );

    // Apply or remove .has-alert on every device card
    document.querySelectorAll('.device-card').forEach(card => {
        const deviceId = parseInt(card.id.replace('device-card-', ''));
        const hasAlert = alertDeviceIds.has(deviceId);
        card.classList.toggle('has-alert', hasAlert);

        // Add/remove the pulsing dot next to the device name
        const nameEl = card.querySelector('.device-name');
        if (nameEl) {
            const existing = nameEl.querySelector('.alert-pulse');
            if (hasAlert && !existing) {
                const dot = document.createElement('span');
                dot.className = 'alert-pulse';
                dot.title = 'Unread alert';
                nameEl.appendChild(dot);
            } else if (!hasAlert && existing) {
                existing.remove();
            }
        }
    });
}

function openAlertsModal() {
    loadAlerts();
    document.getElementById('alertsModal').classList.add('active');
}

function closeAlertsModal() {
    document.getElementById('alertsModal').classList.remove('active');
}

async function dismissAlert(alertId) {
    try {
        const res = await apiFetch(`${API_BASE}/alerts/${alertId}/read`, { method: 'POST' });
        if (res.ok) loadAlerts();
    } catch (e) {}
}

async function clearAllAlerts() {
    if (loadedAlerts.length === 0) return;
    if (!confirm('Mark all alerts as read?')) return;

    for (const alert of loadedAlerts) {
        try {
            await apiFetch(`${API_BASE}/alerts/${alert.id}/read`, { method: 'POST' });
        } catch (e) {
            console.error('Failed to clear alert', alert.id, e);
        }
    }

    loadAlerts();
    showAlert({ title: 'Success', message: 'All alerts cleared', type: 'success' });
}

// Generic Alert/Toast Function
function showAlert(data) {
    const message = typeof data === 'string' ? data : data.message;
    const title = data.title || 'Notification';
    const type = data.type || 'info';

    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast`;

    // Icons
    const icons = {
        'success': '✓',
        'error': '✕',
        'warning': '⚠',
        'info': 'ℹ'
    };

    toast.innerHTML = `
        <div class="toast-icon">${icons[type] || 'ℹ'}</div>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            <div class="toast-message">${message}</div>
        </div>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideInRight 0.3s reverse forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}