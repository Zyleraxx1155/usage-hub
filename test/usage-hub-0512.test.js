// test/usage-hub-0512.test.js — 0.5.12：hero 数字字形统一、顶部按钮等高
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const panelSource = () => fs.readFileSync(new URL("../assets/panel.js", import.meta.url), "utf8");
const cssSource = () => fs.readFileSync(new URL("../assets/panel.css", import.meta.url), "utf8");

test("0.5.12: hero 数字与单位同字体流渲染", () => {
  const css = cssSource();
  const source = panelSource();
  assert.match(css, /font-variant-numeric: lining-nums/);
  assert.match(css, /font-feature-settings: "lnum" 1/);
  assert.match(css, /\.cnt\.hmv-pop/);
  assert.doesNotMatch(source, /od\.style\.width/, "逐位数字盒子已移除");
});

test("0.5.12: 顶部按钮统一最小高度", () => {
  assert.match(cssSource(), /\.head > button \{ min-height: 38px; \}/);
});
