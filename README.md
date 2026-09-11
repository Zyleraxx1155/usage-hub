# usage-hub · 用量中心

Usage Hub 是一个 Hana 插件，用于统计 Token 用量、展示趋势与来源分布，并提供独立的供应商余额与 ChatGPT/Codex 额度状态。

当前版本：`0.7.2`

## 功能范围

- 读取 Hana 全量账本并构建增量预聚合视图
- 展示 Token 总量、趋势、来源类型、模型、Provider、Agent 和会话数据
- 根据内置价格表提供 DeepSeek 估算消费
- 支持供应商余额与 ChatGPT/Codex 额度查询
- 余额与额度使用独立请求、独立刷新、独立节流和合并写回
- 提供页面与状态栏小组件

## 目录结构

```text
manifest.json
package.json
index.js
routes/
  api.js
  ui.js
lib/
  aggregate.js
  archive.js
  balance.js
  date-presets.js
  forecast.js
  ledger-reader.js
  migrate.js
  model-config.js
  paths.js
  pricing.js
  rollup.js
  session-reader.js
  settings.js
  speed-scan.js
  speed-stats.js
  types.js
assets/
  panel.js
  panel.css
scripts/
  migrate.mjs
```

## 余额与额度

余额与额度是两条互不阻塞的链路：

- `GET /api/balance`：读取最后一次冷快照，不联网
- `POST /api/balance/refresh-suppliers`：只刷新供应商余额
- `POST /api/quota/refresh`：只刷新 ChatGPT/Codex 额度
- `POST /api/balance/refresh`：兼容旧调用方，执行余额与额度整包刷新

单独刷新一类时，只请求对应上游，并保留另一类的 last-good 快照。未配置 Codex 不会影响供应商余额。

manifest 已声明 `network.fetch`，并允许以下域名：

- `api.deepseek.com`
- `api.moonshot.cn`
- `open.bigmodel.cn`
- `api.minimaxi.com`
- `chatgpt.com`

## 数据与安全

插件运行时的数据、设置、凭据、归档、预聚合和缓存均保存在宿主数据目录，不写回插件包。凭据与公开设置分开保存，公开接口只返回 configured/masked 等状态，不返回密钥原文。

主存储为 `rollup.json`。旧版 `archive.json` 仅作为一次性迁移来源；迁移 CLI 默认只演练，使用 `--apply` 才会写盘。

## 运行要求

- Hana App `0.159.0` 或更高版本
- Node.js `22.5.0` 或更高版本
- 插件以 ESM 方式运行，无第三方运行时依赖

## 一次性迁移

```bash
node scripts/migrate.mjs --src ~/.hanako/plugin-data/token-tracker/usage-archive.json --dst _tmp/migrate-run/archive.json
node scripts/migrate.mjs --apply [--force]
```
