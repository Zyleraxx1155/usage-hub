// lib/forecast.js — 消耗预测（参照 token-tracker 的月度预测口径）
//
// 口径：
//   - 日界与小时均按 Asia/Shanghai。
//   - 日均消耗：最近 7 个「早于今天」的自然日平均；样本不足 2 天时整体返回 null。
//   - 今日预估：用历史（不含今天）小时累计占比外推今日全天；样本不足 3 天或占比过低时返回 null。
//   - 趋势：今日预估 vs 日均，±15% 以内视为持平。
//   - 月底预估：本月已消耗 + 日均 × 距月底天数。
// 仅做展示口径，不参与计费。

const DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });
const HOUR_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false });

function shanghaiDay(date) { return DAY_FMT.format(date); }
function shanghaiHour(date) { return Number(HOUR_FMT.format(date)); }

export function computeForecast({ daily = [], hourlyByDay = {} } = {}, now = new Date()) {
  const today = shanghaiDay(now);
  const past = daily
    .filter((row) => row && typeof row.date === "string" && row.date < today)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (past.length < 2) return null;

  const recent = past.slice(-7);
  const recentSum = recent.reduce((sum, row) => sum + (row.totalTokens || 0), 0);
  const dailyAvg = Math.round(recentSum / recent.length);

  // 历史小时累计占比（排除今天）
  const hourTotals = new Array(24).fill(0);
  let hourSampleDays = 0;
  for (const [day, hours] of Object.entries(hourlyByDay)) {
    if (day === today || !Array.isArray(hours)) continue;
    let hasData = false;
    for (const hour of hours) {
      const value = hour?.totalTokens || 0;
      if (value > 0) { hourTotals[Number(hour.hour) || 0] += value; hasData = true; }
    }
    if (hasData) hourSampleDays++;
  }
  const histTotal = hourTotals.reduce((a, b) => a + b, 0);
  let cumulativePct = null;
  if (hourSampleDays >= 3 && histTotal > 0) {
    cumulativePct = new Array(24);
    let running = 0;
    for (let hour = 0; hour < 24; hour++) {
      running += hourTotals[hour] / histTotal;
      cumulativePct[hour] = running;
    }
  }

  const todayTokens = daily.find((row) => row?.date === today)?.totalTokens || 0;
  const pctNow = cumulativePct ? cumulativePct[Math.min(23, shanghaiHour(now))] : null;
  const predictedToday = pctNow && pctNow > 0.05 ? Math.round(todayTokens / pctNow) : null;

  const monthPrefix = today.slice(0, 7);
  const monthToDate = daily
    .filter((row) => typeof row?.date === "string" && row.date.startsWith(monthPrefix))
    .reduce((sum, row) => sum + (row.totalTokens || 0), 0);
  const [year, month, dayOfMonth] = today.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const daysLeftInMonth = Math.max(0, daysInMonth - dayOfMonth);
  const projectedMonthEnd = Math.round(monthToDate + dailyAvg * daysLeftInMonth);

  let trend = "持平";
  if (predictedToday != null && dailyAvg > 0) {
    if (predictedToday > dailyAvg * 1.15) trend = "上升";
    else if (predictedToday < dailyAvg * 0.85) trend = "下降";
  }

  return {
    today,
    dailyAvg,
    predictedToday,
    trend,
    monthToDate,
    projectedMonthEnd,
    daysLeftInMonth,
    todayTokens,
    sampleDays: recent.length,
    hourSampleDays,
  };
}
