# 项目同步申请单 (AI_HUB_SYNC.md)

> 📌 **统一入口声明**：本项目采用本文件作为向 `AI-Project-Hub` 提交状态同步与索引更新的**标准入口文件**。  
> 存放位置：**必须存放在项目代码工程根目录**。

---

## 一、项目基础信息
- **项目名称**：TablissNG 前端组件 (`tablissng-widgets`)
- **项目物理路径 / 仓库地址**：`C:\Users\oocn\.zcode\workspace\default\tablissng-widgets` / `https://github.com/o-ocn/tablissng-widgets`
- **当前所处阶段**：生产稳定（长期维护阶段，v34 / vps-v10）
- **同步申请类型**：
  - [x] 状态增量更新 (State Update)
  - [x] 里程碑/阶段完成 (Milestone Completed)

---

## 二、提议 Hub 变更内容 (Proposed Hub Changes)
- **PROJECT_INDEX.md 拟更新项**：
  - 维护状态：生产稳定 (长期维护阶段，v34 / vps-v10)
  - 核心特征/说明更新：实现全设备静默自同步（v34），彻底消除副机/新浏览器手动输入 64 位同步口令负担；VPS 监控组件升级适配全新 VMISS-TRI 节点并配置双端高可用拉取（?v=10）；全量主流应用（52款）对齐 Apple App Store 官方 512×512 连续平滑圆角图标规范；客户端具备热更新自愈迁移能力；端到端加密同步正常；单元测试全绿（78 项全部通过）；严禁手改加密密文。
- **Hub 内项目状态指针 / 档案更新**：
  - 唯一事实源指针保持指向项目自身仓库 `PROJECT_STATE.md`；同步入口登记本文件 [`AI_HUB_SYNC.md`](file:///C:/Users/oocn/.zcode/workspace/default/tablissng-widgets/AI_HUB_SYNC.md)。

---

## 三、对应事实源文件与实测证据
> 📌 **填写原则（写“最近同步摘要”，不写长期固定事实）**：本节只写**本次同步的验证方式与结论**，严禁写入会随时间漂移的固定数字或状态。这类内容一律留在项目唯一事实源 `PROJECT_STATE.md` 中，本文件只保留指向它的指针，避免同步单自身过期。

- **项目唯一事实源**：[`PROJECT_STATE.md`](PROJECT_STATE.md)（已包含完整六大核心支柱）
- **核心实测证据摘要**：通过 `npm test` 自动化测试套件验证（覆盖静默自同步逻辑、VPS 外壳版本归一化缓存、Apple 磨砂样式、高清图标解析管道、AES-256-GCM 数据模型、版本兼容迁移与 Worker 乐观锁鉴权，78/78 单元测试全部通过）；全部分支变更已线性合入并推送到 `origin/main`，工作树 clean。

---

## 四、安全与合规声明
- [x] 已确认无任何密码、Token、Cookie、API Key、私钥或完整订阅 URL 具体值；
- [x] 已确认无 AI 聊天记录、推理思考过程或操作流水账；
- [x] 变更内容经实际运行验证通过，具备真实性。
