// test/helpers.test.js — 临时目录统一管理：落 _tmp/、可清理、守卫不抛错
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { tmpDir, cleanupTmpDirs, guardTmpRoot } from "./helpers.js";

after(cleanupTmpDirs);

test("helpers.tmpDir: 落在项目 _tmp/ 下，cleanupTmpDirs 可清理", () => {
  const dir = tmpDir("helpers-check");
  assert.ok(dir.startsWith(path.join(process.cwd(), "_tmp") + path.sep), "临时目录应落在项目 _tmp/ 下");
  assert.ok(fs.existsSync(dir));
  cleanupTmpDirs();
  assert.equal(fs.existsSync(dir), false, "cleanupTmpDirs 应删除临时目录");
});

test("helpers.guardTmpRoot: 不抛错（仅阈值告警）", () => {
  assert.doesNotThrow(() => guardTmpRoot());
});
