# usage-hub 项目日志

## 缘起
usage-hub 用于统一展示 Hana 的 usage-ledger 全量用量。阶段 1 已完成账本读取、归档、聚合与口径验证；本轮补齐会话 JSONL 详情能力，参考 session-insight 但不修改旧插件。

## 当前进度
- 阶段 1：数据层、归档、聚合与测试完成（原 46/46）。
- 阶段 2（本轮）：会话只读读取层、会话列表/详情 API、panel 会话选择器和逐轮详情区域完成；审计修复后共 51/51 自动化测试通过。
- 旧插件 `~/.hanako/plugins/session-insight` 与旧 `plugin-data`：本轮仅读取参考，未写入。

## 2026-09-09 审计修复
- 修复 `/sessions` 路径泄露、JSONL/标题/目录 symlink 跟随、agent fallback、上下文窗口伪默认和详情定位歧义。
- 增加 JSONL 文件/事件上限、limit 归一化、warning 可观测性；前端传递 agent + file，daily hit 弹窗去除算术平均。
- 真实样本只读检查确认 assistant usage 位于 `message.usage`，input/output/cacheRead 为数值，未发现原生 hitRatio、uncachedTokens、contextWindow；实现注释和测试已固定该口径。

## 2026-09-09 冷冷复审跟进
- `/sessions` 对无效目录和 symlink 仅返回 `invalid_sessions_directory` / `symlink_sessions_directory` 等稳定 warning；API 不返回原始绝对路径。
- `deriveSessionsDirInfo` 暴露 `configured-sessions`、`current-session-path`、`default-agent-directory` 来源；默认 hanako 目录同时返回 `default_agent_directory` warning，不伪装成当前 agent。
- 重复 `sessionId` 在未提供 agent/file 时返回 409 `ambiguous_session_id` 与无路径 matches；提供 agent+file 保持精确成功。
- panel 会话窗口无效时显示“上下文窗口：不可用”；每日命中率保留 null，图表断点且汇总只统计真实数值。

## TODO
- 在 Hana 宿主内验证不同版本 `session-manifest.db`、多 agent sessionsDir 和宿主焦点会话联动。
- 评估大体积 JSONL 的增量/尾部读取，当前实现以安全完整读取优先。
- 补充真实宿主视觉回归；本轮不启动浏览器或本地端口。

## 验证清单
- [x] 会话目录、标题侧车、首条用户消息标题兜底。
- [x] 按 agent / sessionId / 文件名定位。
- [x] 列表与详情包含标题、agent、起止时间、逐轮模型和 token、命中率、上下文窗口字段（存在时）。
- [x] JSONL 单行损坏、文件缺失安全降级。
- [x] API 测试只使用 `_tmp` 隔离夹具。
- [ ] Hana 宿主实际加载与视觉回归（未执行）。

## 备份记录
- 2026-09-09 — 会话详情阶段快照：`_backups/usage-hub_20260909-111645_session-detail.tar.gz`

## 2026-09-09 Phase 3 设置与余额/额度
- 新增 `lib/settings.js`：`ctx.dataDir/settings` 私有层，settings/credentials 分离、原子写入、掩码公开、空密钥保留、未知字段与数值范围拒绝。
- 收口 `lib/balance.js`：实际仅支持 DeepSeek/Moonshot/Codex；空响应为 `malformed_response`，Abort/Timeout 为 `network`，失败保留 last-good 并记录 `lastAttemptAt`/`lastSuccessAt`/`stale`；Codex 携带 account id 与 User-Agent；私有 key 缺失时只读宿主 provider-catalog fallback，响应不含 key。
- 新增 `GET/POST /api/settings`、`GET /api/balance`、`POST /api/balance/refresh`；面板加入设置区和余额/额度卡，沿用现有 accent/玻璃视觉，无费用文案。
- 新增 `_tmp` mock/隔离测试；本轮未启动浏览器、端口、真实网络，未修改旧插件目录。
- 宿主联调风险：余额 endpoint 的字段契约、`ctx.dataDir`、provider-catalog 实际宿主路径及网络代理/鉴权注入仍需在 Hana 内确认；Codex endpoint/订阅字段可能随宿主账户变化。智谱/OpenAI/xAI 未猜测 endpoint，当前返回 unavailable/not_supported 语义；本地验证未启动浏览器、端口或真实网络。

## 2026-09-09 最终边界修复
- `lib/balance.js`：供应商数字字段仅接受有限 number 或非空数字字符串；null/undefined/空字符串/boolean 不再被转换为 0。供应商 invalid JSON 统一归类 `malformed_response`。
- 禁用余额时写入一致的 disabled 快照并更新内存 `lastGood`，避免刷新结果和后续 GET 暴露旧成功数据；重新启用仍走原有显式刷新路径。
- `assets/panel.js`：设置保存后改为读取 GET `/balance` 的服务端快照，不在保存流程额外 POST 刷新，关闭余额不会继续显示旧余额，也不引入刷新循环。
- 新增边界回归测试，全量 **71 pass / 0 fail**；未启动浏览器、端口或真实网络，未修改旧插件及旧 plugin-data。

## 2026-09-09 usage-hub 改造实现
- 主页面默认今天（Asia/Shanghai），日期输入改为本年/本月/本周/昨天/今天预设；多日范围不请求也不显示小时趋势；移除标题旁数据条数徽标。
- 设置改为刷新旁齿轮打开的 drawer，逐项持久化 `hiddenAgents`/`hiddenModels`；API 在聚合前过滤，sessions 同步过滤，保证总览/图表/分布/会话口径一致。
- 余额与额度使用 `kind=balance/quota` 拆卡；仅渲染 configured 来源，无配置来源时整卡隐藏；保存、手动刷新、轮询链路保持分离。
- widget 改为只读 `/current-session`，不再调用全局 `loadAllData()`；展示当前会话标题/模型/轮数/token/命中率/上下文/输入构成，焦点消息触发刷新并用版本号丢弃过期响应。
- 会话选择器改为今天/昨天/更早紧凑弹出列表。新增回归测试后全量 **79 pass / 0 fail**；补齐 widget 焦点 query 闭环、disabled cached 语义、昨天小时标签、余额/额度来源筛选，以及前后端 panel/API 路由 `/api/...` 路径收口。
- 本轮未启动真实网络、服务器、端口或浏览器；未修改旧 session-insight、token-tracker 及旧 plugin-data。宿主焦点探测与视觉联调仍是未完成风险。

## 2026-09-09 完整改造收口
- 余额：`BalanceService` 支持 `ctx.network.fetch`/安全 fallback、动态 provider-catalog/base_url/api_key/auth、DeepSeek balance_infos、Moonshot 兼容、Codex OAuth headers 与 primary/secondary window quota；公开响应仅保留脱敏状态字段。
- 会话：新增 `/api/resolve-entry`，从 sessions JSONL 尾部按 entryId 映射 basename；widget 通过宿主 sessions/messages 探测并结合焦点消息加速，page 不再请求 sessions/session-detail。
- 聚合/页面：新增 latency n/avg/p50/p95/max/buckets、明确非 ok errors、平均单请求输出 Token/s；单日小时 Token+命中率+来源类型堆叠，多日每日趋势分层；来源类型堆叠和 Agent 消耗排名区域加入页面。
- 保存设置后立即刷新 `/api/balance/refresh`；入口图标加粗；未生成 releases 包。
- 全量 **88 pass / 0 fail**；未启动浏览器、端口或真实网络，未修改旧 session-insight、token-tracker 及旧 plugin-data。
- 聚合指标补正：`addEntry()` 统一写入 latency/明确 status errors/throughput，所有 public buckets 可见真实数值；daily/hourly 按 sourceType 输出 `byType`，单日小时 UI 消费该结构；latency.buckets 改为固定 7 桶计数，避免暴露原始值；新增跨 summary/daily/hourly/by-agent/by-model/by-provider 数值回归。
- 审计阻断项修复：page 完全移除会话详情函数/状态/选择器样式和 shell 卡片；widget 保留 current-session；宿主 messages 取最后一条有效 entryId；Codex 开关支持插件显式值与宿主 `enableCodexQuota` 兜底，动态根候选覆盖 pluginDir/dataDir/sessionsDir。
- 安全收口：Codex primary/secondary 仅保留规范化白名单窗口字段并覆盖重启缓存；设置 POST 由后端单次刷新并返回 balance，前端消费返回结果，显示设置变更仅 GET 快照。
- 静态资源缓存收口：UI 路由为 panel.js/panel.css 稳定追加 `usage_hub_v=0.5.1`，并保留 token 查询参数，避免 Hana 继续加载旧资源。
- 旧 panel.js 兼容：业务 API 使用统一 helper 同时注册 `/api/...` canonical 与无前缀 legacy 路径；`/assets` 静态路由保持不变。
- 未完成宿主联调：sessions/messages token/响应结构、provider-catalog/auth 实际字段、余额 endpoint/Codex 字段和视觉回归。

## 审查记录
- 待安排 — Phase 3 设置、凭据隔离与余额适配独立复审。

## 2026-09-09 usage-hub 0.5.3 路由契约纠正
- 真实 Hana 页面截图显示 0.5.2 数据接口 HTTP 404；数据目录和聚合数据正常，根因是 0.5.2 错误使用无前缀插件 API，而当前 Hana 宿主插件路由契约与 session-insight 一致，canonical 必须使用 `/api/...`。
- 修复：`assets/panel.js` 所有插件业务 `fetchJson` 恢复 `/api/...`（summary/daily/hourly/status/settings/balance/current-session/resolve-entry 及其他聚合、刷新接口）；原生宿主 `/api/sessions/messages` 不变。
- `routes/api.js` 的注册 helper 同时注册 `/api/${path}` canonical 与 `/${path}` 无前缀 legacy alias，兼容旧资源。
- 发布同步：`manifest.json`、`package.json` 和 `routes/ui.js` cache version 均 bump 至 `0.5.3`。
- 待验证：Hana 页面实际加载回归、正式安装目录验证和视觉回归；不修改 `~/.hanako/plugins`，不生成 zip。

## 2026-09-09 usage-hub 0.5.2 数据 API 路径回归修复
- 真实回归原因：0.3 的 `assets/panel.js` 通过 `fetchJson('/summary')` 等插件内部无前缀路径访问数据；0.5.1 发布包及正式安装目录仍使用 `fetchJson('/api/summary')`，与 `hana.api.fetch` / plugin helper 自动注入插件路由前缀的契约冲突，导致数据接口失败。
- 修复：确认源码 `assets/panel.js` 的业务 API 全部使用无前缀路径（含 `/summary`、`/daily`、`/hourly`、`/status`、`/settings`、`/balance`、`/current-session`、`/resolve-entry` 及其他聚合/刷新接口）；保留宿主直连 `/api/sessions/messages`。
- 缓存与版本：`routes/ui.js` 的 `UI_CACHE_VERSION` 和 `manifest.json` 版本 bump 至 `0.5.2`。
- 回归测试：更新旧路径断言，新增静态断言禁止 `panel.js` 出现 `fetchJson('/api/...')`，并明确不误伤宿主 `/api/sessions/messages`。
- 待验证范围：本地源码全量测试后，仍需在 Hana 宿主内验证实际插件路由注入、焦点会话接口响应和视觉加载；本轮不修改 `~/.hanako/plugins` 正式安装目录、不生成 releases 包。

## 2026-09-09 usage-hub 0.5.4 真实根因：Hana 模块缓存导致路由模块整体加载失败

### 症状
- Hana 内打开「用量中心」page：页面壳正常渲染，所有数据区永久停在「加载中…」，数据接口返回 HTTP 404。
- 此前 0.5.1→0.5.2→0.5.3 三次「路径契约」修复都没有解决问题，因为 404 不是路径写错，而是数据路由根本没注册。

### 根因（有宿主代码与日志双重证据）
- Hana 日志：`[ERROR] [plugin-manager] route "api.js" in "usage-hub" failed to load: The requested module '../lib/session-reader.js' does not provide an export named 'resolveEntryFile'`。
- Hana 宿主 `bundle/index.js` 的模块加载器：
  `function Yu(e) { const t = Sce(e); return t.searchParams.set("t", `${Date.now()}-${Ave++}`), import(t.href); }`
  即宿主**只对插件入口文件**加 `?t=<时间戳>-<自增>` 做 cache-bust。
- 入口文件内部的相对 import（`import "../lib/session-reader.js"`）不带参数，命中 Node 的 ESM 模块 URL 缓存；插件从 0.3.0 升级到 0.5.x 后，`lib/session-reader.js` 仍是旧实例（无 `resolveEntryFile`），新 `routes/api.js` 一加载就抛导出缺失。
- `routes/api.js` 加载失败被宿主记录为 ERROR 但不阻断插件：page/widget 壳照常注册，于是前端能打开、接口全 404、图表永远「加载中」。
- 佐证：`~/.hanako/plugin-backups/usage-hub/...-v0.3.0` 的 `session-reader.js` 无 `resolveEntryFile`，`api.js` 也未 import 该符号，与 17:19 成功加载、18:16/18:42 报错的日志时间线一致。

### 修订
- **内部依赖版本化**：`index.js`、`routes/api.js`、`lib/aggregate.js`、`lib/archive.js`、`lib/balance.js`、`lib/migrate.js` 中所有相对 import 统一追加 `?v=<manifest.version>`（本版 `?v=0.5.4`）。宿主下次加载入口文件时会以新 URL 解析依赖，强制重新读取 lib，无需重启 Hana。
- **规则固化**：任何 lib 改动都必须 bump `manifest.json`/`package.json`/`routes/ui.js` 的版本并同步 `?v=`；新增测试逐文件扫描所有相对 import，未同步即失败。
- **前端错误态**：`fetchJson` 失败信息带上状态码与接口路径；`renderAll` 失败时显示「数据加载失败 + 原因 + 重试」横幅，清掉仍停留在「加载中…」的图表占位，刷新按钮反馈「刷新失败」而不是一律「已刷新」。
- 版本：`manifest.json`、`package.json`、`routes/ui.js` `UI_CACHE_VERSION` 同步升至 `0.5.4`。

### 验证
- 全量自动化测试 **90 pass / 0 fail**（新增 2 项：内部 import 版本一致性、前端错误态）。
- Node 实测 `routes/api.js?v=0.5.4`、`lib/session-reader.js?v=0.5.4`、`index.js?v=0.5.4` 均可正常 import。
- 待验证：Hana 内安装 0.5.4 后 page 数据实际加载、余额/会话用量区域渲染；本轮未启动浏览器或真实网络。

### 0.5.4 上线结果（2026-09-09 晚）
- 需求方在 Hana 内导入 `releases/usage-hub-0.5.4.zip` 后确认「可以了」：page 数据正常加载，404 消失。
- 结论：根因判断与修订方向均成立；`?v=` 依赖版本化使插件升级无需重启 Hana 即可生效。

## 2026-09-09 usage-hub 0.5.5 前端呈现调整
- 单日只保留 24 点小时柱状图（沿用每日趋势呈现），多日只保留每日趋势；命中率与来源类型堆叠收进点击弹窗。
- 输入构成按 `<3 天` 走小时、`≥3 天` 走天；`/api/hourly` 不传 `day` 时返回范围内全部天的小时序列，前端拍平成一维。
- 设置齿轮图标 16px → 20px；移除 P50/P95 耗时指标，保留平均每轮耗时。
- 规格 `docs/specs/2026-09-09-frontend-charts.md`；全量测试 92 pass。

## 2026-09-09 usage-hub 0.5.6 设置与呈现收口
- **余额配置驱动**（参照 token-tracker）：`dataDir/balance-apis.json` 可覆盖/新增供应商，内置 deepseek/moonshot/glm/minimax；key 优先取宿主 `provider-catalog.json` 的 `providers.<id>.api_key`，插件 credentials 仅作最低优先级兼容；通用解析覆盖 DeepSeek `balance_infos` / 通用金额字段 / GLM 百分比额度。
- 设置抽屉移除密钥输入框，改为提示密钥统一来自 Hana 设置。
- **修复「设置保存跟没点一样」**：保存处理器调用的 `renderAll` 是 `renderPage` 内闭包，顶层作用域抛 ReferenceError 并被 catch 吞掉，表现为保存后页面无变化；改为 `state.refreshAll` 暴露后调用，并把「已保存」保留 1.5 秒再关抽屉。
- 底部数据源/统计/图例整块移除，并清理 `GLOW_SEL` 中失效选择器。
- **Agent 显示中文名**：`index.js` 通过 `bus.request("agent:list")` 建 `agentId → name` 映射，`/api/status` 返回 `agentNames`；排名、分布、筛选下拉、隐藏列表显示中文名，值与持久化仍用 agentId。
- 新增「缓存命中率分析」卡：环形总命中率 + 按 Agent/按模型表格（名称/命中率/读取/调用/总消耗），不伪造写入列。
- 规格 `docs/specs/2026-09-09-settings-and-hitrate.md`；全量测试 99 pass。
- 待验证：Hana 内 DeepSeek 余额是否实际返回（key 已确认存在于宿主 catalog，失败原因可能是网络白名单或接口）、设置保存反馈、命中率分析卡视觉回归。

## 2026-09-09 usage-hub 0.5.7 图表整合与消耗预测
- **柱+线双轴**：新增 `comboChart()`，每日/小时消耗趋势都改为左轴 token 柱 + 右轴 0-100% 命中率折线；移除独立的「每日命中率趋势」卡，弹窗同步为组合图并保留命中率摘要。
- 分布卡只保留「模型 / Provider 分布」，移除「Agent 消耗对比」（已由命中率分析表覆盖）。
- 命中率分析标题去掉「缓存读取 ÷（缓存读取 + 未命中输入）」公式说明。
- **新增消耗预测**：`lib/forecast.js` + `GET /api/forecast`——日均消耗（最近 7 个非今天自然日）、今日预估（历史小时累计占比外推，样本不足 3 天返回 null）、趋势（±15% 内持平）、月底预估（本月已用 + 日均 × 距月底天数）、距月底；前端新增「消耗预测」卡。口径参照 token-tracker。
- 全量测试 **104 pass**；包解压后独立再跑一遍同样 104 pass。
- 待验证：Hana 内柱线图与预测卡视觉、预测数字与真实数据一致性。

## 2026-09-09 usage-hub 0.5.8 余额自动刷新与图表呈现修订
- **余额/额度可见性**：`GET /api/balance` 改为「60 秒内有快照直接返回，否则当场查询」，不再依赖前端先 POST `balance/refresh`；插件 `onload` 后台刷新一次并落盘 `balance.json`。此前该文件从未生成，余额卡因此恒为空。实现参照 session-insight。
- **输入构成卡移除**：页面只保留「来源类型」（聊天/任务/子代理/系统）卡；widget 的输入构成条保持不变。
- **图表放大**：图表卡由两列改单列（`grid-template-columns: 1fr`），解决「放大后还是小」的观感问题。
- **设置按钮**：字符 `⚙` 换成 SVG 图标，按钮最小宽度 38px。
- 全量测试 **109 pass**（新增 `test/usage-hub-058.test.js` 5 项）。
- 待验证：Hana 内 DeepSeek 余额是否实际返回、页面单列图表与 SVG 图标视觉。

## 2026-09-09 usage-hub 0.5.9 呈现调整（余额位置 / 来源类型 / 小时轴）
- **余额卡上移**：余额与额度卡移到「消耗预测」之上，紧跟 hero 指标。
- **hero 精简**：移除「平均每轮耗时」。
- **来源类型改水平堆叠条**：不再按时间维度画柱状图，改为一条水平占比条 + 图例（标签 / 总量 / 占比 / 次数），标题右侧显示总消耗；参照 token-tracker 的 source-bar。
- **小时消耗趋势横轴**：新增 `xAxisLabels()`，小时图横轴显示 0:00–23:00 完整刻度（每 3 小时一个标签），不再只显示日期；坐标轴字号 12 → 13。
- 全量测试 **113 pass**（新增 `test/usage-hub-059.test.js` 4 项）。

## 2026-09-09 usage-hub 0.5.10 趋势图复刻用量与设置保存修复
- **修复关键 bug：`fetchJson` 只收 path、丢弃 init**，导致 `postJson` 实际发成 GET——设置保存、余额刷新按钮、隐藏列表全部静默失效。改为 `fetchJson(path, init = {})` 并透传 `...init`。这是「设置点了保存跟没点一样」和「Codex 打开也看不见」的真因。
- **趋势图复刻用量**：新增 `stackedComboChart()`（堆叠柱按来源类型 + 命中率折线右轴 0-100% + 列悬停明细）与 `chartLegend()`（顶部图例）；每日/小时两张趋势卡都改用它；新增 `TYPE_COLORS` 对齐用量配色。
- **取消点击放大**：删除 `cc-zoom` 图标、点击绑定与 `openChartModal` / `chartSummary` / `dailyHitSummary`，并清理无引用的 `comboChart` / `stackedBars`（共约 155 行死代码）。
- **卡片去玻璃光效**：图表卡不再用 `.glass`（无 backdrop-filter / 内发光 / hover 光晕），改为用量那种朴素卡片（bg-card + 边框 + 小阴影）。
- **设置抽屉不被定时刷新重置**：抽屉打开时跳过重建，避免勾选在保存前被 60 秒轮询抹掉。
- **Codex 额度默认开启**（`balance.codexEnabled: true`，对齐 token-tracker），额度卡显示改为「5 小时窗口已用 X% · 周窗口已用 Y%」。
- 全量测试 **118 pass**（新增 `test/usage-hub-0510.test.js` 5 项）。
- 待验证：Hana 内 Codex 额度是否实际返回、趋势图与用量的视觉一致性、设置保存后落盘 `settings/settings.json`。

## 2026-09-09 usage-hub 0.5.11 Codex 独立卡与用量化补齐
- **Codex 额度拆为独立卡**：`renderCodexCard()`——圆环显示周窗口剩余，下方每个窗口一行「已用 X% · 重置时间」；后端 `parseCodex` 新增 `windows`（`codexWindowLabel` 按窗口秒数命名 5 小时/周），并加入公开响应白名单。
- **小时图新增「类型 / 会话」切换**（照用量）：后端 `aggregate` 新增 `hourlyByDayByAgent`，`/api/hourly` 返回 `hourlyByAgent`；前端按 agent 堆叠并持久化选择。
- **卡片间距统一**：`.chart-card` 恢复 16px 下间距，`.chart-grid` / `.settings-grid` 内部归零。
- **侧栏补齐**：「总 tokens」改为「总消耗」；输入构成加回颜色图例（`.w-legend`）；加回「本会话供应商」列表（按 provider 聚合当前会话，`providerLabel` 显示中文名）；「上下文占用」在无窗口字段时改为显示最近一轮上下文 token 数。
- 全量测试 **123 pass**（新增 `test/usage-hub-0511.test.js` 5 项）。
- 待验证：Codex 额度卡实际数据、切换按钮、侧栏三块渲染。

## 2026-09-09 usage-hub 0.5.12 / 0.5.13 细节对齐与 Codex 双圆环
- **0.5.12**：hero 数字加 `lining-nums`（强制等高数字）并改为基线对齐，修复数字与单位字母 M/k/% 视觉大小不一致；`.head > button` 统一 `min-height: 38px`，修复刷新与齿轮按钮不等高。
- **0.5.13**：Codex 卡改为**双圆环**——5 小时窗口与周窗口各一个环（环心显示剩余百分比），环下为窗口名与重置时间，去掉条形进度。
- 全量测试 **125 pass**。

## 2026-09-09 usage-hub 0.5.14 数字渲染与侧栏细节
- **hero 数字改为纯文本渲染**：删除逐位 span 滚动结构（小数点与数字脱钩、字形不一致的根源），改为整体文本 + 上滑淡入动画；字体特性改为 `lining-nums`（不再强等宽）。
- **小时图字体放小**：`stackedComboChart` 新增 `fontSize`（作用于左轴/右轴/横轴刻度），小时图传 11。
- **侧栏本会话供应商**：占比去掉小数（`Math.round`），`tokens` 标签改为「总消耗」。
- 全量测试 **125 pass**。

## 2026-09-09 usage-hub 0.5.15 横轴铺满与首屏提速
- **小时图横轴改为每小时一个刻度**（`xEvery: 1`），与用量一致，不再出现缺齿。
- **单位 K 改大写**（`fmtTokens` 的 `k` → `K`）。
- **余额来源筛选框重做**：`.source-filter` 改为与刷新按钮同风格（圆角、描边、内嵌 chevron、38px 高）。
- **Codex 改名 ChatGPT**：余额源 label、provider 显示名、卡标题、设置开关文案统一；`parseCodex` 解析 `plan_type` 并在卡标题旁显示套餐版本。
- **小时图「会话」改为按 sessionId 聚合**（修正之前误用 agentId），新增 `/api/session-titles` 把 sessionId 映射为会话标题，图例显示标题而非短 id。
- **首屏提速**：`routes/api.js` 新增 `aggregateCached`（按筛选条件 + `builtAt` 缓存 30 秒），首屏 8 个请求从 8 次全量聚合降为 1 次。
- 全量测试 **130 pass**（新增 `test/usage-hub-0515.test.js` 5 项）。

## 2026-09-09 usage-hub 0.5.16 端到端输出速率与横轴几何修复
- **端到端输出速率（对齐 token-tracker 0.4.4）**：新增 `lib/speed-scan.js`——JSONL 口径取相邻两条 assistant 消息 timestamp 差（`100ms~600000ms`，`tps = 上一条 output / durMs`）；扫描每个 agent 下 `sessions`/`subagent-sessions`/`activity`/`workflow-sessions` 四类目录（递归、拒绝符号链接），记录带 `type`（session/subagent/automation）；ledger 口径**白名单**只收 `memory`/`utility`（`sourceTypeOf`；此前黑名单会与 activity/workflow 双算），`durationMs` 同区间且 `out>0`，`reasoningTokens` 计入 `textTps`；模型变化且无 `model_change` 时 provider 置空；按文件 `mtime+size` 增量，`changed>0` 或文件集合增删时才落盘 `speeds.json`（原子写 + 损坏改名 `.corrupt-*`，只存派生统计）。新增 `lib/speed-stats.js` 加权聚合 `Σout/Σdur`（非算术平均），支持 from/to/agent/model/provider/type 过滤。
- **API**：新增 `GET /api/speed`（canonical + legacy），返回 `{ speed, scanning }`，随筛选变化。
- **口径归类**：生成速度的 `type` 按会话目录归类（sessions→session、subagent-sessions→subagent、activity/workflow-sessions→automation），其余卡片的 `type` 按账本子系统归类，两者来源不同；agent = 会话所属 agent（含子代理与后台会话），无法单独区分子代理。前端 hero hover 与模型分布卡均补“不宜跨模型直接比较”偏差说明。
- **前端**：hero「平均单请求输出 Token/s」→「端到端输出速率 X tok/s」（加权）+「加权 · N 次」+ hover 双口径说明；首屏为空且 `scanning` 时 1.5s 后重取一次并局部重绘；agent 排名 tok/s 同步加权；无数据显示「–」。
- **回退原改动 1 的吞吐部分**：移除 `avgOutputTokensPerSecond` / `throughputSamples` / 速率上限 500；延迟保留 `durationMs >= 2` 剔除 0/1ms 伪计时。
- **保留**：小时图 `hourEvery` 1000→1200、`ResizeObserver` 重绘、`presetRange` 本周起点修复、版本号 0.5.16。
- 真实数据抽查（只读）：16 个会话目录 / 430 个 JSONL 首扫 677ms，二次增量 3ms（changed 0 / reused 430 / fileSetChanged false）；记录 19607（session 14354 / subagent 4292 / automation 648 / memory 296 / utility 17）；端到端输出速率 ALL 22 tok/s（n=19607）、今日 31（n=3689）、本周 25（n=6308）。修复前：全量 20 / 今日 28 / n≈14654（漏 subagent/activity/workflow）。
- 全量测试 **154 pass / 0 fail**（`usage-hub-speed.test.js` 22 项；`usage-hub-0516.test.js` 6 项；`usage-hub-revision.test.js` 延迟断言回退）。
- 待验证：Hana 内视觉回归（hero 端到端输出速率小字与 hover 说明、小时图横轴、侧栏开合重绘）由需求方复核与验收；`speeds.json` 首次落盘与后续增量在宿主内的表现；本轮未启动浏览器或真实网络。

## 2026-09-09 usage-hub 0.5.16 增量：刷新体验 / archive 节流 / 小时轴 / 表格
- **静默刷新**：`renderAll(options)` 新增 `silent`/`feedback` 开关；自动定时与 `visibilitychange` 走 `{silent:true,feedback:false}`（不显示「刷新中」、不重播动画）；手动刷新保留按钮反馈但静默；首屏后常驻 `.uh-silent`，CSS 关闭 `.chart-card svg` 与 `.cnt` 动画；`animateNumbers(root, silent)` 静默直赋，数字不滚动。
- **archive 写盘节流**：`lib/archive.js` 导出 `ARCHIVE_SAVE_MIN_INTERVAL_MS=300000` 与 `archiveSaveDue()`；`index.js` 仅在 `stats.added>0||upgraded>0` 且距上次写盘 ≥5min 时才 `saveArchive`，记录 `state.archiveLastSavedAt`（启动首刷允许写）。实测 19.5MB / 23902 条 archive 单次写 58ms，节流后 5 分钟内的 refresh 跳过。
- **小时图横轴**：`hourEvery` 改为 `>=560?1:>=420?2:3`（≥560px 恒 24 刻度）；标签改纯小时数 `0–23`；`xAxisLabels` 新增 `centerEnds` 让首尾标签也居中对齐柱子；卡片标题补「横轴 · 小时」。
- **命中率表**：新增 `.hitrate-table th:not(:first-child){text-align:right}` 修正表头与数值列错位；`按 Agent`→`Agent 分布`、`按模型`→`模型分布`。
- 全量测试 **159 pass / 0 fail**（新增 `test/usage-hub-refresh.test.js` 4 项；`usage-hub-059.test.js` 小时轴断言随 0.5.16 更新）。
- 待验证：Hana 内静默刷新观感（不白屏 / 不重播）、小时图 24 刻度与字号、表格对齐视觉；本轮未启动浏览器或真实网络。

## 2026-09-09 usage-hub 0.5.17 版本 bump（资源缓存失效）
- 原因：0.5.16 已安装到用户机（`~/.hanako/plugins/usage-hub`，23:16）。若本批改动仍以 0.5.16 覆盖，`routes/ui.js` 的 `panel.js?v=...0.5.16` URL 不变，WebView 会命中旧缓存，修复送不到浏览器。
- 变更：`manifest.json` / `package.json` / `routes/ui.js` `UI_CACHE_VERSION` / 所有内部 `?v=`（含 lib 之间 import）统一升至 `0.5.17`；`test/usage-hub-0516.test.js` 版本一致性断言同步（并改为校验无 `0.5.10~0.5.16` 残留）。
- 无功能改动；全量测试 **159 pass / 0 fail**。

## 2026-09-09 usage-hub 0.5.17 增量：widget 今日概览 / 今日模型速率 / 页面本地快照
- **widget 降级**：无当前会话时不再只显示占位，改为「今日概览」（`/api/summary` + `/api/speed` 当天：总消耗/次数/命中率/今日端到端速率），底部小字保留 `current.reason`；有会话路径不变。
- **widget 今日模型速率**：新增区块（`#wSpeedModel`），`pickWidgetModel()` 优先当前会话模型、否则当天 tps 最高；无数据显示「–」，`title` 说明端到端口径。
- **页面本地快照**：`localStorage` 存 `{version, savedAt, filters, data:{summary,daily,hourly,byType,byAgent,byModel,speed,forecast}}`；进入页面先读快照立即渲染 + 「上次更新 · X 分钟前」，随后静默刷新替换；版本不符/筛选不符/损坏回退正常首屏；>1MB 跳过。实测今日快照 34.4KB。
- **诊断（只查）**：宿主 `/api/sessions/messages` 存在（默认用 `currentSessionPath`，响应含 entryId）；宿主 bundle 无 `hostContext`/`focusedSession` 注入 → `resolveCurrentSession(ctx)` 无显式焦点必返回 null；widget 只能靠 `discoverFocusedSession()`。未定位到确定失效环，不改宿主契约。
- **widget 降级态可诊断**：reason 映射为「宿主未提供当前会话」/「会话文件读取失败」/原始字符串；该行 `title` 带探测过程（宿主 `/api/sessions/messages` HTTP 状态、是否拿到 entryId、解析出的 file）。
- **多 agent 会话查找**：新增 `allAgentSessionDirs()`（仅 `agents/<x>/sessions`，不含 subagent-sessions/activity/workflow-sessions）；`/api/current-session`、`/api/resolve-entry` 并入各 agent 目录，主目录（配置/默认）优先，安全边界（拒绝符号链接/越界）不变。修复 `sessionDirs()` 在给定 `sessionsDirs` 时忽略 `sessionsDir` 的顺序陷阱（主目录放数组首位）。
- **当前会话路径兜底**：`/api/current-session` 优先级 query > ctx 声明焦点 > `ctx.sessionPath` 安全路径兜底 > none；响应加 `source`（`query`/`config`/`ctx-session-path`/`none`）。`safeSessionPath()` 只接受 `.jsonl` 且在允许 sessions 目录内，越界/非 jsonl 忽略；与 `resolveCurrentSession` 拒绝 sessionPath 冒充焦点的语义区分（这里是路径兜底，不是焦点冒充）。
- **诊断补齐**：widget probe 加 `origin`；降级行显示 `source`，`title` 含 HTTP 状态/origin/entryId/解析文件。
- 全量测试 **167 pass / 0 fail**（`test/usage-hub-widget.test.js` 8 项）。

## 2026-09-09 usage-hub 0.5.18 版本 bump + getSessionPath 查证 + sessionKeys 诊断
- **`getSessionPath` 查证（静态 bundle 0.450.0）**：插件 ctx 由 `t.ctx = YSe({...})` 构造，`YSe` 参数**不含** `getSessionPath`，ctx 上**无**可调用的 `getSessionPath`；它仅作为插件管理器内部依赖 `_getSessionPath`，用于 tool 调用时的会话路径解析（`y = p?.sessionPath || ... || this._getSessionPath?.()`），未暴露到插件 ctx / 路由 ctx。按约定不猜改，保留 `ctx.sessionPath` 兜底。
- **运行时诊断**：`/api/current-session` 在 `source === "none"` 时额外返回 `sessionKeys`（`Object.keys(ctx)` 中带 session/path/focus 字样的 key 名，只列 key 不列值）。
- **版本 bump 0.5.18**：0.5.17 已安装，bump 以刷新 WebView 资源缓存；manifest / package / `UI_CACHE_VERSION` / 所有内部 `?v=` 统一 0.5.18；版本守卫扩到 `0.5.1[0-7]`。
- 全量测试 **167 pass / 0 fail**。

## 2026-09-09 usage-hub 0.5.19 最近活跃会话兜底 + 可见诊断
- **背景**：用户复现 widget 显示「宿主未提供当前会话 · 来源 none」——三条路全断（宿主不注入焦点、`ctx.sessionPath` 为空、`discoverFocusedSession()` 探测返回 null）。
- **latest-session 兜底**：全部来源拿不到时，扫当前 agent（`ctx.agentId` / `c.get("agentId")`，回退 hanako）的 `sessions/` 顶层 .jsonl，取 30 分钟内 mtime 最新者，经 `safeSessionPath()` 复核（.jsonl + 允许根内）；`source` 新增 `latest-session`；新增 `latestActiveSession()`。
- **可见诊断**：降级行直接显示「探测：HTTP {status} · entryId {有/无} · origin {origin}」；`source=latest-session` 时标注「按最近活跃会话推断」（正常渲染与降级态都显示）。
- **版本 bump 0.5.19**：0.5.18 已安装；manifest / package / `UI_CACHE_VERSION` / 所有内部 `?v=` 统一；版本守卫扩到 `0.5.1[0-8]`。
- 全量测试 **170 pass / 0 fail**（`test/usage-hub-widget.test.js` 11 项）。

## 2026-09-09 usage-hub 0.5.20 hero/widget 文案与模型速率卡片
- **hero**：「端到端输出速率」→「Token 平均速率」，去掉「加权 · N 次」标注，hover 精简为「Σ输出 token ÷ Σ间隔（含工具调用等待与网络排队），过滤 100ms~10min。」；**算法不变**（仍加权 Σout/Σdur）。
- **模型分布卡**：去掉模型用量对比卡下方的 `SPEED_HINT` 提示句；agent 排名行 `title` 保留。
- **widget 上下文占用**：`wDays` 改为当前会话上下文占用百分比（一位小数），无数据「–」，`title`「最近一轮输入 + 缓存读取 ÷ 模型上下文窗口」。
- **widget 模型速率卡片式**：标题「当前会话模型速率」；列出当前会话每个模型（`d.turns` 去重）逐项速率（绿色 `var(--green)`）；speed 记录补 `sessionId`（JSONL 取 `session` 事件、ledger 取 `attribution.sessionId`），`buildSpeedStats` 支持 `sessionId`，`/api/speed` 收 `sessionId`，`SPEED_CACHE_VERSION` 升 2 触发重扫；无会话退回当天 `byModel`。
- **版本 bump 0.5.20**：manifest / package / `UI_CACHE_VERSION` / 所有内部 `?v=` 统一；版本守卫扩到 `0.5.1[0-9]`。
- 全量测试 **174 pass / 0 fail**。

## 2026-09-09 usage-hub 0.5.21 archive 瘦身（数据结构）
- **白名单**：`requestId/startedAt/endedAt/durationMs/status`、`usage.{input.totalTokens,input.uncachedTokens,output.totalTokens,output.reasoningTokens,cache.readTokens,cache.writeTokens,totalTokens}`、`model.{provider,modelId}`、`source.{subsystem,operation}`、`attribution.{kind,agentId,sessionId,sessionFile(新，sessionPath basename)}`、`_migrated`。
- **删除**：`schemaVersion/source.{surface,trigger,parent,actor}/attribution.sessionPath/metadata/rawUsageShape/error/model.api/usage.costTotal/usage.cache.{missTokens,hit,created,hitRatio,support}`（`migrate.js` 里的 `conversationType` 也不在白名单，一并去掉）。
- **实现**：`lib/archive.js` 新增 `slimEntry/slimArchive/migrateArchiveToSlim`，`ARCHIVE_VERSION=2`；`mergeIntoArchive` 写入即瘦身；`lib/migrate.js` 转换后即瘦身；`index.js` 首次加载旧版本时就地迁移（原文件改名备份 `archive.pre-slim-<ts>.json` + tmp+rename 原子写，失败保留原文件）；`/api/session-titles` 改读 `attribution.sessionFile`，缺失回退 `raw[sessionId]`。缺失字段不补 0（保持回退语义）。
- **真实数据对比**（副本）：条目 24111→24111；文件 19.78MB→12.23MB（860→532 B/条）；totalTokens/hitRatio/cacheRead/uncached/output/errors/reasoning、byType/byAgent/byModel/byProvider、speed.tps/textTps/count/byModel 逐项一致。
- **回归修复（M1，冷冷终审）**：`sessionTitleMap` 合并侧车时未给绝对路径键补 basename 别名，瘦身删 `sessionPath` 后历史会话标题失配；现为每个键补 basename 键（`k !== basename` 才补）。真实 `hanako/sessions/session-titles.json` 实测 25/25 绝对路径键 basename 映射成功；`resolveTitle` 的 `titles[item.file]` 因 file 已是 basename 而自然生效。
- **版本 bump 0.5.21**。
- 全量测试 **180 pass / 0 fail**。

## 2026-09-09 usage-hub 子代理归属修正（紧急，插入 0.6.0 Phase ② 之前）
- **问题**：subagent 条目 `attribution.agentId` 恒为父 agent，真实子代理在 `source.actor.agentId`（archive 实测 cece-engineer 2966 / lengleng-audit 400 / 无 1352）；byAgent 与速度 byAgent 把子代理消耗算到父 agent。
- **修正**：`lib/archive.js` 的 `slimEntry` 提升 `source.actor.agentId` → `attribution.actorAgentId`（无则省略，不保留整个 `source.actor`）；新增统一 `agentOf(e)`（subagent 且 actorAgentId 存在 → actorAgentId，否则 `attribution.agentId`，缺失回退父 agent）；`aggregate.js`（byAgent + agent 筛选）、`speed-scan.js`（ledger 口径）、`rollup.js`（byAgent）共用。
- **真实数据**：byAgent 修正前 hanako 2,569,448,349；修正后 hanako 2,045,433,117 / cece-engineer 483,846,651 / lengleng-audit 40,170,724；各 agent 之和 = 总消耗 2,572,167,612；rollup 与 aggregate 一致。
- 全量测试 **196 pass / 0 fail**。

## 2026-09-09 usage-hub 0.6.0 预聚合存储（架构变更）
- **动机**：`archive.json` 随历史无限增长（实测 23873 条 / 19.8MB），每次刷新全量读写；改为按「天 + 小时 + 维度」预聚合，体积随天数线性、不随调用数增长。
- **结构**：`rollup.json` = `{ version, updatedAt, lastMergedAt, recentIds, days, recentSessions, speeds }`。`days[day]` = total / hours（含 byType）/ byType / byAgent（含 byType/byModel/byProvider 交叉表）/ byModel / byProvider；`recentSessions` 仅 30 天（小时图「会话」模式）；`speeds` 账本口径（无 sessionId 的不做每会话上限）。`recentIds` 最近 5000 条判重，避免滚动窗口重复计入。
- **迁移**：首次加载从 `archive.json` 聚合出 rollup；先写 rollup（原子）再把 archive 改名备份 `archive.pre-rollup-<ts>.json`（不覆盖、不删除）；失败不动原文件；重复启动幂等（rollup 已存在则直接加载）。
- **读取链路**：新增 `aggregateRollup`（输出契约与 `aggregateEntries` 对齐，旧函数保留给测试）；`index.js` / `routes/api.js` 全部切到 rollup；`/api/session-titles` 读 `rollup.recentSessions`；`/api/status` 加 `lastSpeedScanAt`；`/api/summary` 返回 `degraded`。
- **子代理归属修正**：新增 `agentOf()` 统一（subagent 归 `source.actor.agentId` / 瘦身后的 `attribution.actorAgentId`，缺失回退父 agent）；`slimEntry` 保留 `actorAgentId`。
- **功能降级**：放弃单次调用明细、延迟分布、多条件交叉筛选；筛选维度只取第一个非空（agent→model→provider→type）；按 agent 筛选分布卡走交叉表，其余维度筛选下分布卡/小时图显示时间范围全量并标注「未随筛选变化」。
- **前端**：hero「Token 平均速率」（去加权字样、算法不变）；widget「当前会话模型速率」卡片式、「上下文占用」百分比；页脚「上次后台扫描：X 分钟前」。
- **真实数据对比（副本）**：archive 19.88MB → rollup 0.35MB；summary / daily / hourly / byType / byAgent / byModel / byProvider / hitRatio / speed 新旧逐项一致；各 agent 之和 = 总消耗；cece-engineer 518,616,693 / lengleng-audit 40,170,724 从 hanako 分出。
- **版本 bump 0.6.0**；全量测试 **199 pass / 0 fail**。
- 待验证：Hana 内首次迁移（备份生成、页面统计）、视觉回归。

## 2026-09-09 usage-hub 工程修复：临时目录不再堆积
- **根因**：测试与验证脚本用 `mkdtemp` 建临时目录不删——`_tmp/` 累积 1.7G / 10374 个目录，系统 `/tmp` 累积 397 个 `usage-hub-*`。
- **修正**：`test/helpers.js` 的 `tmpDir()` 统一落项目 `_tmp/`（不再写系统 `/tmp`），登记后在 `after(cleanupTmpDirs)` 与进程退出钩子里 `rm -rf`（插件后台任务可能在 `after()` 之后写回目录，退出钩子会再清一次，为最终清理）；新增 `guardTmpRoot()`：`_tmp` 顶层 > 200 告警。所有测试的 `fs.mkdtempSync(os.tmpdir()/ "/tmp")` 改为 `tmpDir()`。scripts 无临时创建。
- **验证**：连续 3 次 `node --test` → **201 pass / 0 fail**，`_tmp` 顶层恒为 9（用户保留的脚本），零增长。
- 说明：系统 `/tmp` 下既有 397 个旧目录因沙盒限制未能在本轮清理（已不再新增）。

## 2026-09-09 usage-hub 冷冷终审跟进（M1 + S1–S6）
- **M1（必须修）hidden 在 rollup 路径失效**：`degradeRollupFilter` 透传 hiddenAgents/hiddenModels；`aggregateRollup` 新增 `buildHiddenView`——用 `byAgent[agent].byModel` 交叉表精确排除 hidden agent/model，summary/daily/byType/byModel 均不含被隐藏项（byType/byProvider 对 hidden model 不精确、hourly 无 hour×维度，已在注释说明）。
- **S1**：前端切换某维度筛选时自动清空其他维度，并显示「当前生效维度：xxx」。
- **S2**：`rollup.speeds` 与 `speeds.json` 统一为 30 天 + 每会话 500 + 总量 20000（rollup 实际 2851→1832）。
- **S3**：降级提示覆盖来源类型卡/日趋势卡（未随筛选变化）+ 小时图会话模式（仅最近 30 天）。
- **S4**：`loadRollup` 校验 recentIds；缺失时退化为水位线判重（不全量双计）；seed 改为账本 requestId 全集 ∪ 最近 5000。
- **S5/S6**：文档注明 archive 现为导入中间件/只读来源；迁移遇无 actorAgentId 的 v2 条目时从账本补归属并告警；修正 index.js 顶部过时注释。
- 真实数据：hidden=manman → summary 2,659,014,320 → 2,656,302,078（差 2,712,242 = manman 消耗），byAgent/byModel 不含 manman，各 agent 之和 == total；rollup 1.08MB / speeds 1832。
- 全量测试 **204 pass / 0 fail**。
