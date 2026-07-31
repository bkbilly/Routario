// Command Modal Functions
let currentCommandDeviceId = null;
let currentCommandDevice = null;
let availableCommands = [];
let userCommands = [];
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
    const select = document.getElementById('commandTypeSelect');
    if (select) {
        select.innerHTML = '<option value="" disabled selected>Loading available commands...</option>';
    }

    try {
        const selectedProtocol = document.getElementById('deviceProtocol')?.value;
        const device = currentCommandDevice || (editingDeviceId ? devices.find(d => d.id === editingDeviceId) : null);

        // Use protocol endpoint if unsaved protocol selection in form, otherwise use device ID endpoint
        const url = (selectedProtocol && device?.protocol && selectedProtocol !== device.protocol)
            ? `${API_BASE}/devices/protocol/${selectedProtocol}/command-support`
            : (currentCommandDeviceId
                ? `${API_BASE}/devices/${currentCommandDeviceId}/command-support`
                : `${API_BASE}/devices/protocol/${selectedProtocol || 'custom'}/command-support`);

        const response = await apiFetch(url);
        if (!response.ok) {
            throw new Error('Failed to load command support info');
        }
        
        const data = await response.json();
        availableCommands = data.available_commands || [];
        userCommands = data.user_commands || [];
        commandInfo = data.command_info || {};
        
        const select = document.getElementById('commandTypeSelect');
        if (select) {
            select.innerHTML = '';

            // 1. User Defined Commands
            if (userCommands.length > 0) {
                const userGroup = document.createElement('optgroup');
                userGroup.label = 'User Defined Commands';
                userCommands.forEach(uc => {
                    const opt = document.createElement('option');
                    opt.value = `user_cmd:${uc.id}`;
                    opt.textContent = uc.name;
                    userGroup.appendChild(opt);
                });
                select.appendChild(userGroup);
            }

            // 2. Integration Saved Commands
            const savedCmds = data.saved_commands || [];
            if (savedCmds.length > 0) {
                const savedGroup = document.createElement('optgroup');
                savedGroup.label = 'Saved Commands';
                savedCmds.forEach(sc => {
                    const opt = document.createElement('option');
                    opt.value = `saved:${sc.id}`;
                    opt.textContent = sc.name;
                    savedGroup.appendChild(opt);
                });
                select.appendChild(savedGroup);
            }

            // 3. Flespi Settings & Commands
            const standardCmds = availableCommands.filter(cmd => cmd !== 'custom' && !cmd.startsWith('saved:'));
            if (standardCmds.length > 0) {
                const stdGroup = document.createElement('optgroup');
                stdGroup.label = 'Flespi Device Settings & Commands';
                standardCmds.forEach(cmd => {
                    const opt = document.createElement('option');
                    opt.value = cmd;
                    if (cmd.startsWith('setting:')) {
                        const rawName = cmd.replace('setting:', '');
                        const labelText = rawName.charAt(0).toUpperCase() + rawName.slice(1).replace(/_/g, ' ');
                        opt.textContent = `${labelText}`;
                    } else {
                        opt.textContent = `${cmd.charAt(0).toUpperCase() + cmd.slice(1).replace(/_/g, ' ')}`;
                    }
                    stdGroup.appendChild(opt);
                });
                select.appendChild(stdGroup);
            }

            // 4. Custom Command Option
            const customOpt = document.createElement('option');
            customOpt.value = 'custom';
            customOpt.textContent = 'Custom Command';
            if (userCommands.length === 0 && savedCmds.length === 0 && standardCmds.length === 0) {
                customOpt.selected = true;
            }
            select.appendChild(customOpt);
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
    const customInput = document.getElementById('customCommandInput');
    const saveBtn = document.getElementById('saveUserCmdBtn');
    const deleteBtn = document.getElementById('deleteUserCmdBtn');
    const helpText = document.getElementById('customCommandHelpText');
    const infoBox = document.getElementById('commandInfoBox');
    const paramsBox = document.getElementById('commandParamsBox');
    const previewBox = document.getElementById('commandPreviewBox');
    const dynamicContainer = document.getElementById('dynamicCommandFields');
    const paramsInput = document.getElementById('commandParams');
    const paramsLabel = document.getElementById('commandParamsLabel');
    const paramsHelp = document.getElementById('commandParamsHelp');

    if (previewBox) previewBox.style.display = 'none';

    if (commandType.startsWith('user_cmd:')) {
        const cmdId = commandType.split(':', 1)[1] || commandType.replace('user_cmd:', '');
        const matched = userCommands.find(c => String(c.id) === String(cmdId));
        if (customBox) customBox.style.display = 'block';
        if (customInput) {
            customInput.value = matched ? (matched.payload || '') : '';
            customInput.readOnly = true;
        }
        if (saveBtn) saveBtn.style.display = 'none';
        if (deleteBtn) deleteBtn.style.display = 'inline-block';
        if (helpText) helpText.textContent = 'Saved User Defined Command payload (Read-Only).';
        if (infoBox) infoBox.style.display = 'none';
        if (paramsBox) paramsBox.style.display = 'none';
        return;
    }

    if (customInput) customInput.readOnly = false;
    if (saveBtn) saveBtn.style.display = 'inline-block';
    if (deleteBtn) deleteBtn.style.display = 'none';
    if (helpText) helpText.textContent = 'Enter plain text or hex string (converted to bytes). Click Save to store for this device.';

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
    
    const hasFields = info.fields && Array.isArray(info.fields) && info.fields.length > 0;
    const requiresParams = info.requires_params || false;

    if (paramsBox) {
        paramsBox.style.display = (requiresParams || hasFields) ? 'block' : 'none';
        if (hasFields) {
            if (paramsInput) paramsInput.style.display = 'none';
            if (paramsLabel) paramsLabel.textContent = 'Command Configuration Fields';
            if (paramsHelp) paramsHelp.textContent = 'Configure the parameters for this command/alarm below:';
            if (dynamicContainer) {
                dynamicContainer.innerHTML = '';
                dynamicContainer.style.display = 'flex';
                info.fields.forEach(field => {
                    const fieldGroup = document.createElement('div');
                    fieldGroup.style.display = 'flex';
                    fieldGroup.style.flexDirection = 'column';
                    fieldGroup.style.gap = '0.25rem';

                    const label = document.createElement('label');
                    label.className = 'form-label';
                    label.style.fontSize = '0.85rem';
                    label.style.fontWeight = '600';
                    label.textContent = field.label + (field.required ? ' *' : '');

                    let input;
                    if (field.type === 'select') {
                        input = document.createElement('select');
                        input.className = 'form-select dynamic-cmd-field';
                        (field.options || []).forEach(opt => {
                            const option = document.createElement('option');
                            const valStr = (typeof opt.value === 'object' && opt.value !== null) ? JSON.stringify(opt.value) : String(opt.value ?? '');
                            const lblStr = (typeof opt.label === 'object' && opt.label !== null) ? JSON.stringify(opt.label) : String(opt.label || valStr);
                            option.value = valStr;
                            option.textContent = lblStr;
                            if (String(valStr) === String(field.default)) option.selected = true;
                            input.appendChild(option);
                        });
                    } else {
                        input = document.createElement('input');
                        input.className = 'form-input dynamic-cmd-field';
                        input.type = field.type === 'number' ? 'number' : 'text';
                        if (field.placeholder) input.placeholder = field.placeholder;
                        if (field.default !== undefined && field.default !== null) {
                            input.value = (typeof field.default === 'object') ? JSON.stringify(field.default) : field.default;
                        }
                    }
                    input.dataset.key = field.key;
                    input.dataset.required = field.required ? 'true' : 'false';

                    fieldGroup.appendChild(label);
                    fieldGroup.appendChild(input);

                    if (field.help_text) {
                        const help = document.createElement('div');
                        help.style.fontSize = '0.78rem';
                        help.style.color = 'var(--text-muted)';
                        help.textContent = field.help_text;
                        fieldGroup.appendChild(help);
                    }

                    dynamicContainer.appendChild(fieldGroup);
                });
            }
        } else {
            if (paramsInput) paramsInput.style.display = 'block';
            if (paramsLabel) paramsLabel.textContent = 'Parameters';
            if (paramsHelp) paramsHelp.textContent = 'Parameters will be appended after the command with a space';
            if (dynamicContainer) {
                dynamicContainer.innerHTML = '';
                dynamicContainer.style.display = 'none';
            }
            if (requiresParams && paramsInput) {
                if (info.example && info.example.includes(' ')) {
                    const paramsPart = info.example.split(' ').slice(1).join(' ');
                    paramsInput.placeholder = `e.g., ${paramsPart}`;
                } else {
                    paramsInput.placeholder = 'Enter parameters here';
                }
            }
        }
    }
}

// Extract command payload based on command type and dynamic fields
function _buildPayloadForSelectedCommand(commandType) {
    const info = commandInfo[commandType] || {};

    if (info.fields && Array.isArray(info.fields) && info.fields.length > 0) {
        const payloadObj = {};
        const inputs = document.querySelectorAll('.dynamic-cmd-field');
        let missingRequired = false;
        inputs.forEach(input => {
            const key = input.dataset.key;
            let val = input.value;
            if (input.dataset.required === 'true' && (val === undefined || val === null || String(val).trim() === '')) {
                missingRequired = true;
            }
            if (input.type === 'number') {
                val = val !== '' ? Number(val) : null;
            }
            if (val !== null && val !== undefined) payloadObj[key] = val;
        });
        if (missingRequired) {
            showAlert('Please fill in all required command fields', 'warning');
            return null;
        }
        return JSON.stringify(payloadObj);
    }

    const params = document.getElementById('commandParams')?.value.trim() || '';
    if (info.requires_params && !params) {
        showAlert('This command requires parameters', 'warning');
        return null;
    }
    return info.requires_params && params ? `${commandType} ${params}` : commandType;
}

// Preview Command
async function previewCommand() {
    const select = document.getElementById('commandTypeSelect');
    const commandType = select?.value || 'custom';
    let payload = '';

    if (commandType === 'custom') {
        payload = document.getElementById('customCommandInput')?.value.trim() || '';
        if (!payload) {
            showAlert('Please enter a custom command payload', 'warning');
            return;
        }
    } else if (commandType.startsWith('user_cmd:')) {
        const cmdId = commandType.split(':', 1)[1] || commandType.replace('user_cmd:', '');
        const matched = userCommands.find(c => String(c.id) === String(cmdId));
        payload = matched ? matched.payload : (document.getElementById('customCommandInput')?.value.trim() || '');
    } else if (commandType.startsWith('saved:')) {
        payload = select?.options[select.selectedIndex]?.textContent || commandType;
    } else {
        const calculated = _buildPayloadForSelectedCommand(commandType);
        if (calculated === null) return;
        payload = calculated;
    }

    try {
        const selectedProtocol = document.getElementById('deviceProtocol')?.value;
        const previewUrl = currentCommandDeviceId
            ? `${API_BASE}/devices/${currentCommandDeviceId}/command/preview`
            : `${API_BASE}/devices/protocol/${selectedProtocol}/command/preview`;
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

        const hexEl = document.getElementById('commandPreviewHex');
        const asciiEl = document.getElementById('commandPreviewAscii');

        if (hexEl) {
            if (data.hex) {
                hexEl.textContent = data.hex;
                hexEl.style.display = 'block';
            } else {
                hexEl.style.display = 'none';
            }
        }

        if (asciiEl) {
            asciiEl.textContent = data.ascii || 'No payload data';
            asciiEl.style.display = 'block';
            if (!data.hex) {
                asciiEl.classList.add('no-prefix');
            } else {
                asciiEl.classList.remove('no-prefix');
            }
        }

        document.getElementById('commandPreviewBox').style.display = 'block';
        
    } catch (error) {
        console.error('Error previewing command:', error);
        showAlert(error.message || 'Failed to preview command', 'error');
    }
}

// Send Command
async function sendCommand() {
    if (_checkProtocolUnsaved()) return;
    const select = document.getElementById('commandTypeSelect');
    const commandType = select?.value || 'custom';
    let commandLabel = '';
    let payload = '';

    if (commandType === 'custom') {
        payload = document.getElementById('customCommandInput')?.value.trim() || '';
        if (!payload) {
            showAlert('Please enter a custom command payload', 'warning');
            return;
        }
        commandLabel = payload;
    } else if (commandType.startsWith('user_cmd:')) {
        const cmdId = commandType.split(':', 1)[1] || commandType.replace('user_cmd:', '');
        const matched = userCommands.find(c => String(c.id) === String(cmdId));
        commandLabel = matched ? matched.name : (select?.options[select.selectedIndex]?.textContent || 'User Command');
        payload = matched ? matched.payload : (document.getElementById('customCommandInput')?.value.trim() || '');
    } else if (commandType.startsWith('saved:')) {
        commandLabel = select?.options[select.selectedIndex]?.textContent || commandType;
        payload = commandLabel;
    } else {
        const calculated = _buildPayloadForSelectedCommand(commandType);
        if (calculated === null) return;
        payload = calculated;
        commandLabel = select?.options[select.selectedIndex]?.textContent || commandType;
    }

    const deviceName = currentCommandDevice?.name || 'device';
    if (!confirm(`Send "${commandLabel}" command to ${deviceName}?`)) {
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

        let cmdType = cmd.command_type || (isReceived ? 'response' : '');
        if (cmdType.startsWith('user_cmd:')) {
            const cmdId = cmdType.split(':', 1)[1] || cmdType.replace('user_cmd:', '');
            const matched = userCommands.find(c => String(c.id) === String(cmdId));
            cmdType = matched ? matched.name : 'User Command';
        }
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

// Save custom command as a User Defined Command for the current device
async function saveCustomCommand() {
    if (!currentCommandDeviceId) {
        showAlert('Please select a saved device first', 'warning');
        return;
    }
    const payloadInput = document.getElementById('customCommandInput');
    const payload = payloadInput?.value.trim() || '';
    if (!payload) {
        showAlert('Please enter a custom command payload first', 'warning');
        return;
    }
    const name = prompt('Enter a name/description for this user defined command:', payload);
    if (name === null) return; // User cancelled

    const cmdName = name.trim() || payload;
    try {
        const response = await apiFetch(`${API_BASE}/devices/${currentCommandDeviceId}/user-commands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: cmdName, payload: payload })
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to save user-defined command');
        }
        const resData = await response.json();
        showAlert('User-defined command saved successfully!', 'success');
        await loadAvailableCommands();
        if (resData.added?.id) {
            const select = document.getElementById('commandTypeSelect');
            if (select) select.value = `user_cmd:${resData.added.id}`;
            onCommandSelect();
        }
    } catch (err) {
        console.error('Error saving user command:', err);
        showAlert(err.message || 'Failed to save user command', 'error');
    }
}

// Delete selected User Defined Command from the current device
async function deleteSelectedUserCommand() {
    if (!currentCommandDeviceId) return;
    const select = document.getElementById('commandTypeSelect');
    const commandType = select?.value || '';
    if (!commandType.startsWith('user_cmd:')) return;

    const cmdId = commandType.split(':', 1)[1] || commandType.replace('user_cmd:', '');
    if (!confirm('Are you sure you want to delete this user-defined command?')) return;

    try {
        const response = await apiFetch(`${API_BASE}/devices/${currentCommandDeviceId}/user-commands/${cmdId}`, {
            method: 'DELETE'
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to delete user-defined command');
        }
        showAlert('User-defined command deleted!', 'success');
        await loadAvailableCommands();
        if (select) select.value = 'custom';
        onCommandSelect();
    } catch (err) {
        console.error('Error deleting user command:', err);
        showAlert(err.message || 'Failed to delete user command', 'error');
    }
}

