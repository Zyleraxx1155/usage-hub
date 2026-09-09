// lib/ledger-reader.js — usage-ledger.json 读取器
//
// 主数据源结构（已实测）：{ version: 1, entries: [完整条目...] }
// 重要：这是滚动窗口，只保留最近 5000 条（实测覆盖约 6 天）。
// 窗口挤掉的数据必须由归档器（lib/archive.js）先行归档，读取器本身不负责防丢。

import fs from "node:fs";

/**
 * 读 ledger 文件。返回 { version, entries }。
 * 文件不存在返回 null；JSON 损坏抛出错误（由调用方决定降级策略）。
 */
export function readLedgerFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw);
  return {
    version: typeof data?.version === "number" ? data.version : 1,
    entries: Array.isArray(data?.entries) ? data.entries : [],
  };
}

/**
 * 读 ledger。主路径为直接读文件（PLAN 指定）；文件不可用且提供 bus 时
 * 回退宿主 API usage:list（与 token-tracker 相同的数据通道）。
 */
export async function readLedger({ filePath, bus } = {}) {
  if (filePath) {
    try {
      return { ...readLedgerFile(filePath), source: "file" };
    } catch (err) {
      if (!bus) throw err;
      // 文件读失败且可用 bus → 回退宿主 API
    }
  }
  if (bus) {
    const result = await bus.request("usage:list", {});
    return {
      version: result?.version ?? 1,
      entries: Array.isArray(result?.entries) ? result.entries : [],
      source: "bus",
    };
  }
  throw new Error("ledger unavailable: no file path and no bus");
}

/**
 * 条目是否可用于归档：必须有非空 requestId（唯一键）。
 */
export function isUsableEntry(e) {
  return Boolean(e && typeof e === "object" && typeof e.requestId === "string" && e.requestId.length > 0);
}
