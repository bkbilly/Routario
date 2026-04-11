/**
 * Routario - PWA & Push Notification Manager
 * Place this file at: /web/js/pwa.js
 */

const VAPID_PUBLIC_KEY = 'BGQ3prURPQf1PZSGKySh1Mnr1QQW5pVBGZujTApG_zhqKxGnCz30umqOg5Mh_Q6U-5nNbAtO7XVmz0G-3RR_84g';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function initPWA() {
  await registerServiceWorker();
  renderInstallBanner();

  const btn = document.getElementById('notifEnableBtn');

  if (Notification.permission === 'granted') {
    // Already granted — ensure we have a valid subscription on the server
    await _subscribeToPush();
    if (btn) btn.style.display = 'none';
  } else if (Notification.permission === 'denied') {
    // Blocked — show the manual guide unless dismissed
    if (localStorage.getItem('notif_banner_dismissed') !== '1') {
      showNotificationBlockedBanner();
    }
    if (btn) btn.style.display = 'flex';
  } else {
    // 'default' — not yet asked. Request permission.
    if (localStorage.getItem('notif_banner_dismissed') !== '1') {
      await enablePushNotifications();
    }
    if (btn) {
      btn.style.display = Notification.permission !== 'granted' ? 'flex' : 'none';
    }
  }
}

// ── Service Worker ────────────────────────────────────────────────────────────

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.warn('[PWA] Service workers not supported');
    return null;
  }
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    console.log('[PWA] Service worker registered:', reg.scope);
    return reg;
  } catch (err) {
    console.error('[PWA] Service worker registration failed:', err);
    return null;
  }
}

// ── Push Notifications ────────────────────────────────────────────────────────

async function enablePushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('[PWA] Push notifications not supported in this browser');
    return false;
  }

  const permission = Notification.permission;

  // Already blocked — can't prompt again, must guide user to settings
  if (permission === 'denied') {
    showNotificationBlockedBanner();
    const btn = document.getElementById('notifEnableBtn');
    if (btn) btn.style.display = 'flex';
    return false;
  }

  // Ask for permission if not yet granted
  if (permission === 'default') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') {
      // On installed Android PWAs this will be 'denied' immediately
      // because the system dialog never shows — user must go to Settings
      showNotificationBlockedBanner();
      const btn = document.getElementById('notifEnableBtn');
      if (btn) btn.style.display = 'flex';
      return false;
    }
  }

  // Permission is granted — create/refresh the push subscription
  return await _subscribeToPush();
}

async function _subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return false;
  }

  const userId = localStorage.getItem('user_id');
  if (!userId) {
    console.warn('[PWA] No user_id in localStorage — not logged in yet');
    return false;
  }

  try {
    const reg = await navigator.serviceWorker.ready;

    // Always unsubscribe first to ensure a fresh, valid subscription token.
    // Stale tokens silently fail with HTTP 410 from FCM.
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      await existing.unsubscribe();
    }

    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    const res = await apiFetch(`${API_BASE}/users/${userId}/push-subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription),
    });

    if (res.ok) {
      localStorage.setItem('push_enabled', 'true');
      localStorage.removeItem('notif_banner_dismissed');
      document.getElementById('notifBlockedBanner')?.remove();
      const btn = document.getElementById('notifEnableBtn');
      if (btn) btn.style.display = 'none';
      // showPWAToast('🔔 Notifications enabled!', 'success');
      console.log('[PWA] Push subscription saved to server');
      return true;
    } else {
      const text = await res.text();
      console.error('[PWA] Server rejected subscription:', res.status, text);
      return false;
    }
  } catch (err) {
    console.error('[PWA] Push subscription error:', err);
    return false;
  }
}

// ── Notification blocked banner ───────────────────────────────────────────────

function showNotificationBlockedBanner() {
  if (document.getElementById('notifBlockedBanner')) return;

  // Detect installed PWA vs browser tab
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;

  // Instructions differ: installed PWA has no address bar
  const instructions = isStandalone
    ? `Go to your phone's <strong>Settings → Apps → Routario → Notifications</strong> and enable notifications, then tap the button below.`
    : `Tap the <strong>lock icon 🔒</strong> in the address bar, then go to <strong>Notifications → Allow</strong> and tap the button below.`;

  const banner = document.createElement('div');
  banner.id = 'notifBlockedBanner';
  banner.innerHTML = `
    <div style="
      position: fixed;
      bottom: 1rem;
      left: 50%;
      transform: translateX(-50%);
      background: var(--bg-secondary, #1e293b);
      border: 1px solid var(--accent-warning, #f59e0b);
      border-radius: 14px;
      padding: 1rem 1.25rem;
      display: flex;
      align-items: flex-start;
      gap: 1rem;
      z-index: 9999;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      max-width: 420px;
      width: calc(100% - 2rem);
      animation: slideUp 0.3s ease;
    ">
      <span style="font-size: 1.75rem; flex-shrink: 0; line-height: 1;">🔔</span>
      <div style="flex: 1; min-width: 0;">
        <div style="
          font-weight: 700;
          color: var(--accent-warning, #f59e0b);
          font-size: 0.95rem;
          margin-bottom: 0.4rem;
        ">Notifications are blocked</div>
        <div style="
          font-size: 0.8rem;
          color: var(--text-secondary, #94a3b8);
          line-height: 1.6;
          margin-bottom: 0.75rem;
        ">${instructions}</div>
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
          <button onclick="retryNotificationPermission()" style="
            background: var(--accent-warning, #f59e0b);
            color: #000;
            border: none;
            border-radius: 8px;
            padding: 0.45rem 1rem;
            font-weight: 700;
            cursor: pointer;
            font-size: 0.8rem;
            font-family: var(--font-display, sans-serif);
          ">✓ I've enabled them — retry</button>
          <button onclick="dismissNotifBanner()" style="
            background: transparent;
            border: 1px solid var(--border-color, #374151);
            color: var(--text-muted, #94a3b8);
            border-radius: 8px;
            padding: 0.45rem 0.9rem;
            cursor: pointer;
            font-size: 0.8rem;
            font-family: var(--font-display, sans-serif);
          ">Dismiss</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(banner);
}

function dismissNotifBanner() {
  document.getElementById('notifBlockedBanner')?.remove();
  localStorage.setItem('notif_banner_dismissed', '1');
}

async function retryNotificationPermission() {
  document.getElementById('notifBlockedBanner')?.remove();
  localStorage.removeItem('notif_banner_dismissed');

  if (Notification.permission === 'granted') {
    // Permission was granted in settings — just subscribe
    const success = await _subscribeToPush();
    if (!success) {
      showPWAToast('❌ Could not enable notifications. Please try again.', 'error');
    }
  } else if (Notification.permission === 'default') {
    await enablePushNotifications();
  } else {
    // Still denied — guide them again
    showNotificationBlockedBanner();
    showPWAToast('Notifications are still blocked. Please check your settings.', 'warning');
  }
}

// ── Install Banner ────────────────────────────────────────────────────────────

let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (!localStorage.getItem('pwa_install_dismissed')) {
    showInstallBanner();
  }
});

window.addEventListener('appinstalled', () => {
  hidePWABanner();
  showPWAToast('✅ App installed successfully!', 'success');
  deferredInstallPrompt = null;
  // Re-check notification permission after install —
  // the installed PWA context may have different permissions
  setTimeout(() => initPWA(), 1000);
});

function renderInstallBanner() {
  if (window.matchMedia('(display-mode: standalone)').matches) return;
  if (localStorage.getItem('pwa_install_dismissed')) return;
  // Banner will appear when beforeinstallprompt fires
}

function showInstallBanner() {
  if (document.getElementById('pwaBanner')) return;
  const banner = document.createElement('div');
  banner.id = 'pwaBanner';
  banner.innerHTML = `
    <div style="
      position: fixed; bottom: 1rem; left: 50%; transform: translateX(-50%);
      background: var(--bg-secondary, #1e293b);
      border: 1px solid var(--border-color, #334155);
      border-radius: 14px; padding: 1rem 1.25rem;
      display: flex; align-items: center; gap: 1rem;
      z-index: 9999; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      max-width: 420px; width: calc(100% - 2rem);
      animation: slideUp 0.3s ease;
    ">
      <span style="font-size: 2rem;">📱</span>
      <div style="flex: 1;">
        <div style="font-weight: 700; color: var(--text-primary, #f1f5f9); font-size: 0.95rem;">
          Install Routario
        </div>
        <div style="font-size: 0.8rem; color: var(--text-muted, #94a3b8); margin-top: 0.2rem;">
          Add to your home screen for quick access
        </div>
      </div>
      <button onclick="triggerInstall()" style="
        background: var(--accent-primary, #3b82f6);
        color: white; border: none; border-radius: 8px;
        padding: 0.5rem 1rem; font-weight: 600;
        cursor: pointer; font-size: 0.875rem;
        font-family: var(--font-display, sans-serif);
      ">Install</button>
      <button onclick="dismissPWABanner()" style="
        background: transparent; border: none;
        color: var(--text-muted, #94a3b8);
        cursor: pointer; font-size: 1.2rem; padding: 0.25rem;
      ">✕</button>
    </div>
  `;
  document.body.appendChild(banner);

  if (!document.getElementById('pwaStyles')) {
    const style = document.createElement('style');
    style.id = 'pwaStyles';
    style.textContent = `
      @keyframes slideUp {
        from { opacity: 0; transform: translateX(-50%) translateY(20px); }
        to   { opacity: 1; transform: translateX(-50%) translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }
}

async function triggerInstall() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  hidePWABanner();
}

function dismissPWABanner() {
  localStorage.setItem('pwa_install_dismissed', 'true');
  hidePWABanner();
}

function hidePWABanner() {
  document.getElementById('pwaBanner')?.remove();
}

// ── Toast helper ──────────────────────────────────────────────────────────────

function showPWAToast(message, type = 'info') {
  // Use the dashboard's showAlert if available
  if (typeof showAlert === 'function') {
    showAlert({ title: '', message, type });
    return;
  }
  // Or the shared showToast
  if (typeof showToast === 'function') {
    showToast(message, type);
    return;
  }
  // Fallback: plain toast
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || 'ℹ'}</div>
    <div class="toast-message">${message}</div>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s reverse forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}
