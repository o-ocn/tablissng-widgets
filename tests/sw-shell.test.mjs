/*
   sw.js 外壳缓存策略测试(v2:版本配套,mock Service Worker 环境)。

   覆盖审核要求的场景:

   1. VPS iframe 的目录首页导航(/tablissng-widgets/?v=7)
      被归一化为 index.html 并缓存(请求模拟 iframe 导航)
   2. 版本配套:v18 的 HTML 只配 v18 的 sync-model.js;
      回退到旧版本时整对回退;不发生"新 HTML + 旧 JS"混用
   3. 新鲜度语义:24h 内缓存优先;24h~30d 网络优先可回退;
      超过 30d 条目删除、不再回退(504)
   4. activate 清理旧版本缓存
   5. 跨域请求不进入外壳缓存
   6. 同一路径版本数量上限

   运行:npm test
*/

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SW_SOURCE = readFileSync(new URL("../sw.js", import.meta.url), "utf8");

const ORIGIN = "https://o-ocn.github.io";
const SCOPE = ORIGIN + "/tablissng-widgets/";

function makeResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
}

/*
   加载 sw.js:mock self(含 registration.scope 与 clients.claim)、
   mock caches 与 fetch,捕获事件监听器。
*/

function loadServiceWorker({ fetchImpl }) {
  const listeners = new Map();
  const cachesMap = new Map();

  cachesMap.set("tablissng-runtime-v2", new Map());
  cachesMap.set("tablissng-shell-v2", new Map());

  const sandbox = {
    self: {
      location: { origin: ORIGIN },
      registration: { scope: SCOPE },
      clients: {
        async claim() {},
        async matchAll() {
          return [];
        }
      },
      addEventListener(type, handler) {
        listeners.set(type, handler);
      }
    },
    caches: {
      async open(name) {
        if (!cachesMap.has(name)) {
          cachesMap.set(name, new Map());
        }
        const store = cachesMap.get(name);
        return {
          async match(key) {
            const resolved = typeof key === "string" ? key : String(key);
            return store.get(resolved) || undefined;
          },
          async put(key, response) {
            store.set(typeof key === "string" ? key : String(key), response);
          },
          async delete(key) {
            return store.delete(typeof key === "string" ? key : String(key));
          },
          async keys() {
            return [...store.keys()];
          }
        };
      },
      async keys() {
        return [...cachesMap.keys()];
      },
      async delete(name) {
        return cachesMap.delete(name);
      }
    },
    fetch: fetchImpl,
    Request,
    Response,
    Headers,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    console
  };

  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox, { filename: "sw.js" });

  return {
    listeners,
    cachesMap,
    dispatch(type, event) {
      const handler = listeners.get(type);
      if (!handler) {
        throw new Error(`no listener for ${type}`);
      }
      return handler(event);
    }
  };
}

/* 模拟 iframe 导航 / 脚本请求 */

function fakeRequest(url, { destination = "document", referrer = "" } = {}) {
  return {
    url,
    method: "GET",
    mode: destination === "document" ? "navigate" : destination,
    destination,
    referrer
  };
}

function makeFetchEvent(request) {
  const event = {
    waitUntilCalls: [],
    respondWith(promise) {
      event.responded = promise;
    },
    request,
    waitUntil(promise) {
      event.waitUntilCalls.push(promise);
    }
  };
  return event;
}

async function dispatchFetch(sw, request) {
  const event = makeFetchEvent(request);
  sw.dispatch("fetch", event);
  const response = await event.responded;

  /* fetchWithTimeout 的 abort 由 mock 处理,这里限时等待已 settle 的任务 */
  await Promise.race([
    Promise.allSettled(event.waitUntilCalls),
    new Promise(resolve => setTimeout(resolve, 100))
  ]);

  return response;
}

const SHELL_HTML = "<html><body>shell v17</body></html>";

test("sw: VPS 目录首页导航(/tablissng-widgets/?v=7)被归一化并缓存为 index.html", async () => {
  const sw = loadServiceWorker({
    fetchImpl: async () => makeResponse("<html>vps</html>")
  });

  const request = fakeRequest(`${SCOPE}?v=7`); // iframe 导航,目录根
  const response = await dispatchFetch(sw, request);

  assert.equal(response.status, 200);

  const shellStore = sw.cachesMap.get("tablissng-shell-v2");
  const cached = shellStore.get(`${SCOPE}index.html?v=7`);

  assert.ok(cached, "目录首页必须以归一化路径 + ?v= 为键写入缓存");
  assert.ok(Number(cached.headers.get("x-shell-stored-at")) > 0);
});

test("sw: 无缓存 + 网络成功 → 返回网络响应并写入带时间戳的缓存", async () => {
  const sw = loadServiceWorker({
    fetchImpl: async () => makeResponse(SHELL_HTML)
  });

  const response = await dispatchFetch(
    sw,
    fakeRequest(`${SCOPE}shortcuts.html?v=17`)
  );

  assert.equal(await response.text(), SHELL_HTML);

  const shellStore = sw.cachesMap.get("tablissng-shell-v2");
  assert.ok(shellStore.get(`${SCOPE}shortcuts.html?v=17`));
});

test("sw: 新鲜缓存 → 立即返回缓存,24h 内不重复拉网", async () => {
  let fetchCount = 0;

  const sw = loadServiceWorker({
    fetchImpl: async () => {
      fetchCount += 1;
      return makeResponse(SHELL_HTML);
    }
  });

  const shellStore = sw.cachesMap.get("tablissng-shell-v2");
  shellStore.set(
    `${SCOPE}shortcuts.html?v=17`,
    makeResponse(SHELL_HTML, { headers: { "x-shell-stored-at": String(Date.now()) } })
  );

  const response = await dispatchFetch(
    sw,
    fakeRequest(`${SCOPE}shortcuts.html?v=17`)
  );

  assert.equal(await response.text(), SHELL_HTML, "新鲜缓存必须立即返回");
  assert.equal(fetchCount, 0, "24h 内缓存优先,不重复拉网(更新发生在过期或版本变化时)");
});

test("sw: 版本配套 —— v18 的 HTML 请求 v18 的 sync-model.js,不与 v17 混用", async () => {
  const sw = loadServiceWorker({
    fetchImpl: async request => {
      const url = new URL(request.url);

      if (url.pathname.endsWith("shortcuts.html")) {
        return makeResponse("<html>v18 html</html>");
      }

      if (url.pathname.endsWith("sync-model.js")) {
        return makeResponse("const V18 = true;");
      }

      return makeResponse("other");
    }
  });

  const shellStore = sw.cachesMap.get("tablissng-shell-v2");

  // 预置 v17 的成对缓存(旧版本,已过新鲜期)
  const staleTs = String(Date.now() - 25 * 24 * 60 * 60 * 1000);
  shellStore.set(`${SCOPE}shortcuts.html?v=17`, makeResponse("<html>v17 html</html>", { headers: { "x-shell-stored-at": staleTs } }));
  shellStore.set(`${SCOPE}sync-model.js?v=17`, makeResponse("const V17 = true;", { headers: { "x-shell-stored-at": staleTs } }));

  // 1. v18 导航(该版本缓存缺失)→ 网络 → 返回 v18 HTML 并写入 v18 键
  const htmlResponse = await dispatchFetch(
    sw,
    fakeRequest(`${SCOPE}shortcuts.html?v=18`)
  );

  assert.equal(await htmlResponse.text(), "<html>v18 html</html>");
  assert.ok(shellStore.get(`${SCOPE}shortcuts.html?v=18`));

  // 2. v18 页面发起的 sync-model.js 请求(referrer 带 v=18)
  //    → 存入 sync-model.js?v=18,返回 v18 的 JS
  const jsResponse = await dispatchFetch(
    sw,
    fakeRequest(`${SCOPE}sync-model.js`, {
      destination: "script",
      referrer: `${SCOPE}shortcuts.html?v=18`
    })
  );

  assert.equal(await jsResponse.text(), "const V18 = true;");
  assert.ok(shellStore.get(`${SCOPE}sync-model.js?v=18`), "v18 的 JS 必须在自己的版本键下");
  assert.equal(
    await (await shellStore.get(`${SCOPE}sync-model.js?v=17`)).text(),
    "const V17 = true;",
    "v17 的 JS 保留在自己的键下"
  );
});

test("sw: 新版本 JS 缺失且网络失败 → 返回 504,不允许旧版本 JS 顶替", async () => {
  const sw = loadServiceWorker({
    fetchImpl: () => Promise.reject(new Error("network down"))
  });

  const store = sw.cachesMap.get("tablissng-shell-v2");
  store.set(`${SCOPE}shortcuts.html?v=19`, makeResponse("<html>v19 html</html>", { headers: { "x-shell-stored-at": String(Date.now()) } }));
  store.set(`${SCOPE}sync-model.js?v=17`, makeResponse("const V17 = true;", { headers: { "x-shell-stored-at": String(Date.now()) } }));

  // v19 页面请求 JS(referrer v=19):缓存里只有 v17 的 JS
  // → 必须走网络,失败返回 504,而不是拿 v17 顶替(防止新旧混用)
  const response = await dispatchFetch(
    sw,
    fakeRequest(`${SCOPE}sync-model.js`, {
      destination: "script",
      referrer: `${SCOPE}shortcuts.html?v=19`
    })
  );

  assert.equal(response.status, 504, "不混用:缺失版本的 JS 走网络,失败返回 504 而非旧版本顶替");
});

test("sw: 新版本导航网络失败 → 回退成对的旧版本", async () => {
  let fail = false;

  const sw = loadServiceWorker({
    fetchImpl: async request => {
      if (fail) {
        return Promise.reject(new Error("network down"));
      }

      const url = new URL(request.url);
      return makeResponse(`<html>${url.search}</html>`);
    }
  });

  const shellStore = sw.cachesMap.get("tablissng-shell-v2");

  // 预置 v17 成对缓存(已过 24h 新鲜期、未超 30 天硬限):
  // 这样 v18 导航走网络成功,而不是缓存优先返回 v17
  const staleTs = String(Date.now() - 25 * 24 * 60 * 60 * 1000);
  shellStore.set(`${SCOPE}shortcuts.html?v=17`, makeResponse("<html>v17 html</html>", { headers: { "x-shell-stored-at": staleTs } }));
  shellStore.set(`${SCOPE}sync-model.js?v=17`, makeResponse("const V17 = true;", { headers: { "x-shell-stored-at": staleTs } }));

  // v18 导航成功 → v18 入缓存
  const ok = await dispatchFetch(sw, fakeRequest(`${SCOPE}shortcuts.html?v=18`));
  assert.equal(await ok.text(), "<html>?v=18</html>");

  // 网络开始失败;v19 导航失败 → 回退最近旧版本(v18,成对可用)
  fail = true;

  const fallback = await dispatchFetch(sw, fakeRequest(`${SCOPE}shortcuts.html?v=19`));
  assert.equal(await fallback.text(), "<html>?v=18</html>", "网络失败时回退最近的成功版本,成对可用");
});

test("sw: 24h~30d 陈旧条目 → 网络超时后回退同版本缓存", async () => {
  const sw = loadServiceWorker({
    fetchImpl: (request, init) => new Promise((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
    })
  });

  const staleAge = Date.now() - 25 * 24 * 60 * 60 * 1000; // 25 天
  const shellStore = sw.cachesMap.get("tablissng-shell-v2");
  shellStore.set(
    `${SCOPE}shortcuts.html?v=17`,
    makeResponse(SHELL_HTML, { headers: { "x-shell-stored-at": String(staleAge) } })
  );

  const response = await dispatchFetch(sw, fakeRequest(`${SCOPE}shortcuts.html?v=17`));

  assert.equal(await response.text(), SHELL_HTML, "24h~30d 之间网络超时必须回退同版本缓存");
});

test("sw: 超过 30 天的条目被删除,网络失败时不再回退(504)", async () => {
  const sw = loadServiceWorker({
    fetchImpl: () => Promise.reject(new Error("network down"))
  });

  const ancientAge = Date.now() - 31 * 24 * 60 * 60 * 1000; // 31 天
  const shellStore = sw.cachesMap.get("tablissng-shell-v2");
  shellStore.set(
    `${SCOPE}shortcuts.html?v=17`,
    makeResponse(SHELL_HTML, { headers: { "x-shell-stored-at": String(ancientAge) } })
  );

  const response = await dispatchFetch(sw, fakeRequest(`${SCOPE}shortcuts.html?v=17`));

  assert.equal(response.status, 504, "超过 30 天不允许回退,防止过旧页面运行不兼容的同步逻辑");
  assert.ok(!shellStore.has(`${SCOPE}shortcuts.html?v=17`), "过期条目必须删除");
});

test("sw: activate 清理旧版本缓存,保留图标与外壳缓存", async () => {
  const sw = loadServiceWorker({ fetchImpl: async () => makeResponse("x") });

  sw.cachesMap.set("tablissng-runtime-v1", new Map());
  sw.cachesMap.set("tablissng-shell-v1", new Map());

  const waitUntilCalls = [];
  const event = {
    waitUntil(promise) {
      waitUntilCalls.push(promise);
    }
  };

  sw.dispatch("activate", event);
  await Promise.all(waitUntilCalls);

  assert.ok(!sw.cachesMap.has("tablissng-runtime-v1"), "旧图标缓存必须清理");
  assert.ok(!sw.cachesMap.has("tablissng-shell-v1"), "旧外壳缓存必须清理");
  assert.ok(sw.cachesMap.has("tablissng-runtime-v2"), "当前图标缓存保留");
  assert.ok(sw.cachesMap.has("tablissng-shell-v2"), "当前外壳缓存保留");
});

test("sw: 跨域请求不进入外壳缓存;同源 JS 按版本键进入", async () => {
  const sw = loadServiceWorker({
    fetchImpl: async () => makeResponse("data")
  });

  const shellStore = sw.cachesMap.get("tablissng-shell-v2");

  const crossOriginEvent = makeFetchEvent(
    fakeRequest("https://tablissng-sync.example.workers.dev/sync", { destination: "cors" })
  );
  sw.dispatch("fetch", crossOriginEvent);

  const scriptEvent = makeFetchEvent(
    fakeRequest(`${SCOPE}sync-model.js`, {
      destination: "script",
      referrer: `${SCOPE}shortcuts.html?v=17`
    })
  );
  sw.dispatch("fetch", scriptEvent);
  await scriptEvent.responded;

  assert.equal(
    [...shellStore.keys()].filter(key => key.includes("workers.dev")).length,
    0,
    "跨域请求不得进入外壳缓存"
  );
  assert.ok(shellStore.has(`${SCOPE}sync-model.js?v=17`), "同源 JS 按版本键进入外壳缓存");
});

test("sw: 同一路径超过 3 个版本时只保留最近 3 个", async () => {
  const sw = loadServiceWorker({
    fetchImpl: async request => {
      const url = new URL(request.url);
      return makeResponse(`<html>${url.search}</html>`);
    }
  });

  const shellStore = sw.cachesMap.get("tablissng-shell-v2");

  const versions = ["v14", "v15", "v16", "v17"];

  for (const v of versions) {
    shellStore.set(
      `${SCOPE}shortcuts.html?${v}`,
      makeResponse(`<html>${v}</html>`, {
        headers: { "x-shell-stored-at": String(Date.parse(`2026-09-${10 + versions.indexOf(v)}T00:00:00Z`)) }
      })
    );
  }

  await dispatchFetch(sw, fakeRequest(`${SCOPE}shortcuts.html?v=18`));

  const keys = [...shellStore.keys()].filter(key => key.includes("shortcuts.html"));
  assert.equal(keys.length, 3, "只保留最近 3 个版本");
  assert.ok(keys.includes(`${SCOPE}shortcuts.html?v=18`), "最新版本保留");
  assert.ok(!keys.includes(`${SCOPE}shortcuts.html?v=14`), "最旧版本被清理");
});
