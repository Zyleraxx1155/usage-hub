// test/archive.test.js — 归档器：加载/原子写/requestId 去重/升级/损坏处理
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { emptyArchive, loadArchive, saveArchive, mergeIntoArchive, mergedEntries, slimEntry, migrateArchiveToSlim, ARCHIVE_VERSION } from "../lib/archive.js";
import { makeEntry, makeMigratedEntry, tmpDir, cleanupTmpDirs } from "./helpers.js";

after(cleanupTmpDirs);

test("loadArchive: 文件不存在返回 null", () => {
  assert.equal(loadArchive(path.join(tmpDir("arch"), "nope.json")), null);
});

test("saveArchive + loadArchive 往返一致，且原子写不残留 tmp", () => {
  const dir = tmpDir("arch");
  const p = path.join(dir, "archive.json");
  const a = emptyArchive();
  a.entries["r1"] = makeEntry({ requestId: "r1" });
  a.updatedAt = "2026-09-08T00:00:00.000Z";
  saveArchive(p, a);
  const loaded = loadArchive(p);
  assert.deepEqual(loaded, a);
  assert.equal(fs.existsSync(p + ".tmp"), false);
  assert.deepEqual(fs.readdirSync(dir), ["archive.json"]);
});

test("mergeIntoArchive: 同 requestId 去重（重复合并不增加条数）", () => {
  const a = emptyArchive();
  const e1 = makeEntry({ requestId: "r1" });
  const s1 = mergeIntoArchive(a, [e1]);
  assert.deepEqual(s1, { added: 1, upgraded: 0, skipped: 0, unusable: 0 });
  const s2 = mergeIntoArchive(a, [makeEntry({ requestId: "r1" })]);
  assert.equal(s2.skipped, 1);
  assert.equal(Object.keys(a.entries).length, 1);
});

test("mergeIntoArchive: 迁移条目被账本完整条目替换（upgraded）", () => {
  const a = emptyArchive();
  a.entries["r1"] = makeMigratedEntry({ requestId: "r1", input: 500, uncached: 999, cacheRead: 100 });
  const full = makeEntry({ requestId: "r1", input: 1000, uncached: 1000, cacheRead: 100 });
  const s = mergeIntoArchive(a, [full]);
  assert.equal(s.upgraded, 1);
  assert.equal(s.added, 0);
  assert.equal(a.entries["r1"]._migrated, undefined);
  assert.equal(a.entries["r1"].usage.input.uncachedTokens, 1000); // 完整字段生效
});

test("mergeIntoArchive: 无 requestId 条目拒收（unusable）", () => {
  const a = emptyArchive();
  const s = mergeIntoArchive(a, [{ startedAt: "2026-08-01T00:00:00Z" }]);
  assert.equal(s.unusable, 1);
  assert.equal(Object.keys(a.entries).length, 0);
});

test("loadArchive: 损坏文件抛错并改名保留 .corrupt-*", () => {
  const dir = tmpDir("arch");
  const p = path.join(dir, "archive.json");
  fs.writeFileSync(p, "{broken json!!");
  assert.throws(() => loadArchive(p));
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^archive\.json\.corrupt-\d+$/);
});

test("mergedEntries: 归档 + 账本剩余，按 requestId 去重", () => {
  const a = emptyArchive();
  a.entries["r1"] = makeEntry({ requestId: "r1" });
  const ledger = [makeEntry({ requestId: "r1" }), makeEntry({ requestId: "r2" }), { noId: true }];
  const out = mergedEntries(a, ledger);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(e => e.requestId).sort(), ["r1", "r2"]);
});

test("slimEntry: 白名单保留/删除，sessionFile 由 sessionPath basename 生成", () => {
  const full = {
    schemaVersion: 1, requestId: "r1", startedAt: "t0", endedAt: "t1", durationMs: 123, status: "ok",
    source: { subsystem: "session", operation: "reply", surface: "desktop", trigger: "user", parent: { path: "/x" }, actor: { path: "/y" } },
    attribution: { kind: "session", agentId: "hanako", sessionId: "s1", sessionPath: "/Users/x/.hanako/agents/hanako/sessions/2026.jsonl" },
    model: { provider: "deepseek", modelId: "m", api: "x" },
    usage: { input: { totalTokens: 100, uncachedTokens: 40 }, output: { totalTokens: 20, reasoningTokens: 5 }, cache: { readTokens: 60, writeTokens: 0, missTokens: null, hit: true, created: false, hitRatio: 0.6, support: "reported" }, totalTokens: 180, costTotal: 0 },
    metadata: {}, rawUsageShape: {}, error: "x",
  };
  const s = slimEntry(full);
  // 保留
  assert.equal(s.requestId, "r1");
  assert.equal(s.usage.input.totalTokens, 100);
  assert.equal(s.usage.input.uncachedTokens, 40);
  assert.equal(s.usage.output.totalTokens, 20);
  assert.equal(s.usage.output.reasoningTokens, 5);
  assert.equal(s.usage.cache.readTokens, 60);
  assert.equal(s.usage.cache.writeTokens, 0);
  assert.equal(s.usage.totalTokens, 180);
  assert.equal(s.model.provider, "deepseek");
  assert.equal(s.model.modelId, "m");
  assert.equal(s.source.subsystem, "session");
  assert.equal(s.source.operation, "reply");
  assert.equal(s.attribution.sessionId, "s1");
  assert.equal(s.attribution.sessionFile, "2026.jsonl");
  // 删除
  for (const k of ["schemaVersion", "metadata", "rawUsageShape", "error"]) assert.equal(k in s, false, `不应保留 ${k}`);
  for (const k of ["surface", "trigger", "parent", "actor"]) assert.equal(k in s.source, false, `source.${k} 应删除`);
  assert.equal("sessionPath" in s.attribution, false);
  assert.equal("api" in s.model, false);
  assert.equal("costTotal" in s.usage, false);
  for (const k of ["missTokens", "hit", "created", "hitRatio", "support"]) assert.equal(k in s.usage.cache, false, `cache.${k} 应删除`);
});

test("slimEntry: subagent 保留 attribution.actorAgentId（来源 source.actor.agentId）", () => {
  const s = slimEntry({ requestId: "r", source: { subsystem: "subagent", actor: { agentId: "cece-engineer" } }, attribution: { agentId: "hanako" }, usage: {} });
  assert.equal(s.attribution.actorAgentId, "cece-engineer");
  assert.equal("actor" in s.source, false, "不保留整个 source.actor");
  assert.equal("actorAgentId" in slimEntry({ requestId: "r2", source: { subsystem: "session" }, attribution: { agentId: "hanako" }, usage: {} }).attribution, false, "无 actor 时省略");
});

test("slimEntry: 缺失 uncachedTokens 不补 0（保持回退语义），_migrated 保留", () => {
  const e = { requestId: "r", usage: { input: { totalTokens: 100 }, output: {}, cache: {}, totalTokens: 100 } };
  const s = slimEntry(e);
  assert.equal("uncachedTokens" in s.usage.input, false, "缺失不补 0");
  assert.equal(s.usage.output.totalTokens, undefined);
  assert.equal(slimEntry({ ...e, _migrated: true })._migrated, true);
});

test("migrateArchiveToSlim: 备份原文件 + 原子写 + 幂等", () => {
  const dir = tmpDir("slim");
  const p = path.join(dir, "archive.json");
  const old = { version: 1, updatedAt: "2026-01-01T00:00:00Z", entries: { r1: makeEntry({ requestId: "r1", input: 1000, uncached: 1000, cacheRead: 200 }) } };
  fs.writeFileSync(p, JSON.stringify(old));
  const r = migrateArchiveToSlim(p, old, { now: 111 });
  assert.equal(r.archive.version, ARCHIVE_VERSION);
  assert.ok(fs.existsSync(r.backupPath));
  assert.match(path.basename(r.backupPath), /^archive\.pre-slim-111\.json$/);
  // 原文件已被替换为瘦身结构
  const loaded = JSON.parse(fs.readFileSync(p, "utf-8"));
  assert.equal(loaded.version, ARCHIVE_VERSION);
  assert.equal(loaded.entries.r1.usage.cache.readTokens, 200);
  assert.equal("schemaVersion" in loaded.entries.r1, false);
  // 备份 = 原文件（结构未动）
  const backup = JSON.parse(fs.readFileSync(r.backupPath, "utf-8"));
  assert.equal(backup.version, 1);
  assert.equal(backup.entries.r1.schemaVersion, 1);
  // 幂等：对已瘦身对象再次迁移，结构不变，且不覆盖已有备份
  const r2 = migrateArchiveToSlim(p, loaded, { now: 111 });
  assert.deepEqual(r2.archive.entries, r.archive.entries);
  assert.notEqual(r2.backupPath, r.backupPath, "同名备份不覆盖，另起新名");
});

test("migrateArchiveToSlim: 写失败不破坏原文件", () => {
  const dir = tmpDir("slimfail");
  const p = path.join(dir, "archive.json");
  const old = { version: 1, updatedAt: null, entries: { r1: makeEntry({ requestId: "r1" }) } };
  fs.writeFileSync(p, JSON.stringify(old));
  const original = fs.readFileSync(p, "utf-8");
  // 让 tmp 写失败（tmp 路径是目录）
  fs.mkdirSync(p + ".tmp");
  assert.throws(() => migrateArchiveToSlim(p, old, { now: 1 }));
  assert.equal(fs.readFileSync(p, "utf-8"), original, "原文件未被破坏");
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith("archive.pre-slim-")).length, 0, "不应留下备份");
});
