// test/e2e.test.js — 端到端：模拟宿主加载插件（onload 全链路，0.6.0 rollup 存储）
// 流程：token-tracker 导入 → archive → rollup 迁移（archive 改名备份）→ 增量并入账本。
// 全程使用 _tmp 假 HANA_HOME，不触碰真实 ~/.hanako。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import UsageHubPlugin from "../index.js";
import { makeEntry, tmpDir, cleanupTmpDirs } from "./helpers.js";

after(cleanupTmpDirs);

function makeCtx(dataDir) {
  return {
    dataDir,
    pluginId: "usage-hub",
    config: { get: (k) => (k === "refreshSeconds" ? 10 : undefined) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    bus: null,
  };
}

function buildFakeHome() {
  const home = tmpDir("e2e-home");
  fs.mkdirSync(path.join(home, "plugin-data", "token-tracker"), { recursive: true });
  const ttArchive = {
    version: 1,
    updatedAt: "2026-09-08T12:00:00.000Z",
    entries: {
      old1: { t: "2026-07-22T13:15:49.490Z", e: "2026-07-22T13:15:51.376Z", d: 1886, a: "hanako", m: "deepseek-v4-pro", p: "deepseek", i: 486, o: 36, c: 0, cw: 0, tot: 522, cost: 0, sub: "utility", k: "session", sf: "system", ct: "" },
      old2: { t: "2026-07-23T13:15:49.490Z", e: "2026-07-23T13:15:51.376Z", d: 1000, a: "hanako", m: "deepseek-v4-flash", p: "deepseek", i: 7446, o: 200, c: 19328, cw: 0, tot: 26974, cost: 0, sub: "automation", k: "automation", sf: "system", ct: "" },
    },
  };
  fs.writeFileSync(path.join(home, "plugin-data", "token-tracker", "usage-archive.json"), JSON.stringify(ttArchive));
  return home;
}

function writeLedger(home, entries) {
  fs.writeFileSync(path.join(home, "usage-ledger.json"), JSON.stringify({ version: 1, entries }));
}

async function loadPlugin(home) {
  const dataDir = path.join(home, "plugin-data", "usage-hub");
  const ctx = makeCtx(dataDir);
  const plugin = new UsageHubPlugin();
  plugin.ctx = ctx;
  const cleanups = [];
  plugin.register = (fn) => cleanups.push(fn);
  const prev = process.env.HANA_HOME;
  process.env.HANA_HOME = home;
  try {
    await plugin.onload();
  } finally {
    process.env.HANA_HOME = prev;
  }
  return { ctx, cleanups };
}

test("e2e: 首次加载 = token-tracker 导入 → archive → rollup，archive 改名备份", async () => {
  const home = buildFakeHome();
  writeLedger(home, [makeEntry({ requestId: "fresh1", startedAt: "2026-09-08T04:00:00.000Z", input: 100, uncached: 100, output: 10, cacheRead: 0 })]);

  const { ctx, cleanups } = await loadPlugin(home);
  try {
    const h = ctx._usageHub;
    assert.equal(h.ready, true);
    assert.equal(h.migration.written, true);
    assert.equal(h.migration.stats.imported, 2, "old1/old2 导入");
    // rollup 落盘
    assert.ok(fs.existsSync(path.join(h.paths.dataDir, "rollup.json")));
    // archive 已改名备份，不再写 archive
    assert.equal(fs.existsSync(path.join(h.paths.dataDir, "archive.json")), false);
    assert.equal(fs.readdirSync(h.paths.dataDir).filter((f) => f.startsWith("archive.pre-rollup-")).length, 1);
    // days：迁移的 2 天 + 账本 fresh1 的 1 天
    assert.ok(h.rollup.days["2026-07-22"] && h.rollup.days["2026-07-23"] && h.rollup.days["2026-09-08"]);
    assert.equal(h.rollup.days["2026-09-08"].total.calls, 1);
    assert.equal(h.rollup.days["2026-07-23"].total.totalTokens, 26974);
  } finally {
    cleanups.forEach((fn) => fn());
  }
});

test("e2e: 二次加载加载 rollup（不重复迁移）；refresh 增量并入且不重复计数", async () => {
  const home = buildFakeHome();
  writeLedger(home, [makeEntry({ requestId: "a1", startedAt: "2026-09-08T04:00:00Z" })]);

  const first = await loadPlugin(home);
  first.cleanups.forEach((fn) => fn());
  assert.equal(first.ctx._usageHub.migration.written, true);

  // 账本滚动：a1 仍在窗口，出现 a2
  writeLedger(home, [makeEntry({ requestId: "a1", startedAt: "2026-09-08T04:00:00Z" }), makeEntry({ requestId: "a2", startedAt: "2026-09-08T05:00:00Z" })]);
  const { ctx, cleanups } = await loadPlugin(home);
  try {
    const h = ctx._usageHub;
    assert.equal(h.migration, null, "二次加载直接加载 rollup，不再迁移");
    // a1 已并入（recentIds），a2 新增
    assert.equal(h.rollup.days["2026-09-08"].total.calls, 2, "a1 不重复计入，a2 并入");
    // 手动 refresh：新增 a3
    writeLedger(home, [makeEntry({ requestId: "a2", startedAt: "2026-09-08T05:00:00Z" }), makeEntry({ requestId: "a3", startedAt: "2026-09-08T06:00:00Z" })]);
    await h.refresh();
    assert.equal(h.rollup.days["2026-09-08"].total.calls, 3);
  } finally {
    cleanups.forEach((fn) => fn());
  }
});

test("e2e: 损坏 rollup 改名 .corrupt-* 后重建", async () => {
  const home = tmpDir("e2e-corrupt");
  const dataDir = path.join(home, "plugin-data", "usage-hub");
  fs.mkdirSync(dataDir, { recursive: true });
  const corrupted = "{totally broken";
  fs.writeFileSync(path.join(dataDir, "rollup.json"), corrupted);
  writeLedger(home, [makeEntry({ requestId: "x1", startedAt: "2026-09-08T04:00:00.000Z" })]);

  const { ctx, cleanups } = await loadPlugin(home);
  try {
    const h = ctx._usageHub;
    assert.equal(h.ready, true);
    const backups = fs.readdirSync(dataDir).filter((f) => f.startsWith("rollup.json.corrupt-"));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dataDir, backups[0]), "utf-8"), corrupted);
    assert.equal(h.rollup.days["2026-09-08"].total.calls, 1, "从账本重建");
  } finally {
    cleanups.forEach((fn) => fn());
  }
});

test("e2e: 无旧归档时正常冷启动", async () => {
  const home = tmpDir("e2e-nomig");
  writeLedger(home, [makeEntry({ requestId: "only1" })]);
  const { ctx, cleanups } = await loadPlugin(home);
  try {
    const h = ctx._usageHub;
    assert.equal(h.ready, true);
    assert.equal(h.migration.sourceExists, false);
    assert.equal(h.rollup.days["2026-08-01"].total.calls, 1);
  } finally {
    cleanups.forEach((fn) => fn());
  }
});
