// 宿主模型配置只读适配：仅提取 provider/model/contextWindow，不返回凭据或其他配置。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function numberOrNull(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function candidates({ dataRoot = "", config, homeDir = os.homedir() } = {}) {
  const configured = [dataRoot, config?.get?.("dataRoot"), config?.get?.("modelsPath"), config?.get?.("modelConfigPath")].filter((v) => typeof v === "string" && v.trim());
  const hanaHome = typeof process.env.HANA_HOME === "string" && process.env.HANA_HOME.trim() ? process.env.HANA_HOME.trim() : "";
  const roots = [...configured, path.join(homeDir, ".hanako"), ...(hanaHome ? [hanaHome] : [])].filter(Boolean);
  const files = [];
  for (const value of roots) {
    const full = value.endsWith(".json") ? value : path.join(value, "models.json");
    files.push(full, path.join(path.dirname(full), "config", "models.json"));
  }
  return [...new Set(files)];
}
function entries(value, inheritedProvider = "") {
  const out = [];
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) return value.flatMap((item) => entries(item, inheritedProvider));
  const provider = text(value.provider || value.providerId || value.vendor || inheritedProvider);
  const model = text(value.modelId || value.model || value.id || value.name);
  const contextWindow = numberOrNull(value.contextWindow, value.context_window, value.context, value.maxContextTokens, value.max_input_tokens, value.limits?.contextWindow, value.limits?.context, value.capabilities?.contextWindow);
  if (provider && model && contextWindow) out.push({ provider, model, contextWindow });
  for (const [key, child] of Object.entries(value)) {
    if (key === "credentials" || /key|token|secret|password|auth/i.test(key)) continue;
    const structural = new Set(["providers", "models", "model", "entries", "items", "data", "capabilities", "limits"]);
    const nextProvider = provider || (!structural.has(key) && typeof child === "object" ? key : inheritedProvider);
    const effectiveProvider = provider || inheritedProvider;
    const mappedChild = !structural.has(key) && effectiveProvider && child && typeof child === "object" && !Array.isArray(child) && !text(child.modelId || child.model || child.id || child.name)
      ? { ...child, modelId: key }
      : child;
    out.push(...entries(mappedChild, nextProvider));
  }
  return out;
}
export function readModelsConfig(options = {}) {
  for (const file of candidates(options)) {
    const value = readJson(file);
    if (value) return { file, entries: entries(value) };
  }
  return { file: null, entries: [] };
}
export function resolveContextWindow({ provider = "", model = "", nativeContextWindow = null, ...options } = {}) {
  const native = numberOrNull(nativeContextWindow);
  if (native) return { contextWindow: native, provider, model, source: "jsonl-native" };
  const match = readModelsConfig(options).entries.find((item) => item.provider === provider && item.model === model);
  return match ? { ...match, source: "models-config" } : { contextWindow: null, provider, model, source: "unavailable" };
}
export { candidates as modelConfigCandidates };
