const RUNTIME_CACHE = "tablissng-runtime-v2";
const SHELL_CACHE = "tablissng-shell-v2";
const CACHE_PREFIX = "tablissng-";

/*
   外壳缓存（HTML / JS）—— v2 设计

   目的：修复新标签页冷启动时三个 iframe
   （index / search / shortcuts）因 GitHub Pages
   传输缓慢而长时间空白的问题。

   实测（2026-09-25，GitHub Pages）：
   shortcuts.html 主文档 TTFB 约 0.3s，
   但 29.7KB（压缩后）下载耗时 5.4s；
   三个 iframe 并发时最慢可拖到 20s+。

   ── 版本配套（防止新旧文件混用）──────────────

   缓存键包含完整的 ?v= 参数：

     /tablissng-widgets/shortcuts.html?v=18
     /tablissng-widgets/sync-model.js?v=18

   sync-model.js 自身没有版本参数，但页面加载它时
   SW 能读到请求的 referrer（即 shortcuts.html?v=N
   的完整地址），因此 JS 的缓存键跟随所属 HTML 的
   版本号。效果：

   - v18 的 HTML 只会配 v18 的 sync-model.js；
   - 旧版本 HTML 作为回退时，配套的旧版本 JS
     仍在自己的键下，同样成对；
   - 不存在"新 HTML + 旧 JS"的混用路径：
     若对应版本的 JS 不在缓存，回退网络，
     网络失败就让该次脚本加载失败（严格但安全）。

   发布新版本后的表现：
   第一次打开：该版本缓存缺失 → 走网络（与现状相同，
   可能较慢），成功后写入 v=N 的成对缓存；
   第二次打开：缓存优先，秒开。

   ── 新鲜度（准确语义）────────────────────────

   - 24 小时内：缓存优先（快路径），后台静默更新。
   - 24 小时 ~ 30 天：转为网络优先（超时 2.5s 回退到
     同版本缓存）——不再宣称"强制过期后仍秒开"。
   - 超过 30 天：条目直接删除，不再作为回退，
     防止过旧的快捷方式页面带着不兼容的同步逻辑
     长期运行。

   ── 其他 ────────────────────────────────────

   - 目录首页（/tablissng-widgets/?v=7，VPS iframe）
     归一化为 index.html 参与缓存。
   - 图片仍走原 cacheFirstImage；跨域请求（云端同步
     Worker、VPS API、搜索引擎、图标源）不经过这里，
     同步数据零改动。
   - 同一路径只保留最近 3 个版本的条目。
*/

const SHELL_FRESH_AGE = 24 * 60 * 60 * 1000;
const SHELL_HARD_AGE = 30 * 24 * 60 * 60 * 1000;
const SHELL_NETWORK_TIMEOUT = 2500;
const SHELL_KEEP_VERSIONS = 3;

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

  const path = normalisePath(url.pathname);

  const isHtml =
    /\.html?$/.test(path)
    || path.endsWith("index.html");

  return (isNavigation && isHtml) || isScript;
}

/* /tablissng-widgets/ → /tablissng-widgets/index.html */

function normalisePath(pathname) {
  return pathname.endsWith("/")
    ? pathname + "index.html"
    : pathname;
}

/* 缓存键 = 归一化路径 + 完整查询参数(含 ?v=),统一为绝对 URL */

function cacheKeyFor(url) {
  return new URL(normalisePath(url.pathname) + url.search, url.origin).href;
}

function versionOf(url) {
  return url.searchParams.get("v") || "";
}

function referrerVersion(request) {
  try {
    if (!request.referrer || request.referrer === "about:client") {
      return "";
    }

    return versionOf(new URL(request.referrer));
  } catch (error) {
    return "";
  }
}

async function shellStrategy(request, event) {
  const url = new URL(request.url);
  const cache = await caches.open(SHELL_CACHE);

  /* 脚本:跟随所属 HTML 的版本(referrer 携带 ?v=) */
  const isScript = request.destination === "script" || /\.js$/.test(url.pathname);

  if (isScript) {
    const version = referrerVersion(request);
    const key = new URL(
      normalisePath(url.pathname) + (version ? `?v=${version}` : url.search),
      url.origin
    ).href;
    return shellReadThrough(request, event, cache, key, { isScript });
  }

  return shellReadThrough(request, event, cache, cacheKeyFor(url), { isScript: false });
}

async function shellReadThrough(request, event, cache, key, { isScript }) {
  const url = new URL(request.url);
  const path = normalisePath(url.pathname);

  const cached = await cache.match(key);
  const storedAt = cached
    ? Number(cached.headers.get("x-shell-stored-at") || 0)
    : 0;
  const age = Date.now() - storedAt;

  /*
     超过 30 天：删除条目，不再作为回退。
     网络失败时宁可加载失败，也不运行
     可能不兼容当前同步协议的古老页面。
  */

  if (cached && age > SHELL_HARD_AGE) {
    await cache.delete(key);
    return networkOnly(request);
  }

  const fresh = cached && age < SHELL_FRESH_AGE;

  /*
     24 小时内：缓存优先（快路径）。
     版本更新由 ?v= 键变化触发：发布新版本时
     缓存键不同，必然走网络拉取。
  */

  if (fresh) {
    return cached;
  }

  /*
     无缓存或已过期（24h~30d）：网络优先。
     顺序逻辑，超时 2.5s 后按序回退：
     同版本缓存 → 成对旧版本（仅 HTML）→ 放弃。
  */

  try {
    const response = await fetchWithTimeout(request, SHELL_NETWORK_TIMEOUT);

    if (response && response.ok) {
      await cache.put(key, stampResponse(response));
      await pruneOldVersions(cache, path);
      return response;
    }
  } catch (error) {
    /* 超时或网络失败:走缓存回退 */
  }

  if (cached) {
    return cached;
  }

  /* HTML 导航且同路径存在旧版本条目:
     返回最近的一个"成对旧版本"(旧 HTML 配旧 JS,
     各自在自己的 ?v= 键下,不会混用)。 */
  if (!isScript) {
    const older = await newestOtherVersion(cache, path, key);

    if (older) {
      return older;
    }
  }

  /* 脚本没有对应版本缓存时:不做跨版本回退,
     交给 networkOnly(网络失败返回 504)。 */
  return networkOnly(request);
}

function fetchWithTimeout(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  return fetch(request, { signal: controller.signal }).finally(() => {
    clearTimeout(timer);
  });
}

async function networkOnly(request) {
  try {
    const response = await fetch(request);

    if (response && response.ok) {
      return response;
    }
  } catch (error) {
    /* 网络失败:无回退 */
  }

  return new Response("Shell cache expired", { status: 504 });
}

/* 同一路径下,除当前键外最新的一条旧版本缓存 */

async function newestOtherVersion(cache, path, excludeKey) {
  const keys = await cache.keys();
  const candidates = [];

  for (const key of keys) {
    const requestUrl = shellKeyToString(key);
    const url = new URL(requestUrl, self.location.origin);

    if (normalisePath(url.pathname) !== path) {
      continue;
    }

    const response = await cache.match(url);

    if (!response) {
      continue;
    }

    candidates.push({
      storedAt: Number(response.headers.get("x-shell-stored-at") || 0),
      response
    });
  }

  candidates.sort((left, right) => right.storedAt - left.storedAt);

  return candidates.length ? candidates[0].response : null;
}

/* 同一路径只保留最近 3 个版本 */

async function pruneOldVersions(cache, path) {
  const keys = await cache.keys();
  const versions = [];

  for (const key of keys) {
    const requestUrl = shellKeyToString(key);
    const url = new URL(requestUrl, self.location.origin);

    if (normalisePath(url.pathname) !== path) {
      continue;
    }

    const response = await cache.match(url);

    versions.push({
      key,
      storedAt: Number(response?.headers.get("x-shell-stored-at") || 0)
    });
  }

  if (versions.length <= SHELL_KEEP_VERSIONS) {
    return;
  }

  versions.sort((left, right) => right.storedAt - left.storedAt);

  for (const entry of versions.slice(SHELL_KEEP_VERSIONS)) {
    await cache.delete(entry.key);
  }
}

/* 给缓存条目打上写入时间戳 */

function shellKeyToString(key) {
  if (typeof key === "string") {
    return key;
  }

  if (typeof key.url === "string") {
    return key.url;
  }

  return String(key);
}

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
  if (event.data?.type === "WARM_ICON_CACHE") {
    const urls = Array.isArray(event.data.urls)
      ? [...new Set(event.data.urls)].slice(0, 300)
      : [];

    event.waitUntil(warmIconCache(urls));
    return;
  }

  /*
     验收辅助:在页面控制台执行
     navigator.serviceWorker.controller.postMessage({ type: "SHELL_STATS" })
     并监听 message 事件,可拿到缓存键列表与
     受控 client 的 frameType(nested = iframe 内受控)。
  */

  if (event.data?.type === "SHELL_STATS") {
    event.waitUntil((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const keys = await cache.keys();
      const clients = await self.clients.matchAll({ includeUncontrolled: true });

      event.source.postMessage({
        type: "SHELL_STATS",
        keys: keys.map(key => (shellKeyToString(key))),
        clients: clients.map(client => ({
          url: client.url.slice(0, 120),
          frameType: client.frameType
        }))
      });
    })());
  }
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
