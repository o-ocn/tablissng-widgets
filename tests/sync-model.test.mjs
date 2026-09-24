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
