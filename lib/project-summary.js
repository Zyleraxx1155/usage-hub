// lib/project-summary.js — 项目级会话用量事件的安全汇总层
// 只返回派生统计，不返回会话原文、账本条目、凭据或内部路径。
import { readSessionDetail } from "./session-reader.js?v=0.8.0";
import { entryCost } from "./pricing.js?v=0.8.0";

export const PROJECT_SUMMARY_EVENT = "usage-hub:project-summary";

function emptySummary() {
  return { calls: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, estimatedCost: null, unpricedCalls: 0 };
}
function baseResponse({ ok = true, requestedSessions = 0, matchedSessions = 0, unmatchedSessions = 0, summary = emptySummary(), builtAt = null, partial = false, warnings = [] } = {}) {
  return { ok, source: "usage-hub", matchedSessions, requestedSessions, unmatchedSessions, summary, builtAt, partial: Boolean(partial), warnings: [...new Set(warnings.filter(Boolean).map(String))] };
}
function validDate(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value); }
function dayOf(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(d);
}

export function normalizeProjectSummaryRequest(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("payload must be an object");
  if (!Array.isArray(payload.sessionIds)) throw new Error("sessionIds must be an array");
  if (payload.sessionIds.length > 1000) throw new Error("sessionIds exceeds limit");
  const ids = [];
  for (const raw of payload.sessionIds) {
    if (typeof raw !== "string" || !raw.trim() || raw.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(raw)) throw new Error("sessionIds contains invalid id");
    if (!ids.includes(raw)) ids.push(raw);
  }
  if (payload.from !== undefined && !validDate(payload.from)) throw new Error("from must be YYYY-MM-DD");
  if (payload.to !== undefined && !validDate(payload.to)) throw new Error("to must be YYYY-MM-DD");
  if (payload.from && payload.to && payload.from > payload.to) throw new Error("from must not be after to");
  return { sessionIds: ids, from: payload.from || "", to: payload.to || "" };
}

function inRange(timestamp, from, to) {
  const day = dayOf(timestamp);
  return !!day && (!from || day >= from) && (!to || day <= to);
}
export function buildProjectSummary({ payload, sessionsDirs = [], ready = true, builtAt = null, readDetail = readSessionDetail } = {}) {
  let request;
  try { request = normalizeProjectSummaryRequest(payload); }
  catch (err) { return baseResponse({ ok: false, builtAt, warnings: [`invalid_request: ${err.message}`] }); }
  if (!ready) return baseResponse({ ok: false, requestedSessions: request.sessionIds.length, builtAt, warnings: ["usage_hub_not_ready"] });
  const summary = emptySummary();
  const warnings = [];
  let matchedSessions = 0;
  let unmatchedSessions = 0;
  let partial = false;
  for (const sessionId of request.sessionIds) {
    const readWarnings = [];
    let detail = null;
    try { detail = readDetail({ sessionsDirs, sessionId, full: true, limitTurns: 2000, warn: (message) => readWarnings.push(String(message)) }); } catch { detail = null; }
    if (readWarnings.length) { partial = true; warnings.push(...readWarnings.map((message) => `session_read_warning:${message}`)); }
    if (!detail || detail.error) {
      unmatchedSessions += 1;
      warnings.push(detail?.error === "ambiguous_session_id" ? `session_ambiguous:${sessionId}` : `session_unmatched:${sessionId}`);
      continue;
    }
    if (detail.parseWarnings?.eventLimit) { partial = true; warnings.push(`session_partial_event_limit:${sessionId}`); }
    if (detail.parseWarnings?.malformedLines) { partial = true; warnings.push(`session_malformed_lines:${sessionId}:${detail.parseWarnings.malformedLines}`); }
    matchedSessions += 1;
    for (const turn of detail.turns || []) {
      if ((request.from || request.to) && !inRange(turn.timestamp, request.from, request.to)) continue;
      const input = Number(turn.inputTokens) || 0;
      const output = Number(turn.outputTokens) || 0;
      const cacheRead = Number(turn.cacheReadTokens) || 0;
      const reasoning = Number(turn.reasoningTokens) || 0;
      const total = Number(turn.totalTokens);
      summary.calls += 1;
      summary.inputTokens += input;
      summary.outputTokens += output;
      summary.cacheReadTokens += cacheRead;
      summary.reasoningTokens += reasoning;
      summary.totalTokens += Number.isFinite(total) ? total : input + output + cacheRead;
      const cost = entryCost({
        startedAt: turn.timestamp,
        model: { provider: turn.provider || "", modelId: turn.model || "" },
        usage: { input: { totalTokens: input, uncachedTokens: input }, output: { totalTokens: output, reasoningTokens: reasoning }, cache: { readTokens: cacheRead }, totalTokens: Number.isFinite(total) ? total : input + output + cacheRead },
      });
      if (cost.priced) summary.estimatedCost = (summary.estimatedCost || 0) + cost.cost;
      else summary.unpricedCalls += 1;
    }
  }
  if (unmatchedSessions) warnings.unshift(`${unmatchedSessions} associated session(s) could not be matched or parsed`);
  if (summary.unpricedCalls) warnings.push(`${summary.unpricedCalls} call(s) have no applicable price`);
  if (summary.calls && summary.estimatedCost == null) warnings.push("estimated cost unavailable for matched calls");
  return baseResponse({ requestedSessions: request.sessionIds.length, matchedSessions, unmatchedSessions, summary, builtAt, partial, warnings });
}

export { emptySummary };
