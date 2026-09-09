// test/usage-hub-speed.test.js — 0.5.16 端到端输出速率：四类目录/type、ledger 白名单、加权、mtime 增量、条件写盘
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseSessionSpeedRecords,
  ledgerSpeedRecords,
  scanSessionSpeeds,
  emptySpeedCache,
  flattenSpeedRecords,
  loadSpeedCache,
  saveSpeedCache,
  agentSessionDirs,
  shouldPersistSpeedCache,
} from "../lib/speed-scan.js";
import { buildSpeedStats } from "../lib/speed-stats.js";
import { pruneSpeedCache } from "../lib/speed-scan.js";
import { tmpDir, cleanupTmpDirs } from "./helpers.js";

after(cleanupTmpDirs);
import registerApiRoutes from "../routes/api.js";

const at = (ms) => new Date(Date.UTC(2026, 8, 9, 0, 0, 0, ms)).toISOString();
const assistantLine = ({ ts, out = 10, reasoning = 0, model = "m", provider }) =>
  JSON.stringify({ type: "message", timestamp: ts, message: { role: "assistant", model, ...(provider ? { provider } : {}), usage: { output: out, reasoning } } });
const jsonl = (messages) => messages.map(assistantLine).join("\n");

const rec = (out, durMs, over = {}) => ({
  ts: "2026-09-09T02:00:00.000Z",
  day: "2026-09-09",
  agent: "a",
  type: "session",
  model: "m",
  provider: "p",
  out,
  reasoning: 0,
  durMs,
  tps: +(out / (durMs / 1000)).toFixed(2),
  textTps: +(out / (durMs / 1000)).toFixed(2),
  source: "jsonl",
  ...over,
});
const ledgerEntry = (subsystem, over = {}) => ({
  source: { subsystem },
  attribution: { agentId: "a" },
  model: { modelId: "m", provider: "p" },
  startedAt: "2026-09-09T02:00:00Z",
  durationMs: 10000,
  usage: { output: { totalTokens: 200 } },
  ...over,
});

test("speed-scan: 相邻 assistant 消息差取上一条 output，过滤 100ms~600000ms", () => {
  const pair = (gapMs, out = 100, reasoning = 20) =>
    parseSessionSpeedRecords(jsonl([{ ts: at(0), out, reasoning }, { ts: at(gapMs), out: 10 }]), { agent: "a", type: "session" });

  assert.equal(pair(99).length, 0, "99ms 剔除");
  const ok = pair(100);
  assert.equal(ok.length, 1, "100ms 保留");
  assert.equal(ok[0].durMs, 100);
  assert.equal(ok[0].out, 100, "记录的是上一条消息的 output");
  assert.equal(ok[0].reasoning, 20);
  assert.equal(ok[0].tps, 1000);
  assert.equal(ok[0].textTps, 800); // (100-20)/0.1
  assert.equal(ok[0].agent, "a");
  assert.equal(ok[0].type, "session");
  assert.equal(ok[0].day, "2026-09-09");
  assert.equal(ok[0].source, "jsonl");

  assert.equal(pair(600000).length, 1, "600000ms 保留");
  assert.equal(pair(600001).length, 0, "600001ms 剔除");
});

test("speed-scan: 扫描 sessions/subagent-sessions/activity/workflow-sessions 四类目录并映射 type", async () => {
  const root = tmpDir("usage-hub-speeddirs");
  const agentDir = path.join(root, "agents", "hanako");
  const pair = [{ ts: at(0), out: 100 }, { ts: at(2000), out: 50 }];
  const write = (sub, rel) => {
    const full = path.join(agentDir, sub, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, jsonl(pair));
  };
  write("sessions", "s.jsonl");
  write("subagent-sessions", "direct/a.jsonl");
  write("activity", "a.jsonl");
  write("workflow-sessions", "workflow-x/w.jsonl");

  const dirs = agentSessionDirs(path.join(root, "agents"));
  assert.equal(dirs.length, 4, "每个 agent 四类目录都返回");
  const { cache } = await scanSessionSpeeds({ sessionsDirs: dirs, cache: emptySpeedCache() });
  const records = flattenSpeedRecords(cache);
  const byType = {};
  for (const r of records) byType[r.type] = (byType[r.type] || 0) + 1;
  assert.deepEqual(byType, { session: 1, subagent: 1, automation: 2 }, "目录 → type 映射正确");
  for (const r of records) assert.equal(r.agent, "hanako", "agent 归属父目录名");
});

test("speed-scan: 符号链接目录不扫描", () => {
  const root = tmpDir("usage-hub-speedlink");
  const agentsRoot = path.join(root, "agents");
  fs.mkdirSync(path.join(agentsRoot, "hanako"), { recursive: true });
  const real = path.join(root, "real-sessions");
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, "s.jsonl"), jsonl([{ ts: at(0), out: 10 }, { ts: at(2000), out: 5 }]));
  fs.symlinkSync(real, path.join(agentsRoot, "hanako", "sessions"));
  assert.deepEqual(agentSessionDirs(agentsRoot), [], "符号链接 sessions 目录被拒绝");
});

test("speed-scan: model_change 提供 provider 回退", () => {
  const content = [
    JSON.stringify({ type: "model_change", provider: "openai-codex", modelId: "gpt-x" }),
    assistantLine({ ts: at(0), out: 100 }),
    assistantLine({ ts: at(1000), out: 10 }),
  ].join("\n");
  const records = parseSessionSpeedRecords(content, { agent: "a" });
  assert.equal(records.length, 1);
  assert.equal(records[0].provider, "openai-codex");
});

test("speed-scan: 模型变化且无 model_change 时 provider 置空", () => {
  const content = [
    JSON.stringify({ type: "model_change", provider: "prov-x" }),
    assistantLine({ ts: at(0), out: 100, model: "m1" }),
    assistantLine({ ts: at(1000), out: 100, model: "m2" }),
    assistantLine({ ts: at(2000), out: 100, model: "m2" }),
  ].join("\n");
  const records = parseSessionSpeedRecords(content, { agent: "a" });
  assert.equal(records.length, 2);
  assert.equal(records[0].model, "m2");
  assert.equal(records[0].provider, "prov-x", "记录时 currentProvider 尚未重置");
  assert.equal(records[1].model, "m2");
  assert.equal(records[1].provider, "", "模型切换且无事件 → provider 置空");
});

test("speed-stats: 加权 Σout/Σdur，不是 tps 算术平均", () => {
  // 算术平均 = (100 + 10) / 2 = 55；加权 = (1000+10) / (10+1) = 91.8 → 92
  const stats = buildSpeedStats([rec(1000, 10000), rec(10, 1000)], {});
  assert.equal(stats.tps, 92);
  assert.notEqual(stats.tps, 55);
  assert.equal(stats.count, 2);
  assert.equal(stats.textTps, 92);
});

test("speed-stats: textTps 剔除 reasoning", () => {
  const stats = buildSpeedStats([rec(100, 1000, { reasoning: 40 })], {});
  assert.equal(stats.tps, 100);
  assert.equal(stats.textTps, 60); // (100-40)/1s
});

test("speed-stats: 按时间/agent/model/provider/type 过滤并分组", () => {
  const records = [
    rec(1000, 10000, { agent: "a", model: "m1", provider: "p1", day: "2026-09-09", type: "session" }),
    rec(10, 1000, { agent: "b", model: "m2", provider: "p2", day: "2026-09-08", type: "subagent" }),
    rec(10, 1000, { agent: "b", model: "m2", provider: "p2", day: "2026-09-08", type: "automation" }),
  ];
  assert.equal(buildSpeedStats(records, { agent: "a" }).count, 1);
  assert.equal(buildSpeedStats(records, { model: "m2" }).count, 2);
  assert.equal(buildSpeedStats(records, { provider: "p1" }).count, 1);
  assert.equal(buildSpeedStats(records, { type: "subagent" }).count, 1);
  assert.equal(buildSpeedStats(records, { type: "automation" }).count, 1);
  assert.equal(buildSpeedStats(records, { from: "2026-09-09", to: "2026-09-09" }).count, 1);
  assert.equal(buildSpeedStats(records, { hiddenAgents: ["a"] }).count, 2);
  assert.equal(buildSpeedStats(records, {}).count, 3);
  assert.equal(buildSpeedStats(records, {}).byAgent.length, 2);
  assert.equal(buildSpeedStats([], {}).tps, null);
});

test("speed-scan: JSONL 口径记录带 sessionId（取自 session 事件）", () => {
  const content = [
    JSON.stringify({ type: "session", id: "sess_abc", agentId: "hanako" }),
    assistantLine({ ts: at(0), out: 100 }),
    assistantLine({ ts: at(2000), out: 50 }),
  ].join("\n");
  const records = parseSessionSpeedRecords(content, { agent: "hanako" });
  assert.equal(records.length, 1);
  assert.equal(records[0].sessionId, "sess_abc");
});

test("speed-scan: ledger 口径记录带 attribution.sessionId", () => {
  const led = ledgerSpeedRecords([{ ...ledgerEntry("memory"), attribution: { agentId: "a", sessionId: "sess_led" } }]);
  assert.equal(led.length, 1);
  assert.equal(led[0].sessionId, "sess_led");
});

test("pruneSpeedCache: 保留 30 天，移除过期样本", () => {
  const cache = { version: 2, updatedAt: null, files: {} };
  cache.files["a::x.jsonl"] = { mtime: 1, size: 1, agent: "a", type: "session", speeds: [
    { ts: "2026-09-09T00:00:00Z", day: "2026-09-09", sessionId: "s1" },
    { ts: "2026-01-01T00:00:00Z", day: "2026-01-01", sessionId: "s1" },
  ] };
  const removed = pruneSpeedCache(cache, { now: Date.parse("2026-09-09T12:00:00Z") });
  assert.equal(removed, 1);
  assert.equal(cache.files["a::x.jsonl"].speeds.length, 1);
  assert.equal(cache.files["a::x.jsonl"].speeds[0].day, "2026-09-09");
});

test("speed-stats: 按 sessionId 过滤，byModel 只含该会话模型", () => {
  const records = [
    rec(1000, 10000, { sessionId: "s1", model: "m1" }),
    rec(10, 1000, { sessionId: "s2", model: "m2" }),
  ];
  const s1 = buildSpeedStats(records, { sessionId: "s1" });
  assert.equal(s1.count, 1);
  assert.equal(s1.byModel.length, 1);
  assert.equal(s1.byModel[0].model, "m1");
  assert.equal(buildSpeedStats(records, { sessionId: "sX" }).count, 0);
});

test("speed-scan: ledger 白名单只收 memory/utility", () => {
  const led = ledgerSpeedRecords([
    ledgerEntry("memory"),
    ledgerEntry("utility"),
    ledgerEntry("automation"),
    ledgerEntry("compaction"),
    ledgerEntry("session"),
    ledgerEntry("subagent"),
  ]);
  assert.deepEqual(led.map((r) => r.type).sort(), ["memory", "utility"]);
  assert.equal(led[0].source, "ledger");
  assert.equal(led[0].tps, 20); // 200 / 10s
});

test("speed-scan: ledger 仍过滤 durationMs 边界与 out>0", () => {
  const led = ledgerSpeedRecords([
    ledgerEntry("memory", { durationMs: 99 }),
    ledgerEntry("memory", { durationMs: 600001 }),
    ledgerEntry("memory", { usage: { output: { totalTokens: 0 } } }),
    ledgerEntry("memory", { durationMs: 600000 }),
  ]);
  assert.equal(led.length, 1, "仅 600000ms 且 out>0 保留");
  assert.equal(led[0].durMs, 600000);
});

test("speed-scan: ledger reasoningTokens 计入 textTps", () => {
  const led = ledgerSpeedRecords([
    ledgerEntry("memory", { usage: { output: { totalTokens: 200, reasoningTokens: 50 } } }),
  ]);
  assert.equal(led.length, 1);
  assert.equal(led[0].reasoning, 50);
  assert.equal(led[0].tps, 20); // 200 / 10s
  assert.equal(led[0].textTps, 15); // (200-50) / 10s
});

test("speed-scan: JSONL 与 ledger 合并进同一池（加权）", () => {
  const led = ledgerSpeedRecords([ledgerEntry("memory")]);
  const merged = buildSpeedStats([rec(1000, 10000, { agent: "a" }), ...led], {});
  assert.equal(merged.count, 2);
  // 加权 (1000 + 200) / (10 + 10) = 60
  assert.equal(merged.tps, 60);
});

test("speed-scan: mtime+size 增量，同 mtime 不重扫；mtime 变化才重扫", async () => {
  const root = tmpDir("usage-hub-speed");
  const dir = path.join(root, "agents", "hanako", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "s1.jsonl");
  fs.writeFileSync(file, jsonl([{ ts: at(0), out: 100 }, { ts: at(2000), out: 50 }]));

  const first = await scanSessionSpeeds({ sessionsDirs: [dir], cache: emptySpeedCache() });
  assert.equal(first.changed, 1);
  assert.equal(first.reused, 0);
  const records = flattenSpeedRecords(first.cache);
  assert.equal(records.length, 1);
  assert.equal(records[0].agent, "hanako");
  assert.equal(records[0].tps, 50); // 100 / 2s

  const second = await scanSessionSpeeds({ sessionsDirs: [dir], cache: first.cache });
  assert.equal(second.changed, 0);
  assert.equal(second.reused, 1);
  assert.deepEqual(flattenSpeedRecords(second.cache), records);

  const future = Date.now() / 1000 + 10;
  fs.utimesSync(file, future, future);
  const third = await scanSessionSpeeds({ sessionsDirs: [dir], cache: second.cache });
  assert.equal(third.changed, 1, "mtime 变化触发重扫");
});

test("speed-scan: changed=0 时不落盘（shouldPersistSpeedCache）", async () => {
  const root = tmpDir("usage-hub-speedpersist");
  const dir = path.join(root, "agents", "hanako", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "s.jsonl");
  fs.writeFileSync(file, jsonl([{ ts: at(0), out: 100 }, { ts: at(2000), out: 50 }]));

  const first = await scanSessionSpeeds({ sessionsDirs: [dir], cache: emptySpeedCache() });
  assert.equal(first.changed, 1);
  assert.equal(first.fileSetChanged, true);
  assert.equal(shouldPersistSpeedCache(first), true);

  const second = await scanSessionSpeeds({ sessionsDirs: [dir], cache: first.cache });
  assert.equal(second.changed, 0);
  assert.equal(second.fileSetChanged, false);
  assert.equal(shouldPersistSpeedCache(second), false, "纯 reused 不写盘");

  fs.unlinkSync(file);
  const third = await scanSessionSpeeds({ sessionsDirs: [dir], cache: second.cache });
  assert.equal(third.changed, 0);
  assert.equal(third.fileSetChanged, true, "文件删除也算集合变化");
  assert.equal(shouldPersistSpeedCache(third), true);
});

test("speed-scan: 缓存损坏改名 .corrupt-* 保留，原子写可读回", () => {
  const dir = tmpDir("usage-hub-speedcache");
  const file = path.join(dir, "speeds.json");
  fs.writeFileSync(file, "{ not json");
  assert.throws(() => loadSpeedCache(file));
  assert.ok(!fs.existsSync(file), "损坏文件被移走");
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith("speeds.json.corrupt-")));

  const cache = emptySpeedCache();
  cache.files["session::a::b.jsonl"] = { mtime: 1, size: 2, agent: "a", type: "session", speeds: [rec(100, 1000)] };
  saveSpeedCache(file, cache);
  assert.deepEqual(loadSpeedCache(file), cache);
});

test("speed: /api/speed 返回加权速度、scanning 标志并随筛选变化", () => {
  const dir = tmpDir("usage-hub-speedapi");
  const handlers = {};
  const app = { get: (p, h) => { handlers[`GET ${p}`] = h; }, post: (p, h) => { handlers[`POST ${p}`] = h; } };
  const ctx = {
    _usageHub: {
      speeds: { records: [rec(1000, 10000, { agent: "a", type: "session", sessionId: "s1" }), rec(10, 1000, { agent: "b", type: "subagent", sessionId: "s2" })], updatedAt: "t1", scanning: true },
      data: { entries: [] },
      paths: { dataDir: dir, sessionsDir: dir },
    },
  };
  registerApiRoutes(app, ctx);
  const c = (query = {}) => ({ req: { query: (k) => query[k] || "" }, json: (obj) => obj });

  const all = handlers["GET /api/speed"](c());
  assert.equal(all.speed.count, 2);
  assert.equal(all.speed.tps, 92);
  assert.equal(all.scanning, true, "暴露 scanning 供前端重取");
  assert.ok(handlers["GET /speed"], "legacy 无前缀路由也注册");
  assert.equal(handlers["GET /speed"](c()).speed.count, 2);
  assert.equal(handlers["GET /api/speed"](c({ type: "subagent" })).speed.count, 1);
  assert.equal(handlers["GET /api/speed"](c({ agent: "a" })).speed.tps, 100);
  assert.equal(handlers["GET /api/speed"](c({ sessionId: "s1" })).speed.count, 1, "sessionId 过滤生效");
});

test("speed: index.js 在 onload 后台扫描、条件写盘并合并 rollup ledger 口径", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(source, /scanSessionSpeeds/);
  assert.match(source, /pruneSpeedCache/);
  assert.match(source, /state\.rollup\?\.speeds/);
  assert.match(source, /agentSessionDirs/);
  assert.match(source, /shouldPersistSpeedCache/);
  assert.match(source, /scanSpeeds\(\)\.catch/); // 首屏不 await
  assert.match(source, /speedPath/);
});
