// test/ledger-reader.test.js — ledger 读取器与归档整合的滚动窗口防丢验收（V4）
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { readLedgerFile, readLedger, isUsableEntry } from "../lib/ledger-reader.js";
import { emptyArchive, mergeIntoArchive } from "../lib/archive.js";
import { makeEntry, tmpDir, cleanupTmpDirs } from "./helpers.js";

after(cleanupTmpDirs);

test("readLedgerFile: 解析 {version, entries}", () => {
  const dir = tmpDir("ledger");
  const p = path.join(dir, "usage-ledger.json");
  fs.writeFileSync(p, JSON.stringify({ version: 1, entries: [makeEntry({ requestId: "r1" })] }));
  const r = readLedgerFile(p);
  assert.equal(r.version, 1);
  assert.equal(r.entries.length, 1);
});

test("readLedgerFile: 文件缺失抛 ENOENT（调用方降级）", () => {
  assert.throws(() => readLedgerFile(path.join(tmpDir("ledger"), "missing.json")), /ENOENT/);
});

test("readLedger: 文件优先；文件失败且可用 bus 时回退宿主 API", async () => {
  const dir = tmpDir("ledger");
  const p = path.join(dir, "usage-ledger.json");
  fs.writeFileSync(p, JSON.stringify({ version: 1, entries: [makeEntry({ requestId: "from-file" })] }));
  const fromFile = await readLedger({ filePath: p });
  assert.equal(fromFile.source, "file");

  const bus = {
    request: async () => ({ entries: [makeEntry({ requestId: "from-bus" })] }),
  };
  const fromBus = await readLedger({ filePath: path.join(dir, "missing.json"), bus });
  assert.equal(fromBus.source, "bus");
  assert.equal(fromBus.entries[0].requestId, "from-bus");
});

test("isUsableEntry: 仅接受有非空 requestId 的条目", () => {
  assert.equal(isUsableEntry(makeEntry({ requestId: "ok" })), true);
  assert.equal(isUsableEntry({ requestId: "" }), false);
  assert.equal(isUsableEntry({}), false);
  assert.equal(isUsableEntry(null), false);
});

test("V4 模拟：ledger 滚动窗口挤掉旧记录，归档后条数守恒（不丢数据）", () => {
  // 第 1 轮：账本窗口内 100 条（模拟"最近 5000 条"的一个缩影）
  const round1 = Array.from({ length: 100 }, (_, i) =>
    makeEntry({ requestId: `w1-${i}`, startedAt: `2026-08-0${(i % 9) + 1}T0${i % 10}:00:00Z` })
  );
  const archive = emptyArchive();
  const s1 = mergeIntoArchive(archive, round1);
  assert.equal(s1.added, 100);

  // 账本滚动：前 60 条被挤掉，只剩后 40 条 + 40 条新增（模拟窗口推移）
  const rolledLedger = [
    ...round1.slice(60), // 重叠 40 条
    ...Array.from({ length: 40 }, (_, i) => makeEntry({ requestId: `w2-${i}`, startedAt: `2026-08-10T${String(i % 24).padStart(2, "0")}:00:00Z` })),
  ];
  const s2 = mergeIntoArchive(archive, rolledLedger);
  assert.equal(s2.added, 40, "只新增滚动后出现的新条目");
  assert.equal(s2.skipped, 40, "重叠条目跳过");
  assert.equal(Object.keys(archive.entries).length, 140, "被挤掉的 60 条仍在归档中");
});

test("V4 模拟：三轮滚动后不变量 —— 归档条数 = 历史并集", () => {
  const gen = (prefix, from, n) =>
    Array.from({ length: n }, (_, i) => makeEntry({ requestId: `${prefix}-${from + i}` }));
  const archive = emptyArchive();
  // 窗口容量 10：每轮新增 6 条、挤掉最旧 6 条（更激进的滚动）
  const all = [];
  const rounds = [];
  for (let round = 0; round < 5; round++) {
    const fresh = gen("r" + round, round * 6, 6);
    all.push(...fresh);
    rounds.push(fresh);
    mergeIntoArchive(archive, fresh);
  }
  // 账本当前窗口只有最后一轮（前面 4 轮都被挤掉）
  assert.equal(Object.keys(archive.entries).length, 30, "5 轮 × 6 条全部留存");
  // 模拟各轮账本窗口的重复归档（第 3 轮时账本同时含第 2、3 轮的数据）
  const archive2 = emptyArchive();
  mergeIntoArchive(archive2, [...rounds[0]]);
  mergeIntoArchive(archive2, [...rounds[1], ...rounds[0].slice(0, 2)]); // 窗口重叠
  mergeIntoArchive(archive2, [...rounds[2], ...rounds[1].slice(0, 2)]);
  mergeIntoArchive(archive2, [...rounds[3], ...rounds[2].slice(0, 2)]);
  mergeIntoArchive(archive2, [...rounds[4], ...rounds[3].slice(0, 2)]);
  assert.equal(Object.keys(archive2.entries).length, 30, "重叠窗口重复归档不产生重复条目");
});
