// test/rollup.test.js — 0.6.0 Phase ①：预聚合存储构建 / 清理 / 原子读写 / 迁移
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  emptyRollup, makeRollupBucket, addEntryToRollup, buildRollup, mergeLedgerIntoRollup,
  pruneSpeeds, pruneRecentSessions, loadRollup, saveRollup, migrateArchiveToRollup,
  ROLLUP_VERSION, SPEED_PER_SESSION_LIMIT, RECENT_SESSIONS_MAX_AGE_MS, RECENT_IDS_LIMIT,
} from "../lib/rollup.js";
import { aggregateEntries } from "../lib/aggregate.js";
import { aggregateRollup, degradeRollupFilter, agentOf } from "../lib/aggregate.js";
import { tmpDir, cleanupTmpDirs } from "./helpers.js";

after(cleanupTmpDirs);

const tmp = (name) => tmpDir(`uh-${name}`);

const entry = ({ requestId, startedAt, status = "ok", subsystem = "session", agentId = "hanako", sessionId = "s1", sessionFile = "a.jsonl", provider = "deepseek", modelId = "m1", input = 100, uncached = 50, output = 20, reasoning = 5, cacheRead = 50, totalTokens = 170 } = {}) => ({
  requestId,
  startedAt,
  endedAt: startedAt,
  durationMs: 100,
  status,
  source: { subsystem },
  attribution: { kind: subsystem, agentId, sessionId, sessionFile },
  model: { provider, modelId },
  usage: { input: { totalTokens: input, uncachedTokens: uncached }, output: { totalTokens: output, reasoningTokens: reasoning }, cache: { readTokens: cacheRead }, totalTokens },
});

test("buildRollup: days/hours/各维度聚合与明细聚合一致", () => {
  const entries = [
    entry({ requestId: "r1", startedAt: "2026-09-09T01:00:00Z", totalTokens: 170 }),
    entry({ requestId: "r2", startedAt: "2026-09-09T02:00:00Z", status: "error", subsystem: "subagent", agentId: "manman", sessionId: "s2", sessionFile: "b.jsonl", provider: "openai-codex", modelId: "m2", input: 200, uncached: 200, output: 40, reasoning: 0, cacheRead: 0, totalTokens: 240 }),
  ];
  const rollup = buildRollup(entries, { now: Date.parse("2026-09-09T12:00:00Z") });
  const d = rollup.days["2026-09-09"];
  assert.equal(d.total.calls, 2);
  assert.equal(d.total.totalTokens, 410);
  assert.equal(d.total.errors, 1);
  assert.equal(d.hours["09"].calls, 1); // 01:00Z = 09:00 Asia/Shanghai
  assert.equal(d.hours["10"].calls, 1);
  assert.equal(d.byType.session.calls, 1);
  assert.equal(d.byType.subagent.calls, 1);
  assert.equal(d.byAgent.hanako.calls, 1);
  assert.equal(d.byAgent.manman.calls, 1);
  assert.equal(d.byModel.m1.calls, 1);
  assert.equal(d.byProvider.deepseek.calls, 1);
  assert.equal(rollup.lastMergedAt, "2026-09-09T02:00:00Z");

  // recentSessions 按 agent::file
  assert.equal(rollup.recentSessions["hanako::a.jsonl"].days["2026-09-09"].total.calls, 1);
  assert.equal(rollup.recentSessions["manman::b.jsonl"].lastAt, "2026-09-09T02:00:00Z");

  // 与明细聚合逐项一致
  const agg = aggregateEntries(entries, {});
  assert.equal(d.total.totalTokens, agg.summary.totalTokens);
  assert.equal(d.total.calls, agg.summary.calls);
  assert.equal(d.total.uncached, agg.summary.uncached);
  assert.equal(d.total.cacheRead, agg.summary.cacheRead);
  assert.equal(d.total.errors, agg.summary.errors);
  assert.equal(d.byType.session.totalTokens, agg.byType.find((t) => t.type === "session").totalTokens);
  assert.equal(d.byAgent.hanako.output, agg.byAgent.find((a) => a.agentId === "hanako").output);
});

test("buildRollup: recentSessions 只保留最近 30 天，days 全量保留", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");
  const fresh = entry({ requestId: "r1", startedAt: "2026-09-09T01:00:00Z" });
  const stale = entry({ requestId: "r2", startedAt: "2026-07-01T01:00:00Z", sessionFile: "old.jsonl" });
  const rollup = buildRollup([fresh, stale], { now });
  assert.ok(rollup.days["2026-07-01"], "days 永久保留历史");
  assert.ok(rollup.days["2026-09-09"]);
  assert.ok(rollup.recentSessions["hanako::a.jsonl"], "近期会话保留");
  assert.equal(rollup.recentSessions["hanako::old.jsonl"], undefined, "超 30 天会话从 recentSessions 移除");
});

test("pruneSpeeds: 每会话 500、总量上限，按时间淘汰最旧", () => {
  const speeds = Array.from({ length: 700 }, (_, i) => ({ ts: new Date(Date.parse("2026-09-09T00:00:00Z") + i * 1000).toISOString(), day: "2026-09-09", sessionId: "s1", tps: i }));
  const kept = pruneSpeeds(speeds, Date.now());
  assert.equal(kept.length, SPEED_PER_SESSION_LIMIT);
  assert.equal(kept[0].tps, 699, "保留最新");
  assert.equal(kept.at(-1).tps, 200);
});

test("loadRollup/saveRollup: 原子写往返一致，损坏改名 .corrupt-*", () => {
  const dir = tmp("rollupio");
  const p = path.join(dir, "rollup.json");
  const r = emptyRollup();
  r.days["2026-09-09"] = { total: makeRollupBucket(), hours: {}, byType: {}, byAgent: {}, byModel: {}, byProvider: {} };
  r.days["2026-09-09"].total.calls = 3;
  saveRollup(p, r);
  assert.deepEqual(loadRollup(p), r);
  assert.equal(fs.existsSync(p + ".tmp"), false);
  fs.writeFileSync(p, "{broken");
  assert.throws(() => loadRollup(p));
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("rollup.json.corrupt-")));
  assert.equal(loadRollup(path.join(dir, "nope.json")), null);
});

test("mergeLedgerIntoRollup: 水位线去重（同窗口不重复计入，新条目才并入）", () => {
  const t1 = "2026-09-09T01:00:00Z";
  const t2 = "2026-09-09T03:00:00Z";
  const rollup = buildRollup([entry({ requestId: "r1", startedAt: t1 })]);
  const { added } = mergeLedgerIntoRollup(rollup, [entry({ requestId: "r1", startedAt: t1 }), entry({ requestId: "r2", startedAt: t2 })]);
  assert.equal(added, 1, "只有晚于水位线的条目并入");
  assert.equal(rollup.days["2026-09-09"].total.calls, 2);
  assert.equal(rollup.lastMergedAt, t2);
});

test("mergeLedgerIntoRollup: 晚到但更早的条目仍并入（recentIds 判重为主）", () => {
  const rollup = buildRollup([entry({ requestId: "r1", startedAt: "2026-09-09T05:00:00Z" })]);
  const { added } = mergeLedgerIntoRollup(rollup, [entry({ requestId: "rlate", startedAt: "2026-09-09T01:00:00Z" })]);
  assert.equal(added, 1, "晚到条目（早于水位线但不在 recentIds）应并入");
  assert.equal(rollup.days["2026-09-09"].total.calls, 2);
});

test("recentIds: 上限 5000，超出淘汰最旧", () => {
  const entries = Array.from({ length: RECENT_IDS_LIMIT + 100 }, (_, i) => entry({ requestId: `r${i}`, startedAt: new Date(Date.parse("2026-09-09T00:00:00Z") + i * 1000).toISOString() }));
  const rollup = buildRollup(entries);
  assert.equal(rollup.recentIds.length, RECENT_IDS_LIMIT);
  assert.equal(rollup.recentIds.at(-1), `r${RECENT_IDS_LIMIT + 99}`, "最新在末尾");
  assert.equal(rollup.recentIds[0], "r100", "只保留最近 5000 条");
});

test("migrateArchiveToRollup: 备份 archive + 写 rollup + 不删除备份", () => {
  const dir = tmp("rollupmig");
  const archivePath = path.join(dir, "archive.json");
  const rollupFilePath = path.join(dir, "rollup.json");
  fs.writeFileSync(archivePath, JSON.stringify({ version: 2, entries: { r1: entry({ requestId: "r1", startedAt: "2026-09-09T01:00:00Z" }) } }));
  const { rollup, backupPath, backupError } = migrateArchiveToRollup(archivePath, rollupFilePath, { now: 111 });
  assert.equal(backupError, null);
  assert.equal(rollup.version, ROLLUP_VERSION);
  assert.match(path.basename(backupPath), /^archive\.pre-rollup-111\.json$/);
  assert.equal(fs.existsSync(archivePath), false, "archive 已改名");
  assert.ok(fs.existsSync(rollupFilePath), "rollup 已写");
  assert.ok(fs.existsSync(backupPath), "备份保留");
  assert.equal(loadRollup(rollupFilePath).days["2026-09-09"].total.calls, 1);
  // 备份内容 = 原 archive
  assert.equal(JSON.parse(fs.readFileSync(backupPath, "utf-8")).entries.r1.requestId, "r1");
});

test("migrateArchiveToRollup: 写 rollup 失败时不动原 archive", () => {
  const dir = tmp("rollupmigfail");
  const archivePath = path.join(dir, "archive.json");
  const rollupFilePath = path.join(dir, "rollup.json");
  fs.writeFileSync(archivePath, JSON.stringify({ version: 2, entries: { r1: entry({ requestId: "r1", startedAt: "2026-09-09T01:00:00Z" }) } }));
  const original = fs.readFileSync(archivePath, "utf-8");
  fs.mkdirSync(rollupFilePath + ".tmp"); // 让 saveRollup 的 tmp 写失败
  assert.throws(() => migrateArchiveToRollup(archivePath, rollupFilePath, { now: 1 }));
  assert.equal(fs.readFileSync(archivePath, "utf-8"), original, "原 archive 未被破坏");
  assert.equal(fs.existsSync(rollupFilePath), false);
});

test("pruneRecentSessions: 全空会话被整体删除", () => {
  const rollup = emptyRollup();
  rollup.recentSessions["a::x.jsonl"] = { agent: "a", file: "x.jsonl", lastAt: null, days: { "2026-01-01": { total: makeRollupBucket(), hours: {} } } };
  pruneRecentSessions(rollup, Date.parse("2026-09-09T00:00:00Z"));
  assert.equal(Object.keys(rollup.recentSessions).length, 0);
});

test("degradeRollupFilter: from/to 生效，维度只取第一个非空（agent→model→provider→type）", () => {
  assert.deepEqual(degradeRollupFilter({ from: "2026-09-01", to: "2026-09-09", model: "m", type: "session" }), { from: "2026-09-01", to: "2026-09-09", dim: "model", value: "m", hiddenAgents: [], hiddenModels: [] });
  assert.equal(degradeRollupFilter({ type: "session" }).dim, "type");
  assert.equal(degradeRollupFilter({ provider: "deepseek", type: "session" }).dim, "provider");
  assert.equal(degradeRollupFilter({}).dim, "");
});

test("agentOf: subagent 用 actorAgentId，缺失回退父 agent", () => {
  const parent = entry({ requestId: "p", startedAt: "2026-09-09T01:00:00Z" });
  assert.equal(agentOf(parent), "hanako");
  const sub = { ...entry({ requestId: "s", startedAt: "2026-09-09T01:00:00Z", subsystem: "subagent" }), source: { subsystem: "subagent", actor: { agentId: "cece-engineer" } } };
  assert.equal(agentOf(sub), "cece-engineer");
  const subSlim = { ...entry({ requestId: "s2", startedAt: "2026-09-09T01:00:00Z", subsystem: "subagent" }), attribution: { ...entry({}).attribution, actorAgentId: "lengleng-audit" } };
  assert.equal(agentOf(subSlim), "lengleng-audit", "瘦身结构用 actorAgentId");
  assert.equal(agentOf(entry({ requestId: "s3", startedAt: "2026-09-09T01:00:00Z", subsystem: "subagent" })), "hanako", "actor 缺失回退父 agent");
});

test("byAgent: 子代理从父 agent 分出（aggregateEntries 与 rollup 一致）", () => {
  const sub = entry({ requestId: "s", startedAt: "2026-09-09T02:00:00Z", subsystem: "subagent", agentId: "hanako", input: 200, uncached: 200, output: 20, cacheRead: 0, totalTokens: 220 });
  sub.source = { subsystem: "subagent", actor: { agentId: "cece-engineer" } };
  const entries = [
    entry({ requestId: "p", startedAt: "2026-09-09T01:00:00Z", agentId: "hanako", input: 100, uncached: 100, output: 10, cacheRead: 0, totalTokens: 110 }),
    sub,
  ];
  const o = aggregateEntries(entries, {});
  const agents = Object.fromEntries(o.byAgent.map((a) => [a.agentId, a.totalTokens]));
  assert.equal(agents["cece-engineer"], 220, "子代理单独成行");
  assert.equal(agents["hanako"], 110);
  assert.equal(o.byAgent.reduce((s, a) => s + a.totalTokens, 0), o.summary.totalTokens, "各 agent 之和 = 总消耗");
  assert.equal(aggregateEntries(entries, { agent: "cece-engineer" }).summary.totalTokens, 220, "agent 筛选按子代理");
  const n = aggregateRollup(buildRollup(entries), {});
  const nagents = Object.fromEntries(n.byAgent.map((a) => [a.agentId, a.totalTokens]));
  assert.equal(nagents["cece-engineer"], 220);
  assert.equal(nagents["hanako"], 110);
});

test("aggregateRollup: 按 agent 筛选的 byModel/byProvider/byType 走交叉表", () => {
  const sub = entry({ requestId: "s", startedAt: "2026-09-09T02:00:00Z", subsystem: "subagent", agentId: "hanako", modelId: "m2", provider: "p2" });
  sub.source = { subsystem: "subagent", actor: { agentId: "cece-engineer" } };
  const entries = [
    entry({ requestId: "p", startedAt: "2026-09-09T01:00:00Z", agentId: "hanako", modelId: "m1", provider: "p1", subsystem: "session" }),
    sub,
  ];
  const n = aggregateRollup(buildRollup(entries), { agent: "cece-engineer" });
  assert.equal(n.summary.calls, 1);
  assert.equal(n.byModel.find((m) => m.modelId === "m2").totalTokens, sub.usage.totalTokens);
  assert.equal(n.byModel.find((m) => m.modelId === "m1"), undefined, "不含其他 agent 的模型");
  assert.equal(n.byProvider.find((p) => p.provider === "p2").totalTokens, sub.usage.totalTokens);
  assert.equal(n.byType.find((t) => t.type === "subagent").calls, 1);
  assert.equal(n.degraded.breakdowns, false, "agent 筛选下分布不降级");
  assert.equal(n.degraded.hourly, true, "小时图仍降级");
  const o = aggregateEntries(entries, { agent: "cece-engineer" });
  assert.equal(n.byModel[0].totalTokens, o.byModel[0].totalTokens);
});

test("aggregateRollup: 小时图 byType（hour×type）", () => {
  const entries = [
    entry({ requestId: "a", startedAt: "2026-09-09T01:00:00Z", subsystem: "session" }),
    entry({ requestId: "b", startedAt: "2026-09-09T01:30:00Z", subsystem: "subagent" }),
  ];
  const h9 = aggregateRollup(buildRollup(entries), {}).hourlyByDay["2026-09-09"][9];
  assert.equal(h9.totalTokens, entries.reduce((s, e) => s + e.usage.totalTokens, 0));
  assert.ok(h9.byType.session && h9.byType.subagent, "小时图保留按类型堆叠");
});

test("aggregateRollup: hiddenAgents/hiddenModels 过滤 summary/daily/byType/byModel", () => {
  const entries = [
    entry({ requestId: "a", startedAt: "2026-09-09T01:00:00Z", agentId: "hanako", modelId: "m1", provider: "p1", subsystem: "session", input: 100, uncached: 100, output: 10, cacheRead: 0, totalTokens: 110 }),
    entry({ requestId: "b", startedAt: "2026-09-09T02:00:00Z", agentId: "manman", modelId: "m2", provider: "p2", subsystem: "session", input: 200, uncached: 200, output: 20, cacheRead: 0, totalTokens: 220 }),
  ];
  const rollup = buildRollup(entries);
  assert.equal(aggregateRollup(rollup, {}).summary.totalTokens, 330);
  const hid = aggregateRollup(rollup, { hiddenAgents: ["manman"] });
  assert.equal(hid.summary.totalTokens, 110, "summary 排除 hidden agent");
  assert.equal(hid.daily[0].totalTokens, 110);
  assert.equal(hid.byAgent.find((a) => a.agentId === "manman"), undefined);
  assert.equal(hid.byModel.find((m) => m.modelId === "m2"), undefined, "byModel 排除 hidden agent 的模型");
  assert.equal(hid.byType.reduce((s, t) => s + t.totalTokens, 0), 110, "byType 排除 hidden agent");
  assert.equal(hid.byAgent.reduce((s, a) => s + a.totalTokens, 0), hid.summary.totalTokens, "各 agent 之和 == 总消耗");
  const hidM = aggregateRollup(rollup, { hiddenModels: ["m2"] });
  assert.equal(hidM.summary.totalTokens, 110, "summary 排除 hidden model");
  assert.equal(hidM.byModel.find((m) => m.modelId === "m2"), undefined);
});

test("pruneSpeeds: 30 天保留期（超期移除）", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");
  const kept = pruneSpeeds([
    { ts: "2026-09-09T00:00:00Z", day: "2026-09-09", sessionId: "s1" },
    { ts: "2026-01-01T00:00:00Z", day: "2026-01-01", sessionId: "s1" },
  ], now);
  assert.equal(kept.length, 1, "超 30 天移除");
  assert.equal(kept[0].day, "2026-09-09");
});

test("mergeLedgerIntoRollup: recentIds 缺失时退化为水位线判重（不全量双计）", () => {
  const rollup = buildRollup([entry({ requestId: "r1", startedAt: "2026-09-09T05:00:00Z" })]);
  delete rollup.recentIds;
  const { added, watermarkOnly } = mergeLedgerIntoRollup(rollup, [entry({ requestId: "r1", startedAt: "2026-09-09T05:00:00Z" }), entry({ requestId: "r2", startedAt: "2026-09-09T06:00:00Z" })]);
  assert.equal(watermarkOnly, true);
  assert.equal(added, 1, "只并入晚于水位线的 r2");
  assert.equal(rollup.days["2026-09-09"].total.calls, 2);
});

test("aggregateRollup: 无筛选时与 aggregateEntries 的 summary/byType/daily 一致", () => {
  const entries = [
    entry({ requestId: "r1", startedAt: "2026-09-09T01:00:00Z" }),
    entry({ requestId: "r2", startedAt: "2026-09-09T02:00:00Z", subsystem: "subagent", agentId: "manman", sessionId: "s2", sessionFile: "b.jsonl", modelId: "m2", provider: "openai-codex" }),
  ];
  const rollup = buildRollup(entries);
  const o = aggregateEntries(entries, {}), n = aggregateRollup(rollup, {});
  for (const f of ["totalTokens", "calls", "input", "uncached", "output", "reasoning", "cacheRead", "errors", "hitRatio"]) assert.equal(n.summary[f], o.summary[f], `summary.${f}`);
  assert.equal(n.byType.find((t) => t.type === "session").totalTokens, o.byType.find((t) => t.type === "session").totalTokens);
  assert.equal(n.byAgent.find((a) => a.agentId === "manman").calls, o.byAgent.find((a) => a.agentId === "manman").calls);
  assert.equal(n.daily[0].totalTokens, o.daily[0].totalTokens);
  assert.equal(n.daily[0].hitRatio, o.daily[0].hitRatio);
});
