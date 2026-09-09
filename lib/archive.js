// lib/archive.js — 归档器：从滚动窗口 ledger 增量归档，requestId 唯一键去重
//
// 归档文件 ~/.hanako/plugin-data/usage-hub/archive.json：
//   { version, updatedAt, entries: { [requestId]: 瘦身条目 } }
//
// 存储策略：只保存统计/展示必需字段（白名单 slimEntry），
// 实测 ~1208 B/条 → ~330 B/条；新写入即转换，读取零转换。
// 迁移：旧版本（version < ARCHIVE_VERSION）首次加载时就地瘦身，原文件改名备份为
// archive.pre-slim-<ts>.json，瘦身结果原子写（tmp + rename）；失败保留原文件。
//
// 合并规则（不变量）：
//  - 同 requestId 只保留一条（唯一键去重）；
//  - 完整 ledger 条目优先于迁移条目（迁移条目 _migrated:true，信息不完整）；
//  - 两条完整条目相同 requestId 时保留已有归档（账本与归档内容一致）。

import fs from "node:fs";
import path from "node:path";
import { isUsableEntry } from "./ledger-reader.js?v=0.6.0";

export const ARCHIVE_VERSION = 2;

// 归档写盘节流阈值：距上次写盘 >= 5 分钟才落盘。
// 安全性：ledger 是 5000 条滚动窗口，延迟落盘最多丢阈值内新增条目，
// 下次 refresh/启动可从 ledger 补回，不构成数据丢失风险。
export const ARCHIVE_SAVE_MIN_INTERVAL_MS = 300000;

/**
 * 是否到写盘时机：距上次写盘 >= 阈值（默认 5 分钟）。
 * lastSavedAt 为 0/缺省（启动首刷）时允许立即写。
 */
export function archiveSaveDue(lastSavedAt, now = Date.now(), minIntervalMs = ARCHIVE_SAVE_MIN_INTERVAL_MS) {
  return now - (lastSavedAt || 0) >= minIntervalMs;
}

export function emptyArchive() {
  return { version: ARCHIVE_VERSION, updatedAt: null, entries: {} };
}

function basenameOf(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const parts = value.replaceAll("\\", "/").split("/");
  return parts[parts.length - 1] || "";
}

/**
 * 瘦身：只保留统计/展示必需字段（白名单）。
 * 缺失字段不补 0（保持「缺失→回退」语义，如 uncachedTokens 缺失时聚合层用 input.totalTokens 近似）。
 * 保留：requestId/startedAt/endedAt/durationMs/status、usage.{input,output,cache,totalTokens}、
 * model.{provider,modelId}、source.{subsystem,operation}、
 * attribution.{kind,agentId,sessionId,sessionFile(由 sessionPath basename 生成)}、_migrated。
 */
export function slimEntry(e) {
  if (!e || typeof e !== "object") return e;
  const u = e.usage || {};
  const input = {};
  if (typeof u.input?.totalTokens === "number") input.totalTokens = u.input.totalTokens;
  if (typeof u.input?.uncachedTokens === "number") input.uncachedTokens = u.input.uncachedTokens;
  const output = {};
  if (typeof u.output?.totalTokens === "number") output.totalTokens = u.output.totalTokens;
  if (typeof u.output?.reasoningTokens === "number") output.reasoningTokens = u.output.reasoningTokens;
  const cache = {};
  if (typeof u.cache?.readTokens === "number") cache.readTokens = u.cache.readTokens;
  if (typeof u.cache?.writeTokens === "number") cache.writeTokens = u.cache.writeTokens;
  const usage = { input, output, cache };
  if (typeof u.totalTokens === "number") usage.totalTokens = u.totalTokens;
  const actorAgentId = e.source?.actor?.agentId || e.attribution?.actorAgentId;

  const out = {
    requestId: e.requestId,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    durationMs: e.durationMs,
    status: e.status,
    usage,
    model: { provider: e.model?.provider, modelId: e.model?.modelId },
    source: { subsystem: e.source?.subsystem, operation: e.source?.operation },
    attribution: {
      kind: e.attribution?.kind,
      agentId: e.attribution?.agentId,
      sessionId: e.attribution?.sessionId,
      sessionFile: e.attribution?.sessionFile || basenameOf(e.attribution?.sessionPath),
      // 子代理真正归属：由 source.actor.agentId 提升而来（无则省略），避免瘦身删掉 source.actor 后丢失
      ...(actorAgentId ? { actorAgentId } : {}),
    },
  };
  if (e._migrated === true) out._migrated = true;
  return out;
}

/** 纯内存瘦身（不写盘）：返回新归档对象。 */
export function slimArchive(archive) {
  const entries = {};
  for (const [rid, e] of Object.entries(archive?.entries || {})) entries[rid] = slimEntry(e);
  return { version: ARCHIVE_VERSION, updatedAt: archive?.updatedAt || null, entries };
}

/**
 * 就地将旧归档瘦身为当前版本：先把原文件改名备份 archive.pre-slim-<ts>.json（不覆盖），
 * 瘦身结果原子写（tmp + rename）。失败时恢复原文件并抛出，保证原数据不被破坏；幂等（已是当前版本不应调用）。
 */
export function migrateArchiveToSlim(filePath, archive, { now = Date.now() } = {}) {
  const slim = slimArchive(archive);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  const base = filePath.replace(/\.json$/, "");
  let backupPath = `${base}.pre-slim-${now}.json`;
  let n = 1;
  while (fs.existsSync(backupPath)) backupPath = `${base}.pre-slim-${now}-${n++}.json`;
  let backedUp = false;
  try {
    fs.writeFileSync(tmp, JSON.stringify(slim));
    fs.renameSync(filePath, backupPath);
    backedUp = true;
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (backedUp && !fs.existsSync(filePath)) {
      try { fs.renameSync(backupPath, filePath); } catch {}
    }
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
  return { archive: slim, backupPath };
}

/**
 * 读归档。文件不存在返回 null。
 * JSON 损坏时把损坏文件改名保留（.corrupt-<ts>）再返回 null，绝不静默覆盖历史数据。
 */
export function loadArchive(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || !data.entries || typeof data.entries !== "object") {
      throw new Error("archive structure invalid");
    }
    return data;
  } catch (err) {
    try {
      fs.renameSync(filePath, filePath + ".corrupt-" + Date.now());
    } catch {}
    throw err;
  }
}

/**
 * 原子写归档：tmp + rename，杜绝半截文件。
 */
export function saveArchive(filePath, archive) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(archive));
  fs.renameSync(tmp, filePath);
}

/**
 * 把 ledger 条目合并进归档（就地修改 archive.entries）。
 * 返回 { added, upgraded, skipped, unusable } 统计。
 */
export function mergeIntoArchive(archive, ledgerEntries) {
  const stats = { added: 0, upgraded: 0, skipped: 0, unusable: 0 };
  for (const e of ledgerEntries) {
    if (!isUsableEntry(e)) {
      stats.unusable++;
      continue;
    }
    const rid = e.requestId;
    const existing = archive.entries[rid];
    if (existing && !existing._migrated) {
      // 已有完整条目：内容一致，跳过。
      stats.skipped++;
      continue;
    }
    if (existing && existing._migrated) {
      // 迁移来的不完整条目，被账本完整条目替换。
      stats.upgraded++;
    } else {
      stats.added++;
    }
    archive.entries[rid] = slimEntry(e);
  }
  return stats;
}

/**
 * 合并后的全量数据视图：归档条目 + 账本中归档还没有的条目。
 * 归档写盘失败时也能得到正确的内存视图（统计不因不可写而失真）。
 */
export function mergedEntries(archive, ledgerEntries) {
  const out = Object.values(archive.entries || {});
  const seen = new Set(out.filter(isUsableEntry).map(e => e.requestId));
  for (const e of ledgerEntries) {
    if (!isUsableEntry(e) || seen.has(e.requestId)) continue;
    out.push(e);
    seen.add(e.requestId);
  }
  return out;
}
