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
const SHELL_NETWORK_TIMEOUT = 4000;
const SHELL_KEEP_VERSIONS = 3;

/*
   依赖同源 JS 的页面:回退到旧版本 HTML 时,
   必须确认配套版本(sync-model.js?v=N)的 JS 也在缓存
   且未超过 30 天,否则不成对、不回退。
   (当前项目里只有 shortcuts.html 引用 sync-model.js;
   search / index 无此依赖。)
*/

const JS_DEPENDENT_PAGE = "shortcuts.html";

/*
   记录"当前实际提供给页面的 HTML 版本"(回退发生时写入):
   页面随后请求 sync-model.js 时 referrer 仍带新版本参数,
   必须改用被实际回退到的版本来定位配套 JS,
   否则离线整页跑不起来。
   键 = 归一化 HTML 路径,值 = 版本号(如 "v17")。
   成功从网络取得新版本时移除。
*/

const servedFallback = new Map();

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

  return isNavigation || isHtml || isScript;
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

  /* 脚本:跟随所属 HTML 的版本(referrer 携带 ?v=)。
     若该 HTML 曾被回退到旧版本(servedFallback),
     JS 必须使用被实际提供的旧版本,离线整页才能运行。 */
  const isScript = request.destination === "script" || /\.js$/.test(url.pathname);

  if (isScript) {
    let version = referrerVersion(request);
    const referrerKey = referrerKeyOf(request);
    const referrerPath = referrerPathOf(request);

    if (referrerKey && servedFallback.has(referrerKey)) {
      version = servedFallback.get(referrerKey);
    } else if (!version && referrerPath && servedFallback.has(referrerPath)) {
      version = servedFallback.get(referrerPath);
    }

    const key = new URL(
      normalisePath(url.pathname) + (version ? `?v=${version}` : url.search),
      url.origin
    ).href;
    return shellReadThrough(request, event, cache, key, { isScript });
  }

  return shellReadThrough(request, event, cache, cacheKeyFor(url), { isScript: false });
}

/* referrer 指向的 HTML 归一化路径(无法解析时返回 "") */

function referrerPathOf(request) {
  try {
    if (!request.referrer || request.referrer === "about:client") {
      return "";
    }

    return normalisePath(new URL(request.referrer).pathname);
  } catch (error) {
    return "";
  }
}

/* referrer 指向的 HTML 完整版本化缓存键(无法解析时返回 "") */

function referrerKeyOf(request) {
  try {
    if (!request.referrer || request.referrer === "about:client") {
      return "";
    }

    return cacheKeyFor(new URL(request.referrer));
  } catch (error) {
    return "";
  }
}

async function shellReadThrough(request, event, cache, key, { isScript }) {
  const url = new URL(request.url);
  const path = normalisePath(url.pathname);

  let cached = await cache.match(key);
  let storedAt = cached
    ? Number(cached.headers.get("x-shell-stored-at") || 0)
    : 0;

  /*
     超过 30 天：条目直接作废（等同无缓存）。
     网络失败时宁可加载失败，也不运行
     可能不兼容当前同步协议的古老页面。
  */

  if (cached && Date.now() - storedAt > SHELL_HARD_AGE) {
    await cache.delete(key);
    cached = null;
    storedAt = 0;
  }

  const fresh = cached && Date.now() - storedAt < SHELL_FRESH_AGE;

  /*
     24 小时内：缓存优先（快路径）。
     版本更新由 ?v= 键变化触发：发布新版本时
     缓存键不同，必然走网络拉取。
  */

  if (fresh) {
    servedFallback.delete(key);
    return cached;
  }

  /*
     无缓存或已过期（24h~30d）：走网络。
     只发一次请求：
     - 存在可用回退（同版本缓存 / 成对旧版本）时，
       2.5s 超时中止本次请求并回退（不产生第二次下载）;
     - 没有回退时，不做超时中止、也不重试，
       让这唯一的请求自然完成（慢就慢，避免双重请求）。
  */

  const paired = !isScript
    ? await newestPairedVersion(cache, path, key, Date.now())
    : null;
  const hasFallback = !!cached || !!paired;

  let response = null;

  try {
    response = await fetchWithTimeout(
      request,
      hasFallback ? SHELL_NETWORK_TIMEOUT : 0
    );
  } catch (error) {
    /* 超时中止或网络失败:response 保持 null,走下方回退 */
  }

  if (response && response.ok) {
    await cache.put(key, stampResponse(response));
    await pruneOldVersions(cache, path);
    servedFallback.delete(key);
    servedFallback.delete(path);
    return response;
  }

  /* 网络失败或已中止：按序回退 */

  if (cached) {
    return cached;
  }

  if (paired) {
    /* 回退的旧 HTML 与其配套 JS 在各自 ?v= 键下成对存在,
       优先记录该请求特定 URL 键的版本映射(防止多标签并发不同版本时串扰),
       同时保留路径级备用映射,页面随后请求 JS 时配套使用。 */
    if (paired.version) {
      servedFallback.set(key, paired.version);
      servedFallback.set(path, paired.version);
    }

    /* 后台静默抓取最新版本并写入缓存，保证下次打开即可切换到最新版，避免永久卡在旧版回退 */
    if (event && typeof event.waitUntil === "function") {
      event.waitUntil(
        (async () => {
          try {
            const bgResponse = await fetch(request);
            if (bgResponse && bgResponse.ok) {
              await cache.put(key, stampResponse(bgResponse));
              await pruneOldVersions(cache, path);
              servedFallback.delete(key);
              servedFallback.delete(path);
            }
          } catch (e) {}
        })()
      );
    }

    return paired.response;
  }

  /* 没有任何缓存回退:如果请求已被超时中止,
     也要给出明确失败,不再发起第二次下载。 */
  return new Response("Shell cache unavailable", { status: 504 });
}

/* 单次网络请求;timeoutMs > 0 时超时中止,否则不设超时(仅这一次请求) */

function fetchWithTimeout(request, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) {
    return fetch(request);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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

/*
   在同一路径的历史版本里找"成对可用"的最新回退:

   - 条目本身不得超过 30 天;
   - 若该页面依赖同源 JS(JS_DEPENDENT_PAGE),
     配套版本(sync-model.js?v=N)必须也在缓存中
     且同样未超过 30 天 —— 缺一即不成对、不回退,
     避免只回退 HTML 却让页面脚本加载失败。
   - 不依赖 JS 的页面(search / index)无需配套。
*/

async function newestPairedVersion(cache, path, excludeKey, now) {
  const keys = await cache.keys();
  const candidates = [];

  for (const key of keys) {
    const keyUrl = shellKeyToString(key);
    const url = new URL(keyUrl, self.location.origin);

    if (normalisePath(url.pathname) !== path) {
      continue;
    }

    if (cacheKeyFor(url) === excludeKey) {
      continue;
    }

    const response = await cache.match(url);

    if (!response) {
      continue;
    }

    const storedAt = Number(response.headers.get("x-shell-stored-at") || 0);

    if (!storedAt || now - storedAt > SHELL_HARD_AGE) {
      /* 超过 30 天的历史版本顺手删除,与当前键的过期语义一致 */
      await cache.delete(url);
      continue; /* 超过 30 天的旧版本不成对 */
    }

    const file = url.pathname.split("/").pop();

    if (file === JS_DEPENDENT_PAGE) {
      const version = versionOf(url);

      if (!version) {
        continue; /* 无版本参数无法定位配套 JS */
      }

      const directory = normalisePath(url.pathname).replace(/[^/]*$/, "");
      const jsKey = new URL(`${directory}sync-model.js?v=${version}`, self.location.origin).href;
      const js = await cache.match(jsKey);
      const jsStoredAt = js ? Number(js.headers.get("x-shell-stored-at") || 0) : 0;

      if (!js || !jsStoredAt || now - jsStoredAt > SHELL_HARD_AGE) {
        continue; /* 缺配套 JS 或配套 JS 过旧:不成对 */
      }
    }

    candidates.push({
      storedAt,
      version: versionOf(url),
      response
    });
  }

  candidates.sort((left, right) => right.storedAt - left.storedAt);

  return candidates[0] || null;
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

      event.source?.postMessage({
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
