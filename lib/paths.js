// lib/paths.js — 路径解析（全部可注入，便于测试）
import path from "node:path";

/**
 * Hana 数据根目录：HANA_HOME 优先，回退 ~/.hanako。
 */
export function hanaHome(env = process.env) {
  const home = env.HANA_HOME || path.join(env.HOME || env.USERPROFILE || "", ".hanako");
  return home;
}

/**
 * 主数据源：Hana 全量调用账本（滚动窗口，实测只保留最近 5000 条）。
 */
export function ledgerPath(env = process.env) {
  return path.join(hanaHome(env), "usage-ledger.json");
}

/**
 * 本插件数据目录 ~/.hanako/plugin-data/usage-hub/。
 * 生产环境宿主会通过 ctx.dataDir 注入，这里作为回退。
 */
export function pluginDataDir(env = process.env) {
  return path.join(hanaHome(env), "plugin-data", "usage-hub");
}

/** 自建归档文件（requestId 去重）。 */
export function archivePath(dataDir) {
  return path.join(dataDir, "archive.json");
}

/** 一次性迁移记录（幂等依据）。 */
export function migrationLogPath(dataDir) {
  return path.join(dataDir, "migration.json");
}

/** 生成速度派生统计（mtime 增量缓存，只存派生数据不存会话原文）。 */
export function speedPath(dataDir) {
  return path.join(dataDir, "speeds.json");
}

/** 预聚合存储（0.6.0 起的主存储）。 */
export function rollupPath(dataDir) {
  return path.join(dataDir, "rollup.json");
}

/** 旧 token-tracker 归档（只读来源）。 */
export function tokenTrackerArchivePath(env = process.env) {
  return path.join(hanaHome(env), "plugin-data", "token-tracker", "usage-archive.json");
}
