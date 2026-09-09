#!/usr/bin/env node
// scripts/verify-realdata.mjs — 阶段 1 验收证据（只读真实数据，不写任何旧插件目录）
//
// 验证项（对应 PLAN 阶段验收）：
//  V1 命中率与 ledger hitRatio 逐条对比（全量，非抽样）
//  V2 子代理 / 记忆 / 自动化的消耗出现在统计中
//  V3 迁移导入后 2026-07-22 以来趋势连续、无重复（条数对比）
//  V4 ledger 5000 条滚动窗口不导致数据丢失（合并后条数守恒检验）

import fs from "node:fs";
import { hanaHome, ledgerPath, tokenTrackerArchivePath } from "../lib/paths.js";
import { readLedgerFile } from "../lib/ledger-reader.js";
import { buildArchiveFromTokenTracker } from "../lib/migrate.js";
import { mergeIntoArchive, emptyArchive } from "../lib/archive.js";
import { aggregateEntries, dailyCoverage, uncachedOf, cacheReadOf } from "../lib/aggregate.js";

const env = process.env;
const lp = ledgerPath(env);
const src = tokenTrackerArchivePath(env);

console.log("== V1: hitRatio 逐条对比 ==");
const ledger = readLedgerFile(lp);
let compared = 0, mismatch = 0, withHitRatio = 0, noHitRatio = 0, withUncached = 0;
let maxAbsErr = 0;
const mismatchSamples = [];
for (const e of ledger.entries) {
  const hr = e.usage?.cache?.hitRatio;
  if (typeof hr !== "number") {
    noHitRatio++;
    continue;
  }
  withHitRatio++;
  const unc = e.usage?.input?.uncachedTokens;
  if (typeof unc !== "number") continue;
  withUncached++;
  const cr = cacheReadOf(e);
  const recomputed = cr / (cr + unc);
  compared++;
  const absErr = Math.abs(recomputed - hr);
  if (absErr > 1e-9) {
    mismatch++;
    if (mismatchSamples.length < 5) mismatchSamples.push({ requestId: e.requestId, ledger: hr, recomputed });
  }
  if (absErr > maxAbsErr) maxAbsErr = absErr;
}
console.log(`ledger entries: ${ledger.entries.length} | with hitRatio: ${withHitRatio} | with uncachedTokens: ${withUncached}`);
console.log(`compared: ${compared} | mismatch(>1e-9): ${mismatch} | maxAbsErr: ${maxAbsErr}`);
if (mismatchSamples.length) console.log("mismatch samples:", JSON.stringify(mismatchSamples, null, 2));
console.log(`V1 ${mismatch === 0 && compared > 0 ? "PASS" : "FAIL"}`);

console.log("\n== V2: 来源类型覆盖（子代理/记忆/自动化）==");
const fullAgg = aggregateEntries(ledger.entries, {});
console.log("ledger-only byType:", JSON.stringify(fullAgg.byType.map(t => ({ type: t.type, calls: t.calls, totalTokens: t.totalTokens }))));
const need = ["subagent", "memory", "automation"];
const missing = need.filter(t => !fullAgg.byType.some(b => b.type === t && b.calls > 0));
console.log(`V2 ${missing.length === 0 ? "PASS" : "FAIL"}${missing.length ? " missing: " + missing.join(",") : ""}`);

console.log("\n== V3: 迁移导入对比 ==");
const ttArchive = JSON.parse(fs.readFileSync(src, "utf-8"));
const srcCount = Object.keys(ttArchive.entries || {}).length;
const { archive: migratedArchive, stats } = buildArchiveFromTokenTracker(ttArchive, ledger.entries);
const migratedCount = Object.keys(migratedArchive.entries).length;
console.log(`token-tracker source entries: ${srcCount}`);
console.log(`ledger current window: ${ledger.entries.length}`);
console.log(`overlap (ledger wins): ${stats.overriddenByLedger}`);
console.log(`imported (source - overlap): ${stats.imported}`);
console.log(`expected merged = ledger + imported = ${ledger.entries.length + stats.imported}`);
console.log(`actual merged: ${migratedCount}`);
const consistent = migratedCount === ledger.entries.length + stats.imported;
console.log(`条数守恒: ${consistent ? "PASS" : "FAIL"}`);

const cov = dailyCoverage(Object.values(migratedArchive.entries));
console.log(`coverage: ${cov.firstDay} → ${cov.lastDay} | daysWithData: ${cov.daysWithData} | gaps: ${JSON.stringify(cov.gaps)} | duplicates: ${cov.duplicateRequestIds}`);
const coversJuly22 = cov.firstDay && cov.firstDay <= "2026-07-22";
const noGaps = cov.gaps.length === 0;
const noDups = cov.duplicateRequestIds === 0;
console.log(`V3 ${consistent && coversJuly22 && noGaps && noDups ? "PASS" : "FAIL"} (conserved=${consistent} from0722=${coversJuly22} noGaps=${noGaps} noDups=${noDups})`);

console.log("\n== V4: 滚动窗口防丢（模拟：账本滚动挤掉旧记录，归档合并后条数守恒）==");
// 用真实数据模拟：把 ledger 切成两半——"第 1 轮"归档前半，账本滚到只剩后半，"第 2 轮"归档后半。
const half = Math.floor(ledger.entries.length / 2);
const firstHalf = ledger.entries.slice(0, half);
const secondHalf = ledger.entries.slice(half);
const simArchive = emptyArchive();
const s1 = mergeIntoArchive(simArchive, firstHalf);
const s2 = mergeIntoArchive(simArchive, secondHalf);
const totalAfterRoll = Object.keys(simArchive.entries).length;
const uniqueIds = new Set(ledger.entries.map(e => e.requestId)).size;
console.log(`round1 archived: ${s1.added} | round2 (window rolled) archived: ${s2.added} | skipped dup: ${s2.skipped}`);
console.log(`archive total: ${totalAfterRoll} | unique ledger requestIds: ${uniqueIds}`);
console.log(`V4 ${totalAfterRoll === uniqueIds ? "PASS" : "FAIL"}`);

console.log("\n== 迁移后全量聚合（对比 V2：应包含 7-22 以来的历史）==");
const mergedAll = aggregateEntries(Object.values(migratedArchive.entries), {});
console.log("merged byType:", JSON.stringify(mergedAll.byType.map(t => ({ type: t.type, calls: t.calls, totalTokens: t.totalTokens }))));
console.log(`merged summary: calls=${mergedAll.summary.calls} totalTokens=${mergedAll.summary.totalTokens} cacheRead=${mergedAll.summary.cacheRead} hitRatio=${mergedAll.summary.hitRatio}`);
console.log(`merged daily days: ${mergedAll.daily.length} (${mergedAll.daily[0]?.date} → ${mergedAll.daily[mergedAll.daily.length - 1]?.date})`);
const mergedCov = dailyCoverage(Object.values(migratedArchive.entries));
console.log(`merged coverage: ${mergedCov.firstDay} → ${mergedCov.lastDay} days=${mergedCov.daysWithData} gaps=${mergedCov.gaps.length} dups=${mergedCov.duplicateRequestIds}`);
