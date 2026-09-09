// test/helpers.js — fixture 构造工具 + 临时目录统一管理（ESM）
import fs from "node:fs";
import path from "node:path";

// 临时目录统一落在项目 _tmp/ 下（工作区允许路径，且在 .gitignore 语义内），
// 并在进程退出时统一 rm -rf；不再往系统 /tmp 写，避免临时目录无限堆积。
const TMP_ROOT = path.join(process.cwd(), "_tmp");
const createdDirs = [];
const TMP_GUARD_LIMIT = 200;

/** 创建本次测试专用的临时目录（项目 _tmp/ 下），登记以便收尾统一清理。 */
export function tmpDir(name) {
  const dir = path.join(TMP_ROOT, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  createdDirs.push(dir);
  return dir;
}

/** 清理本次进程创建的全部临时目录（可在 after() 或进程退出时调用；可重复调用）。
 *  保留登记表，因为插件的后台任务（余额刷新 / 速度扫描）可能在 after() 之后又写回目录，
 *  进程退出钩子会再清一次（此时事件循环已空，为最终清理）。 */
export function cleanupTmpDirs() {
  for (const dir of createdDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/** 守卫：_tmp 顶层条目超过阈值时告警，便于及早发现未清理的临时目录。 */
export function guardTmpRoot() {
  try {
    const count = fs.readdirSync(TMP_ROOT).length;
    if (count > TMP_GUARD_LIMIT) {
      console.warn(`[usage-hub test] 警告：_tmp 顶层条目 ${count} > ${TMP_GUARD_LIMIT}，可能有临时目录未清理`);
    }
  } catch {}
}

// 兜底：即使测试文件忘了 after()，进程退出时也会清理 + 守卫。
process.on("exit", () => { cleanupTmpDirs(); guardTmpRoot(); });

export function makeEntry({
  requestId,
  startedAt = "2026-08-01T04:00:00.000Z",
  endedAt = "2026-08-01T04:00:01.000Z",
  subsystem = "session",
  kind = "session",
  agentId = "hanako",
  provider = "deepseek",
  modelId = "deepseek-v4-pro",
  input = 1000,
  uncached = 1000, // 与 input 相等代表本轮全部未命中
  output = 100,
  cacheRead = 0,
  totalTokens = null,
  hitRatio = null,
} = {}) {
  return {
    schemaVersion: 1,
    requestId,
    startedAt,
    endedAt,
    durationMs: 1000,
    status: "ok",
    source: { subsystem, surface: "desktop" },
    attribution: { kind, agentId, sessionId: "sess_" + requestId, sessionPath: "" },
    model: { provider, modelId, api: null },
    usage: {
      input: { totalTokens: input, uncachedTokens: uncached },
      output: { totalTokens: output },
      cache: {
        readTokens: cacheRead,
        writeTokens: 0,
        hit: cacheRead > 0,
        ...(hitRatio == null ? {} : { hitRatio }),
      },
      totalTokens: totalTokens ?? input + output + cacheRead,
    },
  };
}

// 模拟"迁移条目"：无 uncachedTokens、带 _migrated 标记（token-tracker 转换产物形状）
export function makeMigratedEntry({ requestId, startedAt = "2026-07-22T06:00:00.000Z", ...rest }) {
  const e = makeEntry({ requestId, startedAt, ...rest });
  e._migrated = true;
  e.usage.input.uncachedTokens = null;
  return e;
}
