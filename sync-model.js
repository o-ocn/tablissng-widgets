/* ========================================
   TablissNG 同步数据模型（版本 3）

   这个文件同时给两类调用方使用：

   1. shortcuts.html 通过 <script> 引入，
      挂到 window.TablissSyncModel。
   2. tests/ 下的 Node 测试直接加载，
      校验迁移与合并逻辑。

   版本 3 在版本 1 / 2 的基础上增加：

   - 每条快捷方式的稳定键 key（旧版已有）
     与独立更新时间 updatedAt。
   - groupOrder：每个分组自己的顺序列表
     与独立更新时间，改名、换图标不再
     触碰排序信息。
   - trash：已删除快捷方式的墓碑记录，
     防止其他设备把删除的网站“复活”。

   版本 1 / 2 的文档仍然可以完整读取，
   迁移时不会把任何现有快捷方式
   误判为已删除。
   ======================================== */

(function () {

  const SITE_MODEL_VERSION = 3;

  /* 回收站保留规则：最多 100 条，且只保留 30 天内的记录。 */

  const TRASH_MAX_ENTRIES = 100;
  const TRASH_RETENTION_DAYS = 30;

  const SITE_FIELD_LIMITS = {
    key: 100,
    label: 50,
    url: 2048,
    icon: 2048,
    groupId: 50,
    updatedAt: 40
  };

  const GROUP_ORDER_LIMITS = {
    groups: 60,
    itemsPerGroup: 60
  };

  const TRASH_FIELD_LIMITS = {
    ...SITE_FIELD_LIMITS,
    deletedAt: 40,
    originalIndex: 200
  };

  function isPlainObject(value) {
    return (
      Boolean(value)
      && typeof value === "object"
      && !Array.isArray(value)
    );
  }

  function clampString(value, limit) {
    return String(value ?? "").slice(0, limit);
  }

  function normaliseTimestamp(value, fallback = "") {
    const text = typeof value === "string" ? value : "";
    return text && text.length <= 40 ? text : fallback;
  }

  function normaliseSiteIcon(value) {
    const raw = String(value ?? "").trim();
    return /^https:\/\//i.test(raw) ? raw.slice(0, SITE_FIELD_LIMITS.icon) : "";
  }

  function normaliseSiteEntry(entry, fallbackTimestamp = "") {
    if (!isPlainObject(entry)) {
      return null;
    }

    const key = clampString(entry.key, SITE_FIELD_LIMITS.key);
    const label = clampString(entry.label, SITE_FIELD_LIMITS.label).trim();
    const url = clampString(entry.url, SITE_FIELD_LIMITS.url).trim();
    const groupId = clampString(entry.groupId, SITE_FIELD_LIMITS.groupId);
    const icon = normaliseSiteIcon(entry.icon);
    const updatedAt = normaliseTimestamp(entry.updatedAt, fallbackTimestamp);

    if (!key || !label || !groupId || !/^https?:\/\//i.test(url)) {
      return null;
    }

    return { key, label, url, groupId, icon, updatedAt };
  }

  /* 保持原有 v1/v2 的站点字段规则，再补上 updatedAt。 */

  function normaliseSiteList(value, fallbackTimestamp = "") {
    if (!Array.isArray(value)) {
      return [];
    }

    const seenKeys = new Set();
    const sites = [];

    for (const entry of value.slice(0, 200)) {
      const site = normaliseSiteEntry(entry, fallbackTimestamp);

      if (!site || seenKeys.has(site.key)) {
        continue;
      }

      seenKeys.add(site.key);
      sites.push(site);
    }

    return sites;
  }

  function normaliseIconOverrides(value) {
    if (!isPlainObject(value)) {
      return {};
    }

    const overrides = {};

    for (const [key, icon] of Object.entries(value).slice(0, 300)) {
      const safeKey = clampString(key, SITE_FIELD_LIMITS.key);
      const safeIcon = String(icon ?? "");

      if (
        safeKey
        && (
          safeIcon.startsWith("data:image/")
          || /^https:\/\//i.test(safeIcon)
        )
      ) {
        overrides[safeKey] = safeIcon.slice(0, 500_000);
      }
    }

    return overrides;
  }

  function normaliseGroupOrder(value, fallbackTimestamp = "") {
    const order = {};

    if (!isPlainObject(value)) {
      return order;
    }

    for (const [groupId, entry] of Object.entries(value).slice(0, GROUP_ORDER_LIMITS.groups)) {
      const safeGroupId = clampString(groupId, SITE_FIELD_LIMITS.groupId);

      if (!safeGroupId || !isPlainObject(entry) || !Array.isArray(entry.items)) {
        continue;
      }

      const items = [];

      for (const item of entry.items.slice(0, GROUP_ORDER_LIMITS.itemsPerGroup)) {
        const key = clampString(item, SITE_FIELD_LIMITS.key);

        if (key && !items.includes(key)) {
          items.push(key);
        }
      }

      order[safeGroupId] = {
        items,
        updatedAt: normaliseTimestamp(entry.updatedAt, fallbackTimestamp)
      };
    }

    return order;
  }

  function normaliseTrashEntry(entry) {
    if (!isPlainObject(entry)) {
      return null;
    }

    const key = clampString(entry.key, TRASH_FIELD_LIMITS.key);
    const label = clampString(entry.label, TRASH_FIELD_LIMITS.label).trim();
    const url = clampString(entry.url, TRASH_FIELD_LIMITS.url).trim();
    const groupId = clampString(entry.groupId, TRASH_FIELD_LIMITS.groupId);
    const icon = normaliseSiteIcon(entry.icon);
    const deletedAt = normaliseTimestamp(entry.deletedAt);
    const originalGroupId = clampString(
      entry.originalGroupId ?? entry.groupId,
      TRASH_FIELD_LIMITS.groupId
    );
    const originalIndex = Number.isFinite(Number(entry.originalIndex))
      ? Math.max(0, Math.min(TRASH_FIELD_LIMITS.originalIndex, Number(entry.originalIndex)))
      : 0;

    if (!key || !label || !groupId || !/^https?:\/\//i.test(url) || !deletedAt) {
      return null;
    }

    return { key, label, url, groupId, icon, deletedAt, originalGroupId, originalIndex };
  }

  function normaliseTrashEntries(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    const seenKeys = new Set();
    const entries = [];

    for (const entry of value.slice(0, 400)) {
      const safeEntry = normaliseTrashEntry(entry);

      if (!safeEntry || seenKeys.has(safeEntry.key)) {
        continue;
      }

      seenKeys.add(safeEntry.key);
      entries.push(safeEntry);
    }

    return pruneTrashEntries(entries, Date.now());
  }

  /* 回收站清理规则（对用户可见，必须与文档一致）：
     1. 同一个 key 只保留删除时间最新的一条。
     2. 按删除时间从新到旧保留最近 100 条。
     3. 早于 30 天的记录直接丢弃。 */

  function pruneTrashEntries(entries, now = Date.now()) {
    const byKey = new Map();

    for (const entry of entries) {
      const existing = byKey.get(entry.key);

      if (!existing || entry.deletedAt > existing.deletedAt) {
        byKey.set(entry.key, entry);
      }
    }

    const cutoff = new Date(now - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    return [...byKey.values()]
      .filter(entry => entry.deletedAt >= cutoff)
      .sort((left, right) => right.deletedAt.localeCompare(left.deletedAt))
      .slice(0, TRASH_MAX_ENTRIES);
  }

  /* ========================================
     版本 1 / 2 → 版本 3 迁移

     输入的 sites 应当已经过页面侧的
     migrateLegacySites（合并预设与旧自定项）。
     迁移只补时间戳、构建排序、清空回收站，
     绝不会制造删除记录。
     ======================================== */

  function upgradeSitesToV3(sites, { timestamp } = {}) {
    const now = normaliseTimestamp(timestamp) || new Date().toISOString();
    const stamped = normaliseSiteList(sites, now).map(site => ({
      ...site,
      updatedAt: normaliseTimestamp(site.updatedAt) || now
    }));

    return {
      sites: stamped,
      groupOrder: buildGroupOrderFromSites(stamped, now),
      trash: []
    };
  }

  function buildGroupOrderFromSites(sites, timestamp) {
    const order = {};

    for (const site of sites) {
      if (!order[site.groupId]) {
        order[site.groupId] = {
          items: [],
          updatedAt: timestamp
        };
      }

      if (!order[site.groupId].items.includes(site.key)) {
        order[site.groupId].items.push(site.key);
      }
    }

    return order;
  }

  /* 把任意旧版/新版云端文档规整成版本 3 结构。
     旧版文档不会产生删除记录。 */

  function normaliseV3Document(document, { now = Date.now(), fallbackTimestamp } = {}) {
    const doc = isPlainObject(document) ? document : {};
    const fallback = normaliseTimestamp(fallbackTimestamp)
      || normaliseTimestamp(doc.updatedAt)
      || new Date(now).toISOString();
    const version = Number(doc.version ?? doc.modelVersion ?? 1);

    if (version >= 3) {
      return {
        version: 3,
        updatedAt: fallback,
        customSites: normaliseSiteList(doc.customSites, fallback),
        iconOverrides: normaliseIconOverrides(doc.iconOverrides),
        groupOrder: normaliseGroupOrder(doc.groupOrder, fallback),
        trash: normaliseTrashEntries(doc.trash)
      };
    }

    const upgraded = upgradeSitesToV3(doc.customSites || [], { timestamp: fallback });

    return {
      version: 3,
      updatedAt: fallback,
      customSites: upgraded.sites,
      iconOverrides: normaliseIconOverrides(doc.iconOverrides),
      groupOrder: upgraded.groupOrder,
      trash: []
    };
  }

  /* ========================================
     自动合并

     规则（与 PR 描述一致）：

     - 快捷方式按稳定 key 合并，
       updatedAt 新的一方胜出。
     - 一方删除、另一方编辑时，
       时间新的意图胜出：
       删除时间更新 → 保持删除；
       编辑时间更新 → 恢复网站。
     - 分组排序按 groupOrder[groupId].updatedAt
       独立比较，不受改名影响。
     - 双方 updatedAt 相同但内容不同时，
       无法判定谁对，记入 conflicts，
       由冲突窗口交给用户选择。
     ======================================== */

  function mergeSyncDocuments(localDocument, cloudDocument, { now = Date.now() } = {}) {
    const local = normaliseV3Document(localDocument, { now });
    const cloud = normaliseV3Document(cloudDocument, { now });
    const conflicts = [];

    const localSites = new Map(local.customSites.map(site => [site.key, site]));
    const cloudSites = new Map(cloud.customSites.map(site => [site.key, site]));
    const localTrash = new Map(local.trash.map(entry => [entry.key, entry]));
    const cloudTrash = new Map(cloud.trash.map(entry => [entry.key, entry]));
    const mergedTrash = [];
    const mergedSites = [];
    const siteWinner = new Map();

    const allKeys = new Set([
      ...localSites.keys(),
      ...cloudSites.keys(),
      ...localTrash.keys(),
      ...cloudTrash.keys()
    ]);

    for (const key of allKeys) {
      const localLive = localSites.get(key);
      const cloudLive = cloudSites.get(key);
      const localDead = localTrash.get(key);
      const cloudDead = cloudTrash.get(key);

      if (localLive && cloudLive) {
        const winner =
          localLive.updatedAt > cloudLive.updatedAt
            ? localLive
            : cloudLive.updatedAt > localLive.updatedAt
              ? cloudLive
              : null;

        if (winner) {
          mergedSites.push({ ...winner });
          siteWinner.set(key, winner === localLive ? "local" : "cloud");
          continue;
        }

        if (sameSiteContent(localLive, cloudLive)) {
          mergedSites.push({ ...cloudLive });
          siteWinner.set(key, "cloud");
          continue;
        }

        conflicts.push({
          type: "site",
          id: key,
          message: `「${localLive.label}」在两台设备上都被修改，且无法判断先后`
        });

        const fallback = { ...cloudLive };
        mergedSites.push(fallback);
        siteWinner.set(key, "cloud");
        continue;
      }

      if (localLive || cloudLive) {
        const live = localLive || cloudLive;
        const tombstone = localLive ? cloudDead : localDead;
        const side = localLive ? "local" : "cloud";

        if (!tombstone) {
          mergedSites.push({ ...live });
          siteWinner.set(key, side);
          continue;
        }

        if (live.updatedAt > tombstone.deletedAt) {
          mergedSites.push({ ...live });
          siteWinner.set(key, side);
          continue;
        }

        if (live.updatedAt < tombstone.deletedAt) {
          mergedTrash.push({ ...tombstone });
          continue;
        }

        conflicts.push({
          type: "delete",
          id: key,
          message: `「${live.label}」在一台设备上被删除、另一台设备被修改，时间相同无法判断`
        });

        mergedTrash.push({ ...tombstone });
        continue;
      }

      const localDeleted = localDead?.deletedAt || "";
      const cloudDeleted = cloudDead?.deletedAt || "";
      const tombstone = localDeleted >= cloudDeleted ? localDead : cloudDead;

      if (tombstone) {
        mergedTrash.push({ ...tombstone });
      }
    }

    /* 分组排序：只比较排序自己的 updatedAt。 */

    const mergedOrder = {};
    const allGroupIds = new Set([
      ...Object.keys(local.groupOrder),
      ...Object.keys(cloud.groupOrder)
    ]);

    for (const groupId of allGroupIds) {
      const localOrder = local.groupOrder[groupId];
      const cloudOrder = cloud.groupOrder[groupId];

      if (localOrder && cloudOrder) {
        if (localOrder.updatedAt > cloudOrder.updatedAt) {
          mergedOrder[groupId] = { ...localOrder, items: [...localOrder.items] };
          continue;
        }

        if (cloudOrder.updatedAt > localOrder.updatedAt) {
          mergedOrder[groupId] = { ...cloudOrder, items: [...cloudOrder.items] };
          continue;
        }

        if (sameItemList(localOrder.items, cloudOrder.items)) {
          mergedOrder[groupId] = { ...cloudOrder, items: [...cloudOrder.items] };
          continue;
        }

        conflicts.push({
          type: "order",
          id: groupId,
          message: `分组「${groupId}」在两台设备上都被重新排序，且无法判断先后`
        });

        mergedOrder[groupId] = { ...cloudOrder, items: [...cloudOrder.items] };
        continue;
      }

      const single = localOrder || cloudOrder;

      if (single) {
        mergedOrder[groupId] = { ...single, items: [...single.items] };
      }
    }

    /* 把合并后仍然存在的网站补进排序，
       并剔除已被删除或已不存在的 key。 */

    const mergedSiteIds = new Set(mergedSites.map(site => site.key));

    for (const site of mergedSites) {
      const group = mergedOrder[site.groupId];

      if (!group) {
        mergedOrder[site.groupId] = {
          items: [site.key],
          updatedAt: site.updatedAt
        };
        continue;
      }

      if (!group.items.includes(site.key)) {
        group.items.push(site.key);
      }
    }

    for (const group of Object.values(mergedOrder)) {
      group.items = group.items.filter(key => mergedSiteIds.has(key));
    }

    /* 图标覆盖：跟随对应网站的胜者；
       没有对应网站时，本机有未同步更改则本机优先。 */

    const mergedIconOverrides = {
      ...cloud.iconOverrides
    };

    for (const [key, icon] of Object.entries(local.iconOverrides)) {
      const winner = siteWinner.get(key);
      const cloudIcon = Object.prototype.hasOwnProperty.call(cloud.iconOverrides, key)
        ? cloud.iconOverrides[key]
        : undefined;

      if (cloudIcon === undefined) {
        mergedIconOverrides[key] = icon;
        continue;
      }

      if (cloudIcon === icon) {
        continue;
      }

      mergedIconOverrides[key] = winner === "local" ? icon : cloudIcon;
    }

    const trashById = new Map();

    for (const entry of mergedTrash) {
      const existing = trashById.get(entry.key);

      if (!existing || entry.deletedAt > existing.deletedAt) {
        trashById.set(entry.key, entry);
      }
    }

    const trash = pruneTrashEntries([...trashById.values()], now);

    return {
      document: {
        version: SITE_MODEL_VERSION,
        updatedAt: new Date(now).toISOString(),
        customSites: mergedSites,
        iconOverrides: mergedIconOverrides,
        groupOrder: mergedOrder,
        trash
      },
      conflicts
    };
  }

  function sameSiteContent(left, right) {
    return (
      left.label === right.label
      && left.url === right.url
      && left.groupId === right.groupId
      && left.icon === right.icon
    );
  }

  function sameItemList(left, right) {
    return (
      left.length === right.length
      && left.every((key, index) => key === right[index])
    );
  }

  /* ========================================
     冲突处理策略

     - "merge"：默认，自动合并并保留双方
       能共存的全部更改（非破坏性）。
     - "cloud"：整体采用云端版本。
     - "local"：整体保留本机版本，
       仅在用户明确确认后使用。
     ======================================== */

  function applyConflictStrategy(strategy, localDocument, cloudDocument, { now = Date.now() } = {}) {
    if (strategy === "cloud") {
      return {
        document: normaliseV3Document(cloudDocument, { now }),
        conflicts: []
      };
    }

    if (strategy === "local") {
      return {
        document: normaliseV3Document(localDocument, { now }),
        conflicts: []
      };
    }

    return mergeSyncDocuments(localDocument, cloudDocument, { now });
  }

  const TablissSyncModel = {
    SITE_MODEL_VERSION,
    TRASH_MAX_ENTRIES,
    TRASH_RETENTION_DAYS,
    normaliseSiteList,
    normaliseIconOverrides,
    normaliseGroupOrder,
    normaliseTrashEntries,
    normaliseV3Document,
    upgradeSitesToV3,
    buildGroupOrderFromSites,
    mergeSyncDocuments,
    applyConflictStrategy,
    pruneTrashEntries
  };

  if (typeof globalThis !== "undefined") {
    globalThis.TablissSyncModel = TablissSyncModel;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = TablissSyncModel;
  }

})();
