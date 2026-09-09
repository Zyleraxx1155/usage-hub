// test/aggregate.test.js — 聚合口径：命中率公式 / 近似规则 / 类型映射 / 筛选 / 时区分桶
import test from "node:test";
import assert from "node:assert/strict";

import { aggregateEntries, dailyCoverage, bucketHitRatio, makeBucket } from "../lib/aggregate.js";
import { sourceTypeOf } from "../lib/types.js";
import { makeEntry, makeMigratedEntry } from "./helpers.js";

test("命中率 = ΣcacheRead ÷ Σ(cacheRead + uncached)，与 ledger hitRatio 同式", () => {
  // 两条：cacheRead/uncached 手工构造，期望按总比口径
  const entries = [
    makeEntry({ requestId: "a", input: 1000, uncached: 1000, output: 200, cacheRead: 9000 }),
    makeEntry({ requestId: "b", input: 3000, uncached: 3000, output: 100, cacheRead: 1000 }),
  ];
  const r = aggregateEntries(entries, {});
  const expected = (9000 + 1000) / (9000 + 1000 + 1000 + 3000);
  assert.ok(Math.abs(r.summary.hitRatio - expected) < 1e-12);
  assert.equal(r.summary.calls, 2);
  assert.equal(r.summary.input, 4000);
  assert.equal(r.summary.output, 300);
  assert.equal(r.summary.cacheRead, 10000);
  // totalTokens = input + output + cacheRead（PLAN 3.3）
  assert.equal(r.summary.totalTokens, 14300);
});

test("迁移条目（无 uncachedTokens）用 input.totalTokens 近似，且标记不影响公式结构", () => {
  const entries = [
    makeMigratedEntry({ requestId: "m1", input: 500, output: 50, cacheRead: 500 }),
    makeEntry({ requestId: "n1", input: 500, uncached: 400, output: 50, cacheRead: 500 }),
  ];
  const r = aggregateEntries(entries, {});
  // m1: uncached 近似 500；n1: 真值 400
  const expected = 1000 / (1000 + 500 + 400);
  assert.ok(Math.abs(r.summary.hitRatio - expected) < 1e-12);
});

test("单条目命中率与 ledger hitRatio 字段一致（验证口径实现可对标）", () => {
  const cr = 15872;
  const unc = 1630;
  const hr = cr / (cr + unc);
  const entries = [makeEntry({ requestId: "x", input: unc, uncached: unc, output: 252, cacheRead: cr, hitRatio: hr })];
  const r = aggregateEntries(entries, {});
  assert.ok(Math.abs(r.summary.hitRatio - hr) < 1e-12);
});

test("来源类型映射：PLAN 3.4 全部 7 类 + 未映射归 other", () => {
  const cases = {
    session: makeEntry({ requestId: "t1", subsystem: "session" }),
    subagent: makeEntry({ requestId: "t2", subsystem: "subagent" }),
    memory: makeEntry({ requestId: "t3", subsystem: "memory" }),
    automation: makeEntry({ requestId: "t4", subsystem: "automation" }),
    utility: makeEntry({ requestId: "t5", subsystem: "utility" }),
    compaction: makeEntry({ requestId: "t6", subsystem: "compaction" }),
    vision: makeEntry({ requestId: "t7", subsystem: "vision" }),
    other: makeEntry({ requestId: "t8", subsystem: "agent", kind: "agent" }),
  };
  for (const [expected, e] of Object.entries(cases)) {
    assert.equal(sourceTypeOf(e), expected, `subsystem=${e.source.subsystem}`);
  }
  const r = aggregateEntries(Object.values(cases), {});
  const typeSet = new Set(r.byType.map(t => t.type));
  for (const k of ["session", "subagent", "memory", "automation", "utility", "compaction", "vision", "other"]) {
    assert.ok(typeSet.has(k), `缺少类型 ${k}`);
  }
  assert.equal(r.byType.find(t => t.type === "other").calls, 1, "未映射类型不丢数据");
});

test("subsystem 缺失时回退 attribution.kind", () => {
  const e = makeEntry({ requestId: "k1", subsystem: "" });
  e.source.subsystem = undefined;
  e.attribution.kind = "memory";
  assert.equal(sourceTypeOf(e), "memory");
});

test("筛选：agent / model / provider / type / from / to 组合", () => {
  const entries = [
    makeEntry({ requestId: "f1", agentId: "hanako", provider: "deepseek", modelId: "deepseek-v4-pro", subsystem: "session", startedAt: "2026-08-01T04:00:00Z" }),
    makeEntry({ requestId: "f2", agentId: "lengleng", provider: "openai", modelId: "gpt-x", subsystem: "subagent", startedAt: "2026-08-02T04:00:00Z" }),
    makeEntry({ requestId: "f3", agentId: "hanako", provider: "deepseek", modelId: "deepseek-v4-pro", subsystem: "memory", startedAt: "2026-08-03T04:00:00Z" }),
  ];
  assert.equal(aggregateEntries(entries, { agent: "hanako" }).matched, 2);
  assert.equal(aggregateEntries(entries, { provider: "openai" }).matched, 1);
  assert.equal(aggregateEntries(entries, { model: "deepseek-v4-pro" }).matched, 2);
  assert.equal(aggregateEntries(entries, { type: "memory" }).matched, 1);
  assert.equal(aggregateEntries(entries, { from: "2026-08-02", to: "2026-08-02" }).matched, 1);
  assert.equal(aggregateEntries(entries, { from: "2026-08-02" }).matched, 2);
  assert.equal(aggregateEntries(entries, { agent: "hanako", type: "memory" }).matched, 1);
  assert.equal(aggregateEntries(entries, { agent: "nobody" }).matched, 0);
});

test("日分桶使用 Asia/Shanghai：UTC 17 点后归次日", () => {
  // 2026-07-21T17:00:00Z = 上海 2026-07-22 01:00 → 归 07-22
  const e = makeEntry({ requestId: "tz1", startedAt: "2026-07-21T17:00:00.000Z" });
  const r = aggregateEntries([e], {});
  assert.equal(r.daily.length, 1);
  assert.equal(r.daily[0].date, "2026-07-22");
});

test("hourly 输出 24 小时连续序列，缺失小时补 0", () => {
  const e = makeEntry({ requestId: "h1", startedAt: "2026-08-01T01:30:00.000Z" }); // 上海 09:30
  const r = aggregateEntries([e], {});
  const series = r.hourlyByDay["2026-08-01"];
  assert.equal(series.length, 24);
  const filled = series.filter(s => s.calls > 0);
  assert.equal(filled.length, 1);
  assert.equal(filled[0].hour, "09");
  assert.equal(series[0].hour, "00");
  assert.equal(series[23].hour, "23");
});

test("dailyCoverage: 无缺口 / 检测缺口 / 检测重复 requestId", () => {
  const e1 = makeEntry({ requestId: "c1", startedAt: "2026-08-01T04:00:00Z" });
  const e2 = makeEntry({ requestId: "c2", startedAt: "2026-08-02T04:00:00Z" });
  const e3 = makeEntry({ requestId: "c3", startedAt: "2026-08-02T05:00:00Z" });
  const cov = dailyCoverage([e1, e2, e3]);
  assert.equal(cov.gaps.length, 0);
  assert.equal(cov.duplicateRequestIds, 0);
  assert.equal(cov.firstDay, "2026-08-01");

  const g1 = makeEntry({ requestId: "g1", startedAt: "2026-08-01T04:00:00Z" });
  const g2 = makeEntry({ requestId: "g2", startedAt: "2026-08-05T04:00:00Z" });
  const covGap = dailyCoverage([g1, g2]);
  assert.equal(covGap.gaps.length, 1);
  assert.deepEqual(covGap.gaps[0], { from: "2026-08-01", to: "2026-08-05", missingDays: 3 });

  const d1 = makeEntry({ requestId: "dup", startedAt: "2026-08-01T04:00:00Z" });
  const d2 = makeEntry({ requestId: "dup", startedAt: "2026-08-01T05:00:00Z" });
  const covDup = dailyCoverage([d1, d2]);
  assert.equal(covDup.duplicateRequestIds, 1);
});

test("bucketHitRatio: 分母为 0 返回 null（无数据不显示命中率）", () => {
  assert.equal(bucketHitRatio(makeBucket()), null);
});

test("防御：usage 为 null 的条目不崩溃，贡献 0（真实数据中存在）", () => {
  const e = makeEntry({ requestId: "nullusage", subsystem: "agent", kind: "agent" });
  e.usage = null;
  const r = aggregateEntries([e], {});
  assert.equal(r.summary.calls, 1);
  assert.equal(r.summary.totalTokens, 0);
  assert.equal(r.summary.hitRatio, null);
  assert.equal(r.byType[0].type, "other");
});

test("reasoning 字段：输出推理 token 单独计入（PLAN 4.4 输入构成）", () => {
  const e1 = makeEntry({ requestId: "r1", input: 100, uncached: 100, output: 50, cacheRead: 0 });
  e1.usage.output.reasoningTokens = 300;
  const e2 = makeEntry({ requestId: "r2", input: 100, uncached: 100, output: 50, cacheRead: 0 });
  const r = aggregateEntries([e1, e2], {});
  assert.equal(r.summary.reasoning, 300);
  assert.equal(r.daily[0].reasoning, 300);
  // 推理不改变 totalTokens 与命中率口径（totalTokens 仍由 ledger 字段决定，不含 reasoning）
  assert.equal(r.summary.output, 100);
  assert.equal(r.summary.totalTokens, 300);
  assert.equal(r.summary.hitRatio, 0); // 有未命中输入（分母 200），缓存命中 0
});
