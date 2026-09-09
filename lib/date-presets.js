const SHANGHAI = "Asia/Shanghai";
const dayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: SHANGHAI });

export function shanghaiDay(value = new Date()) {
  return dayFormatter.format(value);
}

function shiftDay(day, amount) {
  const d = new Date(`${day}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + amount);
  return shanghaiDay(d);
}

export function datePresetRange(preset, now = new Date()) {
  const today = shanghaiDay(now);
  if (preset === "today") return { from: today, to: today };
  if (preset === "yesterday") { const day = shiftDay(today, -1); return { from: day, to: day }; }
  const [year, month, date] = today.split("-").map(Number);
  if (preset === "month") return { from: `${year}-${String(month).padStart(2, "0")}-01`, to: today };
  if (preset === "year") return { from: `${year}-01-01`, to: today };
  if (preset === "week") {
    const utc = new Date(Date.UTC(year, month - 1, date));
    const mondayOffset = (utc.getUTCDay() + 6) % 7;
    return { from: shiftDay(today, -mondayOffset), to: today };
  }
  return { from: "", to: "" };
}

export const DATE_PRESETS = Object.freeze([
  ["year", "本年"], ["month", "本月"], ["week", "本周"], ["yesterday", "昨天"], ["today", "今天"],
]);
