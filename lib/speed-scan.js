// lib/speed-scan.js — 端到端输出速率扫描（对齐 token-tracker 0.4.4）
//
// 双口径（照 token-tracker）：
//  1) 会话 JSONL 口径：会话 JSONL 内相邻两条 assistant 消息的 timestamp 差 durMs；
//     过滤 100ms <= durMs <= 600000ms；tps = 上一条消息的 output / (durMs/1000)。
//  2) ledger 口径：usage-ledger 条目自带 durationMs，同样 100ms <= durMs <= 600000ms && out > 0；
//     tps = out / (durMs/1000)。只收 memory / utility（token-tracker index.js:555-556 白名单），
//     这两个子系统没有 JSONL 消息流，避免与 JSONL 口径对同一请求重复计数。
//
// 扫描范围：每个 agent 下 sessions / subagent-sessions / activity / workflow-sessions 四类目录，
// 递归收集 *.jsonl（拒绝符号链接，排除 .repair.jsonl）。记录带 type：sessions→session、
// subagent-sessions→subagent、activity/workflow-sessions→automation。agent 归属沿用父目录名。
//
// 缓存：按文件 mtime + size 增量，只存派生统计（ts/type/model/provider/out/reasoning/durMs/tps/textTps），
// 绝不落盘会话原文。落盘 plugin-data/usage-hub/speeds.json，原子写 + 损坏改名 .corrupt-*。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MAX_SESSION_FILE_BYTES, MAX_SESSION_EVENTS, usageOf } from "./session-reader.js?v=0.8.0";
import { sourceTypeOf } from "./types.js?v=0.8.0";
import { agentOf } from "./aggregate.js?v=0.8.0";

export const SPEED_CACHE_VERSION = 2;
export const SPEED_MIN_DUR_MS = 100;
export const SPEED_MAX_DUR_MS = 600000;
export const SPEED_PER_FILE_LIMIT = 500;
// speeds.json 保留期与总量硬上限（与 recentSessions 同窗口）
export const SPEED_RETENTION_DAYS = 30;
export const SPEED_TOTAL_LIMIT = 20000;

// ledger 口径白名单（与 token-tracker 一致）：只收无 JSONL 消息流的子系统
const LEDGER_SPEED_TYPES = new Set(["memory", "utility"]);

// agent 目录下的四类会话目录 → 记录 type
const DIR_TYPES = {
  sessions: "session",
  "subagent-sessions": "subagent",
  activity: "automation",
  "workflow-sessions": "automation",
};
export const AGENT_SESSION_SUBDIRS = Object.keys(DIR_TYPES);

const SHANGHAI_DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });

function shanghaiDay(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return SHANGHAI_DAY_FMT.format(d);
}

function typeOfDir(dir) {
  return DIR_TYPES[path.basename(dir)] || "session";
}

export function emptySpeedCache() {
  return { version: SPEED_CACHE_VERSION, updatedAt: null, files: {} };
}

/** 读速度缓存；不存在返回 null；损坏改名 .corrupt-* 后抛出（风格对齐 archive.js）。 */
export function loadSpeedCache(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || !data.files || typeof data.files !== "object") {
      throw new Error("speed cache structure invalid");
    }
    return data;
  } catch (err) {
    try {
      fs.renameSync(filePath, filePath + ".corrupt-" + Date.now());
    } catch {}
    throw err;
  }
}

/** 原子写速度缓存：tmp + rename。 */
export function saveSpeedCache(filePath, cache) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, filePath);
}

/** 是否需要落盘：内容有变化或文件集合增删时写；纯 reused 跳过。 */
export function shouldPersistSpeedCache({ changed = 0, fileSetChanged = false } = {}) {
  return changed > 0 || fileSetChanged;
}

/** ledger 条目输出 token（usage.output 可能是数字或 {totalTokens}）。 */
function ledgerOutputOf(entry) {
  const output = entry?.usage?.output;
  if (typeof output === "number") return output;
  const n = Number(output?.totalTokens);
  return Number.isFinite(n) ? n : 0;
}

/** ledger 条目推理 token（usage.output.reasoningTokens）。 */
function ledgerReasoningOf(entry) {
  const n = Number(entry?.usage?.output?.reasoningTokens);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 解析单个会话 JSONL 的端到端输出速率记录。
 * 只读取 message.usage，不保留任何会话原文。
 */
export function parseSessionSpeedRecords(content, { agent, type = "session" } = {}) {
  const records = [];
  let sessionId = "";
  let currentProvider = null;
  let lastModel = null;
  let prev = null; // { t, out, reasoning }
  let events = 0;
  for (const line of String(content || "").split("\n")) {
    if (!line.trim()) continue;
    if (events >= MAX_SESSION_EVENTS) break;
    events++;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "session" && event.id) { sessionId = String(event.id); continue; }
    if (event?.type === "model_change" && event.provider) {
      currentProvider = event.provider;
      lastModel = null;
      continue;
    }
    if (event?.type !== "message" || event?.message?.role !== "assistant") continue;
    const usage = usageOf(event.message);
    if (!usage) continue;
    const ts = event.timestamp || event.message.timestamp || "";
    const model = event.message.model || event.modelId || "unknown";
    const provider = event.message.provider || currentProvider || "";
    if (prev) {
      const lastT = new Date(prev.t).getTime();
      const curT = new Date(ts).getTime();
      if (!Number.isNaN(lastT) && !Number.isNaN(curT) && curT > lastT) {
        const durMs = curT - lastT;
        if (durMs >= SPEED_MIN_DUR_MS && durMs <= SPEED_MAX_DUR_MS) {
          const textOut = Math.max(0, prev.out - prev.reasoning);
          records.push({
            ts,
            day: shanghaiDay(ts),
            agent: agent || null,
            type,
            sessionId,
            model,
            provider,
            out: prev.out,
            reasoning: prev.reasoning,
            durMs,
            tps: +(prev.out / (durMs / 1000)).toFixed(2),
            textTps: +(textOut / (durMs / 1000)).toFixed(2),
            source: "jsonl",
          });
          if (records.length > SPEED_PER_FILE_LIMIT) records.splice(0, records.length - SPEED_PER_FILE_LIMIT);
        }
      }
    }
    // 模型变化但没有 model_change 事件 → 无法判断供应商，置空（对齐参考实现）
    if (lastModel !== null && lastModel !== model) currentProvider = null;
    lastModel = model;
    prev = { t: ts, out: usage.output, reasoning: usage.reasoning || 0 };
  }
  return records;
}

/** ledger 口径记录（仅 memory/utility 白名单，避免与 JSONL 重复计数）。 */
export function ledgerSpeedRecords(entries) {
  const out = [];
  for (const e of entries || []) {
    const type = sourceTypeOf(e);
    if (!LEDGER_SPEED_TYPES.has(type)) continue;
    const durMs = Number(e?.durationMs) || 0;
    if (!(durMs >= SPEED_MIN_DUR_MS && durMs <= SPEED_MAX_DUR_MS)) continue;
    const output = ledgerOutputOf(e);
    if (!(output > 0)) continue;
    const reasoning = Math.min(output, ledgerReasoningOf(e));
    const ts = e.startedAt || e.endedAt || "";
    const tps = +(output / (durMs / 1000)).toFixed(2);
    out.push({
      ts,
      day: shanghaiDay(ts),
      agent: agentOf(e),
      type,
      sessionId: e?.attribution?.sessionId || "",
      model: e?.model?.modelId || "unknown",
      provider: e?.model?.provider || "",
      out: output,
      reasoning,
      durMs,
      tps,
      textTps: +((output - reasoning) / (durMs / 1000)).toFixed(2),
      source: "ledger",
    });
  }
  return out;
}

/** 递归收集 dir 下的 .jsonl 相对路径（拒绝符号链接，排除 .repair.jsonl）。 */
function walkJsonl(dir, base = "", out = []) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(dir, base), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) walkJsonl(dir, rel, out);
    else if (ent.isFile() && ent.name.endsWith(".jsonl") && !ent.name.includes(".repair.jsonl")) out.push(rel);
  }
  return out;
}

/** 列出 agents 根目录下每个 agent 的四类会话目录（sessions/subagent-sessions/activity/workflow-sessions）。 */
export function agentSessionDirs(agentsRoot) {
  const dirs = [];
  let entries;
  try {
    entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
    for (const name of AGENT_SESSION_SUBDIRS) {
      const dir = path.join(agentsRoot, ent.name, name);
      try {
        const stat = fs.lstatSync(dir);
        if (stat.isDirectory() && !stat.isSymbolicLink()) dirs.push(dir);
      } catch {}
    }
  }
  return dirs;
}

/**
 * mtime + size 增量扫描多个会话目录，产出并缓存 speed 记录。
 * 读取使用异步 IO，避免首次全量扫描阻塞宿主事件循环。
 */
export async function scanSessionSpeeds({ sessionsDirs = [], cache = emptySpeedCache(), warn } = {}) {
  const dirs = [...new Set((Array.isArray(sessionsDirs) ? sessionsDirs : [sessionsDirs]).filter((v) => typeof v === "string" && v.trim()))];
  const nextFiles = {};
  let changed = 0, reused = 0, skipped = 0;
  for (const dir of dirs) {
    const agent = path.basename(path.dirname(dir));
    const type = typeOfDir(dir);
    for (const rel of walkJsonl(dir)) {
      const full = path.join(dir, rel);
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const key = `${type}::${agent}::${rel}`;
      const prev = cache.files?.[key];
      if (prev && prev.mtime === stat.mtimeMs && prev.size === stat.size) {
        nextFiles[key] = prev;
        reused++;
        continue;
      }
      if (stat.size > MAX_SESSION_FILE_BYTES) {
        warn?.(`跳过超限 JSONL: ${rel} (${stat.size} bytes)`);
        skipped++;
        continue;
      }
      let content;
      try {
        content = await fsp.readFile(full, "utf8");
      } catch {
        skipped++;
        continue;
      }
      nextFiles[key] = { mtime: stat.mtimeMs, size: stat.size, agent, type, speeds: parseSessionSpeedRecords(content, { agent, type }) };
      changed++;
    }
  }
  const prevKeys = Object.keys(cache.files || {});
  const nextKeys = Object.keys(nextFiles);
  const prevSet = new Set(prevKeys);
  const fileSetChanged = prevKeys.length !== nextKeys.length || nextKeys.some((key) => !prevSet.has(key));
  return { cache: { version: SPEED_CACHE_VERSION, updatedAt: new Date().toISOString(), files: nextFiles }, changed, reused, skipped, fileSetChanged };
}

/** 展平缓存中的所有 speed 记录。 */
export function flattenSpeedRecords(cache) {
  const out = [];
  for (const entry of Object.values(cache?.files || {})) {
    if (entry && Array.isArray(entry.speeds)) out.push(...entry.speeds);
  }
  return out;
}

/**
 * 清理速度缓存（在扫描/写入时顺手做，不在读取路径）：
 * 保留最近 SPEED_RETENTION_DAYS 天，每文件最多 SPEED_PER_FILE_LIMIT，总量最多 SPEED_TOTAL_LIMIT（按 ts 淘汰最旧）。
 * 返回被移除的记录数。
 */
export function pruneSpeedCache(cache, { now = Date.now() } = {}) {
  const files = cache?.files || {};
  const count = () => Object.values(files).reduce((sum, entry) => sum + (Array.isArray(entry?.speeds) ? entry.speeds.length : 0), 0);
  const before = count();
  const cutoff = SHANGHAI_DAY_FMT.format(new Date(now - SPEED_RETENTION_DAYS * 86400000));
  for (const entry of Object.values(files)) {
    if (!entry || !Array.isArray(entry.speeds)) continue;
    entry.speeds = entry.speeds.filter((s) => (s.day || "") >= cutoff).slice(-SPEED_PER_FILE_LIMIT);
  }
  const all = flattenSpeedRecords(cache);
  if (all.length > SPEED_TOTAL_LIMIT) {
    const sorted = [...all].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    const keep = new Set(sorted.slice(0, SPEED_TOTAL_LIMIT));
    for (const entry of Object.values(files)) {
      if (!entry || !Array.isArray(entry.speeds)) continue;
      entry.speeds = entry.speeds.filter((s) => keep.has(s));
    }
  }
  return before - count();
}
