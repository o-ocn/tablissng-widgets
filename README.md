# TablissNG widgets

用于 TablissNG 新标签页的独立小组件。

- `index.html`：VPS 监控器
- `search.html`：Apple 风格搜索框
- `shortcuts.html`：分类快捷方式
- `sw.js`：快捷图标长期缓存
- `tabliss/vps-widget.html`：粘贴到 TablissNG 的 VPS 监控器 HTML
- `tabliss/search-widget.html`：粘贴到 TablissNG 自定义 HTML
- `tabliss/shortcuts-widget.html`：粘贴到 TablissNG 自定义 HTML
- `worker/`：快捷方式安全同步服务（Cloudflare Worker + GitHub App）

搜索引擎列表在搜索框内部横向展开，可以保持 iframe 为搜索栏高度，避免透明区域覆盖下面的快捷方式。

快捷图标由 Service Worker 缓存在当前浏览器中；VPS 监控器会先恢复上一次成功数据，再在后台请求最新状态。

搜索框嵌入地址使用：

```text
https://o-ocn.github.io/tablissng-widgets/search.html?v=13
```

快捷方式嵌入地址建议使用：

```text
https://o-ocn.github.io/tablissng-widgets/shortcuts.html?v=13
```

快捷方式支持：右键图标上传本地图片、填写 HTTPS 图片直链、恢复自动图标；右键空白区域可把新快捷方式添加到当前分类。自定义内容保存在浏览器本地。
