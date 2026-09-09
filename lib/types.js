// lib/types.js — 来源类型映射（PLAN.md 3.4 口径，勿自行改动）
//
// 映射键：优先 source.subsystem，缺失时回退 attribution.kind。
// 实测 subsystem 取值：session / subagent / memory / automation / utility /
// compaction / vision / agent。
// 其中 "agent"（本地 Qwen 的 appearance_summary，实测 2 条）不在 PLAN 3.4 表内，
// 已由需求方（2026-09-08）确认：归入 other 保留数据即可，不新增映射。

export const SOURCE_TYPES = {
  session: "会话",
  subagent: "子代理",
  memory: "记忆",
  automation: "自动化",
  utility: "实用",
  compaction: "压缩",
  vision: "视觉",
};

/** 未映射类型统一归入 other，数据不丢弃。 */
export const TYPE_OTHER = "other";

/**
 * 返回条目的来源类型 key（见 SOURCE_TYPES）。
 * 未在 PLAN 3.4 表中的 subsystem/kind 返回 TYPE_OTHER。
 */
export function sourceTypeOf(entry) {
  const sub = entry?.source?.subsystem || "";
  if (sub && Object.prototype.hasOwnProperty.call(SOURCE_TYPES, sub)) return sub;
  const kind = entry?.attribution?.kind || "";
  if (kind && Object.prototype.hasOwnProperty.call(SOURCE_TYPES, kind)) return kind;
  return TYPE_OTHER;
}

/** 展示名。 */
export function sourceTypeLabel(type) {
  if (type === TYPE_OTHER) return "其他";
  return SOURCE_TYPES[type] || type;
}
