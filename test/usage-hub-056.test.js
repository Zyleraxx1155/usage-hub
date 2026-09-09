// test/usage-hub-056.test.js — 0.5.6：密钥来源、Agent 中文名、底部清理、命中率分析块
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BalanceService } from "../lib/balance.js";

const panelSource = () => fs.readFileSync(new URL("../assets/panel.js", import.meta.url), "utf8");
const apiSource = () => fs.readFileSync(new URL("../routes/api.js", import.meta.url), "utf8");
const indexSource = () => fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test("0.5.6: 设置抽屉不再内联密钥输入，说明密钥来自宿主", () => {
  const source = panelSource();
  assert.doesNotMatch(source, /setDeepseek|setMoonshot/, "设置抽屉不应再有密钥输入框");
  assert.doesNotMatch(source, /deepseekApiKey:\s*settingsEl/, "保存 payload 不应再提交密钥");
  assert.match(source, /provider-catalog\.json/, "应提示密钥来自 Hana 设置");
});

test("0.5.6: 底部不再渲染数据源/统计/图例，hero 改用总消耗", () => {
  const source = panelSource();
  assert.doesNotMatch(source, /数据源 usage-ledger/, "底部数据源行应移除");
  assert.doesNotMatch(source, /foot-note/, "底部统计行应移除");
  assert.match(source, /\["总消耗"/, "总 tokens 应改名为总消耗");
  assert.doesNotMatch(source, /\["总 tokens"/);
});

test("0.5.6: Agent 显示中文名，筛选与持久化仍用 agentId", () => {
  const source = panelSource();
  assert.match(source, /function agentLabel\(id\)/);
  assert.match(source, /state\.status\?\.agentNames/);
  assert.match(source, /data-value="\$\{esc\(item\)\}"/, "隐藏项的值仍应是 agentId");
  assert.match(source, /fill\("fAgent", state\.options\.agents, "全部 agent", agentLabel\)/, "筛选下拉应显示中文名");
});

test("0.5.6: 宿主 status 返回 agentNames 映射，index 通过 agent:list 获取", () => {
  assert.match(apiSource(), /agentNames: h\.agentNames \|\| \{\}/);
  const idx = indexSource();
  assert.match(idx, /bus\.request\("agent:list"\)/);
  assert.match(idx, /agentNames: \{\}/, "初始状态应有空映射兜底");
});

test("0.5.6: 命中率分析块列不含伪造的写入列", () => {
  const source = panelSource();
  assert.match(source, /缓存命中率分析/);
  assert.match(source, /<th>名称<\/th><th>命中率<\/th><th>读取<\/th><th>调用<\/th><th>总消耗<\/th>/);
  assert.doesNotMatch(source, /<th>写入<\/th>/, "聚合层没有 cacheWrite 口径，不应伪造写入列");
  assert.match(source, /id="hitRateCard"/);
});

test("0.5.6: 余额查询配置驱动，key 取自宿主 provider-catalog", async () => {
  const dir = tmp("usage-hub-balance-apis-");
  const home = tmp("usage-hub-balance-home-");
  fs.writeFileSync(path.join(home, "provider-catalog.json"), JSON.stringify({ providers: { acme: { api_key: "acme-key" } } }));
  fs.writeFileSync(path.join(dir, "balance-apis.json"), JSON.stringify({ acme: { url: "https://acme.test/balance", enabled: true } }));
  const calls = [];
  const service = new BalanceService({
    dataDir: dir,
    homeDir: home,
    fetchFn: async (url, init) => { calls.push([url, init.headers.Authorization]); return { ok: true, json: async () => ({ balance: 42 }) }; },
  });
  const result = await service.refresh();
  const acme = result.sources.find((source) => source.id === "acme");
  assert.equal(acme.status, "ok");
  assert.equal(acme.balance, 42);
  assert.ok(calls.some(([url, auth]) => url === "https://acme.test/balance" && auth === "Bearer acme-key"));
});

test("0.5.6: balance-apis.json 可禁用默认供应商", async () => {
  const dir = tmp("usage-hub-balance-disable-");
  const home = tmp("usage-hub-balance-disable-home-");
  fs.writeFileSync(path.join(home, "provider-catalog.json"), JSON.stringify({ providers: { deepseek: { api_key: "deep-key" } } }));
  fs.writeFileSync(path.join(dir, "balance-apis.json"), JSON.stringify({ deepseek: { enabled: false } }));
  const calls = [];
  const service = new BalanceService({ dataDir: dir, homeDir: home, fetchFn: async (url) => { calls.push(url); return { ok: true, json: async () => ({ balance_infos: [{ total_balance: 1 }] }) }; } });
  await service.refresh();
  assert.equal(calls.some((url) => String(url).includes("deepseek")), false, "被禁用的供应商不应发起请求");
});
