const RUNTIME_CACHE = "tablissng-runtime-v2";
const CACHE_PREFIX = "tablissng-runtime-";

self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();

      await Promise.all(
        names
          .filter(name => name.startsWith(CACHE_PREFIX) && name !== RUNTIME_CACHE)
          .map(name => caches.delete(name))
      );

      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET" || request.destination !== "image") {
    return;
  }

  event.respondWith(cacheFirstImage(request));
});

self.addEventListener("message", event => {
  if (event.data?.type !== "WARM_ICON_CACHE") {
    return;
  }

  const urls = Array.isArray(event.data.urls)
    ? [...new Set(event.data.urls)].slice(0, 300)
    : [];

  event.waitUntil(warmIconCache(urls));
});

async function cacheFirstImage(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);

  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);

    if (response.ok || response.type === "opaque") {
      await cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    const fallback = await cache.match(request, { ignoreVary: true });

    if (fallback) {
      return fallback;
    }

    throw error;
  }
}

async function warmIconCache(urls) {
  const cache = await caches.open(RUNTIME_CACHE);

  await Promise.allSettled(
    urls
      .filter(url => /^https:\/\//i.test(url))
      .map(async url => {
        const request = new Request(url, {
          mode: "no-cors",
          credentials: "omit",
          cache: "reload"
        });

        if (await cache.match(request)) {
          return;
        }

        const response = await fetch(request);

        if (response.ok || response.type === "opaque") {
          await cache.put(request, response);
        }
      })
  );
}
