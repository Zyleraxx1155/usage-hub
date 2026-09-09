// test/usage-hub-0516.test.js — 0.5.16：生成速度前端呈现、小时图横轴几何、本周范围、版本一致性
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { aggregateEntries } from "../lib/aggregate.js";

const ROOT = new URL("..", import.meta.url);
const readSource = (rel) => fs.readFileSync(new URL(rel, ROOT), "utf8");
const panelSource = () => readSource("assets/panel.js");
const cssSource = () => readSource("assets/panel.css");

const mkEntry = ({ durationMs, output = 10 } = {}) => ({
  source: { subsystem: "session" },
  attribution: { agentId: "a", sessionId: "s" },
  model: { modelId: "m", provider: "p" },
  startedAt: "2026-09-09T02:00:00Z",
  status: "ok",
  durationMs,
  usage: {
    input: { totalTokens: output, uncachedTokens: output },
    cache: { readTokens: 0 },
    output: { totalTokens: output },
    totalTokens: output * 2,
  },
});

test("0.5.16: aggregate 不再暴露吞吐字段，延迟保留 0/1ms 剔除", () => {
  const result = aggregateEntries([mkEntry({ durationMs: 0 }), mkEntry({ durationMs: 1 }), mkEntry({ durationMs: 2 }), mkEntry({ durationMs: 5000 })]);
  const s = result.summary;
  assert.equal(s.latency.n, 2); // 仅 2ms 与 5000ms
  assert.equal("avgOutputTokensPerSecond" in s, false);
  assert.equal("throughputSamples" in s, false);
  for (const bucket of [result.byType[0], result.byAgent[0], result.byModel[0], result.byProvider[0], result.daily[0]]) {
    assert.equal("avgOutputTokensPerSecond" in bucket, false);
    assert.equal("throughputSamples" in bucket, false);
  }
});

test("0.5.16: 前端 presetRange 本周起点与 lib/date-presets 同式（修复少一天）", () => {
  const source = panelSource();
  const start = source.indexOf("function presetRange(preset)");
  assert.ok(start >= 0, "panel.js 应包含 presetRange");
  const end = source.indexOf("\n}", start);
  const body = source.slice(start, end + 2);
  const make = (todayStr) => new Function("cnToday", `${body}; return presetRange;`)(() => todayStr);
  assert.deepEqual(make("2026-09-07")("week"), { from: "2026-09-07", to: "2026-09-07" }); // 周一
  assert.deepEqual(make("2026-09-09")("week"), { from: "2026-09-07", to: "2026-09-09" }); // 周三
  assert.deepEqual(make("2026-09-13")("week"), { from: "2026-09-07", to: "2026-09-13" }); // 周日
  assert.deepEqual(make("2026-09-14")("week"), { from: "2026-09-14", to: "2026-09-14" }); // 下周一
  // 旧实现用 d.getUTCDay()（上海午夜落在 UTC 前一天 16:00）会少算一天，确保已替换
  assert.doesNotMatch(source, /shift\(-\(\(d\.getUTCDay\(\) \+ 6\) % 7\)\)/);
});

test("0.5.16: 小时图 viewBox 宽度跟随容器，刻度间隔随宽度变化", () => {
  const source = panelSource();

  // chartW：返回容器宽度（下限 360），缩放系数恒为 1
  const chartWDecl = source.match(/const chartW = \(id\) => [^;]+;/);
  assert.ok(chartWDecl, "应存在 chartW");
  const makeChartW = (clientWidth) => new Function("document", `${chartWDecl[0]} return chartW;`)({ getElementById: () => ({ clientWidth }) });
  for (const w of [360, 720, 900, 1280]) assert.equal(makeChartW(w)("chHourly"), w);
  assert.equal(makeChartW(200)("chHourly"), 360, "容器过窄时下限 360");

  // hourEvery：>=1200 → 1，>=720 → 2，否则 3
  const everyDecl = source.match(/const hourEvery = [^;]+;/);
  assert.ok(everyDecl, "应存在 hourEvery");
  const everyOf = (hourW) => new Function("hourW", `${everyDecl[0]} return hourEvery;`)(hourW);
  assert.equal(everyOf(1280), 1);
  assert.equal(everyOf(900), 1);
  assert.equal(everyOf(560), 1);
  assert.equal(everyOf(420), 2);
  assert.equal(everyOf(360), 3);

  // 视觉字号恒 11px：viewBox 与容器一致（w: hourW），横轴不缩放
  assert.match(source, /w: hourW/);
  assert.match(source, /fontSize: 11/);
  assert.match(source, /viewBox="0 0 \$\{w\} \$\{h\}"/);
});

test("0.5.20: hero「Token 平均速率」不含加权字样、hover 精简", () => {
  const source = panelSource();
  assert.match(source, /Token 平均速率/);
  assert.doesNotMatch(source, /端到端输出速率/);
  assert.doesNotMatch(source, /加权 · /, "去掉「加权 · N 次」标注");
  assert.match(source, /Σ输出 token ÷ Σ间隔（含工具调用等待与网络排队），过滤 100ms~10min。/);
  assert.match(source, /state\.speed/);
  assert.match(source, /hm-unit/);
  assert.match(source, /hmv-null/);
  // 旧的逐请求吞吐字段已移除
  assert.doesNotMatch(source, /avgOutputTokensPerSecond/);
  assert.doesNotMatch(source, /throughputSamples/);
  // agent 排名沿用同一加权口径（state.speed.byAgent）
  assert.match(source, /state\.speed\?\.byAgent/);
  // 空值显示占位符，不用 || 0
  assert.match(source, /speed\.tps != null \? speed\.tps : null/);
  // F6：首屏为空且扫描中时局部重取
  assert.match(source, /scheduleSpeedRetry/);
  assert.match(source, /fresh\.scanning/);
  // 模型分布卡不再输出提示句；排名行 title 保留
  assert.doesNotMatch(source, /pieCell\(modelRows, "模型用量对比", "modelId", SPEED_HINT\)/);
  assert.match(source, /agent-rank-row" title="\$\{esc\(SPEED_HINT\)\}"/);

  const css = cssSource();
  assert.match(css, /\.hm \.hm-note \{/);
  assert.match(css, /\.hm \.hmv \.hmv-null \{/);
  assert.match(css, /\.hm \.hmv \.hm-unit \{/);
});

test("0.5.20: 速率偏差说明仅保留在 agent 排名行 title", () => {
  const source = panelSource();
  assert.match(source, /const SPEED_HINT = "按模型\/单条的速率受消息间隔与工具调用密度影响，非模型纯生成速度，不宜跨模型直接比较。"/);
  // 模型分布卡不再挂提示句
  assert.doesNotMatch(source, /pieCell\(modelRows, "模型用量对比", "modelId", SPEED_HINT\)/);
  // 排名行 title 保留
  assert.match(source, /agent-rank-row" title="\$\{esc\(SPEED_HINT\)\}"/);
});

test("0.5.16: 小时图与每日趋势图绑定 ResizeObserver，销毁时解绑", () => {
  const source = panelSource();
  assert.match(source, /new ResizeObserver\(/);
  assert.match(source, /for \(const id of \["chHourly", "chDailyTokens"\]\)/);
  assert.match(source, /chartResizeObserver\.observe\(el\)/);
  assert.match(source, /chartResizeObserver\?\.disconnect\(\)/);
  // window resize 防抖兜底保留
  assert.match(source, /resizeTimer = setTimeout/);
});

test("0.6.0: 页脚「上次后台扫描」与筛选降级提示", () => {
  const source = panelSource();
  assert.match(source, /上次后台扫描：\$\{timeAgo\(last\)\}/);
  assert.match(source, /lastSpeedScanAt/);
  assert.match(source, /state\.degraded = summary\.degraded/);
  assert.match(source, /state\.degraded\?\.breakdowns/);
  assert.match(source, /state\.degraded\?\.hourly/);
  const api = readSource("routes/api.js");
  assert.match(api, /lastSpeedScanAt: h\.speeds\?\.updatedAt/);
  assert.match(api, /degraded: r\.degraded/);
});

test("0.5.16–0.6.0: 版本号全量同步，内部 import 均带当前版本、无旧版本残留", () => {
  const manifest = JSON.parse(readSource("manifest.json"));
  const pkg = JSON.parse(readSource("package.json"));
  assert.equal(manifest.version, "0.6.0");
  assert.equal(pkg.version, "0.6.0");
  assert.match(readSource("routes/ui.js"), /UI_CACHE_VERSION = "0\.6\.0"/);

  const files = [
    "index.js",
    ...fs.readdirSync(new URL("routes", ROOT)).filter((f) => f.endsWith(".js")).map((f) => `routes/${f}`),
    ...fs.readdirSync(new URL("lib", ROOT)).filter((f) => f.endsWith(".js")).map((f) => `lib/${f}`),
  ];
  for (const file of files) {
    const src = readSource(file);
    assert.doesNotMatch(src, /0\.5\.\d/, `${file} 不应残留 0.5.x 版本号`);
    for (const match of src.matchAll(/from\s+["']([^"']+)["']/g)) {
      if (!match[1].startsWith(".")) continue;
      assert.ok(match[1].endsWith(".js?v=0.6.0"), `${file} 的相对 import ${match[1]} 必须带 ?v=0.6.0`);
    }
  }
});
