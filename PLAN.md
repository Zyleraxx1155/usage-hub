# usage-hub 实施任务书

> 版本 v1 · 2026-09-08 · 需求方：项目负责人 · 统筹：项目协调
> 本文件是需求边界与验收标准的唯一依据。实施中发现需要偏离，先回来确认，不要自行脑补。

## 1. 背景

现有两个 Hana 插件功能重叠、口径不一致：

| 插件 | 目录 | 问题 |
|------|------|------|
| session-insight（会话用量） | `~/.hanako/plugins/session-insight` | 视觉与交互好；缓存命中率口径错误；费用算不准且价格表硬编码 |
| token-tracker（Token 用量） | `~/.hanako/plugins/token-tracker` | 数据源全（ledger 全量）；前端杂；费用未接线 |

决定：合并为 **usage-hub**，以 session-insight 的视觉为壳，数据源换成 ledger 全量，**彻底不做费用计算**。

## 2. 硬约束（不可违反）

1. **不得修改、覆盖、删除、卸载 `session-insight` 与 `token-tracker`** 两个现有插件目录及其 plugin-data。它们必须保持可正常运行。
2. 开发目录固定为项目根目录（下文以 `<项目目录>` 代指）。
3. 插件 id 固定为 `usage-hub`，数据目录 `~/.hanako/plugin-data/usage-hub/`。
4. 读取旧插件文件一律只读；复制前端资源时先复制到新目录再改，严禁原地改源文件。
5. 验证通过并得到需求方确认前，不得停用或卸载旧插件。
6. 不引入 GPU、大型框架等重依赖；前端不引入 Chart.js，统一用自绘 SVG。

## 3. 数据源与口径

### 3.1 主数据源（全量调用）

- `~/.hanako/usage-ledger.json`：Hana 全量 LLM 调用账本。
  - 实测为**滚动窗口，只保留最近 5000 条**，当前仅覆盖 2026-09-03 至 09-08。
  - 结构：`{ version, entries: [...] }`，每条含 `source.subsystem`、`attribution.agentId`、`model.provider`、`model.modelId`、`usage.*`、`startedAt`。
- 自建归档 `~/.hanako/plugin-data/usage-hub/archive.json`：从 ledger 增量归档，**必须去重**（同一 `requestId` 只记一次）。
- 一次性迁移：只读导入 `~/.hanako/plugin-data/token-tracker/usage-archive.json`（实测 19772 条，覆盖 2026-07-22 起）。

### 3.2 辅助数据源（会话详情）

- `~/.hanako/agents/<agent>/sessions/*.jsonl`：会话逐轮序列、上下文窗口、混用模型识别。
- `~/.hanako/agents/<agent>/sessions/session-titles.json`：会话标题。

### 3.3 字段口径（已实测确认，不要再猜）

| 字段 | 含义 |
|------|------|
| `usage.cache.readTokens` | 本轮命中缓存的 token 数（**不是累计值**） |
| `usage.input.uncachedTokens` | 本轮未命中输入 |
| `usage.output.totalTokens` | 输出 |
| `usage.totalTokens` | = input + output + cacheRead |
| `usage.cache.hitRatio` | Hana 已算好的命中率 = readTokens ÷ (readTokens + uncachedTokens) |
| `usage.costTotal` | **恒为 0，禁止使用** |

验证结论：4511 条含 hitRatio 的记录，全部与 `cacheRead ÷ (cacheRead + uncachedInput)` 一致，零偏差。

### 3.4 聚合口径

- 命中率 = `Σ cacheRead ÷ Σ (cacheRead + uncachedInput)`；**不要**用总量或增量口径。
- 来源类型映射：

| subsystem / kind | 展示类型 |
|---|---|
| `session` | 会话 |
| `subagent` | 子代理 |
| `memory` | 记忆 |
| `automation` | 自动化 |
| `utility` | 实用 |
| `compaction` | 压缩 |
| `vision` | 视觉 |

## 4. 功能范围

### 4.1 保留（来自会话用量）

- 页面壳、主题同步、动效与视觉语言
- widget 状态条（当前模型、命中率、Token、上下文窗口）
- 会话详情：逐轮序列图表、上下文窗口占用、混用模型识别、会话选择器
- 余额与额度查询（仅 DeepSeek / Moonshot / Codex；智谱、OpenAI、xAI 明确 not_supported）

### 4.2 新增（来自 Token 用量）

- ledger 全量数据（会话 / 子代理 / 记忆 / 自动化 / 实用工具）
- 多维筛选：时间范围、agent、模型、供应商、来源类型
- 日趋势与小时趋势
- 缓存命中下钻（按 agent、按模型）
- （不包含费用、价格或消耗预测逻辑）

### 4.3 删除

- 全部费用 UI 与接口：会话费用、每轮费用、总消费、费用图表、`/api/total-cost`
- 价格表配置与编辑面板
- 峰谷计价与工作日判定逻辑
- Chart.js 依赖

### 4.4 补位

费用腾出的位置换成：命中率趋势、输入构成（未命中输入／缓存命中／输出／推理）、上下文窗口占用。

### 4.5 设置面板

只保留：余额查询凭据、余额/Codex 开关与轮询间隔、前端刷新间隔、显示偏好（隐藏 agent／模型）。不含价格表。

## 5. 分阶段实施

### 阶段 1：数据层与口径

1. 目录骨架 + `manifest.json`（contributes.page + widget，trust full-access）
2. ledger 读取器（滚动窗口处理）
3. 归档器：增量归档 + `requestId` 去重
4. 一次性迁移脚本：只读导入旧 token-tracker archive
5. 聚合接口：按时间／agent／模型／供应商／来源类型

**阶段验收**

- [ ] 命中率与 ledger 的 `hitRatio` 抽样逐条一致
- [ ] 子代理／记忆／自动化的消耗出现在统计中
- [ ] 归档导入后 2026-07-22 以来的趋势连续，无重复计数
- [ ] ledger 滚动覆盖（5000 条上限）不导致数据丢失

### 阶段 2：视图迁移

1. 从 session-insight **复制** `assets/panel.js`、`assets/panel.css`、`routes/ui.js` 到新插件
2. 删除全部费用 UI 与调用
3. 补位新指标
4. 搬入筛选栏、日与小时趋势、缓存命中下钻
5. 保留会话详情与 widget

**阶段验收**

- [ ] 全站无费用字段残留（grep 确认）
- [ ] 筛选、趋势、下钻数据正确
- [ ] 会话详情与旧 session-insight 一致
- [ ] 无 Chart.js 引用

### 阶段 3：配置与联调

1. 设置面板（余额凭据、刷新间隔、显示偏好）
2. 余额／额度查询接入（二选一，避免两套并存）
3. widget 接入
4. 端到端自测

**阶段验收**

- [ ] 余额查询返回真实数字
- [ ] widget 正常刷新
- [ ] 旧插件仍可独立运行、未被改动

## 6. 风险

| 风险 | 应对 |
|------|------|
| 归档去重错误导致趋势翻倍 | 以 `requestId` 为唯一键，导入前后条数比对 |
| 复制前端时误改旧文件 | 先复制到新目录，源目录只读 |
| ledger 滚动导致丢数据 | 归档频率高于窗口覆盖速度；启动时先归档再读 |
| 新旧插件同时订阅 token_usage 事件 | 数据独立，不影响；但需确认无端口/路由冲突 |
| 前端改造量大（panel.js 约 2264 行） | 分阶段提交，每阶段可验证 |

## 7. 协作分工

- 项目协调：需求边界、验收标准、复核结果、上线决策
- 测测：代码实现、测试、项目内文档
- 冷冷：上线前审计（数据口径、并发、迁移安全）
