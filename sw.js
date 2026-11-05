/* App-shell caching only. Imported courses and progress belong in IndexedDB. */
'use strict';

const VERSION = '2026.11.10';
const SCOPE_URL = self.registration.scope;

function scopeHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// Sibling deployments on the same origin cannot delete each other's caches.
const CACHE_PREFIX = `dayang-english-coach-${scopeHash(SCOPE_URL)}-`;
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const INDEX_URL = new URL('./index.html', SCOPE_URL).href;
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './planner.js',
  './db.js',
  './tts.js',
  './asr.js',
  './import.js',
  './manifest.json',
  './demo.json',
  './courses_expanded.json',
  './dayang_unified_courses.json',
  './CHANGELOG.md',
  './lexicon.json',
  './THIRD_PARTY_NOTICES.txt',
  './course.schema.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon.svg',
  './README.md',
  './sw.js',
].map(path => new URL(path, SCOPE_URL).href);
const APP_SHELL_URLS = new Set(APP_SHELL);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // addAll is atomic: a missing resource prevents a partial version activating.
    await cache.addAll(APP_SHELL.map(url => new Request(url, { cache: 'reload' })));
    // Intentionally wait for the user's update action; do not skipWaiting here.
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

function mayCache(response, requestURL) {
  if (!response || !response.ok) return false;
  if (response.type === 'opaque' || response.type === 'opaqueredirect') return false;
  try {
    return new URL(response.url || requestURL).origin === self.location.origin;
  } catch {
    return false;
  }
}

async function navigationResponse() {
  const cache = await caches.open(CACHE_NAME);
  // Stay on the installed shell until its waiting replacement is accepted.
  const shell = await cache.match(INDEX_URL);
  if (shell) return shell;
  try {
    const response = await fetch(INDEX_URL);
    if (mayCache(response, INDEX_URL)) {
      try {
        await cache.put(INDEX_URL, response.clone());
      } catch {
        // A successful online response is still usable if storage is full.
      }
    }
    return response;
  } catch {
    return new Response('首次使用需要联网。请连接网络后重新打开大洋英语，完成离线缓存。', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function staticResponse(request, cacheKey = request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (mayCache(response, request.url)) {
      try {
        await cache.put(cacheKey, response.clone());
      } catch {
        // Cache quota/unsupported responses must not break an online request.
      }
    }
    return response;
  } catch {
    return new Response('此资源尚未缓存，请联网后重试。', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Avoid browser Cache API limitations for range and non-HTTP requests.
  if (!['http:', 'https:'].includes(url.protocol) || request.headers.has('range')) return;
  if (request.mode === 'navigate') {
    // A link to a precached document (README, JSON, icon, etc.) must return
    // that document, not be mistaken for an application route. Search/hash
    // do not change the installed copy used for these known static documents.
    const documentURL = new URL(url.href);
    documentURL.search = '';
    documentURL.hash = '';
    const isStaticDocument = APP_SHELL_URLS.has(documentURL.href)
      && documentURL.href !== SCOPE_URL
      && documentURL.href !== INDEX_URL;
    event.respondWith(isStaticDocument
      ? staticResponse(request, documentURL.href)
      : navigationResponse());
    return;
  }
  event.respondWith(staticResponse(request));
});
