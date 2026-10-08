# TablissNG Widgets 项目状态档案 (PROJECT_STATE.md)

> 📌 **单一事实源声明**：本项目采用根目录 `PROJECT_STATE.md` 作为项目当前状态的**唯一事实源（Single Source of Truth）**。  
> 任何新 AI（ChatGPT / Claude / Codex / Gemini 等）接手前，**必须首先读取本文件与 [`AGENTS.md`](AGENTS.md)**。

---

## 一、项目目标与组件体系

维护个人浏览器新标签页（TablissNG fork）的高性能、安全同步与离线韧性前端组件体系：

1. **核心嵌入组件（GitHub Pages 托管）**：
   - **VPS 监控器 (`index.html` / `tabliss/vps-widget.html`)**：展示服务器负载、内存、网络与状态；
   - **Apple 风格搜索框 (`search.html` / `tabliss/search-widget.html`)**：横向切换多搜索引擎，iframe 紧凑防穿透；
   - **分类快捷方式 (`shortcuts.html` / `tabliss/shortcuts-widget.html`)**：桌面式应用图标，支持拖拽排序、自定义分组、软删除回收站与右键定制。
2. **跨端加密同步系统 (`sync-model.js` & `worker/`)**：
   - 基于 Cloudflare Worker + GitHub App 架构；
   - 快捷方式配置通过 AES-256-GCM 算法在客户端完成端到端加密，密文同步存储至 `data/sync.enc.json`；
   - 采用 SHA 乐观并发控制锁（Optimistic Locking），防止多设备同时写入互相覆盖。
3. **离线韧性与版本化双缓存 (`sw.js`)**：
   - 通过 Service Worker 缓存图标与核心外壳资源，解决弱网或冷启动空白问题；
   - 严格采用带 `?v=` 版本号的配对缓存机制。

---

## 二、当前版本与分支状态

- **当前工作分支**：`main`
- **远端同步状态**：与 `origin/main` 保持对齐（工作区 clean）
- **主要分支状态说明**：
  - `main`：线上稳定分支，包含最新透明矢量图标优化、Worker v3 安全同步架构、v28 图标探测兜底修复与 AI-Project-Hub 规范治理；
  - `feature/shortcut-sync-safety`：PR #1 来源，同步模型加固、SHA 乐观锁与回收站（已合入 main）；
  - `feature/ui-glass-polish`：磨砂质感优化与侧边栏分组字重微调；
  - `feature/cold-start-resilience`：冷启动 Service Worker 外壳缓存加固与诊断页；
  - `feature/shortcuts-custom-groups-and-glass`：快捷方式分组与高分辨率图标管线。

---

## 三、实测验证基线 (2026-10-08 现场核验)

- **自动化单元测试**：运行 `npm test`，全套 **78/78 单元测试全部通过**（0 fail, 0 skipped）：
  - `tests/shortcuts-features.test.mjs`：测试 Apple 磨砂样式、高清图标解析管道、Google S2 16x16 假兜底过滤、多页滑动与分组拖拽算法（14 项子测试 pass）；
  - `tests/sync-model.test.mjs`：测试 AES-GCM 数据模型、版本升级（v1/v2/v3 兼容）、并发合并冲突解决、站点墓碑（tombstone）与回收站生命周期（67 项子测试 pass）；
  - `tests/worker.test.mjs`：测试 Cloudflare Worker 鉴权、409 冲突拦截、合法性校验、只读与写入隔离（10 项子测试 pass）。
- **静态安全验证**：测试用例显式断言“任何响应与异常均不回显同步口令、加密密钥或 GitHub 私钥”。
- **全分类图标全面对齐 Apple App Store 官方规范 (v33)**：
  - **全量升级覆盖**：全量覆盖所有具备 App Store 官方 App 的 52 款应用。新增涵盖 AI（Kimi、智谱清言、通义千问、豆包、秘塔写作猫、腾讯元宝）、搜索/工具（百度、Google、LocalSend）、游戏（SteamPY/匹歪、杉果游戏、Epic Games、3DM游戏、Oopz）、运营（抖音来客、抖音直播伴侣/专业版、巨量引擎、主播平台）及表情（闪萌表情），全量替换为 Apple App Store 官方 512×512 连续平滑圆角原画；
  - **AI 组全面统一**：ChatGPT、Claude、DeepSeek、Grok、Gemini、Kimi、智谱清言、通义千问、豆包、腾讯元宝、秘塔写作猫全量配齐官方 App Store 原版圆角图标；
  - **组件版本递增**：宿主引用组件版本递增至 `?v=33`，彻底穿透旧缓存，全站视觉质感对齐 iPadOS / macOS Launchpad 原生标准。

---

## 四、核心技术约定与铁律

1. **单一事实源与 Hub 规范**：
   本项目遵循 [AI-Project-Hub](https://github.com/o-ocn/AI-Project-Hub) 协作规范，以根目录 `PROJECT_STATE.md` 为唯一详细事实源（Hub 仅作索引），行为与交接流程详见 [`AGENTS.md`](AGENTS.md)。
2. **绝对禁止手动篡改同步密文**：
   `data/sync.enc.json` 为真实端到端加密书签数据，**严禁手工编辑、格式化或清空该文件**，所有变更必须经由客户端加密逻辑生成。
3. **禁止破坏 Git 历史**：
   严禁 `git reset --hard`、严禁强制推送（force push），保持分支树清晰可追溯。
4. **Service Worker 缓存版本配对准则**：
   - HTML、JS 与 SW 缓存键强绑定 `?v=` 参数；
   - 每次对 HTML 界面或脚本进行实质修改后，在引入处递增版本号（如 `?v=28`），确保客户端秒级拉取最新资源，杜绝缓存死锁。
5. **组件代码隔离**：
   `sync-model.js` 采用严格 IIFE 模式暴露 `window.TablissSyncModel`，避免与页面内联脚本命名空间污染。
6. **Public 仓库安全边界**：
   本项目为开源/公开仓库，**严禁提交任何个人 API Key、私钥正文、私人动态域名或未脱敏配置**。

---

## 五、下一步工作与接手指南

- **后续 AI 接手快速启动**：
  ```bash
  git status
  npm test
  ```
  确认 78 项测试 pass 后展开工作。
- **日常维护与收尾流转**：
  日常小修改以 `main` 分支为主；完成修改并验证后，就地更新本文件（`PROJECT_STATE.md`）并提交推送，工作树保持干净。如需改动同步算法或 Service Worker 逻辑，优先编写对应单元测试并保证 `npm test` 全绿后提交。

---

## 附：所有者偏好合入记录（2026-10-04）

- **变更性质**：规则与文档级变更（合入《所有者偏好与项目执行规则》母版适用条款），**非功能或服务实测**。
- **母版来源**：`AI-HUB/templates/OWNER_PREFERENCES.md`，导入版本 `2026-10-04 / v1`。
- **本次改动**：`AGENTS.md` 追加“所有者偏好（母版合入内容）”一节；本文档追加本记录。
- **最小修正**：无（既有规则与母版一致，未改动既有条款）。
- **未改动**：业务代码、生产配置、真实凭据文件的跟踪状态均未变更。
- **验证方式**：规则一致性人工核对（母版条款与既有规则逐条比对、去重合入）；无代码或服务实测。

