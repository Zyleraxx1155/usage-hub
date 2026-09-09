// lib/speed-stats.js — 生成速度聚合（加权，对齐 token-tracker buildSpeedStats）
//
// 加权口径：tps = Σoutput / (ΣdurMs/1000)；textTps = Σ(output - reasoning) / (ΣdurMs/1000)。
// 注意：这里是加权平均，不是各条 tps 的算术平均。
// 过滤沿用 usage-hub 现有筛选：from/to（Asia/Shanghai 日界）、agent、model、provider + 隐藏列表。

function sumOf(records) {
  let out = 0, dur = 0, text = 0;
  for (const r of records) {
    out += r.out || 0;
    dur += r.durMs || 0;
    text += Math.max(0, (r.out || 0) - (r.reasoning || 0));
  }
  return { out, dur, text, tps: dur > 0 ? out / (dur / 1000) : null, textTps: dur > 0 ? text / (dur / 1000) : null };
}

function roundOrNull(v) {
  return v == null ? null : Math.round(v);
}

/**
 * @param {Array} records speed 记录（JSONL + ledger 合并池）
 * @param {object} [filters] { from, to, agent, model, provider, type, sessionId, hiddenAgents, hiddenModels }
 * @returns {{tps, textTps, count, last, byModel, byProvider, byAgent}}
 */
export function buildSpeedStats(records, filters = {}) {
  const { from = "", to = "", agent = "", model = "", provider = "", type = "", sessionId = "", hiddenAgents = [], hiddenModels = [] } = filters || {};
  const hiddenAgentSet = new Set(Array.isArray(hiddenAgents) ? hiddenAgents : []);
  const hiddenModelSet = new Set(Array.isArray(hiddenModels) ? hiddenModels : []);

  const selected = [];
  for (const r of records || []) {
    if (!r || !(r.durMs > 0)) continue;
    if (from && (!r.day || r.day < from)) continue;
    if (to && (!r.day || r.day > to)) continue;
    const recAgent = r.agent || "unknown";
    const recModel = r.model || "unknown";
    if (hiddenAgentSet.has(recAgent) || hiddenModelSet.has(recModel)) continue;
    if (agent && recAgent !== agent) continue;
    if (model && recModel !== model) continue;
    if (provider && (r.provider || "") !== provider) continue;
    if (type && (r.type || "") !== type) continue;
    if (sessionId && (r.sessionId || "") !== sessionId) continue;
    selected.push(r);
  }

  if (!selected.length) {
    return { tps: null, textTps: null, count: 0, last: null, byModel: [], byProvider: [], byAgent: [] };
  }

  selected.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const total = sumOf(selected);

  const group = (keyOf, field) => {
    const map = new Map();
    for (const r of selected) {
      const key = keyOf(r);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    }
    return [...map.entries()]
      .map(([key, arr]) => {
        const s = sumOf(arr);
        return { [field]: key, n: arr.length, tps: roundOrNull(s.tps), textTps: roundOrNull(s.textTps) };
      })
      .sort((x, y) => y.n - x.n);
  };

  const last = selected[0];
  return {
    tps: roundOrNull(total.tps),
    textTps: roundOrNull(total.textTps),
    count: selected.length,
    last: last
      ? { ts: last.ts, model: last.model, provider: last.provider, tps: last.tps, textTps: last.textTps, out: last.out, durMs: last.durMs, source: last.source }
      : null,
    byModel: group((r) => r.model || "unknown", "model"),
    byProvider: group((r) => r.provider || "", "provider"),
    byAgent: group((r) => r.agent || "unknown", "agentId"),
  };
}
