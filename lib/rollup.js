// lib/rollup.js — 预聚合存储（rollup.json，0.6.0 起的主存储）
//
// 设计：不再保存全量明细，按「天 + 小时 + 维度」预聚合。
//  - days：全部历史（永久；体积随天数线性，不随调用数增长）
//  - recentSessions：仅最近 30 天（小时图「会话」模式、会话维度用），超期清理
//  - speeds：每会话最多 500 条，总量硬上限 50000（按时间淘汰最旧）
// 增量：以 lastMergedAt（已并入的最大 startedAt）为水位线，仅并入更新的账本条目，
//       避免滚动窗口重复计入。迁移从 archive 明细全量构建。
// 落盘：原子写 + 损坏改名 .corrupt-*（沿用 archive 风格）。

import fs from "node:fs";
import path from "node:path";
import { inputOf, uncachedOf, outputOf, reasoningOf, cacheReadOf, totalTokensOf, entryDay, entryHour, agentOf } from "./aggregate.js?v=0.7.3";
import { sourceTypeOf } from "./types.js?v=0.7.3";
import { ledgerSpeedRecords } from "./speed-scan.js?v=0.7.3";
import { entryCost } from "./pricing.js?v=0.7.3";

export const ROLLUP_VERSION = 1;
export const RECENT_SESSIONS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const SPEED_PER_SESSION_LIMIT = 500;
export const SPEED_TOTAL_LIMIT = 20000;
// 已并入的最近 requestId 上限（覆盖 ledger 5000 条滚动窗口，用于增量去重）
export const RECENT_IDS_LIMIT = 5000;

const DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });

export function emptyRollup() {
  return { version: ROLLUP_VERSION, updatedAt: null, lastMergedAt: null, recentIds: [], days: {}, recentSessions: {}, speeds: [] };
}

export function makeRollupBucket() {
  return { totalTokens: 0, input: 0, uncached: 0, output: 0, reasoning: 0, cacheRead: 0, calls: 0, errors: 0, cost: 0, unpricedCalls: 0 };
}

function isError(e) {
  return e?.status !== undefined && e?.status !== null && e.status !== "ok";
}
function ensure(map, key) {
  if (!map[key]) map[key] = makeRollupBucket();
  return map[key];
}
function addTo(bucket, e, price) {
  bucket.calls += 1;
  bucket.input += inputOf(e);
  bucket.uncached += uncachedOf(e);
  bucket.output += outputOf(e);
  bucket.reasoning += reasoningOf(e);
  bucket.cacheRead += cacheReadOf(e);
  bucket.totalTokens += totalTokensOf(e);
  if (isError(e)) bucket.errors += 1;
  // 旧 rollup bucket 可能没有 cost/unpricedCalls（向后兼容：缺省 0，不触发重迁移）
  if (typeof bucket.cost !== "number") bucket.cost = 0;
  if (typeof bucket.unpricedCalls !== "number") bucket.unpricedCalls = 0;
  // price 三态语义：
  //   null            → skipped：该条目不参与计价（迁移历史），cost 与 unpricedCalls 均不累加
  //   { priced:true } → 累加估算金额 cost
  //   { priced:false }→ 应计价但无价（网关/未知模型），累加 unpricedCalls
  if (price == null) return;
  if (price.priced) bucket.cost += price.cost;
  else bucket.unpricedCalls += 1;
}
function tsOf(e) { return e?.startedAt || e?.endedAt || ""; }
function makeHourBucket() { return { ...makeRollupBucket(), byType: {} }; }
function makeAgentBucket() { return { ...makeRollupBucket(), byType: {}, byModel: {}, byProvider: {} }; }
function ensureHour(map, hh) { if (!map[hh]) map[hh] = makeHourBucket(); return map[hh]; }
function ensureAgentBucket(map, key) { if (!map[key]) map[key] = makeAgentBucket(); return map[key]; }

// 会话文件：优先 sessionFile（瘦身结构），否则由 sessionPath 取 basename（旧明细/账本条目）。
function sessionFileOf(e) {
  const f = e?.attribution?.sessionFile;
  if (typeof f === "string" && f) return f;
  const p = e?.attribution?.sessionPath;
  if (typeof p === "string" && p.trim()) {
    const parts = p.replaceAll("\\", "/").split("/");
    return parts[parts.length - 1] || "";
  }
  return "";
}

/** 把一条明细累加进 rollup（days + recentSessions）。无日期的条目返回 false。
 *  @param {object} [options]
 *  @param {boolean} [options.pricing=true] 是否参与计价：true=增量并入（按条计价）；
 *    false=不参与计价（迁移历史，等价于三态中的 skipped，不产生 cost、也不累加 unpricedCalls）。 */
export function addEntryToRollup(rollup, e, { pricing = true } = {}) {
  const day = entryDay(e);
  if (!day) return false;
  if (!rollup.days[day]) rollup.days[day] = { total: makeRollupBucket(), hours: {}, byType: {}, byAgent: {}, byModel: {}, byProvider: {} };
  const d = rollup.days[day];
  const type = sourceTypeOf(e);
  const agent = agentOf(e);
  const model = e?.model?.modelId || "unknown";
  const provider = e?.model?.provider || "unknown";
  // 每条明细只计价一次，结果复用到所有 bucket（避免 8+ 个 bucket 各算一遍）；
  // pricing=false（迁移）时 price=null → skipped，不调 entryCost，也不动 cost/unpricedCalls。
  const price = pricing ? entryCost(e) : null;
  addTo(d.total, e, price);
  const hour = entryHour(e);
  if (hour != null) { const hb = ensureHour(d.hours, hour); addTo(hb, e, price); addTo(ensure(hb.byType, type), e, price); }
  addTo(ensure(d.byType, type), e, price);
  // agent 维度带交叉表（byType/byModel/byProvider），支持「按 agent 筛选」下的分布卡
  const ab = ensureAgentBucket(d.byAgent, agent);
  addTo(ab, e, price); addTo(ensure(ab.byType, type), e, price); addTo(ensure(ab.byModel, model), e, price); addTo(ensure(ab.byProvider, provider), e, price);
  addTo(ensure(d.byModel, model), e, price);
  addTo(ensure(d.byProvider, provider), e, price);

  const sessionAgent = e?.attribution?.agentId || "unknown";
  const file = sessionFileOf(e);
  if (file) {
    const key = `${sessionAgent}::${file}`;
    if (!rollup.recentSessions[key]) rollup.recentSessions[key] = { agent: sessionAgent, file, sessionId: e?.attribution?.sessionId || "", lastAt: null, days: {} };
    const rs = rollup.recentSessions[key];
    if (!rs.sessionId && e?.attribution?.sessionId) rs.sessionId = e.attribution.sessionId;
    const t = tsOf(e);
    if (t && (!rs.lastAt || t > rs.lastAt)) rs.lastAt = t;
    if (!rs.days[day]) rs.days[day] = { total: makeRollupBucket(), hours: {} };
    addTo(rs.days[day].total, e, price);
    if (hour != null) addTo(ensure(rs.days[day].hours, hour), e, price);
  }
  return true;
}

/** 保留期：30 天 + 每会话最多 SPEED_PER_SESSION_LIMIT + 总量最多 SPEED_TOTAL_LIMIT（按 ts 淘汰最旧）。
 *  与 speeds.json 的 pruneSpeedCache 同口径。无 sessionId 的记录不做「每会话」限制。 */
export function pruneSpeeds(speeds, now = Date.now()) {
  const cutoff = DAY_FMT.format(new Date(now - RECENT_SESSIONS_MAX_AGE_MS));
  const bySession = new Map();
  const kept = [];
  for (const s of speeds) {
    if (!s) continue;
    if ((s.day || "") < cutoff) continue; // 30 天保留期
    const key = s.sessionId || "";
    if (!key) { kept.push(s); continue; }
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(s);
  }
  for (const arr of bySession.values()) {
    arr.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    kept.push(...arr.slice(0, SPEED_PER_SESSION_LIMIT));
  }
  kept.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return kept.slice(0, SPEED_TOTAL_LIMIT);
}

/** 清理 recentSessions 中超过 RECENT_SESSIONS_MAX_AGE_MS 的天；无剩余天的会话整体删除。 */
export function pruneRecentSessions(rollup, now = Date.now()) {
  const cutoff = DAY_FMT.format(new Date(now - RECENT_SESSIONS_MAX_AGE_MS));
  for (const [key, rs] of Object.entries(rollup.recentSessions || {})) {
    for (const day of Object.keys(rs.days || {})) if (day < cutoff) delete rs.days[day];
    if (!Object.keys(rs.days || {}).length) delete rollup.recentSessions[key];
  }
}

/** 从明细全量构建 rollup（**迁移路径**，migrateArchiveToRollup 复用）。speeds 为可选的额外速度记录。
 *  计价策略：迁移的历史条目**不参与计价**（skipped）——不产生 cost，也不累加 unpricedCalls，
 *  以贯彻「不回填历史、只从升级后新并入的条目起算」。计价只发生在 mergeLedgerIntoRollup。 */
export function buildRollup(entries, { now = Date.now(), speeds = [], seedRequestIds = [] } = {}) {
  const rollup = emptyRollup();
  let lastMergedAt = null;
  const idTimes = [];
  for (const e of entries || []) {
    addEntryToRollup(rollup, e, { pricing: false });
    const t = tsOf(e);
    if (t && (!lastMergedAt || t > lastMergedAt)) lastMergedAt = t;
    if (e?.requestId && t) idTimes.push([e.requestId, t]);
  }
  // seed：账本 requestId 全集 ∪ archive 最近 RECENT_IDS_LIMIT 条（旧→新），供后续增量去重
  idTimes.sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
  const recent = idTimes.slice(0, RECENT_IDS_LIMIT).map(([rid]) => rid).reverse();
  rollup.recentIds = [...new Set([...(seedRequestIds || []).filter(Boolean), ...recent])].slice(-RECENT_IDS_LIMIT);
  rollup.speeds = pruneSpeeds([...ledgerSpeedRecords(entries || []), ...(speeds || [])], now);
  rollup.lastMergedAt = lastMergedAt;
  pruneRecentSessions(rollup, now);
  rollup.updatedAt = new Date().toISOString();
  return rollup;
}

/** 增量并入账本条目：以 recentIds 判重为主；recentIds 缺失（旧/异常存储）时退化为水位线判重，
 *  避免把整份账本重新并入导致全量双计。 */
export function mergeLedgerIntoRollup(rollup, entries, { now = Date.now() } = {}) {
  if (!Array.isArray(rollup.recentIds)) { rollup.recentIds = []; rollup.recentIdsMissing = true; }
  const recent = new Set(rollup.recentIds);
  const useWatermark = rollup.recentIdsMissing === true;
  const fresh = [];
  for (const e of entries || []) {
    const rid = e?.requestId;
    const t = tsOf(e);
    if (!t) continue;
    if (useWatermark) {
      if (rollup.lastMergedAt && t <= rollup.lastMergedAt) continue;
    } else if (rid && recent.has(rid)) continue; // 已并入
    fresh.push(e);
    addEntryToRollup(rollup, e);
    if (rid) {
      rollup.recentIds.push(rid);
      if (rollup.recentIds.length > RECENT_IDS_LIMIT) rollup.recentIds.splice(0, rollup.recentIds.length - RECENT_IDS_LIMIT);
      recent.add(rid);
    }
    if (t > (rollup.lastMergedAt || "")) rollup.lastMergedAt = t;
  }
  if (fresh.length) rollup.speeds = pruneSpeeds([...rollup.speeds, ...ledgerSpeedRecords(fresh)], now);
  pruneRecentSessions(rollup, now);
  rollup.updatedAt = new Date().toISOString();
  return { added: fresh.length, watermarkOnly: useWatermark };
}

export function loadRollup(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || !data.days || typeof data.days !== "object") throw new Error("rollup structure invalid");
    if (!data.recentSessions || typeof data.recentSessions !== "object") data.recentSessions = {};
    if (!Array.isArray(data.speeds)) data.speeds = [];
    if (!Array.isArray(data.recentIds)) { data.recentIds = []; data.recentIdsMissing = true; }
    return data;
  } catch (err) {
    try { fs.renameSync(filePath, filePath + ".corrupt-" + Date.now()); } catch {}
    throw err;
  }
}

export function saveRollup(filePath, rollup) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(rollup));
  fs.renameSync(tmp, filePath);
}

/**
 * 一次性迁移：从 archive.json 明细聚合出 rollup.json。
 * 先写 rollup（原子），再把 archive 改名备份 archive.pre-rollup-<ts>.json（不覆盖，不删除）。
 * 失败时原 archive 不被破坏；重复执行由调用方按「rollup 已存在则跳过」保证幂等。
 */
export function migrateArchiveToRollup(archivePath, rollupPath, { now = Date.now(), speeds = [], seedRequestIds = [], ledgerEntries = [] } = {}) {
  const archive = JSON.parse(fs.readFileSync(archivePath, "utf-8"));
  // v2 archive（瘦身过、可能无 actorAgentId）：尽量从账本窗口补子代理归属
  const actorById = new Map();
  for (const e of ledgerEntries) {
    const actor = e?.source?.actor?.agentId;
    if (e?.requestId && actor) actorById.set(e.requestId, actor);
  }
  const entries = Object.values(archive.entries || {});
  let actorRecovered = 0, actorUnrecovered = 0;
  for (const e of entries) {
    if (e?.source?.subsystem !== "subagent") continue;
    if (e?.attribution?.actorAgentId || e?.source?.actor?.agentId) continue;
    const actor = actorById.get(e?.requestId);
    if (actor) { e.attribution = { ...(e.attribution || {}), actorAgentId: actor }; actorRecovered++; }
    else actorUnrecovered++;
  }
  const rollup = buildRollup(entries, { now, speeds, seedRequestIds });
  saveRollup(rollupPath, rollup); // 先落新存储，确保不会在无 rollup 的情况下动 archive

  const base = archivePath.replace(/\.json$/, "");
  let backupPath = `${base}.pre-rollup-${now}.json`;
  let n = 1;
  while (fs.existsSync(backupPath)) backupPath = `${base}.pre-rollup-${now}-${n++}.json`;
  let backupError = null;
  try {
    fs.renameSync(archivePath, backupPath);
  } catch (err) {
    backupPath = null;
    backupError = String(err?.message || err);
  }
  return { rollup, backupPath, backupError, actorRecovered, actorUnrecovered };
}
