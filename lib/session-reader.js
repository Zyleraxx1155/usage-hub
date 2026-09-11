// lib/session-reader.js — 只读会话 JSONL 读取层
// 安全边界：拒绝目录、JSONL、标题侧车的符号链接；单文件/事件数有硬上限。
// 口径说明：真实 ~/.hanako 样本的 assistant usage 位于 message.usage，input、output、cacheRead
// 是数值字段，未发现 uncachedTokens/hitRatio/contextWindow。故无原生 hitRatio 时，详情命中率
// 仅表示 JSONL 局部口径（cacheRead / (input + cacheRead)），不等同 usage-ledger 总览；若 JSONL
// 提供原生 hitRatio，则优先使用该值。message.content[].arguments.context 是工具参数，不是窗口。
import fs from "node:fs";
import path from "node:path";

export const MAX_SESSION_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_SESSION_EVENTS = 10_000;
const DEFAULT_LIST_LIMIT = 120;
const DEFAULT_TURN_LIMIT = 500;
const MAX_LIST_LIMIT = 1_000;
const MAX_TURN_LIMIT = 2_000;

function boundedLimit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(n)));
}
function textOf(value) { return typeof value === "string" ? value : Array.isArray(value) ? value.filter((x) => x?.type === "text" && typeof x.text === "string").map((x) => x.text).join(" ") : ""; }
function firstUserTitle(events) { for (const e of events) { if (e?.type !== "message" || e.message?.role !== "user") continue; const v = textOf(e.message.content).trim(); if (!v || /^\[(hana_|sessionfile|image|attachment|file|audio|video|media)/i.test(v) || /^<file name=/i.test(v)) continue; return v.replace(/\s+/g, " ").slice(0, 80); } return ""; }
function numberOrNull(...values) { for (const value of values) { const n = Number(value); if (Number.isFinite(n)) return n; } return null; }

export function usageOf(message) {
  const u = message?.usage;
  if (!u || typeof u !== "object") return null;
  const input = numberOrNull(u.input?.totalTokens, u.inputTokens, u.promptTokens, u.input);
  const output = numberOrNull(u.output?.totalTokens, u.outputTokens, u.completionTokens, u.output);
  const cacheRead = numberOrNull(u.cache?.readTokens, u.cacheRead, u.cacheReadTokens, u.promptCacheHitTokens) ?? 0;
  const cacheWrite = numberOrNull(u.cache?.writeTokens, u.cacheWrite, u.cacheWriteTokens) ?? 0;
  const reasoning = numberOrNull(u.reasoning, u.reasoningTokens) ?? 0;
  const total = numberOrNull(u.totalTokens, u.total, u.total_tokens);
  const contextWindow = numberOrNull(u.contextWindow, u.context?.window, message.contextWindow);
  const contextTokens = numberOrNull(u.contextTokens, u.context?.tokens, u.context?.used, message.contextTokens);
  const nativeHitRatio = numberOrNull(u.hitRatio, u.cache?.hitRatio);
  if (input == null && output == null && total == null && contextTokens == null) return null;
  return { input: input ?? 0, output: output ?? 0, cacheRead, cacheWrite, reasoning, total, contextWindow, contextTokens, nativeHitRatio };
}

function parseContent(content, limitTurns = DEFAULT_TURN_LIMIT) {
  const events = [], invalidLines = [];
  for (const line of String(content || "").split("\n")) {
    if (!line.trim()) continue;
    if (events.length >= MAX_SESSION_EVENTS) { invalidLines.push("event-limit"); break; }
    try { events.push(JSON.parse(line)); } catch { invalidLines.push("malformed"); }
  }
  const session = events.find((e) => e?.type === "session") || {};
  let model = null, provider = null; const turns = [];
  for (const event of events) {
    if (event?.type === "model_change") { model = event.modelId || model; provider = event.provider || provider; }
    if (event?.type !== "message" || event.message?.role !== "assistant") continue;
    const usage = usageOf(event.message); if (!usage) continue;
    const hitRatio = usage.nativeHitRatio ?? (usage.input + usage.cacheRead > 0 ? usage.cacheRead / (usage.input + usage.cacheRead) : null);
    turns.push({ index: turns.length + 1, timestamp: event.timestamp || null, model: event.message.model || event.modelId || model || null, provider: event.message.provider || event.provider || provider || null, inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite, reasoningTokens: usage.reasoning, totalTokens: usage.total ?? usage.input + usage.output + usage.cacheRead + usage.reasoning, hitRatio, hitRatioSource: usage.nativeHitRatio == null ? "jsonl-local" : "jsonl-native", contextWindow: usage.contextWindow, contextTokens: usage.contextTokens });
  }
  const last = turns.at(-1) || null;
  const inputTokens = turns.reduce((s, t) => s + t.inputTokens, 0), outputTokens = turns.reduce((s, t) => s + t.outputTokens, 0), cacheReadTokens = turns.reduce((s, t) => s + t.cacheReadTokens, 0), totalTokens = turns.reduce((s, t) => s + t.totalTokens, 0);
  const denominator = inputTokens + cacheReadTokens;
  const derived = turns.some((t) => t.hitRatioSource === "jsonl-local");
  const native = turns.length > 0 && turns.every((t) => t.hitRatioSource === "jsonl-native");
  const startTime = session.timestamp || events.find((e) => e?.timestamp)?.timestamp || null;
  const endTime = [...events].reverse().find((e) => e?.timestamp)?.timestamp || last?.timestamp || null;
  const contextWindow = last?.contextWindow ?? numberOrNull(session.contextWindow, session.context?.window);
  const contextTokens = last?.contextTokens ?? (last ? last.inputTokens + last.cacheReadTokens : null);
  return { sessionId: session.id || null, agent: session.agentId || session.agent || null, title: firstUserTitle(events), startTime, endTime, model: model || last?.model || null, provider: provider || last?.provider || null, turns: turns.slice(-boundedLimit(limitTurns, DEFAULT_TURN_LIMIT, MAX_TURN_LIMIT)), turnCount: turns.length, inputTokens, outputTokens, cacheReadTokens, totalTokens, hitRatio: native ? (turns.at(-1)?.hitRatio ?? null) : (denominator ? cacheReadTokens / denominator : null), hitRatioSource: native ? "jsonl-native" : (derived ? "jsonl-local" : null), contextWindow, contextTokens, contextPercent: contextTokens == null || contextWindow == null || contextWindow <= 0 ? null : (contextTokens / contextWindow) * 100, parseWarnings: invalidLines.length ? { malformedLines: invalidLines.filter((x) => x === "malformed").length, eventLimit: invalidLines.includes("event-limit") } : null };
}

function safeRead(fullPath, limitTurns, warn) {
  try {
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) { warn?.(`拒绝符号链接: ${path.basename(fullPath)}`); return null; }
    if (!stat.isFile() || stat.size <= 0) return null;
    if (stat.size > MAX_SESSION_FILE_BYTES) { warn?.(`跳过超限 JSONL: ${path.basename(fullPath)} (${stat.size} bytes)`); return null; }
    const parsed = parseContent(fs.readFileSync(fullPath, "utf8"), limitTurns);
    if (!parsed.turnCount && !parsed.sessionId && !parsed.title) return null;
    return { ...parsed, file: path.basename(fullPath), size: stat.size, mtime: stat.mtimeMs };
  } catch { return null; }
}
function titleMap(dir, warn) { try { const p = path.join(dir, "session-titles.json"), stat = fs.lstatSync(p); if (stat.isSymbolicLink()) { warn?.("拒绝符号链接: session-titles.json"); return {}; } const value = JSON.parse(fs.readFileSync(p, "utf8")); return value && typeof value === "object" ? value : {}; } catch { return {}; } }
function resolveTitle(item, titles) { return String(titles[item.sessionId] || titles[item.file] || item.title || "未命名会话").trim(); }
function validDir(dir) { try { const stat = fs.lstatSync(dir); return stat.isDirectory() && !stat.isSymbolicLink(); } catch { return false; } }
function dirWarning(dir) { try { return fs.lstatSync(dir).isSymbolicLink() ? "symlink_sessions_directory" : "invalid_sessions_directory"; } catch { return "invalid_sessions_directory"; } }
function agentOf(item, dir) { return item.agent || path.basename(path.dirname(dir)) || null; }
export function sessionTitleMap({ sessionsDir, sessionsDirs: inputSessionsDirs } = {}) {
  const out = {};
  for (const dir of sessionDirs({ sessionsDir, sessionsDirs: inputSessionsDirs })) {
    if (!validDir(dir)) continue;
    try {
      // 侧车文件键是混合形态：历史条目用绝对路径，较新条目用 sessionId。
      // 合并时为每个键补一份 basename 键，保证按 sessionFile（basename）/ sessionId 都能命中。
      for (const [k, v] of Object.entries(titleMap(dir, () => {}))) {
        out[k] = v;
        const b = String(k).replaceAll("\\", "/").split("/").pop();
        if (b && b !== k) out[b] = v;
      }
    } catch {}
  }
  return out;
}
export function sessionDirs({ sessionsDir, sessionsDirs } = {}) { const list = Array.isArray(sessionsDirs) ? sessionsDirs : [sessionsDir]; return [...new Set(list.filter((v) => typeof v === "string" && v.trim()))]; }

/**
 * 各 agent 的 sessions 目录（仅 `agents/<x>/sessions`，不含 subagent-sessions/activity/workflow-sessions）。
 * 用于当前会话查找：焦点会话可能属于非默认 agent。拒绝符号链接。
 */
export function allAgentSessionDirs(agentsRoot) {
  const dirs = [];
  let entries;
  try { entries = fs.readdirSync(agentsRoot, { withFileTypes: true }); } catch { return dirs; }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
    const dir = path.join(agentsRoot, ent.name, "sessions");
    try {
      const stat = fs.lstatSync(dir);
      if (stat.isDirectory() && !stat.isSymbolicLink()) dirs.push(dir);
    } catch {}
  }
  return dirs;
}

/**
 * 最近活跃会话：sessionsDir 顶层 .jsonl 中 mtime 最新、且在 maxAgeMs 内被写入过的文件。
 * 只扫顶层（不含 subagent-sessions/activity/workflow-sessions 等子目录），
 * 用于「宿主不提供焦点」时的兜底推断；陈旧会话（超窗）不返回。
 */
export function latestActiveSession({ sessionsDir, maxAgeMs = 30 * 60 * 1000, now = Date.now() } = {}) {
  if (typeof sessionsDir !== "string" || !sessionsDir.trim()) return null;
  let names;
  try { names = fs.readdirSync(sessionsDir).filter((name) => name.endsWith(".jsonl") && !name.includes(".repair.jsonl")); } catch { return null; }
  let best = null;
  for (const name of names) {
    const full = path.join(sessionsDir, name);
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    if (now - stat.mtimeMs > maxAgeMs) continue;
    if (!best || stat.mtimeMs > best.mtimeMs) best = { file: name, mtimeMs: stat.mtimeMs };
  }
  return best ? { file: best.file, mtimeMs: best.mtimeMs } : null;
}

export function listSessions({ sessionsDir, sessionsDirs, agent, limit = DEFAULT_LIST_LIMIT, warn } = {}) {
  const result = [], cappedLimit = boundedLimit(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  for (const dir of sessionDirs({ sessionsDir, sessionsDirs })) {
    if (!validDir(dir)) { if (dir) warn?.(dirWarning(dir)); continue; }
    let names = []; try { names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")); } catch { continue; }
    const titles = titleMap(dir, warn);
    for (const name of names) { const item = safeRead(path.join(dir, name), 0, warn); if (!item) continue; const itemAgent = agentOf(item, dir); if (agent && itemAgent !== agent) continue; result.push({ sessionId: item.sessionId || name.replace(/\.jsonl$/, ""), file: name, title: resolveTitle(item, titles), agent: itemAgent, model: item.model, startTime: item.startTime, endTime: item.endTime, turnCount: item.turnCount, totalTokens: item.totalTokens, parseWarnings: item.parseWarnings, _dir: dir }); }
  }
  result.sort((a, b) => String(b.endTime || b.startTime || "").localeCompare(String(a.endTime || a.startTime || "")));
  return result.slice(0, cappedLimit).map(({ _dir, ...item }) => item);
}

function matchingSessionFiles({ sessionsDir, sessionsDirs, agent, sessionId, file, warn } = {}) {
  const matches = [];
  for (const dir of sessionDirs({ sessionsDir, sessionsDirs })) {
    if (!validDir(dir)) continue;
    let names = []; try { names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")); } catch { continue; }
    for (const name of names) {
      if (file && name !== file) continue;
      const item = safeRead(path.join(dir, name), 0, warn); if (!item) continue;
      const id = item.sessionId || name.replace(/\.jsonl$/, "");
      if (sessionId && id !== sessionId && name !== sessionId && name !== `${sessionId}.jsonl`) continue;
      const itemAgent = agentOf(item, dir); if (agent && itemAgent !== agent) continue;
      matches.push({ dir, name, item, id, agent: itemAgent });
    }
  }
  return matches;
}
export function findSessionMatches(options = {}) { return matchingSessionFiles(options).map(({ agent, name, id }) => ({ agent, file: name, sessionId: id })); }
export function readSessionDetail({ sessionsDir, sessionsDirs, agent, sessionId, file, limitTurns = DEFAULT_TURN_LIMIT, warn } = {}) {
  const matches = matchingSessionFiles({ sessionsDir, sessionsDirs, agent, sessionId, file, warn });
  if (!matches.length) return null;
  if (matches.length > 1 && !agent && !file) return { error: "ambiguous_session_id", matches: matches.map(({ agent: itemAgent, name, id }) => ({ agent: itemAgent, file: name, sessionId: id })) };
  const { dir, name, id } = matches[0];
  const item = safeRead(path.join(dir, name), boundedLimit(limitTurns, DEFAULT_TURN_LIMIT, MAX_TURN_LIMIT), warn);
  if (!item) return null;
  return { ...item, sessionId: id, agent: agentOf(item, dir), title: resolveTitle(item, titleMap(dir, warn)) };
}
export function deriveSessionsDirInfo(ctx) {
  const configured = ctx?.config?.get?.("sessionsDir");
  if (configured) return { path: configured, source: "configured-sessions" };
  if (ctx?.sessionPath?.endsWith?.(".jsonl")) return { path: path.dirname(ctx.sessionPath), source: "current-session-path" };
  const root = process.env.HANA_HOME || path.join(process.env.HOME || "", ".hanako");
  return { path: path.join(root, "agents", "hanako", "sessions"), source: "default-agent-directory", warning: "default_agent_directory" };
}
export function deriveSessionsDir(ctx) { return deriveSessionsDirInfo(ctx).path; }

export function resolveEntryFile({ sessionsDir, sessionsDirs, entryId, maxBytes = 2 * 1024 * 1024, warn } = {}) {
  if (typeof entryId !== "string" || !/^[A-Za-z0-9_-]{4,128}$/.test(entryId)) return null;
  for (const dir of sessionDirs({ sessionsDir, sessionsDirs })) {
    if (!validDir(dir)) continue;
    let names = []; try { names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")); } catch { continue; }
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        const stat = fs.lstatSync(full);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const start = Math.max(0, stat.size - maxBytes);
        const fd = fs.openSync(full, "r");
        const buf = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd);
        for (const line of buf.toString("utf8").split("\n")) {
          try { const event = JSON.parse(line); if (event?.id === entryId || event?.message?.id === entryId) return { file: name, agent: path.basename(path.dirname(dir)) }; } catch {}
        }
      } catch { warn?.("resolve_entry_read_failed"); }
    }
  }
  return null;
}

function safeFocusFile(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const normalized = value.trim().replaceAll("\\\\", "/");
  const file = path.basename(normalized);
  return file === "." || file === ".." ? "" : file;
}

function normalizeFocusCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sessionId = typeof (value.sessionId || value.id) === "string" ? String(value.sessionId || value.id).trim() : "";
  const file = safeFocusFile(value.file || value.path || value.sessionPath);
  if (!sessionId && !file) return null;
  const agent = typeof (value.agent || value.agentId) === "string" ? String(value.agent || value.agentId).trim() : "";
  return { sessionId: sessionId || file.replace(/\.jsonl$/i, ""), agent, file };
}

// 只接受明确的焦点对象；不读取 ctx.sessionPath、ctx.sessionId 或全局最新记录冒充焦点。
export function resolveCurrentSession(ctx = {}, explicit = null) {
  const explicitFocus = normalizeFocusCandidate(explicit);
  if (explicitFocus) return explicitFocus;
  const candidates = [ctx.currentSession, ctx.focusedSession, ctx.hostContext?.currentSession, ctx.hostContext?.focusedSession, ctx.context?.currentSession];
  for (const candidate of candidates) {
    const focus = normalizeFocusCandidate(candidate);
    if (focus) return focus;
  }
  return null;
}
export { parseContent };
