// routes/ui.js — usage-hub 页面壳（源自 session-insight routes/ui.js，已改标题与缓存参数）
const UI_CACHE_VERSION = "0.6.0";
export default function registerPluginUiRoutes(app, ctx) {
  app.get("/page", (c) => c.html(renderShell(c, ctx, "page")));
  app.get("/widget", (c) => c.html(renderShell(c, ctx, "widget")));
  app.get("/card", (c) => c.html(renderShell(c, ctx, "card")));
}

function renderShell(c, ctx, surface) {
  const hanaCss = c.req.query("hana-css") || "";
  const theme = c.req.query("hana-theme") || "inherit";
  const token = c.req.query("token") || "";
  const base = `/api/plugins/${encodeURIComponent(ctx.pluginId)}`;
  const title = "用量中心";
  const withToken = (url) => {
    const query = new URLSearchParams();
    query.set("usage_hub_v", UI_CACHE_VERSION);
    if (token) query.set("token", token);
    return `${url}${url.includes("?") ? "&" : "?"}${query}`;
  };
  const panelCss = withToken(`${base}/assets/panel.css`);
  const panelJs = withToken(`${base}/assets/panel.js`);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${hanaCss ? `<link id="hana-theme-css" rel="stylesheet" href="${escapeAttr(hanaCss)}">` : ""}
  <link rel="stylesheet" href="${escapeAttr(panelCss)}">
</head>
<body data-hana-theme="${escapeAttr(theme)}" data-surface="${surface}">
  <div id="root" data-surface="${surface}"></div>
  <script>
    window.addEventListener("error", function (e) {
      var root = document.getElementById("root");
      if (root && !root.innerHTML) {
        root.innerHTML = '<div class="empty">面板加载失败：' + (e.message || "脚本错误") + "</div>";
      }
    });
  </script>
  <script type="module" src="${escapeAttr(panelJs)}"></script>
</body>
</html>`;
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function escapeHtml(value) {
  return escapeAttr(value).replace(/>/g, "&gt;");
}
