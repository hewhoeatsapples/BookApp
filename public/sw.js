const CACHE_NAME = 'bookapp-shell-v2'
const BASE_PATH = self.location.pathname.replace(/sw\.js$/, '')
const APP_SHELL = [
  BASE_PATH,
  `${BASE_PATH}manifest.webmanifest`,
  `${BASE_PATH}apple-touch-icon.png`,
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ),
    ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  if (request.method !== 'GET') {
    return
  }

  const url = new URL(request.url)

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request))
    return
  }

  if (
    url.hostname === 'openlibrary.org' ||
    url.hostname === 'covers.openlibrary.org'
  ) {
    event.respondWith(staleWhileRevalidate(request))
  }
})

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME)

  try {
    const response = await fetch(request)
    cache.put(request, response.clone())
    return response
  } catch {
    const cached = await cache.match(request)
    if (cached) {
      return cached
    }

    if (request.mode === 'navigate') {
      const appShell = await cache.match(BASE_PATH)
      if (appShell) {
        return appShell
      }
    }

    throw new Error('Network request failed')
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(request)

  const networkPromise = fetch(request)
    .then((response) => {
      cache.put(request, response.clone())
      return response
    })
    .catch(() => cached)

  return cached ?? networkPromise
}
