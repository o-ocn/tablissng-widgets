/*
   同步数据模型测试（可重复，不依赖网络）。

   覆盖：
   - 版本 1 / 2 → 3 的迁移（不误判删除）
   - 两台设备同时修改不同快捷方式
   - 两台设备同时修改同一快捷方式
   - 两台设备同时调整不同分组的排序
   - 删除与另一台设备编辑的冲突
   - 相同更新时间无法判定时的冲突上报
   - 回收站保留规则（100 条 / 30 天）

   运行：npm test
*/

import test from "node:test";
import assert from "node:assert/strict";
import TablissSyncModel from "../sync-model.js";

const {
  SITE_MODEL_VERSION,
  TRASH_MAX_ENTRIES,
  TRASH_RETENTION_DAYS,
  normaliseV3Document,
  upgradeSitesToV3,
  upgradeCustomSitesToV3,
  mergeSyncDocuments,
  applyConflictStrategy,
  pruneTrashEntries
} = TablissSyncModel;

const BASE = Date.parse("2026-09-24T12:00:00.000Z");

function at(minutesAgo) {
  return new Date(BASE - minutesAgo * 60_000).toISOString();
}

function site(key, label, groupId, updatedAt, icon = "") {
  return { key, label, url: `https://${key}.example.com/`, groupId, icon, updatedAt };
}

function dead(key, label, groupId, deletedAt, index = 0) {
  return {
    key,
    label,
    url: `https://${key}.example.com/`,
    groupId,
    icon: "",
    deletedAt,
    originalGroupId: groupId,
    originalIndex: index
  };
}

function doc({ sites = [], overrides = {}, order = {}, trash = [], updatedAt = at(1) } = {}) {
  return {
    version: SITE_MODEL_VERSION,
    updatedAt,
    customSites: sites,
    iconOverrides: overrides,
    groupOrder: order,
    trash
  };
}

test("模型版本是 3", () => {
  assert.equal(SITE_MODEL_VERSION, 3);
});

test("版本 2 文档升级到 3：补更新时间、建排序、回收站为空", () => {
  const legacy = {
    version: 2,
    updatedAt: at(30),
    customSites: [
      { key: "github", label: "GitHub", url: "https://github.com/", groupId: "home", icon: "" },
      { key: "custom-1", label: "自建站", url: "https://example.org/", groupId: "home", icon: "" }
    ],
    iconOverrides: {}
  };

  const upgraded = normaliseV3Document(legacy, { now: BASE });

  assert.equal(upgraded.version, 3);
  assert.equal(upgraded.customSites.length, 2, "现有快捷方式不能丢");
  assert.equal(upgraded.trash.length, 0, "迁移绝不产生删除记录");
  assert.ok(upgraded.customSites.every(entry => entry.updatedAt));
  assert.equal(upgraded.groupOrder.home.items.join(","), "github,custom-1");
  assert.equal(upgraded.groupOrder.home.updatedAt, at(30));
});

test("版本 1 文档升级到 3 同样安全", () => {
  const legacy = {
    version: 1,
    updatedAt: at(90),
    customSites: [{ key: "a", label: "A", url: "https://a.com/", groupId: "tools", icon: "" }],
    iconOverrides: {}
  };

  const upgraded = normaliseV3Document(legacy, { now: BASE });

  assert.equal(upgraded.customSites.length, 1);
  assert.equal(upgraded.trash.length, 0);
  assert.equal(upgraded.groupOrder.tools.items[0], "a");
});

test("upgradeSitesToV3 使用同一时间戳补齐缺失的 updatedAt", () => {
  const { sites } = upgradeSitesToV3(
    [site("a", "A", "home", ""), site("b", "B", "home", at(10))],
    { timestamp: at(20) }
  );

  assert.equal(sites[0].updatedAt, at(20));
  assert.equal(sites[1].updatedAt, at(10), "已有时间戳必须保留");
});

/* ========================================
   P1 回归：v2 → v3 升级绝不重置用户修改

   v2 已是统一管理的数据结构，
   预设同样可编辑、可移动、可删除。
   升级时 customSites 是权威数据，
   只补 v3 字段，绝不重新并入预设。
   ======================================== */

const V2_PRESETS = [
  site("github", "GitHub", "home", ""),
  site("gmail", "Gmail", "mail", ""),
  site("bilibili", "哔哩哔哩", "media", "")
];

test("P1: v2 修改过预设名称，升级后保留新名称", () => {
  const v2Sites = [
    site("github", "我的代码仓库", "home", at(30)),
    site("gmail", "Gmail", "mail", at(30)),
    site("bilibili", "哔哩哔哩", "media", at(30))
  ];

  const { sites } = upgradeCustomSitesToV3(2, v2Sites, V2_PRESETS, { timestamp: at(1) });

  assert.equal(sites.length, 3, "不得新增或删除条目");
  assert.equal(
    sites.find(s => s.key === "github").label,
    "我的代码仓库",
    "用户改名必须保留，不能恢复默认名称"
  );
});

test("P1: v2 修改过预设链接，升级后保留新链接", () => {
  const v2Sites = [
    site("github", "GitHub", "home", at(30)),
    site("gmail", "Gmail", "mail", at(30)),
    site("bilibili", "哔哩哔哩", "media", at(30))
  ];

  const { sites } = upgradeCustomSitesToV3(2, v2Sites, V2_PRESETS, { timestamp: at(1) });
  const github = sites.find(s => s.key === "github");

  github.url = "https://github.com/o-ocn";

  const { sites: after } = upgradeCustomSitesToV3(2, sites, V2_PRESETS, { timestamp: at(1) });

  assert.equal(
    after.find(s => s.key === "github").url,
    "https://github.com/o-ocn",
    "用户修改的链接必须保留"
  );
});

test("P1: v2 把预设移动到其他分组，升级后保留新分组", () => {
  const v2Sites = [
    site("github", "GitHub", "tools", at(30)),
    site("gmail", "Gmail", "mail", at(30)),
    site("bilibili", "哔哩哔哩", "media", at(30))
  ];

  const { sites } = upgradeCustomSitesToV3(2, v2Sites, V2_PRESETS, { timestamp: at(1) });

  assert.equal(
    sites.find(s => s.key === "github").groupId,
    "tools",
    "移动过的分组必须保留，不能回到默认分组"
  );
  assert.equal(
    sites.find(s => s.key === "github").updatedAt,
    at(30),
    "已有 updatedAt 必须原样保留"
  );
});

test("P1: v2 删除过预设，升级后不得重新出现", () => {
  const v2Sites = [
    site("gmail", "Gmail", "mail", at(30)),
    site("bilibili", "哔哩哔哩", "media", at(30))
  ];

  const { sites, trash } = upgradeCustomSitesToV3(2, v2Sites, V2_PRESETS, { timestamp: at(1) });

  assert.ok(!sites.some(s => s.key === "github"), "已删除的预设不能复活");
  assert.equal(sites.length, 2);
  assert.equal(trash.length, 0, "迁移不产生删除记录");
});

test("P1: v2 用户修改过的内容升级到 v3 后全部原样保留", () => {
  const v2Sites = [
    site("github", "改名+改链接", "tools", at(20)),
    site("custom-1", "自建站", "home", at(25))
  ];

  const { sites, groupOrder, trash } = upgradeCustomSitesToV3(2, v2Sites, V2_PRESETS, { timestamp: at(1) });

  const github = sites.find(s => s.key === "github");
  assert.deepEqual(
    [github.label, github.url, github.groupId, github.updatedAt],
    ["改名+改链接", github.url, "tools", at(20)]
  );

  const custom = sites.find(s => s.key === "custom-1");
  assert.deepEqual([custom.label, custom.groupId], ["自建站", "home"]);

  assert.ok(!sites.some(s => s.key === "gmail"), "不存在的预设不得补入");
  assert.ok(!sites.some(s => s.key === "bilibili"), "不存在的预设不得补入");
  assert.equal(trash.length, 0);
  assert.deepEqual(groupOrder.tools.items, ["github"]);
  assert.deepEqual(groupOrder.home.items, ["custom-1"]);
});

test("P1: v1 升级仍会补入预设，且用户自建的同 key 记录按 v1 语义让位", () => {
  const v1Sites = [
    site("github", "GitHub", "home", at(40)),
    site("custom-1", "自建站", "home", at(40))
  ];

  const { sites, trash } = upgradeCustomSitesToV3(1, v1Sites, V2_PRESETS, { timestamp: at(1) });

  assert.ok(sites.some(s => s.key === "github"), "v1 需要补入预设");
  assert.ok(sites.some(s => s.key === "gmail"), "v1 需要补入预设");
  assert.ok(sites.some(s => s.key === "custom-1"), "用户自建站保留");
  assert.equal(trash.length, 0);
});

test("P1: 云端 v2 文档升级同样保留用户的全部修改", () => {
  const cloudV2 = {
    version: 2,
    updatedAt: at(30),
    customSites: [
      site("github", "云端改名", "tools", at(30)),
      site("gmail", "Gmail", "mail", at(30))
    ],
    iconOverrides: {}
  };

  /*
     与页面 pullCloudSync 相同的升级路径：
     云端 version=2 → 不并预设，customSites 权威。
  */

  const { sites, trash } = upgradeCustomSitesToV3(
    Number(cloudV2.version || 1),
    cloudV2.customSites,
    [],
    { timestamp: cloudV2.updatedAt }
  );

  assert.equal(sites.find(s => s.key === "github").label, "云端改名");
  assert.equal(sites.find(s => s.key === "github").groupId, "tools");
  assert.ok(!sites.some(s => s.key === "bilibili"), "已删除预设不复活");
  assert.equal(sites.every(s => s.updatedAt), true);
  assert.equal(trash.length, 0);
});

test("两台设备修改不同快捷方式：自动合并保留双方", () => {
  const local = doc({
    sites: [
      site("github", "GitHub", "home", at(5)),
      site("a", "A-本地改名", "home", at(4))
    ],
    order: { home: { items: ["github", "a"], updatedAt: at(6) } }
  });

  const cloud = doc({
    sites: [
      site("github", "GitHub", "home", at(9)),
      site("a", "A", "home", at(10)),
      site("b", "B-云端新增", "tools", at(3))
    ],
    order: { home: { items: ["a", "github"], updatedAt: at(11) }, tools: { items: ["b"], updatedAt: at(3) } }
  });

  const { document: merged, conflicts } = mergeSyncDocuments(local, cloud, { now: BASE });

  assert.deepEqual(conflicts, []);

  const byKey = new Map(merged.customSites.map(entry => [entry.key, entry]));
  assert.equal(byKey.get("a").label, "A-本地改名", "本机较新的修改获胜");
  assert.equal(byKey.get("b").label, "B-云端新增", "云端新增的网站保留");
  assert.equal(byKey.get("github").updatedAt, at(5), "未修改的条目取较新副本（本机 5 分钟前 > 云端 9 分钟前）");
  assert.ok(byKey.has("b"));
});

test("两台设备修改同一快捷方式：更新时间新的一方获胜", () => {
  const local = doc({
    sites: [site("a", "A-本机", "home", at(2))],
    order: { home: { items: ["a"], updatedAt: at(2) } }
  });

  const cloud = doc({
    sites: [site("a", "A-云端", "home", at(8))],
    order: { home: { items: ["a"], updatedAt: at(8) } }
  });

  const { document: merged, conflicts } = mergeSyncDocuments(local, cloud, { now: BASE });

  assert.deepEqual(conflicts, []);
  assert.equal(merged.customSites[0].label, "A-本机");
});

test("两台设备调整不同分组的排序：两个排序都保留", () => {
  const local = doc({
    sites: [site("a", "A", "home", at(30)), site("b", "B", "tools", at(30)), site("c", "C", "tools", at(30))],
    order: {
      home: { items: ["a"], updatedAt: at(30) },
      tools: { items: ["c", "b"], updatedAt: at(3) }
    }
  });

  const cloud = doc({
    sites: [site("a", "A", "home", at(30)), site("b", "B", "tools", at(30)), site("c", "C", "tools", at(30))],
    order: {
      home: { items: ["a"], updatedAt: at(2) },
      tools: { items: ["b", "c"], updatedAt: at(30) }
    }
  });

  const { document: merged, conflicts } = mergeSyncDocuments(local, cloud, { now: BASE });

  assert.deepEqual(conflicts, []);
  assert.deepEqual(merged.groupOrder.tools.items, ["c", "b"], "本机较新的 tools 排序获胜");
  assert.equal(merged.groupOrder.home.updatedAt, at(2), "云端较新的 home 排序获胜");
});

test("改名不覆盖排序：站点更新时间新但排序时间旧", () => {
  const local = doc({
    sites: [site("a", "A-改名", "home", at(1))],
    order: { home: { items: ["a"], updatedAt: at(40) } }
  });

  const cloud = doc({
    sites: [site("a", "A", "home", at(50))],
    order: { home: { items: ["a"], updatedAt: at(2) } }
  });

  const { document: merged, conflicts } = mergeSyncDocuments(local, cloud, { now: BASE });

  assert.deepEqual(conflicts, []);
  assert.equal(merged.customSites[0].label, "A-改名", "改名获胜");
  assert.equal(merged.groupOrder.home.updatedAt, at(2), "云端较新的排序独立保留");
});

test("删除与编辑冲突：删除时间更新 → 保持删除", () => {
  const local = doc({
    sites: [],
    order: { home: { items: [], updatedAt: at(1) } },
    trash: [dead("a", "A", "home", at(2))]
  });

  const cloud = doc({
    sites: [site("a", "A-云端编辑", "home", at(9))],
    order: { home: { items: ["a"], updatedAt: at(9) } }
  });

  const { document: merged, conflicts } = mergeSyncDocuments(local, cloud, { now: BASE });

  assert.deepEqual(conflicts, []);
  assert.equal(merged.customSites.length, 0, "删除获胜，网站保持删除");
  assert.equal(merged.trash.length, 1);
  assert.equal(merged.trash[0].key, "a");
});

test("删除与编辑冲突：编辑时间更新 → 网站恢复", () => {
  const local = doc({
    sites: [],
    order: { home: { items: [], updatedAt: at(20) } },
    trash: [dead("a", "A", "home", at(10))]
  });

  const cloud = doc({
    sites: [site("a", "A-云端编辑", "home", at(3))],
    order: { home: { items: ["a"], updatedAt: at(3) } }
  });

  const { document: merged, conflicts } = mergeSyncDocuments(local, cloud, { now: BASE });

  assert.deepEqual(conflicts, []);
  assert.equal(merged.customSites.length, 1);
  assert.equal(merged.customSites[0].label, "A-云端编辑");
  assert.equal(merged.trash.length, 0, "过期墓碑被清除，不会反复复活删除");
});

test("更新时间相同但内容不同 → 记入冲突，默认保留云端副本", () => {
  const local = doc({
    sites: [site("a", "A-本机", "home", at(5))],
    order: { home: { items: ["a"], updatedAt: at(5) } }
  });

  const cloud = doc({
    sites: [site("a", "A-云端", "home", at(5))],
    order: { home: { items: ["a"], updatedAt: at(5) } }
  });

  const { document: merged, conflicts } = mergeSyncDocuments(local, cloud, { now: BASE });

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].type, "site");
  assert.equal(conflicts[0].id, "a");
  assert.equal(merged.customSites[0].label, "A-云端", "自动合并仍给出确定性结果");
});

test("排序时间相同但顺序不同 → 记入冲突", () => {
  const sites = [site("a", "A", "home", at(30)), site("b", "B", "home", at(30))];
  const local = doc({
    sites,
    order: { home: { items: ["a", "b"], updatedAt: at(5) } }
  });
  const cloud = doc({
    sites,
    order: { home: { items: ["b", "a"], updatedAt: at(5) } }
  });

  const { conflicts } = mergeSyncDocuments(local, cloud, { now: BASE });

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].type, "order");
  assert.equal(conflicts[0].id, "home");
});

test("冲突策略：使用云端版本 / 保留本机版本", () => {
  const local = doc({
    sites: [site("a", "A-本机", "home", at(1))],
    order: { home: { items: ["a"], updatedAt: at(1) } }
  });
  const cloud = doc({
    sites: [site("b", "B-云端", "tools", at(2))],
    order: { tools: { items: ["b"], updatedAt: at(2) } }
  });

  const cloudTaken = applyConflictStrategy("cloud", local, cloud, { now: BASE }).document;
  assert.deepEqual(cloudTaken.customSites.map(entry => entry.key), ["b"]);

  const localKept = applyConflictStrategy("local", local, cloud, { now: BASE }).document;
  assert.deepEqual(localKept.customSites.map(entry => entry.key), ["a"]);

  const merged = applyConflictStrategy("merge", local, cloud, { now: BASE }).document;
  assert.deepEqual(merged.customSites.map(entry => entry.key).sort(), ["a", "b"]);
});

test("合并剔除墓碑对应的排序项", () => {
  const local = doc({
    sites: [site("b", "B", "home", at(30))],
    order: { home: { items: ["a", "b"], updatedAt: at(1) } }
  });
  const cloud = doc({
    sites: [site("b", "B", "home", at(30))],
    order: { home: { items: ["a", "b"], updatedAt: at(30) } },
    trash: [dead("a", "A", "home", at(2))]
  });

  const { document: merged } = mergeSyncDocuments(local, cloud, { now: BASE });

  assert.deepEqual(merged.groupOrder.home.items, ["b"], "已删除的 key 不能留在排序里");
});

test("回收站保留最近 100 条、30 天内的记录", () => {
  const entries = [];

  for (let index = 0; index < TRASH_MAX_ENTRIES + 20; index += 1) {
    entries.push(
      dead(
        `k${index}`,
        `K${index}`,
        "home",
        new Date(BASE - index * 60_000).toISOString()
      )
    );
  }

  const pruned = pruneTrashEntries(entries, BASE);

  assert.equal(pruned.length, TRASH_MAX_ENTRIES);
  assert.equal(pruned[0].key, "k0", "最新的记录在前");
  assert.ok(!pruned.some(entry => entry.key === `k${TRASH_MAX_ENTRIES}`));
});

test("回收站丢弃超过 30 天的记录", () => {
  const cutoffDays = TRASH_RETENTION_DAYS;
  const entries = [
    dead("fresh", "新删除", "home", at(60)),
    dead("stale", "早就删除", "home", new Date(BASE - (cutoffDays + 1) * 24 * 60 * 60 * 1000).toISOString())
  ];

  const pruned = pruneTrashEntries(entries, BASE);

  assert.deepEqual(pruned.map(entry => entry.key), ["fresh"]);
});

test("合并后的回收站同样遵循保留规则", () => {
  const trash = [];

  for (let index = 0; index < TRASH_MAX_ENTRIES + 5; index += 1) {
    trash.push(dead(`k${index}`, `K${index}`, "home", new Date(BASE - index * 60_000).toISOString()));
  }

  const local = doc({ sites: [site("a", "A", "home", at(30))], order: { home: { items: ["a"], updatedAt: at(30) } } });
  const cloud = doc({ sites: [], order: {}, trash });

  const { document: merged } = mergeSyncDocuments(local, cloud, { now: BASE });

  assert.ok(merged.trash.length <= TRASH_MAX_ENTRIES);
});

test("图标覆盖合并：跟随对应网站的胜者", () => {
  const local = doc({
    sites: [site("a", "A-本机改名", "home", at(1))],
    overrides: { a: "https://icons.example.com/local.png" },
    order: { home: { items: ["a"], updatedAt: at(1) } }
  });

  const cloud = doc({
    sites: [site("a", "A", "home", at(9))],
    overrides: { a: "https://icons.example.com/cloud.png" },
    order: { home: { items: ["a"], updatedAt: at(9) } }
  });

  const { document: merged } = mergeSyncDocuments(local, cloud, { now: BASE });

  assert.equal(
    merged.iconOverrides.a,
    "https://icons.example.com/local.png",
    "本机站点副本较新，图标跟随本机"
  );
});

test("双向同时新增同名 key 的不同内容按时间合并", () => {
  const local = doc({
    sites: [site("shared", "本机版", "home", at(2))],
    order: { home: { items: ["shared"], updatedAt: at(2) } }
  });
  const cloud = doc({
    sites: [site("shared", "云端版", "home", at(6))],
    order: { home: { items: ["shared"], updatedAt: at(6) } }
  });

  const { document: merged, conflicts } = mergeSyncDocuments(local, cloud, { now: BASE });

  assert.deepEqual(conflicts, []);
  assert.equal(merged.customSites[0].label, "本机版");
});

/* ========================================
   P2 回归：图标覆盖的删除必须参与合并
   ======================================== */

test("P2: 设备A恢复自动图标 + 设备B修改其他网站，409 合并后旧图标不复活", () => {
  /*
     设备 A：恢复自动图标（删除 override 并更新站点时间）
     设备 B（云端）：同时改了别的网站，仍带着 A 的旧图标
  */

  const local = doc({
    sites: [
      site("a", "A", "home", at(1)),
      site("b", "B-本机改名", "tools", at(2))
    ],
    overrides: {},
    order: { home: { items: ["a"], updatedAt: at(1) }, tools: { items: ["b"], updatedAt: at(2) } }
  });

  const cloud = doc({
    sites: [
      site("a", "A", "home", at(20)),
      site("b", "B", "tools", at(30))
    ],
    overrides: { a: "data:image/webp;base64,OLDDATA" },
    order: { home: { items: ["a"], updatedAt: at(20) }, tools: { items: ["b"], updatedAt: at(30) } }
  });

  const { document: merged, conflicts } = mergeSyncDocuments(local, cloud, { now: BASE });

  assert.deepEqual(conflicts, []);
  assert.ok(!Object.prototype.hasOwnProperty.call(merged.iconOverrides, "a"), "恢复自动图标的意图必须同步，旧图标不能复活");
  assert.equal(merged.customSites.find(s => s.key === "b").label, "B-本机改名", "设备B对其他网站的修改仍保留");
});

test("P2: 云端胜出时对称规则 —— 云端删除覆盖同样生效", () => {
  const local = doc({
    sites: [site("a", "A", "home", at(20))],
    overrides: { a: "https://icons.example.com/old.png" },
    order: { home: { items: ["a"], updatedAt: at(20) } }
  });

  const cloud = doc({
    sites: [site("a", "A-云端改名", "home", at(1))],
    overrides: {},
    order: { home: { items: ["a"], updatedAt: at(1) } }
  });

  const { document: merged } = mergeSyncDocuments(local, cloud, { now: BASE });

  assert.equal(merged.customSites.find(s => s.key === "a").label, "A-云端改名");
  assert.ok(!Object.prototype.hasOwnProperty.call(merged.iconOverrides, "a"), "云端胜出且云端无覆盖时，本机旧覆盖被删除");
});

test("P2: 删除带本地图标的网站后，不残留孤立 data URL", () => {
  const local = doc({
    sites: [],
    overrides: {},
    order: { home: { items: [], updatedAt: at(1) } },
    trash: [dead("a", "A", "home", at(1))]
  });

  const cloud = doc({
    sites: [site("a", "A", "home", at(40))],
    overrides: { a: "data:image/png;base64,BIGDATAURL", other: "https://icons.example.com/keep.png" },
    order: { home: { items: ["a"], updatedAt: at(40) } }
  });

  const { document: merged } = mergeSyncDocuments(local, cloud, { now: BASE });

  assert.equal(merged.customSites.length, 0, "墓碑时间更新，网站保持删除");
  assert.ok(!Object.prototype.hasOwnProperty.call(merged.iconOverrides, "a"), "已删除网站的图标覆盖必须清理");
  assert.equal(merged.iconOverrides.other, "https://icons.example.com/keep.png", "其他网站的覆盖不受影响");
});

test("P2: 双方都有覆盖且本机站点胜出时取本机，反之取云端", () => {
  const local = doc({
    sites: [site("a", "A-本机", "home", at(1))],
    overrides: { a: "https://icons.example.com/local.png" },
    order: { home: { items: ["a"], updatedAt: at(1) } }
  });

  const cloud = doc({
    sites: [site("a", "A", "home", at(9))],
    overrides: { a: "https://icons.example.com/cloud.png" },
    order: { home: { items: ["a"], updatedAt: at(9) } }
  });

  const { document: merged } = mergeSyncDocuments(local, cloud, { now: BASE });
  assert.equal(merged.iconOverrides.a, "https://icons.example.com/local.png");
});

/* ========================================
   P3 回归：永久删除后不得被离线旧设备复活
   ======================================== */

test("P3: 设备A永久删除 + 设备B保留旧网站并修改其他网站，合并后不复活", () => {
  /*
     设备 A：删除了 key "removed" 并永久删除
     （trash 中只留精简 purged 墓碑）
     设备 B（云端）：仍保存 "removed" 的旧副本，
     同时修改了另一个网站 "kept"
  */

  const local = doc({
    sites: [site("kept", "kept-本机改名", "tools", at(1))],
    order: { tools: { items: ["kept"], updatedAt: at(1) } },
    trash: [
      {
        key: "removed",
        deletedAt: at(2),
        purged: true,
        purgedAt: at(2)
      }
    ]
  });

  const cloud = doc({
    sites: [
      site("removed", "被永久删除的网站", "home", at(50)),
      site("kept", "kept", "tools", at(30))
    ],
    order: { home: { items: ["removed"], updatedAt: at(50) }, tools: { items: ["kept"], updatedAt: at(30) } },
    trash: []
  });

  const { document: merged, conflicts } = mergeSyncDocuments(local, cloud, { now: BASE });

  assert.deepEqual(conflicts, []);
  assert.ok(!merged.customSites.some(s => s.key === "removed"), "被永久删除的网站不得复活");
  assert.equal(merged.customSites.find(s => s.key === "kept").label, "kept-本机改名", "设备B对其他网站的修改仍保留");

  const marker = merged.trash.find(entry => entry.key === "removed");
  assert.ok(marker, "purged 墓碑必须保留在合并结果中");
  assert.equal(marker.purged, true);
  assert.equal(marker.label, undefined, "精简墓碑不携带站点内容");
  assert.equal(marker.url, undefined, "精简墓碑不携带站点内容");
  assert.equal(marker.icon, undefined, "精简墓碑不携带图标");
});

test("P3: 即便站点副本比永久删除时间更新，也不复活", () => {
  const local = doc({
    sites: [],
    order: {},
    trash: [
      { key: "x", deletedAt: at(60), purged: true, purgedAt: at(60) }
    ]
  });

  const cloud = doc({
    sites: [site("x", "X-旧设备上被编辑过", "home", at(5))],
    order: { home: { items: ["x"], updatedAt: at(5) } },
    trash: []
  });

  const { document: merged } = mergeSyncDocuments(local, cloud, { now: BASE });

  assert.ok(!merged.customSites.some(s => s.key === "x"), "purged 墓碑无条件压制同名站点");
  assert.ok(merged.trash.some(entry => entry.key === "x" && entry.purged));
});

test("P3: purged 墓碑压过普通墓碑；同类取时间新者", () => {
  const local = doc({
    sites: [],
    order: {},
    trash: [
      { key: "y", label: "Y", url: "https://y.example.com/", groupId: "home", icon: "", deletedAt: at(1), originalGroupId: "home", originalIndex: 0 }
    ]
  });

  const cloud = doc({
    sites: [],
    order: {},
    trash: [
      { key: "y", deletedAt: at(50), purged: true, purgedAt: at(50) }
    ]
  });

  const { document: merged } = mergeSyncDocuments(local, cloud, { now: BASE });

  const marker = merged.trash.find(entry => entry.key === "y");
  assert.equal(marker.purged, true, "永久删除的意图不可被普通删除覆盖");
});

test("P3: 精简墓碑不参与回收站 UI 的容量与过期规则", () => {
  // 100 条普通墓碑 + 5 条 purged：普通按 100 条截断，purged 全部保留
  const trash = [];

  for (let index = 0; index < TRASH_MAX_ENTRIES + 10; index += 1) {
    trash.push(
      dead(`p${index}`, `P${index}`, "home", new Date(BASE - index * 60_000).toISOString())
    );
  }

  for (let index = 0; index < 5; index += 1) {
    trash.push({
      key: `purged${index}`,
      deletedAt: new Date(BASE - index * 60_000).toISOString(),
      purged: true,
      purgedAt: new Date(BASE - index * 60_000).toISOString()
    });
  }

  const pruned = TablissSyncModel.pruneTrashEntries(trash, BASE);

  assert.equal(pruned.filter(entry => !entry.purged).length, TRASH_MAX_ENTRIES);
  assert.equal(pruned.filter(entry => entry.purged).length, 5);
});

test("P3: 精简墓碑 180 天后清理，不无限增长", () => {
  const trash = [
    { key: "fresh", deletedAt: at(100), purged: true, purgedAt: at(100) },
    { key: "expired", deletedAt: new Date(BASE - (181) * 24 * 60 * 60 * 1000).toISOString(), purged: true, purgedAt: new Date(BASE - (181) * 24 * 60 * 60 * 1000).toISOString() }
  ];

  const pruned = TablissSyncModel.pruneTrashEntries(trash, BASE);

  assert.deepEqual(pruned.map(entry => entry.key), ["fresh"]);
});

/* ========================================
   P4 回归：确定性调用链中的时间统一使用传入的 now
   ======================================== */

test("P4: 系统时间到达远未来时，传入固定 now 的结果不变", () => {
  const entries = [
    dead("fresh", "新删除", "home", at(60)),
    dead("boundary", "临界记录", "home", new Date(BASE - 29 * 24 * 60 * 60 * 1000).toISOString())
  ];

  // 模拟系统时钟已走到 2027 年（远超 30 天清理窗口）
  const realNow = Date.now;
  Date.now = () => BASE + 400 * 24 * 60 * 60 * 1000;

  try {
    const prunedWithNow = TablissSyncModel.pruneTrashEntries(entries, BASE);

    assert.deepEqual(
      prunedWithNow.map(entry => entry.key).sort(),
      ["boundary", "fresh"],
      "传入 now 时不得使用真实系统时间"
    );

    const normalised = TablissSyncModel.normaliseTrashEntries(entries, BASE);

    assert.deepEqual(
      normalised.map(entry => entry.key).sort(),
      ["boundary", "fresh"],
      "normaliseTrashEntries 必须透传 now"
    );

    const documentNormalised = normaliseV3Document(
      doc({ sites: [site("a", "A", "home", at(1))], order: { home: { items: ["a"], updatedAt: at(1) } }, trash: entries }),
      { now: BASE }
    );

    assert.deepEqual(
      documentNormalised.trash.map(entry => entry.key).sort(),
      ["boundary", "fresh"],
      "normaliseV3Document 必须把 now 传到回收站清理"
    );

    const merged = mergeSyncDocuments(
      doc({ sites: [], order: {}, trash: entries }),
      doc({ sites: [], order: {}, trash: [] }),
      { now: BASE }
    );

    assert.deepEqual(
      merged.document.trash.map(entry => entry.key).sort(),
      ["boundary", "fresh"],
      "mergeSyncDocuments 必须把 now 传到回收站清理"
    );
  }

  finally {
    Date.now = realNow;
  }
});

test("P4: 模拟远未来系统时间下，合并的回收站清理仍以传入 now 为准", () => {
  const trash = [];

  for (let index = 0; index < 3; index += 1) {
    trash.push(dead(`k${index}`, `K${index}`, "home", new Date(BASE - index * 60_000).toISOString()));
  }

  const local = doc({ sites: [site("a", "A", "home", at(30))], order: { home: { items: ["a"], updatedAt: at(30) } } });
  const cloud = doc({ sites: [], order: {}, trash });

  const realNow = Date.now;
  Date.now = () => BASE + 400 * 24 * 60 * 60 * 1000;

  try {
    const { document: merged } = mergeSyncDocuments(local, cloud, { now: BASE });

    assert.equal(merged.trash.length, 3, "按传入 now 计算，三条墓碑都未过期");
  }

  finally {
    Date.now = realNow;
  }
});
