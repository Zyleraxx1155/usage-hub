// test/usage-hub-058.test.js — 0.5.8：余额自动刷新、输入构成移除、图标与布局
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import registerApiRoutes from "../routes/api.js";
import { tmpDir, cleanupTmpDirs } from "./helpers.js";

after(cleanupTmpDirs);

const panelSource = () => fs.readFileSync(new URL("../assets/panel.js", import.meta.url), "utf8");
const cssSource = () => fs.readFileSync(new URL("../assets/panel.css", import.meta.url), "utf8");
const indexSource = () => fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");

function appMock() { const handlers = {}; return { handlers, app: { get: (p, h) => handlers[`GET ${p}`] = h, post: (p, h) => handlers[`POST ${p}`] = h } }; }
function cMock() { return { req: { query: () => "", json: async () => ({}) }, json: (obj, code = 200) => ({ obj, code }) }; }

test("0.5.8: GET /balance 无快照时自动刷新，不再依赖前端 POST", async () => {
  const dir = tmpDir("balance-get-auto");
  let refreshCalls = 0;
  const balance = {
    snapshot: () => ({ sources: [], lastAttemptAt: null }),
    refresh: async () => { refreshCalls += 1; return { sources: [{ id: "deepseek", status: "ok", balance: 5 }], lastAttemptAt: new Date().toISOString() }; },
  };
  const { handlers, app } = appMock();
  registerApiRoutes(app, { _usageHub: { paths: { dataDir: dir }, balance } });
  const got = await handlers["GET /balance"](cMock());
  assert.equal(refreshCalls, 1, "无快照时应触发一次刷新");
  assert.equal(got.obj.sources[0].balance, 5);
});

test("0.5.8: 60 秒内的快照直接复用，不重复请求供应商", async () => {
  const dir = tmpDir("balance-get-cache");
  let refreshCalls = 0;
  const snapshot = { sources: [{ id: "deepseek", status: "ok", balance: 9 }], lastAttemptAt: new Date().toISOString() };
  const { handlers, app } = appMock();
  registerApiRoutes(app, { _usageHub: { paths: { dataDir: dir }, balance: { snapshot: () => snapshot, refresh: async () => { refreshCalls += 1; return snapshot; } } } });
  const got = await handlers["GET /balance"](cMock());
  assert.equal(refreshCalls, 0);
  assert.equal(got.obj.sources[0].balance, 9);
});

test("0.5.8: 插件启动即后台刷新一次余额", () => {
  assert.match(indexSource(), /state\.balance\.refresh\(\)\.catch/);
});

test("0.5.8: 页面输入构成卡移除，来源类型卡保留（widget 不受影响）", () => {
  const source = panelSource();
  assert.doesNotMatch(source, /id="chCompose"/, "页面输入构成卡应已移除");
  assert.match(source, /id="chSource"/);
  assert.match(source, /来源类型/);
  assert.match(source, /w-comp-track/, "widget 的输入构成条保留");
  assert.equal(source.split("输入构成").length - 1, 1, "「输入构成」字样仅剩 widget 一处");
});

test("0.5.8: 设置按钮改为 SVG 图标，图表卡改单列", () => {
  const source = panelSource();
  assert.doesNotMatch(source, />⚙</, "字符齿轮应替换为 SVG");
  assert.match(source, /id="settingsBtn"[\s\S]{0,160}<svg/);
  assert.match(cssSource(), /\.icon-btn \{ min-width:38px/);
  assert.match(cssSource(), /grid-template-columns: 1fr;\s*gap: 18px/);
});
