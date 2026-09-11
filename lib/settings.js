// 私有设置与凭据：settings/ 下分离存储，凭据永不进入公开响应。
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_SETTINGS = Object.freeze({
  display: { hideAgent: false, hideModel: false, hiddenAgents: [], hiddenModels: [] },
  ui: { refreshSeconds: 60 },
  balance: { enabled: true, pollSeconds: 300, codexEnabled: true },
  compaction: { threshold: 0.80 },
});
export const LIMITS = Object.freeze({ uiRefreshSeconds: [10, 3600], pollSeconds: [60, 86400], compactionThreshold: [0.50, 0.95] });
const SETTINGS_FILE = "settings.json";
const CREDENTIALS_FILE = "credentials.json";

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function merge(base, value) {
  const out = {};
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  for (const section of Object.keys(base)) {
    const defaults = base[section];
    const incoming = source[section];
    const next = {};
    for (const key of Object.keys(defaults)) {
      next[key] = Object.prototype.hasOwnProperty.call(incoming || {}, key)
        ? incoming[key]
        : defaults[key];
    }
    out[section] = next;
  }
  return out;
}
function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}
function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (err) {
    if (err.code === "ENOENT") return clone(fallback);
    throw new Error("stored settings are invalid");
  }
}
function mask(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 7) return "••••";
  return `${text.slice(0, 2)}••••${text.slice(-2)}`;
}

export function settingsPaths(dataDir) {
  const dir = path.join(dataDir, "settings");
  return { dir, settings: path.join(dir, SETTINGS_FILE), credentials: path.join(dir, CREDENTIALS_FILE) };
}
export function loadSettings(dataDir) {
  const p = settingsPaths(dataDir);
  return { settings: merge(DEFAULT_SETTINGS, readJson(p.settings, DEFAULT_SETTINGS)), credentials: readJson(p.credentials, {}) };
}
export function publicSettings(dataDir) {
  const { settings, credentials } = loadSettings(dataDir);
  return { ...clone(settings), credentials: Object.fromEntries(["deepseekApiKey", "moonshotApiKey"].map((key) => [key, { configured: Boolean(credentials[key]), masked: mask(credentials[key]) }])) };
}

const allowed = { display: ["hideAgent", "hideModel", "hiddenAgents", "hiddenModels"], ui: ["refreshSeconds"], balance: ["enabled", "pollSeconds", "codexEnabled"], compaction: ["threshold"], credentials: ["deepseekApiKey", "moonshotApiKey"] };
export function validateAndSave(dataDir, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("malformed payload");
  for (const key of Object.keys(payload)) if (!allowed[key]) throw new Error(`unknown field: ${key}`);
  const current = loadSettings(dataDir);
  const next = clone(current.settings);
  const nextCredentials = { ...current.credentials };
  for (const section of ["display", "ui", "balance", "compaction"]) {
    if (payload[section] === undefined) continue;
    if (!payload[section] || typeof payload[section] !== "object" || Array.isArray(payload[section])) throw new Error(`malformed field: ${section}`);
    for (const key of Object.keys(payload[section])) if (!allowed[section].includes(key)) throw new Error(`unknown field: ${section}.${key}`);
    for (const key of Object.keys(payload[section])) {
      const value = payload[section][key];
      const list = section === "display" && (key === "hiddenAgents" || key === "hiddenModels");
      const numeric = (section === "ui" && key === "refreshSeconds") || (section === "balance" && key === "pollSeconds") || (section === "compaction" && key === "threshold");
      if (list) {
        if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`invalid field: ${section}.${key}`);
        next[section][key] = [...new Set(value.map((item) => item.trim()))];
        continue;
      }
      if (typeof value !== (numeric ? "number" : "boolean") || (numeric && !Number.isFinite(value))) throw new Error(`invalid field: ${section}.${key}`);
      if (key === "refreshSeconds" && (value < LIMITS.uiRefreshSeconds[0] || value > LIMITS.uiRefreshSeconds[1] || !Number.isInteger(value))) throw new Error("refreshSeconds out of range");
      if (key === "pollSeconds" && (value < LIMITS.pollSeconds[0] || value > LIMITS.pollSeconds[1] || !Number.isInteger(value))) throw new Error("pollSeconds out of range");
      if (key === "threshold" && (value < LIMITS.compactionThreshold[0] || value > LIMITS.compactionThreshold[1] || Math.round(value * 100) !== value * 100)) throw new Error("threshold out of range");
      next[section][key] = value;
    }
  }
  if (payload.credentials !== undefined) {
    if (!payload.credentials || typeof payload.credentials !== "object" || Array.isArray(payload.credentials)) throw new Error("malformed field: credentials");
    for (const key of Object.keys(payload.credentials)) {
      if (!allowed.credentials.includes(key)) throw new Error(`unknown field: credentials.${key}`);
      if (typeof payload.credentials[key] !== "string") throw new Error(`invalid field: credentials.${key}`);
      if (payload.credentials[key].length > 4096) throw new Error(`invalid field: credentials.${key}`);
      if (payload.credentials[key].trim()) nextCredentials[key] = payload.credentials[key].trim();
    }
  }
  const p = settingsPaths(dataDir);
  atomicWrite(p.settings, next);
  atomicWrite(p.credentials, nextCredentials);
  return publicSettings(dataDir);
}
export { atomicWrite };
