// 余额/订阅额度读取：只保留供应商返回的余额或额度字段，不做费用计算。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadSettings, atomicWrite } from "./settings.js?v=0.6.0";

const TIMEOUT_MS = 8000;
const CATALOG_FILES = ["provider-catalog.json", path.join(".hanako", "provider-catalog.json")];

// 配置驱动的余额查询（参照 token-tracker 的 balance-apis.json 方案）：
// 数据目录下的 balance-apis.json 可覆盖/新增供应商，key 一律从宿主 provider-catalog.json 取。
const BALANCE_APIS_FILE = "balance-apis.json";
const DEFAULT_BALANCE_APIS = Object.freeze({
  deepseek: { url: "https://api.deepseek.com/user/balance", enabled: true },
  moonshot: { url: "https://api.moonshot.cn/v1/users/me/balance", enabled: true },
  glm: { url: "https://open.bigmodel.cn/api/paas/v4/users/me/balance", enabled: true },
  minimax: { url: "https://api.minimaxi.com/v1/user/balance", enabled: true },
});
const PROVIDER_LABELS = Object.freeze({ deepseek: "DeepSeek", moonshot: "Moonshot", glm: "智谱", minimax: "MiniMax", agnes: "Agnes", "llm-qwen": "Qwen", codex: "ChatGPT" });
// 宿主 catalog 提供 base_url 时，用它拼默认路径；否则用配置里的完整 url
const DEFAULT_PATHS = Object.freeze({ deepseek: "/user/balance", glm: "/api/paas/v4/users/me/balance", minimax: "/v1/user/balance" });
function labelOf(id) { return PROVIDER_LABELS[id] || id; }
function resolveBalanceUrl(id, conf, catalog) {
  const node = providerNode(catalog, id) || {};
  const base = firstString(node.base_url, node.baseUrl, node.url);
  if (base) {
    if (id === "moonshot") return moonshotBalanceUrl(base);
    const suffix = firstString(conf.path) || DEFAULT_PATHS[id];
    if (suffix) return `${base.replace(/\/+$/, "")}${suffix}`;
  }
  return firstString(conf.url);
}
function loadBalanceApis(dataDir) {
  const merged = { ...DEFAULT_BALANCE_APIS };
  try {
    const custom = JSON.parse(fs.readFileSync(path.join(dataDir, BALANCE_APIS_FILE), "utf8"));
    if (custom && typeof custom === "object") {
      for (const [id, conf] of Object.entries(custom)) {
        if (conf === false) { delete merged[id]; continue; }
        if (conf && typeof conf === "object") merged[id] = { ...(merged[id] || {}), ...conf };
      }
    }
  } catch {}
  return merged;
}
function readObject(value) { if (!value) return null; if (typeof value === "object") return value; try { return JSON.parse(fs.readFileSync(value, "utf8")); } catch { return null; } }
function providerNode(catalog, provider) { return catalog?.providers?.[provider] || catalog?.[provider] || catalog?.models?.[provider] || catalog?.catalog?.[provider] || null; }
function firstString(...values) { return values.find((v) => typeof v === "string" && v.trim())?.trim() || ""; }
function safeNumber(v) {
  if (typeof v !== "number" && typeof v !== "string") return null;
  if (typeof v === "string" && !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function pick(obj, keys) { for (const k of keys) { const n = safeNumber(obj?.[k]); if (n != null) return n; } return null; }
function statusOf(error) {
  const code = String(error?.code || "");
  const name = String(error?.name || "");
  const message = String(error?.message || error || "");
  if (code === "MALFORMED_RESPONSE") return "malformed_response";
  if (code === "ABORT_ERR" || name === "AbortError" || name === "TimeoutError" || /timeout|network|fetch failed|ECONN|ENOTFOUND/i.test(message)) return "network";
  return /401|403|unauthorized|invalid.*key/i.test(message) ? "unauthorized" : "error";
}
function authHeader(key) { return { Authorization: `Bearer ${key}`, Accept: "application/json" }; }
function moonshotBalanceUrl(base) {
  const normalized = String(base || "https://api.moonshot.cn").replace(/\/+$/, "");
  return /\/v1$/i.test(normalized) ? `${normalized}/users/me/balance` : `${normalized}/v1/users/me/balance`;
}
async function getJson(fetchFn, url, init) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetchFn(url, { ...init, signal });
  if (!res?.ok) throw new Error(`HTTP ${res?.status || 0}`);
  try { return await res.json(); }
  catch (error) { throw Object.assign(error, { code: "MALFORMED_RESPONSE" }); }
}
function parseDeepSeek(data) {
  const row = Array.isArray(data?.balance_infos) ? data.balance_infos[0] : data;
  const balance = pick(row, ["total_balance", "balance", "available_balance"]);
  if (balance == null) throw Object.assign(new Error("malformed response"), { code: "MALFORMED_RESPONSE" });
  return { currency: row?.currency || "CNY", balance };
}
function parseMoonshot(data) {
  const row = Array.isArray(data?.data) ? data.data[0] : (data?.data || data);
  const balance = pick(row, ["available_balance", "balance", "cash_balance", "total_balance"]);
  if (balance == null) throw Object.assign(new Error("malformed response"), { code: "MALFORMED_RESPONSE" });
  return { currency: row?.currency || "CNY", balance };
}
// 通用解析：DeepSeek balance_infos / 通用金额字段 / GLM 百分比额度
function parseGeneric(data) {
  if (Array.isArray(data?.balance_infos) && data.balance_infos.length) {
    let total = 0;
    let currency = "CNY";
    let seen = false;
    for (const info of data.balance_infos) {
      const value = safeNumber(info?.total_balance);
      if (value != null) { total += value; seen = true; }
      if (typeof info?.currency === "string" && info.currency.trim()) currency = info.currency.trim();
    }
    if (seen) return { currency, balance: total };
    throw Object.assign(new Error("malformed response"), { code: "MALFORMED_RESPONSE" });
  }
  const row = Array.isArray(data?.data) ? data.data[0] : (data?.data && typeof data.data === "object" ? data.data : data);
  const balance = pick(row, ["available_balance", "balance", "total_balance", "cash_balance", "available"]);
  if (balance != null) return { currency: row?.currency || data?.currency || "CNY", balance };
  const limits = data?.data?.limits;
  if (Array.isArray(limits)) {
    const entry = limits.find((item) => item?.type === "TOKENS_LIMIT") || limits[0];
    const usedPercent = percentOf(entry, ["percentage", "used_percent"]);
    if (usedPercent != null) return { currency: "", balance: null, usedPercent, remainingPercent: Math.max(0, 100 - usedPercent) };
  }
  throw Object.assign(new Error("malformed response"), { code: "MALFORMED_RESPONSE" });
}
function percentOf(obj, keys) {
  const value = pick(obj, keys);
  if (value == null) return null;
  return value >= 0 && value <= 1 ? value * 100 : value;
}
function codexWindow(raw = {}, name = "window") {
  const used = pick(raw, ["used", "usage", "current_usage"]);
  const limit = pick(raw, ["limit", "max_usage", "quota"]);
  const usedPercent = percentOf(raw, ["used_percent", "usedPercent"]);
  const remainingPercent = percentOf(raw, ["remaining_percent", "remainingPercent"]) ?? (usedPercent != null ? Math.max(0, 100 - usedPercent) : null);
  const remaining = pick(raw, ["remaining", "remaining_usage"]) ?? (limit != null && used != null ? Math.max(0, limit - used) : remainingPercent);
  return { name, used, limit, remaining, usedPercent, remainingPercent, reset: raw.reset_at || raw.resetAt || null, limitWindowSeconds: pick(raw, ["limit_window_seconds", "limitWindowSeconds"]) };
}
function codexWindowLabel(id, seconds) {
  const s = Number(seconds);
  if (s === 18000) return "5 小时窗口";
  if (s === 604800) return "周窗口";
  if (Number.isFinite(s) && s > 0) return `${Math.round(s / 3600)} 小时窗口`;
  return id === "secondary" ? "周窗口" : "主窗口";
}
function parseCodex(data) {
  const row = data?.rate_limit || data?.usage || data;
  const primary = codexWindow(row?.primary_window || row?.primaryWindow || row?.primary || row || {}, "primary");
  const secondary = codexWindow(row?.secondary_window || row?.secondaryWindow || row?.secondary || {}, "secondary");
  if (primary.used == null && primary.limit == null && primary.remaining == null && primary.remainingPercent == null && secondary.remaining == null && secondary.remainingPercent == null) throw Object.assign(new Error("malformed response"), { code: "MALFORMED_RESPONSE" });
  const windows = [
    { id: "primary", label: codexWindowLabel("primary", primary.limitWindowSeconds), usedPercent: primary.usedPercent, remainingPercent: primary.remainingPercent, resetAt: primary.reset },
    { id: "secondary", label: codexWindowLabel("secondary", secondary.limitWindowSeconds), usedPercent: secondary.usedPercent, remainingPercent: secondary.remainingPercent, resetAt: secondary.reset },
  ].filter((w) => w.usedPercent != null || w.remainingPercent != null);
  return { period: primary.reset || row?.period || "subscription", planType: data?.plan_type || row?.plan_type || null, used: primary.used, limit: primary.limit, remaining: primary.remaining, usedPercent: primary.usedPercent, remainingPercent: primary.remainingPercent, secondaryRemaining: secondary.remaining, secondaryRemainingPercent: secondary.remainingPercent, reset: primary.reset, limitWindowSeconds: primary.limitWindowSeconds, primary, secondary, windows };
}
function findKey(value, provider) {
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (const item of value) if (item?.id === provider || item?.name === provider) {
      for (const key of ["apiKey", "api_key", "key", "token"]) if (typeof item[key] === "string" && item[key].trim()) return item[key].trim();
    }
    return "";
  }
  const node = value[provider] || value.providers?.[provider] || value.catalog?.[provider];
  if (node && typeof node === "object") {
    for (const key of ["apiKey", "api_key", "key", "token"]) if (typeof node[key] === "string" && node[key].trim()) return node[key].trim();
  }
  return findKey(value.providers, provider) || findKey(value.catalog, provider);
}
function safeWindow(value, fallbackName) {
  if (!value || typeof value !== "object") return null;
  const out = { name: typeof value.name === "string" ? value.name : fallbackName };
  for (const key of ["used", "limit", "remaining", "usedPercent", "remainingPercent", "limitWindowSeconds"]) {
    const n = safeNumber(value[key]);
    if (n != null) out[key] = n;
  }
  if (typeof value.reset === "string" && value.reset.trim()) out.reset = value.reset;
  return out;
}
function safeSource(source) {
  if (!source || typeof source !== "object") return null;
  const out = {};
  for (const key of ["id", "kind", "status", "configured", "label", "currency", "balance", "period", "used", "limit", "remaining", "secondaryRemaining", "usedPercent", "remainingPercent", "secondaryRemainingPercent", "reset", "limitWindowSeconds", "stale", "disabled", "windows", "planType"]) {
    if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
  }
  const primary = safeWindow(source.primary, "primary");
  const secondary = safeWindow(source.secondary, "secondary");
  if (primary) out.primary = primary;
  if (secondary) out.secondary = secondary;
  return out.id ? out : null;
}
function catalogKey(roots, provider) {
  for (const root of roots) for (const file of CATALOG_FILES) {
    try { const data = JSON.parse(fs.readFileSync(path.join(root, file), "utf8")); const key = findKey(data, provider); if (key) return key; } catch {}
  }
  return "";
}
function hostKey(catalog, roots, provider) {
  const node = providerNode(catalog, provider) || {};
  return firstString(node.api_key, node.apiKey, node.key, node.token) || catalogKey(roots, provider);
}
function firstFileObject(roots, names) {
  for (const root of roots) for (const name of names) {
    const value = readObject(path.join(root, name));
    if (value) return value;
  }
  return null;
}

export class BalanceService {
  constructor({ dataDir, fetchFn, networkFetch, homeDir = os.homedir(), dataRoot = "", pathCandidates = [], pluginDir = "", providerCatalog = null, auth = null, config = null, log } = {}) {
    this.dataDir = dataDir; this.fetchFn = fetchFn || networkFetch || globalThis.fetch; this.homeDir = homeDir; this.dataRoot = dataRoot; this.pathCandidates = pathCandidates; this.pluginDir = pluginDir; this.providerCatalog = providerCatalog; this.auth = auth; this.config = config; this.log = log; this.inflight = null;
    this.lastGood = this.loadLastGood();
  }
  loadLastGood() {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(this.dataDir, "balance.json"), "utf8"));
      if (!value || typeof value !== "object") return null;
      // 缓存里的 label/kind 可能来自旧版本，按 id 重新派生，避免旧显示名继续上屏
      const sources = (value.sources || [])
        .map((raw) => {
          const safe = safeSource(raw);
          if (!safe) return null;
          const kind = safe.id === "codex" ? "quota" : (safe.kind || "balance");
          return { ...safe, kind, label: PROVIDER_LABELS[safe.id] || safe.label || safe.id };
        })
        .filter(Boolean);
      return { ...value, sources };
    } catch { return null; }
  }
  snapshot() { return this.lastGood ? { ...this.lastGood, cached: this.lastGood.disabled ? false : true } : { sources: [], updatedAt: null, cached: false, stale: true, lastAttemptAt: null, lastSuccessAt: null }; }
  async refresh() {
    if (this.inflight) return this.inflight;
    this.inflight = this._refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }
  async _refresh() {
    const { settings, credentials } = loadSettings(this.dataDir);
    const configuredDataRoot = this.config?.get?.("dataRoot");
    const configuredSessionsDir = this.config?.get?.("sessionsDir");
    const roots = [...new Set([...this.pathCandidates, this.dataRoot, configuredDataRoot, this.pluginDir, this.dataDir, configuredSessionsDir, configuredSessionsDir && path.dirname(configuredSessionsDir), this.homeDir].filter((value) => typeof value === "string" && value.trim()))];
    const catalog = readObject(this.providerCatalog) || readObject(this.config?.get?.("providerCatalog")) || readObject(this.config?.get?.("providerCatalogPath")) || firstFileObject(roots, CATALOG_FILES);
    const authCatalog = readObject(this.auth) || readObject(this.config?.get?.("auth")) || readObject(this.config?.get?.("authPath")) || firstFileObject(roots, ["auth.json", path.join(".codex", "auth.json")]) || {};
    const pluginSettings = readObject(path.join(this.dataDir, "settings", "settings.json"));
    const codexExplicit = pluginSettings?.balance && Object.prototype.hasOwnProperty.call(pluginSettings.balance, "codexEnabled");
    const codexEnabled = codexExplicit ? pluginSettings.balance.codexEnabled === true : this.config?.get?.("enableCodexQuota") === true;
    const last = this.lastGood;
    const previous = new Map((last?.sources || []).map((source) => [source.id, safeSource(source)]).filter(([, source]) => source));
    const attemptAt = new Date().toISOString();
    const sources = [];
    if (!settings.balance.enabled) {
      const result = { sources, updatedAt: attemptAt, cached: false, disabled: true, stale: false, lastAttemptAt: attemptAt, lastSuccessAt: last?.lastSuccessAt || null };
      this.lastGood = result;
      atomicWrite(path.join(this.dataDir, "balance.json"), result);
      return result;
    }
    const run = async (id, configured, fn, kind = "balance") => {
      const label = kind === "quota" ? (id === "codex" ? "ChatGPT" : labelOf(id)) : labelOf(id);
      if (!configured) { sources.push({ id, kind, label, status: "unavailable", configured: false }); return; }
      try { sources.push({ id, kind, label, status: "ok", configured: true, ...await fn() }); }
      catch (error) {
        const status = statusOf(error);
        const old = previous.get(id);
        this.log?.warn?.(`[usage-hub] balance ${id} ${status}`);
        sources.push({ ...(old || {}), id, kind, label, status, configured: true, stale: true });
      }
    };
    // 供应商余额：配置驱动（balance-apis.json 可覆盖），key 一律取宿主 provider-catalog.json
    for (const [id, conf] of Object.entries(loadBalanceApis(this.dataDir))) {
      if (!conf || conf.enabled === false) continue;
      const url = resolveBalanceUrl(id, conf, catalog);
      if (!url) continue;
      const key = hostKey(catalog, roots, id) || firstString(credentials?.[`${id}ApiKey`]);
      await run(id, Boolean(key), async () => parseGeneric(await getJson(this.fetchFn, url, { headers: authHeader(key) })));
    }
    if (codexEnabled) {
      let token = ""; let accountId = "";
      const codexAuth = authCatalog["openai-codex"] || authCatalog.codex || {};
      try { const auth = Object.keys(codexAuth).length ? codexAuth : JSON.parse(fs.readFileSync(path.join(this.homeDir, ".codex", "auth.json"), "utf8")); token = auth.access_token || auth.access || auth.tokens?.access_token || auth.token || ""; accountId = auth.account_id || auth.accountId || auth.tokens?.account_id || ""; } catch {}
      await run("codex", Boolean(token), async () => parseCodex(await getJson(this.fetchFn, "https://chatgpt.com/backend-api/wham/usage", { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "OpenAI-Beta": "codex-1", originator: "Codex Desktop", "User-Agent": "usage-hub/0.4", ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}) } })), "quota");
    } else sources.push({ id: "codex", kind: "quota", label: "ChatGPT", status: "unavailable", configured: false, disabled: true });    const success = sources.some((source) => source.status === "ok");
    const result = { sources, updatedAt: attemptAt, cached: false, stale: sources.some((source) => source.status !== "ok"), lastAttemptAt: attemptAt, lastSuccessAt: success ? attemptAt : (last?.lastSuccessAt || null) };
    this.lastGood = result;
    atomicWrite(path.join(this.dataDir, "balance.json"), result);
    return result;
  }
}
export function createBalanceService(options) { return new BalanceService(options); }
