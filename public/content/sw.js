// Replaced with the commit sha at deploy time. Without this the worker's
// bytes never change between deploys, so the browser never notices there is
// a new version and keeps serving the old cached app forever.
const BUILD_ID = '__BUILD_ID__';
const CACHE_NAME = `content-studio-${BUILD_ID}`;
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './db.js',
  './ai.js',
  './ideas-seed.js',
  './version.js',
  './styles.css',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

const MOTIVATIONS = [
  'The streak is waiting on you. Post something — anything — before the day ends.',
  "Don't break the streak. Post no matter what.",
  'A small post today beats a perfect post you never make.',
  'Future you will thank today you for not skipping this one.'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});

// Reads the small meta record db.js mirrors into IndexedDB on every save
// (service workers can't touch localStorage, so this is the only way the
// worker knows whether reminders are on / already posted today).
function readMeta() {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open('content-studio-meta', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('meta');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('meta', 'readonly');
        const getReq = tx.objectStore('meta').get('reminder');
        getReq.onsuccess = () => resolve(getReq.result || null);
        getReq.onerror = () => resolve(null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

// Best-effort background nudge. Periodic Background Sync only exists on
// Chrome/Android for installed PWAs with enough engagement — most sessions
// never fire this, so it's a bonus on top of the reliable foreground check
// in app.js, never the only mechanism.
self.addEventListener('periodicsync', event => {
  if (event.tag !== 'streak-check') return;
  event.waitUntil(
    readMeta().then(meta => {
      if (!meta || !meta.remindersEnabled || meta.postedToday) return;
      const now = new Date();
      const [h, m] = (meta.reminderTime || '18:00').split(':').map(Number);
      if (now.getHours() < h || (now.getHours() === h && now.getMinutes() < m)) return;
      const msg = MOTIVATIONS[Math.floor(Math.random() * MOTIVATIONS.length)];
      const title = meta.streak > 0 ? `🔥 Day ${meta.streak} streak — don't stop now` : 'Time to post';
      return self.registration.showNotification(title, {
        body: msg,
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        tag: 'streak-reminder'
      });
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      if (clients.length > 0) return clients[0].focus();
      return self.clients.openWindow('./');
    })
  );
});
