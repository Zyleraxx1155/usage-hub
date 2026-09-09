// routes/api.js — usage-hub 数据接口（阶段 1：数据层与口径）
//
// 聚合口径见 lib/aggregate.js 模块头注释。所有统计接口共享同一筛选参数：
//   from / to（YYYY-MM-DD，含端点，Asia/Shanghai 日界）
//   agent / model / provider / type（type = 来源类型 key，见 lib/types.js）

// 内部模块 import 必须带 ?v=<manifest.version>，否则 Hana 只对入口文件做 cache-bust，
// 内部相对 import 会命中 Node ESM 缓存，插件更新后仍加载旧版 lib 导致路由模块加载失败。
import { aggregateRollup } from "../lib/aggregate.js?v=0.6.0";
import { SOURCE_TYPES, TYPE_OTHER } from "../lib/types.js?v=0.6.0";
import { deriveSessionsDirInfo, listSessions, readSessionDetail, resolveCurrentSession, resolveEntryFile, sessionTitleMap, allAgentSessionDirs, latestActiveSession } from "../lib/session-reader.js?v=0.6.0";
import { publicSettings, validateAndSave } from "../lib/settings.js?v=0.6.0";
import { computeForecast } from "../lib/forecast.js?v=0.6.0";
import { buildSpeedStats } from "../lib/speed-stats.js?v=0.6.0";
import { hanaHome } from "../lib/paths.js?v=0.6.0";
import fs from "node:fs";
import path from "node:path";

function filtersOf(c, ctx) {
  let display = {};
  try { display = publicSettings(hub(ctx)?.paths?.dataDir || "").display || {}; } catch {}
  return {
    from: c.req.query("from") || "",
    to: c.req.query("to") || "",
    agent: c.req.query("agent") || "",
    model: c.req.query("model") || "",
    provider: c.req.query("provider") || "",
    type: c.req.query("type") || "",
    hiddenAgents: display.hiddenAgents || [],
    hiddenModels: display.hiddenModels || [],
  };
}

function hub(ctx) {
  return ctx._usageHub || null;
}

// 当前会话查找目录：配置/默认 sessionsDir 优先，再并入各 agent 的 sessions 目录（焦点会话可能属于非默认 agent）
// 注意：session-reader 的 sessionDirs() 在给定 sessionsDirs 数组时只用它，因此主目录必须放在数组首位。
function sessionSearchDirs(h, ctx) {
  const derived = h?.paths?.sessionsDir ? null : deriveSessionsDirInfo({ config: ctx?.config });
  const sessionsDir = h?.paths?.sessionsDir || derived?.path || "";
  let extras = [];
  try { extras = allAgentSessionDirs(path.join(hanaHome(), "agents")); } catch {}
  const list = [sessionsDir, ...extras].filter((dir) => dir && dir.trim());
  return { sessionsDir, sessionsDirs: [...new Set(list)] };
}

// 路径兜底（不是“焦点冒充”）：只接受 .jsonl 且位于允许根目录（各 sessions 目录）内的路径。
// 与 resolveCurrentSession 拒绝 ctx.sessionPath 冒充焦点的语义不同：这里不把 sessionPath
// 当作宿主声明的焦点，只当作“读一个已授权的会话文件”的安全路径，越界一律忽略。
function safeSessionPath(sessionPath, allowedDirs) {
  if (typeof sessionPath !== "string" || !sessionPath.trim()) return null;
  const full = path.resolve(sessionPath.trim());
  if (!full.endsWith(".jsonl")) return null;
  const roots = (allowedDirs || []).filter(Boolean).map((dir) => path.resolve(dir));
  if (!roots.some((root) => full.startsWith(root + path.sep))) return null;
  const base = path.basename(full);
  if (!base || base === "." || base === "..") return null;
  const parent = path.basename(path.dirname(full));
  const agent = parent === "sessions" ? path.basename(path.dirname(path.dirname(full))) : "";
  return agent ? { file: base, agent } : { file: base };
}

function requireData(ctx, c) {
  const h = hub(ctx);
  if (!h || !h.ready || !h.data) {
    return { error: "data not ready", detail: h?.lastRefreshError || null };
  }
  return h.data;
}

// 同一筛选条件在短时间内复用聚合结果：首屏多个请求只算一次
const aggregateCache = new Map();
function aggregateCached(data, filters) {
  const key = JSON.stringify(filters);
  const stamp = data.builtAt || 0;
  const hit = aggregateCache.get(key);
  if (hit && hit.stamp === stamp && Date.now() - hit.at < 30000) return hit.value;
  const value = aggregateRollup(data.rollup, filters);
  if (aggregateCache.size > 40) aggregateCache.clear();
  aggregateCache.set(key, { stamp, at: Date.now(), value });
  return value;
}

// 生成速度聚合按筛选条件缓存：速度记录池只在后台扫描后变化（updatedAt 作戳）
let speedCache = { key: "", stamp: "", value: null };
function speedCached(h, filters) {
  const stamp = h?.speeds?.updatedAt || "";
  const key = JSON.stringify(filters);
  if (speedCache.key === key && speedCache.stamp === stamp && speedCache.value) return speedCache.value;
  const value = buildSpeedStats(h?.speeds?.records || [], filters);
  speedCache = { key, stamp, value };
  return value;
}

export default function registerApiRoutes(app, ctx) {
  const registerGet = (path, handler) => { app.get(`/api/${path}`, handler); app.get(`/${path}`, handler); };
  const registerPost = (path, handler) => { app.post(`/api/${path}`, handler); app.post(`/${path}`, handler); };
  // ── 状态与元信息 ──
  registerGet("status", (c) => {
    const h = hub(ctx);
    if (!h) return c.json({ error: "plugin state missing" }, 503);
    const d = h.data;
    return c.json({
      plugin: "usage-hub",
      ready: h.ready,
      lastRefreshAt: h.lastRefreshAt,
      lastSpeedScanAt: h.speeds?.updatedAt || null,
      lastRefreshError: h.lastRefreshError,
      migration: h.migration,
      ledger: d ? { count: d.ledgerCount } : null,
      rollup: d ? { days: d.days, recentSessions: d.recentSessions } : null,
      lastMerge: d ? d.lastMerge : null,
      agentNames: h.agentNames || {},
      typeMap: SOURCE_TYPES,
      otherType: TYPE_OTHER,
    });
  });

  // ── 消耗预测（全量口径，不受筛选影响，保证月底预估稳定） ──
  registerGet("forecast", (c) => {
    const data = requireData(ctx, c);
    if (data.error) return c.json(data, 503);
    const r = aggregateCached(data, filtersOf(c, ctx));
    return c.json({ builtAt: data.builtAt, forecast: computeForecast(r) });
  });

  // ── 汇总 ──
  registerGet("summary", (c) => {
    const data = requireData(ctx, c);
    if (data.error) return c.json(data, 503);
    const r = aggregateCached(data, filtersOf(c, ctx));
    return c.json({
      builtAt: data.builtAt,
      matched: r.matched,
      total: r.total,
      summary: r.summary,
      byType: r.byType,
      degraded: r.degraded,
    });
  });

  // ── 日趋势 ──
  registerGet("daily", (c) => {
    const data = requireData(ctx, c);
    if (data.error) return c.json(data, 503);
    const r = aggregateCached(data, filtersOf(c, ctx));
    return c.json({ builtAt: data.builtAt, matched: r.matched, daily: r.daily });
  });

  // ── 小时趋势（单天 24 小时连续序列）──
  registerGet("hourly", (c) => {
    const data = requireData(ctx, c);
    if (data.error) return c.json(data, 503);
    const day = c.req.query("day") || "";
    const r = aggregateCached(data, filtersOf(c, ctx));
    const series = day ? r.hourlyByDay[day] || [] : r.hourlyByDay;
    const byType = day ? r.hourlyByDayByType?.[day] || [] : r.hourlyByDayByType;
    const bySession = day ? r.hourlyByDayByAgent?.[day] || [] : r.hourlyByDayByAgent;
    return c.json({ builtAt: data.builtAt, day, hourly: series, hourlyByType: byType, hourlyBySession: bySession });
  });

  // ── 多维聚合 ──
  registerGet("by-agent", (c) => {
    const data = requireData(ctx, c);
    if (data.error) return c.json(data, 503);
    const r = aggregateCached(data, filtersOf(c, ctx));
    return c.json({ builtAt: data.builtAt, matched: r.matched, rows: r.byAgent });
  });

  registerGet("by-model", (c) => {
    const data = requireData(ctx, c);
    if (data.error) return c.json(data, 503);
    const r = aggregateCached(data, filtersOf(c, ctx));
    return c.json({ builtAt: data.builtAt, matched: r.matched, rows: r.byModel });
  });

  registerGet("by-provider", (c) => {
    const data = requireData(ctx, c);
    if (data.error) return c.json(data, 503);
    const r = aggregateCached(data, filtersOf(c, ctx));
    return c.json({ builtAt: data.builtAt, matched: r.matched, rows: r.byProvider });
  });

  registerGet("by-type", (c) => {
    const data = requireData(ctx, c);
    if (data.error) return c.json(data, 503);
    const r = aggregateCached(data, filtersOf(c, ctx));
    return c.json({ builtAt: data.builtAt, matched: r.matched, rows: r.byType });
  });

  // ── 生成速度（加权，双口径：JSONL 相邻消息差 + ledger memory/utility） ──
  registerGet("speed", (c) => {
    const h = hub(ctx);
    if (!h) return c.json({ error: "plugin state missing" }, 503);
    const filters = { ...filtersOf(c, ctx), sessionId: c.req.query("sessionId") || "" };
    const speed = speedCached(h, filters);
    return c.json({ builtAt: h.speeds?.updatedAt || null, scanning: Boolean(h.speeds?.scanning), speed });
  });

  // ── 趋势连续性诊断（验收用）──
  registerGet("coverage", (c) => {
    const data = requireData(ctx, c);
    if (data.error) return c.json(data, 503);
    return c.json({ builtAt: data.builtAt, coverage: rollupCoverage(data.rollup) });
  });

  // ── 会话详情：只读 JSONL，按 agent/sessionId 或文件名定位 ──
  registerGet("sessions", (c) => {
    const h = hub(ctx);
    const derived = h?.paths?.sessionsDir ? null : deriveSessionsDirInfo(ctx);
    const sessionsDir = h?.paths?.sessionsDir || derived.path;
    const warnings = [h?.paths?.sessionsDirWarning || derived?.warning].filter(Boolean);
    const display = publicSettings(h?.paths?.dataDir || "").display || {};
    const hiddenAgents = new Set(display.hiddenAgents || []), hiddenModels = new Set(display.hiddenModels || []);
    const sessions = listSessions({ sessionsDir, agent: c.req.query("agent"), limit: c.req.query("limit") || 120, warn: (message) => warnings.push(message) })
      .filter((item) => !hiddenAgents.has(item.agent || "unknown") && !hiddenModels.has(item.model || "unknown"));
    return c.json({ source: h?.paths?.sessionsDirSource || derived?.source || "configured-sessions", sessions, warnings: [...new Set(warnings)] });
  });

  registerGet("resolve-entry", (c) => {
    const h = hub(ctx);
    const { sessionsDir, sessionsDirs } = sessionSearchDirs(h, ctx);
    const resolved = resolveEntryFile({ sessionsDir, sessionsDirs, entryId: c.req.query("entryId") || "" });
    return resolved ? c.json({ ok: true, ...resolved }) : c.json({ ok: false, error: "entry_not_found" }, 404);
  });

  registerGet("current-session", (c) => {
    const h = hub(ctx);
    const queryFocus = {
      sessionId: c.req.query("sessionId") || c.req.query("id") || "",
      agent: c.req.query("agent") || c.req.query("agentId") || "",
      file: c.req.query("file") || c.req.query("path") || c.req.query("sessionPath") || "",
    };
    const hasQueryFocus = Object.values(queryFocus).some(Boolean);
    const explicitlyEmpty = c.req.query("noFocusedSession") === "1";
    const { sessionsDir, sessionsDirs } = sessionSearchDirs(h, ctx);

    // 优先级：显式 query focus > ctx 声明的焦点 > ctx.sessionPath 路径兜底 > 无
    let focus = null;
    let source = "none";
    if (!explicitlyEmpty && hasQueryFocus) {
      focus = resolveCurrentSession({}, queryFocus);
      source = focus ? "query" : "none";
    } else if (!explicitlyEmpty) {
      focus = resolveCurrentSession(ctx);
      if (focus) source = "config";
      if (!focus) {
        const safe = safeSessionPath(ctx?.sessionPath, sessionsDirs);
        if (safe) { focus = safe; source = "ctx-session-path"; }
      }
    }
    if (!focus) {
      // 最近活跃会话兜底：不依赖宿主凭据，按 mtime 推断当前 agent 的活跃会话
      if (!explicitlyEmpty) {
        const agentId = ctx?.agentId || (typeof c.get === "function" ? c.get("agentId") : "") || "";
        const agentsRoot = path.join(hanaHome(), "agents");
        const preferred = agentId ? path.join(agentsRoot, agentId, "sessions") : "";
        let dir = preferred;
        let latest = preferred ? latestActiveSession({ sessionsDir: preferred }) : null;
        if (!latest) {
          dir = path.join(agentsRoot, "hanako", "sessions");
          latest = latestActiveSession({ sessionsDir: dir });
        }
        if (latest) {
          const safe = safeSessionPath(path.join(dir, latest.file), sessionsDirs);
          if (safe) { focus = safe; source = "latest-session"; }
        }
      }
    }
    if (!focus) {
      // 运行时诊断：source 为 none 时列出 ctx 上带 session/path/focus 字样的 key 名（只列 key，不列值）
      const sessionKeys = Object.keys(ctx || {}).filter((key) => /session|path|focus/i.test(key));
      return c.json({ available: false, reason: "no_focused_session", source, sessionKeys, session: null });
    }
    // 当前会话路由禁止使用 ctx.sessionPath 推导目录；只能使用插件配置或默认安全目录。
    const detail = readSessionDetail({ sessionsDir, sessionsDirs, ...focus, limitTurns: c.req.query("limit") || 500 });
    if (!detail) return c.json({ available: false, reason: "focused_session_unavailable", source, session: null });
    return c.json({ available: true, source, session: detail });
  });

  registerGet("session-titles", (c) => {
    const h = hub(ctx);
    const derived = h?.paths?.sessionsDir ? null : deriveSessionsDirInfo({ config: ctx?.config });
    const dir = h?.paths?.sessionsDir || derived?.path;
    try {
      const raw = sessionTitleMap({ sessionsDir: dir });
      const titles = {};
      for (const rs of Object.values(h?.data?.rollup?.recentSessions || {})) {
        const id = rs?.sessionId;
        if (!id || titles[id]) continue;
        // 瘦身后只存 attribution.sessionFile（basename）；旧条目/缺失时回退 sessionId 匹配
        const file = rs?.file || "";
        const title = (file && (raw[file] || raw[file.replace(/\.jsonl$/i, "")])) || raw[id];
        if (title) titles[id] = title;
      }
      return c.json({ titles });
    } catch { return c.json({ titles: {} }); }
  });

  registerGet("session-detail", (c) => {
    const h = hub(ctx);
    const derived = h?.paths?.sessionsDir ? null : deriveSessionsDirInfo(ctx);
    const sessionsDir = h?.paths?.sessionsDir || derived.path;
    const detail = readSessionDetail({
      sessionsDir,
      agent: c.req.query("agent"),
      sessionId: c.req.query("sessionId"),
      file: c.req.query("file"),
      limitTurns: c.req.query("limit") || 500,
    });
    if (!detail) return c.json({ error: "session not found or unreadable" }, 404);
    if (detail.error === "ambiguous_session_id") return c.json({ error: detail.error, matches: detail.matches }, 409);
    return c.json(detail);
  });

  // ── 手动刷新（先归档再重建视图）──
  registerPost("refresh", async (c) => {
    const h = hub(ctx);
    if (!h || typeof h.refresh !== "function") return c.json({ error: "unavailable" }, 503);
    await h.refresh();
    return c.json({ ok: true, ready: h.ready, lastRefreshAt: h.lastRefreshAt, error: h.lastRefreshError });
  });

  // ── 私有设置：GET 仅返回掩码/配置状态；凭据输入为空时保留 ──
  registerGet("settings", (c) => {
    const h = hub(ctx);
    if (!h) return c.json({ error: "plugin state missing" }, 503);
    try { return c.json(publicSettings(h.paths.dataDir)); } catch (err) { return c.json({ error: err.message }, 500); }
  });
  registerPost("settings", async (c) => {
    const h = hub(ctx);
    if (!h) return c.json({ error: "plugin state missing" }, 503);
    try {
      const payload = await c.req.json();
      const before = publicSettings(h.paths.dataDir);
      const result = validateAndSave(h.paths.dataDir, payload);
      h.settings = result;
      const balanceChanged = Boolean(payload.balance && Object.keys(payload.balance).some((key) => payload.balance[key] !== before.balance?.[key]));
      const credentialsChanged = payload.credentials && Object.values(payload.credentials).some((value) => typeof value === "string" && value.trim());
      let balance = null;
      if ((balanceChanged || credentialsChanged) && h.balance?.refresh) balance = await h.balance.refresh();
      return c.json({ ok: true, settings: result, ...(balance ? { balance, balanceRefreshed: true } : { balanceRefreshed: false }) });
    } catch (err) { return c.json({ error: err.message || "malformed payload" }, 400); }
  });

  // ── 余额/订阅额度：网络只发生在显式 refresh，GET 返回最后一次快照 ──
  registerGet("balance", async (c) => {
    const h = hub(ctx);
    if (!h?.balance) return c.json({ error: "unavailable" }, 503);
    // 参照会话用量：GET 直接查询（60 秒内复用上一次结果），不依赖前端先 POST refresh
    try {
      const snapshot = h.balance.snapshot();
      const attemptedAt = snapshot.lastAttemptAt ? Date.parse(snapshot.lastAttemptAt) : 0;
      if (attemptedAt && Date.now() - attemptedAt < 60000) return c.json(snapshot);
      return c.json(await h.balance.refresh());
    } catch (err) {
      return c.json(h.balance.snapshot());
    }
  });
  registerPost("balance/refresh", async (c) => {
    const h = hub(ctx);
    if (!h?.balance) return c.json({ error: "unavailable" }, 503);
    try { return c.json(await h.balance.refresh()); } catch { return c.json({ error: "unavailable" }, 503); }
  });


  // ── 前端静态资源（显式挂载，不依赖宿主框架约定）──
  app.get("/assets/panel.js",  (c) => {
    c.header("Content-Type", "application/javascript; charset=utf-8");
    return c.body(fs.readFileSync(new URL("../assets/panel.js", import.meta.url), "utf-8"));
  });
  app.get("/assets/panel.css", (c) => {
    c.header("Content-Type", "text/css; charset=utf-8");
    return c.body(fs.readFileSync(new URL("../assets/panel.css", import.meta.url), "utf-8"));
  });
}

function rollupCoverage(rollup) {
  const days = Object.keys(rollup?.days || {}).sort();
  const gaps = [];
  for (let i = 1; i < days.length; i++) {
    const diff = Math.round((new Date(days[i] + "T00:00:00Z") - new Date(days[i - 1] + "T00:00:00Z")) / 86400000);
    if (diff > 1) gaps.push({ from: days[i - 1], to: days[i], missingDays: diff - 1 });
  }
  return { firstDay: days[0] || null, lastDay: days[days.length - 1] || null, daysWithData: days.length, gaps, duplicateRequestIds: 0, duplicateSamples: [] };
}

function minDay(entries) {
  let m = null;
  for (const e of entries) {
    const t = e.startedAt || e.endedAt;
    if (t && (!m || t < m)) m = t;
  }
  return m;
}
function maxDay(entries) {
  let m = null;
  for (const e of entries) {
    const t = e.startedAt || e.endedAt;
    if (t && (!m || t > m)) m = t;
  }
  return m;
}
