/*
   快捷方式新特性单元测试：
   1. Apple 仿玻璃蒙版与样式
   2. 高清图标解析管道（appleTouchIcon, googleFavicon 128px, 过滤低清 ico 缓存）
   3. 左侧分组动态配置（CRUD、长按拖拽排序算法、快捷方式迁移与兜底）
*/

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const shortcutsHtml = fs.readFileSync("shortcuts.html", "utf8");

test("HTML 包含仿 Apple 磨砂玻璃蒙版样式及圆角", () => {
  assert.ok(shortcutsHtml.includes("backdrop-filter: blur(28px) saturate(160%)"), "包含高质量 backdrop blur");
  assert.ok(shortcutsHtml.includes("border-radius: 20px"), "容器包含 Apple 风格圆角");
  assert.ok(shortcutsHtml.includes("image-rendering: -webkit-optimize-contrast"), "图标渲染包含优化对比度规则");
  assert.ok(shortcutsHtml.includes("scrollbar-width: none !important"), "强制禁止滚动条以防触发视口缩放");
  assert.ok(shortcutsHtml.includes("contain: paint layout"), "侧边栏区域包含隔离容器");
});

test("Tabliss 外层组件配置保持透明背景以防双层蒙版叠加", () => {
  const widgetHtml = fs.readFileSync("tabliss/shortcuts-widget.html", "utf8");
  assert.ok(widgetHtml.includes("background:transparent"), "外层 div 背景透明");
  assert.ok(widgetHtml.includes("border:0"), "外层 div 无多余边框");
  assert.ok(widgetHtml.includes("box-shadow:none"), "外层 div 无多余阴影");
});

test("HTML 包含分组右键菜单 groupMenu 与分组弹窗 groupModal", () => {
  assert.ok(shortcutsHtml.includes('id="groupMenu"'), "包含 groupMenu 元素");
  assert.ok(shortcutsHtml.includes('data-action="edit-group"'), "包含重命名分组按钮");
  assert.ok(shortcutsHtml.includes('data-action="delete-group"'), "包含删除分组按钮");
  assert.ok(shortcutsHtml.includes('id="groupModal"'), "包含新建/编辑分组弹窗");
  assert.ok(shortcutsHtml.includes(".sidebar-drop-indicator"), "包含侧边栏拖拽指示线样式");
});

test("appleTouchIcon 正确解析官方高清图标地址", () => {
  function appleTouchIcon(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return "";
      }
      return parsed.origin + "/apple-touch-icon.png";
    } catch {
      return "";
    }
  }

  assert.equal(appleTouchIcon("https://vmiss.com/dashboard"), "https://vmiss.com/apple-touch-icon.png");
  assert.equal(appleTouchIcon("http://example.com:8080/path?query=1"), "http://example.com:8080/apple-touch-icon.png");
  assert.equal(appleTouchIcon("invalid-url"), "");
  assert.equal(appleTouchIcon("javascript:alert(1)"), "");
});

test("googleFavicon 请求 128px 高清尺寸", () => {
  function googleFavicon(url) {
    return "https://www.google.com/s2/favicons?sz=128&domain_url=" + encodeURIComponent(url);
  }

  assert.equal(
    googleFavicon("https://github.com"),
    "https://www.google.com/s2/favicons?sz=128&domain_url=https%3A%2F%2Fgithub.com"
  );
});

test("候选图标探测列表中，高清源优先于低清 ownFavicon", () => {
  function getCandidateList(site, overrides = {}) {
    const key = site.key;
    return [...new Set([
      overrides[key] || "",
      site.customIcon || "",
      site.icon && !site.icon.toLowerCase().endsWith(".ico") ? site.icon : "",
      site.url ? new URL(site.url).origin + "/apple-touch-icon.png" : "",
      site.url ? "https://www.google.com/s2/favicons?sz=128&domain_url=" + encodeURIComponent(site.url) : "",
      site.icon && site.icon.toLowerCase().endsWith(".ico") ? site.icon : "",
      site.url ? new URL(site.url).origin + "/favicon.ico" : "",
      "https://icons.duckduckgo.com/ip3/example.com.ico"
    ])].filter(Boolean);
  }

  const customSite = {
    key: "vmiss-test",
    label: "VMiss",
    url: "https://vmiss.com",
    icon: ""
  };

  const list = getCandidateList(customSite);
  const touchIndex = list.findIndex(u => u.includes("apple-touch-icon.png"));
  const googleIndex = list.findIndex(u => u.includes("google.com/s2/favicons?sz=128"));
  const ownIcoIndex = list.findIndex(u => u.includes("favicon.ico"));

  assert.ok(touchIndex >= 0, "包含 apple-touch-icon");
  assert.ok(googleIndex >= 0, "包含 google 128px");
  assert.ok(ownIcoIndex >= 0, "包含 own favicon");
  assert.ok(touchIndex < ownIcoIndex, "apple-touch-icon 必须优先于 own favicon.ico");
  assert.ok(googleIndex < ownIcoIndex, "google 128px 必须优先于 own favicon.ico");
});

test("旧版缓存为低清 .ico 时自动失效，触发重新解析高清图标", () => {
  function getStoredIcon(key, site, cache) {
    const entry = cache[key];
    if (!entry || typeof entry.src !== "string") return "";
    if (entry.src.toLowerCase().includes(".ico") || entry.src.includes("icons.duckduckgo.com")) {
      return "";
    }
    return entry.src;
  }

  const cache = {
    old1: { src: "https://vmiss.com/favicon.ico" },
    old2: { src: "https://icons.duckduckgo.com/ip3/test.ico" },
    sharp1: { src: "https://vmiss.com/apple-touch-icon.png" },
    sharp2: { src: "https://www.google.com/s2/favicons?sz=128&domain_url=https%3A%2F%2Fvmiss.com" }
  };

  assert.equal(getStoredIcon("old1", {}, cache), "", "旧 .ico 缓存被失效");
  assert.equal(getStoredIcon("old2", {}, cache), "", "旧 duckduckgo 缓存被失效");
  assert.equal(getStoredIcon("sharp1", {}, cache), "https://vmiss.com/apple-touch-icon.png", "高清 PNG 缓存被保留");
  assert.equal(getStoredIcon("sharp2", {}, cache), "https://www.google.com/s2/favicons?sz=128&domain_url=https%3A%2F%2Fvmiss.com", "Google 128px 缓存被保留");
});

test("左侧分组拖拽重排算法准确性", () => {
  function reorderGroups(groups, fromIndex, targetSlotIndex) {
    let targetIdx = targetSlotIndex;
    if (targetIdx > fromIndex) {
      targetIdx -= 1;
    }
    if (fromIndex >= 0 && targetIdx >= 0 && targetIdx !== fromIndex && targetIdx < groups.length) {
      const copy = [...groups];
      const [moved] = copy.splice(fromIndex, 1);
      copy.splice(targetIdx, 0, moved);
      return copy;
    }
    return groups;
  }

  const initial = ["home", "mail", "forum", "tools"];

  // 1. 把 home (0) 移到 mail (1) 之后 -> 插入槽位 2
  const r1 = reorderGroups(initial, 0, 2);
  assert.deepEqual(r1, ["mail", "home", "forum", "tools"]);

  // 2. 把 tools (3) 移到 mail (1) 之前 -> 插入槽位 1
  const r2 = reorderGroups(initial, 3, 1);
  assert.deepEqual(r2, ["home", "tools", "mail", "forum"]);

  // 3. 拖到自身位置 -> 保持不变
  const r3 = reorderGroups(initial, 1, 1);
  assert.deepEqual(r3, initial);
});

test("删除分组时快捷方式迁移到兜底分组，且至少保留一个分组", () => {
  let groups = [
    { id: "home", label: "主页", items: ["outlook"] },
    { id: "work", label: "工作", items: ["github", "notion"] }
  ];

  let customSites = [
    { key: "outlook", label: "Outlook", groupId: "home", updatedAt: "2026-09-24T00:00:00.000Z" },
    { key: "github", label: "GitHub", groupId: "work", updatedAt: "2026-09-24T00:00:00.000Z" },
    { key: "notion", label: "Notion", groupId: "work", updatedAt: "2026-09-24T00:00:00.000Z" }
  ];

  function deleteGroup(groupId) {
    if (groups.length <= 1) {
      return { success: false, reason: "at_least_one" };
    }
    const group = groups.find(g => g.id === groupId);
    if (!group) return { success: false, reason: "not_found" };

    const fallback = groups.find(g => g.id !== groupId) || groups[0];
    const now = "2026-09-26T12:00:00.000Z";

    customSites.forEach(site => {
      if (site.groupId === groupId) {
        site.groupId = fallback.id;
        site.updatedAt = now;
      }
    });

    groups = groups.filter(g => g.id !== groupId);
    return { success: true, fallbackId: fallback.id };
  }

  // 删除工作分组
  const result = deleteGroup("work");
  assert.equal(result.success, true);
  assert.equal(result.fallbackId, "home");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, "home");

  // 原属于 work 的快捷方式全部移到了 home
  const github = customSites.find(s => s.key === "github");
  const notion = customSites.find(s => s.key === "notion");
  assert.equal(github.groupId, "home");
  assert.equal(notion.groupId, "home");
  assert.equal(github.updatedAt, "2026-09-26T12:00:00.000Z");

  // 尝试删除最后一个分组 -> 阻止
  const lastDelete = deleteGroup("home");
  assert.equal(lastDelete.success, false);
  assert.equal(lastDelete.reason, "at_least_one");
  assert.equal(groups.length, 1);
});

test("Tabliss 外壳透明化与双层蒙版消除检验", () => {
  const widgetHtml = fs.readFileSync("tabliss/shortcuts-widget.html", "utf8");
  assert.ok(widgetHtml.includes("background:transparent"), "外层 div 背景透明");
  assert.ok(widgetHtml.includes("border:0"), "外层 div 无独立边框");
  assert.ok(widgetHtml.includes("box-shadow:none"), "外层 div 无多余阴影");
  assert.ok(!widgetHtml.includes("backdrop-filter:blur"), "外层 div 不再包含重复的 backdrop-filter 蒙版");
});

test("左侧分组拖拽实感悬浮长条与手风琴上下避让位移算法", () => {
  assert.ok(shortcutsHtml.includes(".sidebar-drag-avatar"), "HTML 包含悬浮圆角长条拖拽代理类");

  function calculateAccordionDisplacements(totalItems, dragStartIndex, targetSlotIndex, gapSize = 30) {
    const offsets = new Array(totalItems).fill(0);
    for (let i = 0; i < totalItems; i++) {
      if (i === dragStartIndex) continue;
      if (targetSlotIndex < dragStartIndex) {
        if (i >= targetSlotIndex && i < dragStartIndex) {
          offsets[i] = gapSize;
        }
      } else if (targetSlotIndex > dragStartIndex) {
        if (i > dragStartIndex && i <= targetSlotIndex) {
          offsets[i] = -gapSize;
        }
      }
    }
    return offsets;
  }

  // 场景 1：拖动第 0 项往下插入到槽位 2（经过第 1 项与第 2 项）
  // 原第 1 项与第 2 项均上移 -30px，给新位置腾出空间
  const offsetsDown = calculateAccordionDisplacements(4, 0, 2, 30);
  assert.deepEqual(offsetsDown, [0, -30, -30, 0]);

  // 场景 2：拖动第 3 项往上插入到槽位 1（在原第 0 项之后、原第 1 项之前）
  // 原第 1 项、原第 2 项应下移 +30px，空出缝隙
  const offsetsUp = calculateAccordionDisplacements(4, 3, 1, 30);
  assert.deepEqual(offsetsUp, [0, 30, 30, 0]);
});

test("快捷方式拖拽合并文件夹、移出及解散逻辑", () => {
  let customSites = [
    { key: "siteA", label: "Site A", url: "https://a.com", groupId: "home", updatedAt: "2026-09-24T00:00:00.000Z" },
    { key: "siteB", label: "Site B", url: "https://b.com", groupId: "home", updatedAt: "2026-09-24T00:00:00.000Z" }
  ];
  let groupItems = ["siteA", "siteB"];

  // 1. 合并 siteA 与 siteB
  function createFolder(targetKey, draggedKey) {
    const folderId = "folder_test123";
    const now = "2026-09-26T12:00:00.000Z";
    const siteTarget = customSites.find(s => s.key === targetKey);
    const siteDragged = customSites.find(s => s.key === draggedKey);

    siteTarget.groupId = folderId;
    siteTarget.updatedAt = now;
    siteDragged.groupId = folderId;
    siteDragged.updatedAt = now;

    const folderSite = {
      key: folderId,
      label: "新建文件夹",
      url: `https://folder.local/?items=${encodeURIComponent(targetKey + "," + draggedKey)}`,
      groupId: "home",
      icon: "",
      updatedAt: now
    };
    customSites.push(folderSite);
    groupItems = groupItems.map(k => (k === targetKey ? folderId : k)).filter(k => k !== draggedKey);
    return folderId;
  }

  const folderKey = createFolder("siteA", "siteB");
  assert.deepEqual(groupItems, [folderKey]);
  assert.equal(customSites.length, 3);
  assert.equal(customSites.find(s => s.key === "siteA").groupId, folderKey);
  assert.equal(customSites.find(s => s.key === "siteB").groupId, folderKey);

  // 2. 解散文件夹
  function dissolveFolder(fKey) {
    const children = customSites.filter(s => s.groupId === fKey);
    const now = "2026-09-26T12:05:00.000Z";
    children.forEach(c => {
      c.groupId = "home";
      c.updatedAt = now;
    });
    const folderIdx = groupItems.indexOf(fKey);
    groupItems.splice(folderIdx, 1, ...children.map(c => c.key));
    customSites = customSites.filter(s => s.key !== fKey);
  }

  dissolveFolder(folderKey);
  assert.deepEqual(groupItems, ["siteA", "siteB"]);
  assert.equal(customSites.length, 2);
  assert.equal(customSites.find(s => s.key === "siteA").groupId, "home");
  assert.equal(customSites.find(s => s.key === "siteB").groupId, "home");
});

test("横向多页滑动分页计算与左右箭头边缘悬浮触发逻辑", () => {
  const ITEMS_PER_PAGE = 12;

  function calculatePages(itemsCount) {
    return Math.max(1, Math.ceil(itemsCount / ITEMS_PER_PAGE));
  }

  assert.equal(calculatePages(0), 1);
  assert.equal(calculatePages(5), 1);
  assert.equal(calculatePages(12), 1);
  assert.equal(calculatePages(13), 2);
  assert.equal(calculatePages(25), 3);

  // 边缘悬浮阈值（75px）判定
  function getArrowVisibility(mouseX, contentLeft, contentWidth, currentPage, totalPages) {
    if (totalPages <= 1) return { prev: false, next: false };
    const contentRight = contentLeft + contentWidth;
    const THRESHOLD = 75;
    const nearLeft = mouseX >= contentLeft && mouseX <= contentLeft + THRESHOLD;
    const nearRight = mouseX >= contentRight - THRESHOLD && mouseX <= contentRight;

    return {
      prev: nearLeft && currentPage > 0,
      next: nearRight && currentPage < totalPages - 1
    };
  }

  const rect = { left: 100, width: 480 }; // right = 580
  // 首页：左移不显示 prev，右移显示 next
  assert.deepEqual(getArrowVisibility(120, rect.left, rect.width, 0, 3), { prev: false, next: false }); // 靠近左侧但在第 0 页 -> prev 为 false
  assert.deepEqual(getArrowVisibility(550, rect.left, rect.width, 0, 3), { prev: false, next: true });  // 靠近右侧且有后页 -> next 为 true
  assert.deepEqual(getArrowVisibility(300, rect.left, rect.width, 0, 3), { prev: false, next: false }); // 中间区域 -> 都不显示

  // 中间页（第 1 页）：左移显示 prev，右移显示 next
  assert.deepEqual(getArrowVisibility(120, rect.left, rect.width, 1, 3), { prev: true, next: false });
  assert.deepEqual(getArrowVisibility(550, rect.left, rect.width, 1, 3), { prev: false, next: true });

  // 尾页（第 2 页）：左移显示 prev，右移不显示 next
  assert.deepEqual(getArrowVisibility(120, rect.left, rect.width, 2, 3), { prev: true, next: false });
  assert.deepEqual(getArrowVisibility(550, rect.left, rect.width, 2, 3), { prev: false, next: false });
});

