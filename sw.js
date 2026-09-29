const CACHE = 'dearly-message-20260929-4';
const ASSETS = ['./', './index.html', './style.css', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);
  const sameOrigin = url.origin === self.location.origin;
  const isAppShell = sameOrigin && (
    e.request.mode === 'navigate' ||
    /\.(?:html|js|css|webmanifest)$/.test(url.pathname)
  );

  if (isAppShell) {
    // 새 문구와 코드가 이전 캐시에 가로막히지 않도록 앱 파일은 네트워크 우선.
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }).catch(() =>
        caches.match(e.request).then(r => r || caches.match('./index.html'))
      )
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (sameOrigin) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }))
  );
});

function logPush(d) {
  return new Promise((resolve, reject) => {
    const q = indexedDB.open('dear-message-v2', 1);
    q.onupgradeneeded = () => q.result.createObjectStore('pushlog', { keyPath: 'id' });
    q.onerror = () => reject(q.error);
    q.onsuccess = () => {
      const db = q.result, tx = db.transaction('pushlog', 'readwrite');
      tx.objectStore('pushlog').put({
        id: crypto.randomUUID(),
        ts: Date.now(),
        title: d.title || '새 메시지',
        message: d.body || '',
        data: d,
      });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
}

// Firebase가 notificationclick을 덮지 않도록 먼저 등록.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow ? self.clients.openWindow('./') : undefined;
  }));
});


const AVATAR_DB = 'dear-message-avatars';
const AVATAR_STORE = 'avatars';

function getCachedAvatar(characterId) {
  if (!characterId) return Promise.resolve('');
  return new Promise(resolve => {
    const req = indexedDB.open(AVATAR_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AVATAR_STORE)) db.createObjectStore(AVATAR_STORE);
    };
    req.onerror = () => resolve('');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(AVATAR_STORE, 'readonly');
      const get = tx.objectStore(AVATAR_STORE).get(characterId);
      get.onsuccess = () => resolve(get.result || '');
      get.onerror = () => resolve('');
      tx.oncomplete = () => db.close();
    };
  });
}

importScripts('https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyDxHoReGJVBh-574v4cYSpq2GiPgs3TaOg',
  authDomain: 'dearly-message.firebaseapp.com',
  projectId: 'dearly-message',
  storageBucket: 'dearly-message.firebasestorage.app',
  messagingSenderId: '864968097858',
  appId: '1:864968097858:web:e60e44cd381ca3a7e9addb',
  measurementId: 'G-T79KM8496B',
});

try {
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage(async payload => {
    const d = payload.data || {};
    const title = payload.notification?.title || d.title || '새 메시지';
    const body = payload.notification?.body || d.body || '';
    const cachedAvatar = await getCachedAvatar(d.characterId);
    const icon = cachedAvatar || d.icon || './icon-192.png';
    return Promise.all([
      logPush({ ...d, title, body }),
      self.registration.showNotification(title, {
        body,
        icon,
        badge: './icon-192.png',
        tag: d.tag || `dear-${Date.now()}`,
        data: d,
      }),
    ]);
  });
} catch (e) {
  console.error('Firebase Messaging service worker init failed:', e);
}
