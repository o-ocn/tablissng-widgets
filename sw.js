const RUNTIME_CACHE = "tablissng-runtime-v2";
const SHELL_CACHE = "tablissng-shell-v1";
const CACHE_PREFIX = "tablissng-";

/*
   外壳缓存（HTML / JS）

   目的：修复新标签页冷启动时三个 iframe
   （index / search / shortcuts）因 GitHub Pages
   传输缓慢而长时间空白的问题。

   实测（2026-09-25，GitHub Pages）：
   shortcuts.html 主文档 TTFB 约 0.3s，
   但 29.7KB（压缩后）下载耗时 5.4s；
   三个 iframe 并发时最慢可拖到 20s+。

   策略：

   1. 只拦截同源的 HTML 导航与脚本请求；
      图片仍走原 cacheFirstImage；
      跨域请求（云端同步 Worker、VPS API、
      搜索引擎、图标）完全不经过这里，
      同步数据零改动。
   2. 缓存键 = pathname（忽略 ?v= 查询参数）。
      发布 ?v=18 时：首次打开立即返回缓存内容
      （秒出），同时后台拉取新版本成功后替换缓存，
      下一次打开即为新版 —— 不会长期卡在旧页面。
   3. 网络优先，超时 2.5 秒后回退缓存：
      网络好时拿最新，网络差/断网时立即显示
      上次成功加载的页面。
   4. 缓存条目带写入时间（x-shell-stored-at），
      超过 24 小时强制走网络重新填充。
   5. sw.js 文件本身更新时（部署新版本），
      activate 会清空旧外壳缓存，强制全量重建。
*/

const SHELL_MAX_AGE = 24 * 60 * 60 * 1000;
const SHELL_NETWORK_TIMEOUT = 2500;

self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();

      await Promise.all(
        names
          .filter(name => name.startsWith(CACHE_PREFIX) && name !== RUNTIME_CACHE && name !== SHELL_CACHE)
          .map(name => caches.delete(name))
      );

      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  if (request.destination === "image") {
    event.respondWith(cacheFirstImage(request));
    return;
  }

  if (isShellRequest(request)) {
    event.respondWith(shellStrategy(request, event));
    return;
  }

  /* 其余请求（跨域 API 等）保持浏览器默认行为 */
});

function isShellRequest(request) {
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    return false;
  }

  const isNavigation =
    request.mode === "navigate"
    || request.destination === "document";

  const isScript =
    request.destination === "script"
    || /\.js$/.test(url.pathname);

  const isHtml = /\.html?$/.test(url.pathname) || url.pathname === "/";

  return (isNavigation && isHtml) || isScript;
}

async function shellStrategy(request, event) {
  const cache = await caches.open(SHELL_CACHE);
  const key = new URL(request.url).pathname;
  const cached = await cache.match(key);
  const storedAt = cached
    ? Number(cached.headers.get("x-shell-stored-at") || 0)
    : 0;
  const fresh = cached && Date.now() - storedAt < SHELL_MAX_AGE;

  /* 后台更新：无论本次返回什么，都尝试拉取最新版本 */
  const networkUpdate = (async () => {
    try {
      const response = await fetch(request);

      if (response && response.ok) {
        await cache.put(key, stampResponse(response));
      }

      return response;
    } catch (error) {
      return null;
    }
  })();

  if (event && event.waitUntil) {
    event.waitUntil(networkUpdate);
  }

  /* 缓存新鲜：立即返回，让网络在后台更新 */
  if (fresh) {
    return cached;
  }

  /* 无缓存或已过期（冷启动 / 超过 24h）：
     网络优先，超时或失败时回退缓存；
     完全没有缓存时让网络请求自然完成（与现状一致）。 */
  try {
    const response = await Promise.race([
      networkUpdate,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("shell timeout")), SHELL_NETWORK_TIMEOUT);
      })
    ]);

    if (response && response.ok) {
      return response;
    }
  } catch (error) {
    /* 超时或网络失败：走缓存回退 */
  }

  if (cached) {
    return cached;
  }

  /* 没有缓存：等待网络结果（成功或失败都如实返回） */
  const finalResponse = await networkUpdate;

  if (finalResponse) {
    return finalResponse;
  }

  return fetch(request);
}

/* 给缓存条目打上写入时间戳 */

function stampResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("x-shell-stored-at", String(Date.now()));

  return new Response(response.clone().body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

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
