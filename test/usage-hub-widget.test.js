// test/usage-hub-widget.test.js — 0.5.17 增量：widget 今日概览降级、今日模型速率、页面本地快照首屏
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allAgentSessionDirs, latestActiveSession, sessionTitleMap } from "../lib/session-reader.js";
import { tmpDir, cleanupTmpDirs } from "./helpers.js";

after(cleanupTmpDirs);
import registerApiRoutes from "../routes/api.js";

const ROOT = new URL("..", import.meta.url);
const panelSource = () => fs.readFileSync(new URL("assets/panel.js", ROOT), "utf8");
const cssSource = () => fs.readFileSync(new URL("assets/panel.css", ROOT), "utf8");
const widgetSource = () => {
  const source = panelSource();
  return source.slice(source.indexOf("async function renderWidget()"), source.indexOf("/* ── page ── */"));
};

test("widget 无当前会话时降级为今日概览，且不破坏有会话渲染", () => {
  const widget = widgetSource();
  // 降级分支
  assert.match(widget, /renderWidgetTodayOverview/);
  assert.match(widget, /今日概览/);
  assert.match(widget, /今日端到端速率/);
  assert.match(widget, /widgetReasonText\(reason\)/);
  assert.match(widget, /metaEl\.title = probeTitle/);
  assert.match(widget, /fetchJson\(`\/api\/summary\?from=\$\{today\}&to=\$\{today\}`\)/);
  assert.match(widget, /todaySpeed\?\.speed\?\.tps/);
  // 有会话路径保留
  assert.match(widget, /getCurrentSession/);
  assert.match(widget, /discoverFocusedSession/);
  assert.match(widget, /\.w-title"\)\.textContent = d\.title/);
  assert.doesNotMatch(widget, /await loadAllData\(\)/);
  // 当前会话模型速率区块
  assert.match(widget, /当前会话模型速率/);
  assert.match(widget, /id="wSpeedModel"/);
  assert.match(widget, /renderWidgetModelSpeed/);
});

test("widget 模型速率卡片：按模型列表逐项取速率，列表为空退回 byModel", () => {
  const source = panelSource();
  const decl = source.match(/function widgetSpeedRows\(models, byModel\) \{[\s\S]*?\n\}/);
  assert.ok(decl, "应存在 widgetSpeedRows");
  const rows = new Function(`${decl[0]}; return widgetSpeedRows;`)();
  const byModel = [{ model: "a", tps: 10 }, { model: "b", tps: 50 }, { model: "c", tps: null }];
  assert.deepEqual(rows(["b", "a"], byModel), [{ model: "b", tps: 50 }, { model: "a", tps: 10 }], "按会话模型顺序");
  assert.deepEqual(rows(["c"], byModel), [{ model: "c", tps: null }], "无速率显示 null");
  assert.deepEqual(rows(["x"], byModel), [{ model: "x", tps: null }]);
  assert.deepEqual(rows([], byModel), [{ model: "a", tps: 10 }, { model: "b", tps: 50 }], "空列表退回 byModel");
  assert.deepEqual(rows([], []), []);
  // 卡片式渲染 + 绿色速率
  assert.match(source, /class="w-speed-cell"/);
  assert.match(source, /class="w-speed-name"/);
  assert.match(source, /class="w-speed-val"/);
  assert.match(source, /r\.tps == null \? "–" : r\.tps \+ " tok\/s"/);
  assert.match(cssSource(), /\.w-speed-val \{[^}]*color: var\(--green\)/);
});

test("widget 上下文占用显示百分比（一位小数），无数据显示 –", () => {
  const source = panelSource();
  assert.match(source, /daysEl\.textContent = lastTurn \? ctxPct\.toFixed\(1\) \+ "%" : "–"/);
  assert.match(source, /daysEl\.title = "最近一轮输入 \+ 缓存读取 ÷ 模型上下文窗口"/);
  assert.match(source, /<b id="wDays">–<\/b>/);
  assert.doesNotMatch(source, /<b id="wDays">不可用<\/b>/);
});

test("widget 降级态文案随 reason 变化，并带探测过程 title", () => {
  const source = panelSource();
  const decl = source.match(/function widgetReasonText\(reason\) \{[\s\S]*?\n\}/);
  assert.ok(decl, "应存在 widgetReasonText");
  const map = new Function(`${decl[0]}; return widgetReasonText;`)();
  assert.equal(map("no_focused_session"), "宿主未提供当前会话");
  assert.equal(map("focused_session_unavailable"), "会话文件读取失败");
  assert.equal(map("something_else"), "something_else", "未知 reason 显示原始字符串");
  assert.equal(map(""), "当前会话不可用");
  assert.equal(map(undefined), "当前会话不可用");
  // probe title 含 HTTP 状态 / origin / entryId / 解析文件
  assert.match(source, /宿主 \/api\/sessions\/messages：HTTP \$\{probe\.httpStatus/);
  assert.match(source, /origin \$\{probe\.origin \|\| "–"\}/);
  assert.match(source, /origin: window\.location\.origin/);
  assert.match(source, /entryId \$\{probe\.entryId \? "已获取" : "未获取"\}/);
  assert.match(source, /解析文件 \$\{probe\.file \|\| "–"\}/);
  // 降级行显示 source / 探测小字
  assert.match(source, /const reasonText = widgetReasonText\(reason\)/);
  assert.match(source, /source === "latest-session" \? "按最近活跃会话推断"/);
  // discoverFocusedSession 带回 probe
  assert.match(source, /probe\.httpStatus = res\.status/);
  assert.match(source, /probe\.entryId = entryId \|\| ""/);
  assert.match(source, /probe\.file = mapped\?\.file \|\| ""/);
});

test("current-session：source 取值与 ctx.sessionPath 路径兜底", () => {
  const root = tmpDir("uh-cspath");
  const agentsRoot = path.join(root, "agents");
  const hanako = path.join(agentsRoot, "hanako", "sessions");
  fs.mkdirSync(hanako, { recursive: true });
  fs.writeFileSync(path.join(hanako, "s.jsonl"), [
    JSON.stringify({ type: "session", id: "s1", agentId: "hanako", timestamp: "2026-09-09T01:00:00Z" }),
    JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
    JSON.stringify({ type: "message", message: { role: "assistant", model: "m", usage: { input: { totalTokens: 1 }, output: { totalTokens: 1 } } } }),
  ].join("\n"));
  // 该用例专测 query/config/ctx-session-path，把文件置为陈旧，避免 latest-session 兜底干扰
  const oldSec = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(path.join(hanako, "s.jsonl"), oldSec, oldSec);

  const prev = process.env.HANA_HOME;
  process.env.HANA_HOME = root;
  try {
    const handlers = {};
    const app = { get: (p, h) => { handlers[`GET ${p}`] = h; }, post: (p, h) => { handlers[`POST ${p}`] = h; } };
    const mkCtx = (extra = {}) => ({ sessionPath: path.join(hanako, "s.jsonl"), _usageHub: { paths: { sessionsDir: hanako, dataDir: hanako }, data: { entries: [] } }, ...extra });
    const c = (query = {}) => ({ req: { query: (k) => query[k] || "" }, json: (o) => o });

    // 无任何来源 → none
    registerApiRoutes(app, mkCtx({ sessionPath: null }));
    let r = handlers["GET /current-session"](c({}));
    assert.equal(r.source, "none");
    assert.equal(r.reason, "no_focused_session");
    assert.deepEqual(r.sessionKeys, ["sessionPath"], "source=none 时列出 ctx 上带 session/path/focus 的 key");

    // ctx.sessionPath 路径兜底命中
    registerApiRoutes(app, mkCtx());
    r = handlers["GET /current-session"](c({}));
    assert.equal(r.source, "ctx-session-path");
    assert.equal(r.available, true);
    assert.equal(r.session.sessionId, "s1");

    // 显式 query 优先
    r = handlers["GET /current-session"](c({ sessionId: "s1", agent: "hanako", file: "s.jsonl" }));
    assert.equal(r.source, "query");
    assert.equal(r.available, true);

    // ctx 声明的焦点 → config（优先于 ctx.sessionPath）
    registerApiRoutes(app, mkCtx({ currentSession: { sessionId: "s1", agent: "hanako", file: "s.jsonl" } }));
    r = handlers["GET /current-session"](c({}));
    assert.equal(r.source, "config");
    assert.equal(r.available, true);

    // noFocusedSession=1 时不走兜底
    r = handlers["GET /current-session"](c({ noFocusedSession: "1" }));
    assert.equal(r.source, "none");

    // 非法路径被拒：越界
    registerApiRoutes(app, mkCtx({ sessionPath: "/etc/hosts.jsonl" }));
    assert.equal(handlers["GET /current-session"](c({})).source, "none");
    // 非 .jsonl
    registerApiRoutes(app, mkCtx({ sessionPath: path.join(hanako, "s.txt") }));
    assert.equal(handlers["GET /current-session"](c({})).source, "none");
    // 允许根目录之外的 .jsonl
    const outside = path.join(root, "outside.jsonl");
    fs.writeFileSync(outside, "{}");
    registerApiRoutes(app, mkCtx({ sessionPath: outside }));
    assert.equal(handlers["GET /current-session"](c({})).source, "none");
  } finally {
    if (prev === undefined) delete process.env.HANA_HOME; else process.env.HANA_HOME = prev;
  }
});

test("current-session/resolve-entry 扩展到各 agent 的 sessions 目录", () => {
  const root = tmpDir("uh-multiagent");
  const agentsRoot = path.join(root, "agents");
  const hanakoSessions = path.join(agentsRoot, "hanako", "sessions");
  const otherSessions = path.join(agentsRoot, "cece-engineer", "sessions");
  fs.mkdirSync(hanakoSessions, { recursive: true });
  fs.mkdirSync(otherSessions, { recursive: true });
  const entryId = "entry-other-1";
  fs.writeFileSync(path.join(otherSessions, "s.jsonl"), [
    JSON.stringify({ type: "session", id: "s-other", agentId: "cece-engineer", timestamp: "2026-09-09T01:00:00Z" }),
    JSON.stringify({ type: "message", id: entryId, message: { role: "user", id: entryId, content: "hi" } }),
    JSON.stringify({ type: "message", message: { role: "assistant", model: "m", usage: { input: { totalTokens: 1 }, output: { totalTokens: 1 } } } }),
  ].join("\n"));

  const prev = process.env.HANA_HOME;
  process.env.HANA_HOME = root;
  try {
    const handlers = {};
    const app = { get: (p, h) => { handlers[`GET ${p}`] = h; }, post: (p, h) => { handlers[`POST ${p}`] = h; } };
    const ctx = { _usageHub: { paths: { sessionsDir: hanakoSessions, dataDir: hanakoSessions }, data: { entries: [] } } };
    registerApiRoutes(app, ctx);
    const c = (query = {}) => ({ req: { query: (k) => query[k] || "" }, json: (obj) => obj });

    const resolved = handlers["GET /resolve-entry"](c({ entryId }));
    assert.equal(resolved.ok, true, "应能在其他 agent 目录找到 entryId");
    assert.equal(resolved.file, "s.jsonl");
    assert.equal(resolved.agent, "cece-engineer");

    const cs = handlers["GET /current-session"](c({ sessionId: "s-other", agent: "cece-engineer", file: "s.jsonl" }));
    assert.equal(cs.available, true, "应能读取其他 agent 的会话");
    assert.equal(cs.session.sessionId, "s-other");
    assert.equal(cs.session.agent, "cece-engineer");
  } finally {
    if (prev === undefined) delete process.env.HANA_HOME; else process.env.HANA_HOME = prev;
  }
});

test("allAgentSessionDirs 只返回各 agent 的 sessions 目录", () => {
  const root = tmpDir("uh-agentdirs");
  const agentsRoot = path.join(root, "agents");
  for (const sub of ["sessions", "subagent-sessions", "activity", "workflow-sessions"]) fs.mkdirSync(path.join(agentsRoot, "hanako", sub), { recursive: true });
  fs.mkdirSync(path.join(agentsRoot, "manman", "sessions"), { recursive: true });
  const dirs = allAgentSessionDirs(agentsRoot);
  assert.deepEqual(dirs.map((d) => path.basename(path.dirname(d))).sort(), ["hanako", "manman"]);
  assert.ok(dirs.every((d) => d.endsWith("/sessions")));
  assert.ok(!dirs.some((d) => d.includes("subagent-sessions") || d.includes("activity") || d.includes("workflow-sessions")));
});

test("latestActiveSession：取 30 分钟内 mtime 最新，超窗/不存在不取", () => {
  const dir = tmpDir("uh-latest");
  const now = Date.now();
  const write = (name, mtimeMs) => { const p = path.join(dir, name); fs.writeFileSync(p, "{}"); fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000); };
  write("old.jsonl", now - 60 * 60 * 1000);
  write("fresh.jsonl", now - 60 * 1000);
  write("newer.jsonl", now - 10 * 1000);
  write("notjson.txt", now);
  assert.equal(latestActiveSession({ sessionsDir: dir, now }).file, "newer.jsonl");

  const onlyOld = tmpDir("uh-latest-old");
  const old = path.join(onlyOld, "old.jsonl");
  fs.writeFileSync(old, "{}");
  fs.utimesSync(old, (now - 60 * 60 * 1000) / 1000, (now - 60 * 60 * 1000) / 1000);
  assert.equal(latestActiveSession({ sessionsDir: onlyOld, now }), null, "超窗不命中");
  assert.equal(latestActiveSession({ sessionsDir: "/nonexistent-dir-xyz", now }), null);
});

test("current-session：latest-session 兜底命中最新活跃会话", () => {
  const root = tmpDir("uh-latestroute");
  const hanako = path.join(root, "agents", "hanako", "sessions");
  fs.mkdirSync(hanako, { recursive: true });
  const now = Date.now();
  const writeSession = (id, mtimeMs) => {
    const p = path.join(hanako, `${id}.jsonl`);
    fs.writeFileSync(p, [
      JSON.stringify({ type: "session", id, agentId: "hanako", timestamp: "2026-09-09T01:00:00Z" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", model: "m", usage: { input: { totalTokens: 1 }, output: { totalTokens: 1 } } } }),
    ].join("\n"));
    fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  };
  writeSession("old", now - 2 * 60 * 60 * 1000);
  writeSession("active", now - 30 * 1000);

  const prev = process.env.HANA_HOME;
  process.env.HANA_HOME = root;
  try {
    const handlers = {};
    const app = { get: (p, h) => { handlers[`GET ${p}`] = h; }, post: (p, h) => { handlers[`POST ${p}`] = h; } };
    const ctx = { sessionPath: null, _usageHub: { paths: { sessionsDir: hanako, dataDir: hanako }, data: { entries: [] } } };
    registerApiRoutes(app, ctx);
    const c = (query = {}) => ({ req: { query: (k) => query[k] || "" }, json: (o) => o });
    const r = handlers["GET /current-session"](c({}));
    assert.equal(r.source, "latest-session");
    assert.equal(r.available, true);
    assert.equal(r.session.sessionId, "active");
  } finally {
    if (prev === undefined) delete process.env.HANA_HOME; else process.env.HANA_HOME = prev;
  }
});

test("widget 降级态可见诊断小字 + latest-session 标注", () => {
  const source = panelSource();
  assert.match(source, /探测：HTTP \$\{probe\.httpStatus \?\? "–"\} · entryId \$\{probe\.entryId \? "有" : "无"\} · origin \$\{probe\.origin \|\| "–"\}/);
  assert.match(source, /const metaText = \[reasonText, sourceNote, probeLine\]\.filter\(Boolean\)\.join\(" · "\)/);
  assert.match(source, /source === "latest-session" \? "按最近活跃会话推断"/);
  assert.match(source, /current\?\.source === "latest-session" \? "按最近活跃会话推断" : ""/);
});

test("本地快照：写入/读取/版本不符回退/筛选不符/损坏/超限跳过", () => {
  const source = panelSource();
  const start = source.indexOf("/* ── 本地快照");
  const end = source.indexOf("/* ── /本地快照");
  assert.ok(start >= 0 && end > start, "应存在本地快照区块");
  const block = source.slice(start, end);
  const api = new Function(`${block}; return { buildSnapshot, snapshotRaw, parseSnapshot, saveSnapshot, loadSnapshot, SNAPSHOT_KEY, MAX_SNAPSHOT_BYTES };`)();
  assert.equal(api.MAX_SNAPSHOT_BYTES, 1024 * 1024);

  const fakeStorage = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  };
  const storage = fakeStorage();
  const st = {
    filters: { from: "2026-09-09", to: "2026-09-09", preset: "today", agent: "", model: "", provider: "", type: "" },
    summary: { summary: { totalTokens: 1 } },
    daily: [{ date: "2026-09-09" }],
    hourly: [],
    byType: [],
    byAgent: [],
    byModel: [],
    speed: { tps: 20 },
    forecast: null,
  };

  assert.equal(api.saveSnapshot(storage, st, "0.5.17", 12345), true);
  const loaded = api.loadSnapshot(storage, "0.5.17", st.filters);
  assert.ok(loaded, "应读回快照");
  assert.equal(loaded.savedAt, 12345);
  assert.equal(loaded.version, "0.5.17");
  assert.deepEqual(loaded.data.summary, { summary: { totalTokens: 1 } });
  assert.deepEqual(loaded.data.speed, { tps: 20 });

  // 版本不符 → 回退（返回 null）
  assert.equal(api.loadSnapshot(storage, "0.5.18", st.filters), null);
  // 筛选条件不符 → 不用旧快照覆盖新数据
  assert.equal(api.loadSnapshot(storage, "0.5.17", { from: "2026-09-08", to: "2026-09-08", preset: "yesterday", agent: "", model: "", provider: "", type: "" }), null);
  // 损坏 JSON → null
  storage.setItem(api.SNAPSHOT_KEY, "{bad json");
  assert.equal(api.loadSnapshot(storage, "0.5.17", st.filters), null);
  // 结构非法 → null
  storage.setItem(api.SNAPSHOT_KEY, JSON.stringify({ version: "0.5.17" }));
  assert.equal(api.loadSnapshot(storage, "0.5.17", st.filters), null);

  // 超限跳过写入，不覆盖旧快照
  storage.setItem(api.SNAPSHOT_KEY, "keep");
  const big = { ...st, summary: { summary: { blob: "x".repeat(2 * 1024 * 1024) } } };
  assert.equal(api.saveSnapshot(storage, big, "0.5.17", 1), false);
  assert.equal(storage.getItem(api.SNAPSHOT_KEY), "keep", "超限不覆盖旧快照");
});

test("页面首屏先用本地快照立即渲染，随后静默刷新替换", () => {
  const source = panelSource();
  assert.match(source, /id="snapshotAge"/);
  assert.match(source, /const snapshot = loadSnapshot\(localStorage, UI_VERSION, state\.filters\)/);
  assert.match(source, /applySnapshot\(snapshot\)/);
  assert.match(source, /renderSnapshotAge\(snapshot\.savedAt\)/);
  assert.match(source, /await renderAll\(\{ silent: Boolean\(snapshot\) \}\)/);
  assert.match(source, /saveSnapshot\(localStorage, state, UI_VERSION\)/);
  assert.match(source, /上次更新 · \$\{timeAgo\(new Date\(savedAt\)\.toISOString\(\)\)\}/);
});

test("session-titles：瘦身条目用 sessionFile 映射（绝对路径键补 basename），缺失回退 sessionId", () => {
  const dir = tmpDir("uh-titles");
  // 侧车混合键：绝对路径键（历史）+ sessionId 键（较新）
  const absKey = "/Users/x/.hanako/agents/hanako/sessions/2026.jsonl";
  fs.writeFileSync(path.join(dir, "session-titles.json"), JSON.stringify({ [absKey]: "标题A", s2: "标题B" }));
  const handlers = {};
  const app = { get: (p, h) => { handlers[`GET ${p}`] = h; }, post: (p, h) => { handlers[`POST ${p}`] = h; } };
  const ctx = {
    _usageHub: {
      paths: { sessionsDir: dir, dataDir: dir },
      data: {
        rollup: {
          recentSessions: {
            "hanako::2026.jsonl": { agent: "hanako", file: "2026.jsonl", sessionId: "s1" }, // 绝对路径键的 basename → 命中
            "hanako::no-file": { agent: "hanako", file: "", sessionId: "s2" }, // 缺 file → 回退 raw[sessionId]
          },
        },
      },
    },
  };
  registerApiRoutes(app, ctx);
  const c = (query = {}) => ({ req: { query: (k) => query[k] || "" }, json: (o) => o });
  const r = handlers["GET /session-titles"](c());
  assert.equal(r.titles.s1, "标题A");
  assert.equal(r.titles.s2, "标题B");
});

test("sessionTitleMap：绝对路径键补 basename 键，与 sessionId 键共存", () => {
  const dir = tmpDir("uh-titlemap");
  const abs = "/Users/x/.hanako/agents/hanako/sessions/2026-05-29T13-58-33-682Z_abc.jsonl";
  fs.writeFileSync(path.join(dir, "session-titles.json"), JSON.stringify({ [abs]: "绝对路径标题", sess_new: "会话ID标题" }));
  const map = sessionTitleMap({ sessionsDir: dir });
  assert.equal(map[abs], "绝对路径标题", "原键保留");
  assert.equal(map["2026-05-29T13-58-33-682Z_abc.jsonl"], "绝对路径标题", "补 basename 键");
  assert.equal(map.sess_new, "会话ID标题", "sessionId 键保留");
});
