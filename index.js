// index.js — usage-hub 插件入口
//
// onload 流程（顺序即防丢数据的关键）：
//   1. 解析数据目录（ctx.dataDir 优先，回退 ~/.hanako/plugin-data/usage-hub）
//   2. 首次：加载 rollup.json；不存在则从 archive.json 迁移（archive 改名备份后不再写）
//   3. 增量：读 ledger → mergeLedgerIntoRollup（recentIds 判重）→ 原子写 rollup
//   4. 定时刷新（refreshSeconds，默认 60 秒，远快于窗口覆盖速度）
//   5. 后台余额定时刷新（balance.pollSeconds，默认 300 秒）：按周期联网刷新并落盘 balance.json
//
// 所有数据状态挂在 ctx._usageHub，路由与 widget 共享。

// 注意：所有插件内部模块 import 必须携带 ?v=<manifest.version>。
// Hana 宿主只对插件入口文件做 cache-bust（?t=时间戳），其内部相对 import 会命中
// Node 的 ESM 模块缓存；不带版本参数时，插件更新后仍会加载旧版 lib，导致
// "does not provide an export named ..." 使整个路由模块加载失败、数据接口全部 404。
// 规则：任何 lib 改动都必须 bump manifest/package/UI 缓存版本并同步此参数。
import {
  hanaHome,
  ledgerPath,
  pluginDataDir,
  archivePath,
  migrationLogPath,
  tokenTrackerArchivePath,
  speedPath,
  rollupPath,
} from "./lib/paths.js?v=0.8.0";
import { readLedger } from "./lib/ledger-reader.js?v=0.8.0";
import { runMigration } from "./lib/migrate.js?v=0.8.0";
import { emptyRollup, loadRollup, saveRollup, mergeLedgerIntoRollup, migrateArchiveToRollup, ROLLUP_VERSION } from "./lib/rollup.js?v=0.8.0";
import { deriveSessionsDirInfo, allAgentSessionDirs } from "./lib/session-reader.js?v=0.8.0";
import { buildProjectSummary, PROJECT_SUMMARY_EVENT } from "./lib/project-summary.js?v=0.8.0";
import { loadSettings } from "./lib/settings.js?v=0.8.0";
import { createBalanceService } from "./lib/balance.js?v=0.8.0";
import { emptySpeedCache, loadSpeedCache, saveSpeedCache, scanSessionSpeeds, flattenSpeedRecords, agentSessionDirs, shouldPersistSpeedCache, pruneSpeedCache } from "./lib/speed-scan.js?v=0.8.0";
import fs from "node:fs";
import path from "node:path";

export default class UsageHubPlugin {
  async onload() {
    const { ctx } = this;
    const { dataDir, config, log, bus } = ctx;
    const env = process.env;

    const resolvedDataDir = dataDir || pluginDataDir(env);
    const sessionsConfig = config.get("sessionsDir") ? { path: config.get("sessionsDir"), source: "configured-sessions" } : deriveSessionsDirInfo(ctx);
    const state = {
      ready: false,
      data: null,
      paths: {
        dataDir: resolvedDataDir,
        ledger: ledgerPath(env),
        archive: archivePath(resolvedDataDir),
        rollup: rollupPath(resolvedDataDir),
        migrationLog: migrationLogPath(resolvedDataDir),
        tokenTrackerArchive: tokenTrackerArchivePath(env),
        sessionsDir: sessionsConfig.path,
        sessionsDirSource: sessionsConfig.source,
        sessionsDirWarning: sessionsConfig.warning || null,
        speed: speedPath(resolvedDataDir),
      },
      rollup: null,
      migration: null,
      agentNames: {},
      lastRefreshAt: null,
      lastRefreshError: null,
      refresh: null,
      // 生成速度：JSONL 口径缓存（mtime 增量）+ ledger 口径记录合并池
      speeds: { cache: null, records: [], updatedAt: null, scanning: false },
    };
    state.settings = loadSettings(resolvedDataDir).settings;
    state.balance = createBalanceService({
      dataDir: resolvedDataDir,
      log,
      fetchFn: typeof ctx.network?.fetch === "function" ? ctx.network.fetch.bind(ctx.network) : undefined,
      networkFetch: ctx.network?.fetch,
      dataRoot: ctx.dataRoot || config.get("dataRoot") || "",
      pathCandidates: [ctx.pluginDir, ctx.dataDir, config.get("dataRoot"), config.get("sessionsDir")].filter(Boolean),
      pluginDir: ctx.pluginDir || "",
      providerCatalog: ctx.providerCatalog || config.get("providerCatalog"),
      auth: ctx.auth || config.get("auth"),
      config,
    });
    ctx._usageHub = state;

    // 稳定的只读跨插件契约：只接受 session ID，返回派生汇总，不暴露内部存储。
    if (bus?.handle) {
      this.register(bus.handle(PROJECT_SUMMARY_EVENT, (payload) => {
        const h = ctx._usageHub;
        const dirs = [h?.paths?.sessionsDir, ...allAgentSessionDirs(path.join(hanaHome(env), "agents"))].filter(Boolean);
        return buildProjectSummary({ payload, sessionsDirs: [...new Set(dirs)], ready: h?.ready === true, builtAt: h?.lastRefreshAt || null });
      }));
    }

    // 余额定时刷新：启动后不立即联网（首个 pollSeconds 周期到达再刷），避免与首屏争抢；
    // enabled=false 时不联网；与用量 refresh 定时器相互独立、互不阻塞。

    // 取 agentId → 中文名映射（失败降级为空映射，不阻断加载）
    try {
      const agentList = await bus.request("agent:list");
      const names = {};
      for (const item of agentList?.agents || []) {
        if (item?.id) names[item.id] = item.name || item.id;
      }
      state.agentNames = names;
      log?.info?.(`[usage-hub] agent names: ${Object.keys(names).length}`);
    } catch (err) {
      state.agentNames = {};
      log?.warn?.("[usage-hub] agent:list failed:", err?.message || err);
    }

    const refreshSeconds = Math.max(10, Number(config.get("refreshSeconds") || 60) || 60);

    // 生成速度扫描目录：配置/默认 sessionsDir + ~/.hanako/agents/*/sessions（各 agent）
    const agentsRoot = path.join(hanaHome(env), "agents");
    const speedDirs = [...new Set([sessionsConfig.path, ...agentSessionDirs(agentsRoot)].filter(Boolean))];

    const rebuildSpeedRecords = () => {
      const jsonl = flattenSpeedRecords(state.speeds.cache || emptySpeedCache());
      const ledger = state.rollup?.speeds || [];
      state.speeds.records = [...jsonl, ...ledger];
      state.speeds.updatedAt = new Date().toISOString();
    };

    // 后台增量扫描：异步 IO + mtime/size 缓存，不阻塞首屏；同一时刻只跑一个
    const scanSpeeds = async () => {
      if (state.speeds.scanning) return;
      state.speeds.scanning = true;
      try {
        if (!state.speeds.cache) {
          try { state.speeds.cache = loadSpeedCache(state.paths.speed) || emptySpeedCache(); }
          catch (err) { log?.warn?.("[usage-hub] speed cache load failed (corrupt kept):", err?.message || err); state.speeds.cache = emptySpeedCache(); }
        }
        const result = await scanSessionSpeeds({ sessionsDirs: speedDirs, cache: state.speeds.cache, warn: (m) => log?.warn?.("[usage-hub] speed:", m) });
        state.speeds.cache = result.cache;
        // 保留期清理（30 天 / 每文件 500 / 总量 2 万）在写入时顺手做
        const pruned = pruneSpeedCache(state.speeds.cache);
        rebuildSpeedRecords();
        // 仅在内容变化、文件集合增删或清理过时落盘；纯 reused 跳过
        if (shouldPersistSpeedCache(result) || pruned > 0) {
          try { saveSpeedCache(state.paths.speed, state.speeds.cache); } catch (err) { log?.warn?.("[usage-hub] speed cache write failed:", err?.message || err); }
        }
        log?.info?.(`[usage-hub] speed scan: dirs=${speedDirs.length} changed=${result.changed} reused=${result.reused} skipped=${result.skipped} pruned=${pruned} records=${state.speeds.records.length}`);
      } catch (err) {
        log?.warn?.("[usage-hub] speed scan failed:", err?.message || err);
      } finally {
        state.speeds.scanning = false;
      }
    };
    state.scanSpeeds = scanSpeeds;

    const refresh = async () => {
      try {
        // ── 1. 读账本 ──
        const ledger = await readLedger({ filePath: state.paths.ledger, bus });

        // ── 2. 首次：加载 rollup；不存在则从 archive 迁移（archive 不存在则先跑 token-tracker 导入）──
        if (!state.rollup) {
          try { state.rollup = loadRollup(state.paths.rollup); }
          catch (err) { log?.warn?.("[usage-hub] rollup load failed (corrupt kept):", err?.message || err); state.rollup = null; }
          if (!state.rollup) {
            if (!fs.existsSync(state.paths.archive) && !state.migration) {
              try {
                state.migration = runMigration({
                  srcPath: state.paths.tokenTrackerArchive,
                  dstPath: state.paths.archive,
                  migrationLogPath: state.paths.migrationLog,
                  ledgerEntries: ledger.entries,
                  force: false,
                  dryRun: false,
                });
                if (state.migration.error) log?.warn?.("[usage-hub] migration issue:", state.migration.error);
              } catch (err) {
                state.migration = { error: String(err?.message || err) };
                log?.warn?.("[usage-hub] migration unavailable:", state.migration.error);
              }
            }
            if (fs.existsSync(state.paths.archive)) {
              try {
                const migrated = migrateArchiveToRollup(state.paths.archive, state.paths.rollup, {
                  seedRequestIds: ledger.entries.map((e) => e?.requestId).filter(Boolean),
                  ledgerEntries: ledger.entries,
                });
                state.rollup = migrated.rollup;
                log?.info?.(`[usage-hub] rollup migrated from archive; backup=${migrated.backupPath ? path.basename(migrated.backupPath) : "none"} actorRecovered=${migrated.actorRecovered} actorUnrecovered=${migrated.actorUnrecovered}${migrated.backupError ? " backupError=" + migrated.backupError : ""}`);
                if (migrated.actorUnrecovered > 0) log?.warn?.(`[usage-hub] ${migrated.actorUnrecovered} 个 subagent 条目无法从账本补回子代理归属（已回退父 agent）`);
              } catch (err) {
                log?.warn?.("[usage-hub] archive→rollup migration failed (archive kept):", err?.message || err);
                state.rollup = emptyRollup();
              }
            } else {
              state.rollup = emptyRollup();
            }
          }
        }

        // ── 3. 增量并入账本（recentIds 判重，避免滚动窗口重复计入）──
        const stats = mergeLedgerIntoRollup(state.rollup, ledger.entries);
        if (stats.added > 0) {
          try { saveRollup(state.paths.rollup, state.rollup); } catch (err) { log?.warn?.("[usage-hub] rollup write failed (memory view continues):", err?.message || err); }
        }

        state.data = {
          builtAt: new Date().toISOString(),
          rollup: state.rollup,
          ledgerCount: ledger.entries.length,
          days: Object.keys(state.rollup.days || {}).length,
          recentSessions: Object.keys(state.rollup.recentSessions || {}).length,
          lastMerge: stats,
        };
        state.lastRefreshAt = state.data.builtAt;
        state.lastRefreshError = null;
        state.ready = true;
        rebuildSpeedRecords();
        log?.info?.(`[usage-hub] refresh: ledger=${ledger.entries.length} days=${state.data.days} recentSessions=${state.data.recentSessions} (added ${stats.added})`);
        // 首屏不等待速度扫描：后台增量执行
        scanSpeeds().catch(() => {});
      } catch (err) {
        state.lastRefreshError = String(err?.message || err);
        log?.warn?.("[usage-hub] refresh failed:", state.lastRefreshError);
      }
    };

    state.refresh = refresh;
    await refresh();

    const intervalMs = refreshSeconds * 1000;
    const timer = setInterval(() => {
      refresh().catch(() => {});
    }, intervalMs);
    timer.unref?.();
    this.register(() => clearInterval(timer));

    // 后台余额定时刷新：按 settings.balance.pollSeconds 周期刷新并落盘 balance.json。
    // settings 保存后（routes/api.js POST /api/settings）会调用 state.restartBalanceTimer 重建，
    // 保证 pollSeconds 变化即时生效且不产生重复定时器。
    const clampPollSeconds = (value) => Math.min(86400, Math.max(60, Number(value) || 300));
    let balanceTimer = null;
    const stopBalanceTimer = () => { if (balanceTimer) { clearInterval(balanceTimer); balanceTimer = null; } };
    const restartBalanceTimer = () => {
      stopBalanceTimer();
      balanceTimer = setInterval(() => {
        if (state.settings?.balance?.enabled === false) return; // 禁用：不联网
        // refresh() 内部已 catch；外层再兜一层，失败不影响用量刷新
        Promise.resolve(state.balance?.refresh?.()).catch(() => {});
      }, clampPollSeconds(state.settings?.balance?.pollSeconds) * 1000);
      balanceTimer.unref?.();
    };
    restartBalanceTimer();
    this.register(stopBalanceTimer);
    state.restartBalanceTimer = restartBalanceTimer;

    log?.info?.(`[usage-hub] loaded: dataDir=${resolvedDataDir} refresh=${refreshSeconds}s rollupVersion=${ROLLUP_VERSION}`);
  }
}
