import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { listSessions, readSessionDetail, parseContent, deriveSessionsDirInfo, MAX_SESSION_FILE_BYTES } from "../lib/session-reader.js";
import { tmpDir } from "./helpers.js";

function writeSession(dir, file, id, extra = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), [
    { type: "session", id, timestamp: "2026-09-09T01:00:00.000Z", ...extra.session },
    { type: "message", message: { role: "user", content: "标题" } },
    { type: "message", timestamp: "2026-09-09T01:01:00.000Z", message: { role: "assistant", usage: extra.usage || { input: { totalTokens: 100 }, output: { totalTokens: 20 }, cacheRead: 50 } } },
  ].map(JSON.stringify).join("\n"));
}

test("session reader: agents/<agent>/sessions fallback and duplicate ids bind agent + file", () => {
  const root = tmpDir("reader-agents");
  const a = path.join(root, "agents", "alpha", "sessions");
  const b = path.join(root, "agents", "beta", "sessions");
  writeSession(a, "same-a.jsonl", "same"); writeSession(b, "same-b.jsonl", "same");
  const list = listSessions({ sessionsDirs: [a, b], limit: 0 });
  assert.equal(list.length, 1); // limit=0 is normalized, not an accidental empty result
  const all = listSessions({ sessionsDirs: [a, b], limit: 99 });
  assert.deepEqual(all.map((x) => x.agent).sort(), ["alpha", "beta"]);
  assert.equal(readSessionDetail({ sessionsDirs: [a, b], sessionId: "same", agent: "beta", file: "same-b.jsonl" }).agent, "beta");
  assert.equal(readSessionDetail({ sessionsDirs: [a, b], sessionId: "same", agent: "alpha", file: "same-a.jsonl" }).file, "same-a.jsonl");
  const ambiguous = readSessionDetail({ sessionsDirs: [a, b], sessionId: "same" });
  assert.equal(ambiguous.error, "ambiguous_session_id"); assert.equal(ambiguous.matches.length, 2);
});

test("session reader: rejects JSONL, sidecar, and directory symlinks", () => {
  const root = tmpDir("reader-links"), real = path.join(root, "real"), outside = path.join(root, "outside");
  fs.mkdirSync(real); fs.mkdirSync(outside); writeSession(real, "good.jsonl", "good");
  fs.writeFileSync(path.join(real, "session-titles.json"), JSON.stringify({ good: "safe" }));
  fs.symlinkSync(path.join(outside, "missing.jsonl"), path.join(real, "link.jsonl"));
  fs.writeFileSync(path.join(outside, "outside.jsonl"), fs.readFileSync(path.join(real, "good.jsonl")));
  fs.unlinkSync(path.join(real, "session-titles.json"));
  fs.symlinkSync(path.join(outside, "outside.jsonl"), path.join(real, "session-titles.json"));
  const warnings = []; assert.equal(listSessions({ sessionsDir: real, warn: (x) => warnings.push(x) }).length, 1); assert.ok(warnings.some((x) => x.includes("符号链接"))); assert.ok(warnings.every((x) => !x.includes(root)));
  const linkedDir = path.join(root, "linked-dir"); fs.symlinkSync(real, linkedDir);
  assert.equal(listSessions({ sessionsDir: linkedDir }).length, 0);
});

test("session reader: no context window is null and native hitRatio wins", () => {
  const parsed = parseContent([
    { type: "session", id: "no-window" },
    { type: "message", message: { role: "assistant", usage: { input: { totalTokens: 100 }, output: { totalTokens: 20 }, cacheRead: 50, hitRatio: 0.9, contextWindow: 999999 } } },
  ].map(JSON.stringify).join("\n"));
  assert.equal(parsed.contextWindow, 999999);
  assert.equal(parsed.hitRatio, 0.9); assert.equal(parsed.hitRatioSource, "jsonl-native");
  const noContext = parseContent(JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: { totalTokens: 100 }, output: { totalTokens: 20 }, cacheRead: 50 } } }));
  assert.equal(noContext.contextWindow, null); assert.equal(noContext.contextPercent, null); assert.equal(noContext.hitRatioSource, "jsonl-local");
});

test("session reader: derive fallback exposes default agent source", () => {
  const info = deriveSessionsDirInfo({ config: { get: () => "" } });
  assert.equal(info.source, "default-agent-directory"); assert.equal(info.warning, "default_agent_directory"); assert.match(info.path, /agents[\\/]hanako[\\/]sessions$/);
});

test("session reader: oversized files are skipped and event limit is observable", () => {
  const root = tmpDir("reader-limits"), oversized = path.join(root, "oversized.jsonl");
  fs.writeFileSync(oversized, "x".repeat(MAX_SESSION_FILE_BYTES + 1));
  const warnings = []; assert.equal(listSessions({ sessionsDir: root, warn: (x) => warnings.push(x) }).length, 0); assert.ok(warnings.some((x) => x.includes("超限")));
  const many = Array.from({ length: 10005 }, (_, i) => JSON.stringify({ type: "event", i })).join("\n");
  assert.equal(parseContent(many).parseWarnings.eventLimit, true);
});

test("panel: 首次无余额快照只主动刷新一次，保存凭据/开关按需刷新", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "assets", "panel.js"), "utf8");
  assert.match(source, /balanceInitialRefreshAttempted/);
  assert.match(source, /state\.balanceInitialRefreshAttempted = true/);
  assert.match(source, /fetchJson\("\/api\/balance\/refresh", \{ method: "POST" \}\)/);
});

test("panel: 设置保存消费后端刷新结果且不重复 POST balance refresh", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "assets", "panel.js"), "utf8");
  assert.match(source, /postJson\("\/api\/settings"/);
  assert.match(source, /state\.balance = saved\.balance \|\| await getBalance\(\)/);
  assert.doesNotMatch(source, /state\.settings = saved\.settings; state\.balance = await fetchJson\("\/api\/balance\/refresh"/);
});

test("panel: hero 移除 P50/P95 与平均每轮耗时", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "assets", "panel.js"), "utf8");
  assert.doesNotMatch(source, /P50|P95/);
  assert.doesNotMatch(source, /平均每轮耗时/);
});

test("panel: single-day chart and composition granularity follow the selected range", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "assets", "panel.js"), "utf8");
  assert.match(source, /dailyTokensCard\.style\.display = singleDay \? "none"/);
  assert.match(source, /hourlyCard\.style\.display = singleDay \? ""/);
  assert.match(source, /sourceBar\(typeRows, typeTotal\)/);
  assert.match(source, /Object\.entries\(hourly \|\| \{\}\)/);
  assert.match(source, /state\.hourly = flattenHourlySeries/);
  assert.match(source, /const hourly = dailyRows\.length < 3 \? await getHourly\("", q\)/);
  assert.match(source, /小时消耗趋势/);
  assert.match(source, /stackedComboChart\(hourRows, hourHits/);
  assert.match(source, /stackedComboChart\(rowsOf\(days\), dayHits/);
  assert.doesNotMatch(source, /data-chart="dailyHit"/, "每日命中率趋势卡已并入每日消耗趋势");
});

test("panel: 命中率缺失保持 null，不做算术平均", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "assets", "panel.js"), "utf8");
  assert.match(source, /d\.hitRatio == null \? null/);
  assert.match(source, /h\.hitRatio == null \? null/);
  assert.match(source, /values\.filter\(\(v\) => v != null && Number\.isFinite\(v\)\)/);
  const page = source.slice(source.indexOf("/* ── page ── */"));
  assert.doesNotMatch(page, /sessionDetail|session-group|session-option|getSessionDetail\(|getSessions\(/);
});
