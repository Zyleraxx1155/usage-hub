// test/usage-hub-0510.test.js — 0.5.10：POST 透传、设置抽屉不重建、Codex 默认开启、趋势图复刻用量
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { DEFAULT_SETTINGS } from "../lib/settings.js";

const panelSource = () => fs.readFileSync(new URL("../assets/panel.js", import.meta.url), "utf8");
const cssSource = () => fs.readFileSync(new URL("../assets/panel.css", import.meta.url), "utf8");

test("0.5.10: fetchJson 透传 init，POST 不再被吞成 GET", () => {
  const source = panelSource();
  assert.match(source, /async function fetchJson\(path, init = \{\}\)/);
  assert.match(source, /\.\.\.init, signal: AbortSignal\.timeout\(15000\)/);
  assert.match(source, /postJson\("\/api\/settings"/);
});

test("0.5.10: 设置抽屉打开时不重建，避免勾选被定时刷新重置", () => {
  const source = panelSource();
  assert.match(source, /classList\.contains\("open"\) === true/);
  assert.match(source, /if \(!drawerOpen\) \{/);
});

test("0.5.10: Codex 额度默认开启（对齐用量）", () => {
  assert.equal(DEFAULT_SETTINGS.balance.codexEnabled, true);
});

test("0.5.10: 趋势图复刻用量——堆叠柱 + 命中率折线 + 顶部图例", () => {
  const source = panelSource();
  assert.match(source, /function stackedComboChart\(rows, lineValues/);
  assert.match(source, /function chartLegend\(keys, keyLabels, colors, lineLabel\)/);
  assert.match(source, /const TYPE_COLORS = \{/);
  assert.match(source, /stackedComboChart\(rowsOf\(days\), dayHits/);
  assert.match(source, /stackedComboChart\(hourRows, hourHits/);
  assert.match(cssSource(), /\.ct-legend \{/);
});

test("0.5.10: 取消点击放大、弹窗与卡片玻璃光效", () => {
  const source = panelSource();
  assert.doesNotMatch(source, /cc-zoom/, "放大图标与绑定已移除");
  assert.doesNotMatch(source, /openChartModal/, "弹窗逻辑已移除");
  assert.doesNotMatch(source, /class="chart-card glass"/, "图表卡不再使用 glass");
  assert.doesNotMatch(source, /combo-legend/, "静态图例改为动态 chartLegend");
});
