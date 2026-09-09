import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadSettings, publicSettings, validateAndSave } from "../lib/settings.js";
import { BalanceService } from "../lib/balance.js";
import { tmpDir, cleanupTmpDirs } from "./helpers.js";

after(cleanupTmpDirs);

test("settings: 原子存储、掩码、空凭据保留与范围/未知字段拒绝", () => {
  const dir = tmpDir("settings");
  validateAndSave(dir, { credentials: { deepseekApiKey: "sk-secret-value" }, ui: { refreshSeconds: 120 } });
  const view = publicSettings(dir);
  assert.equal(view.credentials.deepseekApiKey.configured, true);
  assert.ok(!JSON.stringify(view).includes("sk-secret-value"));
  validateAndSave(dir, { credentials: { deepseekApiKey: "" } });
  assert.equal(loadSettings(dir).credentials.deepseekApiKey, "sk-secret-value");
  assert.throws(() => validateAndSave(dir, { nope: true }), /unknown field/);
  assert.throws(() => validateAndSave(dir, { balance: { pollSeconds: 1 } }), /out of range/);
  assert.equal(fs.statSync(path.join(dir, "settings", "credentials.json")).mode & 0o077, 0);
});

test("balance: ctx network fetch and provider catalog base_url/key are preferred", async () => {
  const dir = tmpDir("balance-network-catalog");
  validateAndSave(dir, { balance: { codexEnabled: false } });
  const calls = [];
  const service = new BalanceService({ dataDir: dir, fetchFn: async (url) => { calls.push(url); return { ok: true, json: async () => ({ balance_infos: [{ total_balance: 3.5, currency: "USD" }] }) }; }, providerCatalog: { providers: { deepseek: { base_url: "https://catalog.deepseek.test", api_key: "catalog-key" } } } });
  const result = await service.refresh();
  assert.equal(result.sources.find((s) => s.id === "deepseek").balance, 3.5);
  assert.ok(calls.includes("https://catalog.deepseek.test/user/balance"));
});

test("balance: Codex OAuth headers and primary/secondary quota fields", async () => {
  const dir = tmpDir("balance-codex-headers");
  validateAndSave(dir, { balance: { codexEnabled: true } });
  const headers = [];
  const service = new BalanceService({ dataDir: dir, auth: { "openai-codex": { access: "oauth-token", accountId: "acct" } }, fetchFn: async (_url, init) => { headers.push(init.headers); return { ok: true, json: async () => ({ rate_limit: { primary_window: { used: 2, limit: 10, remaining: 8, reset_at: "tomorrow" }, secondary_window: { remaining: 20 } } }) }; } });
  const result = await service.refresh();
  const codex = result.sources.find((s) => s.id === "codex");
  assert.equal(codex.remaining, 8); assert.equal(codex.secondaryRemaining, 20);
  assert.equal(headers.at(-1)["OpenAI-Beta"], "codex-1"); assert.equal(headers.at(-1).originator, "Codex Desktop"); assert.equal(headers.at(-1)["ChatGPT-Account-ID"], "acct");
});

test("balance: Codex 百分比窗口保留 primary/secondary 与可用 remaining", async () => {
  const dir = tmpDir("balance-codex-percent"); validateAndSave(dir, { balance: { codexEnabled: true } });
  const service = new BalanceService({ dataDir: dir, auth: { codex: { access_token: "percent-token" } }, fetchFn: async (url) => ({ ok: true, json: async () => url.includes("chatgpt") ? ({ rate_limit: { primary_window: { used_percent: 12, reset_at: "tomorrow", limit_window_seconds: 10800, token: "raw-secret", unexpected: "raw-extra" }, secondaryWindow: { usedPercent: 25, resetAt: "later", limitWindowSeconds: 3600, token: "raw-secondary" } } }) : ({ balance_infos: [{ total_balance: 1 }] }) }) });
  const codex = (await service.refresh()).sources.find((x) => x.id === "codex");
  assert.equal(codex.remaining, 88); assert.equal(codex.remainingPercent, 88); assert.equal(codex.reset, "tomorrow");
  assert.equal(codex.primary.remaining, 88); assert.equal(codex.primary.remainingPercent, 88); assert.equal(codex.primary.limitWindowSeconds, 10800);
  assert.equal(codex.secondary.remaining, 75); assert.equal(codex.secondary.remainingPercent, 75); assert.equal(codex.secondary.reset, "later");
  assert.equal("token" in codex, false); assert.equal("unexpected" in codex.primary, false); assert.equal("token" in codex.secondary, false);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, "balance.json"), "utf8"));
  assert.equal("token" in persisted.sources.find((x) => x.id === "codex"), false);
  assert.equal("unexpected" in persisted.sources.find((x) => x.id === "codex").primary, false);
  const restarted = new BalanceService({ dataDir: dir, fetchFn: async () => { throw new Error("must not fetch"); } }).snapshot();
  assert.equal(restarted.sources.find((x) => x.id === "codex").primary.remainingPercent, 88);
});

test("balance: Moonshot base_url 按 /v1 规范拼接", async () => {
  const urls = [];
  for (const base of ["https://moonshot.test/v1", "https://moonshot.test/api"]) {
    const dir = tmpDir("balance-moonshot-url"); validateAndSave(dir, { credentials: { moonshotApiKey: "moon-key" } });
    const service = new BalanceService({ dataDir: dir, providerCatalog: { providers: { moonshot: { base_url: base } } }, fetchFn: async (url) => { urls.push(url); return { ok: true, json: async () => ({ data: { available_balance: 2 } }) }; } });
    await service.refresh();
  }
  assert.deepEqual(urls.filter((url) => url.includes("moonshot.test")), ["https://moonshot.test/v1/users/me/balance", "https://moonshot.test/api/v1/users/me/balance"]);
});

test("balance: mock 适配、关闭 Codex、last-good 持久化与并发去重", async () => {
  const dir = tmpDir("balance");
  validateAndSave(dir, { credentials: { deepseekApiKey: "deep-key", moonshotApiKey: "moon-key" }, balance: { codexEnabled: false } });
  let calls = 0;
  const fetchFn = async (url) => { calls++; if (url.includes("deepseek")) return { ok: true, json: async () => ({ balance_infos: [{ currency: "CNY", total_balance: "12.5" }] }) }; return { ok: true, json: async () => ({ data: { available_balance: 8 } }) }; };
  const service = new BalanceService({ dataDir: dir, fetchFn, homeDir: tmpDir("home") });
  const [a, b] = await Promise.all([service.refresh(), service.refresh()]);
  assert.deepEqual(a, b); assert.equal(calls, 2);
  assert.equal(a.sources.find((x) => x.id === "deepseek").balance, 12.5);
  assert.equal(a.sources.find((x) => x.id === "codex").disabled, true);
  assert.equal(service.snapshot().cached, true);
  assert.ok(fs.existsSync(path.join(dir, "balance.json")));
});

test("balance: 宿主 Codex 开关兜底、插件显式 false 优先且动态根路径可发现 catalog/auth", async () => {
  const root = tmpDir("balance-host-root"); const dir = tmpDir("balance-host-data");
  fs.writeFileSync(path.join(root, "provider-catalog.json"), JSON.stringify({ providers: { deepseek: { key: "root-key", base_url: "https://root.deepseek.test" } } }));
  fs.writeFileSync(path.join(root, "auth.json"), JSON.stringify({ codex: { access_token: "root-codex" } }));
  const config = { get: (key) => ({ enableCodexQuota: true, sessionsDir: root }[key]) };
  const urls = [];
  const service = new BalanceService({ dataDir: dir, pluginDir: root, config, fetchFn: async (url) => { urls.push(url); return { ok: true, json: async () => url.includes("chatgpt") ? ({ rate_limit: { used: 1, limit: 4 } }) : ({ balance_infos: [{ total_balance: 2 }] }) }; } });
  const result = await service.refresh();
  assert.equal(result.sources.find((x) => x.id === "codex").remaining, 3);
  assert.ok(urls.includes("https://root.deepseek.test/user/balance"));

  const disabledDir = tmpDir("balance-host-disabled");
  validateAndSave(disabledDir, { balance: { codexEnabled: false } });
  const disabled = await new BalanceService({ dataDir: disabledDir, pluginDir: root, config, fetchFn: async () => ({ ok: true, json: async () => ({ rate_limit: { used: 1, limit: 4 } }) }) }).refresh();
  assert.equal(disabled.sources.find((x) => x.id === "codex").disabled, true);
});

test("balance: network 与 unauthorized 只返回稳定状态", async () => {
  const dir = tmpDir("balance-errors");
  validateAndSave(dir, { credentials: { deepseekApiKey: "key" } });
  const service = new BalanceService({ dataDir: dir, fetchFn: async () => { throw new Error("fetch failed"); } });
  const result = await service.refresh();
  assert.equal(result.sources.find((x) => x.id === "deepseek").status, "network");
  assert.ok(!JSON.stringify(result).includes("key"));
});

test("settings: 重载保留 false/0 且磁盘未知字段不进入公开设置", () => {
  const dir = tmpDir("settings-reload");
  fs.mkdirSync(path.join(dir, "settings"), { recursive: true });
  fs.writeFileSync(path.join(dir, "settings", "settings.json"), JSON.stringify({ display: { hideAgent: false, hideModel: true, leaked: "x" }, ui: { refreshSeconds: 0, leaked: true }, balance: { enabled: false, pollSeconds: 0, codexEnabled: false, leaked: true }, leaked: true }));
  const view = publicSettings(dir);
  assert.equal(view.display.hideAgent, false); assert.equal(view.ui.refreshSeconds, 0); assert.equal(view.balance.enabled, false); assert.equal(view.balance.pollSeconds, 0);
  assert.equal("leaked" in view, false); assert.equal("leaked" in view.display, false); assert.equal("leaked" in view.balance, false);
});

test("settings: 任意短凭据固定掩码，长凭据不含完整原文", () => {
  const dir = tmpDir("settings-mask");
  for (const key of ["a", "1234567"]) validateAndSave(dir, { credentials: { deepseekApiKey: key } });
  assert.equal(publicSettings(dir).credentials.deepseekApiKey.masked, "••••");
  validateAndSave(dir, { credentials: { deepseekApiKey: "abcdefghijk" } });
  const masked = publicSettings(dir).credentials.deepseekApiKey.masked;
  assert.ok(masked && !masked.includes("abcdefghijk"));
});

test("balance: 空供应商响应是 malformed_response，AbortError 是 network", async () => {
  const dir = tmpDir("balance-malformed"); validateAndSave(dir, { credentials: { deepseekApiKey: "secret" } });
  const malformed = new BalanceService({ dataDir: dir, fetchFn: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal((await malformed.refresh()).sources.find((x) => x.id === "deepseek").status, "malformed_response");
  const aborted = new BalanceService({ dataDir: dir, fetchFn: async () => { const e = new Error("stop"); e.name = "AbortError"; throw e; } });
  assert.equal((await aborted.refresh()).sources.find((x) => x.id === "deepseek").status, "network");
});

test("balance: Codex account_id 加入请求头且不返回 token", async () => {
  const home = tmpDir("codex-home"); const dir = tmpDir("codex-balance");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "codex-secret", account_id: "acct-1" } }));
  validateAndSave(dir, { balance: { codexEnabled: true } });
  let seen;
  const service = new BalanceService({
    dataDir: dir,
    homeDir: home,
    fetchFn: async (_url, init) => {
      seen = init.headers;
      return { ok: true, json: async () => ({ rate_limit: { used: 1, limit: 4 } }) };
    },
  });
  const result = await service.refresh();
  assert.equal(result.sources.find((x) => x.id === "codex").remaining, 3);
  assert.equal(seen["ChatGPT-Account-ID"], "acct-1"); assert.ok(seen["User-Agent"]); assert.ok(!JSON.stringify(result).includes("codex-secret"));
});

test("balance: provider-catalog 仅作无私有凭据时 fallback，失败保留 last-good 并标 stale", async () => {
  const home = tmpDir("catalog-home"); const dir = tmpDir("catalog-balance");
  fs.writeFileSync(path.join(home, "provider-catalog.json"), JSON.stringify({ providers: { deepseek: { key: "catalog-secret" } } }));
  const headers = []; let good = true;
  validateAndSave(dir, {});
  const service = new BalanceService({
    dataDir: dir,
    homeDir: home,
    fetchFn: async (_url, init) => {
      headers.push(init.headers);
      if (!good) throw new Error("fetch failed");
      return { ok: true, json: async () => ({ balance_infos: [{ total_balance: 9 }] }) };
    },
  });
  const first = await service.refresh(); assert.equal(first.sources.find((x) => x.id === "deepseek").balance, 9); assert.equal(headers[0].Authorization, "Bearer catalog-secret");
  good = false; const second = await service.refresh(); const source = second.sources.find((x) => x.id === "deepseek");
  assert.equal(source.balance, 9); assert.equal(source.stale, true); assert.equal(second.stale, true); assert.ok(!JSON.stringify(second).includes("catalog-secret"));
});

test("balance: null/undefined/空字符串/boolean 供应商字段均为 malformed_response", async () => {
  for (const value of [null, undefined, "", true, false]) {
    const dir = tmpDir("balance-invalid-number");
    validateAndSave(dir, { credentials: { deepseekApiKey: "key" } });
    const service = new BalanceService({ dataDir: dir, fetchFn: async () => ({ ok: true, json: async () => ({ balance_infos: [{ total_balance: value }] }) }) });
    const result = await service.refresh();
    assert.equal(result.sources.find((x) => x.id === "deepseek").status, "malformed_response", String(value));
  }
});

test("balance: 合法数字字符串仍可作为余额", async () => {
  const dir = tmpDir("balance-number-string");
  validateAndSave(dir, { credentials: { deepseekApiKey: "key" } });
  const service = new BalanceService({ dataDir: dir, fetchFn: async () => ({ ok: true, json: async () => ({ balance_infos: [{ total_balance: " 12.50 " }] }) }) });
  const result = await service.refresh();
  assert.equal(result.sources.find((x) => x.id === "deepseek").balance, 12.5);
});

test("balance: invalid JSON response 稳定归类 malformed_response", async () => {
  const dir = tmpDir("balance-invalid-json");
  validateAndSave(dir, { credentials: { deepseekApiKey: "key" } });
  const service = new BalanceService({ dataDir: dir, fetchFn: async () => ({ ok: true, json: async () => { throw new SyntaxError("Unexpected token"); } }) });
  const result = await service.refresh();
  assert.equal(result.sources.find((x) => x.id === "deepseek").status, "malformed_response");
});

test("balance: 禁用清除旧快照，重新启用后可刷新", async () => {
  const dir = tmpDir("balance-disabled");
  validateAndSave(dir, { credentials: { deepseekApiKey: "key" } });
  let value = "9";
  const service = new BalanceService({ dataDir: dir, fetchFn: async () => ({ ok: true, json: async () => ({ balance_infos: [{ total_balance: value }] }) }) });
  const first = await service.refresh();
  assert.equal(first.sources.find((x) => x.id === "deepseek").balance, 9);
  validateAndSave(dir, { balance: { enabled: false } });
  const disabled = await service.refresh();
  assert.equal(disabled.disabled, true); assert.deepEqual(disabled.sources, []);
  assert.equal(service.snapshot().disabled, true); assert.equal(service.snapshot().cached, false); assert.deepEqual(service.snapshot().sources, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "balance.json"), "utf8")).sources, []);
  validateAndSave(dir, { balance: { enabled: true } });
  value = "11";
  const reenabled = await service.refresh();
  assert.equal(reenabled.sources.find((x) => x.id === "deepseek").balance, 11);
  assert.equal(reenabled.disabled, undefined);
});
