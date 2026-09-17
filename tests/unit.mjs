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

const { reflect, errorClass } = await import("../lib/reflector.js");
const sw = await import("../lib/skillwriter.js");
const gateMod = await import("../lib/gate.js");
const selMod = await import("../lib/selector.js");

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


// ---------- 四、高危动作闸门（v6：不可逆操作的前置硬闸门） ----------
test("闸门：普通读取不干预", () => {
  const g = gateMod.createGate();
  assert.equal(g.evaluate({ name: "read", arguments: { path: "a.txt" } }), undefined);
});
test("闸门：识别显式删除", () => {
  const d = gateMod.detectDanger({ name: "shell", arguments: { command: "rm /tmp/a.txt" } });
  assert.ok(d && d.kind === "explicit" && d.targets.some((t) => t.includes("/tmp/a.txt")), JSON.stringify(d));
});
test("闸门：识别代码型删除（抽不出目标清单）", () => {
  const d = gateMod.detectDanger({ name: "run_code", arguments: { code: "import os\nfor f in fs: os.remove(f)" } });
  assert.ok(d && d.kind === "code", JSON.stringify(d));
});
test("闸门：通配符删除一律拒绝（任何声明都放行不了）", () => {
  const g = gateMod.createGate();
  g.prepare({ action: "delete", targets: ["/tmp/work/*"], backup_source: "/tmp/bak", backup_hash: "x" });
  const reason = g.evaluate({ name: "shell", arguments: { command: "rm -rf /tmp/work/*" } });
  assert.ok(typeof reason === "string" && reason.includes("通配符"), String(reason));
});
test("闸门：显式删除但未声明 → 拒绝并指路 meta_prepare", () => {
  const g = gateMod.createGate();
  const reason = g.evaluate({ name: "shell", arguments: { command: "rm /tmp/b/a.txt" } });
  assert.ok(typeof reason === "string" && reason.includes("meta_prepare"), String(reason));
});
test("闸门：声明覆盖后放行", () => {
  const g = gateMod.createGate();
  g.prepare({ action: "delete", targets: ["/tmp/b/a.txt"], backup_source: "/tmp/bak", backup_hash: "abc123" });
  assert.equal(g.evaluate({ name: "shell", arguments: { command: "rm /tmp/b/a.txt" } }), undefined);
});
test("闸门：声明不覆盖目标 → 仍拒绝", () => {
  const g = gateMod.createGate();
  g.prepare({ action: "delete", targets: ["/tmp/b/other.txt"], backup_source: "/tmp/bak", backup_hash: "abc" });
  assert.ok(typeof g.evaluate({ name: "shell", arguments: { command: "rm /tmp/b/a.txt" } }) === "string");
});
test("闸门：声明过期 → 拒绝", () => {
  const g = gateMod.createGate({ ttlMs: -1 });
  g.prepare({ action: "delete", targets: ["/tmp/b/a.txt"], backup_source: "/tmp/bak", backup_hash: "abc" });
  assert.ok(typeof g.evaluate({ name: "shell", arguments: { command: "rm /tmp/b/a.txt" } }) === "string");
});
test("闸门：受保护路径 → 拒绝（声明也不能放行）", () => {
  const g = gateMod.createGate();
  g.prepare({ action: "delete", targets: [".dsh/skills/learn-x"], backup_source: "/tmp/bak", backup_hash: "abc" });
  const reason = g.evaluate({ name: "shell", arguments: { command: "rm -rf .dsh/skills/learn-x" } });
  assert.ok(typeof reason === "string" && reason.includes("受保护"), String(reason));
});
test("闸门：代码型删除必须声明 scope + 条数 + 哈希", () => {
  const g = gateMod.createGate();
  const code = { name: "run_code", arguments: { code: "os.remove(f) for f in files  # /tmp/work" } };
  assert.ok(typeof g.evaluate(code) === "string", "未声明应拒绝");
  g.prepare({ action: "delete", scope: "/tmp/work", expected_count: 23, backup_source: "/tmp/bak", backup_hash: "abc" });
  assert.equal(g.evaluate(code), undefined, "三项齐备应放行");
});
test("闸门：META_GATE=off 可整体关闭（治理开关）", () => {
  const g = gateMod.createGate({ enabled: false });
  assert.equal(g.evaluate({ name: "shell", arguments: { command: "rm -rf /tmp/x/*" } }), undefined);
});

// ---------- 五、误报回归（v0.4.1：闸门必须做工具作用域限定） ----------
test("闸门：内容型工具 write 不被拦（文档里讨论删除 API 是合法的）", () => {
  const g = gateMod.createGate();
  const r = g.evaluate({
    name: "write",
    arguments: { file_path: "/tmp/notes.md", content: "如何安全删除：os.remove(f) 与 rm -rf dir/* 都要小心" },
  });
  assert.equal(r, undefined, "内容型工具被误拦：" + String(r));
});
test("闸门：内容型工具 edit 不被拦", () => {
  const g = gateMod.createGate();
  const r = g.evaluate({
    name: "edit",
    arguments: { file_path: "/tmp/doc.md", old_string: "x", new_string: "shutil.rmtree(dir)" },
  });
  assert.equal(r, undefined, String(r));
});
test("闸门：动作型工具仍然被拦（放宽作用域不能把闸门放空）", () => {
  const g = gateMod.createGate();
  assert.ok(typeof g.evaluate({ name: "shell", arguments: { command: "rm -rf /tmp/x/*" } }) === "string");
  assert.ok(typeof g.evaluate({ name: "run_code", arguments: { code: "os.remove(f)" } }) === "string");
});
test("闸门：可用 META_GATE_SKIP_TOOLS 追加自定义内容型工具", () => {
  const g = gateMod.createGate({ skipTools: ["my_notes_tool"] });
  assert.equal(g.evaluate({ name: "my_notes_tool", arguments: { body: "rm -rf /x/*" } }), undefined);
  assert.ok(typeof g.evaluate({ name: "shell", arguments: { command: "rm -rf /x/*" } }) === "string");
});


// ---------- 六、去碎片化（v0.4.2） ----------
test("错误类：路径/数字/引号不同视为同一类", () => {
  const a = errorClass("FS_STALE_VERSION: file changed since last read (shared.md)", "FSError");
  const b = errorClass("FS_STALE_VERSION: file changed since last read (other-1234.md)", "FSError");
  assert.equal(a, b, `${a} != ${b}`);
});
test("错误类：不同失败仍是不同类", () => {
  assert.notEqual(errorClass("tool not found", ""), errorClass("output violates schema", ""));
});
test("去碎片化：同工具同错误类的多条教训合并为一条且账本累加", () => {
  const mk = (id, msg) => ({
    id, tool: "edit", title: "调用「edit」失败", triggers: ["edit", "失败"],
    body: `- 调用 \`edit\` 曾失败：${msg}`,
  });
  sw.writeSkill(mk("learn-aaaaaaaaaaaa-111111111111", "EIO: ReplaceFileW failed on /a/one.md"));
  sw.writeSkill(mk("learn-aaaaaaaaaaaa-222222222222", "EIO: ReplaceFileW failed on /b/two.md"));
  sw.updateSkill("learn-aaaaaaaaaaaa-111111111111", { trials: 3 });
  const before = sw.countSkills();
  const rep = sw.compactSkills();
  assert.ok(rep.groups_merged >= 1, JSON.stringify(rep));
  assert.equal(sw.countSkills(), before - rep.archived, "活动条目数应等于 原数-归档数");
  const canon = sw.listSkills().find((x) => x.id === "learn-aaaaaaaaaaaa-111111111111");
  assert.ok(canon && canon.trials >= 3, "canonical 账本未累加");
  const md = fs.readFileSync(path.join(TMP, "learn-aaaaaaaaaaaa-111111111111", "SKILL.md"), "utf-8");
  assert.ok(/merged_from:/.test(md), "未记录 merged_from 来源");
  assert.ok(/^trials:\s*4\s*$/m.test(md) || /^trials:\s*[3-9]\d*\s*$/m.test(md), "trials 未累加: " + md.slice(0, 200));
});
test("去碎片化：dry_run 不改动文件", () => {
  const before = sw.countSkills();
  const rep = sw.compactSkills({ dryRun: true });
  assert.equal(sw.countSkills(), before);
  assert.ok(Array.isArray(rep.merged));
});
test("去碎片化：被合并条目进归档可恢复（不是删除）", () => {
  assert.ok(fs.existsSync(path.join(TMP, ".archive", "learn-aaaaaaaaaaaa-222222222222", "SKILL.md")), "应进 .archive");
  const r = sw.restoreSkill("learn-aaaaaaaaaaaa-222222222222");
  assert.equal(r.ok, true);
  sw.archiveSkill("learn-aaaaaaaaaaaa-222222222222"); // 收尾归位
});
test("去碎片化：审计流水留下 compact 事件", () => {
  const raw = fs.readFileSync(path.join(TMP, ".audit", "ledger.jsonl"), "utf-8");
  assert.ok(raw.split("\n").some((l) => l.includes('"op":"compact"')), "缺少 compact 审计事件");
});


test("去碎片化：专类教训（collab）不参与自动合并", () => {
  sw.writeSkill({
    id: "learn-collab-aaaaaaaaaaaa-bbbbbbbbbbbb", tool: "edit",
    title: "协作冲突：并发/版本冲突（学怎么协作）", triggers: ["edit", "协作"],
    body: "- 并行写文件前先 read 最新版本。\n- 失败信息：EIO: failed on /x/one.md",
  });
  sw.writeSkill({
    id: "learn-cccccccccccc-dddddddddddd", tool: "edit",
    title: "调用「edit」失败", triggers: ["edit", "失败"],
    body: "- 调用 \`edit\` 曾失败：EIO: failed on /y/two.md",
  });
  const rep = sw.compactSkills();
  const collabAlive = sw.listSkills().some((x) => x.id.startsWith("learn-collab-"));
  assert.ok(collabAlive, "专类教训不应被合并/归档");
  assert.ok(rep.merged.every((m) => !m.merged_from.some((i) => i.startsWith("learn-collab-"))), "合并来源里不应出现专类教训");
});

// ---------- 七、v0.4.4 缺陷回归（先红后绿） ----------
// 缺陷 1（旧）：成功加分是"该工具的第一条教训"（readdir 顺序）= 随机 → 账本不可复现。
// 修复：抽成纯函数 pickRepresentative（successes 高 → trials 高 → 创建早），并单测它。
test("缺陷1：代表教训选取是确定性的（账本厚者优先，并列取创建早）", () => {
  const a = { id: "a", successes: 1, trials: 0, created_at: "2026-01-01" };
  const b = { id: "b", successes: 5, trials: 0, created_at: "2026-02-01" };
  const c = { id: "c", successes: 5, trials: 2, created_at: "2026-03-01" };
  assert.equal(selMod.pickRepresentative([a, b, c]).id, "c", "successes 同为 5 时取 trials 高者");
  assert.equal(selMod.pickRepresentative([a, b]).id, "b");
  // 并列完全相同时取创建更早的
  const d = { id: "d", successes: 2, trials: 1, created_at: "2026-05-01" };
  const e = { id: "e", successes: 2, trials: 1, created_at: "2026-04-01" };
  assert.equal(selMod.pickRepresentative([d, e]).id, "e", "并列取创建早者");
  // 顺序无关（确定性）
  assert.equal(selMod.pickRepresentative([b, a, c]).id, "c");
  assert.equal(selMod.pickRepresentative([]), null);
});

// 缺陷 2（旧）：meta_prepare 的声明在有效期内可无限次放行，与"放行一次"的承诺不符。
test("缺陷2：声明放行一次后即失效（第二次同类调用必须被拒）", () => {
  const g = gateMod.createGate({ audit: sw.audit }); // 用真实审计，验证 gate:consume 落账
  const call = { name: "shell", arguments: { command: "rm -rf /tmp/one/a.txt" } };
  assert.ok(typeof g.evaluate(call) === "string", "未声明应拒绝");
  const c = g.prepare({ action: "delete", targets: ["/tmp/one/a.txt"], backup_source: "/tmp/bak", backup_hash: "h1" });
  assert.equal(g.evaluate(call), undefined, "声明后第一次应放行");
  const second = g.evaluate(call);
  assert.ok(typeof second === "string", "第二次必须被拒（声明一次性）");
  assert.ok(!g.list().some((x) => x.id === c.id), "已消费的声明不应再出现在活动声明里");
});

test("缺陷2b：审计流水记录声明的消费（gate:consume）", () => {
  const raw = fs.readFileSync(path.join(TMP, ".audit", "ledger.jsonl"), "utf-8");
  assert.ok(raw.split("\n").some((l) => l.includes('"op":"gate:consume"')), "缺少 gate:consume 事件");
});

console.log(cases.join("\n"));
console.log(`\n${passed}/${cases.length} 通过`);
if (process.exitCode) {
  console.log("UNIT_FAIL");
} else {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("UNIT_OK");
}
