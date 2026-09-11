// lib/migrate.js — 一次性迁移：只读导入 token-tracker 的 usage-archive.json
//
// 源（只读）：~/.hanako/plugin-data/token-tracker/usage-archive.json
//   结构 { version, updatedAt, entries: { [requestId]: 紧凑短键条目 } }
//   实测（2026-09-08）19837 条，覆盖 2026-07-22 起；两代条目键组合：
//     老代（无 sessionId）：a,c,cost,ct,cw,d,e,i,k,m,o,p,sf,sub,t,tot
//     新代（有 sessionId）：a,c,cost,ct,e,i,k,m,o,p,sf,sid,sp,sub,t,tot
//
// 转换规则：
//  - 短键 → 完整 ledger 条目形状（聚合层零分支）；
//  - 条目带 _migrated:true 标记：无 uncachedTokens，命中率分母用
//    input.totalTokens 近似（聚合层统一处理）；
//  - cost 字段一律丢弃（本插件禁止使用费用数据，PLAN 3.3）；
//  - 与 ledger 重叠的 requestId 以账本完整条目为准（信息更全）。

import fs from "node:fs";
import { saveArchive, ARCHIVE_VERSION, slimEntry } from "./archive.js?v=0.7.2";

/**
 * token-tracker 归档短键条目 → 完整 ledger 条目形状。
 */
export function tokenTrackerEntryToLedgerShape(requestId, r) {
  return {
    requestId,
    schemaVersion: 1,
    _migrated: true,
    startedAt: r.t || null,
    endedAt: r.e || null,
    durationMs: typeof r.d === "number" ? r.d : null,
    status: null,
    source: { subsystem: r.sub || "", surface: r.sf || "" },
    attribution: {
      kind: r.k || "",
      agentId: r.a || "unknown",
      sessionId: r.sid || "",
      sessionPath: r.sp || "",
      conversationType: r.ct || "",
    },
    model: { provider: r.p || "", modelId: r.m || "unknown", api: null },
    usage: {
      input: { totalTokens: r.i || 0, uncachedTokens: null },
      output: { totalTokens: r.o || 0, reasoningTokens: null },
      cache: { readTokens: r.c || 0, writeTokens: r.cw || 0, hit: null },
      totalTokens: r.tot || 0,
    },
  };
}

/**
 * 从 token-tracker 归档构建 usage-hub 归档。
 * @param {object} ttArchive 已解析的 token-tracker 归档
 * @param {Array} [ledgerEntries] 当前账本条目（重叠时账本优先）
 * @returns {{archive: object, stats: object}}
 */
export function buildArchiveFromTokenTracker(ttArchive, ledgerEntries = []) {
  const archive = { version: ARCHIVE_VERSION, updatedAt: null, entries: {} };
  const stats = {
    sourceEntries: 0,
    imported: 0,
    overriddenByLedger: 0,
    ledgerMerged: 0,
  };

  // 1. 账本条目先入（瘦身结构，权威）
  const ledgerSeen = new Set();
  for (const e of ledgerEntries) {
    if (!e?.requestId) continue;
    archive.entries[e.requestId] = slimEntry(e);
    ledgerSeen.add(e.requestId);
    stats.ledgerMerged++;
  }

  // 2. 旧归档转换导入（重叠跳过：账本版本信息更全）；转换后即瘦身
  for (const [rid, r] of Object.entries(ttArchive.entries || {})) {
    stats.sourceEntries++;
    if (ledgerSeen.has(rid)) {
      stats.overriddenByLedger++;
      continue;
    }
    archive.entries[rid] = slimEntry(tokenTrackerEntryToLedgerShape(rid, r));
    stats.imported++;
  }

  archive.updatedAt = new Date().toISOString();
  return { archive, stats };
}

/**
 * 执行迁移。默认幂等：目标归档已存在且非空时跳过（除非 force）。
 * dryRun 只计算不写盘。
 * @returns 报告对象（写失败不抛出，记入 report.error）
 */
export function runMigration({
  srcPath,          // token-tracker archive（只读）
  dstPath,          // usage-hub archive 目标
  migrationLogPath, // 迁移记录 JSON
  ledgerEntries = [],
  force = false,
  dryRun = false,
} = {}) {
  const report = {
    at: new Date().toISOString(),
    srcPath,
    dstPath,
    dryRun,
    sourceExists: false,
    skipped: { reason: null },
    stats: null,
    written: false,
    error: null,
  };

  // 幂等：目标已存在且非空 → 跳过；损坏/不可读 → 改名保留后重建，绝不静默覆盖
  if (!force) {
    try {
      const existing = fs.readFileSync(dstPath, "utf-8");
      const data = JSON.parse(existing);
      if (data && data.entries && Object.keys(data.entries).length > 0) {
        report.skipped = { reason: "archive already exists and is non-empty (use --force to re-run)" };
        return report;
      }
    } catch (err) {
      if (err && err.code !== "ENOENT") {
        // 损坏或不可读的归档：改名保留（与 loadArchive 的 .corrupt-* 策略一致），继续重建
        if (dryRun) {
          // dry-run 零写入：只报告，不动文件
          report.preservedCorrupt = true;
        } else {
          try {
            fs.renameSync(dstPath, dstPath + ".corrupt-" + Date.now());
            report.preservedCorrupt = true;
          } catch (renameErr) {
            report.preservedCorrupt = false;
            report.error = "archive exists but unreadable and rename failed: " + String(renameErr?.message || renameErr);
            return report;
          }
        }
      }
    }
  }

  if (!fs.existsSync(srcPath)) {
    report.sourceExists = false;
    report.error = "token-tracker archive not found: " + srcPath;
    return report;
  }
  report.sourceExists = true;

  try {
    const ttArchive = JSON.parse(fs.readFileSync(srcPath, "utf-8"));
    const { archive, stats } = buildArchiveFromTokenTracker(ttArchive, ledgerEntries);
    report.stats = stats;
    if (dryRun) return report;
    saveArchive(dstPath, archive);
    report.written = true;
    try {
      fs.writeFileSync(
        migrationLogPath,
        JSON.stringify(
          { at: report.at, srcPath, dstPath, stats, version: ARCHIVE_VERSION },
          null,
          2
        )
      );
    } catch {}
  } catch (err) {
    report.error = String(err && (err.stack || err.message) || err);
  }
  return report;
}
