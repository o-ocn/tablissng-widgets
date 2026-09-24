# TablissNG 安全同步 Worker

这个 Worker 为快捷方式页面提供跨浏览器同步：

1. 浏览器使用单独的同步密码访问 Worker。
2. Worker 使用 AES-256-GCM 加密快捷方式和自定义图标。
3. Worker 通过仅授权本仓库的 GitHub App，把密文写入 `data/sync.enc.json`。
4. GitHub App 私钥、同步密码和加密密钥只保存在 Cloudflare Secret 中。

公开仓库中只能看到加密后的数据，不能直接读取快捷方式内容。

## Cloudflare 普通变量

- `ALLOWED_ORIGIN=https://o-ocn.github.io`
- `GITHUB_OWNER=o-ocn`
- `GITHUB_REPO=tablissng-widgets`
- `GITHUB_BRANCH=main`
- `GITHUB_DATA_PATH=data/sync.enc.json`

## Cloudflare 加密变量

- `SYNC_SECRET`
- `DATA_ENCRYPTION_KEY`（32 字节随机值的 Base64）
- `GITHUB_APP_ID`
- `GITHUB_INSTALLATION_ID`
- `GITHUB_PRIVATE_KEY`

不要把这些加密变量的值提交到 GitHub。
