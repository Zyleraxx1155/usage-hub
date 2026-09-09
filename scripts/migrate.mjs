#!/usr/bin/env node
// scripts/migrate.mjs — 一次性迁移 CLI：只读导入 token-tracker 归档到 usage-hub
//
// 用法：
//   node scripts/migrate.mjs [--dry-run] [--force] [--dst <path>] [--home <homedir>]
//   --dry-run  只计算统计，不写任何文件（默认开启，写盘需显式 --apply）
//   --apply    实际写入 usage-hub archive.json + migration.json
//   --force    目标归档已存在时强制重跑
//   --dst      覆盖目标归档路径（默认 ~/.hanako/plugin-data/usage-hub/archive.json）
//   --src      覆盖源归档路径（默认 ~/.hanako/plugin-data/token-tracker/usage-archive.json）
//   --home     覆盖 HANA_HOME（默认 ~/.hanako）
//
// 源文件只读，绝不修改 token-tracker 目录。

import fs from "node:fs";
import path from "node:path";
import {
  hanaHome,
  ledgerPath,
  pluginDataDir,
  archivePath,
  migrationLogPath,
  tokenTrackerArchivePath,
} from "../lib/paths.js";
import { readLedgerFile } from "../lib/ledger-reader.js";
import { runMigration } from "../lib/migrate.js";

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

const args = process.argv.slice(2);
const dryRun = !args.includes("--apply");
const force = args.includes("--force");
const customHome = argValue(args, "--home") || hanaHome();
const customDst = argValue(args, "--dst");
const customSrc = argValue(args, "--src");

const home = customHome;
const src = customSrc || tokenTrackerArchivePath({ HANA_HOME: home, HOME: process.env.HOME });
const dst = customDst || archivePath(pluginDataDir({ HANA_HOME: home, HOME: process.env.HOME }));
const migLog = customDst ? path.join(path.dirname(customDst), "migration.json") : migrationLogPath(pluginDataDir({ HANA_HOME: home, HOME: process.env.HOME }));
const lp = ledgerPath({ HANA_HOME: home, HOME: process.env.HOME });

console.log(`usage-hub migration (dry-run=${dryRun}, force=${force})`);
console.log(`  src : ${src}`);
console.log(`  dst : ${dst}`);

// 源存在性
if (!fs.existsSync(src)) {
  console.error(`ERROR: token-tracker archive not found: ${src}`);
  process.exit(1);
}

// 当前账本（重叠时账本优先）
let ledgerEntries = [];
try {
  ledgerEntries = readLedgerFile(lp).entries;
  console.log(`  ledger: ${ledgerEntries.length} entries`);
} catch {
  console.log(`  ledger: unavailable (proceeding without overlap resolution)`);
}

// 源条目数（只读统计）
const srcArchive = JSON.parse(fs.readFileSync(src, "utf-8"));
const srcCount = Object.keys(srcArchive.entries || {}).length;
let srcMin = null;
let srcMax = null;
for (const r of Object.values(srcArchive.entries || {})) {
  if (r.t) {
    if (!srcMin || r.t < srcMin) srcMin = r.t;
    if (!srcMax || r.t > srcMax) srcMax = r.t;
  }
}
console.log(`  source entries: ${srcCount} (${srcMin} → ${srcMax})`);

const report = runMigration({ srcPath: src, dstPath: dst, migrationLogPath: migLog, ledgerEntries, force, dryRun });

console.log(`\nresult:`);
console.log(JSON.stringify(report, null, 2));

if (report.written) {
  const written = JSON.parse(fs.readFileSync(dst, "utf-8"));
  console.log(`\nwritten archive: ${Object.keys(written.entries).length} entries`);
} else if (dryRun && !report.error && report.stats) {
  const expected = (report.stats.ledgerMerged || 0) + (report.stats.imported || 0);
  console.log(`\n[dry-run] would write ${expected} entries to ${dst}`);
}
if (report.error) process.exitCode = 2;
