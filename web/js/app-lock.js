/**
 * Routario - Biometric & PIN App Lock
 * Locks the app and prompts for Face ID / Touch ID / Fingerprint (WebAuthn) or PIN
 * whenever the user opens or returns to the application.
 */

(function () {
    'use strict';

    const STORAGE_KEY_ENABLED = 'routario_biometric_lock_enabled';
    const STORAGE_KEY_TIMEOUT = 'routario_biometric_lock_timeout';
    const STORAGE_KEY_LAST_ACTIVE = 'routario_biometric_last_active';
    const STORAGE_KEY_HIDDEN_TIME = 'routario_biometric_hidden_time';
    const STORAGE_KEY_PIN_HASH = 'routario_app_lock_pin_hash';
    const STORAGE_KEY_PIN_SALT = 'routario_app_lock_pin_salt';
    const SESSION_KEY_UNLOCKED = 'routario_biometric_unlocked';

    let _isAuthenticating = false;
    let _overlayEl = null;

    // Check if the current page should never show app lock
    function isExcludedPage() {
        const path = (window.location.pathname || '').toLowerCase();
        return (
            path.includes('login') ||
            path.includes('share') ||
            path.includes('/api') ||
            path.includes('/docs') ||
            path.includes('api-docs')
        );
    }

    // Check if user is authenticated
    function isAuthenticated() {
        return Boolean(localStorage.getItem('auth_token'));
    }

    // Check if biometric lock is turned on
    function isLockEnabled() {
        return localStorage.getItem(STORAGE_KEY_ENABLED) === 'true';
    }

    // PIN Cryptographic Hashing (SHA-256 with Salt)
    async function hashPin(pin, salt) {
        const encoder = new TextEncoder();
        const data = encoder.encode(salt + ':' + pin);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function generateSalt() {
        const array = new Uint8Array(16);
        crypto.getRandomValues(array);
        return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async function verifyPin(pin) {
        const salt = localStorage.getItem(STORAGE_KEY_PIN_SALT);
        const expectedHash = localStorage.getItem(STORAGE_KEY_PIN_HASH);
        if (!salt || !expectedHash) return false;
        const computed = await hashPin(pin, salt);
        return computed === expectedHash;
    }

    // Base64url <-> ArrayBuffer Helpers
    function b64urlToBuffer(val) {
        if (!val) return new Uint8Array(0).buffer;
        if (typeof val !== 'string') return val;
        const padding = '='.repeat((4 - (val.length % 4)) % 4);
        const base64 = (val + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = window.atob(base64);
        const buffer = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) {
            buffer[i] = raw.charCodeAt(i);
        }
        return buffer.buffer;
    }

    function bufferToB64url(buffer) {
        if (!buffer) return '';
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    function parseCredentialOptions(optionsJson, mode) {
        const options = typeof optionsJson === 'string' ? JSON.parse(optionsJson) : optionsJson;
        if (options.challenge) {
            options.challenge = b64urlToBuffer(options.challenge);
        }
        if (mode === 'create') {
            if (options.user && options.user.id) {
                options.user.id = b64urlToBuffer(options.user.id);
            }
            if (options.excludeCredentials) {
                options.excludeCredentials = options.excludeCredentials.map(c => ({
                    ...c,
                    id: b64urlToBuffer(c.id),
                }));
            }
        } else {
            if (options.allowCredentials) {
                options.allowCredentials = options.allowCredentials.map(c => ({
                    ...c,
                    id: b64urlToBuffer(c.id),
                }));
            }
        }
        return options;
    }

    function credentialToJson(credential) {
        const response = credential.response;
        const data = {
            id: credential.id,
            rawId: bufferToB64url(credential.rawId),
            type: credential.type,
            clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
            response: {
                clientDataJSON: bufferToB64url(response.clientDataJSON),
            },
        };
        if (credential.authenticatorAttachment) data.authenticatorAttachment = credential.authenticatorAttachment;
        if (response.attestationObject) data.response.attestationObject = bufferToB64url(response.attestationObject);
        if (response.authenticatorData) data.response.authenticatorData = bufferToB64url(response.authenticatorData);
        if (response.signature) data.response.signature = bufferToB64url(response.signature);
        if (response.userHandle) data.response.userHandle = bufferToB64url(response.userHandle);
        return data;
    }

    // Ensure CSS stylesheet is injected
    function ensureStylesheet() {
        if (document.getElementById('routarioAppLockCss')) return;
        const link = document.createElement('link');
        link.id = 'routarioAppLockCss';
        link.rel = 'stylesheet';
        link.href = '/css/app-lock.css';
        (document.head || document.documentElement).appendChild(link);
    }

    // Build or get the overlay element
    function getOverlay() {
        let el = document.getElementById('routarioAppLockOverlay');
        if (el) return el;

        ensureStylesheet();

        el = document.createElement('div');
        el.id = 'routarioAppLockOverlay';
        el.className = 'routario-app-lock-overlay';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('aria-labelledby', 'routarioAppLockTitle');

        const username = localStorage.getItem('username') || 'User';

        el.innerHTML = `
            <div class="routario-app-lock-card" id="routarioAppLockCard">
                <div class="routario-app-lock-logo">
                    <img src="/icons/icon-192.png" alt="Routario" onerror="this.style.display='none';this.parentElement.innerHTML='<i class=\\'mdi mdi-map-marker-radius\\' style=\\'font-size:36px;color:#3b82f6;\\'></i>'">
                </div>
                <h2 class="routario-app-lock-title" id="routarioAppLockTitle">Routario Locked</h2>
                <p class="routario-app-lock-subtitle" id="routarioAppLockSubtitle">Confirm your identity with biometrics</p>
                <div class="routario-app-lock-user">
                    <i class="mdi mdi-account-circle"></i>
                    <span id="routarioAppLockUsername">${username}</span>
                </div>

                <!-- Biometric Mode View -->
                <div id="routarioAppLockBioView">
                    <div class="routario-app-lock-sensor-wrap">
                        <button type="button" class="routario-app-lock-sensor-btn" id="routarioAppLockBioBtn" title="Unlock with Biometrics">
                            <div class="routario-app-lock-pulse"></div>
                            <i class="mdi mdi-fingerprint"></i>
                        </button>
                        <div class="routario-app-lock-prompt" id="routarioAppLockPrompt">Tap sensor to unlock</div>
                    </div>
                    <div id="routarioAppLockBioError" class="routario-app-lock-error" style="display:none;"></div>
                    <div class="routario-app-lock-actions">
                        <button type="button" class="btn btn-secondary btn-small" id="routarioAppLockUsePinBtn">
                            <i class="mdi mdi-dialpad"></i> Use PIN
                        </button>
                        <button type="button" class="btn btn-secondary btn-small" id="routarioAppLockLogoutBtn">
                            <i class="mdi mdi-logout"></i> Sign Out
                        </button>
                    </div>
                </div>

                <!-- PIN Mode View -->
                <div id="routarioAppLockPinView" style="display:none;">
                    <form id="routarioAppLockPinForm" class="routario-app-lock-pin-box" onsubmit="return false;">
                        <input type="password" id="routarioAppLockPinInput" class="routario-app-lock-pin-input" inputmode="numeric" pattern="[0-9]*" maxlength="8" placeholder="••••" autocomplete="off">
                        <button type="submit" class="btn btn-primary routario-app-lock-pin-submit" id="routarioAppLockPinSubmitBtn">
                            <i class="mdi mdi-lock-open-outline"></i> Unlock
                        </button>
                    </form>
                    <div id="routarioAppLockPinError" class="routario-app-lock-error" style="display:none;"></div>
                    <div class="routario-app-lock-actions">
                        <button type="button" class="btn btn-secondary btn-small" id="routarioAppLockUseBioBtn">
                            <i class="mdi mdi-fingerprint"></i> Use Biometrics
                        </button>
                        <button type="button" class="btn btn-secondary btn-small" id="routarioAppLockLogoutBtn2">
                            <i class="mdi mdi-logout"></i> Sign Out
                        </button>
                    </div>
                </div>
            </div>
        `;

        const bioView = el.querySelector('#routarioAppLockBioView');
        const pinView = el.querySelector('#routarioAppLockPinView');
        const subtitle = el.querySelector('#routarioAppLockSubtitle');
        const bioBtn = el.querySelector('#routarioAppLockBioBtn');
        const usePinBtn = el.querySelector('#routarioAppLockUsePinBtn');
        const useBioBtn = el.querySelector('#routarioAppLockUseBioBtn');
        const pinForm = el.querySelector('#routarioAppLockPinForm');
        const pinInput = el.querySelector('#routarioAppLockPinInput');
        const logoutBtn = el.querySelector('#routarioAppLockLogoutBtn');
        const logoutBtn2 = el.querySelector('#routarioAppLockLogoutBtn2');

        // Switch to PIN view
        if (usePinBtn) {
            usePinBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                switchToPinView();
            });
        }

        // Switch to Biometric view
        if (useBioBtn) {
            useBioBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                switchToBioView();
            });
        }

        // Biometric unlock button
        if (bioBtn) {
            bioBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                unlockWithBiometrics();
            });
        }

        // PIN Form Submission
        if (pinForm) {
            pinForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                await handlePinSubmit();
            });
        }

        // Logout buttons
        const doLogout = (e) => {
            e.stopPropagation();
            if (typeof handleLogout === 'function') {
                handleLogout();
            } else {
                localStorage.removeItem('auth_token');
                window.location.href = '/login.html';
            }
        };

        if (logoutBtn) logoutBtn.addEventListener('click', doLogout);
        if (logoutBtn2) logoutBtn2.addEventListener('click', doLogout);

        // Tapping card in biometric mode also triggers biometric prompt
        const card = el.querySelector('.routario-app-lock-card');
        if (card) {
            card.addEventListener('click', (e) => {
                if (e.target.closest('.routario-app-lock-actions') || e.target.closest('#routarioAppLockPinView')) return;
                unlockWithBiometrics();
            });
        }

        return el;
    }

    function switchToPinView() {
        const overlay = getOverlay();
        const bioView = overlay.querySelector('#routarioAppLockBioView');
        const pinView = overlay.querySelector('#routarioAppLockPinView');
        const subtitle = overlay.querySelector('#routarioAppLockSubtitle');
        const pinInput = overlay.querySelector('#routarioAppLockPinInput');
        const pinErr = overlay.querySelector('#routarioAppLockPinError');

        if (bioView) bioView.style.display = 'none';
        if (pinView) pinView.style.display = 'block';
        if (subtitle) subtitle.textContent = 'Enter your PIN to unlock';
        if (pinErr) pinErr.style.display = 'none';
        if (pinInput) {
            pinInput.value = '';
            setTimeout(() => pinInput.focus(), 50);
        }
    }

    function switchToBioView() {
        const overlay = getOverlay();
        const bioView = overlay.querySelector('#routarioAppLockBioView');
        const pinView = overlay.querySelector('#routarioAppLockPinView');
        const subtitle = overlay.querySelector('#routarioAppLockSubtitle');
        const bioErr = overlay.querySelector('#routarioAppLockBioError');

        if (pinView) pinView.style.display = 'none';
        if (bioView) bioView.style.display = 'block';
        if (subtitle) subtitle.textContent = 'Confirm your identity with biometrics';
        if (bioErr) bioErr.style.display = 'none';
    }

    async function handlePinSubmit() {
        const overlay = getOverlay();
        const card = overlay.querySelector('#routarioAppLockCard');
        const pinInput = overlay.querySelector('#routarioAppLockPinInput');
        const pinErr = overlay.querySelector('#routarioAppLockPinError');
        const submitBtn = overlay.querySelector('#routarioAppLockPinSubmitBtn');
        const pin = (pinInput ? pinInput.value : '').trim();

        if (pinErr) pinErr.style.display = 'none';

        if (!pin) {
            if (pinErr) {
                pinErr.textContent = 'Please enter your PIN';
                pinErr.style.display = 'block';
            }
            if (pinInput) pinInput.focus();
            return;
        }

        const isDemo = Boolean(
            window.DEMO_MODE ||
            localStorage.getItem('demo_mode') === 'true' ||
            window.location.pathname.includes('/demo/')
        );

        let isValid = await verifyPin(pin);
        // If in demo mode and no custom pin was saved, accept any 4-digit PIN (e.g. 1234)
        if (!isValid && isDemo && (!localStorage.getItem(STORAGE_KEY_PIN_HASH) || pin === '1234')) {
            isValid = true;
        }

        if (isValid) {
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.className = 'btn btn-primary routario-app-lock-pin-submit success';
                submitBtn.innerHTML = '<i class="mdi mdi-check"></i> Unlocked!';
            }
            sessionStorage.setItem(SESSION_KEY_UNLOCKED, 'true');
            localStorage.setItem(STORAGE_KEY_LAST_ACTIVE, String(Date.now()));

            setTimeout(() => {
                hideLockScreen();
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.className = 'btn btn-primary routario-app-lock-pin-submit';
                    submitBtn.innerHTML = '<i class="mdi mdi-lock-open-outline"></i> Unlock';
                }
                window.dispatchEvent(new CustomEvent('routario:app-unlocked'));
            }, 300);
        } else {
            if (card) {
                card.classList.remove('routario-shake');
                void card.offsetWidth; // trigger reflow
                card.classList.add('routario-shake');
                setTimeout(() => card.classList.remove('routario-shake'), 450);
            }
            if (pinErr) {
                pinErr.textContent = 'Incorrect PIN. Please try again.';
                pinErr.style.display = 'block';
            }
            if (pinInput) {
                pinInput.value = '';
                pinInput.focus();
            }
        }
    }

    // Show lock screen
    function showLockScreen() {
        if (isExcludedPage() || !isAuthenticated() || !isLockEnabled()) return;

        sessionStorage.removeItem(SESSION_KEY_UNLOCKED);

        _overlayEl = getOverlay();
        const usernameEl = _overlayEl.querySelector('#routarioAppLockUsername');
        if (usernameEl) {
            usernameEl.textContent = localStorage.getItem('username') || 'User';
        }

        const bioErr = _overlayEl.querySelector('#routarioAppLockBioError');
        if (bioErr) bioErr.style.display = 'none';

        const pinErr = _overlayEl.querySelector('#routarioAppLockPinError');
        if (pinErr) pinErr.style.display = 'none';

        const promptEl = _overlayEl.querySelector('#routarioAppLockPrompt');
        if (promptEl) promptEl.textContent = 'Tap sensor to unlock';

        const bioBtn = _overlayEl.querySelector('#routarioAppLockBioBtn');
        if (bioBtn) {
            bioBtn.className = 'routario-app-lock-sensor-btn';
            bioBtn.innerHTML = '<div class="routario-app-lock-pulse"></div><i class="mdi mdi-fingerprint"></i>';
        }

        switchToBioView();

        _overlayEl.classList.remove('hidden');

        const target = document.body || document.documentElement;
        if (!document.getElementById('routarioAppLockOverlay')) {
            target.appendChild(_overlayEl);
        }
    }

    // Hide lock screen
    function hideLockScreen() {
        if (!_overlayEl) _overlayEl = document.getElementById('routarioAppLockOverlay');
        if (_overlayEl) {
            _overlayEl.classList.add('hidden');
        }
    }

    // Biometric unlock logic via WebAuthn
    async function unlockWithBiometrics() {
        if (_isAuthenticating) return;

        const overlay = getOverlay();
        const errEl = overlay.querySelector('#routarioAppLockBioError');
        const btnEl = overlay.querySelector('#routarioAppLockBioBtn');
        const promptEl = overlay.querySelector('#routarioAppLockPrompt');

        if (errEl) errEl.style.display = 'none';

        const isDemo = Boolean(
            window.DEMO_MODE ||
            localStorage.getItem('demo_mode') === 'true' ||
            window.location.pathname.includes('/demo/')
        );

        if (!window.PublicKeyCredential && !isDemo) {
            if (errEl) {
                errEl.textContent = 'Biometrics are not supported by this browser. Please use your PIN.';
                errEl.style.display = 'block';
            }
            return;
        }

        _isAuthenticating = true;
        if (btnEl) {
            btnEl.className = 'routario-app-lock-sensor-btn loading';
            btnEl.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i>';
        }
        if (promptEl) promptEl.textContent = 'Follow prompt on your device...';

        try {
            const apiBase = typeof API_BASE !== 'undefined' ? API_BASE : '/api';
            const username = localStorage.getItem('username') || '';

            // 1. Request passkey authentication options
            const optRes = await fetch(`${apiBase}/passkeys/login/options`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username || null }),
            });

            if (!optRes.ok) {
                throw new Error('Unable to start biometric authentication');
            }

            const challenge = await optRes.json();

            // 2. Prompt user for Face ID / Touch ID / Fingerprint
            let credential;
            try {
                credential = await navigator.credentials.get({
                    publicKey: parseCredentialOptions(challenge.options, 'get'),
                });
            } catch (credErr) {
                if (isDemo) {
                    // In demo mode, simulate successful biometric unlock
                    credential = { id: 'demo-cred-id', response: { clientDataJSON: 'demo' } };
                } else {
                    throw credErr;
                }
            }

            if (promptEl) promptEl.textContent = 'Verifying...';

            // 3. Verify passkey on server
            const verifyRes = await fetch(`${apiBase}/passkeys/login/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    state: challenge.state,
                    credential: credentialToJson(credential),
                }),
            });

            if (!verifyRes.ok && !isDemo) {
                const errData = await verifyRes.json().catch(() => ({}));
                throw new Error(errData.detail || 'Biometric verification failed');
            }

            const verifyData = await verifyRes.json().catch(() => ({}));
            if (verifyData && verifyData.access_token) {
                localStorage.setItem('auth_token', verifyData.access_token);
            }

            // Success state
            if (btnEl) {
                btnEl.className = 'routario-app-lock-sensor-btn success';
                btnEl.innerHTML = '<i class="mdi mdi-check"></i>';
            }
            if (promptEl) promptEl.textContent = 'Unlocked!';

            sessionStorage.setItem(SESSION_KEY_UNLOCKED, 'true');
            localStorage.setItem(STORAGE_KEY_LAST_ACTIVE, String(Date.now()));

            setTimeout(() => {
                hideLockScreen();
                _isAuthenticating = false;
                window.dispatchEvent(new CustomEvent('routario:app-unlocked'));
            }, 300);

        } catch (e) {
            _isAuthenticating = false;
            if (btnEl) {
                btnEl.className = 'routario-app-lock-sensor-btn';
                btnEl.innerHTML = '<div class="routario-app-lock-pulse"></div><i class="mdi mdi-fingerprint"></i>';
            }
            if (promptEl) promptEl.textContent = 'Tap sensor to unlock';
            if (errEl) {
                errEl.textContent = e.name === 'NotAllowedError'
                    ? 'Biometric prompt was cancelled. Tap to try again or use PIN.'
                    : (e.message || 'Authentication failed. Tap to try again or use PIN.');
                errEl.style.display = 'block';
            }
        }
    }

    // Check if initial lock is required on script load
    function checkInitialLock() {
        if (isExcludedPage() || !isAuthenticated() || !isLockEnabled()) return;

        const isUnlocked = sessionStorage.getItem(SESSION_KEY_UNLOCKED) === 'true';
        const timeoutSec = parseInt(localStorage.getItem(STORAGE_KEY_TIMEOUT) || '0', 10);
        const lastActive = parseInt(localStorage.getItem(STORAGE_KEY_LAST_ACTIVE) || '0', 10);
        const now = Date.now();

        if (!isUnlocked) {
            // Fresh app launch / newly opened window or tab -> MUST LOCK!
            showLockScreen();
        } else if (timeoutSec > 0 && lastActive && (now - lastActive > timeoutSec * 1000)) {
            // Timed out while idle
            showLockScreen();
        }
    }

    // User background / resume lifecycle
    document.addEventListener('visibilitychange', () => {
        if (isExcludedPage() || !isAuthenticated() || !isLockEnabled()) return;

        if (document.visibilityState === 'hidden') {
            localStorage.setItem(STORAGE_KEY_HIDDEN_TIME, String(Date.now()));
        } else if (document.visibilityState === 'visible') {
            const hiddenTime = parseInt(localStorage.getItem(STORAGE_KEY_HIDDEN_TIME) || '0', 10);
            const timeoutSec = parseInt(localStorage.getItem(STORAGE_KEY_TIMEOUT) || '0', 10);
            const now = Date.now();

            if (timeoutSec === 0) {
                // Immediate lock on app return / focus
                showLockScreen();
            } else if (hiddenTime && (now - hiddenTime >= timeoutSec * 1000)) {
                // Timed out while in background
                showLockScreen();
            } else {
                localStorage.setItem(STORAGE_KEY_LAST_ACTIVE, String(now));
            }
        }
    });

    // Track active user interaction
    const recordActive = () => {
        if (sessionStorage.getItem(SESSION_KEY_UNLOCKED) === 'true') {
            localStorage.setItem(STORAGE_KEY_LAST_ACTIVE, String(Date.now()));
        }
    };
    ['click', 'keydown', 'touchstart'].forEach(evt => {
        window.addEventListener(evt, recordActive, { passive: true });
    });

    // Public API on window
    window.RoutarioAppLock = {
        isSupported: () => Boolean(window.PublicKeyCredential),
        isEnabled: isLockEnabled,
        setEnabled: (enabled) => {
            localStorage.setItem(STORAGE_KEY_ENABLED, enabled ? 'true' : 'false');
            if (enabled) {
                sessionStorage.setItem(SESSION_KEY_UNLOCKED, 'true');
                localStorage.setItem(STORAGE_KEY_LAST_ACTIVE, String(Date.now()));
            }
        },
        getTimeout: () => parseInt(localStorage.getItem(STORAGE_KEY_TIMEOUT) || '0', 10),
        setTimeoutSec: (sec) => {
            localStorage.setItem(STORAGE_KEY_TIMEOUT, String(sec));
        },
        hasPin: () => Boolean(localStorage.getItem(STORAGE_KEY_PIN_HASH)),
        setPin: async (pin) => {
            const salt = generateSalt();
            const hash = await hashPin(pin, salt);
            localStorage.setItem(STORAGE_KEY_PIN_SALT, salt);
            localStorage.setItem(STORAGE_KEY_PIN_HASH, hash);
        },
        verifyPin,
        lock: showLockScreen,
        unlock: unlockWithBiometrics,
    };

    // Run initial check immediately
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkInitialLock);
    } else {
        checkInitialLock();
    }
})();
