// test/migrate.test.js — 一次性迁移：字段转换 / 重叠账本优先 / 幂等 / dry-run
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { tokenTrackerEntryToLedgerShape, buildArchiveFromTokenTracker, runMigration } from "../lib/migrate.js";
import { makeEntry, tmpDir } from "./helpers.js";

// token-tracker 真实短键条目样例（取自 2026-07-22 实测数据，键组合为老代格式）
const ttSample = {
  t: "2026-07-22T13:15:49.490Z",
  e: "2026-07-22T13:15:51.376Z",
  d: 1886,
  a: "hanako",
  m: "deepseek-v4-pro",
  p: "deepseek",
  i: 486,
  o: 36,
  c: 0,
  cw: 0,
  tot: 522,
  cost: 0,
  sub: "utility",
  k: "session",
  sf: "system",
  ct: "",
};

test("tokenTrackerEntryToLedgerShape: 字段映射正确，cost 丢弃，uncachedTokens 为 null", () => {
  const e = tokenTrackerEntryToLedgerShape("llm_abc_1", ttSample);
  assert.equal(e.requestId, "llm_abc_1");
  assert.equal(e._migrated, true);
  assert.equal(e.startedAt, ttSample.t);
  assert.equal(e.durationMs, 1886);
  assert.equal(e.source.subsystem, "utility");
  assert.equal(e.attribution.agentId, "hanako");
  assert.equal(e.model.provider, "deepseek");
  assert.equal(e.model.modelId, "deepseek-v4-pro");
  assert.equal(e.usage.input.totalTokens, 486);
  assert.equal(e.usage.input.uncachedTokens, null);
  assert.equal(e.usage.output.totalTokens, 36);
  assert.equal(e.usage.cache.readTokens, 0);
  assert.equal(e.usage.cache.writeTokens, 0);
  assert.equal(e.usage.totalTokens, 522);
  assert.equal("costTotal" in e.usage, false, "cost 字段必须丢弃");
});

test("buildArchiveFromTokenTracker: 重叠以账本为准，条数守恒", () => {
  const ttArchive = {
    entries: {
      old1: { ...ttSample, t: "2026-07-22T13:15:49.490Z" },
      old2: { ...ttSample, t: "2026-07-23T13:15:49.490Z" },
      overlap: { ...ttSample, t: "2026-09-03T10:00:00.000Z" },
    },
  };
  const ledger = [makeEntry({ requestId: "overlap", startedAt: "2026-09-03T10:00:00.000Z", input: 1630, uncached: 1630, cacheRead: 15872 })];
  const { archive, stats } = buildArchiveFromTokenTracker(ttArchive, ledger);
  assert.equal(stats.sourceEntries, 3);
  assert.equal(stats.ledgerMerged, 1);
  assert.equal(stats.imported, 2);
  assert.equal(stats.overriddenByLedger, 1);
  assert.equal(Object.keys(archive.entries).length, 3);
  // 重叠条目保留账本完整版本
  const overlap = archive.entries["overlap"];
  assert.equal(overlap._migrated, undefined);
  assert.equal(overlap.usage.cache.readTokens, 15872);
  assert.equal(overlap.usage.input.uncachedTokens, 1630);
  // 导入条目带 _migrated
  assert.equal(archive.entries["old1"]._migrated, true);
});

test("runMigration: 源缺失 → 报错不写", () => {
  const dir = tmpDir("mig");
  const report = runMigration({
    srcPath: path.join(dir, "no-src.json"),
    dstPath: path.join(dir, "archive.json"),
    migrationLogPath: path.join(dir, "migration.json"),
    dryRun: false,
  });
  assert.equal(report.sourceExists, false);
  assert.ok(report.error.includes("not found"));
  assert.equal(fs.existsSync(path.join(dir, "archive.json")), false);
});

test("runMigration: dry-run 只计算不写盘", () => {
  const dir = tmpDir("mig");
  const src = path.join(dir, "tt.json");
  fs.writeFileSync(src, JSON.stringify({ entries: { a: ttSample } }));
  const report = runMigration({ srcPath: src, dstPath: path.join(dir, "archive.json"), migrationLogPath: path.join(dir, "migration.json"), dryRun: true });
  assert.equal(report.written, false);
  assert.equal(report.stats.imported, 1);
  assert.equal(fs.existsSync(path.join(dir, "archive.json")), false);
});

test("runMigration: 写盘成功 + 幂等（第二次跳过）", () => {
  const dir = tmpDir("mig");
  const src = path.join(dir, "tt.json");
  const dst = path.join(dir, "archive.json");
  fs.writeFileSync(src, JSON.stringify({ entries: { a: ttSample, b: ttSample } }));
  const r1 = runMigration({ srcPath: src, dstPath: dst, migrationLogPath: path.join(dir, "migration.json"), dryRun: false });
  assert.equal(r1.written, true);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(dst, "utf-8")).entries).length, 2);
  const r2 = runMigration({ srcPath: src, dstPath: dst, migrationLogPath: path.join(dir, "migration.json"), dryRun: false });
  assert.ok(r2.skipped.reason, "第二次应幂等跳过");
});

test("runMigration: force 重跑覆盖", () => {
  const dir = tmpDir("mig");
  const src = path.join(dir, "tt.json");
  const dst = path.join(dir, "archive.json");
  fs.writeFileSync(src, JSON.stringify({ entries: { a: ttSample } }));
  runMigration({ srcPath: src, dstPath: dst, migrationLogPath: path.join(dir, "migration.json"), dryRun: false });
  const r = runMigration({ srcPath: src, dstPath: dst, migrationLogPath: path.join(dir, "migration.json"), dryRun: false, force: true });
  assert.equal(r.written, true);
  assert.equal(r.stats.imported, 1);
});

test("runMigration: 损坏归档改名保留（.corrupt-*）后重建，绝不静默覆盖（冷冷审计修复）", () => {
  const dir = tmpDir("mig");
  const src = path.join(dir, "tt.json");
  const dst = path.join(dir, "archive.json");
  fs.writeFileSync(src, JSON.stringify({ entries: { a: ttSample, b: ttSample } }));
  const corrupted = "{broken json!!";
  fs.writeFileSync(dst, corrupted);

  const r = runMigration({ srcPath: src, dstPath: dst, migrationLogPath: path.join(dir, "migration.json"), dryRun: false });
  assert.equal(r.written, true, "应重建归档");
  assert.equal(r.preservedCorrupt, true, "报告应标记已保留损坏文件");
  assert.equal(r.stats.imported, 2);

  // 损坏文件被改名保留且内容不变
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("archive.json.corrupt-"));
  assert.equal(files.length, 1, "应存在一个 .corrupt-* 备份");
  assert.equal(fs.readFileSync(path.join(dir, files[0]), "utf-8"), corrupted, "损坏文件内容必须原样保留");
  // 新归档可正常解析
  const rebuilt = JSON.parse(fs.readFileSync(dst, "utf-8"));
  assert.equal(Object.keys(rebuilt.entries).length, 2);
});

test("runMigration: 损坏归档 + dry-run 不写不破坏（只计算）", () => {
  const dir = tmpDir("mig");
  const src = path.join(dir, "tt.json");
  const dst = path.join(dir, "archive.json");
  fs.writeFileSync(src, JSON.stringify({ entries: { a: ttSample } }));
  fs.writeFileSync(dst, "{broken");
  const r = runMigration({ srcPath: src, dstPath: dst, migrationLogPath: path.join(dir, "migration.json"), dryRun: true });
  assert.equal(r.written, false);
  // dry-run 不改名不写盘：损坏文件仍在原处
  assert.equal(fs.readFileSync(dst, "utf-8"), "{broken");
  assert.equal(r.preservedCorrupt, true, "dry-run 也应报告会保留损坏文件");
});
