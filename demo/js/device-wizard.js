/**
 * device-wizard.js
 * Guided Onboarding Setup Wizard for new devices in Routario.
 * Walks the user through: Company -> Device Details -> SIM Card -> Driver -> User Access -> Cheat Sheet.
 */

(function() {
    'use strict';

    let currentStepIndex = 0;
    let activeSteps = [];
    let wizardData = {};
    let cachedProtocols = [];
    let cachedProtocolInfo = {};
    let cachedIntegrationProviders = [];
    let cachedIntegrationAccounts = [];
    let cachedCompanies = [];
    let cachedSims = [];
    let cachedSimProviders = [];
    let cachedRemoteSims = [];
    let cachedDrivers = [];
    let cachedUsers = [];

    // Helper: Escapes HTML strings
    function _esc(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function _isAdmin() {
        return localStorage.getItem('is_admin') === 'true';
    }

    function _isCompanyAdmin() {
        return localStorage.getItem('is_company_admin') === 'true';
    }

    function _getUserCompanyId() {
        const cid = localStorage.getItem('company_id');
        return cid ? parseInt(cid, 10) : null;
    }

    // ── Build Wizard Modal DOM if not present ───────────────────────────────
    function _ensureWizardModal() {
        let modal = document.getElementById('deviceWizardModal');
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = 'deviceWizardModal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <div style="display:flex;align-items:center;gap:0.6rem;">
                        <span style="font-size:1.4rem;color:var(--accent-primary);display:inline-flex;align-items:center;"><i class="mdi mdi-magic-staff"></i></span>
                        <h2 class="modal-title" style="font-size:1.35rem;">Guided Device Setup</h2>
                    </div>
                    <button type="button" class="modal-close" onclick="closeDeviceWizard()"><i class="mdi mdi-close"></i></button>
                </div>

                <div class="wizard-stepper" id="wizardStepper"></div>

                <div class="wizard-body" id="wizardBody">
                    <!-- Step 1: Company -->
                    <div class="wizard-step-panel" id="wzPanelCompany">
                        <div class="wizard-section-header">
                            <h3 class="wizard-section-title"><i class="mdi mdi-office-building"></i> Select Company</h3>
                            <p class="wizard-section-desc">Assign this tracking device to an existing company fleet, create a new company, or leave it platform-wide.</p>
                        </div>
                        <div class="wizard-choice-cards">
                            <div class="wizard-choice-card selected" onclick="_selectCompanyMode('existing')">
                                <div class="wizard-choice-head">
                                    <span class="wizard-choice-title"><i class="mdi mdi-domain"></i> Existing Company</span>
                                    <div class="wizard-choice-radio"></div>
                                </div>
                                <span class="wizard-choice-desc">Assign to an existing company in the platform.</span>
                            </div>
                            <div class="wizard-choice-card" onclick="_selectCompanyMode('new')">
                                <div class="wizard-choice-head">
                                    <span class="wizard-choice-title"><i class="mdi mdi-plus-box"></i> Create New Company</span>
                                    <div class="wizard-choice-radio"></div>
                                </div>
                                <span class="wizard-choice-desc">Set up a new organization right now.</span>
                            </div>
                            <div class="wizard-choice-card" onclick="_selectCompanyMode('none')">
                                <div class="wizard-choice-head">
                                    <span class="wizard-choice-title"><i class="mdi mdi-earth"></i> Platform Global</span>
                                    <div class="wizard-choice-radio"></div>
                                </div>
                                <span class="wizard-choice-desc">No company association (system-wide).</span>
                            </div>
                        </div>

                        <div id="wzCompanyExistingBox" class="wizard-choice-content">
                            <div class="form-group" style="margin-bottom:0;">
                                <label class="form-label">Company *</label>
                                <select id="wzCompanySelect" class="form-select" onchange="_onCompanySelectionChanged()"></select>
                            </div>
                        </div>

                        <div id="wzCompanyNewBox" class="wizard-choice-content" style="display:none;">
                            <div class="form-group" style="margin-bottom:0;">
                                <label class="form-label">Company Name *</label>
                                <input type="text" id="wzNewCompanyName" class="form-input" placeholder="e.g. Acme Logistics">
                            </div>
                        </div>
                    </div>

                    <!-- Step 2: Device Details -->
                    <div class="wizard-step-panel" id="wzPanelDevice">
                        <div class="wizard-section-header">
                            <h3 class="wizard-section-title"><i class="mdi mdi-antenna"></i> Tracker Info</h3>
                            <p class="wizard-section-desc">Enter the hardware identification and connection protocol of the GPS device.</p>
                        </div>
                        <div class="wizard-form-grid">
                            <div class="form-group">
                                <label class="form-label">Device Name *</label>
                                <input type="text" id="wzDeviceName" class="form-input" placeholder="e.g. Delivery Van 04" required>
                            </div>
                            <div class="form-group">
                                <label class="form-label">Protocol *</label>
                                <select id="wzDeviceProtocol" class="form-select" onchange="_onWizardProtocolChanged()"></select>
                                <div class="wizard-proto-info" id="wzProtoInfo" style="display:none;">
                                    <span>Target Port: <strong class="wizard-proto-port" id="wzProtoPort">5027</strong></span>
                                    <span id="wzProtoTransports"></span>
                                </div>
                            </div>
                            <div class="form-group wizard-form-full" id="wzDeviceImeiGroup">
                                <label class="form-label">IMEI / Hardware Identifier *</label>
                                <input type="text" id="wzDeviceImei" class="form-input" placeholder="e.g. 868012345678901" required>
                                <span style="font-size:0.75rem;color:var(--text-muted);margin-top:0.25rem;display:block;">Printed on the tracker label or barcode.</span>
                            </div>

                            <!-- Integration Fields Panel (shown when external integration is selected) -->
                            <div class="form-group wizard-form-full" id="wzIntgPanel" style="display:none;">
                                <div id="wzIntgFieldsContainer"></div>
                            </div>
                        </div>
                    </div>

                    <!-- Step 3: SIM Card -->
                    <div class="wizard-step-panel" id="wzPanelSim">
                        <div class="wizard-section-header">
                            <h3 class="wizard-section-title"><i class="mdi mdi-sim"></i> Cellular SIM Card (Optional)</h3>
                            <p class="wizard-section-desc">Associate a SIM card to monitor cellular data usage, balance, and network connectivity.</p>
                        </div>
                        <div class="wizard-choice-cards">
                            <div class="wizard-choice-card selected" onclick="_selectSimMode('existing')">
                                <div class="wizard-choice-head">
                                    <span class="wizard-choice-title"><i class="mdi mdi-sim"></i> Existing SIM</span>
                                    <div class="wizard-choice-radio"></div>
                                </div>
                                <span class="wizard-choice-desc">Pick an unassigned SIM from inventory.</span>
                            </div>
                            <div class="wizard-choice-card" onclick="_selectSimMode('new')">
                                <div class="wizard-choice-head">
                                    <span class="wizard-choice-title"><i class="mdi mdi-plus-box"></i> Register New SIM</span>
                                    <div class="wizard-choice-radio"></div>
                                </div>
                                <span class="wizard-choice-desc">Add a new SIM or connect via Provider API.</span>
                            </div>
                            <div class="wizard-choice-card" onclick="_selectSimMode('skip')">
                                <div class="wizard-choice-head">
                                    <span class="wizard-choice-title"><i class="mdi mdi-skip-next"></i> Skip SIM Card</span>
                                    <div class="wizard-choice-radio"></div>
                                </div>
                                <span class="wizard-choice-desc">Leave tracker without SIM profile.</span>
                            </div>
                        </div>

                        <div id="wzSimExistingBox" class="wizard-choice-content">
                            <div class="form-group" style="margin-bottom:0;">
                                <label class="form-label">Available SIM Card</label>
                                <select id="wzSimSelect" class="form-select"></select>
                            </div>
                        </div>

                        <div id="wzSimNewBox" class="wizard-choice-content" style="display:none;">
                            <div class="form-group" style="margin-bottom:0.85rem;">
                                <label class="form-label">SIM Provider</label>
                                <select id="wzNewSimProvider" class="form-select" onchange="_onWizardSimProviderChanged()"></select>
                            </div>

                            <!-- Dynamic provider fields for API credentials -->
                            <div id="wzSimProviderFields" style="margin-bottom:0.85rem;"></div>

                            <!-- Provider API Actions: Test & Fetch -->
                            <div id="wzSimApiActions" style="display:none;margin-bottom:1rem;display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;">
                                <button type="button" class="btn btn-secondary btn-small" id="wzSimTestBtn" onclick="_wzTestSimConnection()">
                                    <i class="mdi mdi-connection" id="wzSimTestIcon"></i> <span id="wzSimTestText">Test Connection</span>
                                    <span id="wzSimTestLoading" class="loading" style="display:none;margin-left:0.35rem;"></span>
                                </button>
                                <button type="button" class="btn btn-secondary btn-small" id="wzSimFetchBtn" onclick="_wzFetchRemoteSims()">
                                    <i class="mdi mdi-cloud-download" id="wzSimFetchIcon"></i> <span id="wzSimFetchText">Fetch Remote SIMs & Fill Data</span>
                                    <span id="wzSimFetchLoading" class="loading" style="display:none;margin-left:0.35rem;"></span>
                                </button>
                                <div id="wzSimTestResult" style="display:none;font-size:0.8rem;padding:0.25rem 0.6rem;border-radius:6px;font-weight:500;"></div>
                            </div>

                            <!-- Remote SIM Picker Dropdown -->
                            <div id="wzSimRemoteFetchGroup" class="form-group" style="display:none;padding:0.75rem;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;margin-bottom:1rem;">
                                <label class="form-label" style="font-weight:600;"><i class="mdi mdi-sim"></i> Discovered Remote SIM Cards (Select to auto-fill)</label>
                                <select id="wzSimRemotePickerSelect" class="form-select" onchange="_onWizardRemoteSimSelected()"></select>
                            </div>

                            <div class="wizard-form-grid">
                                <div class="form-group">
                                    <label class="form-label">Phone Number / MSISDN *</label>
                                    <input type="text" id="wzNewSimPhone" class="form-input" placeholder="e.g. +30 691 234 5678">
                                </div>
                                <div class="form-group">
                                    <label class="form-label">Plan Name</label>
                                    <input type="text" id="wzNewSimPlan" class="form-input" placeholder="e.g. 500MB IoT Flex">
                                </div>
                                <div class="form-group">
                                    <label class="form-label">Balance / Data (MB)</label>
                                    <input type="number" id="wzNewSimData" class="form-input" placeholder="e.g. 500" step="any">
                                </div>
                                <div class="form-group">
                                    <label class="form-label">Account Label</label>
                                    <input type="text" id="wzNewSimLabel" class="form-input" placeholder="e.g. IoT Fleet SIM 12">
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Step 4: Driver -->
                    <div class="wizard-step-panel" id="wzPanelDriver">
                        <div class="wizard-section-header">
                            <h3 class="wizard-section-title"><i class="mdi mdi-account-tie"></i> Assign Driver (Optional)</h3>
                            <p class="wizard-section-desc">Assign a primary driver to this vehicle, create a new driver profile, or skip for now.</p>
                        </div>
                        <div class="wizard-choice-cards">
                            <div class="wizard-choice-card selected" onclick="_selectDriverMode('existing')">
                                <div class="wizard-choice-head">
                                    <span class="wizard-choice-title"><i class="mdi mdi-account-check"></i> Existing Driver</span>
                                    <div class="wizard-choice-radio"></div>
                                </div>
                                <span class="wizard-choice-desc">Select from registered drivers.</span>
                            </div>
                            <div class="wizard-choice-card" onclick="_selectDriverMode('new')">
                                <div class="wizard-choice-head">
                                    <span class="wizard-choice-title"><i class="mdi mdi-account-plus"></i> Create New Driver</span>
                                    <div class="wizard-choice-radio"></div>
                                </div>
                                <span class="wizard-choice-desc">Register a new driver inline.</span>
                            </div>
                            <div class="wizard-choice-card" onclick="_selectDriverMode('skip')">
                                <div class="wizard-choice-head">
                                    <span class="wizard-choice-title"><i class="mdi mdi-skip-next"></i> Skip Driver</span>
                                    <div class="wizard-choice-radio"></div>
                                </div>
                                <span class="wizard-choice-desc">Leave vehicle unassigned.</span>
                            </div>
                        </div>

                        <div id="wzDriverExistingBox" class="wizard-choice-content">
                            <div class="form-group" style="margin-bottom:0;">
                                <label class="form-label">Driver</label>
                                <select id="wzDriverSelect" class="form-select"></select>
                            </div>
                        </div>

                        <div id="wzDriverNewBox" class="wizard-choice-content" style="display:none;">
                            <div class="wizard-form-grid">
                                <div class="form-group">
                                    <label class="form-label">Full Name *</label>
                                    <input type="text" id="wzNewDriverName" class="form-input" placeholder="e.g. John Doe">
                                </div>
                                <div class="form-group">
                                    <label class="form-label">Phone Number</label>
                                    <input type="text" id="wzNewDriverPhone" class="form-input" placeholder="e.g. +30 692 345 6789">
                                </div>
                                <div class="form-group">
                                    <label class="form-label">License Number</label>
                                    <input type="text" id="wzNewDriverLicense" class="form-input" placeholder="e.g. DL-987654">
                                </div>
                                <div class="form-group wizard-form-full">
                                    <label class="form-label">Notes</label>
                                    <input type="text" id="wzNewDriverNotes" class="form-input" placeholder="Optional driver notes...">
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Step 5: User Access -->
                    <div class="wizard-step-panel" id="wzPanelUsers">
                        <div class="wizard-section-header">
                            <h3 class="wizard-section-title"><i class="mdi mdi-account-group"></i> User Access Permissions</h3>
                            <p class="wizard-section-desc">Choose which users are authorized to view and monitor this device on their dashboard.</p>
                        </div>
                        <div class="wizard-choice-cards">
                            <div class="wizard-choice-card selected" onclick="_selectUserAccessMode('select')">
                                <div class="wizard-choice-head">
                                    <span class="wizard-choice-title"><i class="mdi mdi-account-multiple-check"></i> Select User(s)</span>
                                    <div class="wizard-choice-radio"></div>
                                </div>
                                <span class="wizard-choice-desc">Grant access to existing platform users.</span>
                            </div>
                            <div class="wizard-choice-card" onclick="_selectUserAccessMode('new')">
                                <div class="wizard-choice-head">
                                    <span class="wizard-choice-title"><i class="mdi mdi-account-plus"></i> Create New User</span>
                                    <div class="wizard-choice-radio"></div>
                                </div>
                                <span class="wizard-choice-desc">Create a user account and give them access.</span>
                            </div>
                            <div class="wizard-choice-card" onclick="_selectUserAccessMode('skip')">
                                <div class="wizard-choice-head">
                                    <span class="wizard-choice-title"><i class="mdi mdi-skip-next"></i> Skip Access</span>
                                    <div class="wizard-choice-radio"></div>
                                </div>
                                <span class="wizard-choice-desc">Do not grant user access right now.</span>
                            </div>
                        </div>

                        <!-- Select Existing Users Box -->
                        <div id="wzUsersSelectBox" class="wizard-choice-content">
                            <div class="wizard-users-toolbar">
                                <div class="wizard-users-quick">
                                    <button type="button" class="wizard-quick-btn" onclick="_quickSelectUsers('all')">Select All</button>
                                    <button type="button" class="wizard-quick-btn" onclick="_quickSelectUsers('me')">Only Me</button>
                                    <button type="button" class="wizard-quick-btn" onclick="_quickSelectUsers('none')">Clear</button>
                                </div>
                                <span style="font-size:0.8rem;color:var(--text-muted);" id="wzUsersCount">0 users selected</span>
                            </div>
                            <div class="wizard-users-list" id="wzUsersList"></div>
                        </div>

                        <!-- Create New User Box -->
                        <div id="wzUsersNewBox" class="wizard-choice-content" style="display:none;">
                            <div class="wizard-form-grid">
                                <div class="form-group">
                                    <label class="form-label">Username *</label>
                                    <input type="text" id="wzNewUserName" class="form-input" placeholder="e.g. john_driver">
                                </div>
                                <div class="form-group">
                                    <label class="form-label">Email Address *</label>
                                    <input type="email" id="wzNewUserEmail" class="form-input" placeholder="e.g. john@example.com">
                                </div>
                                <div class="form-group">
                                    <label class="form-label">Password *</label>
                                    <input type="password" id="wzNewUserPassword" class="form-input" placeholder="Min. 8 characters">
                                </div>
                                <div class="form-group">
                                    <label class="form-label">Account Role</label>
                                    <select id="wzNewUserRole" class="form-select">
                                        <option value="user">Regular User (Fleet Member)</option>
                                        <option value="company_admin">Company Admin</option>
                                    </select>
                                </div>
                            </div>
                        </div>

                        <!-- Skip User Box -->
                        <div id="wzUsersSkipBox" class="wizard-choice-content" style="display:none;">
                            <div style="padding:1rem;color:var(--text-muted);font-size:0.88rem;background:var(--bg-tertiary);border-radius:8px;">
                                <i class="mdi mdi-information-outline"></i> No users will be assigned right now. You can assign users later from User Management or Device Settings.
                            </div>
                        </div>
                    </div>

                    <!-- Step 6: Review & Finalize -->
                    <div class="wizard-step-panel" id="wzPanelSummary">
                        <div id="wzSummaryReviewState">
                            <div class="wizard-section-header">
                                <h3 class="wizard-section-title"><i class="mdi mdi-clipboard-check"></i> Review & Create</h3>
                                <p class="wizard-section-desc">Review your configured parameters before creating the device.</p>
                            </div>

                            <div class="wizard-summary-grid" id="wzSummaryGrid"></div>
                        </div>

                        <div id="wzSummarySuccessState" style="display:none;">
                            <div class="wizard-success-header">
                                <div class="wizard-success-badge"><i class="mdi mdi-check-bold"></i></div>
                                <h3 style="font-size:1.4rem;font-weight:700;color:var(--text-primary);margin-bottom:0.3rem;">Device Registered Successfully!</h3>
                                <p style="font-size:0.88rem;color:var(--text-muted);">Use the tracker connection cheat sheet below to configure your GPS hardware.</p>
                            </div>

                            <div class="wizard-cheatsheet">
                                <div class="wizard-cheatsheet-title"><i class="mdi mdi-router-wireless"></i> Tracker Connection Parameters</div>
                                
                                <div class="wizard-param-row">
                                    <div class="wizard-param-meta">
                                        <span class="wizard-param-label">Server Host / IP</span>
                                        <span class="wizard-param-val" id="wzCsHost"></span>
                                    </div>
                                    <button type="button" class="wizard-copy-btn" onclick="copyWizardParam(this, document.getElementById('wzCsHost').textContent)"><i class="mdi mdi-content-copy"></i> Copy</button>
                                </div>

                                <div class="wizard-param-row">
                                    <div class="wizard-param-meta">
                                        <span class="wizard-param-label">Protocol Port</span>
                                        <span class="wizard-param-val" id="wzCsPort"></span>
                                    </div>
                                    <button type="button" class="wizard-copy-btn" onclick="copyWizardParam(this, document.getElementById('wzCsPort').textContent)"><i class="mdi mdi-content-copy"></i> Copy</button>
                                </div>

                                <div class="wizard-param-row">
                                    <div class="wizard-param-meta">
                                        <span class="wizard-param-label">Device Identifier (IMEI)</span>
                                        <span class="wizard-param-val" id="wzCsImei"></span>
                                    </div>
                                    <button type="button" class="wizard-copy-btn" onclick="copyWizardParam(this, document.getElementById('wzCsImei').textContent)"><i class="mdi mdi-content-copy"></i> Copy</button>
                                </div>

                                <div class="wizard-tip-box" id="wzCsTips"></div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="wizard-footer">
                    <button type="button" class="btn btn-secondary" id="wzPrevBtn" onclick="wizardPrev()"><i class="mdi mdi-chevron-left"></i> Back</button>
                    <div class="wizard-footer-right">
                        <button type="button" class="btn btn-secondary" id="wzCancelBtn" onclick="closeDeviceWizard()">Cancel</button>
                        <button type="button" class="btn btn-primary" id="wzNextBtn" onclick="wizardNext()">Continue <i class="mdi mdi-chevron-right"></i></button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        return modal;
    }

    // ── Open Wizard Entrypoint ──────────────────────────────────────────────
    window.openDeviceWizard = async function() {
        const canCreateDevice = _isAdmin() || _isCompanyAdmin();
        if (!canCreateDevice || (typeof hasPermission === 'function' && !hasPermission('edit_devices'))) {
            showAlert('Regular users cannot add devices or use the setup wizard', 'error');
            return;
        }

        _ensureWizardModal();

        // Determine step sequence: Super Admin gets company step; others skip directly to device
        const includeCompany = _isAdmin();
        activeSteps = includeCompany
            ? ['company', 'device', 'sim', 'driver', 'users', 'summary']
            : ['device', 'sim', 'driver', 'users', 'summary'];

        currentStepIndex = 0;
        wizardData = {
            company: {
                mode: includeCompany ? 'existing' : 'user',
                company_id: _getUserCompanyId(),
                name: ''
            },
            device: {
                name: '',
                protocol: 'teltonika',
                imei: '',
                is_integration: false,
                integration: null
            },
            sim: {
                mode: 'existing',
                sim_card_id: null,
                phone_number: '',
                provider_id: 'manual',
                account_label: '',
                plan_name: '',
                balance: null,
                credentials: {}
            },
            driver: {
                mode: 'existing',
                driver_id: null,
                name: '',
                phone: '',
                license_number: '',
                notes: ''
            },
            users: {
                mode: 'select',
                selectedUserIds: new Set(),
                newUserData: {
                    username: '',
                    email: '',
                    password: '',
                    role: 'user'
                }
            },
            createdDevice: null
        };

        // Reset UI form values
        document.getElementById('wzDeviceName').value = '';
        document.getElementById('wzDeviceImei').value = '';

        document.getElementById('wzNewCompanyName').value = '';

        document.getElementById('wzNewSimPhone').value = '';
        document.getElementById('wzNewSimLabel').value = '';
        document.getElementById('wzNewSimPlan').value = '';
        document.getElementById('wzNewSimData').value = '';
        const simResBadge = document.getElementById('wzSimTestResult');
        if (simResBadge) simResBadge.style.display = 'none';
        const simRemoteGroup = document.getElementById('wzSimRemoteFetchGroup');
        if (simRemoteGroup) simRemoteGroup.style.display = 'none';

        document.getElementById('wzNewDriverName').value = '';
        document.getElementById('wzNewDriverPhone').value = '';
        document.getElementById('wzNewDriverLicense').value = '';
        document.getElementById('wzNewDriverNotes').value = '';

        document.getElementById('wzNewUserName').value = '';
        document.getElementById('wzNewUserEmail').value = '';
        document.getElementById('wzNewUserPassword').value = '';
        document.getElementById('wzNewUserRole').value = 'user';

        document.getElementById('wzSummaryReviewState').style.display = 'block';
        document.getElementById('wzSummarySuccessState').style.display = 'none';

        // Preselect current user in user access
        const myId = parseInt(localStorage.getItem('user_id'), 10);
        if (myId) wizardData.users.selectedUserIds.add(myId);

        _selectCompanyMode(includeCompany ? 'existing' : 'none');
        _selectSimMode('existing');
        _selectDriverMode('existing');
        _selectUserAccessMode('select');

        // Show modal immediately
        document.getElementById('deviceWizardModal').classList.add('active');

        // Load data dependencies asynchronously
        await _loadWizardDependencies();

        _renderStepper();
        _showCurrentStep();
    };

    window.closeDeviceWizard = function() {
        const modal = document.getElementById('deviceWizardModal');
        if (modal) modal.classList.remove('active');
    };

    // ── Load Dependencies ───────────────────────────────────────────────────
    async function _loadWizardDependencies() {
        const reqs = [];

        // 1. Protocols & Integrations
        if (window.availableProtocols && window.availableProtocols.length > 0) {
            cachedProtocols = window.availableProtocols;
            cachedProtocolInfo = window.protocolInfo || {};
        } else {
            reqs.push(
                apiFetch(`${API_BASE}/protocols`)
                    .then(r => r.ok ? r.json() : { protocols: [], protocol_info: {} })
                    .then(data => {
                        cachedProtocols = data.protocols || [];
                        cachedProtocolInfo = data.protocol_info || {};
                    })
                    .catch(() => {})
            );
        }

        // Integration Providers
        if (window.integrationProviders && window.integrationProviders.length > 0) {
            cachedIntegrationProviders = window.integrationProviders;
        } else {
            reqs.push(
                apiFetch(`${API_BASE}/integrations/providers`)
                    .then(r => r.ok ? r.json() : [])
                    .then(data => { cachedIntegrationProviders = data || []; })
                    .catch(() => {})
            );
        }

        // Integration Accounts
        if (window.integrationAccounts && window.integrationAccounts.length > 0) {
            cachedIntegrationAccounts = window.integrationAccounts;
        } else if (typeof hasPermission === 'function' && hasPermission('manage_integrations')) {
            reqs.push(
                apiFetch(`${API_BASE}/integrations/accounts`)
                    .then(r => r.ok ? r.json() : [])
                    .then(data => { cachedIntegrationAccounts = data || []; })
                    .catch(() => {})
            );
        }

        // 2. Companies
        if (window.allCompanies && window.allCompanies.length > 0) {
            cachedCompanies = window.allCompanies;
        } else if (_isAdmin()) {
            reqs.push(
                apiFetch(`${API_BASE}/companies`)
                    .then(r => r.ok ? r.json() : [])
                    .then(data => { cachedCompanies = data; })
                    .catch(() => {})
            );
        }

        // 3. SIM Cards
        reqs.push(
            apiFetch(`${API_BASE}/sim-cards`)
                .then(r => r.ok ? r.json() : [])
                .then(data => { cachedSims = data; })
                .catch(() => {})
        );

        // 4. SIM Providers
        reqs.push(
            apiFetch(`${API_BASE}/sim-cards/providers`)
                .then(r => r.ok ? r.json() : [])
                .then(data => {
                    cachedSimProviders = data;
                    _populateSimProviders(data);
                })
                .catch(() => { _populateSimProviders([]); })
        );

        // 5. Drivers
        reqs.push(
            apiFetch(`${API_BASE}/drivers`)
                .then(r => r.ok ? r.json() : [])
                .then(data => { cachedDrivers = data; })
                .catch(() => {})
        );

        // 6. Users
        if (_isAdmin() || _isCompanyAdmin()) {
            reqs.push(
                apiFetch(`${API_BASE}/users`)
                    .then(r => r.ok ? r.json() : [])
                    .then(data => { cachedUsers = data; })
                    .catch(() => {})
            );
        }

        await Promise.all(reqs);

        _populateProtocolsSelect();
        _populateCompaniesSelect();
        _refreshDynamicEntityDropdowns();
    }

    function _populateProtocolsSelect() {
        const sel = document.getElementById('wzDeviceProtocol');
        if (!sel) return;
        sel.innerHTML = '';

        const nativeNames = {
            teltonika: 'Teltonika', gt06: 'GT06 / Concox', osmand: 'OsmAnd',
            flespi: 'Flespi', totem: 'Totem', tk103: 'TK103', gps103: 'GPS103', h02: 'H02',
        };

        const nativeGroup = document.createElement('optgroup');
        nativeGroup.label = 'Native (direct connection)';
        const list = cachedProtocols.length > 0 ? cachedProtocols : ['teltonika', 'gt06', 'tk103', 'osmand'];
        [...list].sort().forEach(p => {
            const opt = document.createElement('option');
            opt.value = p;
            const info = cachedProtocolInfo[p] || {};
            const type = info.protocol_types?.includes('udp') && info.protocol_types?.includes('tcp')
                ? ' TCP/UDP' : info.protocol_types?.[0]?.toUpperCase() || 'TCP';
            const label = nativeNames[p] || (p.charAt(0).toUpperCase() + p.slice(1));
            opt.textContent = `${label} — port ${info.port || '?'} ${type}`;
            if (p === 'teltonika') opt.selected = true;
            nativeGroup.appendChild(opt);
        });
        sel.appendChild(nativeGroup);

        if (cachedIntegrationProviders.length > 0) {
            const intgGroup = document.createElement('optgroup');
            intgGroup.label = 'External Integrations';
            const canManage = typeof hasPermission === 'function' ? hasPermission('manage_integrations') : true;
            cachedIntegrationProviders.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.provider_id;
                opt.textContent = p.display_name;
                opt.dataset.integration = 'true';
                opt.disabled = !canManage;
                intgGroup.appendChild(opt);
            });
            sel.appendChild(intgGroup);
        }

        _onWizardProtocolChanged();
    }

    window._onWizardProtocolChanged = function() {
        const proto = document.getElementById('wzDeviceProtocol').value;
        const info = cachedProtocolInfo[proto] || {};
        const infoBox = document.getElementById('wzProtoInfo');
        const portEl = document.getElementById('wzProtoPort');
        const transportsEl = document.getElementById('wzProtoTransports');
        const isIntg = cachedIntegrationProviders.some(p => p.provider_id === proto);

        const imeiGroup = document.getElementById('wzDeviceImeiGroup');
        const intgPanel = document.getElementById('wzIntgPanel');
        const intgContainer = document.getElementById('wzIntgFieldsContainer');

        if (isIntg) {
            infoBox.style.display = 'none';
            if (imeiGroup) imeiGroup.style.display = 'none';
            if (intgPanel) {
                intgPanel.style.display = 'block';
                const provider = cachedIntegrationProviders.find(p => p.provider_id === proto);
                const existingAccounts = cachedIntegrationAccounts.filter(a => a.provider_id === proto);

                let existingHtml = '';
                if (existingAccounts.length > 0) {
                    existingHtml = `
                        <div class="form-group" style="margin-bottom:0.75rem;">
                            <label class="form-label">Existing Account</label>
                            <select id="wzIntgAccountSelect" class="form-select" onchange="_onWizardIntgAccountChanged()">
                                <option value="">— Enter new credentials —</option>
                                ${existingAccounts.map(a => `<option value="${a.id}">${_esc(a.account_label)}</option>`).join('')}
                            </select>
                        </div>
                    `;
                }

                const fieldsHtml = (provider?.fields || []).map(f => {
                    const type = f.field_type === 'password' ? 'password' : 'text';
                    return `
                        <div class="form-group" style="margin-bottom:0.75rem;">
                            <label class="form-label">${_esc(f.label)} ${f.required ? '<span style="color:var(--color-danger,#ef4444)">*</span>' : ''}</label>
                            <input type="${type}" id="wzIntgField_${f.key}" class="form-input" placeholder="${_esc(f.placeholder || '')}">
                        </div>
                    `;
                }).join('');

                intgContainer.innerHTML = `
                    <div style="background:var(--bg-tertiary);border:1px solid var(--accent-primary);border-radius:8px;padding:1rem;">
                        <div style="font-size:0.78rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--accent-primary);margin-bottom:0.75rem;font-weight:600;">
                            <i class="mdi mdi-connection"></i> ${_esc(provider?.display_name || proto)} Connection
                        </div>
                        ${existingHtml}
                        <div id="wzIntgNewCredsBox">
                            <div class="form-group" style="margin-bottom:0.75rem;">
                                <label class="form-label">Account Label *</label>
                                <input type="text" id="wzIntgAccountLabel" class="form-input" placeholder="e.g. Main Fleet">
                            </div>
                            ${fieldsHtml}
                        </div>
                        <div class="form-group" style="margin-bottom:0;">
                            <label class="form-label">Remote Device ID / IMEI</label>
                            <input type="text" id="wzIntgRemoteId" class="form-input" placeholder="Identifier on external platform">
                        </div>
                    </div>
                `;
            }
        } else {
            if (imeiGroup) imeiGroup.style.display = 'block';
            if (intgPanel) intgPanel.style.display = 'none';

            if (info.port) {
                infoBox.style.display = 'inline-flex';
                portEl.textContent = info.port;
                const transports = (info.protocol_types || ['TCP']).join(' / ').toUpperCase();
                transportsEl.textContent = `(${transports})`;
            } else {
                infoBox.style.display = 'none';
            }
        }
    };

    window._onWizardIntgAccountChanged = function() {
        const sel = document.getElementById('wzIntgAccountSelect');
        const box = document.getElementById('wzIntgNewCredsBox');
        if (box) {
            box.style.display = (sel && sel.value) ? 'none' : 'block';
        }
    };

    function _populateCompaniesSelect() {
        const sel = document.getElementById('wzCompanySelect');
        if (!sel) return;
        sel.innerHTML = '';
        if (!cachedCompanies.length) {
            sel.innerHTML = '<option value="">No companies found</option>';
            return;
        }
        cachedCompanies.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.name;
            sel.appendChild(opt);
        });
        if (sel.options.length > 0) {
            wizardData.company.company_id = parseInt(sel.value, 10);
        }
    }

    function _populateSimProviders(providers) {
        const sel = document.getElementById('wzNewSimProvider');
        if (!sel) return;
        sel.innerHTML = '<option value="manual">— None (Manual SIM) —</option>';
        providers.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.provider_id;
            opt.textContent = p.display_name || p.provider_id;
            sel.appendChild(opt);
        });
        _onWizardSimProviderChanged();
    }

    window._onWizardSimProviderChanged = function() {
        const provId = document.getElementById('wzNewSimProvider')?.value;
        const container = document.getElementById('wzSimProviderFields');
        const actions = document.getElementById('wzSimApiActions');
        const resEl = document.getElementById('wzSimTestResult');
        const fetchGrp = document.getElementById('wzSimRemoteFetchGroup');

        if (resEl) resEl.style.display = 'none';
        if (fetchGrp) fetchGrp.style.display = 'none';

        if (!provId || provId === 'manual') {
            if (container) container.innerHTML = '';
            if (actions) actions.style.display = 'none';
            return;
        }

        const provider = cachedSimProviders.find(p => p.provider_id === provId);
        if (!provider) {
            if (container) container.innerHTML = '';
            if (actions) actions.style.display = 'none';
            return;
        }

        if (actions) actions.style.display = 'flex';

        if (container) {
            container.innerHTML = `
                <div style="background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;padding:0.85rem;margin-bottom:0.75rem;">
                    <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);margin-bottom:0.6rem;">
                        ${_esc(provider.display_name)} API Configuration
                    </div>
                    ${(provider.fields || []).map(f => {
                        const inputType = f.field_type === 'password' ? 'password' : 'text';
                        return `
                            <div class="form-group" style="margin-bottom:0.65rem;">
                                <label class="form-label">${_esc(f.label)} ${f.required ? '<span style="color:var(--color-danger,#ef4444)">*</span>' : ''}</label>
                                <input type="${inputType}" id="wzSimCred_${f.key}" class="form-input" placeholder="${_esc(f.placeholder || '')}" value="${_esc(f.default || '')}">
                                ${f.help_text ? `<span style="font-size:0.74rem;color:var(--text-muted);display:block;margin-top:0.2rem;">${_esc(f.help_text)}</span>` : ''}
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
        }
    };

    function _getWizardSimCredentials() {
        const provId = document.getElementById('wzNewSimProvider')?.value;
        const provider = cachedSimProviders.find(p => p.provider_id === provId);
        if (!provider) return {};

        const creds = {};
        for (const f of (provider.fields || [])) {
            const el = document.getElementById(`wzSimCred_${f.key}`);
            if (el) creds[f.key] = el.value.trim();
        }
        return creds;
    }

    window._wzTestSimConnection = async function() {
        const provId = document.getElementById('wzNewSimProvider')?.value;
        if (!provId || provId === 'manual') return;

        const creds = _getWizardSimCredentials();
        const btn = document.getElementById('wzSimTestBtn');
        const text = document.getElementById('wzSimTestText');
        const load = document.getElementById('wzSimTestLoading');
        const icon = document.getElementById('wzSimTestIcon');
        const resEl = document.getElementById('wzSimTestResult');

        if (btn) btn.disabled = true;
        if (text) text.textContent = 'Testing…';
        if (icon) icon.style.display = 'none';
        if (load) load.style.display = 'inline-block';

        if (resEl) {
            resEl.style.display = 'block';
            resEl.style.background = 'rgba(99,102,241,0.12)';
            resEl.style.color = 'var(--accent-primary,#6366f1)';
            resEl.textContent = 'Testing connection…';
        }

        try {
            const res = await apiFetch(`${API_BASE}/sim-cards/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider_id: provId, credentials: creds })
            });
            const data = await res.json();
            if (data.ok) {
                resEl.style.background = 'rgba(34,197,94,0.15)';
                resEl.style.color = 'var(--color-success,#22c55e)';
                resEl.textContent = `✓ ${data.message || 'Connection successful'}`;
            } else {
                resEl.style.background = 'rgba(239,68,68,0.15)';
                resEl.style.color = 'var(--color-danger,#ef4444)';
                resEl.textContent = `✗ ${data.message || 'Connection failed'}`;
            }
        } catch (e) {
            resEl.style.background = 'rgba(239,68,68,0.15)';
            resEl.style.color = 'var(--color-danger,#ef4444)';
            resEl.textContent = `✗ ${e.message}`;
        } finally {
            if (btn) btn.disabled = false;
            if (text) text.textContent = 'Test Connection';
            if (icon) icon.style.display = '';
            if (load) load.style.display = 'none';
        }
    };

    window._wzFetchRemoteSims = async function() {
        const provId = document.getElementById('wzNewSimProvider')?.value;
        if (!provId || provId === 'manual') return;

        const creds = _getWizardSimCredentials();
        const btn = document.getElementById('wzSimFetchBtn');
        const text = document.getElementById('wzSimFetchText');
        const load = document.getElementById('wzSimFetchLoading');
        const icon = document.getElementById('wzSimFetchIcon');
        const fetchGrp = document.getElementById('wzSimRemoteFetchGroup');
        const sel = document.getElementById('wzSimRemotePickerSelect');

        if (btn) btn.disabled = true;
        if (text) text.textContent = 'Fetching SIMs…';
        if (icon) icon.style.display = 'none';
        if (load) load.style.display = 'inline-block';

        try {
            const res = await apiFetch(`${API_BASE}/sim-cards/fetch-remote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider_id: provId, credentials: creds })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || 'Failed to fetch SIMs');
            }
            cachedRemoteSims = await res.json();
            if (!cachedRemoteSims.length) {
                showAlert('No active SIM cards found on this provider account', 'warning');
                return;
            }

            fetchGrp.style.display = 'block';
            sel.innerHTML = '<option value="">— Select Remote SIM to auto-fill —</option>' +
                cachedRemoteSims.map((s, idx) => {
                    const balPart = s.balance != null ? ` - ${s.balance} ${s.currency || 'EUR'}` : '';
                    const dataPart = s.remaining_data_mb != null ? ` [${s.remaining_data_mb} MB left]` : '';
                    return `<option value="${idx}">${_esc(s.phone_number)}${s.plan_name ? ' (' + _esc(s.plan_name) + ')' : ''}${balPart}${dataPart}</option>`;
                }).join('');

            showAlert(`Discovered ${cachedRemoteSims.length} SIM card(s) from provider.`, 'success');
        } catch (e) {
            showAlert(e.message, 'error');
        } finally {
            if (btn) btn.disabled = false;
            if (text) text.textContent = 'Fetch Remote SIMs & Fill Data';
            if (icon) icon.style.display = '';
            if (load) load.style.display = 'none';
        }
    };

    window._onWizardRemoteSimSelected = function() {
        const sel = document.getElementById('wzSimRemotePickerSelect');
        const idx = parseInt(sel?.value, 10);
        if (isNaN(idx)) return;
        const chosen = cachedRemoteSims[idx];
        if (chosen) {
            if (chosen.phone_number) document.getElementById('wzNewSimPhone').value = chosen.phone_number;
            if (chosen.plan_name) document.getElementById('wzNewSimPlan').value = chosen.plan_name;
            if (chosen.remaining_data_mb != null) {
                document.getElementById('wzNewSimData').value = chosen.remaining_data_mb;
            } else if (chosen.balance != null) {
                document.getElementById('wzNewSimData').value = chosen.balance;
            }
            if (!document.getElementById('wzNewSimLabel').value && chosen.phone_number) {
                document.getElementById('wzNewSimLabel').value = chosen.phone_number;
            }
        }
    };

    // ── Update SIM, Driver, and User lists based on selected Company ─────────
    function _refreshDynamicEntityDropdowns() {
        const activeCompanyId = _getSelectedCompanyId();

        // 1. SIM Cards: Filter to unassigned SIMs for this company (or all unassigned if company null)
        const simSel = document.getElementById('wzSimSelect');
        simSel.innerHTML = '';
        const availableSims = cachedSims.filter(s => {
            const matchesCompany = (activeCompanyId == null) || (s.company_id === activeCompanyId);
            const isUnassigned = !s.device_id;
            return matchesCompany && isUnassigned;
        });

        if (availableSims.length > 0) {
            availableSims.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id;
                const provName = s.provider_id ? ` · ${s.provider_id.toUpperCase()}` : '';
                const plan = s.plan_name ? ` · ${s.plan_name}` : '';
                opt.textContent = `${s.phone_number || s.account_label}${provName}${plan}`;
                simSel.appendChild(opt);
            });
            wizardData.sim.sim_card_id = parseInt(availableSims[0].id, 10);
        } else {
            simSel.innerHTML = '<option value="">No unassigned SIM cards available</option>';
            wizardData.sim.sim_card_id = null;
        }

        // 2. Drivers: Filter to drivers of selected company
        const drvSel = document.getElementById('wzDriverSelect');
        drvSel.innerHTML = '';
        const availableDrivers = cachedDrivers.filter(d => {
            return (activeCompanyId == null) || (d.company_id === activeCompanyId);
        });

        if (availableDrivers.length > 0) {
            availableDrivers.forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.id;
                const phone = d.phone ? ` (${d.phone})` : '';
                opt.textContent = `${d.name}${phone}`;
                drvSel.appendChild(opt);
            });
            wizardData.driver.driver_id = parseInt(availableDrivers[0].id, 10);
        } else {
            drvSel.innerHTML = '<option value="">No drivers found for this company</option>';
            wizardData.driver.driver_id = null;
        }

        // 3. Users: Filter to users in selected company
        const usersListEl = document.getElementById('wzUsersList');
        usersListEl.innerHTML = '';
        const availableUsers = cachedUsers.filter(u => {
            return (activeCompanyId == null) || (u.company_id === activeCompanyId) || u.is_admin;
        });

        if (availableUsers.length > 0) {
            availableUsers.forEach(u => {
                const isSelected = wizardData.users.selectedUserIds.has(u.id);
                const item = document.createElement('div');
                item.className = 'wizard-user-item';
                if (isSelected) item.classList.add('selected');
                item.dataset.userId = u.id;
                item.onclick = () => _toggleUserSelection(u.id, item);

                const avatarLetter = (u.username || 'U').charAt(0).toUpperCase();
                const roleBadge = u.is_admin ? '<span class="badge" style="font-size:0.7rem;background:rgba(59,130,246,0.15);color:#3b82f6;">Admin</span>' : '';
                const userComp = (isAdmin && u.company_id) ? cachedCompanies.find(c => c.id === u.company_id) : null;
                const compBadge = userComp ? `<span class="badge" style="font-size:0.7rem;background:rgba(255,255,255,0.06);color:var(--text-secondary);border:1px solid var(--border-color);margin-left:0.35rem;"><i class="mdi mdi-domain" style="font-size:11px;vertical-align:middle;margin-right:2px;"></i>${_esc(userComp.name)}</span>` : '';

                item.innerHTML = `
                    <input type="checkbox" style="accent-color:var(--accent-primary);" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); _toggleUserSelection(${u.id}, this.closest('.wizard-user-item'))">
                    <div class="wizard-user-avatar">${avatarLetter}</div>
                    <div class="wizard-user-info">
                        <div class="wizard-user-name">${_esc(u.username)} ${roleBadge} ${compBadge}</div>
                        <div class="wizard-user-email">${_esc(u.email || 'No email')}</div>
                    </div>
                `;
                usersListEl.appendChild(item);
            });
        } else {
            usersListEl.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--text-muted);font-size:0.85rem;">No existing users available for this company.</div>';
        }

        _updateUsersCountDisplay();
    }

    function _getSelectedCompanyId() {
        if (!_isAdmin()) return _getUserCompanyId();
        if (wizardData.company.mode === 'existing') {
            return wizardData.company.company_id;
        }
        return null;
    }

    // ── Choice Card Selection Handlers ──────────────────────────────────────
    window._selectCompanyMode = function(mode) {
        wizardData.company.mode = mode;
        const panel = document.getElementById('wzPanelCompany');
        const cards = panel.querySelectorAll('.wizard-choice-card');
        cards.forEach((c, i) => {
            const cardModes = ['existing', 'new', 'none'];
            c.classList.toggle('selected', cardModes[i] === mode);
        });

        document.getElementById('wzCompanyExistingBox').style.display = (mode === 'existing') ? 'block' : 'none';
        document.getElementById('wzCompanyNewBox').style.display = (mode === 'new') ? 'block' : 'none';

        _refreshDynamicEntityDropdowns();
    };

    window._onCompanySelectionChanged = function() {
        const val = document.getElementById('wzCompanySelect')?.value;
        wizardData.company.company_id = val ? parseInt(val, 10) : null;
        _refreshDynamicEntityDropdowns();
    };

    window._selectSimMode = function(mode) {
        wizardData.sim.mode = mode;
        const panel = document.getElementById('wzPanelSim');
        const cards = panel.querySelectorAll('.wizard-choice-card');
        cards.forEach((c, i) => {
            const cardModes = ['existing', 'new', 'skip'];
            c.classList.toggle('selected', cardModes[i] === mode);
        });

        document.getElementById('wzSimExistingBox').style.display = (mode === 'existing') ? 'block' : 'none';
        document.getElementById('wzSimNewBox').style.display = (mode === 'new') ? 'block' : 'none';
    };

    window._selectDriverMode = function(mode) {
        wizardData.driver.mode = mode;
        const panel = document.getElementById('wzPanelDriver');
        const cards = panel.querySelectorAll('.wizard-choice-card');
        cards.forEach((c, i) => {
            const cardModes = ['existing', 'new', 'skip'];
            c.classList.toggle('selected', cardModes[i] === mode);
        });

        document.getElementById('wzDriverExistingBox').style.display = (mode === 'existing') ? 'block' : 'none';
        document.getElementById('wzDriverNewBox').style.display = (mode === 'new') ? 'block' : 'none';
    };

    window._selectUserAccessMode = function(mode) {
        wizardData.users.mode = mode;
        const panel = document.getElementById('wzPanelUsers');
        const cards = panel.querySelectorAll('.wizard-choice-card');
        cards.forEach((c, i) => {
            const cardModes = ['select', 'new', 'skip'];
            c.classList.toggle('selected', cardModes[i] === mode);
        });

        document.getElementById('wzUsersSelectBox').style.display = (mode === 'select') ? 'block' : 'none';
        document.getElementById('wzUsersNewBox').style.display = (mode === 'new') ? 'block' : 'none';
        document.getElementById('wzUsersSkipBox').style.display = (mode === 'skip') ? 'block' : 'none';
    };

    // ── User Selection Handlers ─────────────────────────────────────────────
    function _toggleUserSelection(userId, itemEl) {
        if (wizardData.users.selectedUserIds.has(userId)) {
            wizardData.users.selectedUserIds.delete(userId);
            itemEl.classList.remove('selected');
            itemEl.querySelector('input[type="checkbox"]').checked = false;
        } else {
            wizardData.users.selectedUserIds.add(userId);
            itemEl.classList.add('selected');
            itemEl.querySelector('input[type="checkbox"]').checked = true;
        }
        _updateUsersCountDisplay();
    }

    window._quickSelectUsers = function(type) {
        const myId = parseInt(localStorage.getItem('user_id'), 10);
        const activeCompanyId = _getSelectedCompanyId();
        const eligible = cachedUsers.filter(u => (activeCompanyId == null) || (u.company_id === activeCompanyId) || u.is_admin);

        wizardData.users.selectedUserIds.clear();
        if (type === 'all') {
            eligible.forEach(u => wizardData.users.selectedUserIds.add(u.id));
        } else if (type === 'me') {
            if (myId) wizardData.users.selectedUserIds.add(myId);
        }

        document.querySelectorAll('#wzUsersList .wizard-user-item').forEach(el => {
            const uid = parseInt(el.dataset.userId, 10);
            const isSel = wizardData.users.selectedUserIds.has(uid);
            el.classList.toggle('selected', isSel);
            const cb = el.querySelector('input[type="checkbox"]');
            if (cb) cb.checked = isSel;
        });
        _updateUsersCountDisplay();
    };

    function _updateUsersCountDisplay() {
        const count = wizardData.users.selectedUserIds.size;
        const el = document.getElementById('wzUsersCount');
        if (el) el.textContent = `${count} ${count === 1 ? 'user' : 'users'} selected`;
    }

    // ── Stepper UI Navigation ───────────────────────────────────────────────
    function _renderStepper() {
        const stepper = document.getElementById('wizardStepper');
        stepper.innerHTML = '';

        const stepLabels = {
            company: 'Company',
            device:  'Device',
            sim:     'SIM Card',
            driver:  'Driver',
            users:   'Access',
            summary: 'Finish'
        };

        activeSteps.forEach((stepKey, idx) => {
            const item = document.createElement('div');
            item.className = 'wizard-step-item';
            if (idx === currentStepIndex) item.classList.add('active');
            if (idx < currentStepIndex) {
                item.classList.add('completed');
                item.onclick = () => _jumpToStep(idx);
            }

            const isDone = idx < currentStepIndex;
            item.innerHTML = `
                <div class="wizard-step-num">${isDone ? '<i class="mdi mdi-check"></i>' : idx + 1}</div>
                <div class="wizard-step-label">${stepLabels[stepKey] || stepKey}</div>
            `;
            stepper.appendChild(item);

            if (idx < activeSteps.length - 1) {
                const divider = document.createElement('div');
                divider.className = 'wizard-step-divider';
                stepper.appendChild(divider);
            }
        });
    }

    function _showCurrentStep() {
        const stepKey = activeSteps[currentStepIndex];

        // Hide all panels
        document.querySelectorAll('.wizard-step-panel').forEach(p => p.classList.remove('active'));

        const panelIdMap = {
            company: 'wzPanelCompany',
            device:  'wzPanelDevice',
            sim:     'wzPanelSim',
            driver:  'wzPanelDriver',
            users:   'wzPanelUsers',
            summary: 'wzPanelSummary'
        };

        const targetPanel = document.getElementById(panelIdMap[stepKey]);
        if (targetPanel) targetPanel.classList.add('active');

        // Update footer buttons
        const prevBtn = document.getElementById('wzPrevBtn');
        const nextBtn = document.getElementById('wzNextBtn');
        const cancelBtn = document.getElementById('wzCancelBtn');

        prevBtn.style.display = currentStepIndex === 0 ? 'none' : 'inline-flex';

        if (stepKey === 'summary') {
            if (wizardData.createdDevice) {
                // Already successfully submitted
                prevBtn.style.display = 'none';
                cancelBtn.style.display = 'none';
                nextBtn.innerHTML = 'Done & View Devices <i class="mdi mdi-check"></i>';
                nextBtn.onclick = () => {
                    closeDeviceWizard();
                    if (typeof loadDevices === 'function') loadDevices();
                };
            } else {
                _renderSummaryReview();
                cancelBtn.style.display = 'inline-flex';
                nextBtn.innerHTML = 'Create Device <i class="mdi mdi-check-bold"></i>';
                nextBtn.onclick = () => wizardSubmit();
            }
        } else {
            cancelBtn.style.display = 'inline-flex';
            nextBtn.innerHTML = 'Continue <i class="mdi mdi-chevron-right"></i>';
            nextBtn.onclick = () => wizardNext();
        }

        _renderStepper();
    }

    function _jumpToStep(stepIdx) {
        if (stepIdx < currentStepIndex && !wizardData.createdDevice) {
            currentStepIndex = stepIdx;
            _showCurrentStep();
        }
    }

    // ── Validation & Transitions ────────────────────────────────────────────
    window.wizardNext = function() {
        const stepKey = activeSteps[currentStepIndex];

        // 1. Validate Company
        if (stepKey === 'company') {
            if (wizardData.company.mode === 'existing') {
                const compSel = document.getElementById('wzCompanySelect');
                if (!compSel || !compSel.value) {
                    showAlert('Please select a company or create a new one', 'error');
                    return;
                }
                wizardData.company.company_id = parseInt(compSel.value, 10);
            } else if (wizardData.company.mode === 'new') {
                const name = document.getElementById('wzNewCompanyName').value.trim();
                if (!name) {
                    showAlert('Company name is required', 'error');
                    document.getElementById('wzNewCompanyName').focus();
                    return;
                }
                wizardData.company.name = name;
            }
            _refreshDynamicEntityDropdowns();
        }

        // 2. Validate Device
        if (stepKey === 'device') {
            const name = document.getElementById('wzDeviceName').value.trim();
            const protocol = document.getElementById('wzDeviceProtocol').value;
            const isIntg = cachedIntegrationProviders.some(p => p.provider_id === protocol);
            const imei = isIntg
                ? (document.getElementById('wzIntgRemoteId')?.value.trim() || `EXT-${protocol}-${Date.now()}`.slice(0, 64))
                : document.getElementById('wzDeviceImei').value.trim();

            if (!name) {
                showAlert('Device name is required', 'error');
                document.getElementById('wzDeviceName').focus();
                return;
            }
            if (!protocol) {
                showAlert('Please select a protocol', 'error');
                return;
            }
            if (!isIntg && !imei) {
                showAlert('Device IMEI / Identifier is required', 'error');
                document.getElementById('wzDeviceImei').focus();
                return;
            }

            wizardData.device.name = name;
            wizardData.device.protocol = protocol;
            wizardData.device.imei = imei;
            wizardData.device.is_integration = isIntg;

            if (isIntg) {
                const existingSel = document.getElementById('wzIntgAccountSelect');
                const accountId = existingSel?.value ? parseInt(existingSel.value, 10) : null;
                const accountLabel = accountId
                    ? (cachedIntegrationAccounts.find(a => a.id === accountId)?.account_label || '')
                    : document.getElementById('wzIntgAccountLabel')?.value.trim();
                const remoteId = document.getElementById('wzIntgRemoteId')?.value.trim() || '';

                wizardData.device.integration = {
                    provider: protocol,
                    account_id: accountId,
                    account_label: accountLabel || protocol,
                    remote_id: remoteId
                };
            } else {
                wizardData.device.integration = null;
            }
        }

        // 3. Validate SIM
        if (stepKey === 'sim') {
            if (wizardData.sim.mode === 'existing') {
                const simSel = document.getElementById('wzSimSelect');
                wizardData.sim.sim_card_id = simSel?.value ? parseInt(simSel.value, 10) : null;
            } else if (wizardData.sim.mode === 'new') {
                const phone = document.getElementById('wzNewSimPhone').value.trim();
                if (!phone) {
                    showAlert('SIM phone number / MSISDN is required', 'error');
                    document.getElementById('wzNewSimPhone').focus();
                    return;
                }
                wizardData.sim.phone_number = phone;
                wizardData.sim.provider_id = document.getElementById('wzNewSimProvider').value || 'manual';
                wizardData.sim.account_label = document.getElementById('wzNewSimLabel').value.trim() || phone;
                wizardData.sim.plan_name = document.getElementById('wzNewSimPlan').value.trim() || null;
                const balRaw = document.getElementById('wzNewSimData').value.trim();
                wizardData.sim.balance = balRaw !== '' ? parseFloat(balRaw) : null;
                wizardData.sim.credentials = _getWizardSimCredentials();
            }
        }

        // 4. Validate Driver
        if (stepKey === 'driver') {
            if (wizardData.driver.mode === 'existing') {
                const drvSel = document.getElementById('wzDriverSelect');
                wizardData.driver.driver_id = drvSel?.value ? parseInt(drvSel.value, 10) : null;
            } else if (wizardData.driver.mode === 'new') {
                const name = document.getElementById('wzNewDriverName').value.trim();
                if (!name) {
                    showAlert('Driver name is required', 'error');
                    document.getElementById('wzNewDriverName').focus();
                    return;
                }
                wizardData.driver.name = name;
                wizardData.driver.phone = document.getElementById('wzNewDriverPhone').value.trim() || null;
                wizardData.driver.license_number = document.getElementById('wzNewDriverLicense').value.trim() || null;
                wizardData.driver.notes = document.getElementById('wzNewDriverNotes').value.trim() || null;
            }
        }

        // 5. Validate User Access
        if (stepKey === 'users') {
            if (wizardData.users.mode === 'new') {
                const username = document.getElementById('wzNewUserName').value.trim();
                const email = document.getElementById('wzNewUserEmail').value.trim();
                const password = document.getElementById('wzNewUserPassword').value;
                const role = document.getElementById('wzNewUserRole').value;

                if (!username) {
                    showAlert('Username is required', 'error');
                    document.getElementById('wzNewUserName').focus();
                    return;
                }
                if (!email) {
                    showAlert('Email address is required', 'error');
                    document.getElementById('wzNewUserEmail').focus();
                    return;
                }
                if (!password || password.length < 8) {
                    showAlert('Password must be at least 8 characters long', 'error');
                    document.getElementById('wzNewUserPassword').focus();
                    return;
                }

                wizardData.users.newUserData = { username, email, password, role };
            }
        }

        if (currentStepIndex < activeSteps.length - 1) {
            currentStepIndex++;
            _showCurrentStep();
        }
    };

    window.wizardPrev = function() {
        if (currentStepIndex > 0) {
            currentStepIndex--;
            _showCurrentStep();
        }
    };

    // ── Review Summary Renderer ─────────────────────────────────────────────
    function _renderSummaryReview() {
        const grid = document.getElementById('wzSummaryGrid');
        if (!grid) return;
        grid.innerHTML = '';

        // 1. Company
        let compLabel = 'Platform Global';
        if (wizardData.company.mode === 'existing') {
            const found = cachedCompanies.find(c => c.id === wizardData.company.company_id);
            compLabel = found ? found.name : 'Selected Company';
        } else if (wizardData.company.mode === 'new') {
            compLabel = `${wizardData.company.name} (New Company)`;
        } else if (!_isAdmin()) {
            compLabel = 'My Company Fleet';
        }

        // 2. Protocol & Port
        const isIntg = wizardData.device.is_integration;
        const proto = wizardData.device.protocol.toUpperCase();
        const pInfo = cachedProtocolInfo[wizardData.device.protocol] || {};
        const pPort = pInfo.port ? ` (Port ${pInfo.port})` : '';

        // 3. SIM
        let simLabel = 'None / Skipped';
        if (wizardData.sim.mode === 'existing' && wizardData.sim.sim_card_id) {
            const s = cachedSims.find(x => x.id === wizardData.sim.sim_card_id);
            simLabel = s ? (s.phone_number || s.account_label) : 'Existing SIM';
        } else if (wizardData.sim.mode === 'new') {
            simLabel = `${wizardData.sim.phone_number} (New SIM)`;
        }

        // 4. Driver
        let drvLabel = 'Unassigned';
        if (wizardData.driver.mode === 'existing' && wizardData.driver.driver_id) {
            const d = cachedDrivers.find(x => x.id === wizardData.driver.driver_id);
            drvLabel = d ? d.name : 'Assigned Driver';
        } else if (wizardData.driver.mode === 'new') {
            drvLabel = `${wizardData.driver.name} (New Driver)`;
        }

        // 5. Users
        let usersLabel = 'None / Skipped';
        if (wizardData.users.mode === 'select') {
            const count = wizardData.users.selectedUserIds.size;
            usersLabel = `${count} ${count === 1 ? 'user' : 'users'} granted access`;
        } else if (wizardData.users.mode === 'new') {
            usersLabel = `New user: ${wizardData.users.newUserData.username}`;
        }

        const cards = [
            { label: 'Company', val: compLabel, sub: 'Fleet scope' },
            { label: 'Device Name', val: `🚗 ${_esc(wizardData.device.name)}`, sub: 'Tracker hardware' },
            { label: 'Protocol', val: isIntg ? `${proto} (External)` : `${proto}${pPort}`, sub: `IMEI / ID: ${wizardData.device.imei}` },
            { label: 'SIM Card', val: simLabel, sub: wizardData.sim.mode === 'new' ? (wizardData.sim.provider_id || 'Cellular').toUpperCase() : 'Cellular link' },
            { label: 'Driver Assignment', val: drvLabel, sub: 'Assigned operator' },
            { label: 'User Access', val: usersLabel, sub: 'Dashboard visibility' },
        ];

        cards.forEach(c => {
            const card = document.createElement('div');
            card.className = 'wizard-summary-card';
            card.innerHTML = `
                <div class="wizard-summary-label">${c.label}</div>
                <div class="wizard-summary-val">${c.val}</div>
                <div class="wizard-summary-sub">${c.sub}</div>
            `;
            grid.appendChild(card);
        });
    }

    // ── Wizard Submit Flow (Atomic Execution) ───────────────────────────────
    window.wizardSubmit = async function() {
        const nextBtn = document.getElementById('wzNextBtn');
        const prevBtn = document.getElementById('wzPrevBtn');
        nextBtn.disabled = true;
        prevBtn.disabled = true;
        nextBtn.innerHTML = '<span class="loading" style="display:inline-block;width:14px;height:14px;margin-right:0.4rem;vertical-align:middle;"></span> Creating...';

        try {
            // 1. Create company inline if requested
            let targetCompanyId = wizardData.company.company_id;
            if (wizardData.company.mode === 'new') {
                const compRes = await apiFetch(`${API_BASE}/companies`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: wizardData.company.name })
                });
                if (!compRes.ok) {
                    const err = await compRes.json().catch(() => ({}));
                    throw new Error(err.detail || 'Failed to create new company');
                }
                const createdComp = await compRes.json();
                targetCompanyId = createdComp.id;
            } else if (wizardData.company.mode === 'none') {
                targetCompanyId = null;
            }

            // 2. Create SIM card inline if requested
            let targetSimId = wizardData.sim.sim_card_id;
            if (wizardData.sim.mode === 'new') {
                const simPayload = {
                    provider_id: wizardData.sim.provider_id || 'manual',
                    account_label: wizardData.sim.account_label || wizardData.sim.phone_number,
                    phone_number: wizardData.sim.phone_number,
                    plan_name: wizardData.sim.plan_name,
                    balance: wizardData.sim.balance,
                    credentials: wizardData.sim.credentials || {},
                    company_id: targetCompanyId
                };
                const simRes = await apiFetch(`${API_BASE}/sim-cards`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(simPayload)
                });
                if (!simRes.ok) {
                    const err = await simRes.json().catch(() => ({}));
                    throw new Error(err.detail || 'Failed to register new SIM card');
                }
                const createdSim = await simRes.json();
                targetSimId = createdSim.id;
            }

            // 3. Create Driver inline if requested
            let targetDriverId = wizardData.driver.driver_id;
            if (wizardData.driver.mode === 'new') {
                const drvPayload = {
                    name: wizardData.driver.name,
                    phone: wizardData.driver.phone,
                    license_number: wizardData.driver.license_number,
                    notes: wizardData.driver.notes,
                    company_id: targetCompanyId
                };
                const drvRes = await apiFetch(`${API_BASE}/drivers`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(drvPayload)
                });
                if (!drvRes.ok) {
                    const err = await drvRes.json().catch(() => ({}));
                    throw new Error(err.detail || 'Failed to create new driver');
                }
                const createdDrv = await drvRes.json();
                targetDriverId = createdDrv.id;
            }

            // 4. Create Device
            const devPayload = {
                name: wizardData.device.name,
                imei: wizardData.device.imei,
                protocol: wizardData.device.protocol,
                vehicle_type: 'car',
                company_id: targetCompanyId,
                sim_card_id: targetSimId,
                config: {
                    offline_timeout_hours: 24,
                    has_camera: false,
                    ...(wizardData.device.integration ? { integration: wizardData.device.integration } : {})
                }
            };

            const devRes = await apiFetch(`${API_BASE}/devices`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(devPayload)
            });

            if (!devRes.ok) {
                const err = await devRes.json().catch(() => ({}));
                throw new Error(err.detail || 'Failed to create device');
            }

            const createdDevice = await devRes.json();
            wizardData.createdDevice = createdDevice;

            // 5. Assign Driver if selected
            if (targetDriverId) {
                await apiFetch(`${API_BASE}/drivers/assign?device_id=${createdDevice.id}&driver_id=${targetDriverId}`, {
                    method: 'POST'
                }).catch(e => console.warn('Failed to assign driver to device:', e));
            }

            // 6. Handle User Access
            if (wizardData.users.mode === 'new') {
                const uData = wizardData.users.newUserData;
                const userPayload = {
                    username: uData.username,
                    email: uData.email,
                    password: uData.password,
                    is_company_admin: uData.role === 'company_admin',
                    company_id: targetCompanyId
                };
                const userRes = await apiFetch(`${API_BASE}/users`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(userPayload)
                });
                if (userRes.ok) {
                    const createdUser = await userRes.json();
                    await apiFetch(`${API_BASE}/devices/${createdDevice.id}/users?user_id=${createdUser.id}&action=add`, { method: 'POST' })
                        .catch(e => console.warn('Failed to assign newly created user to device:', e));
                } else {
                    const err = await userRes.json().catch(() => ({}));
                    console.warn('Failed to create new user for device:', err);
                }
            } else if (wizardData.users.mode === 'select' && wizardData.users.selectedUserIds.size > 0) {
                const userPromises = Array.from(wizardData.users.selectedUserIds).map(uid =>
                    apiFetch(`${API_BASE}/devices/${createdDevice.id}/users?user_id=${uid}&action=add`, { method: 'POST' })
                );
                await Promise.allSettled(userPromises);
            }

            // 7. Transition into Connection Cheat Sheet
            _renderSuccessCheatSheet(createdDevice);

            showAlert('Device added successfully!', 'success');
            window.dispatchEvent(new CustomEvent('routario:devices-updated'));
            window.dispatchEvent(new CustomEvent('routario:users-updated'));
            if (typeof loadDevices === 'function') loadDevices();

        } catch (e) {
            showAlert(e.message || 'Failed to complete device setup', 'error');
            console.error('Wizard setup error:', e);
            nextBtn.disabled = false;
            prevBtn.disabled = false;
            nextBtn.innerHTML = 'Create Device <i class="mdi mdi-check-bold"></i>';
        }
    };

    function _renderSuccessCheatSheet(device) {
        document.getElementById('wzSummaryReviewState').style.display = 'none';
        document.getElementById('wzSummarySuccessState').style.display = 'block';

        const proto = device.protocol || 'teltonika';
        const pInfo = cachedProtocolInfo[proto] || {};
        const port = pInfo.port || 5027;
        const host = window.location.hostname || 'your-server-ip';

        document.getElementById('wzCsHost').textContent = host;
        document.getElementById('wzCsPort').textContent = `${port} (${(pInfo.protocol_types || ['TCP']).join('/').toUpperCase()})`;
        document.getElementById('wzCsImei').textContent = device.imei;

        // Custom tips based on protocol
        const tipsEl = document.getElementById('wzCsTips');
        if (proto === 'teltonika') {
            tipsEl.innerHTML = `
                <strong>Teltonika Tracker Configuration:</strong><br>
                Send SMS or configure via Teltonika Configurator:<br>
                <code>setparam 2004:${host};2005:${port};2006:0</code><br>
                <span style="font-size:0.78rem;color:var(--text-muted);margin-top:0.3rem;display:inline-block;">Ensure your SIM card APN is correctly set to allow mobile data transmission.</span>
            `;
        } else if (proto === 'tk103' || proto === 'gt06') {
            tipsEl.innerHTML = `
                <strong>${proto.toUpperCase()} Tracker Configuration:</strong><br>
                Configure server address and port:<br>
                <code>adminip123456 ${host} ${port}</code><br>
                <span style="font-size:0.78rem;color:var(--text-muted);margin-top:0.3rem;display:inline-block;">Default tracker password may vary (e.g. 123456).</span>
            `;
        } else if (cachedIntegrationProviders.some(p => p.provider_id === proto)) {
            const intgProv = cachedIntegrationProviders.find(p => p.provider_id === proto);
            tipsEl.innerHTML = `
                <strong>${_esc(intgProv?.display_name || proto)} Integration:</strong><br>
                This device receives telematics telemetry pulled automatically from the external API.<br>
                <span style="font-size:0.78rem;color:var(--text-muted);margin-top:0.3rem;display:inline-block;">No direct tracker IP/port configuration required.</span>
            `;
        } else {
            tipsEl.innerHTML = `
                <strong>General Configuration:</strong><br>
                Point your GPS device to IP <code>${host}</code> on port <code>${port}</code>.<br>
                Set the unique device identifier to <code>${device.imei}</code>.
            `;
        }
    }

    window.copyWizardParam = function(btn, text) {
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            const originalHtml = btn.innerHTML;
            btn.innerHTML = '<i class="mdi mdi-check"></i> Copied';
            setTimeout(() => { btn.innerHTML = originalHtml; }, 1800);
        }).catch(() => {
            showAlert('Failed to copy to clipboard', 'error');
        });
    };

})();
