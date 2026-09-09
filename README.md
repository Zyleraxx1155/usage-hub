# usage-hub · 用量中心

> 以 Hana 全量账本（usage-ledger）为唯一数据源的 Token 用量统计插件。
> 参考 session-insight（视觉壳）与 token-tracker（全量数据源）的呈现方式，
> **彻底不做费用计算**（`usage.costTotal` 恒为 0，已禁用）。
>
> 当前 0.6.0（架构变更）：**存储从全量明细改为预聚合**（`rollup.json`）。数据接口使用 `/api/...` canonical 路径并保留 legacy alias；余额优先使用宿主 provider-catalog/auth 与 `ctx.network.fetch`；widget 通过宿主焦点消息解析 entryId；page 只展示全局用量。

**功能范围**：放弃单次调用明细、延迟分布、多条件交叉筛选；筛选维度只取第一个非空。

**已知限制（隐藏过滤边界）**：隐藏**助手**时所有维度精确排除；隐藏**模型**时总消耗 / 按模型分布 / 各 agent 行会排除它，但「来源类型」卡、Provider 分布、小时图仍含其贡献（预聚合无 type×model / hour×dim 交叉表）。按 agent 筛选时该行 byType 之和可能略大于行 total（byType 含被隐藏模型贡献，total 不含）。

## 目录结构

```
manifest.json         插件清单（id=usage-hub，minAppVersion 0.159.0，trust full-access）
package.json          零依赖 ESM
index.js              插件入口：onload → 读账本 → 迁移检查 → 归档 → 数据视图 → 定时归档
routes/api.js         聚合接口 + page/widget 占位
lib/
  paths.js            HANA_HOME / 数据目录 / 各文件路径（全部可注入）
  ledger-reader.js    usage-ledger.json 读取器（文件主路径，bus 回退）
  archive.js          旧归档器（保留 slimEntry 供 token-tracker 导入；主存储已改 rollup）
  rollup.js           预聚合存储：days/recentSessions/speeds、增量并入、archive→rollup 迁移
  speed-scan.js       生成速度扫描（JSONL mtime 增量 + ledger 口径）与保留期清理
  speed-stats.js      生成速度加权聚合
  migrate.js          一次性迁移：只读导入 token-tracker 归档
  aggregate.js        聚合：时间 / agent / 模型 / 供应商 / 来源类型
  types.js            来源类型映射（PLAN 3.4）
  session-reader.js    会话 JSONL 列表与详情读取（只读、安全降级）
  settings.js          dataDir/settings 下原子设置/凭据存储（凭据仅掩码输出）
  balance.js           DeepSeek/Moonshot 余额与可选 Codex 额度适配、状态与 last-good
scripts/
  migrate.mjs         迁移 CLI（dry-run 默认；--apply 写盘）
  verify-realdata.mjs 阶段 1 验收证据脚本（只读真实数据）
test/                 node:test 单元 + e2e（204 用例）
```

## 数据流

```
~/.hanako/usage-ledger.json（滚动窗口，仅最近 5000 条）
        │  增量并入（recentIds 判重，覆盖滚动窗口）
        ▼
~/.hanako/plugin-data/usage-hub/rollup.json（预聚合：days 全历史 + recentSessions 30 天）
        ▲  一次性迁移（只读 archive；archive 改名备份 archive.pre-rollup-<ts>.json）
~/.hanako/plugin-data/usage-hub/archive.json（旧全量明细，迁移后不再写）
        ▲  一次性导入（只读）
~/.hanako/plugin-data/token-tracker/usage-archive.json（历史）
```

- **归档频率**：manifest `refreshSeconds`（默认 60 秒）仅用于归档；前端刷新使用私有 `settings.ui.refreshSeconds`，余额轮询使用 `settings.balance.pollSeconds`，三者明确分离。
- **私有设置**：`dataDir/settings/settings.json` 与 `credentials.json` 均原子写入且权限收紧；保存空密钥保留已有值，公开 API 只返回 configured/masked。
- **余额安全边界**：首次 GET 无快照时前端主动刷新一次，之后仅按轮询/显式操作刷新；Codex 只有 `codexEnabled=true` 才读取 `~/.codex/auth.json`，不做费用、价格或金额估算。
- **启动顺序**：先读账本 → 首次迁移（archive→rollup，幂等）→ 增量并入 → 构建视图。
- **archive.json 现为导入中间件 / 只读来源**：0.6.0 起主存储是 `rollup.json`；archive 仅在首次迁移时读取并改名备份。`scripts/migrate.mjs` 仍产出 archive（供 token-tracker 导入 / 迁移用），不是运行时存储。
- **迁移条目**带 `_migrated: true`：旧归档无 `uncachedTokens`，命中率分母用
  `input.totalTokens` 近似；账本原生条目使用精确 `uncachedTokens`。

## 口径（PLAN 3.3，已实测验证）

| 字段 | 含义 |
|------|------|
| `usage.cache.readTokens` | 本轮命中缓存的 token 数（非累计） |
| `usage.input.uncachedTokens` | 本轮未命中输入 |
| `usage.totalTokens` | = input + output + cacheRead |
| 命中率 | `Σ cacheRead ÷ Σ (cacheRead + uncachedInput)`（总比口径） |
| agent 归属 | subagent 条目归真正的子代理（`source.actor.agentId` / 瘦身后的 `attribution.actorAgentId`），其余归 `attribution.agentId`，缺失回退父 agent |
| Token 平均速率 | 加权 `Σout ÷ Σ间隔`（过滤 100ms~10min）；见 `CONTEXT.md`「Token 平均速率」 |
| `usage.costTotal` | 恒为 0，**禁用** |

来源类型（PLAN 3.4）：session/会话 · subagent/子代理 · memory/记忆 ·
automation/自动化 · utility/实用 · compaction/压缩 · vision/视觉。
实测 ledger 中存在 2 条 `subsystem="agent"`（本地模型 appearance_summary），
不在 PLAN 3.4 表内，**已由需求方确认（2026-09-08）：归 `other` 保留数据，不新增映射**。

## 聚合接口

以下插件内部 canonical 路径均由 `hana.api.fetch` 调用；Hana 宿主插件路由契约要求使用 `/api/...`，同时保留无前缀 legacy alias 兼容旧资源。全部支持筛选参数：`from` / `to`（YYYY-MM-DD，含端点，Asia/Shanghai 日界）、
`agent` / `model` / `provider` / `type`（来源类型 key）。**筛选维度只取第一个非空**（优先级 agent→model→provider→type），外部直接调 API 时同样适用。

| 接口 | 说明 |
|------|------|
| `GET /api/status` | 数据状态、迁移报告、窗口范围 |
| `GET /api/summary` | 总览 + byType |
| `GET /api/daily` | 日趋势（含每日命中率） |
| `GET /api/hourly?day=` | 单天 24 小时连续序列 |
| `GET /api/by-agent` `/api/by-model` `/api/by-provider` `/api/by-type` | 多维聚合 |
| `GET /api/speed?sessionId=` | Token 平均速率（加权，ledger + JSONL 双口径）；支持 `sessionId` 过滤 |
| `GET /api/coverage` | 趋势连续性诊断（缺口/重复） |
| `GET /api/sessions` | 会话列表（支持 `agent` / `limit`；按设置过滤隐藏 agent/model；`source` 标明配置/当前 session/default agent，warnings 只返回稳定码，不暴露本地路径） |
| `GET /api/current-session` | 只读宿主明确提供的当前焦点会话 JSONL；无法可靠确定时返回空态，不回退全局最新记录 |
| `GET /api/session-detail` | 单会话详情（支持 `sessionId` + `file` + `agent` / `limit`；仅 sessionId 匹配多个时返回 409 `ambiguous_session_id`） |
| `POST /api/refresh` | 手动归档 + 重建视图 |
| `GET/POST /api/settings` | 显示偏好（逐项 hiddenAgents/hiddenModels）、前端刷新间隔、余额/Codex 开关、轮询间隔；GET 不返回密钥 |
| `GET /api/balance` | 最后一次余额/额度快照（无网络），来源明确标记 kind=balance/quota |
| `POST /api/balance/refresh` | 显式读取余额/额度；并发请求去重，状态含 unavailable/unauthorized/network/malformed_response；失败保留 last-good 并标 stale |

## 一次性迁移

插件首次启动（归档为空）自动执行；也可手动：

```bash
# 演练（只计算，不写盘）
node scripts/migrate.mjs --src ~/.hanako/plugin-data/token-tracker/usage-archive.json --dst _tmp/migrate-run/archive.json

# 实际写盘（生产路径，或 --dst 指定）
node scripts/migrate.mjs --apply [--force]
```

## 测试

```bash
node --test "test/*.test.js"   # 204 用例：单元 + e2e（临时目录隔离，不触碰真实数据）
node scripts/verify-realdata.mjs  # 真实数据验收证据（只读）
```
