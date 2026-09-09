// assets/panel.js — usage-hub 前端（视觉语言沿用 session-insight，数据源为 usage-hub 聚合接口）
// page: 全局用量面板；widget: 用量状态条。本插件不含任何费用 UI（PLAN 4.3）。

const PROTOCOL = "hana.plugin.ui";
const VERSION = 1;
let seq = 0;

function targetOrigin() {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("hana-host-origin");
  if (explicit) return explicit;
  try {
    return new URL(document.referrer).origin;
  } catch {
    return "*";
  }
}

function post(message) {
  window.parent.postMessage(message, targetOrigin());
}

function event(type, payload) {
  post({ protocol: PROTOCOL, version: VERSION, kind: "event", type, payload });
}

function request(type, payload, timeoutMs = 10000) {
  const id = `hana-plugin-${Date.now()}-${++seq}`;
  const origin = targetOrigin();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error(`Host request timed out: ${type}`));
    }, timeoutMs);

    function onMessage(evt) {
      if (evt.source !== window.parent) return;
      if (origin !== "*" && evt.origin !== origin) return;
      const msg = evt.data || {};
      if (msg.protocol !== PROTOCOL || msg.version !== VERSION || msg.id !== id || msg.type !== type) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (msg.kind === "error") reject(new Error(msg.error?.message || `Host request failed: ${type}`));
      else resolve(msg.payload);
    }

    window.addEventListener("message", onMessage);
    post({ protocol: PROTOCOL, version: VERSION, id, kind: "request", type, payload });
  });
}

function currentPluginId() {
  const match = /^\/api\/plugins\/([^/]+)(?:\/|$)/.exec(window.location.pathname || "");
  if (!match) throw new Error("Plugin API helper requires an iframe route under /api/plugins/:pluginId/.");
  return decodeURIComponent(match[1]);
}

function normalizePluginApiPath(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("Invalid plugin API path.");
  const trimmed = input.trim();
  if (
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    trimmed.includes("#") ||
    trimmed.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  ) throw new Error("Invalid plugin API path.");

  const stripped = trimmed.replace(/^\/+/, "");
  if (!stripped || stripped.startsWith("./") || stripped === "api/plugins" || stripped.startsWith("api/plugins/")) {
    throw new Error("Invalid plugin API path. Use a route path relative to the current plugin.");
  }
  const queryIndex = stripped.indexOf("?");
  const rawPath = queryIndex >= 0 ? stripped.slice(0, queryIndex) : stripped;
  const segments = rawPath.split("/");
  for (const segment of segments) {
    if (!segment) throw new Error("Invalid plugin API path.");
    const decoded = decodeURIComponent(segment);
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw new Error("Invalid plugin API path.");
    }
  }
  const parsed = new URL(`http://hana.local/${stripped}`);
  return `${segments.map(segment => encodeURIComponent(decodeURIComponent(segment))).join("/")}${parsed.search}`;
}

function pluginApiUrl(path) {
  return `${window.location.origin}/api/plugins/${encodeURIComponent(currentPluginId())}/${normalizePluginApiPath(path)}`;
}

function pluginApiFetch(path, init = {}) {
  const surfaceSession = new URLSearchParams(window.location.search).get("pluginSurfaceSession");
  const headers = new Headers(init.headers || {});
  if (surfaceSession) headers.set("X-Hana-Plugin-Surface-Session", surfaceSession);
  return fetch(pluginApiUrl(path), { ...init, headers });
}

const hana = {
  ready: () => event("hana.ready"),
  ui: { resize: (size) => event("ui.resize", size) },
  api: { url: pluginApiUrl, fetch: pluginApiFetch },
  toast: { show: (input) => request("toast.show", input) },
};

const root = document.getElementById("root");
const surface = root?.dataset.surface || "page";

/* ── 宿主主题同步（沿用 session-insight 的完整链路） ── */
function parseThemeRgb(value) {
  const raw = String(value || "").trim();
  let match = raw.match(/^#([0-9a-f]{6})$/i);
  if (match) return [0, 2, 4].map((i) => Number.parseInt(match[1].slice(i, i + 2), 16));
  match = raw.match(/^#([0-9a-f]{3})$/i);
  if (match) return [...match[1]].map((x) => Number.parseInt(x + x, 16));
  match = raw.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function syncComputedColorMode() {
  try {
    const styles = getComputedStyle(document.body);
    const rgb = parseThemeRgb(styles.getPropertyValue("--bg")) || parseThemeRgb(styles.backgroundColor);
    if (!rgb) return;
    const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    const mode = luminance < 145 ? "dark" : "light";
    document.documentElement.dataset.colorMode = mode;
    document.body.dataset.colorMode = mode;
  } catch {}
}

function resolveThemeIntent(theme) {
  const raw = typeof theme === "string" ? theme.trim() : "";
  if (raw === "auto") return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "midnight" : "warm-paper";
  if (!raw || raw === "inherit") return "";
  return raw;
}

function applyHostTheme(theme) {
  const raw = resolveThemeIntent(theme);
  if (!raw) return false;
  if (document.documentElement.dataset.theme !== raw) document.documentElement.dataset.theme = raw;
  if (document.body.dataset.hanaTheme !== raw) document.body.dataset.hanaTheme = raw;
  const themeCss = document.getElementById("hana-theme-css")
    || document.querySelector('link[href*="/api/plugins/theme.css"]');
  if (themeCss) {
    try {
      const url = new URL(themeCss.href, window.location.href);
      if (url.searchParams.get("theme") !== raw) {
        url.searchParams.set("theme", raw);
        themeCss.addEventListener("load", syncComputedColorMode, { once: true });
        themeCss.href = url.toString();
      }
    } catch {}
  }
  requestAnimationFrame(syncComputedColorMode);
  return true;
}

function initHostThemeSync() {
  const initial = new URLSearchParams(window.location.search).get("hana-theme")
    || document.body.dataset.hanaTheme
    || "warm-paper";
  if (!applyHostTheme(initial)) applyHostTheme("warm-paper");

  try {
    const hostWindow = window.parent;
    const hostDocument = hostWindow.document;
    const hostRoot = hostDocument.documentElement;
    const media = hostWindow.matchMedia?.("(prefers-color-scheme: dark)");

    const readHostTheme = () => {
      const attr = hostRoot.getAttribute("data-theme")?.trim()
        || hostDocument.body?.getAttribute("data-theme")?.trim();
      if (attr && attr !== "auto" && attr !== "inherit") return attr;
      const saved = hostWindow.localStorage?.getItem("hana-theme")?.trim();
      if (saved && saved !== "auto" && saved !== "inherit") return saved;
      if (initial && initial !== "auto" && initial !== "inherit") return initial;
      return media?.matches ? "midnight" : "warm-paper";
    };

    const sync = () => applyHostTheme(readHostTheme());
    sync();

    const observer = new MutationObserver(sync);
    observer.observe(hostRoot, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    if (hostDocument.body) {
      observer.observe(hostDocument.body, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    }
    hostWindow.addEventListener("storage", sync);
    hostWindow.addEventListener("hana-settings", sync);
    media?.addEventListener?.("change", sync);
    const timer = hostWindow.setInterval(sync, 500);

    window.addEventListener("beforeunload", () => {
      observer.disconnect();
      hostWindow.removeEventListener("storage", sync);
      hostWindow.removeEventListener("hana-settings", sync);
      media?.removeEventListener?.("change", sync);
      hostWindow.clearInterval(timer);
    }, { once: true });
  } catch {}
}

initHostThemeSync();

function onHostThemeMessage(evt) {
  if (evt.source !== window.parent) return;
  const msg = evt.data || {};
  if (msg.type !== "hana.host.theme" && msg.type !== "hana.host.context") return;
  const payload = msg.payload || {};
  const theme = payload.resolvedTheme || payload.effectiveTheme || payload.theme;
  applyHostTheme(theme);
}
window.addEventListener("message", onHostThemeMessage);

/* ── SVG 图表（自绘，无 Chart.js；沿用 session-insight） ── */

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function gridLines(w, h, pad, n = 3) {
  let out = "";
  for (let g = 0; g < n; g++) {
    const y = pad + g * ((h - pad * 2) / (n - 1));
    out += `<line x1="${pad}" y1="${y.toFixed(1)}" x2="${w - pad}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="0.5" opacity="0.55"/>`;
  }
  return out;
}

function yAxis(values, opts) {
  const { h, axisW, plotL, plotR, topPad = 8, botPad = 8, yMax, format, n = 3, fontSize = 13 } = opts;
  const numericValues = values.filter((v) => v != null && Number.isFinite(v));
  const rawMax = numericValues.length ? Math.max(...numericValues) : 1;
  const max = yMax || (rawMax <= 0 ? 1 : rawMax * 1.08);
  let out = "";
  for (let i = 0; i < n; i++) {
    const frac = n === 1 ? 1 : i / (n - 1);
    const y = h - botPad - frac * (h - botPad - topPad);
    const val = max * frac;
    out += `<line x1="${plotL}" y1="${y.toFixed(1)}" x2="${plotR}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="0.5" opacity="0.45"/>`;
    out += `<text x="${axisW - 7}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="${fontSize}" font-weight="500" font-family="var(--font-ui)" fill="var(--text-light)">${esc(format ? format(val) : Math.round(val))}</text>`;
  }
  return out;
}

function xAxisEnds(n, opts) {
  const { h, plotL, plotR, pad, label } = opts;
  const y = h - 4;
  return `<text x="${plotL}" y="${y}" font-size="13" font-weight="500" font-family="var(--font-ui)" fill="var(--text-light)">1</text>` +
    `<text x="${plotR}" y="${y}" text-anchor="end" font-size="13" font-weight="500" font-family="var(--font-ui)" fill="var(--text-light)">${esc(label || n)}</text>`;
}

// 完整横轴刻度：labels 数组 + 显示间隔（用于小时图 0:00-23:00）
function xAxisLabels(n, opts) {
  const { h, plotL, plotR, labels, every = 1, fontSize = 13, centerEnds = false } = opts;
  const y = h - 4;
  const slot = (plotR - plotL) / n;
  const shown = [];
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    if (!isLast && i % every !== 0) continue;
    if (isLast && shown.length && (i - shown[shown.length - 1]) < every * 0.6) continue;
    shown.push(i);
  }
  return shown
    .map((i) => {
      const isFirst = i === 0, isLast = i === n - 1;
      const center = plotL + i * slot + slot / 2;
      // centerEnds：首尾也居中对齐到柱子中心（小时图 24 刻度用），否则首尾贴边
      const x = centerEnds ? center : (isFirst ? plotL : (isLast ? plotR : center));
      const anchor = centerEnds ? "middle" : (isFirst ? "start" : (isLast ? "end" : "middle"));
      return `<text x="${x.toFixed(1)}" y="${y}" text-anchor="${anchor}" font-size="${fontSize}" font-weight="500" font-family="var(--font-ui)" fill="var(--text-light)">${esc(labels[i])}</text>`;
    })
    .join("");
}

function lineChart(values, opts = {}) {
  const plotH = opts.h || 170;
  const xPad = 16;
  const w = opts.w || 640, h = plotH + xPad;
  const axisW = opts.axisW ?? 44, pad = 8;
  const plotL = axisW + pad, plotR = w - pad;
  const topPad = 34, botPad = 8;
  const top = topPad, bottom = plotH - botPad;
  const stroke = opts.stroke || "var(--accent)";
  const fill = opts.fill || "rgba(83,125,150,0.10)";
  const format = opts.format;
  const fmtTip = opts.tipFormat || format || ((v) => String(Math.round(v)));
  const n = values.length;
  if (n < 2) return `<svg viewBox="0 0 ${w} ${h}" role="img" xmlns="http://www.w3.org/2000/svg"><text x="${w/2}" y="${h/2}" text-anchor="middle" font-size="12" fill="var(--text-muted)">数据不足</text></svg>`;
  const numericValues = values.filter((v) => v != null && Number.isFinite(v));
  const rawMax = numericValues.length ? Math.max(...numericValues) : 1;
  const max = opts.yMax || (rawMax <= 0 ? 1 : rawMax * 1.08);
  const step = (plotR - plotL) / (n - 1);
  const Y = (v) => bottom - (v / max) * (bottom - top);
  const pts = values.map((v, i) => v == null || !Number.isFinite(v) ? null : [plotL + i * step, Y(v)]);
  const paths = [];
  let current = "";
  pts.forEach((p) => { if (!p) { if (current) paths.push(current); current = ""; } else { current += (current ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1); } });
  if (current) paths.push(current);
  const path = paths.join("");
  const area = paths.length === 1 && numericValues.length === n ? path + ` L${(plotL + (n - 1) * step).toFixed(1)},${bottom} L${plotL},${bottom} Z` : "";
  const lastIndex = values.findLastIndex((v) => v != null && Number.isFinite(v));
  const last = pts[lastIndex] || [plotL, bottom];
  const lastLabel = format && lastIndex >= 0 ? esc(format(values[lastIndex])) : "";
  const lx = Math.max(axisW + 24, Math.min(last[0], plotR - 24));
  let dots = "";
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (!p) continue;
    dots += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="var(--bg-card)" stroke="${stroke}" stroke-width="1" opacity="0"><title>第 ${i + 1} 天：${esc(fmtTip(values[i]))}</title></circle>`;
  }
  return `<svg viewBox="0 0 ${w} ${h}" role="img" xmlns="http://www.w3.org/2000/svg">
  ${yAxis(values, { h: plotH, axisW, plotL, plotR, topPad, botPad, yMax: opts.yMax, format, n: opts.ticks || 3 })}
  ${area ? `<path class="si-area" d="${area}" fill="${fill}" stroke="none"/>` : ""}
  <path class="si-line" d="${path}" pathLength="1" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  ${dots}
  ${lastLabel ? `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.5" fill="${stroke}"/><text x="${lx.toFixed(1)}" y="${Math.max(14, last[1] - 10).toFixed(1)}" text-anchor="middle" font-size="12.5" font-weight="500" font-family="var(--font-ui)" fill="var(--text)">${lastLabel}</text>` : ""}
  ${xAxisEnds(n, { h, plotL, plotR, pad, label: opts.xLabel || (n + " 天") })}
  </svg>`;
}

function barChart(values, opts = {}) {
  const plotH = opts.h || 170;
  const xPad = 16;
  const w = opts.w || 640, h = plotH + xPad;
  const axisW = opts.axisW ?? 44, pad = 8;
  const plotL = axisW + pad, plotR = w - pad;
  const topPad = 34, botPad = 8;
  const top = topPad, bottom = plotH - botPad;
  const fill = opts.fill || "rgba(83,125,150,0.55)";
  const format = opts.format;
  const fmtTip = opts.tipFormat || format || ((v) => String(Math.round(v)));
  const n = values.length;
  if (n === 0) return `<svg viewBox="0 0 ${w} ${h}" role="img" xmlns="http://www.w3.org/2000/svg"><text x="${w/2}" y="${h/2}" text-anchor="middle" font-size="12" fill="var(--text-muted)">暂无数据</text></svg>`;
  const rawMax = Math.max(...values);
  const max = opts.yMax || (rawMax <= 0 ? 1 : rawMax * 1.08);
  const slot = (plotR - plotL) / n;
  const bw = Math.max(2, Math.min(12, slot * 0.62));
  let bars = "";
  let maxIdx = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v > values[maxIdx]) maxIdx = i;
    const bh = Math.max(v <= 0 ? 0.5 : (v / max) * (bottom - top), 0.5);
    const x = plotL + i * slot + (slot - bw) / 2;
    const y = bottom - bh;
    bars += `<rect class="si-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${fill}"><title>${esc(fmtTip(v))}</title></rect>`;
  }
  const mx = plotL + maxIdx * slot + slot / 2;
  const my = bottom - (values[maxIdx] / max) * (bottom - top);
  const maxLabel = format ? esc(format(values[maxIdx])) : "";
  const labelX = Math.max(axisW + 24, Math.min(mx, plotR - 24));
  return `<svg viewBox="0 0 ${w} ${h}" role="img" xmlns="http://www.w3.org/2000/svg">
  ${yAxis(values, { h: plotH, axisW, plotL, plotR, topPad, botPad, yMax: opts.yMax, format, n: opts.ticks || 3 })}
  ${bars}
  ${maxLabel ? `<text x="${labelX.toFixed(1)}" y="${(my - 4).toFixed(1)}" text-anchor="middle" font-size="12.5" font-weight="500" font-family="var(--font-ui)" fill="var(--accent)">${maxLabel}</text>` : ""}
  ${xAxisEnds(n, { h, plotL, plotR, pad, label: opts.xLabel })}
  </svg>`;
}


// 消耗趋势：堆叠柱（按来源类型，左轴 token）+ 命中率折线（右轴 0-100%），参照 token-tracker
function stackedComboChart(rows, lineValues, opts = {}) {
  const plotH = opts.h || 190;
  const xPad = 24;
  const w = opts.w || 640, h = plotH + xPad;
  const axisW = opts.axisW ?? 52, pad = 8;
  const rightW = opts.rightAxisW ?? 42;
  const plotL = axisW + pad, plotR = w - pad - rightW;
  const top = 12, bottom = plotH - 10;
  const keys = opts.keys || [];
  const keyLabels = opts.keyLabels || keys;
  const colors = opts.colors || [];
  const format = opts.format;
  const fmtTip = opts.tipFormat || format || ((v) => String(Math.round(v)));
  const n = rows.length;
  if (n === 0) return `<svg viewBox="0 0 ${w} ${h}" role="img" xmlns="http://www.w3.org/2000/svg"><text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-size="13" fill="var(--text-muted)">暂无数据</text></svg>`;
  const sums = rows.map((r) => keys.reduce((s, k) => s + (r[k] || 0), 0));
  const rawMax = Math.max(...sums, 0);
  const max = opts.yMax || (rawMax <= 0 ? 1 : rawMax * 1.08);
  const slot = (plotR - plotL) / n;
  const bw = Math.max(3, Math.min(26, slot * 0.62));
  let bars = "";
  for (let i = 0; i < n; i++) {
    let yBottom = bottom;
    for (let k = 0; k < keys.length; k++) {
      const v = rows[i][keys[k]] || 0;
      if (v <= 0) continue;
      const bh = (v / max) * (bottom - top);
      const y = yBottom - bh;
      const x = plotL + i * slot + (slot - bw) / 2;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${colors[k % colors.length]}"/>`;
      yBottom = y;
    }
  }
  const points = lineValues.map((v, i) =>
    v == null || !Number.isFinite(v) ? null : [plotL + i * slot + slot / 2, bottom - (Math.max(0, Math.min(100, v)) / 100) * (bottom - top)]
  );
  let path = "", started = false;
  for (const p of points) {
    if (!p) { started = false; continue; }
    path += `${started ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    started = true;
  }
  const dots = points.filter(Boolean).map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.2" fill="${opts.stroke || "var(--green)"}"/>`).join("");
  const rightTicks = [0, 50, 100]
    .map((pct) => `<text x="${(plotR + rightW / 2 + 2).toFixed(1)}" y="${(bottom - (pct / 100) * (bottom - top) + 4).toFixed(1)}" text-anchor="middle" font-size="${(opts.fontSize || 12) - 1}" font-family="var(--font-ui)" fill="var(--text-muted)">${pct}%</text>`)
    .join("");
  const colTips = rows
    .map((row, i) => {
      const lines = [opts.colLabels?.[i] || ""]
        .concat(keys.filter((k) => (row[k] || 0) > 0).map((k) => `${keyLabels[keys.indexOf(k)] || k}: ${fmtTip(row[k])}`))
        .concat(lineValues[i] == null ? [] : [`缓存命中率: ${lineValues[i].toFixed(1)}%`])
        .filter(Boolean);
      return `<rect x="${(plotL + i * slot).toFixed(1)}" y="${top}" width="${slot.toFixed(1)}" height="${(bottom - top).toFixed(1)}" fill="transparent"><title>${esc(lines.join("\n"))}</title></rect>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}" role="img" xmlns="http://www.w3.org/2000/svg">
  ${yAxis(sums, { h: plotH, axisW, plotL, plotR, topPad: top, botPad: plotH - bottom, yMax: opts.yMax, format, n: opts.ticks || 3, fontSize: opts.fontSize })}
  ${bars}
  ${path ? `<path d="${path}" fill="none" stroke="${opts.stroke || "var(--green)"}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : ""}
  ${dots}
  ${rightTicks}
  ${colTips}
  ${opts.xLabels ? xAxisLabels(n, { h, plotL, plotR, labels: opts.xLabels, every: opts.xEvery || 1, fontSize: opts.fontSize, centerEnds: opts.centerEnds }) : xAxisEnds(n, { h, plotL, plotR, pad, label: opts.xLabel })}
  </svg>`;
}

// 图表顶部图例（HTML，照 token-tracker）
function chartLegend(keys, keyLabels, colors, lineLabel) {
  return `<div class="ct-legend">` +
    keys.map((k, i) => `<span><i style="background:${colors[i % colors.length]}"></i>${esc(keyLabels[i] || k)}</span>`).join("") +
    (lineLabel ? `<span><i class="ct-line" style="background:var(--green)"></i>${esc(lineLabel)}</span>` : "") +
    `</div>`;
}

/* 来源类型：水平堆叠条 + 图例（参照 token-tracker 的 source-bar） */
function sourceBar(rows, total) {
  const sum = total > 0 ? total : rows.reduce((s, r) => s + (r.totalTokens || 0), 0) || 1;
  const segs = rows.map((r, i) => ({
    label: TYPE_LABELS[r.type] || r.type,
    value: r.totalTokens || 0,
    calls: r.calls || 0,
    color: PIE_COLORS[i % PIE_COLORS.length],
  }));
  const pctOf = (v) => (v / sum) * 100;
  const track = segs
    .map((s) => `<div class="sb-seg" style="width:${pctOf(s.value).toFixed(2)}%;background:${s.color}" title="${esc(s.label)}：${esc(fmtTokens(s.value))} (${pctOf(s.value).toFixed(1)}%)"></div>`)
    .join("");
  const legend = segs
    .map((s) => `<span class="sb-item"><i class="sb-dot" style="background:${s.color}"></i>${esc(s.label)} <b>${esc(fmtTokens(s.value))}</b> (${pctOf(s.value).toFixed(1)}%)${s.calls ? " · " + s.calls + " 次" : ""}</span>`)
    .join("");
  return `<div class="sb-track">${track}</div><div class="sb-legend">${legend}</div>`;
}

/* ── 格式化 ── */

function fmtTokens(n) {
  if (n == null) return "–";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return "–";
  return n.toFixed(2) + "%";
}

function fmtDuration(min) {
  if (min == null || min < 0) return "–";
  if (min < 60) return min + " 分";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? h + " 时 " + m + " 分" : h + " 小时";
}

function fmtByKind(v, kind) {
  if (kind === "tokens") return fmtTokens(v);
  if (kind === "pct") return v.toFixed(2) + "%";
  if (kind === "dur") return fmtDuration(v);
  if (kind === "tps") return String(Math.round(v));
  return String(Math.round(v));
}

function renderOdometer(el, to, kind, silent) {
  // 纯文本渲染：数字与单位字母走同一字体流，避免逐位 span 造成的小数点脱钩与字形差异
  const str = fmtByKind(to, kind);
  if (el.textContent === str) return;
  el.textContent = str;
  if (silent) return; // 静默刷新：直接赋值，不播上滑动画
  el.classList.remove("hmv-pop");
  void el.offsetWidth;
  el.classList.add("hmv-pop");
}

function animateNumbers(rootEl, silent = false) {
  if (!rootEl) return;
  const els = rootEl.querySelectorAll(".cnt");
  els.forEach((el) => {
    const to = parseFloat(el.dataset.to || "0") || 0;
    const kind = el.dataset.kind || "int";
    renderOdometer(el, to, kind, silent);
  });
}

function pieChart(segments, opts = {}) {
  const size = opts.size || 110;
  const cx = size / 2, cy = size / 2;
  const r = opts.r || size / 2 - 4;
  const total = segments.reduce((s, x) => s + (x.v || 0), 0) || 1;
  if (segments.length === 1) {
    return `<svg viewBox="0 0 ${size} ${size}" role="img" xmlns="http://www.w3.org/2000/svg"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${segments[0].color}"/></svg>`;
  }
  let ang = -90;
  let idx = 0;
  let paths = "";
  for (const seg of segments) {
    if (!seg.v || seg.v <= 0) continue;
    const frac = seg.v / total;
    const a1 = ang, a2 = ang + frac * 360;
    const rad = (a) => (a * Math.PI) / 180;
    const x1 = cx + r * Math.cos(rad(a1));
    const y1 = cy + r * Math.sin(rad(a1));
    const x2 = cx + r * Math.cos(rad(a2));
    const y2 = cy + r * Math.sin(rad(a2));
    const large = frac > 0.5 ? 1 : 0;
    paths += `<path class="si-sect-path" pathLength="1" style="animation-delay:${(idx * 0.12).toFixed(2)}s" d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${seg.color}" stroke="var(--bg-card)" stroke-width="1"/>`;
    ang = a2;
    idx++;
  }
  return `<svg viewBox="0 0 ${size} ${size}" role="img" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
}

function donutChart(segments, opts = {}) {
  const size = opts.size || 150;
  const r = opts.r || 54;
  const sw = opts.sw || 16;
  const cx = size / 2, cy = size / 2;
  const center = opts.center || "";
  const sub = opts.sub || "";
  const total = segments.reduce((s, x) => s + (x.v || 0), 0) || 1;
  const C = 2 * Math.PI * r;
  let offset = 0;
  let idx = 0;
  let arcs = "";
  for (const seg of segments) {
    if (!seg.v || seg.v <= 0) continue;
    const len = (seg.v / total) * C;
    arcs += `<circle class="si-sect" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${seg.color}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-offset + C).toFixed(2)}" style="--si-sweep-to:${(-offset).toFixed(2)};animation-delay:${(idx * 0.12).toFixed(2)}s"/>`;
    offset += len;
    idx++;
  }
  return `<svg viewBox="0 0 ${size} ${size}" role="img" xmlns="http://www.w3.org/2000/svg" style="transform:rotate(-90deg)">
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="color-mix(in srgb, var(--text, #3b3d3f) 7%, transparent)" stroke-width="${sw}"/>
  ${arcs}
  </svg>` +
  `<div class="ua-donut-center"><span class="udc-v">${center}</span>${sub ? `<span class="udc-s">${sub}</span>` : ""}</div>`;
}

/* ── 数据获取（usage-hub 聚合接口） ── */

async function fetchJson(path, init = {}) {
  const res = await hana.api.fetch(path, { ...init, signal: AbortSignal.timeout(15000) });
  // 带上路径与状态码，接口 404/500 时用户能直接看出是哪个接口出问题
  if (!res.ok) throw new Error(`HTTP ${res.status} · ${path}`);
  return res.json();
}
// 探测宿主焦点会话，并带回探测过程信息（供 widget 降级态展示诊断）
async function discoverFocusedSession() {
  const probe = { httpStatus: null, origin: window.location.origin, entryId: "", file: "", error: "" };
  try {
    const token = new URLSearchParams(window.location.search).get("token");
    const url = new URL("/api/sessions/messages", window.location.origin);
    url.searchParams.set("limit", "5"); if (token) url.searchParams.set("token", token);
    const res = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(5000) });
    probe.httpStatus = res.status;
    if (!res.ok) return { focus: null, probe };
    const payload = await res.json();
    const messages = Array.isArray(payload) ? payload : (payload.messages || payload.items || payload.entries || []);
    const entry = messages.filter((item) => item?.entryId || item?.id).at(-1);
    const entryId = entry?.entryId || entry?.id;
    probe.entryId = entryId || "";
    if (!entryId) return { focus: null, probe };
    const mapped = await fetchJson("/api/resolve-entry?entryId=" + encodeURIComponent(entryId));
    probe.file = mapped?.file || "";
    return { focus: mapped?.file ? { file: mapped.file, agent: mapped.agent || "" } : null, probe };
  } catch (err) {
    probe.error = String(err?.message || err);
    return { focus: null, probe };
  }
}

const getSummary = (q = "") => fetchJson("/api/summary" + q);
const getDaily = (q = "") => fetchJson("/api/daily" + q);
const getHourly = (day = "", q = "") => fetchJson((day ? "/api/hourly?day=" + encodeURIComponent(day) + q.slice(1).split("&").filter(Boolean).map((kv) => "&" + kv).join("") : "/api/hourly" + q));
const getByAgent = (q = "") => fetchJson("/api/by-agent" + q);
const getByModel = (q = "") => fetchJson("/api/by-model" + q);
const getByProvider = (q = "") => fetchJson("/api/by-provider" + q);
const getByType = (q = "") => fetchJson("/api/by-type" + q);
const getStatus = () => fetchJson("/api/status");
const getSettings = () => fetchJson("/api/settings");
const getBalance = () => fetchJson("/api/balance");
const getForecast = () => fetchJson("/api/forecast");
const getSpeed = (q = "") => fetchJson("/api/speed" + q);
const getSessionTitles = () => fetchJson("/api/session-titles");
const getCurrentSession = (focus = undefined) => {
  const query = new URLSearchParams();
  if (focus === null) query.set("noFocusedSession", "1");
  if (focus?.sessionId) query.set("sessionId", focus.sessionId);
  if (focus?.agent) query.set("agent", focus.agent);
  if (focus?.file) query.set("file", focus.file);
  const suffix = query.toString();
  return fetchJson("/api/current-session" + (suffix ? "?" + suffix : ""));
};
const postJson = (path, body) => fetchJson(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
// 与数据层一致的 Asia/Shanghai 今日
function cnToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}
function presetRange(preset) {
  const today = cnToday();
  const d = new Date(`${today}T00:00:00+08:00`);
  const shift = (n) => { const copy = new Date(d); copy.setUTCDate(copy.getUTCDate() + n); return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(copy); };
  if (preset === "today") return { from: today, to: today };
  if (preset === "yesterday") { const day = shift(-1); return { from: day, to: day }; }
  if (preset === "month") return { from: today.slice(0, 8) + "01", to: today };
  if (preset === "year") return { from: today.slice(0, 4) + "-01-01", to: today };
  const [y, m, dd] = today.split("-").map(Number);
  const mondayOffset = (new Date(Date.UTC(y, m - 1, dd)).getUTCDay() + 6) % 7;
  const monday = shift(-mondayOffset);
  return { from: monday, to: today };
}

/* ── 通用放大模态 ── */

function openModal(title, bodyHtml) {
  const modal = document.createElement("div");
  modal.className = "si-modal";
  modal.innerHTML =
    `<div class="si-modal-bg"></div>` +
    `<div class="si-modal-card glass">` +
    `<div class="si-modal-head"><h3>${esc(title)}</h3><button type="button" class="si-modal-close" title="关闭">×</button></div>` +
    `<div class="si-modal-body">${bodyHtml}</div>` +
    `</div>`;
  document.body.appendChild(modal);
  requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add("open")));
  const close = () => {
    modal.classList.remove("open");
    modal.classList.add("closing");
    setTimeout(() => modal.remove(), 220);
    document.removeEventListener("keydown", escHandler);
  };
  const escHandler = (e) => {
    if (e.key === "Escape") close();
  };
  modal.addEventListener("click", (e) => {
    if (e.target.closest(".si-modal-close") || e.target.classList.contains("si-modal-bg")) close();
  });
  document.addEventListener("keydown", escHandler);
}

/* ── 共享状态 ── */

const state = {
  summary: null,
  daily: [],
  hourly: [],
  byAgent: [],
  byModel: [],
  byProvider: [],
  byType: [],
  status: null,
  forecast: null,
  builtAt: null,
  loading: false,
  // 筛选（与聚合接口参数一致：from/to/agent/model/provider/type）
  filters: { from: cnToday(), to: cnToday(), preset: "today", agent: "", model: "", provider: "", type: "" },
  // 选项池：首次全量加载快照，筛选后不变（避免选项随筛选缩水）
  options: { agents: [], models: [], providers: [] },
  settings: null,
  balance: null,
  speed: null,
  speedScanning: false,
  speedRetryTimer: null,
  degraded: null,
  balanceSource: "",
  quotaSource: "",
  balanceInitialRefreshAttempted: false,
};

function buildQuery(filters) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters || {})) {
    if (v) p.set(k, v);
  }
  const q = p.toString();
  return q ? "?" + q : "";
}

// 插件资源版本（从自身模块 URL 的 usage_hub_v 读取）；版本变化时旧快照自动失效
const UI_VERSION = (() => {
  try { return new URL(import.meta.url).searchParams.get("usage_hub_v") || ""; } catch { return ""; }
})();

/* ── 本地快照（首屏无感渲染） ── */
const SNAPSHOT_KEY = "usage-hub-snapshot";
const MAX_SNAPSHOT_BYTES = 1024 * 1024;

// 只打包渲染所需数据；不含会话原文
function buildSnapshot(state, version, savedAt) {
  return {
    version,
    savedAt,
    filters: { ...(state.filters || {}) },
    data: {
      summary: state.summary || null,
      daily: state.daily || [],
      hourly: state.hourly || [],
      byType: state.byType || [],
      byAgent: state.byAgent || [],
      byModel: state.byModel || [],
      speed: state.speed || null,
      forecast: state.forecast || null,
    },
  };
}

// 序列化；超过 MAX_SNAPSHOT_BYTES 返回 null（跳过写入）
function snapshotRaw(snapshot) {
  let raw;
  try { raw = JSON.stringify(snapshot); } catch { return null; }
  let bytes = raw.length;
  try { bytes = new TextEncoder().encode(raw).length; } catch {}
  return bytes > MAX_SNAPSHOT_BYTES ? null : raw;
}

// 解析；版本不符/结构非法/JSON 损坏返回 null
function parseSnapshot(raw, expectedVersion) {
  try {
    const snap = JSON.parse(raw);
    if (!snap || typeof snap !== "object" || !snap.data || snap.version !== expectedVersion) return null;
    return snap;
  } catch { return null; }
}

function saveSnapshot(storage, state, version, savedAt) {
  try {
    const raw = snapshotRaw(buildSnapshot(state, version, savedAt ?? Date.now()));
    if (!raw) return false;
    storage.setItem(SNAPSHOT_KEY, raw);
    return true;
  } catch { return false; }
}

// 读取；筛选条件不一致时不用旧快照覆盖新数据
function loadSnapshot(storage, version, filters) {
  try {
    const raw = storage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const snap = parseSnapshot(raw, version);
    if (!snap) return null;
    if (filters && JSON.stringify(snap.filters) !== JSON.stringify(filters)) return null;
    return snap;
  } catch { return null; }
}
/* ── /本地快照 ── */

function applySnapshot(snap) {
  const d = snap.data || {};
  state.summary = d.summary || null;
  state.daily = d.daily || [];
  state.hourly = d.hourly || [];
  state.byType = d.byType || [];
  state.byAgent = d.byAgent || [];
  state.byModel = d.byModel || [];
  state.speed = d.speed || null;
  state.forecast = d.forecast || null;
  state.options.agents = [...new Set((state.byAgent || []).map((r) => r.agentId).filter(Boolean))];
  state.options.models = [...new Set((state.byModel || []).map((r) => r.modelId).filter(Boolean))];
  state.options.providers = (state.speed?.byProvider || []).map((r) => r.provider).filter(Boolean);
}

function renderSnapshotAge(savedAt) {
  const el = document.getElementById("snapshotAge");
  if (!el) return;
  if (!savedAt) { el.textContent = ""; return; }
  el.textContent = `上次更新 · ${timeAgo(new Date(savedAt).toISOString())}`;
}

async function loadAllData() {
  const q = buildQuery(state.filters);
  const [summary, daily, byAgent, byModel, byProvider, byType, status, settings, balance, forecast, titles, speed] = await Promise.all([
    getSummary(q),
    getDaily(q),
    getByAgent(q),
    getByModel(q),
    getByProvider(q),
    getByType(q),
    getStatus().catch(() => null),
    getSettings().catch(() => null),
    getBalance().catch(() => null),
    getForecast().catch(() => null),
    state.sessionTitles ? Promise.resolve(null) : getSessionTitles().catch(() => null),
    getSpeed(q).catch(() => null),
  ]);
  const dailyRows = daily.daily || [];
  const hourly = dailyRows.length < 3 ? await getHourly("", q) : { hourly: [] };
  state.summary = summary;
  state.degraded = summary.degraded || null;
  state.daily = dailyRows;
  state.hourly = flattenHourlySeries(hourly.hourly || {}, state.filters.from);
  state.hourlyBySession = hourly.hourlyBySession || null;
  if (titles?.titles) state.sessionTitles = titles.titles;
  state.byAgent = byAgent.rows || [];
  state.byModel = byModel.rows || [];
  state.byProvider = byProvider.rows || [];
  state.byType = byType.rows || [];
  state.status = status;
  state.forecast = forecast?.forecast || null;
  state.settings = settings;
  state.balance = balance;
  state.speed = speed?.speed || null;
  state.speedScanning = Boolean(speed?.scanning);
  // 首次加载只在启用余额且 GET 没有快照时主动刷新一次，避免 renderAll/定时器循环触发。
  if (!state.balanceInitialRefreshAttempted && settings?.balance?.enabled !== false && (!balance || (balance.cached === false && !(balance.sources || []).length))) {
    state.balanceInitialRefreshAttempted = true;
    state.balance = await fetchJson("/api/balance/refresh", { method: "POST" }).catch(() => state.balance);
  }
  state.builtAt = summary.builtAt || null;
  // 首次全量（无筛选）时填选项池
  if (!q || !state.options.agents.length) {
    state.options.agents = [...new Set([...(byAgent.rows || []).map((r) => r.agentId).filter(Boolean), ...(settings?.display?.hiddenAgents || [])])];
    state.options.models = [...new Set([...(byModel.rows || []).map((r) => r.modelId).filter(Boolean), ...(settings?.display?.hiddenModels || [])])];
    state.options.providers = (byProvider.rows || []).map((r) => r.provider).filter(Boolean);
  }
}

/* ── 常量与颜色 ── */

const TYPE_LABELS = { session: "会话", subagent: "子代理", memory: "记忆", automation: "自动化", utility: "实用", compaction: "压缩", vision: "视觉", other: "其他" };
const TYPE_COLORS = {
  session: "var(--chart-bar-chat, var(--text, #3A3D42))",
  subagent: "#10b981",
  automation: "#f59e0b",
  memory: "#ec4899",
  utility: "var(--chart-bar-channel, #C9A34B)",
  compaction: "#8b5cf6",
  vision: "#5BA0B0",
  other: "rgba(143,134,123,0.7)",
};
const PIE_COLORS = ["rgba(83,125,150,0.8)", "rgba(157,95,77,0.75)", "rgba(74,107,74,0.8)", "rgba(167,139,250,0.75)", "rgba(143,134,123,0.7)", "rgba(27,54,93,0.75)", "rgba(196,150,60,0.75)"];

function focusFromHostPayload(payload) {
  const value = payload?.session || payload?.focusedSession || payload?.context || payload || {};
  const sessionId = value.sessionId || value.id || "";
  const agent = value.agent || value.agentId || "";
  const rawFile = value.file || value.path || value.sessionPath || "";
  const file = typeof rawFile === "string" && rawFile.trim() ? rawFile.trim().replaceAll("\\\\", "/").split("/").pop() : "";
  if (!sessionId && !file) return null;
  return { sessionId: String(sessionId || file.replace(/\\.jsonl$/i, "")), agent: String(agent || ""), file };
}
function focusKey(focus) { return focus ? `${focus.agent}\u0000${focus.sessionId}\u0000${focus.file}` : ""; }

/* ── widget ── */

async function renderWidget() {
  if (!root) return;
  root.innerHTML = `
    <div class="panel widget-panel">
      <section class="widget-card">
        <header class="w-head">
          <div class="w-identity">
            <span class="dot" id="dot"></span>
            <div class="w-id-copy">
              <div class="w-title">用量中心</div>
              <div class="model" id="model">加载中…</div>
            </div>
          </div>
          <span class="w-turns" id="wTurns">– 次</span>
        </header>

        <div class="w-overview">
          <div class="w-ring" id="wRing">
            <svg viewBox="0 0 100 100" aria-hidden="true">
              <circle class="w-ring-track" cx="50" cy="50" r="42"></circle>
              <circle class="w-ring-progress" id="wRingProgress" cx="50" cy="50" r="42" pathLength="100"></circle>
            </svg>
            <div class="w-ring-core">
              <strong id="wHitPct">–</strong>
              <span>命中率</span>
            </div>
          </div>
          <div class="w-ov-stats">
            <div class="w-ov-row"><span>总消耗</span><b id="wTotalTokens">–</b></div>
            <div class="w-ov-row"><span>缓存命中</span><b id="wCacheRead">–</b></div>
          </div>
        </div>

        <div class="w-composition">
          <div class="w-section-head"><span>输入构成（未命中 / 缓存 / 输出 / 推理）</span></div>
          <div class="w-comp-track" id="wCompTrack"><i class="input"></i><i class="cache"></i><i class="output"></i><i class="reasoning"></i></div>
          <div class="w-legend"><span><i class="input"></i>未命中</span><span><i class="cache"></i>缓存命中</span><span><i class="output"></i>输出</span><span><i class="reasoning"></i>推理</span></div>
          <div class="w-context-note" id="wComposeNote">–</div>
        </div>

        <div class="w-grid" id="metrics">
          <div class="w-metric"><span>未命中输入</span><b id="wUncached">–</b></div>
          <div class="w-metric"><span>输出</span><b id="wOutput">–</b></div>
          <div class="w-metric"><span>推理</span><b id="wReasoning">–</b></div>
          <div class="w-metric"><span>上下文占用</span><b id="wDays">–</b></div>
        </div>

        <div class="w-context">
          <div class="w-section-head"><span>上下文窗口</span><b id="wContextText">– / –</b></div>
          <div class="w-ctx-track"><div class="w-ctx-fill" id="wContextFill"></div><div class="w-ctx-threshold" id="wContextThreshold"></div></div>
          <div class="w-context-note" id="wContextNote">压缩阈值 80%</div>
        </div>

        <div class="w-context">
          <div class="w-section-head"><span>本会话供应商</span></div>
          <div class="w-provider-list" id="wTypeList"></div>
        </div>

        <div class="w-context">
          <div class="w-section-head"><span>当前会话模型速率</span></div>
          <div class="w-speed-list" id="wSpeedModel">–</div>
        </div>
        <div class="w-error" id="meta"></div>
      </section>
    </div>`;

  const dot = document.getElementById("dot");
  const modelEl = document.getElementById("model");
  const metaEl = document.getElementById("meta");
  const ringProgressEl = document.getElementById("wRingProgress");
  const hitPctEl = document.getElementById("wHitPct");
  const turnsEl = document.getElementById("wTurns");
  const totalEl = document.getElementById("wTotalTokens");
  const cacheEl = document.getElementById("wCacheRead");
  const uncachedEl = document.getElementById("wUncached");
  const outputEl = document.getElementById("wOutput");
  const reasoningEl = document.getElementById("wReasoning");
  const daysEl = document.getElementById("wDays");
  const typeCountEl = document.getElementById("wTypeCount");
  const contextTextEl = document.getElementById("wContextText");
  const contextFillEl = document.getElementById("wContextFill");
  const contextThresholdEl = document.getElementById("wContextThreshold");
  const typeListEl = document.getElementById("wTypeList");
  const contextStateEl = document.getElementById("wContextState");
  const composeNoteEl = document.getElementById("wComposeNote");
  const segs = {
    input: document.querySelector("#wCompTrack i.input"),
    cache: document.querySelector("#wCompTrack i.cache"),
    output: document.querySelector("#wCompTrack i.output"),
    reasoning: document.querySelector("#wCompTrack i.reasoning"),
  };

  let requestVersion = 0;
  let currentFocus;
  let currentFocusKey = "";

  // 当前会话模型速率（卡片式）：按会话内每个模型分别展示；无会话模型时退回当天 byModel
  function renderWidgetModelSpeed(models, byModel) {
    const el = document.getElementById("wSpeedModel");
    if (!el) return;
    const rows = widgetSpeedRows(models, byModel);
    if (!rows.length) { el.innerHTML = `<span class="w-speed-val">–</span>`; return; }
    el.innerHTML = rows.map((r) => `<div class="w-speed-cell" title="Σ输出 token ÷ Σ间隔（含工具调用等待与网络排队）"><span class="w-speed-name" title="${esc(r.model)}">${esc(r.model)}</span><span class="w-speed-val">${r.tps == null ? "–" : r.tps + " tok/s"}</span></div>`).join("");
  }

  // 无当前会话时降级：展示今日概览（总消耗/次数/命中率/今日端到端速率）
  async function renderWidgetTodayOverview(reason, todaySpeed, probe, source) {
    const today = cnToday();
    const summary = await fetchJson(`/api/summary?from=${today}&to=${today}`).catch(() => null);
    const s = summary?.summary || null;
    document.querySelector(".w-title").textContent = "今日概览";
    const reasonText = widgetReasonText(reason);
    const sourceNote = source === "latest-session" ? "按最近活跃会话推断" : (source && source !== "none" ? `来源 ${source}` : "");
    const probeLine = probe ? `探测：HTTP ${probe.httpStatus ?? "–"} · entryId ${probe.entryId ? "有" : "无"} · origin ${probe.origin || "–"}` : "";
    const metaText = [reasonText, sourceNote, probeLine].filter(Boolean).join(" · ");
    const probeTitle = probe
      ? `宿主 /api/sessions/messages：HTTP ${probe.httpStatus ?? "–"} · origin ${probe.origin || "–"} · entryId ${probe.entryId ? "已获取" : "未获取"} · 解析文件 ${probe.file || "–"}${probe.error ? ` · ${probe.error}` : ""}`
      : "未执行宿主焦点探测";
    if (!s) {
      dot.className = "dot err";
      modelEl.textContent = "数据不可用";
      turnsEl.textContent = "– 次";
      metaEl.textContent = metaText;
      metaEl.title = probeTitle;
      return;
    }
    const total = s.totalTokens || 0;
    const unc = s.uncached || 0;
    const ca = s.cacheRead || 0;
    const ou = s.output || 0;
    const re = s.reasoning || 0;
    const compTotal = unc + ca + ou + re || 1;
    const tps = todaySpeed?.speed?.tps;
    dot.className = "dot";
    modelEl.textContent = tps == null ? "今日端到端速率 –" : `今日端到端速率 ${tps} tok/s`;
    turnsEl.textContent = `${s.calls || 0} 次`;
    const pct = Math.max(0, Math.min(100, (s.hitRatio ?? 0) * 100));
    ringProgressEl.style.strokeDasharray = `${pct} ${100 - pct}`;
    hitPctEl.textContent = fmtPct(pct);
    totalEl.textContent = fmtTokens(total);
    cacheEl.textContent = fmtTokens(ca);
    uncachedEl.textContent = fmtTokens(unc);
    outputEl.textContent = fmtTokens(ou);
    reasoningEl.textContent = fmtTokens(re);
    segs.input.style.width = (unc / compTotal) * 100 + "%";
    segs.cache.style.width = (ca / compTotal) * 100 + "%";
    segs.output.style.width = (ou / compTotal) * 100 + "%";
    segs.reasoning.style.width = (re / compTotal) * 100 + "%";
    composeNoteEl.textContent = `未命中 ${fmtTokens(unc)} · 缓存 ${fmtTokens(ca)} · 输出 ${fmtTokens(ou)} · 推理 ${fmtTokens(re)}`;
    if (contextTextEl) contextTextEl.textContent = "– / –";
    if (contextFillEl) contextFillEl.style.width = "0%";
    if (daysEl) { daysEl.textContent = "–"; daysEl.title = ""; }
    if (typeListEl) typeListEl.innerHTML = `<div class="empty">无当前会话</div>`;
    metaEl.textContent = metaText;
    metaEl.title = probeTitle;
    dot.classList.remove("pulse");
    void dot.offsetWidth;
    dot.classList.add("pulse");
  }

  async function tick(focus = currentFocus) {
    const version = ++requestVersion;
    try {
      let resolvedFocus = focus;
      let probe = null;
      if (focus === undefined) {
        const discovered = await discoverFocusedSession();
        resolvedFocus = discovered.focus;
        probe = discovered.probe;
      }
      if (version !== requestVersion) return;
      const today = cnToday();
      const [current, todaySpeed] = await Promise.all([
        getCurrentSession(resolvedFocus),
        fetchJson(`/api/speed?from=${today}&to=${today}`).catch(() => null),
      ]);
      if (version !== requestVersion) return;
      const d = current?.session;
      const s = d ? { totalTokens: d.totalTokens, calls: d.turnCount, hitRatio: d.hitRatio, cacheRead: d.cacheReadTokens, uncached: d.inputTokens, output: d.outputTokens, reasoning: (d.turns || []).reduce((sum, turn) => sum + (turn.reasoningTokens || 0), 0) } : null;
      if (!s) {
        renderWidgetModelSpeed([], todaySpeed?.speed?.byModel);
        await renderWidgetTodayOverview(current?.reason, todaySpeed, probe, current?.source);
        return;
      }
      document.querySelector(".w-title").textContent = d.title || "当前会话";
      const total = s.totalTokens || 0;
      const unc = s.uncached || 0;
      const ca = s.cacheRead || 0;
      const ou = s.output || 0;
      const re = s.reasoning || 0;
      const compTotal = unc + ca + ou + re || 1;

      dot.className = "dot";
      modelEl.textContent = d.model || "未知模型";
      turnsEl.textContent = `${s.calls || 0} 次`;

      const pct = Math.max(0, Math.min(100, (s.hitRatio ?? 0) * 100));
      ringProgressEl.style.strokeDasharray = `${pct} ${100 - pct}`;
      hitPctEl.textContent = fmtPct(pct);

      totalEl.textContent = fmtTokens(total);
      cacheEl.textContent = fmtTokens(ca);
      uncachedEl.textContent = fmtTokens(unc);
      outputEl.textContent = fmtTokens(ou);
      reasoningEl.textContent = fmtTokens(re);

      segs.input.style.width = (unc / compTotal) * 100 + "%";
      segs.cache.style.width = (ca / compTotal) * 100 + "%";
      segs.output.style.width = (ou / compTotal) * 100 + "%";
      segs.reasoning.style.width = (re / compTotal) * 100 + "%";
      composeNoteEl.textContent = `未命中 ${fmtTokens(unc)} · 缓存 ${fmtTokens(ca)} · 输出 ${fmtTokens(ou)} · 推理 ${fmtTokens(re)}`;

      const types = (() => {
        const map = new Map();
        for (const turn of d.turns || []) {
          const key = turn.provider || "unknown";
          const cur = map.get(key) || { type: key, totalTokens: 0, calls: 0, cacheRead: 0, uncached: 0 };
          cur.totalTokens += turn.totalTokens || 0;
          cur.calls += 1;
          cur.cacheRead += turn.cacheReadTokens || 0;
          cur.uncached += turn.inputTokens || 0;
          map.set(key, cur);
        }
        return [...map.values()]
          .map((x) => ({ ...x, hitRatio: x.cacheRead + x.uncached > 0 ? x.cacheRead / (x.cacheRead + x.uncached) : null }))
          .sort((a, b) => b.totalTokens - a.totalTokens);
      })();
      // 上下文窗口：窗口大小取自模型常量表（缺失回退 1M），占用取最近一轮 input + cacheRead
      const lastTurn = (d.turns || []).at(-1);
      const lastWindowTokens = lastTurn ? (lastTurn.inputTokens || 0) + (lastTurn.cacheReadTokens || 0) : 0;
      const ctxWindow = CONTEXT_WINDOW[d.model] || 1_000_000;
      const ctxPct = ctxWindow > 0 ? Math.max(0, Math.min(100, (lastWindowTokens / ctxWindow) * 100)) : 0;
      if (daysEl) { daysEl.textContent = lastTurn ? ctxPct.toFixed(1) + "%" : "–"; daysEl.title = "最近一轮输入 + 缓存读取 ÷ 模型上下文窗口"; }
      const threshold = Math.round((d.compactThreshold ?? COMPACT_THRESHOLD) * 100);
      const remainToCompact = Math.max(0, ctxWindow * (d.compactThreshold ?? COMPACT_THRESHOLD) - lastWindowTokens);
      if (contextTextEl) contextTextEl.textContent = `${fmtTokens(lastWindowTokens)} / ${fmtTokens(ctxWindow)}`;
      if (contextFillEl) contextFillEl.style.width = ctxPct.toFixed(2) + "%";
      if (contextThresholdEl) contextThresholdEl.style.left = threshold + "%";
      if (contextStateEl) contextStateEl.textContent = `距压缩约 ${fmtTokens(remainToCompact)} · 阈值 ${threshold}%`;
      const typeTotal = types.reduce((sum, t) => sum + t.totalTokens, 0) || 1;
      if (typeListEl) typeListEl.innerHTML = types
        .sort((a, b) => b.totalTokens - a.totalTokens)
        .map((t) => {
          const share = Math.round((t.totalTokens / typeTotal) * 100);
          return `<div class="w-provider-row" title="${esc(providerLabel(t.type))}：${t.calls} 次">` +
            `<div class="w-provider-share"><svg viewBox="0 0 100 100" aria-hidden="true"><circle class="w-share-track" cx="50" cy="50" r="42"></circle><circle class="w-share-progress" cx="50" cy="50" r="42" pathLength="100" style="stroke-dasharray:${share} ${100 - Number(share)}"></circle></svg><span>${share}%</span></div>` +
            `<div class="w-provider-name"><strong>${esc(providerLabel(t.type))}</strong><span>${t.calls || 0} 次</span></div>` +
            `<div class="w-provider-values">` +
              `<div class="w-provider-stat"><span>总消耗</span><b>${fmtTokens(t.totalTokens || 0)}</b></div>` +
              `<div class="w-provider-stat"><span>命中率</span><b>${t.hitRatio == null ? "–" : fmtPct(t.hitRatio * 100)}</b></div>` +
            `</div>` +
            `</div>`;
        }).join("");
      const sessionModels = [...new Set((d.turns || []).map((turn) => turn.model).filter(Boolean))];
      const sessionSpeed = d.sessionId ? await fetchJson("/api/speed?sessionId=" + encodeURIComponent(d.sessionId)).catch(() => null) : null;
      renderWidgetModelSpeed(sessionModels, sessionSpeed?.speed?.byModel || todaySpeed?.speed?.byModel);
      metaEl.textContent = current?.source === "latest-session" ? "按最近活跃会话推断" : "";
      dot.classList.remove("pulse");
      void dot.offsetWidth;
      dot.classList.add("pulse");
    } catch (e) {
      dot.className = "dot err";
      modelEl.textContent = "数据不可用";
      metaEl.innerHTML = `<span class="err-text">${esc(e.message || e)}</span>`;
    }
  }

  await tick();
  const timer = setInterval(() => tick(), Math.max(10, Number(state.settings?.ui?.refreshSeconds || 60)) * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || !["hana.host.context", "hana.session.focused"].includes(event.data?.type)) return;
    currentFocus = focusFromHostPayload(event.data?.payload);
    currentFocusKey = focusKey(currentFocus);
    tick(currentFocus);
  });
  window.addEventListener("beforeunload", () => clearInterval(timer), { once: true });
}

/* ── page ── */

function flattenHourlySeries(hourly, fallbackDay = "") {
  if (Array.isArray(hourly)) return hourly.map((row) => ({ ...row, day: row.day || fallbackDay }));
  return Object.entries(hourly || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([day, rows]) => (Array.isArray(rows) ? rows : []).map((row) => ({ ...row, day })));
}

// 模型上下文窗口（缺失回退 1M），与 session-insight 同源口径
const CONTEXT_WINDOW = {
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v4-pro": 1_000_000,
  "mimo-v2.5": 1_000_000,
  "mimo-v2.5-pro": 1_000_000,
};
const COMPACT_THRESHOLD = 0.8;

// 供应商显示名
function providerLabel(id) {
  const map = { "openai-codex": "ChatGPT", codex: "ChatGPT", deepseek: "DeepSeek", "opencode-go": "OpenCode", "minimax-token-plan": "MiniMax", "llm-qwen": "Qwen 本地", gemini: "Gemini", anthropic: "Claude" };
  return map[id] || id || "未知";
}

// Agent 显示名：优先用宿主 agent:list 返回的中文名，缺失时回落 agentId
function agentLabel(id) {
  if (!id) return "–";
  return state.status?.agentNames?.[id] || id;
}
function rowLabel(row, key) {
  if (key === "agentId") return agentLabel(row.agentId);
  return TYPE_LABELS[row[key]] || row[key] || "–";
}

// 速率偏差说明（hero hover 与模型分布卡共用）
const SPEED_HINT = "按模型/单条的速率受消息间隔与工具调用密度影响，非模型纯生成速度，不宜跨模型直接比较。";

// widget 降级态：把 reason 转成可读文案
function widgetReasonText(reason) {
  if (reason === "no_focused_session") return "宿主未提供当前会话";
  if (reason === "focused_session_unavailable") return "会话文件读取失败";
  return reason ? String(reason) : "当前会话不可用";
}

// widget 模型速率卡片：按给定模型列表逐项取速率；列表为空时退回 byModel 全部
function widgetSpeedRows(models, byModel) {
  const list = [...new Set((models || []).filter(Boolean))];
  const rateOf = (model) => {
    const hit = (byModel || []).find((m) => m && m.model === model && m.tps != null);
    return hit ? hit.tps : null;
  };
  let rows = list.map((model) => ({ model, tps: rateOf(model) }));
  if (!rows.length) rows = (byModel || []).filter((m) => m && m.tps != null).map((m) => ({ model: m.model, tps: m.tps }));
  return rows;
}

function renderHero() {
  const el = document.getElementById("heroMetrics");
  if (!el) return;
  const s = state.summary?.summary || null;
  if (!s) {
    el.innerHTML = `<div class="empty">数据未就绪</div>`;
    return;
  }
  // 生成速度：加权口径（Σ输出 / Σ耗时），双来源（JSONL 相邻消息差 + ledger memory/utility）
  const speed = state.speed || null;
  const speedValue = speed && speed.tps != null ? speed.tps : null;
  const speedTip = speedValue != null
    ? "Σ输出 token ÷ Σ间隔（含工具调用等待与网络排队），过滤 100ms~10min。"
    : "暂无速率样本";
  const hms = [
    ["总消耗", s.totalTokens || 0, "tokens", "", ""],
    ["调用次数", s.calls || 0, "int", "", ""],
    ["命中率", (s.hitRatio ?? 0) * 100, "pct", "", ""],
    ["缓存命中", s.cacheRead || 0, "tokens", "", ""],
    ["未命中输入", s.uncached || 0, "tokens", "", ""],
    ["输出", s.output || 0, "tokens", "", ""],
    ["推理", s.reasoning || 0, "tokens", "", ""],
    ["Token 平均速率", speedValue, "tps", "", speedTip],
  ];
  el.innerHTML = hms
    .map(([label, to, kind, note, tip]) => {
      // 空值不用 `|| 0` 伪装成 0，直接显示占位符
      const value = to == null
        ? `<span class="hmv-null">–</span>`
        : `<span class="cnt" data-to="${to}" data-kind="${kind}">0</span>` + (kind === "tps" ? `<span class="hm-unit">tok/s</span>` : "");
      const noteHtml = note ? `<span class="hm-note">${esc(note)}</span>` : "";
      return `<div class="hm"${tip ? ` title="${esc(tip)}"` : ""}><span class="hml">${label}</span><span class="hmv">${value}</span>${noteHtml}</div>`;
    })
    .join("");
}

// 首次打开时后台扫描可能尚未完成：speed 为空且仍在 scanning 时，1.5s 后重取一次并局部重绘
function scheduleSpeedRetry() {
  clearTimeout(state.speedRetryTimer);
  state.speedRetryTimer = null;
  const empty = !state.speed || state.speed.count === 0;
  if (!empty || state.speedScanning !== true) return;
  state.speedRetryTimer = setTimeout(async () => {
    state.speedRetryTimer = null;
    try {
      const fresh = await getSpeed(buildQuery(state.filters)).catch(() => null);
      if (!fresh) return;
      state.speedScanning = Boolean(fresh.scanning);
      if (fresh.speed && fresh.speed.count > 0) {
        state.speed = fresh.speed;
        renderHero();
        renderDistributions();
      }
    } catch {}
  }, 1500);
}

function renderCharts() {
  const days = state.daily || [];
  // 降级提示：维度筛选下，来源类型/日趋势的 byType、小时图都不随筛选变化；会话维度仅最近 30 天
  const degradedNote = state.degraded?.breakdowns ? "未随筛选变化" : "";
  for (const id of ["dailyNote", "sourceNote"]) { const el = document.getElementById(id); if (el) el.textContent = degradedNote; }
  const hourlyNoteEl = document.getElementById("hourlyNote");
  if (hourlyNoteEl) {
    const parts = [state.degraded?.hourly ? "未随筛选变化" : "", hourlyMode() === "session" ? "会话维度仅最近 30 天" : ""].filter(Boolean);
    hourlyNoteEl.textContent = parts.join(" · ");
  }
  const singleDay = Boolean(state.filters.from && state.filters.from === state.filters.to);
  const dayToks = days.map((d) => d.totalTokens || 0);
  const dayHits = days.map((d) => (d.hitRatio == null ? null : d.hitRatio * 100));
  const hours = state.hourly || [];
  const hourlyCard = document.querySelector('[data-chart="hourly"]');
  const dailyTokensCard = document.querySelector('[data-chart="dailyTokens"]');
  if (dailyTokensCard) dailyTokensCard.style.display = singleDay ? "none" : "";
  if (hourlyCard) hourlyCard.style.display = singleDay ? "" : "none";
  const hourToks = hours.map((h) => h.totalTokens || 0);
  const hourHits = hours.map((h) => (h.hitRatio == null ? null : h.hitRatio * 100));
  const dayRange = days.length ? days[0].date.slice(5) + "~" + days[days.length - 1].date.slice(5) : "";

  // 趋势图：堆叠柱（按来源类型）+ 命中率折线，与用量一致
  const typeOrder = (state.byType || []).map((t) => t.type);
  const typeLabels = typeOrder.map((t) => TYPE_LABELS[t] || t);
  const typeColors = typeOrder.map((t) => TYPE_COLORS[t] || TYPE_COLORS.other);
  const rowsOf = (series) => series.map((d) => Object.fromEntries(typeOrder.map((t) => [t, d.byType?.[t]?.totalTokens || 0])));
  const legend = chartLegend(typeOrder, typeLabels, typeColors, "缓存命中率");
  const dayStep = Math.max(1, Math.ceil(days.length / 8));
  // viewBox 宽度跟随容器：否则 SVG 会被整体放大，字号和柱宽一起失真
  const chartW = (id) => Math.max(360, Math.round(document.getElementById(id)?.clientWidth || 640));
  const dayW = chartW("chDailyTokens");
  const hourW = chartW("chHourly");
  // 小时图 24 个刻度：容器 >= 560px 全部显示（纯数字标签窄，不重叠），更窄才降级
  const hourEvery = hourW >= 560 ? 1 : hourW >= 420 ? 2 : 3;

  document.getElementById("chDailyTokens").innerHTML =
    legend +
    stackedComboChart(rowsOf(days), dayHits, {
      keys: typeOrder, keyLabels: typeLabels, colors: typeColors, format: fmtTokens, stroke: "var(--green)", w: dayW,
      colLabels: days.map((d) => d.date.slice(5)),
      xLabels: days.map((d) => d.date.slice(5)), xEvery: dayStep,
    });
  const typeRows = (state.byType || []).filter((t) => (t.totalTokens || 0) > 0);
  const typeTotal = typeRows.reduce((sum, t) => sum + (t.totalTokens || 0), 0);
  const sourceTotalEl = document.getElementById("sourceTotal");
  if (sourceTotalEl) sourceTotalEl.textContent = typeTotal > 0 ? `总消耗 ${fmtTokens(typeTotal)}` : "";
  document.getElementById("chSource").innerHTML = typeRows.length
    ? sourceBar(typeRows, typeTotal)
    : `<div class="empty">暂无来源数据</div>`;
  // 小时图：类型 / 会话 切换（照用量，会话=每段会话而非助手）
  const hourMode = hourlyMode();
  const sessionHourly = state.hourlyBySession?.[state.filters.from] || null;
  const useSession = hourMode === "session" && Array.isArray(sessionHourly);
  const sessionSum = (key) => (sessionHourly || []).reduce((s, h) => s + (h?.[key]?.totalTokens || 0), 0);
  const hourKeys = useSession
    ? [...new Set((sessionHourly || []).flatMap((h) => Object.keys(h || {})))].sort((x, y) => sessionSum(y) - sessionSum(x))
    : typeOrder;
  const hourLabels = useSession ? hourKeys.map((k) => sessionLabel(k)) : typeLabels;
  const hourColors = useSession ? hourKeys.map((_, i) => PIE_COLORS[i % PIE_COLORS.length]) : typeColors;
  const hourRows = useSession
    ? (sessionHourly || []).map((h) => Object.fromEntries(hourKeys.map((k) => [k, h?.[k]?.totalTokens || 0])))
    : rowsOf(hours);
  document.querySelectorAll("#hourlySwitch button").forEach((btn) => {
    btn.classList.toggle("on", btn.dataset.mode === hourMode);
    btn.onclick = () => { try { localStorage.setItem(HOURLY_MODE_KEY, btn.dataset.mode); } catch {} renderCharts(); };
  });
  document.getElementById("chHourly").innerHTML =
    chartLegend(hourKeys, hourLabels, hourColors, "缓存命中率") +
    stackedComboChart(hourRows, hourHits, {
      keys: hourKeys, keyLabels: hourLabels, colors: hourColors, format: fmtTokens, stroke: "var(--green)", w: hourW,
      colLabels: hours.map((_, i) => `${i}:00`),
      xLabels: hours.map((_, i) => String(i)), xEvery: hourEvery, centerEnds: true, h: 150, fontSize: 11,
    });
}

// 小时图的“类型 / 会话”切换（照用量）
const HOURLY_MODE_KEY = "usage-hub-hourly-mode";
function hourlyMode() {
  try { return localStorage.getItem(HOURLY_MODE_KEY) === "session" ? "session" : "type"; } catch { return "type"; }
}
// 会话标签：优先用会话标题，缺失时取 sessionId 末 8 位
function sessionLabel(id) {
  if (!id || id === "unknown") return "未知会话";
  const title = state.sessionTitles?.[id];
  return title || `会话 ${String(id).slice(-8)}`;
}

// 消耗预测（抄 token-tracker 的月度预测口径）
function renderForecast() {
  const el = document.getElementById("forecastCard");
  if (!el) return;
  const f = state.forecast;
  if (!f) { el.style.display = "none"; return; }
  el.style.display = "";
  const items = [
    ["日均消耗", fmtTokens(f.dailyAvg)],
    ["今日预估", f.predictedToday == null ? "–" : fmtTokens(f.predictedToday)],
    ["趋势", f.trend || "持平"],
    ["月底预估", fmtTokens(f.projectedMonthEnd)],
    ["距月底", `${f.daysLeftInMonth} 天`],
  ];
  el.innerHTML =
    `<h3>消耗预测 <span class="lg-sub">本月已用 ${fmtTokens(f.monthToDate)}</span></h3>` +
    `<div class="forecast-row">` +
    items.map(([label, value]) => `<div class="forecast-item"><div class="fi-label">${label}</div><div class="fi-val">${esc(value)}</div></div>`).join("") +
    `</div>`;
}

function renderHitRateAnalysis() {
  const el = document.getElementById("hitRateCard");
  if (!el) return;
  const s = state.summary?.summary || null;
  if (!s) { el.innerHTML = `<div class="empty">数据未就绪</div>`; return; }
  const hit = s.hitRatio == null ? null : s.hitRatio * 100;
  const center = hit == null ? "–" : hit.toFixed(1) + "%";
  const ring = donutChart(
    hit == null
      ? [{ v: 1, color: "rgba(143,134,123,0.25)" }]
      : [{ v: hit, color: "rgba(83,125,150,0.85)" }, { v: Math.max(0, 100 - hit), color: "rgba(143,134,123,0.22)" }],
    { size: 168, r: 62, sw: 16, center, sub: "总命中率" }
  );
  const table = (rows, key, title) => {
    const body = (rows || [])
      .filter((r) => r.totalTokens > 0)
      .map((r) => `<tr><td>${esc(rowLabel(r, key))}</td><td>${r.hitRatio == null ? "–" : fmtPct(r.hitRatio * 100)}</td><td>${fmtTokens(r.cacheRead || 0)}</td><td>${fmtTokens(r.calls || 0)}</td><td>${fmtTokens(r.totalTokens || 0)}</td></tr>`)
      .join("");
    return `<div class="hitrate-block"><div class="hitrate-title">${title}</div>` +
      (body
        ? `<table class="hitrate-table"><thead><tr><th>名称</th><th>命中率</th><th>读取</th><th>调用</th><th>总消耗</th></tr></thead><tbody>${body}</tbody></table>`
        : `<div class="empty">暂无数据</div>`) +
      `</div>`;
  };
  el.innerHTML =
    `<h3>缓存命中率分析</h3>` +
    `<div class="hitrate-layout">` +
    `<div class="hitrate-ring"><div class="ua-donut">${ring}</div></div>` +
    `<div class="hitrate-tables">` +
    table(state.byAgent, "agentId", "Agent 分布") +
    table(state.byModel, "modelId", "模型分布") +
    `</div></div>`;
}

function renderDistributions() {
  const el = document.getElementById("distCard");
  if (!el) return;

  const hideAgent = state.settings?.display?.hideAgent === true;
  const hideModel = state.settings?.display?.hideModel === true;
  const agentRows = hideAgent ? [] : (state.byAgent || []).filter((a) => a.totalTokens > 0);
  const modelRows = hideModel ? [] : (state.byModel || []).filter((m) => m.totalTokens > 0);
  const typeRows = (state.byType || []).filter((t) => t.totalTokens > 0);

  const pieCell = (rows, title, key, sub) => {
    const segs = rows.map((r, i) => ({ v: r.totalTokens, color: PIE_COLORS[i % PIE_COLORS.length] }));
    const legend = rows
      .map((r, i) => `<span><i class="fb-dot" style="background:${PIE_COLORS[i % PIE_COLORS.length]}"></i>${esc(TYPE_LABELS[r[key]] || r[key])} ${fmtTokens(r.totalTokens)} · ${r.calls} 次 · 命中率 ${r.hitRatio == null ? "–" : fmtPct(r.hitRatio * 100)}</span>`)
      .join("");
    return `<div class="lg-cell" data-dist="${key}" title="点击放大查看"><div class="lg-t">${title}</div>` +
      `<div class="ua-donut-wrap">` +
      `<div class="ua-donut">${pieChart(segs, { size: 110 })}</div>` +
      `<div class="ua-lg">${legend}</div>` +
      `</div>` +
      (sub ? `<div class="lg-note">${sub}</div>` : "") +
      `</div>`;
  };

  const agentSpeedTps = (id) => {
    const hit = (state.speed?.byAgent || []).find((x) => x.agentId === (id || "unknown"));
    return hit && hit.tps != null ? hit.tps : null;
  };
  const agentRank = agentRows.map((row, index) => {
    const tps = agentSpeedTps(row.agentId);
    return `<div class="agent-rank-row" title="${esc(SPEED_HINT)}"><b>${index + 1}. ${esc(agentLabel(row.agentId))}</b><span>${fmtTokens(row.totalTokens)} · ${row.calls} 次 · 命中 ${row.hitRatio == null ? "–" : fmtPct(row.hitRatio * 100)} · 输出 ${fmtTokens(row.output)} · 推理 ${fmtTokens(row.reasoning)} · ${tps == null ? "–" : tps + " tok/s"}</span></div>`;
  }).join("");
  el.innerHTML =
    `<h3>模型 / Provider 分布${state.degraded?.breakdowns ? ` <span class="lg-sub">未随筛选变化</span>` : ""}</h3><div class="lg-grid">` +
    pieCell(modelRows, "模型用量对比", "modelId") +
    pieCell((state.byProvider || []).filter((p) => p.totalTokens > 0), "Provider 用量", "provider") +
    `</div>`;

  el.querySelectorAll(".lg-cell[data-dist]").forEach((cell) => {
    cell.addEventListener("click", () => {
      const key = cell.dataset.dist;
      let title = "", rows = [];
      if (key === "agentId") { title = "Agent 用量"; rows = agentRows; }
      else if (key === "modelId") { title = "模型用量对比"; rows = modelRows; }
      else { title = "来源类型分布"; rows = typeRows; }
      const segs = rows.map((r, i) => ({ v: r.totalTokens, color: PIE_COLORS[i % PIE_COLORS.length] }));
      const legend = rows
        .map((r, i) => `<span><i class="fb-dot" style="background:${PIE_COLORS[i % PIE_COLORS.length]}"></i>${esc(rowLabel(r, key))} <b>${fmtTokens(r.totalTokens)}</b> · ${r.calls} 次 · 命中率 ${r.hitRatio == null ? "–" : fmtPct(r.hitRatio * 100)}</span>`)
        .join("");
      openModal(title,
        `<div class="ua-donut" style="width:250px;height:250px">${donutChart(segs, { size: 250, r: 92, sw: 24, center: fmtTokens(rows.reduce((s, r) => s + r.totalTokens, 0)), sub: "tokens" })}</div>` +
        `<div class="ua-lg ua-lg-modal">${legend}</div>`);
    });
  });
}

function fmtResetAt(value) {
  if (value == null || value === "") return "";
  const ms = typeof value === "number" ? (value > 1e12 ? value : value * 1000) : Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Codex 订阅额度：独立卡（圆环剩余 + 各窗口已用/重置时间），参照 token-tracker
function renderCodexCard() {
  const el = document.getElementById("codexCard");
  if (!el) return;
  const s = (state.balance?.sources || []).find((x) => x.id === "codex");
  if (!s || !s.configured) { el.style.display = "none"; return; }
  el.style.display = "";
  const refreshBtn = `<button class="ghost" id="codexRefresh" type="button">刷新</button>`;
  const plan = s.planType ? ` <span class="lg-sub">${esc(s.planType)}</span>` : "";
  const head = `<div class="settings-head"><h3>ChatGPT 额度${plan}</h3>${refreshBtn}</div>`;
  if (s.status !== "ok") {
    el.innerHTML = `${head}<div class="empty">不可用</div>`;
    el.querySelector("#codexRefresh")?.addEventListener("click", refreshCodex);
    return;
  }
  const wins = s.windows || [];
  if (!wins.length) {
    el.innerHTML = `${head}<div class="empty">接口未返回窗口额度</div>`;
    el.querySelector("#codexRefresh")?.addEventListener("click", refreshCodex);
    return;
  }
  const cells = wins
    .map((w) => {
      const used = w.usedPercent ?? (w.remainingPercent != null ? 100 - w.remainingPercent : 0);
      const left = Math.max(0, Math.min(100, Math.round(100 - used)));
      const color = used >= 80 ? "#ef4444" : used >= 60 ? "#f59e0b" : "var(--green)";
      const ring = donutChart(
        [{ v: left, color }, { v: Math.max(0, 100 - left), color: "rgba(143,134,123,0.22)" }],
        { size: 148, r: 56, sw: 13, center: `${left}%`, sub: "剩余" }
      );
      const reset = fmtResetAt(w.resetAt);
      return `<div class="cx-cell"><div class="ua-donut">${ring}</div>` +
        `<div class="cx-name">${esc(w.label)}</div>` +
        (reset ? `<div class="cx-reset">${esc(reset)} 重置</div>` : "") +
        `</div>`;
    })
    .join("");
  el.innerHTML =
    `${head}` +
    `<div class="codex-layout">${cells}</div>`;
  el.querySelector("#codexRefresh")?.addEventListener("click", refreshCodex);
}

function refreshCodex(e) {
  e.currentTarget.disabled = true;
  fetchJson("/api/balance/refresh", { method: "POST" })
    .then((b) => { state.balance = b; renderSettingsAndBalance(); })
    .catch(() => { e.currentTarget.disabled = false; });
}

function closeSettings() {
  const drawer = document.getElementById("settingsDrawer"), shade = document.getElementById("settingsShade");
  drawer?.classList.remove("open"); drawer?.setAttribute("aria-hidden", "true"); shade?.classList.remove("open");
}
function openSettings() {
  const drawer = document.getElementById("settingsDrawer"), shade = document.getElementById("settingsShade");
  drawer?.classList.add("open"); drawer?.setAttribute("aria-hidden", "false"); shade?.classList.add("open");
}

function renderSettingsAndBalance() {
  const settingsEl = document.getElementById("settingsCard");
  const balanceEl = document.getElementById("balanceCard");
  const sources = (state.balance?.sources || []).filter((s) => s.configured);
  const renderSourceCard = (el, kind, title) => {
    if (!el) return;
    const rows = sources.filter((s) => (s.kind || (s.id === "codex" ? "quota" : "balance")) === kind);
    if (!rows.length) { el.style.display = "none"; return; }
    el.style.display = "";
    const quotaText = (s) => {
      const parts = [];
      if (s.usedPercent != null) parts.push(`5 小时窗口已用 ${s.usedPercent}%`);
      if (s.secondaryRemainingPercent != null) parts.push(`周窗口已用 ${100 - s.secondaryRemainingPercent}%`);
      if (!parts.length && s.remainingPercent != null) parts.push(`剩余 ${s.remainingPercent}%`);
      return parts.length ? parts.join(" · ") : "–";
    };
    const filterKey = kind === "quota" ? "quotaSource" : "balanceSource";
    const selected = state[filterKey] && rows.some((s) => s.id === state[filterKey]) ? state[filterKey] : "";
    const visibleRows = selected ? rows.filter((s) => s.id === selected) : rows;
    const sourceFilter = rows.length > 1 ? `<select class="source-filter" id="${kind}SourceFilter"><option value="">全部来源</option>${rows.map((s) => `<option value="${esc(s.id)}" ${s.id === selected ? "selected" : ""}>${esc(providerLabel(s.id))}</option>`).join("")}</select>` : "";
    el.innerHTML = `<div class="settings-head"><h3>${title}</h3>${sourceFilter}<button class="ghost" id="${kind}Refresh" type="button">刷新</button></div>` + visibleRows.map((s) => `<div class="balance-row"><b>${esc(providerLabel(s.id) || s.label)}</b><span class="status-${esc(s.status)}">${s.status === "ok" ? (kind === "quota" ? quotaText(s) : (s.balance != null ? `${esc(s.balance)} ${esc(s.currency || "")}` : (s.remainingPercent != null ? `剩余 ${esc(s.remainingPercent)}%` : "–"))) : "不可用"}</span></div>`).join("");
    el.querySelector(`#${kind}SourceFilter`)?.addEventListener("change", (event) => { state[filterKey] = event.target.value; renderSettingsAndBalance(); });
    el.querySelector(`#${kind}Refresh`)?.addEventListener("click", async (e) => { e.currentTarget.disabled = true; state.balance = await fetchJson("/api/balance/refresh", { method: "POST" }).catch(() => state.balance); renderSettingsAndBalance(); });
  };
  renderSourceCard(balanceEl, "balance", "余额");
  renderCodexCard();
  if (!settingsEl) return;
  const s = state.settings || { display: {}, ui: {}, balance: {}, credentials: {} };
  const agents = state.options.agents || [], models = state.options.models || [];
  const toggles = (items, key, label) => items.length ? `<div class="set-list"><strong>${label}</strong>${items.map((item) => `<label><input class="set-hidden-item" data-key="${key}" data-value="${esc(item)}" type="checkbox" ${(s.display?.[key] || []).includes(item) ? "checked" : ""}> 隐藏 ${esc(key === "hiddenAgents" ? agentLabel(item) : item)}</label>`).join("")}</div>` : "";
  // 抽屉打开时不重建，避免定时刷新把用户正在编辑的勾选/输入重置
  const drawerOpen = document.getElementById("settingsDrawer")?.classList.contains("open") === true;
  if (!drawerOpen) {
  settingsEl.innerHTML = `<div class="settings-head"><h3>设置</h3><button class="ghost" id="settingsClose" type="button">关闭</button></div>${toggles(agents, "hiddenAgents", "助手逐项隐藏")}${toggles(models, "hiddenModels", "模型逐项隐藏")}<label>前端刷新间隔（秒） <input id="setUiRefresh" type="number" min="10" max="3600" value="${s.ui?.refreshSeconds || 60}"></label><label><input id="setBalance" type="checkbox" ${s.balance?.enabled !== false ? "checked" : ""}> 启用余额读取</label><label>余额轮询间隔（秒） <input id="setPoll" type="number" min="60" max="86400" value="${s.balance?.pollSeconds || 900}"></label><label><input id="setCodex" type="checkbox" ${s.balance?.codexEnabled ? "checked" : ""}> 启用额度 / ChatGPT</label><div class="set-note">供应商密钥统一从 Hana 设置读取（provider-catalog.json），此处无需填写。</div><button class="ghost" id="settingsSave" type="button">保存</button><span id="settingsState"></span>`;
  settingsEl.querySelector("#settingsClose")?.addEventListener("click", closeSettings);
  settingsEl.querySelector("#settingsSave")?.addEventListener("click", async (e) => { const btn = e.currentTarget; const stateEl = settingsEl.querySelector("#settingsState"); btn.disabled = true; stateEl.textContent = "保存中"; try { const hidden = (key) => [...settingsEl.querySelectorAll(`.set-hidden-item[data-key="${key}"]:checked`)].map((el) => el.dataset.value); const payload = { display: { hiddenAgents: hidden("hiddenAgents"), hiddenModels: hidden("hiddenModels") }, ui: { refreshSeconds: Number(settingsEl.querySelector("#setUiRefresh").value) }, balance: { enabled: settingsEl.querySelector("#setBalance").checked, pollSeconds: Number(settingsEl.querySelector("#setPoll").value), codexEnabled: settingsEl.querySelector("#setCodex").checked } }; const saved = await postJson("/api/settings", payload); state.settings = saved.settings; state.balance = saved.balance || await getBalance().catch(() => state.balance); stateEl.textContent = "已保存"; await state.refreshAll?.(); const fresh = settingsEl.querySelector("#settingsState"); if (fresh) fresh.textContent = "已保存"; setTimeout(closeSettings, 1500); } catch { stateEl.textContent = "保存失败"; } finally { btn.disabled = false; } });
  }
}

function renderFoot() {
  const el = document.getElementById("foot");
  if (!el) return;
  const last = state.status?.lastRefreshAt || state.builtAt || null;
  if (!last) { el.innerHTML = ""; return; }
  const speed = state.status?.lastSpeedScanAt || "";
  el.innerHTML = `<span class="foot-scan" title="数据刷新：${esc(last)}${speed ? " · 速度扫描：" + esc(speed) : ""}">上次后台扫描：${timeAgo(last)}</span>`;
}

function timeAgo(iso) {
  if (!iso) return "–";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "–";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return s + " 秒前";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  return Math.floor(s / 3600) + " 小时前";
}

async function renderPage() {
  if (!root) return;
  root.innerHTML = `
    <div class="panel">
    <div class="head">
      <h1>用量中心</h1>
      <span class="lg-sub" id="snapshotAge"></span>
      <span class="spacer"></span>
      <button class="ghost" id="refreshBtn" type="button"><span class="btn-ic" id="btnIc">↻</span><span class="btn-tx" id="btnTx">刷新</span></button>
      <button class="ghost icon-btn" id="settingsBtn" type="button" title="设置" aria-label="设置"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg></button>
    </div>
    <div class="filter-bar" id="filterBar">
      <div class="preset-group" id="datePresets">
        <button class="preset-btn" data-preset="year" type="button">本年</button><button class="preset-btn" data-preset="month" type="button">本月</button><button class="preset-btn" data-preset="week" type="button">本周</button><button class="preset-btn" data-preset="yesterday" type="button">昨天</button><button class="preset-btn active" data-preset="today" type="button">今天</button>
      </div>
      <select class="fb-select" id="fAgent"><option value="">全部 agent</option></select>
      <select class="fb-select" id="fModel"><option value="">全部模型</option></select>
      <select class="fb-select" id="fProvider"><option value="">全部供应商</option></select>
      <select class="fb-select" id="fType">
        <option value="">全部来源</option>
        <option value="session">会话</option>
        <option value="subagent">子代理</option>
        <option value="memory">记忆</option>
        <option value="automation">自动化</option>
        <option value="utility">实用</option>
        <option value="compaction">压缩</option>
        <option value="vision">视觉</option>
        <option value="other">其他</option>
      </select>
      <span class="fb-active" id="activeDim"></span>
      <button class="ghost fb-clear" id="fClear" type="button">清空</button>
    </div>
    <div class="hero-metrics" id="heroMetrics"></div>
    <div class="settings-grid"><div class="chart-card" id="balanceCard"></div><div class="chart-card" id="codexCard"></div></div>
    <div class="chart-card" id="forecastCard"></div>
    <div class="chart-grid si-anim">
      <div class="chart-card" data-chart="dailyTokens"><h3>每日消耗趋势 <span class="lg-sub" id="dailyNote"></span></h3><div id="chDailyTokens">加载中…</div></div>
      <div class="chart-card" data-chart="source"><h3>来源类型 <span class="lg-sub" id="sourceTotal"></span> <span class="lg-sub" id="sourceNote"></span></h3><div id="chSource">加载中…</div></div>
      <div class="chart-card" data-chart="hourly"><h3>小时消耗趋势 <span class="lg-sub">横轴 · 小时</span> <span class="lg-sub" id="hourlyNote"></span> <span class="tc-switch" id="hourlySwitch"><button data-mode="type" type="button">类型</button><button data-mode="session" type="button">会话</button></span></h3><div id="chHourly">加载中…</div></div>
    </div>
    <div class="chart-card" id="hitRateCard"></div>
    <div class="chart-card" id="distCard"></div>
    <div class="drawer-shade" id="settingsShade"></div><aside class="settings-drawer glass" id="settingsDrawer" aria-hidden="true"><div id="settingsCard"></div></aside>
    <div class="foot" id="foot"></div>
    </div>
  `;

  const refreshBtn = document.getElementById("refreshBtn");
  const settingsBtn = document.getElementById("settingsBtn");
  settingsBtn?.addEventListener("click", () => { renderSettingsAndBalance(); openSettings(); });
  document.getElementById("settingsShade")?.addEventListener("click", closeSettings);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeSettings(); });

  // ── 筛选栏：选项池填充（首次全量快照，筛选后不缩水）──
  const FILTER_IDS = ["fAgent", "fModel", "fProvider", "fType"]; 

  function renderFilterOptions() {
    const fill = (id, items, label, labelOf) => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const cur = sel.value;
      sel.innerHTML = `<option value="">${label}</option>` + items.map((v) => `<option value="${esc(v)}">${esc(labelOf ? labelOf(v) : v)}</option>`).join("");
      sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "";
    };
    fill("fAgent", state.options.agents, "全部 agent", agentLabel);
    fill("fModel", state.options.models, "全部模型");
    fill("fProvider", state.options.providers, "全部供应商");
  }

  function renderActiveDim() {
    const el = document.getElementById("activeDim");
    if (!el) return;
    const labels = { agent: "agent", model: "模型", provider: "供应商", type: "来源类型" };
    for (const d of ["agent", "model", "provider", "type"]) {
      if (state.filters[d]) { el.textContent = `当前生效维度：${labels[d]} = ${state.filters[d]}`; return; }
    }
    el.textContent = "";
  }

  function applyFilter() {
    const range = presetRange(state.filters.preset || "today");
    state.filters = {
      ...range,
      preset: state.filters.preset || "today",
      agent: document.getElementById("fAgent")?.value || "",
      model: document.getElementById("fModel")?.value || "",
      provider: document.getElementById("fProvider")?.value || "",
      type: document.getElementById("fType")?.value || "",
    };
    renderAll({ silent: true });
  }

  function bindFilterEvents() {
    document.querySelectorAll("#datePresets .preset-btn").forEach((button) => button.addEventListener("click", () => {
      state.filters.preset = button.dataset.preset || "today";
      document.querySelectorAll("#datePresets .preset-btn").forEach((item) => item.classList.toggle("active", item === button));
      applyFilter();
    }));
    for (const id of FILTER_IDS) {
      document.getElementById(id)?.addEventListener("change", () => {
        // 单条件筛选：切换某维度时清空其他维度，避免静默丢弃用户选择
        for (const other of FILTER_IDS) {
          if (other === id) continue;
          const el = document.getElementById(other);
          if (el) el.value = "";
        }
        applyFilter();
      });
    }
    document.getElementById("fClear")?.addEventListener("click", () => {
      state.filters.preset = "today";
      document.querySelectorAll("#datePresets .preset-btn").forEach((item) => item.classList.toggle("active", item.dataset.preset === "today"));
      for (const id of FILTER_IDS) {
        const el = document.getElementById(id);
        if (el) el.value = "";
      }
      applyFilter();
    });
  }

  function setLoading(on, ok = true) {
    refreshBtn.disabled = on;
    const ic = document.getElementById("btnIc");
    const tx = document.getElementById("btnTx");
    if (on) {
      refreshBtn.classList.add("loading");
      if (tx) tx.textContent = "刷新中";
    } else {
      refreshBtn.classList.remove("loading");
      if (ic) {
        ic.textContent = ok ? "✓" : "!";
        ic.classList.add("done");
      }
      if (tx) tx.textContent = ok ? "已刷新" : "刷新失败";
      setTimeout(() => {
        if (ic && !refreshBtn.classList.contains("loading")) {
          ic.textContent = "↻";
          ic.classList.remove("done");
        }
        if (tx && !refreshBtn.classList.contains("loading")) tx.textContent = "刷新";
      }, 1000);
    }
  }

  async function renderAll(options = {}) {
    const silent = options.silent === true;
    const feedback = options.feedback !== false;
    if (state.loading) return;
    state.loading = true;
    if (feedback) setLoading(true);
    let ok = true;
    try {
      await loadAllData();
      renderFilterOptions();
      renderActiveDim();
      renderHero();
      scheduleSpeedRetry();
      renderForecast();
      renderCharts();
      renderHitRateAnalysis();
      renderDistributions();
      renderSettingsAndBalance();
      renderFoot();
      invalidateGlowCache();
      animateNumbers(root, silent);
      // 成功加载后写入本地快照（首屏占位用）；超限自动跳过
      saveSnapshot(localStorage, state, UI_VERSION);
      renderSnapshotAge(0); // 数据已刷新，清掉「上次更新」
      // 首次进入的图表动画只播一次
      const gridEl = document.querySelector(".chart-grid");
      if (gridEl) gridEl.classList.remove("si-anim");
    } catch (e) {
      // 接口失败时不再让图表永远停在“加载中”：统一给出错误提示 + 重试入口
      ok = false;
      const message = esc(e?.message || String(e));
      const metricsEl = document.getElementById("heroMetrics");
      if (metricsEl) {
        metricsEl.innerHTML =
          `<div class="load-error"><div class="le-title">数据加载失败</div><div class="le-msg">${message}</div>` +
          `<button type="button" class="ghost" id="loadRetry">重试</button></div>`;
        metricsEl.querySelector("#loadRetry")?.addEventListener("click", () => renderAll({ silent: true }));
      }
      for (const id of ["chDailyTokens", "chHourly"]) {
        const el = document.getElementById(id);
        if (el && el.textContent.includes("加载中")) el.innerHTML = `<div class="empty">加载失败</div>`;
      }
      for (const id of ["distCard", "balanceCard", "quotaCard"]) {
        const el = document.getElementById(id);
        if (el && !el.innerHTML.trim()) el.innerHTML = `<div class="empty">加载失败</div>`;
      }
    } finally {
      state.loading = false;
      if (feedback) setLoading(false, ok);
    }
  }

  refreshBtn.addEventListener("click", () => renderAll({ silent: true }));
  bindFilterEvents();
  root.setAttribute("tabindex", "-1");
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "F5") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        renderAll({ silent: true });
      }
    },
    true
  );
  root.addEventListener("pointerdown", () => root.focus());
  root.focus();

  state.refreshAll = () => renderAll({ silent: true });
  // 进入页面先用本地快照立即渲染，避免空白；随后真实刷新静默替换
  const snapshot = loadSnapshot(localStorage, UI_VERSION, state.filters);
  if (snapshot) {
    applySnapshot(snapshot);
    renderFilterOptions();
    renderHero();
    scheduleSpeedRetry();
    renderForecast();
    renderCharts();
    renderHitRateAnalysis();
    renderDistributions();
    renderSettingsAndBalance();
    renderFoot();
    invalidateGlowCache();
    animateNumbers(root, false);
    renderSnapshotAge(snapshot.savedAt);
  }
  await renderAll({ silent: Boolean(snapshot) }); // 有快照：静默替换；无快照：首屏动画
  root.classList.add("uh-silent"); // 之后所有刷新静默，不重播动画
  const uiRefreshMs = Math.max(10, Number(state.settings?.ui?.refreshSeconds || 60)) * 1000;
  const autoTimer = setInterval(() => { if (!document.hidden && !state.loading) renderAll({ silent: true, feedback: false }); }, uiRefreshMs);
  // 容器宽度变化时重算图表 viewBox，避免 SVG 被拉伸导致字号失真
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (!document.hidden && !state.loading) renderCharts(); }, 200);
  });
  // 容器自身宽度变化（侧栏开合、布局变化）即时重绘；window resize 仅作兜底。
  // 只绑定一次（renderPage 只执行一次），rAF + 排队标志避免观察器与重绘互相触发。
  let chartResizeQueued = false;
  const chartResizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => {
        if (chartResizeQueued) return;
        chartResizeQueued = true;
        requestAnimationFrame(() => {
          chartResizeQueued = false;
          if (!document.hidden && !state.loading) renderCharts();
        });
      })
    : null;
  if (chartResizeObserver) {
    for (const id of ["chHourly", "chDailyTokens"]) {
      const el = document.getElementById(id);
      if (el) chartResizeObserver.observe(el);
    }
  }
  const balanceTimer = setInterval(async () => { if (!document.hidden && state.settings?.balance?.enabled !== false) { state.balance = await fetchJson("/api/balance/refresh", { method: "POST" }).catch(() => state.balance); renderSettingsAndBalance(); } }, Math.max(60, Number(state.settings?.balance?.pollSeconds || 900)) * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !state.loading) renderAll({ silent: true, feedback: false }); });
  window.addEventListener("beforeunload", () => { clearInterval(autoTimer); clearInterval(balanceTimer); chartResizeObserver?.disconnect(); clearTimeout(state.speedRetryTimer); }, { once: true });
}

/* ── 鼠标跟踪光晕（沿用 session-insight） ── */

function ensureGlowSpot(card) {
  if (!card.querySelector(".si-glow-spot")) {
    const spot = document.createElement("div");
    spot.className = "si-glow-spot";
    card.prepend(spot);
  }
  if (!card.querySelector(".si-border-glow")) {
    const border = document.createElement("div");
    border.className = "si-border-glow";
    card.prepend(border);
  }
}

let glowCache = null;
const GLOW_SEL = ".hm .hml, .hm .hmv, h3, .legend span, .ua-t, .ua-pv, .ua-pv-num, .ua-lg span, .ua-detail span, .ctx-labels span, .ctx-note, .lg-t, .lg-sub, .model, .w-title, .w-turns, .w-section-head span, .w-section-head b, .w-context-note, .w-metric span, .w-metric b, .w-legend span, .w-provider-share span, .w-provider-name strong, .w-provider-name span, .w-provider-stat span, .w-provider-stat b, .w-ov-row span, .w-ov-row b";
function buildGlowCache(card) {
  const r = card.getBoundingClientRect();
  const els = card.querySelectorAll(GLOW_SEL);
  const glowR = parseFloat(getComputedStyle(card).getPropertyValue("--glow-r")) || 175;
  const cardSize = Math.max(r.width, r.height);
  glowCache = {
    card,
    maxD: Math.min(glowR, cardSize * 0.5),
    els: Array.from(els, (el) => {
      const er = el.getBoundingClientRect();
      return { el, rx: er.left + er.width / 2 - r.left, ry: er.top + er.height / 2 - r.top };
    }),
  };
}
function invalidateGlowCache() {
  glowCache = null;
}

function initGlow(container) {
  const selector = ".hm, .chart-card, .bar, .foot, .w-overview, .w-metric, .w-provider-row, .lg-cell";
  let raf = null;
  let mx = 0, my = 0;
  container.addEventListener("mousemove", (e) => {
    mx = e.clientX;
    my = e.clientY;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      const card = document.elementFromPoint(mx, my)?.closest(selector);
      if (!card) return;
      ensureGlowSpot(card);
      const r = card.getBoundingClientRect();
      const x = (((mx - r.left) / r.width) * 100).toFixed(1);
      const y = (((my - r.top) / r.height) * 100).toFixed(1);
      card.style.setProperty("--mx", x + "%");
      card.style.setProperty("--my", y + "%");
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const ang = (Math.atan2(my - cy, mx - cx) * 180) / Math.PI + 90;
      card.style.setProperty("--ang", ang.toFixed(1) + "deg");
      if (!glowCache || glowCache.card !== card) buildGlowCache(card);
      if (glowCache.els.length) {
        const rl = r.left, rt = r.top;
        for (const item of glowCache.els) {
          const dx = item.rx - (mx - rl);
          const dy = item.ry - (my - rt);
          const g = 1 - Math.sqrt(dx * dx + dy * dy) / glowCache.maxD;
          const q = g > 0 ? Math.round(Math.max(0, g) * 20) / 20 : 0;
          if (item.el.__glow !== q) {
            item.el.__glow = q;
            item.el.style.setProperty("--glow", q.toFixed(2));
          }
        }
      }
    });
  });
}

/* ── 卡片按压回弹动效（沿用 session-insight） ── */

function initPressFx() {
  const cardSel = ".hm, .chart-card, .ua-pie, .lg-cell, .w-overview, .w-metric, .w-provider-row";
  const pressCard = (el) => {
    if (el.classList.contains("ua-disabled")) return;
    el.classList.remove("si-release");
    el.classList.add("si-press");
  };
  const releaseCard = (el) => {
    if (!el || !el.classList.contains("si-press")) return;
    el.classList.remove("si-press");
    el.classList.add("si-release");
    clearTimeout(el.__siRel);
    el.__siRel = setTimeout(() => el.classList.remove("si-release"), 650);
  };
  document.addEventListener("mousedown", (e) => {
    const card = e.target.closest(cardSel);
    if (card) pressCard(card);
  }, true);
  document.addEventListener("mouseup", (e) => {
    const card = e.target.closest(cardSel);
    if (card) releaseCard(card);
  }, true);
  document.addEventListener("mouseleave", (e) => {
    const card = e.target.closest(cardSel);
    if (card) releaseCard(card);
  }, true);
  document.addEventListener("touchstart", (e) => {
    const card = e.target.closest(cardSel);
    if (card) pressCard(card);
  }, true);
  document.addEventListener("touchend", (e) => {
    const card = e.target.closest(cardSel);
    if (card) releaseCard(card);
  }, true);
}

/* ── 入口 ── */

if (surface === "widget") {
  renderWidget();
  hana.ui.resize({ height: 600 });
} else {
  renderPage();
  hana.ui.resize({ height: 1000 });
}
initGlow(root);
initPressFx();
hana.ready();
