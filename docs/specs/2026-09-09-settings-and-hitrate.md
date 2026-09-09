# usage-hub 0.5.6 设置与呈现收口

> 2026-09-09 需求方确认。承接 0.5.5 前端呈现调整，本批处理设置、凭据来源、
> Agent 显示名、命中率分析块与底部清理。

## 需求来源

| 编号 | 原始描述 | 确认结论 |
|---|---|---|
| 6 | 额度和余额没用，设置点了保存跟没点一样 | 余额/额度**保留**，只显示能拿到数据的来源（如 DeepSeek）；设置保存反馈单独排查 |
| 7 | 相关供应商的 key 可以直接在 hanako 的设置里面获取 | 宿主配置作为唯一来源，插件设置里的 key 输入框去掉 |
| 8 | 页面最底下的数据源什么的可以去除掉了 | 底部整块去掉（数据源行 + 统计行 + 颜色图例） |
| 9 | 为啥要给我的 agent 助手都用拼音显示名字呢 | 显示中文名，无映射时回落 id |
| 10 | 很喜欢用量里面的缓存命中率分析卡片，按着那个改 | **保留**「每日命中率趋势」折线卡，**新增**环形总命中率 + 按 Agent/模型表格 |

## 已核实的事实

- 宿主凭据在 `~/.hanako/provider-catalog.json` 的 `providers.<id>.api_key`。
  当前实配：`deepseek`（有 key）、`agnes`（有 key）、`openai-codex-oauth`（无 key）、`llm-qwen`（无 key）；
  **没有 moonshot**。因此 Moonshot 余额本来就不该出现。
- `lib/balance.js` 的 `roots` 已包含 `os.homedir()`，理论上能读到
  `~/.hanako/provider-catalog.json`。DeepSeek 余额为何没出来，需要实施时实测定位
  （key 读取 / 网络白名单 / 接口返回 三者之一）。
- Agent 中文名来源：Hana 插件 API `bus.request("agent:list")` 返回 `{ agents: [{ id, name }] }`，
  `token-tracker` 已用此方式实现（`index.js` 里建 `agentNames` 映射）。
- token-tracker 的「缓存命中率分析」块 = 环形总命中率 + 按 Agent 表格 + 按模型表格，
  列：名称 / 命中率 / 读取 / 写入 / 调用 / 总消耗。

## 改动清单

### A. 凭据来源改为宿主优先，去掉插件 key 输入框

后端（`lib/balance.js`）：

- 凭据解析顺序调整为：**宿主 `provider-catalog.json`（含 `~/.hanako/provider-catalog.json`）
  → 宿主 `auth.json` → 插件私有 settings.credentials（仅作兼容 fallback）**。
  即宿主有值时不再被插件里的旧值覆盖。
- 保持响应脱敏，任何 key 都不出现在接口响应里。

前端（`assets/panel.js`）：

- 设置抽屉里删除「DeepSeek Key」「Moonshot Key」两个输入框。
- 保存 payload 中不再包含 `credentials`。
- 若 `lib/settings.js` 的 credentials 结构因此不再被写入，保留读取兼容，不删结构（避免旧数据报错）。

验收：

- 设置抽屉不再出现任何 key 输入框。
- DeepSeek 余额来自宿主 catalog，不需要在插件里填任何东西。

### B. 余额 / 额度卡：只显示能拿到数据的来源

- 卡片渲染规则：**只渲染已配置的来源**（现状即 `filter(s => s.configured)`）；
  未配置的供应商（如 Moonshot）不出现，也不留空位。
- 若某来源已配置但取数失败，必须显示明确状态（如「不可用」）并保留手动刷新入口，
  不能静默消失——否则用户无法区分「没配」和「配了但失败」。
- **实施时必须实测 DeepSeek 余额能否取到**，并记录失败原因（key / 网络白名单 / 接口）。
  若为插件网络白名单问题，在 `manifest.json` 的 `network.allowedHosts` 补齐对应域名。

验收：页面只出现 DeepSeek 余额（额度卡因无 Codex 配置不出现）；取数失败时有可见状态。

### C. 底部区域整块移除

`assets/panel.js` 的 `renderFoot`：

- 删除 `foot-file`（「数据源 usage-ledger…」）与 `foot-note`（「合并 N 条 · 账本窗口…」）。
- 删除 `fb-legend` 颜色图例（「输入构成」卡内已有等价图例）。
- 若容器最终为空，保持隐藏，不留空白占位。
- 同步清理 `assets/panel.css` 中仅服务于这些节点的样式（确认无其他引用后再删）。

验收：页面底部不再出现任何数据源/统计/图例文案。

### D. Agent 显示中文名

后端（`index.js`）：

- `onload` 时调用 `bus.request("agent:list")`，构建 `agentId → name` 映射存到插件 state；
  失败时降级为空映射并 `log.warn`，不得抛错阻断加载。
- 通过 `/api/status` 返回该映射（字段名 `agentNames`）。

前端（`assets/panel.js`）：

- Agent 消耗排名、Agent 分布图、筛选下拉、设置里的「助手逐项隐藏」列表，
  一律优先显示中文名，无映射时回落 `agentId`。
- **值仍然用 `agentId`**：筛选参数、`hiddenAgents` 持久化、接口请求都不变，
  只改显示文案。

验收：页面显示「笨笨 / 测测 / 冷冷 / 慢慢 / 账账」，不再出现 `hanako`、`cece-engineer` 这类 id。

### E. 新增「缓存命中率分析」块

- 保留现有「每日命中率趋势」折线卡不动。
- 新增一块卡片：环形总命中率 + 按 Agent 表格 + 按模型表格。
- 数据来源：`state.summary.summary.hitRatio`、`state.byAgent`、`state.byModel`。
- 表格列：名称 / 命中率 / 读取 / 调用 / 总消耗。
  **不设「写入」列**——usage-hub 聚合层没有 cacheWrite 口径，不伪造字段。
- 视觉沿用现有 accent / 玻璃卡片风格，环形图用原生 SVG，不引第三方图表库。
- 位置：与命中率相关图表相邻（分布区附近），具体由实施者按现有栅格决定。

验收：总命中率环形可读；按 Agent / 按模型表格的命中率、读取、调用、总消耗与筛选范围一致；
切换筛选后表格同步。

### F. 设置保存反馈

- 先诊断：保存后是否出现「已保存」、设置文件是否落盘、`/api/settings` 是否返回新快照。
- 若链路正常，问题是「余额无数据导致看不出变化」，则本项按 B 处理即可。
- 无论如何，保存结果反馈要足够明显：成功/失败文案保留足够时长（≥ 2 秒），
  并在保存成功后立即刷新余额快照。

验收：点保存能明确看到结果；保存后余额区状态与设置一致。

## 版本与缓存

- `manifest.json` / `package.json` / `routes/ui.js` 的 `UI_CACHE_VERSION` 升到 `0.5.6`。
- 所有内部相对 import 的 `?v=` 同步改为 `0.5.6`（版本一致性测试强制校验）。

## 不做什么

- 不改聚合口径与 `/api/summary`、`/api/daily` 等返回结构（`/api/status` 只增 `agentNames`）。
- 不动 0.5.5 已确认的单日/多日图表切换与输入构成粒度逻辑。
- 不引入第三方依赖。
- 不删除 `lib/settings.js` 的 credentials 结构（保留兼容，仅前端不再写入）。

## 测试要求

- 新增断言：设置抽屉不含 key 输入框；`/api/status` 返回 `agentNames`；
  Agent 显示优先中文名且值仍为 id；底部不再渲染数据源/统计/图例；
  命中率分析块的表格列不含「写入」。
- `lib/balance.js`：宿主 catalog 凭据优先于插件 credentials 的回归用例。
- 全量测试通过，版本一致性测试通过。
