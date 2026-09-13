// tools/observe.mjs — 观测期快照：每次运行追加一行 JSON 到 data/snapshots.jsonl
//   node tools/observe.mjs
// 数据源：<META_SKILLS_DIR | ~/.dsh/skills>（单级布局 + manifest.json）
// 设计原则：快照是"事实流水"——只记录当时磁盘上的真实状态，不做任何推算或回填。
//   缺失字段就让它缺（早期 schema 没有 successes 字段，见 docs/observation.md 第二节）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SKILLS_ROOT = process.env.META_SKILLS_DIR || path.join(os.homedir(), ".dsh", "skills");
const OUT_DIR = path.join(import.meta.dirname, "..", "data");
const SNAPSHOTS = path.join(OUT_DIR, "snapshots.jsonl");
const RUNS = path.join(OUT_DIR, "runs.log");

// 发布到公开仓时不留本机绝对路径：把 home 前缀替换成 ~
function display(p) {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length).replace(/\\/g, "/") : p.replace(/\\/g, "/");
}

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const fm = m ? m[1] : "";
  const g = (k) => {
    const r = fm.match(new RegExp(`^${k}:\\s*(.+)$`, "m"));
    return r ? r[1].trim() : null;
  };
  const num = (k) => {
    const v = g(k);
    return v === null ? null : parseInt(v, 10);
  };
  return {
    title: (g("description") || "").split("。")[0],
    related_tool: g("related_tool") || "",
    trials: num("trials"),
    successes: num("successes"),
    created_at: g("created_at") || "",
  };
}

const dirs = fs.existsSync(SKILLS_ROOT)
  ? fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(SKILLS_ROOT, d.name, "SKILL.md")))
  : [];

const skills = dirs.map((d) => {
  const md = fs.readFileSync(path.join(SKILLS_ROOT, d.name, "SKILL.md"), "utf-8");
  return { id: d.name, ...parseFrontmatter(md) };
});

// 聚合：只在字段确实存在时累加（缺失字段不补 0——缺就是缺）
const byTool = {};
for (const s of skills) byTool[s.related_tool || "?"] = (byTool[s.related_tool || "?"] || 0) + 1;
const totals = {};
for (const k of ["trials", "successes"]) {
  const vals = skills.map((s) => s[k]).filter((v) => typeof v === "number");
  if (vals.length) totals[k] = vals.reduce((a, b) => a + b, 0);
}

const snapshot = {
  ts: new Date().toISOString(),
  skills_root: display(SKILLS_ROOT),
  count: skills.length,
  totals,
  by_tool: byTool,
  rate: typeof totals.trials === "number" && typeof totals.successes === "number" && totals.trials
    ? +(totals.successes / totals.trials).toFixed(3)
    : null,
  skills: skills.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || "")),
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.appendFileSync(SNAPSHOTS, JSON.stringify(snapshot) + "\n", "utf-8");

// 运行审计：距上次快照 >26h 视为跳跑（计划任务未登录/关机），让它成为可查事实而不是空白
const prev = fs.existsSync(SNAPSHOTS)
  ? fs.readFileSync(SNAPSHOTS, "utf-8").trim().split("\n").filter(Boolean).slice(-2, -1)[0]
  : null;
let prevGapH = null;
if (prev) {
  try {
    prevGapH = +(Math.abs(Date.now() - new Date(JSON.parse(prev).ts).getTime()) / 3600000).toFixed(1);
  } catch {}
}
fs.appendFileSync(RUNS, JSON.stringify({ ts: snapshot.ts, ok: true, count: snapshot.count, prev_gap_h: prevGapH }) + "\n", "utf-8");
if (prevGapH !== null && prevGapH > 26) {
  console.log(`[gap] ⚠ 距上次快照 ${prevGapH}h（>26h，疑似跳跑：机器未登录/关机）——见 data/runs.log`);
}
console.log(JSON.stringify({ ts: snapshot.ts, count: snapshot.count, totals: snapshot.totals, by_tool: snapshot.by_tool }, null, 2));
