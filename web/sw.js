/**
 * Routario - Service Worker
 * Handles PWA caching and push notification delivery
 * Place this file at: /web/sw.js  (root of your web directory)
 */

const CACHE_NAME = 'gps-dashboard-v149';
const TILE_CACHE_NAME = 'routario-map-tiles-v1';
const MAX_CACHED_TILES = 1500;
let tileInsertCount = 0;

const STATIC_ASSETS = [
  '/login.html',
  '/gps-dashboard.html',
  '/device-management.html',
  '/company-management.html',
  '/drivers.html',
  '/management.html',
  '/reports.html',
  '/user-settings.html',
  '/css/tables.css',
  '/css/dashboard.css',
  '/css/device-management.css',
  '/css/user-settings.css',
  '/js/config.js',
  '/js/ui-utils.js',
  '/js/dashboard-state.js',
  '/js/dashboard.js',
  '/js/dashboard-auth.js',
  '/js/dashboard-alerts.js',
  '/js/dashboard-devices.js',
  '/js/dashboard-geofences.js',
  '/js/dashboard-bottom-bar.js',
  '/js/dashboard-history.js',
  '/js/dashboard-logbook.js',
  '/js/dashboard-map.js',
  '/js/dashboard-routes.js',
  '/js/dashboard-utils.js',
  '/js/drivers.js',
  '/js/settings-nav.js',
  '/js/device-management.js',
  '/js/device-management-integrations.js',
  '/js/device-commands.js',
  '/js/company-management.js',
  '/js/management-advanced.js',
  '/js/notification-management.js',
  '/js/reports.js',
  '/js/user-settings.js',
  '/js/users-management.js',
  '/js/pwa.js',
  '/js/voice-ptt.js',
  '/css/voice-ptt.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

/**
 * Checks whether a GET request is fetching a map tile image.
 */
function isMapTileRequest(request, url) {
  if (request.method !== 'GET') return false;
  const host = url.hostname;
  if (
    host.endsWith('tile.openstreetmap.org') ||
    host.endsWith('basemaps.cartocdn.com') ||
    host.endsWith('tiles.stadiamaps.com') ||
    host.endsWith('arcgisonline.com') ||
    host.endsWith('opentopomap.org') ||
    host.endsWith('openseamap.org') ||
    (host.endsWith('google.com') && url.pathname.includes('/vt/'))
  ) {
    return true;
  }
  // Generic XYZ tile pattern: e.g. /12/234/567.png or /tile/12/234/567
  if (/\/\d+\/\d+\/\d+(\.[a-z0-9_-]+)?$/i.test(url.pathname)) {
    return true;
  }
  return false;
}

/**
 * Writes tile to cache and periodically prunes oldest tiles to respect storage limits.
 */
async function putAndTrimTile(cache, request, response) {
  try {
    await cache.put(request, response);
    tileInsertCount++;
    if (tileInsertCount >= 40) {
      tileInsertCount = 0;
      const keys = await cache.keys();
      if (keys.length > MAX_CACHED_TILES) {
        const deleteCount = keys.length - MAX_CACHED_TILES;
        for (let i = 0; i < deleteCount; i++) {
          await cache.delete(keys[i]);
        }
      }
    }
  } catch (err) {
    console.warn('[SW] Tile cache write failed:', err);
  }
}

// ── Install: pre-cache static assets ─────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching static assets');
      // Cache what we can; ignore failures for external resources
      return Promise.allSettled(
        STATIC_ASSETS.map(url => cache.add(url).catch(() => {}))
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches (preserve map tile cache) ──────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== TILE_CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
     .then(() => self.clients.matchAll({ type: 'window' }))
     .then((clients) => clients.forEach((client) => client.postMessage({ type: 'SW_UPDATED' })))
  );
});

// ── Fetch: cache-first for static & tiles, network-first for API ─────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always go network-first for API calls and WebSockets
  if (url.pathname.startsWith('/api/') || url.protocol === 'ws:' || url.protocol === 'wss:') {
    return; // Let browser handle normally
  }

  // Map Tile Caching: Cache-First with bounded LRU eviction
  if (isMapTileRequest(event.request, url)) {
    event.respondWith(
      caches.open(TILE_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) {
          return cached;
        }
        try {
          const networkResponse = await fetch(event.request);
          if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
            const clone = networkResponse.clone();
            event.waitUntil(putAndTrimTile(cache, event.request, clone));
          }
          return networkResponse;
        } catch (err) {
          if (cached) return cached;
          throw err;
        }
      })
    );
    return;
  }

  // Static Assets & App Shell Caching
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache successful GET responses for static assets
        if (event.request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => {
      // Offline fallback for HTML pages
      if (event.request.destination === 'document') {
        return caches.match('/gps-dashboard.html');
      }
    })
  );
});

// ── Push: receive and display push notifications ──────────────────
self.addEventListener('push', (event) => {
  let data = {
    title: 'GPS Alert',
    body: 'A new alert has been triggered.',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: 'gps-alert',
    data: {}
  };

  if (event.data) {
    try {
      const payload = event.data.json();
      data = { ...data, ...payload };
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const isCritical = data.severity === 'critical' || data.severity === 'high';
  const isWarning  = data.severity === 'warning';

  // For critical emergency alerts, use an intense, escalating siren vibration pattern:
  // 500ms on, 150ms off, 500ms on, 150ms off, 500ms on, 200ms off, 800ms on, 200ms off, 1200ms on (~4.2s total)
  const vibratePattern = isCritical
    ? [500, 150, 500, 150, 500, 200, 800, 200, 1200]
    : (isWarning ? [250, 100, 250] : [150, 100, 150]);

  const hasCoordinates = Boolean(
    data.has_coordinates ||
    data.data?.has_coordinates ||
    (data.latitude != null && data.longitude != null && !isNaN(Number(data.latitude)) && !isNaN(Number(data.longitude))) ||
    (data.data?.latitude != null && data.data?.longitude != null && !isNaN(Number(data.data.latitude)) && !isNaN(Number(data.data.longitude)))
  );

  const actions = [];
  if (hasCoordinates) {
    actions.push({ action: 'open', title: 'Open Map' });
  }
  actions.push({ action: 'dismiss', title: 'Dismiss' });

  const options = {
    body: data.body,
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/badge-96.png',
    tag: isCritical ? `gps-critical-${data.data?.alert_id || Date.now()}` : (data.tag || 'gps-alert'),
    data: data.data || {},
    requireInteraction: isCritical,
    renotify: true,
    vibrate: vibratePattern,
    actions: actions
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// ── Notification click handler ────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') {
    const alertId = event.notification.data?.alert_id;
    const token = event.notification.data?.token;

    event.waitUntil((async () => {
      let markedRead = false;
      if (alertId) {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const url = token ? `/api/alerts/${alertId}/read?token=${encodeURIComponent(token)}` : `/api/alerts/${alertId}/read`;
        try {
          const res = await fetch(url, { method: 'POST', credentials: 'omit', headers });
          if (res.ok) markedRead = true;
        } catch (err) {
          console.error('[SW] Failed to mark alert read on dismiss:', err);
        }
      }

      try {
        const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of windowClients) {
          client.postMessage({
            type: 'ALERT_DISMISSED',
            alertId: alertId,
            needsApiCall: !markedRead
          });
        }
      } catch (err) {
        console.error('[SW] Failed notifying clients:', err);
      }
    })());
    return;
  }

  // Open or focus the dashboard
  const targetUrl = event.notification.data?.url || '/gps-dashboard.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus existing tab if open
      for (const client of clients) {
        if (client.url.includes('gps-dashboard') && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new tab
      return self.clients.openWindow(targetUrl);
    })
  );
});
