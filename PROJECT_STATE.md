# TablissNG Widgets 项目状态档案 (PROJECT_STATE.md)

> 📌 **单一事实源声明**：本项目采用本文件作为项目当前状态的**唯一事实源（Single Source of Truth）**。  
> ⚠️ **强制规范**：**必须完整包含以下六大核心支柱（缺少任何一项视为不合格交接）**。任何新 AI 接手前必须首先阅读本文件，完成实质工作后必须就地更新本文件。

---

## 一、项目目标（为什么做 / 终态目标）

- **核心定位与痛点**：
  - 解决个人浏览器新标签页（TablissNG fork）多设备间快捷方式配置漂移、冷启动弱网白屏、应用图标分辨率模糊不均、第三方外链失效及私密书签云端同步安全痛点；
  - 提供轻量、高性能、高度契合 Apple 原生磨砂质感的前端组件体系。
- **长期终态目标**：
  - **核心嵌入组件（GitHub Pages 托管）**：
    - **分类快捷方式 (`shortcuts.html` / `tabliss/shortcuts-widget.html`)**：桌面式应用启动台，支持平滑拖拽排序、自定义分组、软删除回收站、端到端自愈迁移与右键定制；
    - **Apple 风格搜索框 (`search.html` / `tabliss/search-widget.html`)**：横向平滑切换多搜索引擎，iframe 紧凑防穿透；
    - **VPS 监控器 (`index.html` / `tabliss/vps-widget.html`)**：跨域展示服务器负载、内存、网络吞吐与健康状态。
  - **跨端加密同步系统 (`sync-model.js` & `worker/`)**：基于 Cloudflare Worker + GitHub App 架构，书签数据经客户端 AES-256-GCM 端到端加密后存入 `data/sync.enc.json`，依托 SHA 乐观锁实现冲突预防。
  - **离线韧性与版本化双缓存 (`sw.js`)**：通过 Service Worker 与版本号配对缓存，秒级冷启动并解决弱网白屏。

---

## 二、当前状态（做到哪里 / 运行事实）

- **当前阶段**：生产稳定（长期维护阶段，v33）
- **当前版本与分支**：`v33` / `main`（与 `origin/main` 保持对齐，工作树 clean）
- **核心组件运行事实**：
  - `shortcuts.html` 引入版本递增至 `?v=33`；
  - 线上 52 款具备官方 App 的主流应用已 100% 完成 Apple App Store 官方 512×512 连续平滑圆角图标覆盖；
  - 单元测试套件持续守护：全套 78 项自动化测试 100% pass。
- **当前采用方案与架构**：
  - 前端静态页面托管于 GitHub Pages，图标资产由独立图库 [`o-ocn/icons`](https://github.com/o-ocn/icons) 提供 CORS-free 高清直链；
  - 数据模型严格区分预设站点（`ORIGINAL_PRESET_ICONS`）与自定义覆盖（`iconOverrides` / `customSites`），启动时触发无感自愈迁移。

---

## 三、已完成事项（哪些已验证 / 成果证据）

- [x] **全分类图标全面对齐 Apple App Store 官方规范 (v33)**：
  - 全量覆盖所有具备 App Store 官方 App 的 52 款应用（AI、邮箱、社交、影音、网盘、购物、工具、游戏、运营、表情等），全量替换为 Apple 官方 512×512 平滑圆角原画（PNG 格式，外角透明），彻底移除不稳定第三方外链与模糊小图；
  - AI 组（ChatGPT、Claude、DeepSeek、Grok、Gemini、Kimi、智谱清言、通义千问、豆包、腾讯元宝、秘塔写作猫）全量对齐原生圆角视觉。
- [x] **客户端热更新自愈迁移机制**：`shortcuts.html` 启动时比对 `entry.icon !== presetIcon`，自动将旧外链更新为最新官方 PNG 图标，主动失效本地旧缓存并写回加密同步文档。
- [x] **Worker v3 端到端加密同步与乐观锁**：AES-GCM 数据模型、版本升级（v1/v2/v3 兼容）、并发 409 拦截、站点墓碑与回收站全周期管理。

### 实测验证记录
- **测试命令**：`npm test`
- **实测证据**：**78/78 单元测试全部通过（0 fail, 0 skipped）**：
  - `tests/shortcuts-features.test.mjs`：测试 Apple 磨砂样式、高清图标解析管道、Google S2 16x16 假兜底过滤、多页滑动与分组拖拽算法（14 项子测试 pass）；
  - `tests/sync-model.test.mjs`：测试 AES-GCM 数据模型、多版本兼容、并发合并冲突解决、站点墓碑与回收站清理（67 项子测试 pass）；
  - `tests/worker.test.mjs`：测试 Cloudflare Worker 鉴权、409 冲突拦截、合法性校验、只读与写入隔离（10 项子测试 pass）；
  - 静态安全断言：响应与异常显式不回显口令、密钥或私钥内容。

---

## 四、历史决策（为什么这么做 / 放弃过什么）

### 1. 关键技术决定与原因
- **决定 1：全量采用 Apple App Store 官方 512×512 连续平滑圆角原画（Squircle PNG）**  
  -> **原因**：第三方 Favicon（大多为 16×16 或 32×32）在高分屏磨砂毛玻璃背景下严重模糊发虚；Apple App Store 官方原图为 512×512 超清母版，应用 Apple 标准连续平滑圆角遮罩（`radius=115`，外角全透明）后，与 macOS / iPadOS Launchpad 视觉规范完美一致。
- **决定 2：iTunes Search API 按区域隔离获取官方资产**  
  -> **原因**：国内特色应用（哔哩哔哩、抖音、阿里云盘、夸克等）在 `country=cn` 下返回准确的高清正版原画；国际化应用（Discord、Reddit、Twitch、Notion 等）在 `country=us` 下检索，彻底消除噪音与版本偏差。
- **决定 3：配对版本号参数穿透（`?v=33`）**  
  -> **原因**：彻底穿透 Service Worker 运行时缓存及浏览器 HTTP 强缓存，用户硬刷新一次即可秒级完成全量图标与脚本升级。
- **决定 4：SHA 乐观并发锁控制**  
  -> **原因**：多台设备同时编辑书签时，后提交者收到 409 冲突，防止无条件覆盖云端新增数据造成书签丢失。

### 2. 已尝试但已放弃的方案（★ 严禁后续 AI 重复踩坑）
- **放弃方案 1：带有应用文字排版的官方横版/带字 Logo**  
  - *尝试背景*：部分模型初始检索到带有中文字体字样的图标底图（如带 "DeepSeek" 拼音、Grok 英文说明底板）。
  - *失败/放弃原因*：在 48×48 / 64×64 小组件启动台尺寸下，带文字的图标视觉极其拥挤局促、重心失衡，统一放弃并替换为纯正的官方独立圆角图标主体。
- **放弃方案 2：依赖第三方 Favicon 代理抓取（如 Google S2 或外部 CDN）**  
  - *尝试背景*：早期通过第三方 API 动态获取域名默认 favicon。
  - *失败/放弃原因*：国内访问极易被墙或超时，且 Google S2 对无图标网站会返回不可靠的 16×16 浅灰假球兜底图；现已全面放弃并收拢至 GitHub Pages 自建 `icons` 仓库集中托管。

---

## 五、未完成事项（Bug / 风险 / 待确认）

### 1. 已知缺陷与技术债 (Known Issues)
- 9 款纯垂直工具/网络论坛站点（阡陌居、搜书吧、老王论坛、其乐 Keylol、塔科夫官网、发表情、逗比拯救世界、斗图啦、颜文字）因无 App Store 独立 App，维持现有图标，后续若有高清矢量重绘诉求再行优化。

### 2. 待确认与排查事项 (Open Questions)
- 暂无阻塞项，线上生产环境稳定运行。

### 3. 边界约束与潜在风险
- **绝对禁止手动篡改同步密文**：`data/sync.enc.json` 为真实端到端加密书签数据，严禁手工编辑、格式化或清空该文件，所有变更必须经由客户端加密逻辑生成；
- **Public 仓库安全红线**：严禁提交任何个人 API Key、私钥正文或未脱敏配置；
- **Git 历史铁律**：严禁 `git reset --hard`、严禁强推（force push）。遇到远端 Worker 同步提交时，使用 `git fetch` + `git rebase origin/main` 保持线性历史。

---

## 六、下一步计划（从哪里继续 / 具体工作）

1. **后续 AI 接手快速启动**：
   ```bash
   git status
   npm test
   ```
   确认 78 项测试 pass 后展开工作。
2. **日常维护与新图标收录规范**：
   若后续在 `shortcuts.html` 新增预设快捷方式，优先通过 iTunes Search API 查询官方 512×512 原画，经 GDI+ 连续平滑圆角裁切后入库至 [`icons`](https://github.com/o-ocn/icons)，同步更新 `shortcuts.html` 字典并递增小组件版本号。

---

## 附录：工程资产与安全规范

### 1. 关键文件与配置清单
| 路径 | 宿主 / 仓库 | 用途说明 |
| :--- | :---: | :--- |
| `shortcuts.html` | 本地 / GitHub Pages | 快捷方式主页面，内含预设字典、拖拽、回收站与自愈逻辑 |
| `tabliss/shortcuts-widget.html` | 本地 / GitHub Pages | 宿主 Tabliss 嵌入代码，维护版本号参数（`?v=33`） |
| `sync-model.js` | 本地 / GitHub Pages | AES-256-GCM 端到端加密模型与墓碑合并逻辑 |
| `worker/worker.js` | 本地 / Cloudflare Worker | 跨设备同步后端网关，负责鉴权与 SHA 乐观锁控制 |
| `data/sync.enc.json` | 本地 / GitHub | 端到端加密书签存储密文（严禁人工篡改） |
| `AI_HUB_SYNC.md` | 本地工程根目录 | AI-Project-Hub 标准同步申请入口文件 |

### 2. 安全与凭据管理
- 凭据存储位置：Cloudflare Worker 环境变量与 GitHub App Secrets；
- 红线：严禁在本文档或代码中记录任何真实 Secret / 密码 / Key 明文。

### 3. 所有者偏好合入记录 (2026-10-04)
- **母版来源**：`AI-HUB/templates/OWNER_PREFERENCES.md`，导入版本 `2026-10-04 / v1`；
- **合入位置**：`AGENTS.md` 顶部来源标记与所有者偏好正文章节，保持规则一致性。
