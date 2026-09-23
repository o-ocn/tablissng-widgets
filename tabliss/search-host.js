/*
  粘贴到 TablissNG 的“自定义 JavaScript”组件。

  搜索菜单关闭时，iframe 只有搜索栏高度；
  菜单打开时，按搜索框宽度等比例临时扩展。
*/

if (window.__tablissSearchMenuHandler) {
  window.removeEventListener(
    "message",
    window.__tablissSearchMenuHandler
  );
}

window.__tablissSearchMenuHandler = event => {
  if (
    event.origin !== "https://o-ocn.github.io"
    || event.data?.type !== "tabliss-search-menu-state"
  ) {
    return;
  }

  const frame = Array.from(
    document.querySelectorAll(
      'iframe[src*="o-ocn.github.io/vps-widget/search.html"]'
    )
  ).find(item => item.contentWindow === event.source);

  if (!frame) {
    return;
  }

  if (event.data.open) {
    const openHeight = Math.ceil(
      frame.getBoundingClientRect().width * 0.43
    );

    frame.style.height = `${openHeight}px`;
    frame.style.zIndex = "1000";
  }
  else {
    frame.style.height = "100%";
    frame.style.zIndex = "auto";
  }
};

window.addEventListener(
  "message",
  window.__tablissSearchMenuHandler
);
