// test/usage-hub-refresh.test.js — 0.5.16 增量：静默刷新、archive 写盘节流、小时图 24 刻度、命中率表对齐与文案
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ARCHIVE_SAVE_MIN_INTERVAL_MS, archiveSaveDue } from "../lib/archive.js";

const readSource = (rel) => fs.readFileSync(new URL(rel, new URL("..", import.meta.url)), "utf8");
const panelSource = () => readSource("assets/panel.js");
const cssSource = () => readSource("assets/panel.css");
const indexSource = () => readSource("index.js");

test("静默刷新：自动/visibility 不显示刷新态、不重播动画；手动保留反馈", () => {
  const source = panelSource();
  // renderAll 支持 silent / feedback 两个开关
  assert.match(source, /async function renderAll\(options = \{\}\)/);
  assert.match(source, /const silent = options\.silent === true/);
  assert.match(source, /const feedback = options\.feedback !== false/);
  assert.match(source, /if \(feedback\) setLoading\(true\)/);
  assert.match(source, /if \(feedback\) setLoading\(false, ok\)/);
  // 自动定时器 / visibilitychange 走静默且无按钮反馈
  assert.match(source, /renderAll\(\{ silent: true, feedback: false \}\)/);
  // 手动按钮保留按钮反馈，但静默（不重播动画）
  assert.match(source, /refreshBtn\.addEventListener\("click", \(\) => renderAll\(\{ silent: true \}\)\)/);
  // 首次加载后常驻 .uh-silent
  assert.match(source, /await renderAll\(\{ silent: Boolean\(snapshot\) \}\)/);
  assert.match(source, /root\.classList\.add\("uh-silent"\)/);
  // 数字静默直赋
  assert.match(source, /animateNumbers\(root, silent\)/);
  assert.match(source, /function renderOdometer\(el, to, kind, silent\)/);
  assert.match(source, /if \(silent\) return;/);
  // CSS 关闭图表/数字动画
  const css = cssSource();
  assert.match(css, /\.uh-silent \.chart-card svg/);
  assert.match(css, /animation: none !important/);
});

test("archive 写盘节流：无变化不写、间隔不足不写、间隔足够且有变化才写", () => {
  assert.equal(ARCHIVE_SAVE_MIN_INTERVAL_MS, 300000);
  const now = 10_000_000;
  assert.equal(archiveSaveDue(0, now), true, "启动首刷（无历史值）允许写");
  assert.equal(archiveSaveDue(now - 1000, now), false, "间隔不足不写");
  assert.equal(archiveSaveDue(now - 299999, now), false);
  assert.equal(archiveSaveDue(now - 300000, now), true, "间隔足够才写");
  // 可注入小阈值
  assert.equal(archiveSaveDue(now - 50, now, 100), false);
  assert.equal(archiveSaveDue(now - 100, now, 100), true);

  const source = indexSource();
  // index.js 已改为 rollup 存储：仅在有新增时写 rollup，不再写 archive
  assert.match(source, /if \(stats\.added > 0\) \{/);
  assert.match(source, /saveRollup\(state\.paths\.rollup, state\.rollup\)/);
  assert.doesNotMatch(source, /saveArchive\(/);
  // archive 写盘节流工具仍在（archive.js 保留给迁移/历史）
  assert.equal(typeof archiveSaveDue, "function");
});

test("小时图：容器 >=560 每小时一刻度、纯数字标签、900px 不重叠且与柱对齐", () => {
  const source = panelSource();
  const everyDecl = source.match(/const hourEvery = [^;]+;/);
  assert.ok(everyDecl, "应存在 hourEvery");
  const everyOf = (hourW) => new Function("hourW", `${everyDecl[0]} return hourEvery;`)(hourW);
  assert.equal(everyOf(900), 1);
  assert.equal(everyOf(560), 1);
  assert.equal(everyOf(420), 2);
  assert.equal(everyOf(360), 3);

  // 纯数字标签 + 首尾居中 + 卡片补「小时」说明
  assert.match(source, /xLabels: hours\.map\(\(_, i\) => String\(i\)\)/);
  assert.match(source, /centerEnds: true/);
  assert.match(source, /横轴 · 小时/);

  // 几何：900px、24 刻度，slot 宽必须大于标签最大宽（"23" @11px 约 14px）
  const w = 900, axisW = 52, pad = 8, rightW = 42;
  const plotL = axisW + pad, plotR = w - pad - rightW;
  const slot = (plotR - plotL) / 24;
  assert.ok(slot > 16, `900px 下 slot=${slot.toFixed(1)} 应大于标签宽，24 个标签不重叠`);
  // 标签居中于柱子中心
  assert.match(source, /const center = plotL \+ i \* slot \+ slot \/ 2;/);
  assert.match(source, /const x = centerEnds \? center :/);
});

test("命中率表：数值列表头右对齐；标题改为 Agent 分布 / 模型分布", () => {
  const css = cssSource();
  assert.match(css, /\.hitrate-table th:not\(:first-child\) \{\s*text-align: right;/);
  const source = panelSource();
  assert.match(source, /"Agent 分布"/);
  assert.match(source, /"模型分布"/);
  assert.doesNotMatch(source, /"按 Agent"|"按模型"/);
});
