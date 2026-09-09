// test/usage-hub-059.test.js — 0.5.9：余额上移、来源类型水平条、小时图横轴刻度
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const panelSource = () => fs.readFileSync(new URL("../assets/panel.js", import.meta.url), "utf8");
const cssSource = () => fs.readFileSync(new URL("../assets/panel.css", import.meta.url), "utf8");

test("0.5.9: 余额/额度卡排在消耗预测之前", () => {
  const source = panelSource();
  const balanceAt = source.indexOf('id="balanceCard"');
  const forecastAt = source.indexOf('id="forecastCard"');
  assert.ok(balanceAt > 0 && forecastAt > 0, "两个卡都应存在");
  assert.ok(balanceAt < forecastAt, "余额卡应在消耗预测卡之前");
});

test("0.5.9: hero 不再显示平均每轮耗时", () => {
  assert.doesNotMatch(panelSource(), /平均每轮耗时/);
});

test("0.5.9: 来源类型改水平堆叠条并显示总消耗", () => {
  const source = panelSource();
  assert.match(source, /function sourceBar\(rows, total\)/);
  assert.match(source, /sourceBar\(typeRows, typeTotal\)/);
  assert.match(source, /总消耗 \$\{fmtTokens\(typeTotal\)\}/);
  assert.match(cssSource(), /\.sb-track \{/);
  assert.match(cssSource(), /\.sb-seg \{/);
  assert.match(cssSource(), /\.sb-legend \{/);
});

test("0.5.9/0.5.16: 小时图横轴完整 24 刻度（0–23，0.5.16 起为纯数字）", () => {
  const source = panelSource();
  assert.match(source, /function xAxisLabels\(n, opts\)/);
  assert.match(source, /xLabels: hours\.map\(\(_, i\) => String\(i\)\)/);
  assert.match(source, /const hourEvery =/);
  assert.doesNotMatch(source, /xLabel: "0 时 ~ 23 时/);
});
