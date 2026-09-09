import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpDir } from "./helpers.js";
import { validateAndSave } from "../lib/settings.js";
import { BalanceService } from "../lib/balance.js";
import registerApiRoutes from "../routes/api.js";

function appMock() { const handlers = {}; return { handlers, app: { get: (p, h) => handlers[`GET ${p}`] = h, post: (p, h) => handlers[`POST ${p}`] = h } }; }
function ctxMock(dir) { return { _usageHub: { paths: { dataDir: dir }, balance: { snapshot: () => ({ sources: [{ id: "deepseek", status: "unavailable" }], lastAttemptAt: new Date().toISOString() }), refresh: async () => ({ sources: [] }) } } }; }
function cMock(body) { return { req: { json: async () => body }, json: (obj, code = 200) => ({ obj, code }) }; }

test("api phase3: settings 与 balance 路由存在且不泄露凭据", async () => {
  const dir = tmpDir("api-phase3"); const { handlers, app } = appMock(); const ctx = ctxMock(dir); registerApiRoutes(app, ctx);
  assert.ok(handlers["GET /settings"]); assert.ok(handlers["POST /settings"]); assert.ok(handlers["GET /balance"]); assert.ok(handlers["POST /balance/refresh"]);
  const saved = await handlers["POST /settings"](cMock({ credentials: { deepseekApiKey: "secret-key" } }));
  assert.equal(saved.code, 200); assert.ok(!JSON.stringify(saved.obj).includes("secret-key"));
  const got = handlers["GET /settings"](cMock()); assert.equal(got.obj.credentials.deepseekApiKey.configured, true);
  assert.equal((await handlers["GET /balance"](cMock())).obj.sources[0].status, "unavailable");
  assert.deepEqual((await handlers["POST /balance/refresh"](cMock())).obj.sources, []);
  assert.ok(fs.existsSync(`${dir}/settings/credentials.json`));
});

test("api phase3: settings 仅在余额/凭据变化时刷新一次并返回快照", async () => {
  const dir = tmpDir("api-settings-refresh-once"); let refreshCalls = 0;
  const balance = { snapshot: () => ({ sources: [] }), refresh: async () => { refreshCalls += 1; return { sources: [{ id: "deepseek", status: "ok", balance: 1 }] }; } };
  const { handlers, app } = appMock(); registerApiRoutes(app, { _usageHub: { paths: { dataDir: dir }, balance } });
  const displayOnly = await handlers["POST /settings"](cMock({ display: { hiddenAgents: ["a"] } }));
  assert.equal(refreshCalls, 0); assert.equal(displayOnly.obj.balanceRefreshed, false);
  const balanceChange = await handlers["POST /settings"](cMock({ balance: { enabled: false } }));
  assert.equal(refreshCalls, 1); assert.equal(balanceChange.obj.balanceRefreshed, true); assert.equal(balanceChange.obj.balance.sources[0].balance, 1);
});

test("api phase3: malformed settings payload 返回 400", async () => {
  const { handlers, app } = appMock(); registerApiRoutes(app, ctxMock(tmpDir("api-malformed")));
  assert.equal((await handlers["POST /settings"](cMock({ unknown: true }))).code, 400);
  assert.equal((await handlers["POST /settings"](cMock(null))).code, 400);
});

test("api phase3: 关闭余额后 settings 与 GET balance 不暴露旧成功快照", async () => {
  const dir = tmpDir("api-balance-disabled");
  validateAndSave(dir, { credentials: { deepseekApiKey: "key" } });
  const balance = new BalanceService({ dataDir: dir, fetchFn: async () => ({ ok: true, json: async () => ({ balance_infos: [{ total_balance: "7" }] }) }) });
  const ctx = { _usageHub: { paths: { dataDir: dir }, balance } };
  const { handlers, app } = appMock(); registerApiRoutes(app, ctx);
  await balance.refresh();
  const saved = await handlers["POST /settings"](cMock({ balance: { enabled: false } }));
  assert.equal(saved.obj.settings.balance.enabled, false);
  const got = (await handlers["GET /balance"](cMock())).obj;
  assert.equal(got.disabled, true); assert.deepEqual(got.sources, []); assert.equal(got.sources.some((x) => x.balance === 7), false);
  await handlers["POST /settings"](cMock({ balance: { enabled: true } }));
  assert.equal((await handlers["GET /balance"](cMock())).obj.sources.find((x) => x.id === "deepseek").balance, 7);
});
