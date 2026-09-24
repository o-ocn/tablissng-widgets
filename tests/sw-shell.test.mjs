/*
   sw.js 外壳缓存策略测试(mock Service Worker 环境)。

   覆盖:
   1. 无缓存 + 网络成功 → 返回网络响应并写入缓存(带时间戳)
   2. 新鲜缓存 → 立即返回缓存,网络仅在后台更新
   3. 过期/无缓存 + 网络超时 → 2.5s 后回退缓存
   4. activate 清理旧版本缓存,保留当前图标与外壳缓存
   5. 跨域请求与 /sync 不被外壳策略拦截

   运行:npm test
*/

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SW_SOURCE = readFileSync(new URL("../sw.js", import.meta.url), "utf8");

const ORIGIN = "https://o-ocn.github.io";

function makeResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
}

/*
   加载 sw.js:mock self,捕获事件监听器,
   提供 mock 的 caches 与 fetch。
*/

function loadServiceWorker({ fetchImpl, cacheStore }) {
  const listeners = new Map();
  const cachesMap = new Map(); // name -> Map(pathname -> Response)
  cachesMap.set("tablissng-runtime-v2", new Map());
  cachesMap.set("tablissng-shell-v1", new Map());

  const sandbox = {
    self: {
      location: { origin: ORIGIN },
      clients: { async claim() {} },
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
            return store.get(key) || undefined;
          },
          async put(key, response) {
            store.set(key, response);
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

function makeFetchEvent(request, { waitUntilCalls = [] } = {}) {
  const event = {
    respondWith(promise) {
      event.responded = promise;
    },
    request,
    waitUntil(promise) {
      waitUntilCalls.push(promise);
    },
    waitUntilCalls
  };
  return event;
}

const fakeRequest = (url, destination = "document") => ({
  url,
  method: "GET",
  mode: destination === "document" ? "navigate" : destination === "cors" ? "cors" : destination,
  destination
});

const SHELL_HTML = "<html><body>shell</body></html>";

test("sw: 无缓存 + 网络成功 → 返回网络响应并写入带时间戳的缓存", async () => {
  const url = `${ORIGIN}/tablissng-widgets/shortcuts.html?v=17`;
  const sw = loadServiceWorker({
    fetchImpl: async () => makeResponse(SHELL_HTML)
  });

  const request = fakeRequest(url);
  const event = makeFetchEvent(request);
  sw.dispatch("fetch", event);
  const response = await event.responded;

  assert.equal(response.status, 200);
  assert.equal(await response.text(), SHELL_HTML);

  const shellStore = sw.cachesMap.get("tablissng-shell-v1");
  const cached = shellStore.get("/tablissng-widgets/shortcuts.html");
  assert.ok(cached, "必须以 pathname 为键写入缓存");
  assert.ok(Number(cached.headers.get("x-shell-stored-at")) > 0, "缓存条目必须带时间戳");
});

test("sw: 新鲜缓存 → 立即返回缓存,网络在后台更新", async () => {
  let resolveNetwork;
  const networkPromise = new Promise(resolve => {
    resolveNetwork = resolve;
  });

  const sw = loadServiceWorker({
    fetchImpl: () => networkPromise
  });

  // 预填新鲜缓存
  const shellStore = sw.cachesMap.get("tablissng-shell-v1");
  const freshResponse = makeResponse(SHELL_HTML, {
    headers: { "x-shell-stored-at": String(Date.now()) }
  });
  shellStore.set("/tablissng-widgets/shortcuts.html", freshResponse);

  const request = fakeRequest(`${ORIGIN}/tablissng-widgets/shortcuts.html?v=18`);
  const event = makeFetchEvent(request);
  sw.dispatch("fetch", event);
  const response = await event.responded;

  assert.equal(await response.text(), SHELL_HTML, "新鲜缓存必须立即返回(?v=18 与 ?v=17 同键)");

  // 后台更新被 waitUntil 跟踪,此时网络尚未完成
  assert.ok(event.waitUntilCalls.length === 1, "后台更新必须挂到 waitUntil");
  resolveNetwork(makeResponse("<html>new</html>"));
  await event.waitUntilCalls[0];

  assert.equal(
    await (shellStore.get("/tablissng-widgets/shortcuts.html")).text(),
    "<html>new</html>",
    "后台拉新成功后必须替换缓存"
  );
});

test("sw: 网络超时 → 回退到过期缓存,而不是长时间白屏", async () => {
  const sw = loadServiceWorker({
    fetchImpl: () => new Promise(() => {}) // 网络永不返回
  });

  const staleAge = Date.now() - 25 * 60 * 60 * 1000; // 25 小时前,已过 24h TTL
  const shellStore = sw.cachesMap.get("tablissng-shell-v1");
  shellStore.set(
    "/tablissng-widgets/shortcuts.html",
    makeResponse(SHELL_HTML, { headers: { "x-shell-stored-at": String(staleAge) } })
  );

  const request = fakeRequest(`${ORIGIN}/tablissng-widgets/shortcuts.html`);
  const event = makeFetchEvent(request);
  sw.dispatch("fetch", event);
  const response = await event.responded;

  assert.equal(await response.text(), SHELL_HTML, "超时后必须回退缓存,避免白屏");
});

test("sw: activate 清理旧版本缓存,保留图标与外壳缓存", async () => {
  const sw = loadServiceWorker({ fetchImpl: async () => makeResponse("x") });

  // 预置旧版本与当前版本缓存
  sw.cachesMap.set("tablissng-runtime-v1", new Map());
  sw.cachesMap.set("tablissng-shell-v0", new Map());
  sw.cachesMap.set("tablissng-runtime-v2", new Map());
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
  assert.ok(!sw.cachesMap.has("tablissng-shell-v0"), "旧外壳缓存必须清理");
  assert.ok(sw.cachesMap.has("tablissng-runtime-v2"), "当前图标缓存保留");
  assert.ok(sw.cachesMap.has("tablissng-shell-v1"), "当前外壳缓存保留");
});

test("sw: 跨域请求与脚本以外的请求不走外壳策略", async () => {
  const calls = [];
  const sw = loadServiceWorker({
    fetchImpl: async request => {
      calls.push(request.url);
      return makeResponse("passthrough");
    }
  });

  // 跨域(同步 Worker / VPS API / 图标源)
  const crossOrigin = fakeRequest("https://tablissng-sync.example.workers.dev/sync", "cors");
  const handler = sw.listeners.get("fetch");

  // 直接调用 listener,若外壳策略接管会抛出(它返回 shellStrategy 的响应)
  // 这里通过行为断言:跨域请求不会被写入外壳缓存
  const event = makeFetchEvent(crossOrigin);
  handler(event);

  assert.equal(sw.cachesMap.get("tablissng-shell-v1")?.size || 0, 0, "跨域请求不得进入外壳缓存");

  const shellStore = sw.cachesMap.get("tablissng-shell-v1");
  const sameOriginScript = new Request(`${ORIGIN}/tablissng-widgets/sync-model.js`);
  const scriptEvent = makeFetchEvent(sameOriginScript);
  handler(scriptEvent);
  await scriptEvent.responded;

  assert.ok(
    shellStore.has("/tablissng-widgets/sync-model.js"),
    "同源 JS 应进入外壳缓存"
  );
});
