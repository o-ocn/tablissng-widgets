# TablissNG widgets

用于 TablissNG 新标签页的独立小组件。

- `index.html`：VPS 监控器
- `search.html`：Apple 风格搜索框
- `shortcuts.html`：分类快捷方式
- `tabliss/search-widget.html`：粘贴到 TablissNG 自定义 HTML
- `tabliss/search-host.js`：粘贴到 TablissNG 自定义 JavaScript

搜索框的父级脚本会在菜单关闭时把 iframe 恢复为搜索栏高度，避免透明区域覆盖下面的快捷方式；打开菜单时才会按宽度等比例扩展 iframe。

快捷方式嵌入地址建议使用：

```text
https://o-ocn.github.io/vps-widget/shortcuts.html?v=4
```
