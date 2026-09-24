/*
   Worker 冲突保护测试（可重复，不访问真实网络）。

   用假的 GitHub Contents API 模拟云端文件，
   模拟两台设备（客户端 A / B）同时修改同一份数据：

   - 双方读取同一版本后先后上传 → 后者收到 409，
     云端数据不被覆盖
   - 409 响应携带最新 revision，重新读取后可安全上传
   - 版本 1 / 2 旧页面按旧格式继续工作，不会被误标为版本 3
   - 版本 3 文档的 groupOrder / trash 正确往返
   - 任何响应都不包含测试密钥内容

   运行：npm test
*/

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import worker from "../worker/worker.js";

const BASE_URL = "https://worker.example.com";

function makeEnv() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

  return {
    SYNC_SECRET: "test-sync-secret-not-real",
    DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    GITHUB_APP_ID: "12345",
    GITHUB_INSTALLATION_ID: "67890",
    GITHUB_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ALLOWED_ORIGIN: "https://o-ocn.github.io",
    GITHUB_OWNER: "o-ocn",
    GITHUB_REPO: "tablissng-widgets",
    GITHUB_BRANCH: "main",
    GITHUB_DATA_PATH: "data/sync.enc.json"
  };
}

/*
   假 GitHub：内存中的 sync.enc.json。

   githubState.file = { sha, content: base64 } | null
   githubState.putCalls 记录写入次数，用于断言
   “409 时绝不写入”。
*/

function makeGithubState() {
  return { file: null, putCalls: 0, lastPutBody: null };
}

function fakeGithubFetch(state) {
  return async function patchedFetch(url, options = {}) {
    const requestUrl = new URL(url);

    if (requestUrl.pathname.startsWith("/app/installations/")) {
      return new Response(
        JSON.stringify({
          token: "test-installation-token",
          expires_at: new Date(Date.now() + 3600_000).toISOString()
        }),
        { status: 201 }
      );
    }

    if (
      requestUrl.hostname !== "api.github.com"
      || !requestUrl.pathname.includes("/contents/data/sync.enc.json")
    ) {
      return new Response(JSON.stringify({ message: "Not found" }), { status: 404 });
    }

    const isWrite = options.method === "PUT";

    if (!isWrite) {
      if (!state.file) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }

      return new Response(
        JSON.stringify({
          sha: state.file.sha,
          content: state.file.content
        }),
        { status: 200 }
      );
    }

    state.putCalls += 1;
    state.lastPutBody = JSON.parse(options.body);

    const suppliedSha = state.lastPutBody.sha || "";

    if (state.file && suppliedSha !== state.file.sha) {
      return new Response(
        JSON.stringify({ message: `${suppliedSha} does not match ${state.file.sha}` }),
        { status: 409 }
      );
    }

    if (!state.file && !suppliedSha) {
      // 新建文件
    } else if (!state.file && suppliedSha) {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 409 });
    }

    const newSha = randomBytes(20).toString("hex");

    state.file = {
      sha: newSha,
      content: state.lastPutBody.content
    };

    return new Response(
      JSON.stringify({ content: { sha: newSha } }),
      { status: 200 }
    );
  };
}

async function callWorker(request, env, state, fetchImpl) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl || fakeGithubFetch(state);

  try {
    return await worker.fetch(request, env, { waitUntil() {} });
  } finally {
    globalThis.fetch = realFetch;
  }
}

function syncRequest(method, { token = "test-sync-secret-not-real", body, origin = "https://o-ocn.github.io" } = {}) {
  return new Request(`${BASE_URL}/sync`, {
    method,
    headers: {
      Origin: origin,
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

function v3Document(overrides = {}) {
  return {
    modelVersion: 3,
    customSites: [
      { key: "github", label: "GitHub", url: "https://github.com/", groupId: "home", icon: "", updatedAt: "2026-09-24T10:00:00.000Z" }
    ],
    iconOverrides: {},
    groupOrder: { home: { items: ["github"], updatedAt: "2026-09-24T10:00:00.000Z" } },
    trash: [],
    ...overrides
  };
}

async function readJson(response) {
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null, headers: response.headers };
}

test("空云端时 GET 返回空的旧版文档并带空 revision", async () => {
  const env = makeEnv();
  const state = makeGithubState();

  const response = await callWorker(syncRequest("GET"), env, state);
  const { status, body } = await readJson(response);

  assert.equal(status, 200);
  assert.equal(body.version, 1);
  assert.deepEqual(body.customSites, []);
  assert.equal(body.revision, "");
});

test("版本 3 客户端首次上传到空云端成功", async () => {
  const env = makeEnv();
  const state = makeGithubState();

  const response = await callWorker(
    syncRequest("PUT", { body: v3Document({ expectedRevision: "" }) }),
    env,
    state
  );
  const { status, body } = await readJson(response);

  assert.equal(status, 200);
  assert.ok(body.revision, "返回新的 revision");
  assert.equal(state.putCalls, 1);
  assert.ok(state.lastPutBody.sha === undefined || state.lastPutBody.sha === "", "空云端写入不带 sha");
});

test("版本 3 上传缺少 expectedRevision 时被拒绝", async () => {
  const env = makeEnv();
  const state = makeGithubState();

  const response = await callWorker(syncRequest("PUT", { body: v3Document() }), env, state);
  const { status } = await readJson(response);

  assert.equal(status, 400);
  assert.equal(state.putCalls, 0, "绝不写入");
});

test("两台模拟设备同时修改：后上传者收到 409，云端不被覆盖", async () => {
  const env = makeEnv();
  const state = makeGithubState();

  // 设备 B 先上传一份初始数据
  const first = await readJson(
    await callWorker(syncRequest("PUT", { body: v3Document({ expectedRevision: "" }) }), env, state)
  );
  assert.equal(first.status, 200);
  const revision1 = first.body.revision;

  // 设备 A 与设备 B 都读取到 revision1
  const getA = await readJson(await callWorker(syncRequest("GET"), env, state));
  assert.equal(getA.body.revision, revision1);

  // 设备 B 基于 revision1 修改并上传成功
  const bDocument = v3Document({
    expectedRevision: revision1,
    customSites: [
      { key: "github", label: "GitHub-B 修改", url: "https://github.com/", groupId: "home", icon: "", updatedAt: "2026-09-24T10:05:00.000Z" }
    ]
  });

  const putB = await readJson(await callWorker(syncRequest("PUT", { body: bDocument }), env, state));
  assert.equal(putB.status, 200);
  const revision2 = putB.body.revision;
  assert.notEqual(revision2, revision1);
  const putCallsAfterB = state.putCalls;

  // 设备 A 仍带着 revision1 上传 → 409，且不写入 GitHub
  const aDocument = v3Document({
    expectedRevision: revision1,
    customSites: [
      { key: "github", label: "GitHub-A 修改", url: "https://github.com/", groupId: "home", icon: "", updatedAt: "2026-09-24T10:06:00.000Z" }
    ]
  });

  const putA = await readJson(await callWorker(syncRequest("PUT", { body: aDocument }), env, state));

  assert.equal(putA.status, 409);
  assert.equal(putA.body.currentRevision, revision2, "409 响应携带云端最新 revision");
  assert.equal(state.putCalls, putCallsAfterB, "冲突时绝不发起 GitHub 写入");

  // 云端内容仍是 B 的数据，没有被 A 覆盖
  const after = await readJson(await callWorker(syncRequest("GET"), env, state));
  assert.equal(after.body.revision, revision2);
  assert.equal(after.body.customSites[0].label, "GitHub-B 修改");

  // 设备 A 重新读取后带着 revision2 上传 → 成功
  const aRetry = v3Document({
    expectedRevision: revision2,
    customSites: aDocument.customSites
  });

  const putARetry = await readJson(await callWorker(syncRequest("PUT", { body: aRetry }), env, state));
  assert.equal(putARetry.status, 200);
});

test("读取与写入之间被人抢先：GitHub 返回 409 时 Worker 不重试", async () => {
  const env = makeEnv();
  const state = makeGithubState();

  const first = await readJson(
    await callWorker(syncRequest("PUT", { body: v3Document({ expectedRevision: "" }) }), env, state)
  );
  const revision1 = first.body.revision;

  // 在 Worker 读取 SHA 之后、写入之前，直接篡改假 GitHub 的当前 SHA，
  // 模拟另一台设备恰好在间隙中写入。
  const baseFetch = fakeGithubFetch(state);

  const racingFetch = async (url, options) => {
    if (options?.method === "PUT") {
      state.file = { sha: "someone-else-wrote", content: state.file.content };
    }

    return baseFetch(url, options);
  };

  try {
    const response = await callWorker(
      syncRequest("PUT", { body: v3Document({ expectedRevision: revision1 }) }),
      env,
      state,
      racingFetch
    );
    const { status } = await readJson(response);

    assert.equal(status, 409, "写入间隙被抢先时返回 409");
  } finally {
    globalThis.fetch = baseFetch;
  }

  const after = await readJson(await callWorker(syncRequest("GET"), env, state));
  assert.equal(after.body.revision, "someone-else-wrote", "外部写入的数据保持原样");
});

test("旧版页面（版本 2）继续按旧格式工作，不被误标为版本 3", async () => {
  const env = makeEnv();
  const state = makeGithubState();

  const legacyDocument = {
    modelVersion: 2,
    customSites: [
      { key: "a", label: "A", url: "https://a.com/", groupId: "home", icon: "" }
    ],
    iconOverrides: {}
  };

  const response = await readJson(
    await callWorker(syncRequest("PUT", { body: legacyDocument }), env, state)
  );

  assert.equal(response.status, 200, "旧页面没有 expectedRevision 也能上传");

  const stored = await readJson(await callWorker(syncRequest("GET"), env, state));

  assert.equal(stored.body.version, 2, "版本必须保持 2");
  assert.equal(stored.body.customSites[0].key, "a");
  assert.ok(!("groupOrder" in stored.body), "旧格式不能混入新字段");
  assert.ok(!("trash" in stored.body), "旧格式不能混入新字段");
  assert.ok(!("updatedAt" in stored.body.customSites[0]), "旧格式条目不带 updatedAt");
});

test("没有 modelVersion 的最老客户端按版本 1 处理", async () => {
  const env = makeEnv();
  const state = makeGithubState();

  const oldest = {
    customSites: [
      { key: "a", label: "A", url: "https://a.com/", groupId: "home", icon: "" }
    ],
    iconOverrides: {}
  };

  const response = await readJson(
    await callWorker(syncRequest("PUT", { body: oldest }), env, state)
  );

  assert.equal(response.status, 200);

  const stored = await readJson(await callWorker(syncRequest("GET"), env, state));

  assert.equal(stored.body.version, 1);
  assert.ok(!("groupOrder" in stored.body));
});

test("版本 3 文档的 groupOrder 与 trash 正确往返", async () => {
  const env = makeEnv();
  const state = makeGithubState();

  const document = v3Document({
    expectedRevision: "",
    trash: [
      {
        key: "removed",
        label: "已删除",
        url: "https://removed.example.com/",
        groupId: "home",
        icon: "",
        deletedAt: "2026-09-24T09:00:00.000Z",
        originalGroupId: "home",
        originalIndex: 2
      }
    ]
  });

  const put = await readJson(await callWorker(syncRequest("PUT", { body: document }), env, state));
  assert.equal(put.status, 200);

  const get = await readJson(await callWorker(syncRequest("GET"), env, state));

  assert.equal(get.body.version, 3);
  assert.equal(get.body.trash.length, 1);
  assert.equal(get.body.trash[0].key, "removed");
  assert.equal(get.body.trash[0].originalIndex, 2);
  assert.deepEqual(get.body.groupOrder.home.items, ["github"]);
  assert.ok(get.body.customSites[0].updatedAt);
  assert.equal(get.headers.get("etag"), `"${get.body.revision}"`);
});

test("任何响应都不包含同步口令、加密密钥或 GitHub 私钥内容", async () => {
  const env = makeEnv();
  const state = makeGithubState();

  const secrets = [
    env.SYNC_SECRET,
    env.DATA_ENCRYPTION_KEY,
    env.GITHUB_PRIVATE_KEY,
    "PRIVATE KEY"
  ];

  const responses = [];

  responses.push(await callWorker(syncRequest("GET"), env, state));
  responses.push(
    await callWorker(syncRequest("PUT", { body: v3Document({ expectedRevision: "" }) }), env, state)
  );
  responses.push(await callWorker(syncRequest("PUT", { body: { modelVersion: 3 } }), env, state));
  responses.push(await callWorker(syncRequest("PUT", { body: "not-an-object" }), env, state));
  responses.push(await callWorker(syncRequest("GET", { token: "wrong-token" }), env, state));
  responses.push(await callWorker(syncRequest("GET", { origin: "https://evil.example.com" }), env, state));

  for (const response of responses) {
    const text = await response.clone().text();

    for (const secret of secrets) {
      assert.ok(!text.includes(secret), "响应泄漏了敏感内容");
    }
  }
});

test("非法上传被拒绝且不写入", async () => {
  const env = makeEnv();
  const state = makeGithubState();

  const badDocuments = [
    v3Document({ expectedRevision: "", customSites: [{ key: "x", label: "", url: "https://x.com/", groupId: "g", icon: "" }] }),
    v3Document({ expectedRevision: "", customSites: "not-an-array" }),
    v3Document({ expectedRevision: "", iconOverrides: [] })
  ];

  for (const body of badDocuments) {
    const { status } = await readJson(await callWorker(syncRequest("PUT", { body }), env, state));
    assert.equal(status, 400);
  }

  assert.equal(state.putCalls, 0);
});
