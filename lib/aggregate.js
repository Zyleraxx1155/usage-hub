// lib/aggregate.js — 聚合接口：按时间 / agent / 模型 / 供应商 / 来源类型
//
// 口径（PLAN 3.3/3.4，已实测确认，勿改动）：
//  - usage.cache.readTokens：本轮命中缓存的 token 数（非累计）
//  - usage.input.uncachedTokens：本轮未命中输入
//  - usage.totalTokens = input + output + cacheRead
//  - 命中率 = Σ cacheRead ÷ Σ (cacheRead + uncachedInput)（总比口径，非平均）
//  - usage.costTotal 恒为 0，禁止使用 → 本模块完全不读取该字段
//  - 迁移数据（_migrated）无 uncachedTokens，近似用 input.totalTokens 代替，
//    属于历史数据近似，不影响 ledger 原生数据的精确口径。

import { sourceTypeOf, sourceTypeLabel, TYPE_OTHER } from "./types.js?v=0.8.0";

// 日/小时分桶使用 Asia/Shanghai 时区（与 token-tracker、Hana 显示习惯一致）
const DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });
const HOUR_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  hour12: false,
});

export function inputOf(e) {
  return e?.usage?.input?.totalTokens ?? 0;
}
export function uncachedOf(e) {
  const u = e?.usage?.input?.uncachedTokens;
  if (typeof u === "number") return u;
  // 迁移条目：无 uncachedTokens，用 input.totalTokens 近似（记录见模块头注释）
  return inputOf(e);
}
export function outputOf(e) {
  return e?.usage?.output?.totalTokens ?? 0;
}
export function reasoningOf(e) {
  return e?.usage?.output?.reasoningTokens ?? 0;
}
export function cacheReadOf(e) {
  return e?.usage?.cache?.readTokens ?? 0;
}
export function totalTokensOf(e) {
  return e?.usage?.totalTokens ?? 0;
}

/**
 * agent 归属（统一口径）：subagent 条目用真正的子代理（source.actor.agentId / 瘦身后的
 * attribution.actorAgentId），其余用 attribution.agentId；缺失回退父 agent（不丢条目）。
 */
export function agentOf(e) {
  if (e?.source?.subsystem === "subagent") {
    const actor = e?.attribution?.actorAgentId || e?.source?.actor?.agentId;
    if (typeof actor === "string" && actor) return actor;
  }
  return e?.attribution?.agentId || "unknown";
}

/**
 * 条目日期（Asia/Shanghai）。无时间返回 null。
 */
export function entryDay(e) {
  const t = e?.startedAt || e?.endedAt;
  if (!t) return null;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return DAY_FMT.format(d);
}

export function entryHour(e) {
  const t = e?.startedAt || e?.endedAt;
  if (!t) return null;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return String(HOUR_FMT.format(d)).padStart(2, "0");
}

export function makeBucket() {
  return { calls: 0, input: 0, uncached: 0, output: 0, reasoning: 0, cacheRead: 0, totalTokens: 0, latencyN: 0, latencySum: 0, latencyValues: [], errors: 0, cost: 0, unpricedCalls: 0 };
}

// 计时可信度：0/1ms 是账本里普遍存在的计时缺失（实测 5000 条中 4372 条为 0、205 条为 1），
// 不能当作真实耗时参与延迟统计，故要求 durationMs 为有限数且 >= 2。
// 生成速度已改由 lib/speed-scan.js + lib/speed-stats.js 加权口径提供，本模块不再计算吞吐。
const MIN_TRUSTED_DURATION_MS = 2;

function latencyOf(e) {
  const n = Number(e?.durationMs);
  return Number.isFinite(n) && n >= MIN_TRUSTED_DURATION_MS ? n : null;
}
const LATENCY_BUCKETS = [
  ["0-99ms", 0, 100],
  ["100-499ms", 100, 500],
  ["500-999ms", 500, 1000],
  ["1-2s", 1000, 2000],
  ["2-5s", 2000, 5000],
  ["5-10s", 5000, 10000],
  ["10s+", 10000, Infinity],
];

function latencyStats(b) {
  const values = [...b.latencyValues].sort((a, z) => a - z);
  const percentile = (p) => values.length ? values[Math.floor((values.length - 1) * p)] : null;
  const buckets = Object.fromEntries(LATENCY_BUCKETS.map(([label]) => [label, 0]));
  for (const value of values) {
    const bucket = LATENCY_BUCKETS.find(([, min, max]) => value >= min && value < max);
    if (bucket) buckets[bucket[0]] += 1;
  }
  return { n: values.length, avg: values.length ? b.latencySum / values.length : null, p50: percentile(0.5), p95: percentile(0.95), max: values.at(-1) ?? null, buckets };
}
function publicBucket(b) {
  const { latencyValues, latencyN, latencySum, errors, ...base } = b;
  return { ...base, latency: latencyStats(b), errors };
}
function publicTypeBuckets(typeMap) {
  return Object.fromEntries([...typeMap.entries()].map(([type, bucket]) => [type, { ...publicBucket(bucket), hitRatio: bucketHitRatio(bucket) }]));
}

export function bucketHitRatio(b) {
  const denom = (b.cacheRead || 0) + (b.uncached || 0);
  return denom > 0 ? (b.cacheRead || 0) / denom : null;
}

function addEntry(b, e) {
  b.calls += 1;
  b.input += inputOf(e);
  b.uncached += uncachedOf(e);
  b.output += outputOf(e);
  b.reasoning += reasoningOf(e);
  b.cacheRead += cacheReadOf(e);
  b.totalTokens += totalTokensOf(e);
  const duration = latencyOf(e);
  if (duration != null) { b.latencyN += 1; b.latencySum += duration; b.latencyValues.push(duration); }
  if (e?.status !== undefined && e?.status !== null && e.status !== "ok") b.errors += 1;
}

/**
 * 构建筛选谓词。支持 from/to（日期，含端点）、agent、model、provider、type。
 * type 取值即来源类型 key（session/subagent/.../other）。
 */
export function buildFilter(filters = {}) {
  const { from = "", to = "", agent = "", model = "", provider = "", type = "", hiddenAgents = [], hiddenModels = [] } = filters || {};
  const hiddenAgentSet = new Set(Array.isArray(hiddenAgents) ? hiddenAgents : []);
  const hiddenModelSet = new Set(Array.isArray(hiddenModels) ? hiddenModels : []);
  return (e) => {
    const entryAgent = agentOf(e);
    const entryModel = e?.model?.modelId || "unknown";
    if (hiddenAgentSet.has(entryAgent) || hiddenModelSet.has(entryModel)) return false;
    if (agent && entryAgent !== agent) return false;
    if (model && entryModel !== model) return false;
    if (provider && (e?.model?.provider || "unknown") !== provider) return false;
    if (type && sourceTypeOf(e) !== type) return false;
    const day = entryDay(e);
    if (from || to) {
      if (!day) return false; // 时间筛选下，无时间记录不计入
      if (from && day < from) return false;
      if (to && day > to) return false;
    }
    return true;
  };
}

/**
 * 主聚合入口。
 * @param {Array} entries 混合数据（归档 + 账本，已按 requestId 去重）
 * @param {object} [filters] { from, to, agent, model, provider, type }
 * @returns {object} summary / byType / byAgent / byModel / byProvider / daily / hourlyByDay
 */
export function aggregateEntries(entries, filters = {}) {
  const pass = buildFilter(filters);

  const summary = makeBucket();
  const byType = new Map();
  const byAgent = new Map();
  const byModel = new Map();
  const byProvider = new Map();
  const daily = new Map();
  const dailyByType = new Map();
  const hourlyByDay = new Map(); // day -> Map(hour -> bucket)
  const hourlyByDayByType = new Map();
  const hourlyByDayByAgent = new Map(); // day -> hour -> Map(sessionId -> bucket)

  let matched = 0;
  for (const e of entries) {
    if (!pass(e)) continue;
    matched += 1;
    addEntry(summary, e);

    const t = sourceTypeOf(e);
    if (!byType.has(t)) byType.set(t, makeBucket());
    addEntry(byType.get(t), e);

    const a = agentOf(e);
    if (!byAgent.has(a)) byAgent.set(a, makeBucket());
    addEntry(byAgent.get(a), e);

    const m = e?.model?.modelId || "unknown";
    if (!byModel.has(m)) byModel.set(m, makeBucket());
    addEntry(byModel.get(m), e);

    const p = e?.model?.provider || "unknown";
    if (!byProvider.has(p)) byProvider.set(p, makeBucket());
    addEntry(byProvider.get(p), e);

    const day = entryDay(e);
    if (day) {
      if (!daily.has(day)) daily.set(day, makeBucket());
      addEntry(daily.get(day), e);
      if (!dailyByType.has(day)) dailyByType.set(day, new Map());
      if (!dailyByType.get(day).has(t)) dailyByType.get(day).set(t, makeBucket());
      addEntry(dailyByType.get(day).get(t), e);

      const hour = entryHour(e);
      if (hour != null) {
        if (!hourlyByDay.has(day)) hourlyByDay.set(day, new Map());
        const hours = hourlyByDay.get(day);
        if (!hours.has(hour)) hours.set(hour, makeBucket());
        addEntry(hours.get(hour), e);
        if (!hourlyByDayByType.has(day)) hourlyByDayByType.set(day, new Map());
        if (!hourlyByDayByType.get(day).has(hour)) hourlyByDayByType.get(day).set(hour, new Map());
        if (!hourlyByDayByType.get(day).get(hour).has(t)) hourlyByDayByType.get(day).get(hour).set(t, makeBucket());
        addEntry(hourlyByDayByType.get(day).get(hour).get(t), e);
        const sid = e?.attribution?.sessionId || "unknown";
        if (!hourlyByDayByAgent.has(day)) hourlyByDayByAgent.set(day, new Map());
        if (!hourlyByDayByAgent.get(day).has(hour)) hourlyByDayByAgent.get(day).set(hour, new Map());
        if (!hourlyByDayByAgent.get(day).get(hour).has(sid)) hourlyByDayByAgent.get(day).get(hour).set(sid, makeBucket());
        addEntry(hourlyByDayByAgent.get(day).get(hour).get(sid), e);
      }
    }
  }

  // 排序输出
  const sortBuckets = (map, keyName) =>
    [...map.entries()]
      .map(([k, b]) => ({ [keyName]: k, ...publicBucket(b), hitRatio: bucketHitRatio(b) }))
      .sort((x, y) => y.totalTokens - x.totalTokens);

  const typeRows = [...byType.entries()]
    .map(([k, b]) => ({ type: k, label: sourceTypeLabel(k), ...publicBucket(b), hitRatio: bucketHitRatio(b) }))
    .sort((x, y) => y.totalTokens - x.totalTokens);

  const dailyRows = [...daily.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, b]) => ({ date, ...publicBucket(b), hitRatio: bucketHitRatio(b), byType: publicTypeBuckets(dailyByType.get(date)) }));

  // 单天 24 小时连续序列（缺失小时补 0），供趋势图直接使用
  const hourlySeries = {};
  for (const [day, hours] of hourlyByDay.entries()) {
    hourlySeries[day] = Array.from({ length: 24 }, (_, h) => {
      const hh = String(h).padStart(2, "0");
      const b = hours.get(hh);
      const byType = publicTypeBuckets(hourlyByDayByType.get(day)?.get(hh) || new Map());
      return b
        ? { hour: hh, ...publicBucket(b), hitRatio: bucketHitRatio(b), byType }
        : { hour: hh, ...publicBucket(makeBucket()), hitRatio: null, byType };
    });
  }

  const hourlyTypeSeries = {};
  for (const [day, hours] of hourlyByDayByType.entries()) {
    hourlyTypeSeries[day] = Array.from({ length: 24 }, (_, h) => publicTypeBuckets(hours.get(String(h).padStart(2, "0")) || new Map()));
  }

  const hourlyAgentSeries = {};
  for (const [day, hours] of hourlyByDayByAgent.entries()) {
    hourlyAgentSeries[day] = Array.from({ length: 24 }, (_, h) => publicTypeBuckets(hours.get(String(h).padStart(2, "0")) || new Map()));
  }

  return {
    matched,
    total: entries.length,
    summary: { ...publicBucket(summary), hitRatio: bucketHitRatio(summary) },
    byType: typeRows,
    byAgent: sortBuckets(byAgent, "agentId"),
    byModel: sortBuckets(byModel, "modelId"),
    byProvider: sortBuckets(byProvider, "provider"),
    daily: dailyRows,
    hourlyByDay: hourlySeries,
    hourlyByDayByType: hourlyTypeSeries,
    hourlyByDayByAgent: hourlyAgentSeries,
  };
}

/**
 * 计算指定 days 内（含端点）每天是否有记录 → 趋势连续性检查。
 * 用于验收「2026-07-22 以来趋势连续、无重复」。
 */
export function dailyCoverage(entries) {
  const days = new Map(); // day -> count
  const dup = new Map();  // requestId -> count
  for (const e of entries) {
    const d = entryDay(e);
    if (d) days.set(d, (days.get(d) || 0) + 1);
    if (e?.requestId) dup.set(e.requestId, (dup.get(e.requestId) || 0) + 1);
  }
  const sorted = [...days.keys()].sort();
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const p = new Date(prev + "T00:00:00Z");
    const c = new Date(cur + "T00:00:00Z");
    const diffDays = Math.round((c - p) / 86400000);
    if (diffDays > 1) gaps.push({ from: prev, to: cur, missingDays: diffDays - 1 });
  }
  const duplicates = [...dup.entries()].filter(([, n]) => n > 1).map(([rid, n]) => ({ requestId: rid, count: n }));
  return {
    firstDay: sorted[0] || null,
    lastDay: sorted[sorted.length - 1] || null,
    daysWithData: sorted.length,
    gaps,
    duplicateRequestIds: duplicates.length,
    duplicateSamples: duplicates.slice(0, 5),
  };
}

/**
 * 预聚合读取（0.6.0）：从 rollup 累加，输出契约与 aggregateEntries 对齐。
 * 筛选降级：from/to 始终生效；agent/model/provider/type 只取第一个非空（优先级 agent→model→provider→type）。
 *  - 按 agent 筛选：summary/daily 与 byType/byModel/byProvider 走 days.byAgent[agent] 交叉表（准确）。
 *  - 按 model/provider/type 筛选：summary/daily 走对应扁平维度；分布卡与小时图降级为所选时间范围全量（degraded 标记）。
 *  - 任何维度筛选下，小时图都不随维度变化（rollup 无「小时×维度」），degraded.hourly=true。
 */
const ROLLUP_DIM_MAP = { agent: "byAgent", model: "byModel", provider: "byProvider", type: "byType" };
const ROLLUP_BUCKET_FIELDS = ["calls", "input", "uncached", "output", "reasoning", "cacheRead", "totalTokens", "errors", "cost", "unpricedCalls"];

export function degradeRollupFilter(filters = {}) {
  let dim = "";
  let value = "";
  for (const d of ["agent", "model", "provider", "type"]) {
    if (filters[d]) { dim = d; value = filters[d]; break; }
  }
  return {
    from: filters.from || "",
    to: filters.to || "",
    dim,
    value,
    hiddenAgents: Array.isArray(filters.hiddenAgents) ? filters.hiddenAgents : [],
    hiddenModels: Array.isArray(filters.hiddenModels) ? filters.hiddenModels : [],
  };
}

function rollupBucket() { return { calls: 0, input: 0, uncached: 0, output: 0, reasoning: 0, cacheRead: 0, totalTokens: 0, errors: 0, cost: 0, unpricedCalls: 0 }; }
function addRollupBucket(target, b) { for (const f of ROLLUP_BUCKET_FIELDS) target[f] += b?.[f] || 0; }
function rollupHitRatio(b) { const denom = (b.cacheRead || 0) + (b.uncached || 0); return denom > 0 ? b.cacheRead / denom : null; }
function rollupPublic(b) { const out = {}; for (const f of ROLLUP_BUCKET_FIELDS) out[f] = b?.[f] || 0; return { ...out, hitRatio: rollupHitRatio(out) }; }
function mapPublic(map) { const out = {}; for (const [k, b] of Object.entries(map || {})) out[k] = rollupPublic(b); return out; }

/**
 * 按 hidden 过滤后的日视图：用 `byAgent[agent].byModel` 交叉表精确排除 hidden agent / hidden model。
 *  - total / byModel：排除 hidden agent 与 hidden model（精确）。
 *  - byAgent[agent]：排除 hidden model（带 byType/byModel/byProvider 子表）。
 *  - byType / byProvider：排除 hidden agent（精确）；**不含 hidden model 的排除**（rollup 无 type×model 交叉表）。
 *  - hours：无法按维度过滤（无 hour×agent/model），保持原样。
 *  - 计价字段 cost/unpricedCalls：随白名单累加。隐藏 agent 时精确排除；隐藏 **model** 时
 *    total/byModel 精确排除，但 **byType/byProvider 的 cost/unpricedCalls 不随 hidden model 排除**
 *    （无 type×model 交叉表，属已知限制；当前 UI 不展示该层金额）。
 * 无 hidden 时直接返回原 day。
 */
function buildHiddenView(d, hiddenAgentSet, hiddenModelSet) {
  if (!hiddenAgentSet.size && !hiddenModelSet.size) return d;
  const total = rollupBucket();
  const byAgent = {}, byModel = {}, byType = {}, byProvider = {};
  for (const [agent, ab] of Object.entries(d.byAgent || {})) {
    if (hiddenAgentSet.has(agent)) continue;
    const agentAcc = rollupBucket();
    const agentByModel = {};
    for (const [model, mb] of Object.entries(ab.byModel || {})) {
      if (hiddenModelSet.has(model)) continue;
      addRollupBucket(agentAcc, mb);
      if (!agentByModel[model]) agentByModel[model] = rollupBucket();
      addRollupBucket(agentByModel[model], mb);
      if (!byModel[model]) byModel[model] = rollupBucket();
      addRollupBucket(byModel[model], mb);
      addRollupBucket(total, mb);
    }
    byAgent[agent] = { ...agentAcc, byType: {}, byModel: agentByModel, byProvider: {} };
    for (const [type, tb] of Object.entries(ab.byType || {})) {
      if (!byAgent[agent].byType[type]) byAgent[agent].byType[type] = rollupBucket();
      addRollupBucket(byAgent[agent].byType[type], tb);
      if (!byType[type]) byType[type] = rollupBucket();
      addRollupBucket(byType[type], tb);
    }
    for (const [prov, pb] of Object.entries(ab.byProvider || {})) {
      if (!byAgent[agent].byProvider[prov]) byAgent[agent].byProvider[prov] = rollupBucket();
      addRollupBucket(byAgent[agent].byProvider[prov], pb);
      if (!byProvider[prov]) byProvider[prov] = rollupBucket();
      addRollupBucket(byProvider[prov], pb);
    }
  }
  return { total, byType, byAgent, byModel, byProvider, hours: d.hours };
}

export function aggregateRollup(rollup, filters = {}) {
  const { from, to, dim, value, hiddenAgents, hiddenModels } = degradeRollupFilter(filters);
  const hiddenAgentSet = new Set(hiddenAgents);
  const hiddenModelSet = new Set(hiddenModels);
  const dimMap = dim ? ROLLUP_DIM_MAP[dim] : "";
  const agentDim = dim === "agent";
  const days = Object.keys(rollup.days || {}).filter((d) => (!from || d >= from) && (!to || d <= to)).sort();

  const summary = rollupBucket();
  const byType = new Map(), byAgent = new Map(), byModel = new Map(), byProvider = new Map();
  const daily = [];
  const hourlyByDay = {};
  const hourlyByDayByAgent = {};

  for (const day of days) {
    const d = buildHiddenView(rollup.days[day], hiddenAgentSet, hiddenModelSet);
    let dayBucket;
    if (agentDim) dayBucket = d.byAgent?.[value] || rollupBucket();
    else if (dimMap) dayBucket = d[dimMap]?.[value] || rollupBucket();
    else dayBucket = d.total;
    if (!dayBucket.calls) continue; // 无匹配条目的天不出现在 daily/hourly（与明细聚合一致）
    addRollupBucket(summary, dayBucket);

    let dailyByType;
    if (agentDim) {
      const ab = d.byAgent?.[value] || {};
      for (const [k, b] of Object.entries(ab.byType || {})) { if (!byType.has(k)) byType.set(k, rollupBucket()); addRollupBucket(byType.get(k), b); }
      for (const [k, b] of Object.entries(ab.byModel || {})) { if (!byModel.has(k)) byModel.set(k, rollupBucket()); addRollupBucket(byModel.get(k), b); }
      for (const [k, b] of Object.entries(ab.byProvider || {})) { if (!byProvider.has(k)) byProvider.set(k, rollupBucket()); addRollupBucket(byProvider.get(k), b); }
      if (!byAgent.has(value)) byAgent.set(value, rollupBucket());
      addRollupBucket(byAgent.get(value), ab);
      dailyByType = mapPublic(ab.byType);
    } else {
      for (const [k, b] of Object.entries(d.byType || {})) { if (!byType.has(k)) byType.set(k, rollupBucket()); addRollupBucket(byType.get(k), b); }
      for (const [k, b] of Object.entries(d.byAgent || {})) { if (!byAgent.has(k)) byAgent.set(k, rollupBucket()); addRollupBucket(byAgent.get(k), b); }
      for (const [k, b] of Object.entries(d.byModel || {})) { if (!byModel.has(k)) byModel.set(k, rollupBucket()); addRollupBucket(byModel.get(k), b); }
      for (const [k, b] of Object.entries(d.byProvider || {})) { if (!byProvider.has(k)) byProvider.set(k, rollupBucket()); addRollupBucket(byProvider.get(k), b); }
      dailyByType = mapPublic(d.byType);
    }
    daily.push({ date: day, ...rollupPublic(dayBucket), byType: dailyByType });

    hourlyByDay[day] = Array.from({ length: 24 }, (_, h) => {
      const hh = String(h).padStart(2, "0");
      const hb = d.hours?.[hh];
      return { hour: hh, ...rollupPublic(hb), byType: mapPublic(hb?.byType) };
    });
  }

  for (const [key, rs] of Object.entries(rollup.recentSessions || {})) {
    const skey = rs.sessionId || key;
    for (const [day, dd] of Object.entries(rs.days || {})) {
      if ((from && day < from) || (to && day > to)) continue;
      if (!hourlyByDayByAgent[day]) hourlyByDayByAgent[day] = Array.from({ length: 24 }, () => ({}));
      for (const [hh, b] of Object.entries(dd.hours || {})) {
        const idx = Number(hh);
        if (idx < 0 || idx > 23) continue;
        hourlyByDayByAgent[day][idx][skey] = rollupPublic(b);
      }
    }
  }

  const sortRows = (map, keyName) => [...map.entries()].map(([k, b]) => ({ [keyName]: k, ...rollupPublic(b) })).sort((a, z) => z.totalTokens - a.totalTokens);
  return {
    matched: summary.calls,
    total: summary.calls,
    summary: rollupPublic(summary),
    byType: [...byType.entries()].map(([k, b]) => ({ type: k, label: sourceTypeLabel(k), ...rollupPublic(b) })).sort((a, z) => z.totalTokens - a.totalTokens),
    byAgent: sortRows(byAgent, "agentId"),
    byModel: sortRows(byModel, "modelId"),
    byProvider: sortRows(byProvider, "provider"),
    daily,
    hourlyByDay,
    hourlyByDayByType: {},
    hourlyByDayByAgent,
    degraded: { breakdowns: Boolean(dim) && !agentDim, hourly: Boolean(dim) },
  };
}
