// test/ui-routes.test.js — 页面壳（routes/ui.js）：标题、资源引用、鉴权参数透传
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import registerUiRoutes from "../routes/ui.js";

// 版本以 manifest 为准，避免每次发版都要手改断言
const MANIFEST_VERSION = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")).version;

function mockApp() {
  const handlers = {};
  return {
    handlers,
    app: {
      get(p, h) { handlers["GET " + p] = h; },
      post(p, h) { handlers["POST " + p] = h; },
    },
  };
}

function mockC(query = {}) {
  return {
    req: { query: (k) => query[k] ?? "" },
    json: (obj, code) => ({ obj, code: code ?? 200 }),
    html: (s) => s,
  };
}

test("ui: /page 与 /widget 渲染壳（标题用量中心、引用 assets 资源、主题与 token 透传）", () => {
  const { handlers, app } = mockApp();
  registerUiRoutes(app, { pluginId: "usage-hub" });

  for (const p of ["/page", "/widget", "/card"]) {
    const h = handlers["GET " + p];
    assert.ok(h, `缺少路由 GET ${p}`);
    const html = h(mockC({ "hana-theme": "midnight", token: "tok123" }));
    assert.ok(html.includes("<title>用量中心</title>"), "标题应为用量中心");
    assert.ok(html.includes("/api/plugins/usage-hub/assets/panel.css"), "应引用 panel.css");
    assert.ok(html.includes("/api/plugins/usage-hub/assets/panel.js"), "应引用 panel.js");
    const href = (pattern) => html.match(pattern)?.[1].replaceAll("&amp;", "&");
    const cssUrl = new URL(href(/<link rel="stylesheet" href="([^"]*panel\.css[^"]*)"/), "http://hana.local");
    const jsUrl = new URL(href(/<script type="module" src="([^"]*panel\.js[^"]*)"/), "http://hana.local");
    for (const url of [cssUrl, jsUrl]) { assert.equal(url.searchParams.get("usage_hub_v"), MANIFEST_VERSION); assert.equal(url.searchParams.get("token"), "tok123"); }
    assert.ok(html.includes("tok123"), "token 应透传到资源 URL");
    assert.ok(html.includes("data-hana-theme=\"midnight\""), "主题应写入 body 属性");
    assert.ok(html.includes('id="root"'), "应包含挂载点");
  }
});

test("ui: 无 token 时资源 URL 干净（不带空查询）", () => {
  const { handlers, app } = mockApp();
  registerUiRoutes(app, { pluginId: "usage-hub" });
  const html = handlers["GET /page"](mockC());
  const cssHref = html.match(/<link rel="stylesheet" href="([^"]*panel\.css[^"]*)"/)?.[1].replaceAll("&amp;", "&");
  const css = new URL(cssHref, "http://hana.local");
  assert.equal(css.searchParams.get("usage_hub_v"), MANIFEST_VERSION);
  assert.equal(css.searchParams.has("token"), false);
});
