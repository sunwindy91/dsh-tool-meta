// tests/unit.mjs — 零依赖单测：只用 Node 内置模块，干净环境可直接跑
//   node tests/unit.mjs   （期望输出 UNIT_OK）
//
// 为什么单独有这份：verify_plugin.mjs 需要能解析 @deepseek-ai/dsh-tools（peer 依赖，随 DSH profile 提供），
// 干净克隆跑不了。而"治理约束"（负向清单 / 阈值去重 / 账本 / 审计 / 归档不删）必须人人可验证——
// 所以这里绕开 defineTool，只测纯逻辑模块：reflector.js（纯规则）+ skillwriter.js（只用 node:fs）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 必须在 import skillwriter 之前设置：该模块的 BASE 在加载时读取环境变量
const TMP = path.join(os.tmpdir(), `dsh-meta-unit-${Date.now()}`);
process.env.META_SKILLS_DIR = TMP;
process.env.META_LEDGER_TAG = "unit-test";

const { reflect } = await import("../lib/reflector.js");
const sw = await import("../lib/skillwriter.js");

let passed = 0;
const cases = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    cases.push(`  ✓ ${name}`);
  } catch (e) {
    cases.push(`  ✗ ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// ---------- 一、反思分类（变异算子） ----------
test("负向清单：缺凭据不沉淀", () => {
  assert.equal(reflect({ name: "x" }, { error: { message: "MISSING_CREDENTIAL: no API key configured" } }), null);
});
test("负向清单：沙箱策略拒绝不沉淀", () => {
  assert.equal(reflect({ name: "read" }, { error: { message: "sandbox policy denied file access" } }), null);
});
test("负向清单：命令不存在不沉淀", () => {
  assert.equal(reflect({ name: "bash" }, { error: { message: "command not found: rgx" } }), null);
});
test("UNKNOWN_TOOL → 生成未注册工具类教训", () => {
  const r = reflect({ name: "nonexistent_tool" }, { error: { info: { code: "UNKNOWN_TOOL" }, message: "unknown tool" } });
  assert.ok(r, "应生成教训");
  assert.match(r.id, /^learn-unknown-tool-/, `id 形如 learn-unknown-tool-<hash>，实际 ${r.id}`);
  assert.ok(r.title && r.triggers && r.body, "教训需含 title/triggers/body");
});
test("TOOL_OUTPUT_ERROR → 生成 output.schema 类教训", () => {
  const r = reflect({ name: "edit" }, { error: { info: { code: "TOOL_OUTPUT_ERROR" }, message: "output schema mismatch" } });
  assert.ok(r);
  assert.match(r.id, /^learn-output-schema-/, `实际 ${r.id}`);
});
test("协作冲突 → 生成 collab 类教训", () => {
  const r = reflect({ name: "meta_claim" }, { error: { info: { code: "FS_STALE_VERSION" }, message: "stale version conflict" } });
  assert.ok(r);
  assert.match(r.id, /^learn-collab/, `实际 ${r.id}`);
});
test("通用失败 → 仍生成教训（兜底分支）", () => {
  const r = reflect({ name: "write" }, { error: { message: "boom unexpected failure" } });
  assert.ok(r, "通用失败也应沉淀（否则闭环有洞）");
  assert.match(r.id, /^learn-/);
});
test("错误文本被截断到 160 字符（不保存全文）", () => {
  const long = "E".repeat(500);
  const r = reflect({ name: "write" }, { error: { message: long } });
  const blob = JSON.stringify(r);
  assert.ok(blob.length < 1200, `教训体积应受限，实际 ${blob.length}`);
  assert.ok(!blob.includes("E".repeat(200)), "不应包含超长原文");
});

// ---------- 二、沉淀与账本（选择算子） ----------
test("沉淀：单级布局 <root>/<id>/SKILL.md", () => {
  const res = sw.writeSkill({ id: "learn-test-one", title: "测试教训一", triggers: ["t1", "t2"], tool: "edit", body: "正文" });
  assert.equal(res.written, true);
  assert.equal(res.file, path.join(TMP, "learn-test-one", "SKILL.md"));
  const md = fs.readFileSync(res.file, "utf-8");
  assert.match(md, /created_by: agent/);
  assert.match(md, /ledger_tag: unit-test/);
  assert.match(md, /trials: 0/);
  assert.match(md, /updated_at: \d{4}-\d{2}-\d{2}T/);
});
test("去重：同 id 再写 = 复发 trials+1，不新建文件", () => {
  const res = sw.writeSkill({ id: "learn-test-one", title: "测试教训一", triggers: ["t1"], tool: "edit", body: "正文" });
  assert.equal(res.written, false);
  const meta = sw.listSkills().find((s) => s.id === "learn-test-one");
  assert.equal(meta.trials, 1, `复发应 trials=1，实际 ${meta.trials}`);
});
test("验证账本：successes 累加", () => {
  sw.updateSkill("learn-test-one", { successes: +1 });
  sw.updateSkill("learn-test-one", { successes: +1 });
  const meta = sw.listSkills().find((s) => s.id === "learn-test-one");
  assert.equal(meta.successes, 2);
});
test("计数与列举", () => {
  assert.equal(sw.countSkills(), 1);
  assert.equal(sw.listSkills().length, 1);
});
test("检索：按关键词能找到教训", () => {
  const hits = sw.searchSkills("测试教训");
  assert.ok(hits.length >= 1, "应能检索到");
  assert.equal(hits[0].id, "learn-test-one");
});
test("manifest 随账本刷新且是单级索引", () => {
  const mf = path.join(TMP, "manifest.json");
  assert.ok(fs.existsSync(mf), "manifest.json 应存在");
  const m = JSON.parse(fs.readFileSync(mf, "utf-8"));
  assert.ok(JSON.stringify(m).includes("learn-test-one"));
});

// ---------- 三、审计与归档（治理约束） ----------
test("审计流水：precipitate / recur 都留痕", () => {
  const ledger = path.join(TMP, ".audit", "ledger.jsonl");
  assert.ok(fs.existsSync(ledger), "ledger.jsonl 应存在");
  const ops = fs.readFileSync(ledger, "utf-8").trim().split("\n").map((l) => JSON.parse(l).op);
  assert.ok(ops.includes("precipitate"), `应有 precipitate，实际 ${ops}`);
  assert.ok(ops.includes("recur"), `应有 recur，实际 ${ops}`);
  const first = JSON.parse(fs.readFileSync(ledger, "utf-8").trim().split("\n")[0]);
  assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T.*Z$/, "UTC ISO 时间戳");
  assert.equal(first.ledger_tag, "unit-test", "账本带命名空间 tag");
});
test("归档而非删除：移到 .archive/ 且活动库归零", () => {
  const res = sw.archiveSkill("learn-test-one");
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(path.join(TMP, ".archive", "learn-test-one", "SKILL.md")), "归档文件应保留");
  assert.equal(sw.countSkills(), 0, "活动库不应再计入");
});
test("已归档再归档 → 明确失败（不静默）", () => {
  const res = sw.archiveSkill("learn-test-one");
  assert.equal(res.ok, false);
  assert.ok(res.error, "应给出原因");
});
test("恢复：从归档回到活动库", () => {
  const res = sw.restoreSkill("learn-test-one");
  assert.equal(res.ok, true);
  assert.equal(sw.countSkills(), 1);
});
test("pinned 技能拒绝归档", () => {
  const dir = path.join(TMP, "learn-pinned-x");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: learn-pinned-x\npinned: true\ntrials: 0\nsuccesses: 0\n---\n\n# 钉住的\n", "utf-8");
  const res = sw.archiveSkill("learn-pinned-x");
  assert.equal(res.ok, false);
  assert.match(res.error, /pinned/);
});
test("归档/恢复也进审计流水", () => {
  const ops = fs.readFileSync(path.join(TMP, ".audit", "ledger.jsonl"), "utf-8")
    .trim().split("\n").map((l) => JSON.parse(l).op);
  assert.ok(ops.includes("archive") && ops.includes("restore"), `实际 ${[...new Set(ops)]}`);
});

console.log(cases.join("\n"));
console.log(`\n${passed}/${cases.length} 通过`);
if (process.exitCode) {
  console.log("UNIT_FAIL");
} else {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("UNIT_OK");
}
