# usage-hub 自测报告（0.6.0 预聚合存储）

> 2026-09-09 本轮全量自动化测试 **204 pass / 0 fail**；所有项目 JS 均可正常 import。未启动浏览器、端口或真实网络；测试写盘仅位于临时夹具。
>
> 版本说明：本批自 **0.6.0** 起发布（架构变更：存储从全量明细改为预聚合）。

## 0.6.0 新增覆盖
- **预聚合存储 `rollup.json`**：`days`（全历史，含 total/hours+byType/byType/byAgent+交叉表/byModel/byProvider）、`recentSessions`（30 天）、`speeds`（账本口径）、`recentIds`（5000 判重）；原子写 + 损坏改名 `.corrupt-*`。新增 `lib/rollup.js`。
- **迁移**：首次加载从 `archive.json` 聚合出 rollup；先写 rollup 再把 archive 改名备份 `archive.pre-rollup-<ts>.json`（不覆盖、不删除）；失败不动原文件；重复启动幂等。
- **读取链路**：新增 `aggregateRollup`（输出契约与 `aggregateEntries` 对齐）；`index.js`/`routes/api.js` 切到 rollup；`hourlyBySession` 由 `recentSessions` 生成（键 sessionId）；`/api/status` 加 `lastSpeedScanAt`；`/api/summary` 返回 `degraded`。
- **子代理归属修正**：`agentOf()` 统一（subagent 归 `source.actor.agentId`/`attribution.actorAgentId`，缺失回退父 agent）；`slimEntry` 保留 `actorAgentId`。
- **筛选降级**：`from/to` 始终生效；维度只取第一个非空；按 agent 筛选分布卡走交叉表，其余维度筛选下分布卡/小时图显示时间范围全量并标注。
- **前端**：hero「Token 平均速率」；widget 模型速率卡片式、上下文占用百分比；页脚「上次后台扫描」。
- **真实数据逐项对比（副本，新旧两套实现）**：summary / daily / hourly（总量 + byType）/ byType / byAgent / byModel / byProvider / hitRatio / speed（tps/textTps/count/byModel/byAgent）**全部一致**；各 agent 之和 = 总消耗；cece-engineer 518,616,693 / lengleng-audit 40,170,724 从 hanako 分出。archive 19.88MB → rollup 0.35MB。
- **工程修复（临时目录）**：`tmpDir()` 统一落项目 `_tmp/` + `after(cleanupTmpDirs)` + 进程退出兜底清理；新增 `guardTmpRoot()`（>200 告警）；所有 `os.tmpdir()`/`/tmp` 的 mkdtemp 改 `tmpDir()`。连续 3 次 `node --test`（201 pass）后 `_tmp` 顶层恒为 9，零增长。
- **冷冷终审跟进（M1 + S1–S6）**：M1 hidden 在 rollup 路径失效 → `buildHiddenView` 用 agent×model 交叉表精确过滤 summary/daily/byType/byModel；S1 维度切换清空其他 + 显示当前生效维度；S2 speeds 统一 30 天/500/20000；S3 降级提示补齐；S4 recentIds 校验 + 水位线兜底 + seed 并集；S5/S6 文档 + v2 archive 补归属。真实数据 hidden=manman 验证通过，各 agent 之和 == total。

## 0.5.16 新增覆盖
- **端到端输出速率对齐 token-tracker 0.4.4**：新增 `lib/speed-scan.js`——会话 JSONL 口径取相邻 assistant 消息 timestamp 差（`100ms~600000ms`，`tps = 上一条 output / durMs`）；扫描每个 agent 下 `sessions`/`subagent-sessions`/`activity`/`workflow-sessions` 四类目录（递归，拒绝符号链接），记录带 `type`（session/subagent/automation）；ledger 口径白名单只收 `memory`/`utility`（`sourceTypeOf`），`durationMs` 同区间且 `out>0`，`reasoningTokens` 计入 `textTps`；模型变化且无 `model_change` 时 provider 置空；按文件 `mtime+size` 增量，`changed>0` 或文件集合增删时才落盘 `speeds.json`（原子写 + 损坏改名 `.corrupt-*`）。新增 `lib/speed-stats.js` 加权 `Σout/Σdur`（非算术平均），支持 from/to/agent/model/provider/type 过滤。
- 新增 `GET /api/speed`（canonical + legacy），返回 `{ speed, scanning }`，随筛选变化。
- hero 改为「端到端输出速率 X tok/s」（加权）+「加权 · N 次」+ hover 双口径说明（含工具调用/网络排队、过滤 100ms~10min、非模型纯生成速度）；首屏 speed 为空且 `scanning` 时 1.5s 后重取一次并局部重绘；agent 排名 tok/s 同步加权；无数据显示「–」。
- 延迟保留 `durationMs >= 2` 剔除 0/1ms 伪计时；移除逐请求吞吐字段（`avgOutputTokensPerSecond` / `throughputSamples`）。
- 小时图 `hourEvery` 阈值 1000→1200；`#chHourly` / `#chDailyTokens` 绑定 `ResizeObserver`（rAF 排队防抖 + `beforeunload` disconnect），保留 window resize 兜底。
- 前端 `presetRange` 本周起点改用 UTC 日期算法（与 `lib/date-presets.js` 同式），修复上海午夜 `getUTCDay()` 少一天。
- 版本号全量同步至 0.5.17（manifest / package / `UI_CACHE_VERSION` / 所有内部 `?v=`）。
- 终审建议：hero hover 与模型分布卡补「不宜跨模型直接比较」偏差说明（模型榜无独立速度榜，提示落在模型分布卡小字 + 排名行 `title`）；`CONTEXT.md` 新增「端到端输出速率」词条（含 type 归类与 agent 归属）。

## 0.5.16 增量：刷新体验 / archive 节流 / 小时轴 / 表格
- **静默刷新**：`renderAll(options)` 新增 `silent`/`feedback`；自动定时与 `visibilitychange` 走 `{silent:true,feedback:false}`（不显示「刷新中」、不重播动画）；手动刷新保留按钮反馈但静默；首屏后常驻 `.uh-silent`，CSS 关闭 `.chart-card svg` 与 `.cnt` 动画；`animateNumbers(root, silent)` 静默直赋。
- **archive 写盘节流**：`lib/archive.js` 导出 `ARCHIVE_SAVE_MIN_INTERVAL_MS=300000` 与 `archiveSaveDue()`；`index.js` 仅在 `stats.added>0||upgraded>0` 且距上次写盘 ≥5min 时才写，记录 `state.archiveLastSavedAt`（启动首刷允许写）。实测 19.5MB / 23902 条 archive 单次写 58ms，节流后 5 分钟内的 refresh 跳过。
- **小时图横轴**：`hourEvery` 改为 `>=560?1:>=420?2:3`（≥560px 恒 24 刻度）；标签改纯小时数 `0–23`；`xAxisLabels` 新增 `centerEnds` 让首尾标签也居中；卡片标题补「横轴 · 小时」。
- **命中率表**：`.hitrate-table th:not(:first-child){text-align:right}` 修正表头/数值列错位；`按 Agent`→`Agent 分布`、`按模型`→`模型分布`。

## 0.5.17 增量：widget 今日概览 / 今日模型速率 / 页面本地快照
- **widget 降级**：无当前会话时改为「今日概览」（`/api/summary` + `/api/speed` 当天：总消耗/次数/命中率/今日端到端速率），底部小字保留 `current.reason`；有会话路径不变。
- **widget 今日模型速率**：新增 `#wSpeedModel` 区块，`pickWidgetModel()` 优先当前会话模型、否则当天 tps 最高；无数据显示「–」。
- **页面本地快照**：`localStorage` 存 `{version, savedAt, filters, data}`；首屏先读快照立即渲染 + 「上次更新 · X 分钟前」，随后静默刷新替换；版本/筛选不符/损坏回退正常首屏；>1MB 跳过（实测今日快照 34.4KB）。
- **诊断（只查）**：宿主 `/api/sessions/messages` 存在；宿主未注入 `hostContext`/`focusedSession`，`resolveCurrentSession(ctx)` 无显式焦点必为 null，widget 只能靠 `discoverFocusedSession()`；未定位到确定失效环，未改宿主契约。
- **widget 降级态可诊断**：reason → 「宿主未提供当前会话」/「会话文件读取失败」/原始字符串；该行 `title` 带宿主 HTTP 状态、entryId、解析文件。
- **多 agent 会话查找**：`allAgentSessionDirs()`（仅 `agents/<x>/sessions`）并入 `/api/current-session`、`/api/resolve-entry`，主目录优先、安全边界不变。
- **当前会话路径兜底**：`/api/current-session` 优先级 query > ctx 焦点 > `ctx.sessionPath` 安全兜底 > none，响应加 `source`；`safeSessionPath()` 只收 `.jsonl` 且在允许目录内。
- **诊断补齐**：widget probe 加 origin；降级行显示 source，title 含 HTTP 状态/origin/entryId/解析文件。
- **getSessionPath 查证（静态 bundle 0.450.0）**：插件 ctx 无 `getSessionPath`（仅管理器内部 `_getSessionPath` 用于 tool 路径解析）；保留 `ctx.sessionPath` 兜底。`/api/current-session` 在 `source==="none"` 时返回 `sessionKeys`（ctx 上带 session/path/focus 的 key 名）。
- **latest-session 兜底（0.5.19）**：全部来源拿不到时，扫当前 agent 的 `sessions/` 顶层 .jsonl，取 30 分钟内 mtime 最新者，经 `safeSessionPath()` 复核；`source` 新增 `latest-session`。降级行改为可见「探测：HTTP/entryId/origin」小字，`latest-session` 标注「按最近活跃会话推断」。
- **0.5.20 文案与卡片**：hero「端到端输出速率」→「Token 平均速率」（去「加权 · N 次」、hover 精简，算法不变）；模型用量对比卡去掉提示小字（排名行 title 保留）；widget「上下文占用」显示百分比；「当前会话模型速率」改为卡片式，按会话 + 模型分别计算（speed 记录补 `sessionId`，`/api/speed` 收 `sessionId`，`SPEED_CACHE_VERSION` 升 2）。
- **0.5.21 archive 瘦身**：白名单存储（删 `schemaVersion/sessionPath/metadata/rawUsageShape/error/model.api/costTotal/cache.{hit,hitRatio,support,…}` 等），新增 `attribution.sessionFile`；`ARCHIVE_VERSION=2` + 首次加载就地迁移（备份 `archive.pre-slim-<ts>.json` + 原子写，失败保留原文件）；`session-titles` 改读 `sessionFile`。实测 24111 条 19.78MB→12.23MB（860→532 B/条），统计逐项一致。
- **回归修复（M1）**：`sessionTitleMap` 为绝对路径键补 basename 别名（侧车混合键：历史用绝对路径、较新用 `sess_*`），修复瘦身后历史会话标题失配；真实 `hanako/sessions/session-titles.json` 25/25 绝对路径键映射成功。
- **子代理归属修正（紧急）**：`slimEntry` 提升 `source.actor.agentId` → `attribution.actorAgentId`；新增 `agentOf()`（subagent 用子代理、缺失回退父 agent），`aggregate/speed-scan/rollup` 共用。真实数据 byAgent 分出 cece-engineer / lengleng-audit，各 agent 之和仍等于总消耗。
- 真实数据抽查（只读 `~/.hanako/agents/*/{sessions,subagent-sessions,activity,workflow-sessions}` + `usage-ledger.json`）：16 个会话目录 / 430 个 JSONL 首扫 677ms，二次增量 3ms（changed 0 / reused 430 / fileSetChanged false）；记录 19607（session 14354 / subagent 4292 / automation 648 / memory 296 / utility 17）；端到端输出速率 ALL 22 tok/s（n=19607）、今日 31（n=3689）、本周 25（n=6308）。

## 0.5.15 新增覆盖
- 小时图横轴每小时一个刻度；`fmtTokens` 单位 K 大写。
- `.source-filter` 与刷新按钮同风格。
- ChatGPT 改名与套餐版本（`planType`）。
- 「会话」按 sessionId 聚合 + `/api/session-titles` 标题映射。
- `aggregateCached` 聚合缓存。
- 侧栏上下文窗口：`CONTEXT_WINDOW` / 进度条 / 阈值标记 / 距压缩。

## 0.5.14 新增覆盖
- hero 数字纯文本渲染 + 上滑淡入；移除逐位盒子与 tabular 等宽。
- 图表 `fontSize` 参数化，小时图用 11。
- 侧栏供应商占比取整，`tokens` 改「总消耗」。

## 0.5.13 新增覆盖
- Codex 卡改为双圆环（5 小时 / 周窗口），环心显示剩余百分比，环下为窗口名与重置时间。

## 0.5.12 新增覆盖
- hero 数字 `lining-nums` + 基线对齐；`.head > button` 统一最小高度。

## 0.5.11 新增覆盖
- Codex 独立卡（`renderCodexCard` / `fmtResetAt`）+ 后端 `windows` 明细。
- 小时图「类型 / 会话」切换（`hourlySwitch` / `HOURLY_MODE_KEY` / `hourlyByAgent`）。
- 卡片间距：`.chart-card` 16px、`.chart-grid` / `.settings-grid` 内部归零。
- 侧栏：总消耗文案、`.w-legend` 图例、`wTypeList` 供应商列表、`providerLabel`。

## 0.5.10 新增覆盖
- `fetchJson(path, init)` 透传 init，POST 不再被吞成 GET（设置保存/余额刷新的根因）。
- 设置抽屉打开时不重建，勾选不被定时刷新重置。
- `balance.codexEnabled` 默认 true；quota 卡显示 5 小时/周窗口已用百分比。
- 趋势图改 `stackedComboChart`（堆叠柱 + 命中率折线）+ `chartLegend` + `TYPE_COLORS`。
- 移除 `cc-zoom` / `openChartModal` / `combo-legend`，图表卡不再使用 `.glass`。

## 0.5.9 新增覆盖
- 余额/额度卡排在消耗预测之前；hero 移除「平均每轮耗时」。
- 来源类型改为水平堆叠条 + 图例并显示总消耗（`sourceBar`）。
- 小时图横轴 0:00–23:00 完整刻度（`xAxisLabels` / `xLabels` / `xEvery`）。

## 0.5.8 新增覆盖
- `GET /api/balance` 无快照时当场刷新、60 秒内复用快照；插件启动后台刷新一次并落盘。
- 页面输入构成卡移除、来源类型卡保留；widget 输入构成条不受影响。
- 设置按钮改 SVG 图标（min-width 38px）；图表卡改单列放大。

## 0.5.7 新增覆盖
- 消耗与命中率整合为柱+线双轴（`comboChart`），每日命中率趋势卡并入。
- 分布卡只保留模型/Provider；命中率卡去掉公式说明。
- `GET /api/forecast` 与 `lib/forecast.js` 预测口径：日均/月底预估/趋势/距月底；样本不足返回 null。

## 0.5.6 新增覆盖
- 设置抽屉不再内联密钥输入，提示密钥来自宿主；保存 payload 不再提交 credentials。
- 底部不再渲染数据源/统计/图例；hero 改用「总消耗」。
- Agent 显示中文名且筛选/持久化仍用 agentId；`/api/status` 返回 `agentNames`，`index.js` 经 `agent:list` 获取。
- 命中率分析块列固定为 名称/命中率/读取/调用/总消耗，不含伪造的写入列。
- 余额配置驱动：`balance-apis.json` 可新增供应商并禁用默认项，key 取自宿主 provider-catalog。
- 修复设置保存后不刷新（`renderAll` 作用域错误）。

## 0.5.5 新增覆盖
- 单日/多日图表二选一；输入构成按 <3 天/≥3 天切换粒度；齿轮图标放大；移除 P50/P95。

## 0.5.4 新增覆盖
- 内部 import 版本一致性：`index.js`、`routes/*.js`、`lib/*.js` 所有相对 import 必须带 `?v=<manifest.version>`；`package.json` 与 `manifest.json` 版本一致；`routes/ui.js` 的 `UI_CACHE_VERSION` 等于 manifest 版本。
- 前端错误态：`fetchJson` 报错含状态码与接口路径；失败时显示错误横幅与重试入口、清空「加载中…」占位、刷新按钮反馈「刷新失败」。

## 本轮收口覆盖
- 时间预设：本年/本月/本周/昨天/今天，默认今天，Asia/Shanghai 日界；多日范围隐藏小时图。
- 显示偏好：助手/模型逐项 hiddenAgents/hiddenModels 持久化，并在聚合前统一过滤；会话列表同步过滤。
- 设置与卡片：设置迁移为 drawer；余额/额度按稳定 kind 拆卡，无配置来源整卡隐藏。
- widget：只读取 `/current-session`，消息 payload 解析为安全 basename/query；焦点切换、显式无焦点空态和过期响应保护覆盖。
- current-session：query identity 优先；无 query 仅接受明确 current/focused 对象，拒绝 ctx.sessionPath fallback；resolver 跳过不完整候选。
- P2：昨天小时图标签使用选中日期；disabled 余额快照保持 `cached:false`；余额/额度卡支持仅本地筛选 configured 来源。
- 数据 API 路径回归修复：panel.js 的插件业务 API 使用 `/api/...` canonical 路径，routes/api.js 同时注册无前缀 legacy alias；静态资源路径保持不变。
- 静态资源缓存收口：page/widget/card 的 panel.js 与 panel.css URL 稳定追加 `usage_hub_v=0.5.3`，并保留 token 等既有查询参数。
- 旧资源兼容：业务 API 同时注册 canonical `/api/...` 与 legacy 无前缀路径；静态资源仍只使用 `/assets/panel.js`、`/assets/panel.css`。
- 本轮完整改造：ctx.network/provider-catalog 动态余额、Codex OAuth headers/window quota、`/api/resolve-entry`、page 去除会话详情 loader、单日小时趋势/多日命中率分层、来源类型堆叠、Agent排名、latency/throughput 聚合。
- 聚合指标收口：`addEntry()` 对所有 public bucket 累加有效 latency、明确非 ok errors、output/duration throughput；daily/hourly bucket 输出 sourceType `byType` 结构，单日小时图展示来源类型堆叠；latency 使用固定 7 桶计数，不暴露原始 latency values；回归测试覆盖 summary/daily/hourly/by-agent/by-model/by-provider。
- 余额回归：Codex 百分比窗口支持 primary/secondary、remainingPercent、resetAt、limitWindowSeconds；Moonshot base_url 的 `/v1` 拼接分支已覆盖。
- 文案口径：页面显示“平均单请求输出 Token/s”，表示所有有效 duration 请求的输出吞吐平均值。
- 安全收口：Codex primary/secondary 仅持久化规范化白名单字段；设置保存由后端单次刷新并返回快照，前端不重复 POST refresh；仅显示设置变更时前端按需 GET balance。
- 审计收口：page 删除会话详情函数、状态、选择器样式和 shell 卡片；widget 保留 current-session；宿主 messages 取最后一条可解析 entryId；Codex 支持插件显式开关与宿主 `enableCodexQuota` 兜底，catalog/auth 支持 pluginDir/dataDir/sessionsDir 候选路径。
- 会话 API：后端 sessions/session-detail 路由保留兼容；page 不加载、不渲染会话详情，widget 仅使用 current-session 闭环。
- settings：own-property 合并保留 `false/0`，allowlist 重建过滤磁盘未知字段；短凭据固定掩码，长凭据不回显原文。
- balance：空响应、invalid JSON、供应商余额/额度字段中的 null/undefined/空字符串/boolean 均为 `malformed_response`；合法数字字符串仍接受；AbortError/TimeoutError/ABORT_ERR 为 `network`；last-good 失败保留并标 `stale`，记录 `lastAttemptAt/lastSuccessAt`；provider-catalog 临时 home fallback；Codex account id/User-Agent；凭据不进入日志/响应。
- balance disabled：关闭后刷新结果、内存快照、磁盘快照和后续 GET 均清除旧成功来源；重新启用可再次刷新。
- UI/API：首次 GET 无快照后只主动 POST 一次；余额/凭据变化由后端 POST `/api/settings` 内部只刷新一次并在响应中返回 `balance`，前端消费 `saved.balance`；仅显示设置变化时前端 GET `/api/balance`；settings/balance 路由隔离测试。
- 范围：实际仅支持 DeepSeek、Moonshot、Codex；智谱/OpenAI/xAI 不猜 endpoint，文档标明 not_supported；不包含费用/价格逻辑。

## 版本校验（0.5.17）
- `grep -rn "0\.5\.1[0-6]" --include='*.js' --include='*.json' --include='*.css' .` 在源码与配置中无旧版本残留；当前版本为 0.5.17。
- 仍含旧版本号的位置仅：`_tmp/`、`_backups/`、历史测试套件的批次标签（如 `test/usage-hub-0515.test.js`）与文档历史记录。

## 执行环境与命令

```bash
cd <项目目录>
NODE=$(which node)   # 或本地 nvm 的 node 绝对路径
$NODE --test "test/*.test.js"
find . -path './_tmp' -prune -o -path './_backups' -prune -o -name '*.js' -print0 | xargs -0 -n1 $NODE --check
find . -path './_tmp' -prune -o -path './_backups' -prune -o -name '*.json' -print0 | xargs -0 -n1 $NODE -e 'const fs=require("fs"); JSON.parse(fs.readFileSync(process.argv[1],"utf8"));'
```

宿主联调尚未执行：宿主 `/api/sessions/messages` 的 token/响应结构、provider-catalog/auth 实际字段、余额 endpoint 字段、Codex 订阅字段及视觉布局仍需在 Hana 内确认；本轮未启动浏览器或真实网络。

## 2026-09-09 0.5.2 数据 API 路径回归（历史记录）
- 原因：0.5.2 使用无前缀插件业务路径，触发 Hana 宿主 HTTP 404；数据目录正常。此前将宿主契约误判为自动补齐前缀，结论已由真实 Hana 页面截图纠正。
- 该版本记录保留原始排查背景；0.5.3 已恢复 `/api/...` canonical 路径。

## 2026-09-09 0.5.3 数据 API 路径修复
- 修复：panel.js 的插件业务 `fetchJson` 全部使用 `/api/...`；宿主原生 `/api/sessions/messages` 保持不变；routes/api.js 同时注册 `/api/${path}` canonical 与 `/${path}` legacy alias。
- 版本：manifest、package 和 UI cache version 均为 `0.5.3`。
- 待验证：Hana 宿主页面回归、正式安装目录加载与浏览器视觉回归；未生成 zip。
