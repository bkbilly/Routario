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
        // Use the currently-selected protocol from the form (may differ from saved device protocol)
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
        
        // Filter out 'custom' since it has its own tab
        availableCommands = availableCommands.filter(cmd => cmd !== 'custom');
        
        // Populate the command select dropdown
        const select = document.getElementById('commandTypeSelect');
        select.innerHTML = '<option value="">-- Select a command --</option>';
        
        availableCommands.forEach(cmd => {
            const option = document.createElement('option');
            option.value = cmd;
            option.textContent = cmd.charAt(0).toUpperCase() + cmd.slice(1).replace('_', ' ');
            select.appendChild(option);
        });
        
        if (availableCommands.length === 0) {
            showAlert('This device protocol does not support commands', 'warning');
        }
    } catch (error) {
        console.error('Error loading available commands:', error);
        showAlert('Failed to load available commands', 'error');
    }
}

// Handle command selection
function onCommandSelect() {
    const select = document.getElementById('commandTypeSelect');
    const commandType = select.value;
    
    if (!commandType) {
        document.getElementById('commandInfoBox').style.display = 'none';
        document.getElementById('commandParamsBox').style.display = 'none';
        document.getElementById('commandPreviewBox').style.display = 'none';
        return;
    }
    
    const info = commandInfo[commandType] || {};
    
    // Show command info
    document.getElementById('commandDescription').textContent = info.description || 'No description available';
    
    // For commands with params, show example with params appended
    let exampleText = info.example || commandType;
    if (info.requires_params && info.example && info.example.includes(' ')) {
        // Example already includes params, show it as is
        exampleText = info.example;
    } else if (info.requires_params) {
        // Add a note about how params will be appended
        exampleText = `${commandType} [your-parameters]`;
    }
    document.getElementById('commandExample').textContent = exampleText;
    document.getElementById('commandInfoBox').style.display = 'block';
    
    // Show parameters box if needed
    const requiresParams = info.requires_params || false;
    const paramsBox = document.getElementById('commandParamsBox');
    paramsBox.style.display = requiresParams ? 'block' : 'none';
    
    if (requiresParams) {
        // Update placeholder based on example
        const paramsInput = document.getElementById('commandParams');
        if (info.example && info.example.includes(' ')) {
            // Extract the params part from the example
            const paramsPart = info.example.split(' ').slice(1).join(' ');
            paramsInput.placeholder = `e.g., ${paramsPart}`;
        } else {
            paramsInput.placeholder = 'Enter parameters here';
        }
    }
    
    // Hide preview
    document.getElementById('commandPreviewBox').style.display = 'none';
}

// Preview Command
async function previewCommand() {
    const commandType = document.getElementById('commandTypeSelect').value;
    if (!commandType) {
        showAlert('Please select a command', 'warning');
        return;
    }
    
    const params = document.getElementById('commandParams').value.trim();
    
    // Build the full command: for commands that require params, append them with a space
    const info = commandInfo[commandType] || {};
    let payload = commandType;
    
    if (info.requires_params && params) {
        payload = `${commandType} ${params}`;
    } else if (!info.requires_params) {
        payload = commandType;
    } else if (info.requires_params && !params) {
        showAlert('This command requires parameters', 'warning');
        return;
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

        // Show preview
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
    const commandType = document.getElementById('commandTypeSelect').value;
    if (!commandType) {
        showAlert('Please select a command', 'warning');
        return;
    }
    
    const params = document.getElementById('commandParams').value.trim();
    
    // Build the full command: for commands that require params, append them with a space
    const info = commandInfo[commandType] || {};
    let payload = commandType;
    
    if (info.requires_params && params) {
        payload = `${commandType} ${params}`;
    } else if (!info.requires_params) {
        payload = commandType;
    } else if (info.requires_params && !params) {
        showAlert('This command requires parameters', 'warning');
        return;
    }
    
    // Confirm before sending
    if (!confirm(`Send "${payload}" command to ${currentCommandDevice.name}?`)) {
        return;
    }
    
    const btn = document.getElementById('sendCommandBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i> Sending...';
    
    try {
        const response = await apiFetch(`${API_BASE}/devices/${currentCommandDeviceId}/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device_id: currentCommandDeviceId,
                command_type: commandType,  // Use actual command type, not 'custom'
                payload: payload,
                max_retries: 3
            })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to send command');
        }
        
        const result = await response.json();
        
        showAlert('Command queued successfully', 'success');
        
        // Reset form
        document.getElementById('commandTypeSelect').value = '';
        document.getElementById('commandParams').value = '';
        document.getElementById('commandInfoBox').style.display = 'none';
        document.getElementById('commandParamsBox').style.display = 'none';
        document.getElementById('commandPreviewBox').style.display = 'none';
        
        // Switch to history tab to show the queued command
        setTimeout(() => {
            switchCommandTab('history');
        }, 500);
        
    } catch (error) {
        console.error('Error sending command:', error);
        showAlert(error.message || 'Failed to send command', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="mdi mdi-antenna"></i> Send Command';
    }
}

// Preview Custom Command
async function previewCustomCommand() {
    const customInput = document.getElementById('customCommandInput').value.trim();
    if (!customInput) {
        showAlert('Please enter a command', 'warning');
        return;
    }
    
    try {
        const selectedProtocol = document.getElementById('deviceProtocol')?.value;
        const previewUrl = selectedProtocol
            ? `${API_BASE}/devices/protocol/${selectedProtocol}/command/preview`
            : `${API_BASE}/devices/${currentCommandDeviceId}/command/preview`;
        const response = await apiFetch(previewUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command_type: 'custom', payload: customInput })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Preview failed');
        }
        
        const data = await response.json();
        
        // Show preview
        document.getElementById('customCommandPreviewHex').textContent = data.hex || 'N/A';
        document.getElementById('customCommandPreviewAscii').textContent = data.ascii || 'Non-ASCII binary data';
        document.getElementById('customCommandPreviewBox').style.display = 'block';
        
    } catch (error) {
        console.error('Error previewing custom command:', error);
        showAlert(error.message || 'Failed to preview command', 'error');
    }
}

// Send Custom Command
async function sendCustomCommand() {
    if (_checkProtocolUnsaved()) return;
    const customInput = document.getElementById('customCommandInput').value.trim();
    if (!customInput) {
        showAlert('Please enter a command', 'warning');
        return;
    }
    
    // Confirm before sending
    if (!confirm(`Send custom command to ${currentCommandDevice.name}?`)) {
        return;
    }
    
    const btn = document.getElementById('sendCustomCommandBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i> Sending...';
    
    try {
        const response = await apiFetch(`${API_BASE}/devices/${currentCommandDeviceId}/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device_id: currentCommandDeviceId,
                command_type: 'custom',
                payload: customInput,
                max_retries: 3
            })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to send command');
        }
        
        const result = await response.json();
        
        showAlert('Custom command queued successfully', 'success');
        
        // Reset form
        document.getElementById('customCommandInput').value = '';
        document.getElementById('customCommandPreviewBox').style.display = 'none';
        
        // Switch to history tab to show the queued command
        setTimeout(() => {
            switchCommandTab('history');
        }, 500);
        
    } catch (error) {
        console.error('Error sending custom command:', error);
        showAlert(error.message || 'Failed to send command', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="mdi mdi-antenna"></i> Send Custom Command';
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

// Render Command History
function renderCommandHistory(commands) {
    const tbody = document.getElementById('commandHistoryBody');
    const emptyDiv = document.getElementById('commandHistoryEmpty');
    
    if (!commands || commands.length === 0) {
        tbody.innerHTML = '';
        emptyDiv.style.display = 'block';
        return;
    }
    
    emptyDiv.style.display = 'none';
    
    tbody.innerHTML = commands.map(cmd => {
        const createdTime = new Date(cmd.created_at).toLocaleString();
        const statusClass = cmd.status.toLowerCase();
        
        // Truncate long payloads
        let displayPayload = cmd.payload || '';
        if (displayPayload.length > 50) {
            displayPayload = displayPayload.substring(0, 50) + '...';
        }
        
        let response = cmd.response || '-';
        if (response.length > 50) {
            response = response.substring(0, 50) + '...';
        }
        
        return `
            <tr>
                <td style="font-family: var(--font-mono); font-size: 0.8125rem;">${createdTime}</td>
                <td style="font-weight: 600;">${cmd.command_type}</td>
                <td class="command-payload" title="${cmd.payload || ''}">${displayPayload}</td>
                <td><span class="command-status ${statusClass}">${cmd.status}</span></td>
                <td style="font-family: var(--font-mono); font-size: 0.8125rem;" title="${cmd.response || ''}">${response}</td>
            </tr>
        `;
    }).join('');
}

