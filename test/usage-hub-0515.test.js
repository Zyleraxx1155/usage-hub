// test/usage-hub-0515.test.js — 0.5.15：横轴铺满、K 大写、筛选框样式、ChatGPT 改名与套餐、会话按 sessionId、聚合缓存
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const panelSource = () => fs.readFileSync(new URL("../assets/panel.js", import.meta.url), "utf8");
const cssSource = () => fs.readFileSync(new URL("../assets/panel.css", import.meta.url), "utf8");
const balanceSource = () => fs.readFileSync(new URL("../lib/balance.js", import.meta.url), "utf8");
const apiSource = () => fs.readFileSync(new URL("../routes/api.js", import.meta.url), "utf8");
const aggSource = () => fs.readFileSync(new URL("../lib/aggregate.js", import.meta.url), "utf8");

test("0.5.15: 小时图横轴每小时一个刻度，K 改为大写", () => {
  const source = panelSource();
  assert.match(source, /const hourEvery =/);
  assert.match(source, /if \(n >= 1e3\) return \(n \/ 1e3\)\.toFixed\(1\) \+ "K";/);
  assert.doesNotMatch(source, /\+ "k";/);
});

test("0.5.15: 余额筛选框与刷新按钮同风格", () => {
  const css = cssSource();
  assert.match(css, /\.source-filter \{/);
  assert.match(css, /appearance: none/);
  assert.match(css, /min-height: 38px/);
});

test("0.5.15: Codex 改名为 ChatGPT 并显示套餐版本", () => {
  assert.match(balanceSource(), /id === "codex" \? "ChatGPT"/);
  assert.match(balanceSource(), /label: "ChatGPT"/);
  assert.match(balanceSource(), /planType: data\?\.plan_type/);
  assert.match(panelSource(), /"openai-codex": "ChatGPT"/);
  assert.match(panelSource(), /ChatGPT 额度/);
});

test("0.5.15: 小时图「会话」按 sessionId 聚合而非 agentId", () => {
  assert.match(aggSource(), /attribution\?\.sessionId \|\| "unknown"/);
  assert.match(apiSource(), /hourlyBySession/);
  assert.match(panelSource(), /state\.hourlyBySession/);
  assert.match(panelSource(), /function sessionLabel\(id\)/);
  assert.match(panelSource(), /data-mode="session"/);
});

test("0.5.15: 聚合结果按筛选条件缓存，首屏只算一次", () => {
  const source = apiSource();
  assert.match(source, /const aggregateCache = new Map\(\)/);
  assert.match(source, /function aggregateCached\(data, filters\)/);
  assert.doesNotMatch(source, /const r = aggregateEntries\(data\.entries, filtersOf\(c, ctx\)\)/);
});

test("0.5.15: 侧栏上下文窗口照会话用量呈现", () => {
  const source = panelSource();
  const css = cssSource();
  assert.match(source, /id="wContextText"/);
  assert.match(source, /id="wContextFill"/);
  assert.match(source, /id="wContextThreshold"/);
  assert.match(source, /const CONTEXT_WINDOW = \{/);
  assert.match(source, /COMPACT_THRESHOLD/);
  assert.match(source, /距压缩约/);
  assert.match(css, /\.w-ctx-track \{/);
  assert.match(css, /\.w-ctx-fill \{/);
  assert.match(css, /\.w-ctx-threshold \{/);
});
