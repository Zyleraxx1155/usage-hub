// lib/pricing.js — DeepSeek 估算消费计价（纯函数，零网络、零 IO）
//
// 口径来源：docs/specs/2026-09-11-cost-estimation-and-balance-timer.md 第二节。
//  - 单位：元 / 百万 tokens；高峰价 = 空闲价 × 2
//  - 高峰时段：北京时间 周一至周五 09:00–12:00、14:00–18:00
//    （12:00 起、18:00 起为空闲；工作日午休 12:00–14:00、晚间与周末全天为空闲）
//  - 模型 → 档位：显式白名单优先；命中不到时仅对 `deepseek` 前缀的变体按子串兜底
//    （含 flash → Flash；含 pro → Pro），非 DeepSeek 家族一律不计价
//  - 仅 provider=deepseek 计价；网关（opencode-go 等）与未知模型不计价 → 计入 unpricedCalls
//    依据：opencode-go 等网关为订阅套餐（与 ChatGPT 订阅类似），不按 token 扣费，故只计数不计价（最终口径）
//  - 2026-09-14 12:00（北京）起，Pro 档模型整体路由到 V4.1 Flash，按 Flash 价计（官方脚注 2）
//  - cost 为「估算」，不代表真实账单（未剔除赠送额度等）
//
// 内部模块 import 必须带 ?v=<manifest.version>（见 index.js 顶部说明）。
import { cacheReadOf, uncachedOf, outputOf } from "./aggregate.js?v=0.7.3";

export const PRICING_VERSION = 1;
export const PRICING_CURRENCY = "CNY";

// 价格表：元 / 百万 tokens
const PRICES = Object.freeze({
  flash: Object.freeze({
    idle: Object.freeze({ hit: 0.02, miss: 1, output: 4 }),
    peak: Object.freeze({ hit: 0.04, miss: 2, output: 8 }),
  }),
  pro: Object.freeze({
    idle: Object.freeze({ hit: 0.15, miss: 4.5, output: 13.5 }),
    peak: Object.freeze({ hit: 0.30, miss: 9.0, output: 27.0 }),
  }),
});

// 模型 → 档位（大小写不敏感：规范化后先查显式白名单，再按 deepseek 前缀兜底）
const MODEL_TIERS = Object.freeze({
  "deepseek-v4-pro": "pro",
  "v4-pro": "pro",
  "deepseek-flash": "flash",
  "deepseek-v4-flash": "flash",
  "deepseek-v4-flash-vision-exp": "flash",
  "v4-flash": "flash",
  "v4.1-flash": "flash",
  "vision-exp": "flash",
});

// 2026-09-14 12:00 北京时间 = 04:00Z：Pro 档自此路由到 V4.1 Flash。
// 注意：该路由按「档位」生效，在实现上泛化到整个 pro 档——不仅 `deepseek-v4-pro`，
// 还包括别名 `v4-pro` 与兜底推断出的 pro（如 `deepseek-v4-pro-0813`），因为它们同指一个模型。
export const PRO_TO_FLASH_AT = "2026-09-14T04:00:00.000Z";

const PEAK_HOURS = new Set([9, 10, 11, 14, 15, 16, 17]);
const WEEKEND = new Set(["Sat", "Sun"]);
const BEIJING_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function beijingParts(at) {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const parts = BEIJING_FMT.formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  const hour = Number(get("hour"));
  if (!Number.isFinite(hour)) return null;
  return { weekday: get("weekday"), hour };
}

function normalizeModel(modelId) {
  return String(modelId || "").trim().toLowerCase();
}
function normalizeProvider(provider) {
  return String(provider || "").trim().toLowerCase();
}

/**
 * 基础档位（不含 9/14 路由）：显式白名单优先；命中不到时，**仅对 `deepseek` 前缀**的
 * 变体按子串兜底（含 flash → Flash；含 pro → Pro）。非 DeepSeek 家族一律 null。
 * 依据官方脚注 1：旧模型名仍可调用、按 Flash 价计费。
 */
function baseTierOf(modelId) {
  const name = normalizeModel(modelId);
  if (!name) return null;
  if (Object.prototype.hasOwnProperty.call(MODEL_TIERS, name)) return MODEL_TIERS[name];
  if (!name.startsWith("deepseek")) return null;
  if (name.includes("flash")) return "flash";
  if (name.includes("pro")) return "pro";
  return null;
}

/** 模型档位（含 2026-09-14 12:00 路由规则）。未知模型返回 null。 */
export function tierOf(modelId, at = "") {
  const base = baseTierOf(modelId);
  if (!base) return null;
  // Pro 档模型（含别名 v4-pro 与兜底推断出的 pro）在截止时刻后整体按 Flash 计价，因为同指一个模型
  if (base === "pro") {
    const t = Date.parse(at);
    if (Number.isFinite(t) && t >= Date.parse(PRO_TO_FLASH_AT)) return "flash";
  }
  return base;
}

/** 是否高峰时段（北京时间 周一至周五 09:00–12:00、14:00–18:00）。非法时间按空闲处理。 */
export function isPeak(at) {
  const p = beijingParts(at);
  if (!p) return false;
  if (WEEKEND.has(p.weekday)) return false;
  return PEAK_HOURS.has(p.hour);
}

/** 单价（元/百万 tokens）。不计价（非 deepseek 或未知模型）返回 null。 */
export function unitPrices({ provider, modelId, at } = {}) {
  if (normalizeProvider(provider) !== "deepseek") return null;
  const tier = tierOf(modelId, at);
  if (!tier) return null;
  const table = PRICES[tier][isPeak(at) ? "peak" : "idle"];
  return { hit: table.hit, miss: table.miss, output: table.output };
}

/**
 * 单条估算消费。
 * @returns {{ cost:number, priced:boolean, peak:boolean, tier:("pro"|"flash"|null) }}
 * 不计价时 cost=0、priced=false（调用方据此累加 unpricedCalls）。
 */
export function entryCost(entry) {
  const provider = entry?.model?.provider;
  const modelId = entry?.model?.modelId;
  const at = entry?.startedAt || entry?.endedAt || "";
  const prices = unitPrices({ provider, modelId, at });
  if (!prices) return { cost: 0, priced: false, peak: false, tier: null };
  const cacheRead = cacheReadOf(entry);
  const uncached = uncachedOf(entry);
  const output = outputOf(entry);
  const cost = (cacheRead / 1e6) * prices.hit + (uncached / 1e6) * prices.miss + (output / 1e6) * prices.output;
  return { cost, priced: true, peak: isPeak(at), tier: tierOf(modelId, at) };
}

/** 价格表元信息（供 GET /api/pricing）。不含凭据与内部路径。 */
export function pricingInfo() {
  const tierMeta = (id, label) => ({
    id,
    label,
    models: Object.keys(MODEL_TIERS).filter((m) => MODEL_TIERS[m] === id),
    idle: { ...PRICES[id].idle },
    peak: { ...PRICES[id].peak },
  });
  return {
    version: PRICING_VERSION,
    currency: PRICING_CURRENCY,
    unit: "per_million_tokens",
    peak: "工作日 09:00-12:00, 14:00-18:00 (Asia/Shanghai)",
    effectiveFrom: null,
    tiers: [tierMeta("flash", "Flash"), tierMeta("pro", "Pro")],
    note: "估算，非账单",
  };
}
