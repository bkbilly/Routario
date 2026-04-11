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

async function initPWA() {
  await registerServiceWorker();
  renderInstallBanner();
  await enablePushNotifications();
}

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

async function enablePushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('[PWA] Push notifications not supported');
    return false;
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    console.warn('[PWA] Notification permission denied');
    return false;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    let subscription = await reg.pushManager.getSubscription();
    const alreadySubscribed = !!subscription;

    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }

    const userId = localStorage.getItem('user_id');

    const res = await apiFetch(`${API_BASE}/users/${userId}/push-subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription)
    });

    if (res.ok) {
      localStorage.setItem('push_enabled', 'true');
      if (!alreadySubscribed) {
        showPWAToast('🔔 Desktop notifications enabled!', 'success');
      }
      return true;
    } else {
      console.error('[PWA] Server rejected subscription:', res.status, await res.text());
      return false;
    }
  } catch (err) {
    console.error('[PWA] Push subscription error:', err);
    return false;
  }
}

// ── Install Banner ────────────────────────────────────────────────
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
});

function renderInstallBanner() {
  if (window.matchMedia('(display-mode: standalone)').matches) return;
  if (localStorage.getItem('pwa_install_dismissed')) return;
}

function showInstallBanner() {
  if (document.getElementById('pwaBanner')) return;
  const banner = document.createElement('div');
  banner.id = 'pwaBanner';
  banner.innerHTML = `
    <div style="
      position: fixed; bottom: 1rem; left: 50%; transform: translateX(-50%);
      background: var(--bg-secondary, #1e293b); border: 1px solid var(--border-color, #334155);
      border-radius: 14px; padding: 1rem 1.25rem; display: flex; align-items: center;
      gap: 1rem; z-index: 9999; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      max-width: 420px; width: calc(100% - 2rem); animation: slideUp 0.3s ease;
    ">
      <span style="font-size: 2rem;">📱</span>
      <div style="flex: 1;">
        <div style="font-weight: 700; color: var(--text-primary, #f1f5f9); font-size: 0.95rem;">Install Routario</div>
        <div style="font-size: 0.8rem; color: var(--text-muted, #94a3b8); margin-top: 0.2rem;">Add to your home screen for quick access</div>
      </div>
      <button onclick="triggerInstall()" style="background: var(--accent-primary, #3b82f6); color: white; border: none; border-radius: 8px; padding: 0.5rem 1rem; font-weight: 600; cursor: pointer; font-size: 0.875rem;">Install</button>
      <button onclick="dismissPWABanner()" style="background: transparent; border: none; color: var(--text-muted, #94a3b8); cursor: pointer; font-size: 1.2rem; padding: 0.25rem;">✕</button>
    </div>
  `;
  document.body.appendChild(banner);
  if (!document.getElementById('pwaStyles')) {
    const style = document.createElement('style');
    style.id = 'pwaStyles';
    style.textContent = `@keyframes slideUp { from { opacity:0; transform:translateX(-50%) translateY(20px);} to {opacity:1; transform:translateX(-50%) translateY(0);}}`;
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

function showPWAToast(message, type = 'info') {
  if (typeof showAlert === 'function') { showAlert(message, type); return; }
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<div class="toast-icon">${icons[type] || 'ℹ'}</div><div class="toast-message">${message}</div>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s reverse forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}