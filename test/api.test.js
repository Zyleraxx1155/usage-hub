// test/api.test.js — 路由层 smoke：聚合与会话详情均使用 _tmp 隔离夹具
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import registerApiRoutes from "../routes/api.js";
import { makeEntry, tmpDir, cleanupTmpDirs } from "./helpers.js";

after(cleanupTmpDirs);
import { buildRollup } from "../lib/rollup.js";

function mockApp() { const handlers = {}; return { handlers, app: { get(p, h) { handlers["GET " + p] = h; }, post(p, h) { handlers["POST " + p] = h; } } }; }
function mockC(query = {}) { return { req: { query: (k) => query[k] ?? "" }, json: (obj, code) => ({ obj, code: code ?? 200 }), html: (s) => s }; }
function makeHubState(entries, sessionsDir = null) { const rollup = buildRollup(entries); return { ready: true, lastRefreshAt: "2026-09-08T12:00:00.000Z", lastRefreshError: null, paths: { dataDir: "/tmp/x", ledger: "/tmp/x/usage-ledger.json", archive: "/tmp/x/archive.json", rollup: "/tmp/x/rollup.json", sessionsDir }, migration: { written: true }, data: { builtAt: "2026-09-08T12:00:00.000Z", rollup, ledgerCount: entries.length, days: Object.keys(rollup.days).length, recentSessions: Object.keys(rollup.recentSessions).length, lastMerge: { added: entries.length } } }; }
const entries = [makeEntry({ requestId: "api1", agentId: "hanako", provider: "deepseek", modelId: "deepseek-v4-pro", input: 100, uncached: 100, output: 20, cacheRead: 400 }), makeEntry({ requestId: "api2", agentId: "lengleng", provider: "openai-codex", modelId: "gpt-5.6", subsystem: "subagent", input: 50, uncached: 50, output: 10 })];

test("api: 全部聚合接口可调用且命中率口径正确", () => { const { handlers, app } = mockApp(); registerApiRoutes(app, { _usageHub: makeHubState(entries) }); for (const p of ["/summary", "/daily", "/hourly", "/by-agent", "/by-model", "/by-provider", "/by-type", "/coverage", "/status"]) { const h = handlers["GET " + p]; assert.ok(h); assert.ok([200, undefined].includes(h(mockC()).code)); } const s = handlers["GET /summary"](mockC()).obj; assert.ok(Math.abs(s.summary.hitRatio - 400 / 550) < 1e-12); assert.equal(s.matched, 2); });
test("api: 筛选参数透传", () => { const { handlers, app } = mockApp(); registerApiRoutes(app, { _usageHub: makeHubState(entries) }); assert.equal(handlers["GET /summary"](mockC({ agent: "lengleng" })).obj.matched, 1); assert.equal(handlers["GET /by-agent"](mockC({ provider: "deepseek" })).obj.rows[0].agentId, "hanako"); assert.equal(handlers["GET /summary"](mockC({ from: "2026-08-01", to: "2026-07-31" })).obj.matched, 0); });
test("api: hourly 返回 24 小时连续序列", () => { const { handlers, app } = mockApp(); registerApiRoutes(app, { _usageHub: makeHubState(entries) }); const r = handlers["GET /hourly"](mockC({ day: "2026-08-01" })).obj; assert.equal(r.hourly.length, 24); assert.equal(r.hourly[23].hour, "23"); });
test("api: 数据未就绪返回 503", () => { const { handlers, app } = mockApp(); registerApiRoutes(app, { _usageHub: { ready: false, lastRefreshError: "ledger missing" } }); assert.equal(handlers["GET /summary"](mockC()).code, 503); });
test("api: refresh 端点触发重算", async () => { let n = 0; const hub = makeHubState(entries); hub.refresh = async () => { n++; }; const { handlers, app } = mockApp(); registerApiRoutes(app, { _usageHub: hub }); await handlers["POST /refresh"](mockC()); assert.equal(n, 1); });

test("api: 会话列表与详情按 sessionId 定位，并安全跳过损坏文件", () => {
  const dir = tmpDir("api-sessions");
  fs.writeFileSync(path.join(dir, "session-titles.json"), JSON.stringify({ "sess-good": "标题来自侧车" }));
  fs.writeFileSync(path.join(dir, "good.jsonl"), [
    { type: "session", id: "sess-good", agentId: "hanako", timestamp: "2026-09-09T01:00:00.000Z" },
    { type: "message", timestamp: "2026-09-09T01:01:00.000Z", message: { role: "user", content: "首条问题" } },
    { type: "model_change", modelId: "model-a", provider: "provider-a" },
    { type: "message", timestamp: "2026-09-09T01:02:00.000Z", message: { role: "assistant", model: "model-a", usage: { input: { totalTokens: 100 }, output: { totalTokens: 30 }, cache: { readTokens: 70 }, contextWindow: 1000 } } },
  ].map(JSON.stringify).join("\n"));
  fs.writeFileSync(path.join(dir, "broken.jsonl"), "{not-json\n");
  const { handlers, app } = mockApp(); registerApiRoutes(app, { _usageHub: makeHubState(entries, dir) });
  const list = handlers["GET /sessions"](mockC()).obj; assert.equal(list.sessions.length, 1); assert.equal(list.sessions[0].title, "标题来自侧车");
  const detail = handlers["GET /session-detail"](mockC({ sessionId: "sess-good" })).obj; assert.equal(detail.agent, "hanako"); assert.equal(detail.turns[0].model, "model-a"); assert.equal(detail.turns[0].inputTokens, 100); assert.equal(detail.turns[0].cacheReadTokens, 70); assert.equal(detail.contextTokens, 170); assert.equal(detail.contextWindow, 1000); assert.equal(handlers["GET /session-detail"](mockC({ sessionId: "missing" })).code, 404);
});
test("api: sessions warning 不泄露绝对目录且默认来源可观测", () => {
  const secretDir = path.join(tmpDir("api-invalid"), "missing");
  const { handlers, app } = mockApp(); registerApiRoutes(app, { _usageHub: makeHubState(entries, secretDir) });
  const result = handlers["GET /sessions"](mockC()).obj;
  assert.equal(result.source, "configured-sessions"); assert.ok(result.warnings.includes("invalid_sessions_directory"));
  assert.ok(result.warnings.every((warning) => !warning.includes(secretDir)));

  const fallback = mockApp(); registerApiRoutes(fallback.app, { _usageHub: makeHubState(entries) });
  const fallbackResult = fallback.handlers["GET /sessions"](mockC()).obj;
  assert.equal(fallbackResult.source, "default-agent-directory"); assert.ok(fallbackResult.warnings.includes("default_agent_directory"));
});

test("api: 重复 sessionId 返回 409，带 agent+file 精确成功", () => {
  const root = tmpDir("api-duplicate"); const dir = path.join(root, "agents", "shared", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "alpha.jsonl"), JSON.stringify({ type: "session", id: "duplicate", agentId: "alpha" }) + "\n");
  fs.writeFileSync(path.join(dir, "beta.jsonl"), JSON.stringify({ type: "session", id: "duplicate", agentId: "beta" }) + "\n");
  const { handlers, app } = mockApp(); registerApiRoutes(app, { _usageHub: makeHubState(entries, dir) });
  const ambiguous = handlers["GET /session-detail"](mockC({ sessionId: "duplicate" }));
  assert.equal(ambiguous.code, 409); assert.equal(ambiguous.obj.error, "ambiguous_session_id"); assert.equal(ambiguous.obj.matches.length, 2);
  const exact = handlers["GET /session-detail"](mockC({ sessionId: "duplicate", agent: "beta", file: "beta.jsonl" }));
  assert.equal(exact.code, 200); assert.equal(exact.obj.agent, "beta");
});

test("api: assets 路由可读", () => { const { handlers, app } = mockApp(); registerApiRoutes(app, { _usageHub: makeHubState(entries) }); for (const p of ["/assets/panel.js", "/assets/panel.css"]) { const c = { req: { query: () => "" }, headers: {}, header(k, v) { this.headers[k] = v; }, body: (content) => ({ content }) }; assert.ok(String(handlers["GET " + p](c).content).length > 1000); } });
