import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { datePresetRange } from "../lib/date-presets.js";
import { aggregateEntries } from "../lib/aggregate.js";
import { validateAndSave, publicSettings } from "../lib/settings.js";
import { resolveCurrentSession } from "../lib/session-reader.js";
import registerApiRoutes from "../routes/api.js";
import { tmpDir, cleanupTmpDirs } from "./helpers.js";

after(cleanupTmpDirs);

const now = new Date("2026-09-09T05:00:00Z");

test("date presets use Asia/Shanghai and default today", () => {
  assert.deepEqual(datePresetRange("today", now), { from: "2026-09-09", to: "2026-09-09" });
  assert.deepEqual(datePresetRange("yesterday", now), { from: "2026-09-08", to: "2026-09-08" });
  assert.deepEqual(datePresetRange("week", now), { from: "2026-09-07", to: "2026-09-09" });
  assert.deepEqual(datePresetRange("month", now), { from: "2026-09-01", to: "2026-09-09" });
  assert.deepEqual(datePresetRange("year", now), { from: "2026-01-01", to: "2026-09-09" });
});

test("hidden agents/models are filtered before every aggregate", () => {
  const entry = (agentId, modelId, totalTokens) => ({ startedAt: "2026-09-09T01:00:00Z", attribution: { agentId }, model: { modelId, provider: "p" }, usage: { input: { totalTokens: totalTokens, uncachedTokens: totalTokens }, output: { totalTokens: 0 }, totalTokens } });
  const result = aggregateEntries([entry("a", "m1", 10), entry("b", "m2", 20)], { hiddenAgents: ["a"], hiddenModels: [] });
  assert.equal(result.summary.totalTokens, 20);
  assert.deepEqual(result.byAgent.map((x) => x.agentId), ["b"]);
});

test("display hidden lists persist as independent items", () => {
  const dir = tmpDir("usage-hub-settings");
  const saved = validateAndSave(dir, { display: { hiddenAgents: ["a", "a"], hiddenModels: ["m2"] } });
  assert.deepEqual(saved.display.hiddenAgents, ["a"]);
  assert.deepEqual(publicSettings(dir).display.hiddenModels, ["m2"]);
});

test("current session resolver skips incomplete candidates and never falls back to ctx.sessionPath", () => {
  assert.equal(resolveCurrentSession({ sessionPath: "/tmp/arbitrary.jsonl" }), null);
  assert.deepEqual(resolveCurrentSession({ currentSession: {}, focusedSession: { path: "C:\\\\sessions\\\\focus.jsonl", agentId: "a" } }), { sessionId: "focus", agent: "a", file: "focus.jsonl" });
  assert.deepEqual(resolveCurrentSession({}, { id: "s1", agent: "a", path: "/safe/one.jsonl" }), { sessionId: "s1", agent: "a", file: "one.jsonl" });
});

test("current-session API uses explicit query identity and a safe ctx.sessionPath fallback", () => {
  const dir = tmpDir("usage-hub-current");
  fs.writeFileSync(`${dir}/focus.jsonl`, [{ type: "session", id: "focus", agentId: "alpha", timestamp: "2026-09-09T01:00:00Z" }, { type: "message", id: "entry-focus", message: { role: "user", id: "entry-focus", content: "focus" } }, { type: "message", message: { role: "assistant", model: "m", usage: { input: { totalTokens: 1 }, output: { totalTokens: 1 } } } }].map(JSON.stringify).join("\n"));
  const handlers = {}; const app = { get: (path, handler) => { handlers[`GET ${path}`] = handler; }, post: (path, handler) => { handlers[`POST ${path}`] = handler; } };
  const ctx = { sessionPath: `${dir}/focus.jsonl`, _usageHub: { paths: { sessionsDir: dir, dataDir: dir } } }; registerApiRoutes(app, ctx);
  for (const route of ["status", "summary", "daily", "hourly", "by-agent", "by-model", "by-provider", "by-type", "coverage", "sessions", "resolve-entry", "current-session", "session-detail", "settings", "balance"]) {
    assert.ok(handlers[`GET /api/${route}`], `missing canonical plugin GET /api/${route}`);
    assert.ok(handlers[`GET /${route}`], `missing legacy plugin GET /${route}`);
  }
  for (const route of ["refresh", "settings", "balance/refresh"]) {
    assert.ok(handlers[`POST /api/${route}`], `missing canonical plugin POST /api/${route}`);
    assert.ok(handlers[`POST /${route}`], `missing legacy plugin POST /${route}`);
  }
  const c = (query) => ({ req: { query: (key) => query[key] || "" }, json: (obj) => obj });
  assert.equal(handlers["GET /current-session"](c({ noFocusedSession: "1" })).reason, "no_focused_session");
  assert.equal(handlers["GET /current-session"](c({})).source, "ctx-session-path");
  assert.equal(handlers["GET /current-session"](c({})).session.file, "focus.jsonl");
  assert.equal(handlers["GET /current-session"](c({ sessionId: "focus", agent: "alpha", file: "/unsafe/../focus.jsonl" })).session.file, "focus.jsonl");
  assert.equal(handlers["GET /resolve-entry"](c({ entryId: "entry-focus" })).file, "focus.jsonl");
  assert.equal(handlers["GET /resolve-entry"](c({ entryId: "../unsafe" })).error, "entry_not_found");
});

test("frontend separates widget current-session API from global loader and hides badge/date inputs", () => {
  const source = fs.readFileSync(new URL("../assets/panel.js", import.meta.url), "utf8");
  const widget = source.slice(source.indexOf("async function renderWidget()"), source.indexOf("/* ── page ── */"));
  assert.match(widget, /getCurrentSession/);
  assert.doesNotMatch(widget, /await loadAllData\(\)/);
  assert.doesNotMatch(source, /id="modelBadge"/);
  assert.doesNotMatch(source, /id="fFrom"|id="fTo"/);
  assert.match(source, /data-preset="today"/);
  assert.match(source, /settingsDrawer/);
  assert.match(source, /hiddenAgents/);
  assert.match(source, /filter\(\(s\) => s\.configured\)/);
  assert.match(source, /balanceSource|quotaSource/);
  assert.match(source, /SourceFilter/);
  assert.match(source, /state\[filterKey\] = event\.target\.value/);
  assert.match(source, /focusFromHostPayload/);
  assert.match(source, /sessionId.*agent.*file/);
  assert.match(source, /xLabels: hours\.map/);
  assert.match(widget, /discoverFocusedSession/);
  assert.doesNotMatch(source.slice(source.indexOf("/* ── page ── */")), /sessions|session-detail|getSessions|getSessionDetail|sessionDetail|session-group/);
});

test("backend API routes keep canonical /api paths and legacy aliases", () => {
  const source = fs.readFileSync(new URL("../routes/api.js", import.meta.url), "utf8");
  assert.match(source, /registerGet\("summary"/);
  assert.match(source, /app\.get\(`\/api\/\$\{path\}`/);
  assert.match(source, /app\.get\(`\/\$\{path\}`/);
  assert.match(source, /app\.post\(`\/api\/\$\{path\}`/);
  assert.match(source, /app\.post\(`\/\$\{path\}`/);
});

test("aggregate exposes latency/errors on every public bucket with fixed latency bins", () => {
  const base = { source: { subsystem: "session" }, attribution: { agentId: "a" }, model: { modelId: "m", provider: "p" }, usage: { input: { totalTokens: 100, uncachedTokens: 50 }, cache: { readTokens: 50 }, output: { totalTokens: 40 }, totalTokens: 190 } };
  const entries = [
    { ...base, startedAt: "2026-09-09T01:00:00Z", durationMs: 50, status: "ok" },
    { ...base, startedAt: "2026-09-09T02:00:00Z", durationMs: 750, status: "error", usage: { ...base.usage, output: { totalTokens: 80 }, totalTokens: 230 } },
    { ...base, startedAt: "2026-09-09T03:00:00Z", durationMs: 2500, status: "failed", usage: { ...base.usage, output: { totalTokens: 100 }, totalTokens: 250 } },
    { ...base, startedAt: "2026-09-09T04:00:00Z", durationMs: 0, status: "ok" },
  ];
  const result = aggregateEntries(entries);
  for (const bucket of [result.summary, result.byType[0], result.byAgent.find((x) => x.agentId === "a"), result.byModel[0], result.byProvider[0], result.daily[0]]) {
    assert.ok(bucket, "expected public bucket");
    // 0.5.16：延迟只保留 durationMs >= 2（0/1ms 计时缺失剔除），不再计算吞吐（改由 speed-stats 加权口径）。
    assert.equal(bucket.latency.n, 3);
    assert.equal(bucket.latency.avg, (50 + 750 + 2500) / 3);
    assert.equal(bucket.errors, 2);
    assert.deepEqual(bucket.latency.buckets, { "0-99ms": 1, "100-499ms": 0, "500-999ms": 1, "1-2s": 0, "2-5s": 1, "5-10s": 0, "10s+": 0 });
    assert.ok(!Array.isArray(bucket.latency.buckets));
  }
  assert.equal(result.daily[0].byType.session.totalTokens, result.daily[0].totalTokens);
  const hourly = result.hourlyByDay["2026-09-09"][9];
  assert.equal(hourly.latency.n, 1);
  assert.equal(hourly.latency.avg, 50);
  assert.equal(hourly.errors, 0);
  assert.equal(hourly.byType.session.totalTokens, hourly.totalTokens);
  assert.equal(result.summary.hitRatio, 0.5);
  assert.equal(result.byAgent[0].latency.avg, (50 + 750 + 2500) / 3);
});

test("aggregate: migrated or missing status is not counted as error", () => {
  const usage = { input: { totalTokens: 1, uncachedTokens: 1 }, cache: { readTokens: 0 }, output: { totalTokens: 1 }, totalTokens: 2 };
  const entries = [
    { source: { subsystem: "session" }, status: null, usage },
    { source: { subsystem: "session" }, usage },
    { source: { subsystem: "session" }, status: "failed", usage },
  ];
  assert.equal(aggregateEntries(entries).summary.errors, 1);
});

test("backend API exposes resolve-entry and page loader does not request sessions", () => {
  const source = fs.readFileSync(new URL("../routes/api.js", import.meta.url), "utf8");
  assert.match(source, /registerGet\("resolve-entry"/);
  const panel = fs.readFileSync(new URL("../assets/panel.js", import.meta.url), "utf8");
  const pageLoader = panel.slice(panel.indexOf("async function loadAllData()"), panel.indexOf("/* ── 常量与颜色 ── */"));
  assert.doesNotMatch(pageLoader, /getSessions\(|getSessionDetail\(|renderSessionDetail/);
  assert.doesNotMatch(panel, /sessionDetail|selectedSession|id=\\"sessionDetail\\"/);
  assert.doesNotMatch(panel.slice(panel.indexOf("async function renderPage()")), /session-detail-card/);
  assert.match(panel, /messages\.filter\(\(item\) => item\?\.entryId \|\| item\?\.id\)\.at\(-1\)/);
  const index = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.doesNotMatch(index, /sessionDetail|session-detail-card/);
});

test("panel API helpers use canonical /api plugin paths and preserve host API path", () => {
  const source = fs.readFileSync(new URL("../assets/panel.js", import.meta.url), "utf8");
  for (const route of ["summary", "daily", "hourly", "by-agent", "by-model", "by-provider", "by-type", "status", "settings", "balance", "current-session", "resolve-entry"]) {
    assert.match(source, route === "hourly" ? /\/api\/hourly/ : new RegExp(`fetchJson\\(\\"/api/${route}`), `missing canonical plugin /api/${route}`);
  }
  assert.match(source, /fetchJson\("\/api\/balance\/refresh/);
  assert.doesNotMatch(source, /fetchJson\(\s*["']\/(?!api\/)/, "plugin fetchJson must use /api/ prefix");
  assert.match(source, /new URL\("\/api\/sessions\/messages"/);
  assert.match(source, /fetch\(url/);
  assert.match(source, /postJson\("\/api\/settings"/);
  assert.match(source, /assets\/panel\.js/);
  assert.match(source, /byType/);
  assert.match(source, /Token 平均速率/);
});

// 背景：Hana 宿主加载插件模块时只给入口文件加 ?t=<时间戳> 做 cache-bust（bundle/index.js
// 的 Yu()），入口文件内部的相对 import 会命中 Node 的 ESM 模块缓存。若不带版本参数，
// 插件更新后仍会拿到旧版 lib，报 "does not provide an export named ..."，使整个路由模块
// 加载失败、所有数据接口 404。因此所有内部相对 import 必须携带 ?v=<manifest.version>。
test("plugin internal imports carry manifest version so Hana cannot serve stale lib modules", () => {
  const root = new URL("..", import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", root), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(new URL("package.json", root), "utf8"));
  const uiSource = fs.readFileSync(new URL("routes/ui.js", root), "utf8");

  assert.equal(pkg.version, manifest.version, "package.json 与 manifest.json 版本必须一致");
  assert.match(
    uiSource,
    new RegExp(`UI_CACHE_VERSION = "${manifest.version.replaceAll(".", "\\.")}"`),
    "routes/ui.js 的 UI_CACHE_VERSION 必须等于 manifest 版本"
  );

  const files = [
    "index.js",
    ...fs.readdirSync(new URL("routes", root)).filter((f) => f.endsWith(".js")).map((f) => `routes/${f}`),
    ...fs.readdirSync(new URL("lib", root)).filter((f) => f.endsWith(".js")).map((f) => `lib/${f}`),
  ];
  const expectedSuffix = `.js?v=${manifest.version}`;
  let checked = 0;
  for (const file of files) {
    const source = fs.readFileSync(new URL(file, root), "utf8");
    for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      const spec = match[1];
      if (!spec.startsWith(".")) continue; // node: 内置与裸包名不参与
      checked++;
      assert.ok(
        spec.endsWith(expectedSuffix),
        `${file} 的相对 import "${spec}" 必须带 ?v=${manifest.version}，否则会命中 Hana 旧模块缓存`
      );
    }
  }
  assert.ok(checked >= 10, `应检查到足够多的内部 import，实际 ${checked}`);
});

test("page loader surfaces API failure instead of spinning forever", () => {
  const source = fs.readFileSync(new URL("../assets/panel.js", import.meta.url), "utf8");
  // 错误信息带上接口路径与状态码
  assert.match(source, /HTTP \$\{res\.status\} · \$\{path\}/);
  // 统一错误态与重试入口
  assert.match(source, /load-error/);
  assert.match(source, /id="loadRetry"/);
  // 清掉仍停留在“加载中…”的图表占位
  assert.match(source, /textContent\.includes\("加载中"\)/);
  assert.match(source, /加载失败/);
  // 失败时刷新按钮反馈失败，不再一律显示“已刷新”
  assert.match(source, /setLoading\(false, ok\)/);
});
