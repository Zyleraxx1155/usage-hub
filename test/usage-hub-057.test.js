// test/usage-hub-057.test.js — 0.5.7：柱线整合、分布卡拆分、消耗预测
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { computeForecast } from "../lib/forecast.js";

const panelSource = () => fs.readFileSync(new URL("../assets/panel.js", import.meta.url), "utf8");
const apiSource = () => fs.readFileSync(new URL("../routes/api.js", import.meta.url), "utf8");

test("0.5.7: 消耗与命中率整合为柱+线双轴，每日命中率趋势卡并入", () => {
  const source = panelSource();
  assert.match(source, /function stackedComboChart\(rows, lineValues/);
  assert.match(source, /stackedComboChart\(rowsOf\(days\), dayHits/);
  assert.match(source, /stackedComboChart\(hourRows, hourHits/);
  assert.match(source, /每日消耗趋势/);
  assert.match(source, /小时消耗趋势/);
  assert.doesNotMatch(source, /data-chart="dailyHit"/, "每日命中率趋势卡已并入每日消耗趋势");
});

test("0.5.7: 分布卡只保留模型/Provider，命中率卡去掉公式说明", () => {
  const source = panelSource();
  assert.doesNotMatch(source, /Agent 消耗对比/, "Agent 消耗对比已由命中率分析表覆盖");
  assert.match(source, /模型 \/ Provider 分布/);
  assert.doesNotMatch(source, /缓存读取 ÷（/, "命中率标题不再挂公式说明");
});

test("0.5.7: forecast 接口与预测卡接线", () => {
  assert.match(apiSource(), /registerGet\("forecast"/);
  assert.match(apiSource(), /computeForecast\(r\)/);
  const source = panelSource();
  assert.match(source, /id="forecastCard"/);
  assert.match(source, /getForecast = \(\) => fetchJson\("\/api\/forecast"\)/);
  assert.match(source, /日均消耗/);
  assert.match(source, /月底预估/);
  assert.match(source, /距月底/);
});

test("0.5.7: 预测口径——日均取近 7 天、月底预估按剩余天数外推", () => {
  const now = new Date("2026-09-09T02:00:00Z"); // 上海 2026-09-09 10:00
  const daily = [];
  for (let d = 1; d <= 8; d++) daily.push({ date: `2026-09-${String(d).padStart(2, "0")}`, totalTokens: 1000 });
  daily.push({ date: "2026-09-09", totalTokens: 300 });
  const hourlyByDay = {};
  for (let d = 1; d <= 8; d++) {
    const day = `2026-09-${String(d).padStart(2, "0")}`;
    hourlyByDay[day] = Array.from({ length: 24 }, (_, h) => ({ hour: String(h).padStart(2, "0"), totalTokens: h < 12 ? 100 : 0 }));
  }
  const f = computeForecast({ daily, hourlyByDay }, now);
  assert.equal(f.today, "2026-09-09");
  assert.equal(f.dailyAvg, 1000);
  assert.equal(f.monthToDate, 8300);
  assert.equal(f.daysLeftInMonth, 21);
  assert.equal(f.projectedMonthEnd, 8300 + 1000 * 21);
  // 历史小时在 0-11 时均匀分布，10 时累计占比 11/12，300 ÷ (11/12) ≈ 327
  assert.equal(f.predictedToday, 327);
  assert.equal(f.trend, "下降");
});

test("0.5.7: 历史样本不足时预测整体返回 null", () => {
  assert.equal(
    computeForecast({ daily: [{ date: "2026-09-09", totalTokens: 1 }], hourlyByDay: {} }, new Date("2026-09-09T02:00:00Z")),
    null
  );
});
