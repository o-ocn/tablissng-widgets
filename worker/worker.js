const encoder = new TextEncoder();
const decoder = new TextDecoder();

let cachedInstallationToken = null;
let cachedInstallationTokenExpiresAt = 0;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const corsHeaders = buildCorsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      if (!isAllowedOrigin(origin, env)) {
        return json({ error: "Origin not allowed" }, 403, corsHeaders);
      }

      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return json(
        {
          ok: true,
          service: "tablissng-sync",
          version: 3,
        },
        200,
        corsHeaders,
      );
    }

    if (url.pathname !== "/sync") {
      return json({ error: "Not found" }, 404, corsHeaders);
    }

    if (!isAllowedOrigin(origin, env)) {
      return json({ error: "Origin not allowed" }, 403, corsHeaders);
    }

    if (!(await isAuthorised(request, env.SYNC_SECRET))) {
      return json({ error: "Unauthorised" }, 401, corsHeaders);
    }

    try {
      if (request.method === "GET") {
        const stored = await readEncryptedDocument(env);

        if (!stored) {
          return json(
            {
              version: 1,
              updatedAt: "",
              customSites: [],
              iconOverrides: {},
              revision: "",
            },
            200,
            corsHeaders,
          );
        }

        const document = await decryptDocument(stored.payload, env);

        return json(
          {
            ...document,
            revision: stored.sha,
          },
          200,
          corsHeaders,
          {
            ETag: `\"${stored.sha}\"`,
            "Cache-Control": "no-store",
          },
        );
      }

      if (request.method === "PUT" || request.method === "POST") {
        const contentLength = Number(request.headers.get("Content-Length") || 0);

        if (contentLength > 800_000) {
          return json({ error: "Payload too large" }, 413, corsHeaders);
        }

        const incoming = await request.json();

        /*
           版本 3 及以上的客户端必须携带 expectedRevision
           （它最后一次读取到的 GitHub 文件 SHA）。
           写入前重新读取云端当前 SHA，不一致时返回 409，
           绝不写入，绝不静默覆盖另一台设备的数据。

           版本 1 / 2 的旧页面没有版本概念，
           继续按旧流程处理，保持完全兼容。
        */

        const modelVersion = Number(incoming?.modelVersion || 1);

        if (modelVersion >= 3) {
          if (typeof incoming.expectedRevision !== "string") {
            return json(
              { error: "New sync clients must send expectedRevision" },
              400,
              corsHeaders,
            );
          }

          const outcome = await writeWithOptimisticLock(incoming, env);

          if (outcome.status === 409) {
            return json(
              {
                error: "Sync conflict: cloud was updated by another device",
                currentRevision: outcome.currentRevision || "",
              },
              409,
              corsHeaders,
              { "Cache-Control": "no-store" },
            );
          }

          return json(
            {
              ok: true,
              updatedAt: outcome.document.updatedAt,
              sha: outcome.sha,
              revision: outcome.sha,
            },
            200,
            corsHeaders,
            { "Cache-Control": "no-store" },
          );
        }

        const document = validateSyncDocument(incoming);
        const encrypted = await encryptDocument(document, env);
        const result = await writeEncryptedDocument(encrypted, env);

        return json(
          {
            ok: true,
            updatedAt: document.updatedAt,
            sha: result.sha,
            revision: result.sha,
          },
          200,
          corsHeaders,
          { "Cache-Control": "no-store" },
        );
      }

      return json({ error: "Method not allowed" }, 405, corsHeaders, {
        Allow: "GET, PUT, POST, OPTIONS",
      });
    } catch (error) {
      console.error(error);

      const status = Number(error?.status) || 500;
      const message =
        status >= 500 ? "Sync service failed" : error?.message || "Request failed";

      return json({ error: message }, status, corsHeaders);
    }
  },
};

function configuredOrigin(env) {
  return (env.ALLOWED_ORIGIN || "https://o-ocn.github.io").replace(/\/$/, "");
}

function isAllowedOrigin(origin, env) {
  return !origin || origin.replace(/\/$/, "") === configuredOrigin(env);
}

function buildCorsHeaders(origin, env) {
  const headers = {
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };

  if (origin && isAllowedOrigin(origin, env)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function json(body, status, baseHeaders = {}, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...baseHeaders,
      ...extraHeaders,
    },
  });
}

async function isAuthorised(request, expectedSecret) {
  if (!expectedSecret) {
    throw new Error("SYNC_SECRET is not configured");
  }

  const provided = (request.headers.get("Authorization") || "").replace(
    /^Bearer\s+/i,
    "",
  );

  const left = encoder.encode(provided);
  const right = encoder.encode(expectedSecret);

  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }

  return difference === 0;
}

function validateSyncDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw clientError("Invalid sync document");
  }

  if (!Array.isArray(value.customSites)) {
    throw clientError("customSites must be an array");
  }

  if (
    !value.iconOverrides ||
    typeof value.iconOverrides !== "object" ||
    Array.isArray(value.iconOverrides)
  ) {
    throw clientError("iconOverrides must be an object");
  }

  const modelVersion = Number(value.modelVersion || 1);
  const version = modelVersion >= 3 ? 3 : modelVersion >= 2 ? 2 : 1;

  const customSites = value.customSites.slice(0, 200).map((site) => {
    const entry = normaliseShortcutEntry(site);

    if (!entry) {
      throw clientError("Shortcut entry is incomplete");
    }

    if (version < 3) {
      const legacyEntry = { key: entry.key, label: entry.label, url: entry.url, groupId: entry.groupId, icon: entry.icon };

      return legacyEntry;
    }

    return entry;
  });

  const iconOverrides = {};

  for (const [key, icon] of Object.entries(value.iconOverrides).slice(0, 300)) {
    const safeKey = String(key).slice(0, 100);
    const safeIcon = String(icon || "");

    if (
      safeKey &&
      (safeIcon.startsWith("data:image/") || /^https:\/\//i.test(safeIcon))
    ) {
      iconOverrides[safeKey] = safeIcon.slice(0, 500_000);
    }
  }

  const document = {
    version,
    updatedAt: new Date().toISOString(),
    customSites,
    iconOverrides,
  };

  /*
     版本 3 才写入 groupOrder 与 trash。
     版本 1 / 2 的文档保持原有字段，
     绝不会被误标成新版。
  */

  if (version >= 3) {
    document.groupOrder = validateGroupOrder(value.groupOrder);
    document.trash = validateTrash(value.trash);
  }

  if (encoder.encode(JSON.stringify(document)).length > 750_000) {
    throw clientError("Sync data is too large");
  }

  return document;
}

function normaliseShortcutEntry(site) {
  if (!site || typeof site !== "object") {
    return null;
  }

  const key = String(site.key || "").slice(0, 100);
  const label = String(site.label || "").trim().slice(0, 50);
  const url = String(site.url || "").trim().slice(0, 2048);
  const groupId = String(site.groupId || "").slice(0, 50);
  const rawIcon = String(site.icon || "").trim();
  const icon = /^https:\/\//i.test(rawIcon) ? rawIcon.slice(0, 2048) : "";
  const updatedAt = normaliseTimestamp(site.updatedAt);

  if (!key || !label || !groupId || !/^https?:\/\//i.test(url)) {
    return null;
  }

  return { key, label, url, groupId, icon, updatedAt };
}

function normaliseTimestamp(value) {
  const text = typeof value === "string" ? value.slice(0, 40) : "";
  return text && !Number.isNaN(Date.parse(text)) ? text : "";
}

function validateGroupOrder(value) {
  const order = {};

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return order;
  }

  for (const [groupId, entry] of Object.entries(value).slice(0, 60)) {
    const safeGroupId = String(groupId).slice(0, 50);

    if (
      !safeGroupId ||
      !entry ||
      typeof entry !== "object" ||
      !Array.isArray(entry.items)
    ) {
      continue;
    }

    const items = [];

    for (const item of entry.items.slice(0, 60)) {
      const key = String(item || "").slice(0, 100);

      if (key && !items.includes(key)) {
        items.push(key);
      }
    }

    order[safeGroupId] = {
      items,
      updatedAt: normaliseTimestamp(entry.updatedAt),
    };
  }

  return order;
}

function validateTrash(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenKeys = new Set();
  const entries = [];

  for (const entry of value.slice(0, 200)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const key = String(entry.key || "").slice(0, 100);
    const label = String(entry.label || "").trim().slice(0, 50);
    const url = String(entry.url || "").trim().slice(0, 2048);
    const groupId = String(entry.groupId || "").slice(0, 50);
    const rawIcon = String(entry.icon || "").trim();
    const icon = /^https:\/\//i.test(rawIcon) ? rawIcon.slice(0, 2048) : "";
    const deletedAt = normaliseTimestamp(entry.deletedAt);
    const originalGroupId = String(entry.originalGroupId || groupId).slice(0, 50);
    const originalIndex = Number.isFinite(Number(entry.originalIndex))
      ? Math.max(0, Math.min(200, Number(entry.originalIndex)))
      : 0;

    if (!key || !label || !groupId || !/^https?:\/\//i.test(url) || !deletedAt) {
      continue;
    }

    if (seenKeys.has(key)) {
      continue;
    }

    seenKeys.add(key);

    entries.push({ key, label, url, groupId, icon, deletedAt, originalGroupId, originalIndex });
  }

  entries.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));

  return entries.slice(0, 100);
}

function clientError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

async function encryptDocument(document, env) {
  const key = await importEncryptionKey(env.DATA_ENCRYPTION_KEY);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(document)),
  );

  return {
    version: 1,
    algorithm: "AES-256-GCM",
    iv: toBase64(new Uint8Array(iv)),
    data: toBase64(new Uint8Array(encrypted)),
    updatedAt: document.updatedAt,
  };
}

async function decryptDocument(payload, env) {
  if (
    !payload ||
    payload.version !== 1 ||
    payload.algorithm !== "AES-256-GCM" ||
    typeof payload.iv !== "string" ||
    typeof payload.data !== "string"
  ) {
    throw new Error("Stored sync document is invalid");
  }

  const key = await importEncryptionKey(env.DATA_ENCRYPTION_KEY);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(payload.iv) },
    key,
    fromBase64(payload.data),
  );

  return JSON.parse(decoder.decode(decrypted));
}

async function importEncryptionKey(base64Key) {
  if (!base64Key) {
    throw new Error("DATA_ENCRYPTION_KEY is not configured");
  }

  const raw = fromBase64(base64Key);

  if (raw.byteLength !== 32) {
    throw new Error("DATA_ENCRYPTION_KEY must contain 32 bytes");
  }

  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function readEncryptedDocument(env) {
  const token = await getInstallationToken(env);
  const response = await githubFetch(contentUrl(env), token);

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw await githubError(response, "Unable to read sync data");
  }

  const file = await response.json();
  const text = decoder.decode(fromBase64(String(file.content || "").replace(/\s/g, "")));

  return {
    sha: file.sha,
    payload: JSON.parse(text),
  };
}

async function writeEncryptedDocument(payload, env) {
  const token = await getInstallationToken(env);
  const existing = await readFileMetadata(env, token);
  const body = {
    message: "Sync TablissNG shortcuts",
    content: toBase64(encoder.encode(`${JSON.stringify(payload, null, 2)}\n`)),
    branch: env.GITHUB_BRANCH || "main",
  };

  if (existing?.sha) {
    body.sha = existing.sha;
  }

  let response = await githubFetch(contentUrl(env, false), token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (response.status === 409) {
    const latest = await readFileMetadata(env, token);

    if (latest?.sha) {
      body.sha = latest.sha;
    }

    response = await githubFetch(contentUrl(env, false), token, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  if (!response.ok) {
    throw await githubError(response, "Unable to save sync data");
  }

  const result = await response.json();

  return { sha: result.content?.sha || "" };
}

/*
   版本 3 客户端的受保护写入：
   写入前重新读取 GitHub 当前 SHA，
   与客户端声明的 expectedRevision 不一致时
   返回 409 且不执行任何写入。
   GitHub 端再次返回 409（读取后被人抢先写入）
   时也不重试，直接让客户端重新合并。
*/

async function writeWithOptimisticLock(incoming, env) {
  const document = validateSyncDocument(incoming);
  const expectedRevision = String(incoming.expectedRevision || "");
  const token = await getInstallationToken(env);
  const current = await readFileMetadata(env, token);
  const currentRevision = current?.sha || "";

  if (currentRevision !== expectedRevision) {
    return { status: 409, currentRevision, document };
  }

  const encrypted = await encryptDocument(document, env);
  const body = {
    message: "Sync TablissNG shortcuts",
    content: toBase64(encoder.encode(`${JSON.stringify(encrypted, null, 2)}\n`)),
    branch: env.GITHUB_BRANCH || "main",
  };

  if (currentRevision) {
    body.sha = currentRevision;
  }

  const response = await githubFetch(contentUrl(env, false), token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (response.status === 409) {
    return { status: 409, currentRevision, document };
  }

  if (!response.ok) {
    throw await githubError(response, "Unable to save sync data");
  }

  const result = await response.json();

  return {
    status: 200,
    document,
    sha: result.content?.sha || "",
  };
}

async function readFileMetadata(env, token) {
  const response = await githubFetch(contentUrl(env), token);

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw await githubError(response, "Unable to inspect sync data");
  }

  return response.json();
}

function contentUrl(env, includeRef = true) {
  const owner = encodeURIComponent(env.GITHUB_OWNER || "o-ocn");
  const repo = encodeURIComponent(env.GITHUB_REPO || "tablissng-widgets");
  const path = String(env.GITHUB_DATA_PATH || "data/sync.enc.json")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const branch = encodeURIComponent(env.GITHUB_BRANCH || "main");

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  return includeRef ? `${url}?ref=${branch}` : url;
}

async function githubFetch(url, token, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "tablissng-sync-worker",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
}

async function githubError(response, fallbackMessage) {
  let detail = "";

  try {
    const body = await response.json();
    detail = body.message || "";
  } catch {
    detail = await response.text();
  }

  const error = new Error(detail ? `${fallbackMessage}: ${detail}` : fallbackMessage);
  error.status = response.status >= 400 && response.status < 500 ? 502 : 500;
  return error;
}

async function getInstallationToken(env) {
  if (
    cachedInstallationToken &&
    Date.now() < cachedInstallationTokenExpiresAt - 60_000
  ) {
    return cachedInstallationToken;
  }

  if (!env.GITHUB_APP_ID || !env.GITHUB_INSTALLATION_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("GitHub App credentials are not configured");
  }

  const jwt = await createGitHubAppJwt(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY);
  const response = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(env.GITHUB_INSTALLATION_ID)}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "User-Agent": "tablissng-sync-worker",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!response.ok) {
    throw await githubError(response, "Unable to create GitHub installation token");
  }

  const result = await response.json();
  cachedInstallationToken = result.token;
  cachedInstallationTokenExpiresAt = Date.parse(result.expires_at);

  return cachedInstallationToken;
}

async function createGitHubAppJwt(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = toBase64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = toBase64Url(
    encoder.encode(
      JSON.stringify({
        iat: now - 60,
        exp: now + 540,
        iss: String(appId),
      }),
    ),
  );
  const unsigned = `${header}.${payload}`;
  const key = await importGitHubPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    encoder.encode(unsigned),
  );

  return `${unsigned}.${toBase64Url(new Uint8Array(signature))}`;
}

async function importGitHubPrivateKey(pem) {
  const cleaned = String(pem).trim();
  const bytes = fromBase64(cleaned.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""));
  const pkcs8 = cleaned.includes("BEGIN RSA PRIVATE KEY")
    ? wrapPkcs1AsPkcs8(bytes)
    : bytes;

  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function wrapPkcs1AsPkcs8(pkcs1) {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaAlgorithmIdentifier = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ]);
  const privateKey = derNode(0x04, pkcs1);
  const body = concatBytes(version, rsaAlgorithmIdentifier, privateKey);

  return derNode(0x30, body);
}

function derNode(tag, value) {
  return concatBytes(new Uint8Array([tag]), derLength(value.length), value);
}

function derLength(length) {
  if (length < 128) {
    return new Uint8Array([length]);
  }

  const bytes = [];
  let remaining = length;

  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }

  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatBytes(...parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
}

function toBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function toBase64Url(bytes) {
  return toBase64(bytes).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
