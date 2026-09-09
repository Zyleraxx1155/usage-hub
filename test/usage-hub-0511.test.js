// test/usage-hub-0511.test.js — 0.5.11：Codex 独立卡、类型/会话切换、卡片间距、侧栏补齐
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const panelSource = () => fs.readFileSync(new URL("../assets/panel.js", import.meta.url), "utf8");
const cssSource = () => fs.readFileSync(new URL("../assets/panel.css", import.meta.url), "utf8");
const balanceSource = () => fs.readFileSync(new URL("../lib/balance.js", import.meta.url), "utf8");
const apiSource = () => fs.readFileSync(new URL("../routes/api.js", import.meta.url), "utf8");

test("0.5.11: Codex 额度拆为独立卡（双圆环 + 重置时间）", () => {
  const source = panelSource();
  assert.match(source, /id="codexCard"/);
  assert.match(source, /function renderCodexCard\(\)/);
  assert.match(source, /function fmtResetAt\(value\)/);
  assert.match(source, /cx-cell/);
  assert.match(source, /重置<\/div>/);
  assert.match(cssSource(), /\.codex-layout \{/);
  assert.match(cssSource(), /\.cx-cell \{/);
});

test("0.5.11: 后端 codex 返回窗口明细并进入公开响应", () => {
  const source = balanceSource();
  assert.match(source, /function codexWindowLabel\(id, seconds\)/);
  assert.match(source, /, windows \};/);
  assert.match(source, /"windows", "planType"\]\)/);
});

test("0.5.11: 小时图支持类型/会话切换", () => {
  const source = panelSource();
  assert.match(source, /id="hourlySwitch"/);
  assert.match(source, /HOURLY_MODE_KEY/);
  assert.match(source, /state\.hourlyBySession/);
  assert.match(apiSource(), /hourlyBySession/);
  assert.match(cssSource(), /\.tc-switch \{/);
});

test("0.5.11: 卡片间距统一", () => {
  const css = cssSource();
  assert.match(css, /\.chart-card \{[^}]*margin-bottom: 16px/);
  assert.match(css, /\.chart-grid \.chart-card \{ margin-bottom: 0; \}/);
  assert.match(css, /\.settings-grid \.chart-card \{ margin-bottom: 0; \}/);
});

test("0.5.11: 侧栏补齐总消耗、输入构成图例与本会话供应商", () => {
  const source = panelSource();
  assert.match(source, /<span>总消耗<\/span>/);
  assert.match(source, /class="w-legend"/);
  assert.match(source, /id="wTypeList"/);
  assert.match(source, /function providerLabel\(id\)/);
});
