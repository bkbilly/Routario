// Command Modal Functions
let currentCommandDeviceId = null;
let currentCommandDevice = null;
let availableCommands = [];
let commandInfo = {};
let commandHistoryInterval = null;

// Switch between Send and History tabs
function switchCommandTab(tab) {
    // Update tab buttons
    document.querySelectorAll('.command-tab').forEach(btn => {
        btn.classList.remove('active');
    });
    event?.target?.classList?.add('active') || 
        document.querySelector(`.command-tab:nth-child(${tab === 'send' ? 1 : 2})`).classList.add('active');
    
    // Update tab content
    document.getElementById('sendCommandTab').classList.toggle('active', tab === 'send');
    document.getElementById('historyCommandTab').classList.toggle('active', tab === 'history');
    
    // Start/stop auto-refresh when switching tabs
    clearInterval(commandHistoryInterval);
    commandHistoryInterval = null;
    if (tab === 'history') {
        loadCommandHistory();
        commandHistoryInterval = setInterval(loadCommandHistory, 5000);
    }
}

// Switch between Predefined and Custom subtabs
function switchCommandSubtab(subtab) {
    // Update subtab buttons
    document.querySelectorAll('.command-subtab').forEach(btn => {
        btn.classList.remove('active');
    });
    event?.target?.classList?.add('active') ||
        document.querySelector(`.command-subtab:nth-child(${subtab === 'predefined' ? 1 : 2})`).classList.add('active');
    
    // Update subtab content
    document.getElementById('predefinedCommandContent').classList.toggle('active', subtab === 'predefined');
    document.getElementById('customCommandContent').classList.toggle('active', subtab === 'custom');
}

// Returns true and shows an alert if the protocol in the form hasn't been saved yet
function _checkProtocolUnsaved() {
    const selectedProtocol = document.getElementById('deviceProtocol')?.value;
    const device = currentCommandDevice || (editingDeviceId ? devices.find(d => d.id === editingDeviceId) : null);
    if (device?.protocol && selectedProtocol && selectedProtocol !== device.protocol) {
        showAlert('Save the device first before sending commands with the new protocol', 'warning');
        return true;
    }
    return false;
}

// Load available commands for the device
async function loadAvailableCommands() {
    try {
        const selectedProtocol = document.getElementById('deviceProtocol')?.value;
        const url = selectedProtocol
            ? `${API_BASE}/devices/protocol/${selectedProtocol}/command-support`
            : `${API_BASE}/devices/${currentCommandDeviceId}/command-support`;
        const response = await apiFetch(url);
        if (!response.ok) {
            throw new Error('Failed to load command support info');
        }
        
        const data = await response.json();
        availableCommands = data.available_commands || [];
        commandInfo = data.command_info || {};
        
        availableCommands = availableCommands.filter(cmd => cmd !== 'custom');
        
        const select = document.getElementById('commandTypeSelect');
        if (select) {
            select.innerHTML = '<option value="custom" selected>Custom Command</option>';
            availableCommands.forEach(cmd => {
                const option = document.createElement('option');
                option.value = cmd;
                option.textContent = cmd.charAt(0).toUpperCase() + cmd.slice(1).replace(/_/g, ' ');
                select.appendChild(option);
            });
        }
        
        onCommandSelect();
    } catch (error) {
        console.error('Error loading available commands:', error);
        showAlert('Failed to load available commands', 'error');
    }
}

// Handle command selection
function onCommandSelect() {
    const select = document.getElementById('commandTypeSelect');
    const commandType = select ? select.value : 'custom';
    
    const customBox = document.getElementById('customCommandBox');
    const infoBox = document.getElementById('commandInfoBox');
    const paramsBox = document.getElementById('commandParamsBox');
    const previewBox = document.getElementById('commandPreviewBox');

    if (previewBox) previewBox.style.display = 'none';

    if (commandType === 'custom' || !commandType) {
        if (customBox) customBox.style.display = 'block';
        if (infoBox) infoBox.style.display = 'none';
        if (paramsBox) paramsBox.style.display = 'none';
        return;
    }

    if (customBox) customBox.style.display = 'none';
    
    const info = commandInfo[commandType] || {};
    
    if (infoBox) {
        document.getElementById('commandDescription').textContent = info.description || 'No description available';
        
        let exampleText = info.example || commandType;
        if (info.requires_params && info.example && info.example.includes(' ')) {
            exampleText = info.example;
        } else if (info.requires_params) {
            exampleText = `${commandType} [your-parameters]`;
        }
        document.getElementById('commandExample').textContent = exampleText;
        infoBox.style.display = 'block';
    }
    
    const requiresParams = info.requires_params || false;
    if (paramsBox) {
        paramsBox.style.display = requiresParams ? 'block' : 'none';
        if (requiresParams) {
            const paramsInput = document.getElementById('commandParams');
            if (info.example && info.example.includes(' ')) {
                const paramsPart = info.example.split(' ').slice(1).join(' ');
                paramsInput.placeholder = `e.g., ${paramsPart}`;
            } else {
                paramsInput.placeholder = 'Enter parameters here';
            }
        }
    }
}

// Preview Command
async function previewCommand() {
    const commandType = document.getElementById('commandTypeSelect')?.value || 'custom';
    let payload = '';

    if (commandType === 'custom') {
        payload = document.getElementById('customCommandInput')?.value.trim() || '';
        if (!payload) {
            showAlert('Please enter a custom command payload', 'warning');
            return;
        }
    } else {
        const params = document.getElementById('commandParams')?.value.trim() || '';
        const info = commandInfo[commandType] || {};
        if (info.requires_params && !params) {
            showAlert('This command requires parameters', 'warning');
            return;
        }
        payload = info.requires_params && params ? `${commandType} ${params}` : commandType;
    }

    try {
        const selectedProtocol = document.getElementById('deviceProtocol')?.value;
        const previewUrl = selectedProtocol
            ? `${API_BASE}/devices/protocol/${selectedProtocol}/command/preview`
            : `${API_BASE}/devices/${currentCommandDeviceId}/command/preview`;
        const response = await apiFetch(previewUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command_type: commandType, payload: payload })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Preview failed');
        }

        const data = await response.json();

        document.getElementById('commandPreviewHex').textContent = data.hex || 'N/A';
        document.getElementById('commandPreviewAscii').textContent = data.ascii || 'Non-ASCII binary data';
        document.getElementById('commandPreviewBox').style.display = 'block';
        
    } catch (error) {
        console.error('Error previewing command:', error);
        showAlert(error.message || 'Failed to preview command', 'error');
    }
}

// Send Command
async function sendCommand() {
    if (_checkProtocolUnsaved()) return;
    const commandType = document.getElementById('commandTypeSelect')?.value || 'custom';
    let payload = '';

    if (commandType === 'custom') {
        payload = document.getElementById('customCommandInput')?.value.trim() || '';
        if (!payload) {
            showAlert('Please enter a custom command payload', 'warning');
            return;
        }
    } else {
        const params = document.getElementById('commandParams')?.value.trim() || '';
        const info = commandInfo[commandType] || {};
        if (info.requires_params && !params) {
            showAlert('This command requires parameters', 'warning');
            return;
        }
        payload = info.requires_params && params ? `${commandType} ${params}` : commandType;
    }

    const deviceName = currentCommandDevice?.name || 'device';
    if (!confirm(`Send "${payload}" command to ${deviceName}?`)) {
        return;
    }

    const btn = document.getElementById('sendCommandBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i> Sending...';
    }

    try {
        const response = await apiFetch(`${API_BASE}/devices/${currentCommandDeviceId}/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device_id: currentCommandDeviceId,
                command_type: commandType,
                payload: payload,
                max_retries: 3
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to send command');
        }

        showAlert('Command queued successfully', 'success');

        if (document.getElementById('commandTypeSelect')) document.getElementById('commandTypeSelect').value = 'custom';
        if (document.getElementById('customCommandInput')) document.getElementById('customCommandInput').value = '';
        if (document.getElementById('commandParams')) document.getElementById('commandParams').value = '';
        onCommandSelect();

        setTimeout(() => {
            switchCommandTab('history');
        }, 500);

    } catch (error) {
        console.error('Error sending command:', error);
        showAlert(error.message || 'Failed to send command', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="mdi mdi-antenna"></i> Send Command';
        }
    }
}

// Load Command History
async function loadCommandHistory() {
    try {
        const response = await apiFetch(`${API_BASE}/devices/${currentCommandDeviceId}/commands`);
        if (!response.ok) {
            throw new Error('Failed to load command history');
        }
        
        const commands = await response.json();
        renderCommandHistory(commands);
        
    } catch (error) {
        console.error('Error loading command history:', error);
        document.getElementById('commandHistoryBody').innerHTML = `
            <tr><td colspan="5" style="text-align: center; color: var(--accent-danger);">
                Failed to load command history
            </td></tr>
        `;
    }
}

function renderCommandHistory(commands) {
    const tbody = document.getElementById('commandHistoryBody');
    const emptyDiv = document.getElementById('commandHistoryEmpty');
    
    if (!commands || commands.length === 0) {
        tbody.innerHTML = '';
        emptyDiv.style.display = 'block';
        return;
    }
    
    emptyDiv.style.display = 'none';
    
    const escape = str => {
        if (!str) return '';
        if (typeof RoutarioUI !== 'undefined' && RoutarioUI.escapeHtml) {
            return RoutarioUI.escapeHtml(str);
        }
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    };

    tbody.innerHTML = commands.map(cmd => {
        const dtObj = new Date(cmd.created_at);
        const datePart = dtObj.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        const timePart = dtObj.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        
        const isReceived = (cmd.direction === 'received' || cmd.status === 'received');
        const statusStr = (cmd.status || (isReceived ? 'received' : 'pending')).toLowerCase();

        let statusBadge = '';
        if (isReceived || statusStr === 'received') {
            statusBadge = `<span class="command-status received" title="Message received from device"><i class="mdi mdi-arrow-down-bold"></i> Received</span>`;
        } else if (statusStr === 'sent') {
            statusBadge = `<span class="command-status sent" title="Transmitted to device"><i class="mdi mdi-arrow-up-bold"></i> Sent</span>`;
        } else if (statusStr === 'acked') {
            statusBadge = `<span class="command-status acked" title="Acknowledged by device"><i class="mdi mdi-arrow-up-bold"></i> Acked</span>`;
        } else if (statusStr === 'canceled' || statusStr === 'cancelled') {
            statusBadge = `<span class="command-status canceled" title="Cancelled by user"><i class="mdi mdi-arrow-up-bold"></i> Canceled</span>`;
        } else if (statusStr === 'failed' || statusStr === 'timeout') {
            statusBadge = `<span class="command-status failed" title="Execution failed"><i class="mdi mdi-arrow-up-bold"></i> Failed</span>`;
        } else {
            statusBadge = `<span class="command-status pending" title="Queued in database"><i class="mdi mdi-arrow-up-bold"></i> Pending</span>`;
        }

        const cmdType = cmd.command_type || (isReceived ? 'response' : '');
        const displayData = escape(cmd.payload || cmd.response || '-');
        
        const showCancel = (!isReceived && (statusStr === 'pending' || statusStr === 'sent'));
        const isSuperAdmin = localStorage.getItem('is_admin') === 'true';

        let actionBtn = '';
        if (showCancel) {
            actionBtn = `<button type="button" class="btn-cancel-command" onclick="cancelCommand(${cmd.id})" title="Cancel command"><i class="mdi mdi-close"></i></button>`;
        } else if (isSuperAdmin) {
            actionBtn = `<button type="button" class="btn-delete-command" onclick="deleteCommandHistory(${cmd.id})" title="Delete entry"><i class="mdi mdi-trash-can-outline"></i></button>`;
        }

        return `
            <tr>
                <td style="white-space: nowrap;">${datePart}<br><span style="color: var(--text-muted); font-size: 0.8rem; font-family: var(--font-mono);">${timePart}</span></td>
                <td>${statusBadge}</td>
                <td style="font-weight: 600;">${escape(cmdType)}</td>
                <td class="command-payload" title="${displayData}">${displayData}</td>
                <td>${actionBtn}</td>
            </tr>
        `;
    }).join('');
}

async function cancelCommand(commandId) {
    try {
        const res = await apiFetch(`${API_BASE}/devices/${currentCommandDeviceId}/commands/${commandId}`, { method: 'DELETE' });
        if (res.ok) {
            loadCommandHistory();
        } else {
            const err = await res.json().catch(() => ({}));
            showAlert(err.detail || 'Failed to cancel command.', 'error');
        }
    } catch {
        showAlert('Failed to cancel command.', 'error');
    }
}

async function deleteCommandHistory(commandId) {
    if (!confirm('Are you sure you want to delete this command history entry?')) {
        return;
    }
    try {
        const res = await apiFetch(`${API_BASE}/devices/${currentCommandDeviceId}/commands/${commandId}/history`, { method: 'DELETE' });
        if (res.ok) {
            showAlert('Command history entry deleted', 'success');
            loadCommandHistory();
        } else {
            const err = await res.json().catch(() => ({}));
            showAlert(err.detail || 'Failed to delete command history entry.', 'error');
        }
    } catch {
        showAlert('Failed to delete command history entry.', 'error');
    }
}

