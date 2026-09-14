// 在真实能力盘上执行一次去碎片化（只调用模块，不做删除；合并的条目进 .archive 可恢复）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const DIR = path.join(os.homedir(), ".dsh", "skills");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const BAK = path.join(os.homedir(), ".dsh", `skills.bak-${STAMP}`);

// 备份（复制，不移动）
execSync(`powershell -NoProfile -Command "Copy-Item -Recurse -LiteralPath '${DIR}' -Destination '${BAK}'"`, { stdio: "ignore" });
const countOf = (d, pred = () => true) =>
  fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(d, e.name, "SKILL.md")) && pred(e.name)).length;

const before = countOf(DIR);
const bakCount = countOf(BAK);
console.log(`备份: ${BAK}`);
console.log(`备份条目数: ${bakCount}（应等于整理前 ${before}）`);

// 整理
const sw = await import(new URL("../lib/skillwriter.js", import.meta.url));
const rep = sw.compactSkills();
const after = countOf(DIR);
const learnBefore = countOf(DIR, (n) => n.startsWith("learn-"));
console.log(`\n整理结果：活动条目 ${before} → ${after}（合并组 ${rep.groups_merged}，归档 ${rep.archived}）`);
for (const m of rep.merged) {
  console.log(`  • ${m.tool}: ${m.merged_from.length} 条并入 ${m.canonical}（账本合计 trials=${m.trials}, successes=${m.successes}）`);
  console.log(`      被并入: ${m.merged_from.join(", ")}`);
}
const archDir = path.join(DIR, ".archive");
const archived = fs.existsSync(archDir) ? fs.readdirSync(archDir).filter((n) => fs.existsSync(path.join(archDir, n, "SKILL.md"))).length : 0;
console.log(`\n.archive 中可恢复条目: ${archived}（归档而非删除 ✓）`);
console.log(`整理后 learn-* 条目: ${countOf(DIR, (n) => n.startsWith("learn-"))}（整理前 ${learnBefore}）`);
