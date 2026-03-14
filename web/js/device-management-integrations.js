// ================================================================
//  device-management-integrations.js
//  Integration provider UI: dynamic credential form, account
//  management, browse remote devices, test connection.
//
//  Depends on: device-management.js (loaded before this file)
//  Shared state used: integrationProviders, integrationAccounts,
//                     _esc(), apiFetch(), API_BASE, showAlert()
// ================================================================

// ── Protocol change handler ───────────────────────────────────────

function onProtocolChange(existingIntg = null) {
    const sel      = document.getElementById('deviceProtocol');
    const selected = sel.value;
    const isIntg   = integrationProviders.some(p => p.provider_id === selected);

    // Show/hide IMEI field
    const imeiGroup = document.getElementById('deviceImei')?.closest('.form-group');
    if (imeiGroup) {
        imeiGroup.style.display = isIntg ? 'none' : '';
        const imeiInput = document.getElementById('deviceImei');
        if (imeiInput) imeiInput.required = !isIntg;
    }

    const panel = document.getElementById('integrationFieldsPanel');
    if (!panel) return;

    if (!isIntg) {
        panel.style.display = 'none';
        panel.innerHTML     = '';
        return;
    }

    const provider = integrationProviders.find(p => p.provider_id === selected);
    if (!provider) return;

    panel.style.display = 'block';
    panel.innerHTML     = _renderIntegrationFields(provider, existingIntg);
}

// ── Returns true if the selected protocol is an integration ───────

function _isIntegrationSelected() {
    const val = document.getElementById('deviceProtocol')?.value;
    return integrationProviders.some(p => p.provider_id === val);
}

// ── Render credential form for a provider ────────────────────────

function _renderIntegrationFields(provider, existingIntg = null) {
    const existing = integrationAccounts.filter(a => a.provider_id === provider.provider_id);

    const existingOptions = existing.map(a =>
        `<option value="${a.id}" data-label="${_esc(a.account_label)}"
             ${existingIntg?.account_label === a.account_label ? 'selected' : ''}>
             ${_esc(a.account_label)}
         </option>`
    ).join('');

    return `
        <div style="background:var(--bg-tertiary); border:1px solid var(--accent-primary);
                    border-radius:10px; padding:1.25rem; margin-top:0.5rem;">

            <div style="font-size:0.75rem; text-transform:uppercase; letter-spacing:0.06em;
                        color:var(--accent-primary); margin-bottom:1rem; font-weight:600;">
                🔌 ${_esc(provider.display_name)} Connection
            </div>

            ${existing.length ? `
            <div class="form-group" style="margin-bottom:0.75rem;">
                <label class="form-label">Use existing account</label>
                <select class="form-input" id="intgAccountSelect" onchange="onIntgAccountSelect()">
                    <option value="">— Enter new credentials —</option>
                    ${existingOptions}
                </select>
            </div>` : ''}

            <div id="intgCredentialFields"
                 style="${existingIntg && existing.some(a => a.account_label === existingIntg.account_label)
                         ? 'opacity:0.4;pointer-events:none;' : ''}">

                <div class="form-group" style="margin-bottom:0.75rem;">
                    <label class="form-label">Account Label *</label>
                    <input type="text" class="form-input" id="intgAccountLabel"
                           placeholder="e.g. Main Fleet, Branch Office…"
                           value="${_esc(existingIntg?.account_label || '')}">
                    <div class="form-help">Devices sharing the same label reuse one login.</div>
                </div>

                ${provider.fields.map(f => `
                <div class="form-group" style="margin-bottom:0.75rem;">
                    <label class="form-label">${_esc(f.label)}${f.required ? ' *' : ''}</label>
                    <input type="${f.field_type === 'password' ? 'password'
                                 : f.field_type === 'number'   ? 'number' : 'text'}"
                           class="form-input"
                           id="intgField_${f.key}"
                           placeholder="${_esc(f.placeholder || '')}"
                           value="${_esc(existingIntg?.credentials?.[f.key] ?? f.default ?? '')}"
                           ${f.required ? 'required' : ''}>
                    ${f.help_text ? `<div class="form-help">${_esc(f.help_text)}</div>` : ''}
                </div>`).join('')}
            </div>

            <div class="form-group" style="margin-bottom:0.75rem;">
                <label class="form-label">Remote Device ID *</label>
                <div style="display:flex; gap:0.5rem;">
                    <input type="text" class="form-input" id="intgRemoteId"
                           placeholder="ID on ${_esc(provider.display_name)}"
                           value="${_esc(existingIntg?.remote_id || '')}"
                           style="flex:1;">
                    <button type="button" class="btn btn-secondary"
                            style="white-space:nowrap;" onclick="browseRemoteDevices()">
                        📋 Browse
                    </button>
                </div>
                <div class="form-help">The identifier used by ${_esc(provider.display_name)} for this vehicle.</div>
            </div>

            <button type="button" class="btn btn-secondary" style="width:100%;"
                    onclick="testIntegrationConnection()">
                🔌 Test Connection
            </button>
            <div id="intgTestResult" style="font-size:0.8rem; margin-top:0.5rem; min-height:1.2em;"></div>
        </div>
    `;
}

// ── Restore integration fields when editing an existing device ────

function restoreIntegrationFields(device) {
    const intg = device.config?.integration;
    if (!intg?.provider) return;

    const provider = integrationProviders.find(p => p.provider_id === intg.provider);
    if (!provider) return;

    // Re-render the panel with existingIntg so the matching account <option>
    // is stamped `selected` in the HTML from the start — fixes the bug where
    // onProtocolChange() rendered the panel without existingIntg first, then
    // restoreIntegrationFields() tried to set .value on a select whose options
    // were already rendered without a selection.
    onProtocolChange(intg);

    // Dim the credential fields now that an existing account is selected.
    onIntgAccountSelect();
}

// ── Existing account selected — dim/restore credential fields ─────

function onIntgAccountSelect() {
    const sel       = document.getElementById('intgAccountSelect');
    const fields    = document.getElementById('intgCredentialFields');
    const accountId = sel?.value;
    if (!fields) return;
 
    const usingExisting = !!accountId;
 
    // Dim/restore visual state
    fields.style.opacity       = usingExisting ? '0.4' : '';
    fields.style.pointerEvents = usingExisting ? 'none' : '';
 
    // Remove/restore `required` so the browser won't block form submission
    // when the credential fields are hidden behind an existing account selection.
    const labelInput = document.getElementById('intgAccountLabel');
    if (labelInput) labelInput.required = !usingExisting;
 
    fields.querySelectorAll('input[id^="intgField_"]').forEach(input => {
        if (usingExisting) {
            input.removeAttribute('required');
        } else {
            // Restore required only for fields the provider marked as required.
            // We derive this from the presence of ' *' in the sibling label text.
            const label = input.closest('.form-group')?.querySelector('.form-label');
            if (label?.textContent.includes(' *')) {
                input.setAttribute('required', '');
            }
        }
    });
}

// ── Test connection ───────────────────────────────────────────────

async function testIntegrationConnection() {
    const sel        = document.getElementById('deviceProtocol');
    const providerId = sel?.value;
    const provider   = integrationProviders.find(p => p.provider_id === providerId);
    if (!provider) return;

    const resultEl       = document.getElementById('intgTestResult');
    resultEl.textContent = '⏳ Testing…';
    resultEl.style.color = 'var(--text-muted)';

    const credentials = _collectCredentials(provider);

    try {
        const res  = await apiFetch(`${API_BASE}/integrations/accounts/test`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ provider_id: providerId, credentials }),
        });
        const data = await res.json();
        if (data.ok) {
            resultEl.textContent = `✅ ${data.message}`;
            resultEl.style.color = 'var(--accent-success)';
        } else {
            resultEl.textContent = `❌ ${data.message}`;
            resultEl.style.color = 'var(--accent-danger)';
        }
    } catch (e) {
        resultEl.textContent = '❌ Request failed';
        resultEl.style.color = 'var(--accent-danger)';
    }
}

// ── Browse remote devices ─────────────────────────────────────────

async function browseRemoteDevices() {
    const sel        = document.getElementById('deviceProtocol');
    const providerId = sel?.value;
    const provider   = integrationProviders.find(p => p.provider_id === providerId);
    if (!provider) return;

    // If an existing account is already selected, use it directly
    const existingSel = document.getElementById('intgAccountSelect');
    let accountId     = existingSel?.value ? parseInt(existingSel.value) : null;

    if (!accountId) {
        // Check all required credential fields are filled
        const credentials = _collectCredentials(provider);
        const hasAllRequired = provider.fields
            .filter(f => f.required)
            .every(f => credentials[f.key]?.trim());

        if (!hasAllRequired) {
            showAlert({ title: 'Missing credentials', message: 'Fill in all required credential fields before browsing.', type: 'warning' });
            return;
        }

        // Auto-fill label from username/email if blank
        const labelEl = document.getElementById('intgAccountLabel');
        if (labelEl && !labelEl.value.trim()) {
            labelEl.value = credentials.username || credentials.email || provider.display_name;
        }

        accountId = await _ensureAccount(provider);
        if (!accountId) return;
    }

    try {
        const res = await apiFetch(`${API_BASE}/integrations/accounts/${accountId}/devices`);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            showAlert({ title: 'Error', message: err.detail || 'Could not list remote devices.', type: 'error' });
            return;
        }
        const remoteDevices = await res.json();
        if (!remoteDevices.length) {
            showAlert({ title: 'No devices', message: 'No devices found on this account.', type: 'warning' });
            return;
        }

        const chosen = await _showDevicePicker(remoteDevices);
        if (!chosen) return;

        document.getElementById('intgRemoteId').value = chosen.remote_id;
        if (!document.getElementById('deviceName').value)
            document.getElementById('deviceName').value = chosen.name;
        if (chosen.license_plate)
            document.getElementById('licensePlate').value = chosen.license_plate;

    } catch (e) {
        showAlert({ title: 'Error', message: e.message, type: 'error' });
    }
}

// ── Remote device picker modal ────────────────────────────────────

function _showDevicePicker(remoteDevices) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position:fixed; inset:0; background:rgba(0,0,0,0.75);
            z-index:9999; display:flex; align-items:center; justify-content:center;`;

        const box = document.createElement('div');
        box.style.cssText = `
            background:var(--bg-secondary); border:1px solid var(--border-color);
            border-radius:14px; padding:1.5rem; max-width:500px; width:92%;
            max-height:65vh; overflow-y:auto;`;

        box.innerHTML = `
            <div style="font-weight:700; font-size:1rem; margin-bottom:1rem;">
                Select remote device
            </div>
            ${remoteDevices.map(d => `
            <div style="padding:0.65rem 0.85rem; border:1px solid var(--border-color);
                 border-radius:8px; margin-bottom:0.5rem; cursor:pointer;"
                 onmouseover="this.style.background='var(--bg-hover)'"
                 onmouseout="this.style.background=''"
                 data-remote='${JSON.stringify(d).replace(/'/g, "&#39;")}'>
                <div style="font-weight:600;">${_esc(d.name)}</div>
                <div style="font-size:0.75rem; color:var(--text-muted);">
                    ID: ${_esc(d.remote_id)}
                    ${d.imei          ? ' · IMEI: '  + _esc(d.imei)          : ''}
                    ${d.license_plate ? ' · Plate: ' + _esc(d.license_plate) : ''}
                </div>
            </div>`).join('')}
            <button class="btn btn-secondary" style="width:100%; margin-top:0.5rem;"
                    id="_intgCancelBtn">Cancel</button>
        `;

        box.querySelectorAll('[data-remote]').forEach(el => {
            el.addEventListener('click', () => {
                document.body.removeChild(overlay);
                resolve(JSON.parse(el.dataset.remote));
            });
        });
        box.querySelector('#_intgCancelBtn').addEventListener('click', () => {
            document.body.removeChild(overlay);
            resolve(null);
        });

        overlay.appendChild(box);
        document.body.appendChild(overlay);
    });
}

// ── Helpers ───────────────────────────────────────────────────────

function _collectCredentials(provider) {
    const creds = {};
    provider.fields.forEach(f => {
        const el = document.getElementById(`intgField_${f.key}`);
        if (el) creds[f.key] = el.value.trim();
    });
    return creds;
}

async function _ensureAccount(provider) {
    const existingSel = document.getElementById('intgAccountSelect');
    if (existingSel?.value) return parseInt(existingSel.value);

    const label = document.getElementById('intgAccountLabel')?.value?.trim();
    if (!label) {
        showAlert({ title: 'Required', message: 'Enter an Account Label first.', type: 'warning' });
        return null;
    }

    const credentials = _collectCredentials(provider);
    try {
        const res = await apiFetch(`${API_BASE}/integrations/accounts`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                provider_id:   provider.provider_id,
                account_label: label,
                credentials,
            }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || 'Failed');
        const acct = await res.json();
        integrationAccounts = [
            ...integrationAccounts.filter(a => a.id !== acct.id),
            acct,
        ];
        return acct.id;
    } catch (e) {
        showAlert({ title: 'Error', message: e.message || 'Could not save account.', type: 'error' });
        return null;
    }
}
