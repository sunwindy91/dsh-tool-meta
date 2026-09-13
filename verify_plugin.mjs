// dsh-tool-meta 验证（v5，随 Outfit 打标升级）：模块加载 + 观测闭环 + 阈值 + 单级布局 + 账本
// + 负向清单 + 溯源 + 归档/恢复 + 审计 ledger + manifest 同步 + updated_at
// + ledger_tag（Outfit 账本命名空间）+ board CAS
// 期望输出 META_VERIFY_OK
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// 用临时目录测试，不污染真实 ~/.dsh/skills
const TMP = path.join(os.tmpdir(), `dsh-meta-test-${Date.now()}`);
process.env.META_SKILLS_DIR = TMP;
process.env.META_LEDGER_TAG = "test-outfit"; // 验证 tag 打标机制

const mod = await import("./lib/index.js");
const { apply, __test } = mod;

const registered = [];
const ctx = {
  on(ev, fn) {
    events.push(ev);
  },
  get() {
    return { register: (t) => registered.push(t.name) };
  },
  inject(spec, fn) {
    fn({ register: (t) => registered.push(t.name) });
  },
};
const events = [];
apply(ctx);

console.log("observers:", __test.observers.length, "| tools:", registered.join(","));

const fire = async (name, args, isError, error) =>
  __test.observers[0](
    { name, arguments: args, agent: { name: "test-agent" } },
    { isError, error: error || undefined, value: isError ? undefined : { ok: true }, content: [] }
  );

const UNKNOWN_ERR = { message: "Unknown tool: nonexistent_tool", info: { name: "ToolNotFoundError", code: "UNKNOWN_TOOL" } };
const OUTPUT_ERR = { message: "output value violates declared schema: missing required 'data'", info: { name: "ToolOutputError", code: "TOOL_OUTPUT_ERROR" } };
const STALE_ERR = { message: "FS_STALE_VERSION: file changed since last read (shared.md)", info: { name: "FSError", code: "FS_STALE_VERSION" } };
const ENV_ERR = { message: "MISSING_CREDENTIAL: llm-deepseek: no API key for provider route", info: { name: "CredentialError", code: "MISSING_CREDENTIAL" } };

await fire("nonexistent_tool", {}, true, UNKNOWN_ERR);
const afterOne = fs.existsSync(path.join(TMP, "learn-unknown-tool-f42ab7d28ad1", "SKILL.md"));
console.log("阈值: 单次失败沉淀?", afterOne, "(应为 false)");
await fire("nonexistent_tool", {}, true, UNKNOWN_ERR);
await fire("nonexistent_tool", {}, true, UNKNOWN_ERR);
await fire("voice_tts", { text: "hi" }, true, OUTPUT_ERR);
await fire("voice_tts", { text: "hi" }, true, OUTPUT_ERR);
await fire("voice_tts", { text: "hi" }, false);
await fire("write_file", { path: "shared.md" }, true, STALE_ERR);
await fire("write_file", { path: "shared.md" }, true, STALE_ERR);
await fire("env_tool", {}, true, ENV_ERR);
await fire("env_tool", {}, true, ENV_ERR);

const { listSkills, searchSkills, archiveSkill, restoreSkill } = await import("./lib/skillwriter.js");

const learned = listSkills();
console.log("SKILL count:", learned.length, "(负向豁免后应仍为 3)");
const unknown = learned.find((s) => s.id.startsWith("learn-unknown-tool-"));
const output = learned.find((s) => s.id.startsWith("learn-output-schema-"));
const collab = learned.find((s) => s.id.startsWith("learn-collab-"));
const singleLevel = learned.every((s) => fs.existsSync(path.join(TMP, s.id, "SKILL.md")));
const noNamespace = !fs.existsSync(path.join(TMP, "dsh-tool-meta"));

const unknownMd = fs.readFileSync(path.join(TMP, unknown.id, "SKILL.md"), "utf-8");
const provenanceOk = /^created_by:\s*agent\s*$/m.test(unknownMd);
const updatedAtOk = /^updated_at:\s*\d{4}-\d{2}-\d{2}T/m.test(unknownMd);
const tagFrontOk = /^ledger_tag:\s*test-outfit\s*$/m.test(unknownMd);
console.log("溯源:", provenanceOk, "| updated_at:", updatedAtOk, "| ledger_tag(frontmatter):", tagFrontOk);

const auditFile = path.join(TMP, ".audit", "ledger.jsonl");
const auditRaw = fs.readFileSync(auditFile, "utf-8");
const auditLines = auditRaw.trim().split("\n").filter(Boolean);
const hasOp = (op) => auditLines.some((l) => { try { return JSON.parse(l).op === op; } catch { return false; } });
const tagAuditOk = auditLines.length > 0 && auditLines.every((l) => { try { return JSON.parse(l).ledger_tag === "test-outfit"; } catch { return false; } });
const tsValid = auditLines.every((l) => { try { return /^\d{4}-\d{2}-\d{2}T/.test(JSON.parse(l).ts); } catch { return false; } });
console.log("audit lines:", auditLines.length, "| ops:", [...new Set(auditLines.map((l) => { try { return JSON.parse(l).op; } catch { return "?"; } }))].join(","), "| ledger_tag 全带:", tagAuditOk);
const auditOk = auditLines.length >= 5 && hasOp("precipitate") && hasOp("recur") && hasOp("verify") && tsValid && tagAuditOk;

const manifest = JSON.parse(fs.readFileSync(path.join(TMP, "manifest.json"), "utf-8"));
const lastVerify = JSON.parse(auditLines.filter((l) => { try { return JSON.parse(l).op === "verify"; } catch { return false; } }).pop());
const manifestFresh = manifest.generated_at >= lastVerify.ts;
const manifestTagOk = manifest.ledger_tag === "test-outfit";
console.log("manifest fresh:", manifestFresh, "| manifest ledger_tag:", manifestTagOk);

const searchOk = searchSkills("voice_tts").some((h) => h.id && h.id.startsWith("learn-output-schema-"));
const { board } = await import("./lib/board.js");
const c1 = board.claim("shared.md", "agent-a");
const c2 = board.claim("shared.md", "agent-b");
const boardOk = c1.ok === true && c2.ok === false;

const a1 = archiveSkill(collab.id);
const lenArchived = listSkills().length;
const r1 = restoreSkill(collab.id);
const lenRestored = listSkills().length;
const auditAfter = fs.readFileSync(auditFile, "utf-8").trim().split("\n").filter(Boolean);
const hasOpAfter = (op) => auditAfter.some((l) => { try { return JSON.parse(l).op === op; } catch { return false; } });
const archiveOk = a1.ok && lenArchived === 2 && r1.ok && lenRestored === 3 && hasOpAfter("archive") && hasOpAfter("restore");
console.log("归档/恢复:", a1.ok, lenArchived, "→", r1.ok, lenRestored);

const ok =
  __test.observers.length === 1 &&
  registered.includes("meta_status") &&
  registered.includes("meta_search") &&
  registered.includes("meta_nourish") &&
  registered.includes("meta_claim") &&
  registered.includes("meta_board") &&
  afterOne === false &&
  learned.length === 3 &&
  unknown && unknown.trials === 1 &&
  output && output.trials === 0 && output.successes === 1 &&
  collab && collab.trials === 0 &&
  singleLevel && noNamespace &&
  provenanceOk && updatedAtOk && tagFrontOk &&
  auditOk && manifestFresh && manifestTagOk && searchOk && boardOk && archiveOk;
console.log(ok ? "META_VERIFY_OK" : "META_VERIFY_FAIL");
process.exit(ok ? 0 : 1);
