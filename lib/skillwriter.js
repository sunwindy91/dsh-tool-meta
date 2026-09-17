// 沉淀：把方法论写成本地 SKILL（~/.dsh/skills，DSH skill-filesystem 自动发现 → 自动滋养后续 agent）。
// 目录：<META_SKILLS_DIR|~/.dsh/skills>/<skill_id>/SKILL.md —— 单级布局，
// 对齐 DSH skill-filesystem 的 discoverRoot 单级扫描规则（<root>/<dir>/SKILL.md），滋养链路才能接通。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { errorClass } from "./reflector.js"; // 单一实现，避免两处规则漂移

const BASE = process.env.META_SKILLS_DIR || path.join(os.homedir(), ".dsh", "skills");
const LEDGER_TAG = process.env.META_LEDGER_TAG || "default"; // Outfit 账本命名空间（每套模式一个 tag，先打标不做仪表盘）

export function skillsDir() {
  return BASE;
}

/** 审计 ledger（插件自备能力）：append-only，记录每次 沉淀/复发/验证/归档/恢复 事件（UTC ISO 时间戳），
 *  文件 <root>/.audit/ledger.jsonl —— "哪条教训在几点几分被怎么改的"可逐事件追问。 */
export function audit(op, data = {}) {
  try {
    const root = skillsDir();
    const dir = path.join(root, ".audit");
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), op, ledger_tag: LEDGER_TAG, ...data });
    fs.appendFileSync(path.join(dir, "ledger.jsonl"), line + "\n", "utf-8");
  } catch {}
}

export function writeSkill(skill) {
  const root = skillsDir();
  const dir = path.join(root, skill.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  if (fs.existsSync(file)) {
    // 去重：同一教训再次发生 = trial+1（选择算子的"又遇到一次"）
    updateSkill(skill.id, { trials: +1 });
    audit("recur", { skill_id: skill.id, tool: skill.tool });
    return { written: false, file, exists: true };
  }
  const now = new Date().toISOString().slice(0, 10);
  const iso = new Date().toISOString();
  const md = `---
name: ${skill.id}
description: "${skill.title}。Triggers: ${skill.triggers.join("、")}"
related_tool: ${skill.tool || ""}
created_by: agent
ledger_tag: ${LEDGER_TAG}
trials: 0
successes: 0
created_at: ${now}
updated_at: ${iso}
---

# ${skill.title}

${skill.body}
`;
  fs.writeFileSync(file, md, "utf-8");
  writeManifest();
  audit("precipitate", { skill_id: skill.id, tool: skill.tool });
  return { written: true, file, exists: false };
}

/** 治理（借鉴 Hermes curator：归档替代删除）——把技能移入 <root>/.archive/<id>/（可恢复，不出现在活动库/检索/账本）。
 *  pinned: true 的技能拒绝归档。 */
export function archiveSkill(id) {
  const root = skillsDir();
  const dir = path.join(root, id);
  const file = path.join(dir, "SKILL.md");
  if (!fs.existsSync(file)) return { ok: false, error: `技能不存在: ${id}` };
  let pinned = false;
  try {
    pinned = /^pinned:\s*true\s*$/m.test(fs.readFileSync(file, "utf-8"));
  } catch {}
  if (pinned) return { ok: false, error: `技能已 pinned，拒绝归档: ${id}` };
  const archiveRoot = path.join(root, ".archive");
  fs.mkdirSync(archiveRoot, { recursive: true });
  if (fs.existsSync(path.join(archiveRoot, id))) fs.rmSync(path.join(archiveRoot, id), { recursive: true, force: true });
  fs.renameSync(dir, path.join(archiveRoot, id));
  writeManifest();
  audit("archive", { skill_id: id });
  return { ok: true, archived: path.join(archiveRoot, id) };
}

/** 从归档恢复技能回活动库 */
export function restoreSkill(id) {
  const src = path.join(skillsDir(), ".archive", id);
  if (!fs.existsSync(path.join(src, "SKILL.md"))) return { ok: false, error: `归档中不存在: ${id}` };
  fs.renameSync(src, path.join(skillsDir(), id));
  writeManifest();
  audit("restore", { skill_id: id });
  return { ok: true, restored: path.join(skillsDir(), id) };
}

/** 解析 SKILL.md 元数据（frontmatter） */
export function parseSkillMeta(md, id) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const fm = m ? m[1] : "";
  const g = (k) => {
    const r = fm.match(new RegExp(`^${k}:\\s*(.+)$`, "m"));
    return r ? r[1].trim() : null;
  };
  const name = g("name") || id;
  const desc = g("description") || "";
  const tIdx = desc.indexOf("Triggers:");
  const triggers = tIdx >= 0 ? desc.slice(tIdx + 9).split(/[、,，]/).map((s) => s.trim()).filter(Boolean) : [];
  const title = desc.split("。")[0] || name;
  const trials = parseInt(g("trials") || "0");
  const successes = parseInt(g("successes") || "0");
  return {
    id,
    name,
    title,
    triggers,
    tool: g("related_tool") || "",
    trials,
    successes,
    rate: trials ? +(successes / trials).toFixed(2) : null,
    created_at: g("created_at") || "",
  };
}

/** 生成能力盘 manifest 索引（文明遗产清单：可检索/可继承的基础） */
export function writeManifest() {
  const list = listSkills();
  const manifest = {
    generated_at: new Date().toISOString(),
    count: list.length,
    ledger_tag: LEDGER_TAG,
    skills: list,
  };
  fs.writeFileSync(path.join(skillsDir(), "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  return manifest;
}

/** 词元化：英文按 token（小写），中文按相邻双字 bigram（轻量、零依赖） */
function tokensOf(s) {
  const ascii = (String(s).match(/[A-Za-z0-9_\-./]+/g) || []).map((t) => t.toLowerCase());
  const han = String(s).replace(/[^\u4e00-\u9fff]/g, "");
  const grams = [];
  for (let i = 0; i < han.length - 1; i++) grams.push(han.slice(i, i + 2));
  return [...ascii, ...grams];
}

/** 检索能力盘（关键词 → 相关教训，按相关性排序）——"文明可查阅"
 *  评分 = 子串命中（标题3/触发词2/正文1）+ 词元重叠（bigram/token，封顶 8 个 ×2）。
 *  子串保精确命中，词元救自然语言表述（如"调用不存在的工具" ↔ 触发词"工具不存在"）。 */
export function searchSkills(query) {
  const q = (query || "").toLowerCase().trim();
  if (!q) return [];
  const qTokens = tokensOf(q);
  try {
    const root = skillsDir();
    if (!fs.existsSync(root)) return [];
    const results = [];
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const mdFile = path.join(root, d.name, "SKILL.md");
      if (!fs.existsSync(mdFile)) continue;
      const md = fs.readFileSync(mdFile, "utf-8");
      const meta = parseSkillMeta(md, d.name);
      const lower = md.toLowerCase();
      const titleHit = meta.title.toLowerCase().includes(q);
      const trigHit = meta.triggers.some((t) => t.toLowerCase().includes(q));
      const bodyHit = lower.includes(q);
      const candTokens = tokensOf(`${meta.title} ${meta.triggers.join(" ")} ${md}`);
      const shared = new Set(candTokens.filter((t) => qTokens.includes(t))).size;
      const tokenScore = Math.min(shared, 8) * 2;
      const score = (titleHit ? 3 : 0) + (trigHit ? 2 : 0) + (bodyHit ? 1 : 0) + tokenScore;
      if (score > 0) results.push({ score, ...meta });
    }
    return results.sort((a, b) => b.score - a.score);
  } catch {
    return [];
  }
}

/** 更新 SKILL 效果元数据：patch = { trials: +1, successes: +1, ... } */
export function updateSkill(id, patch) {
  const file = path.join(skillsDir(), id, "SKILL.md");
  if (!fs.existsSync(file)) return null;
  let md = fs.readFileSync(file, "utf-8");
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  let fm = m[1];
  for (const [k, delta] of Object.entries(patch)) {
    if (typeof delta === "number") {
      // 多行匹配（frontmatter 里字段不在开头），replace 不匹配则无变化
      fm = fm.replace(new RegExp(`(${k}:\\s*)(\\d+)`, "m"), (_, p, v) => `${p}${Math.max(0, parseInt(v) + delta)}`);
    }
  }
  // 时间精度：每次账本变更刷新 updated_at（ISO 毫秒）；旧文件无此字段则补写
  const iso = new Date().toISOString();
  fm = fm.includes("updated_at:")
    ? fm.replace(/(updated_at:\s*).*$/m, `$1${iso}`)
    : `${fm}\nupdated_at: ${iso}`;
  fs.writeFileSync(file, md.replace(m[1], fm), "utf-8");
  writeManifest(); // manifest 随账本变更同步刷新，避免过期索引
  return file;
}

/** 列出 SKILL 及效果账本（选择算子数据源） */
export function listSkills() {
  try {
    const root = skillsDir();
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, "SKILL.md")))
      .map((d) => {
        const md = fs.readFileSync(path.join(root, d.name, "SKILL.md"), "utf-8");
        const m = md.match(/^---\n([\s\S]*?)\n---/);
        const fm = m ? m[1] : "";
        const g = (k) => {
          const r = fm.match(new RegExp(`^${k}:\\s*(.+)$`, "m"));
          return r ? r[1].trim() : null;
        };
        const trials = parseInt(g("trials") || "0");
        const successes = parseInt(g("successes") || "0");
        return {
          id: d.name,
          trials,
          successes,
          rate: trials ? +(successes / trials).toFixed(2) : null,
          tool: g("related_tool") || "",
          created_at: g("created_at") || "", // v0.4.4：供"确定性选取代表教训"使用
        };
      });
  } catch {
    return [];
  }
}

export function countSkills() {
  try {
    const root = skillsDir();
    if (!fs.existsSync(root)) return 0;
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, "SKILL.md")))
      .length;
  } catch {
    return 0;
  }
}


/* ============================================================
 * v0.4.2 去碎片化：把"同一工具 + 同一错误类"的重复教训合并成一条
 * ============================================================ */

/** 从一条教训的正文里取回失败消息（用于反推错误类） */
export function failureMsgOf(id) {
  try {
    const md = fs.readFileSync(path.join(skillsDir(), id, "SKILL.md"), "utf-8");
    const m = md.match(/(?:失败信息：|曾失败：)([\s\S]{0,200})/);
    return m ? m[1].split("\n")[0].trim() : "";
  } catch {
    return "";
  }
}

/** 合并同 (tool, 错误类) 的重复教训：账本累加到 canonical，其余条目**归档而非删除**（可恢复） */
export function compactSkills({ dryRun = false } = {}) {
  // 只合并"通用失败"教训（learn-<12hex>-<12hex>）。
  // 专类教训（learn-collab-* / learn-output-schema-* / learn-unknown-tool-*）**不参与自动合并**：
  // 它们的失败类可能相同，但给出的**建议不同**——真实数据上就发生过 collab 教训被并进普通失败教训（v0.4.3 修正）。
  const GENERIC = /^learn-[0-9a-f]{12}-[0-9a-f]{12}$/;
  const list = listSkills().filter((s) => GENERIC.test(s.id));
  const groups = new Map();
  for (const s of list) {
    const cls = errorClass(failureMsgOf(s.id));
    const key = `${s.tool}||${cls}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const merged = [];
  let archived = 0;
  for (const [key, items] of groups) {
    if (items.length < 2) continue;
    // canonical：账本最厚的一条（trials+successes 最大），并列取最早创建
    const [tool] = key.split("||");
    const canon = items.slice().sort((a, b) => (b.trials + b.successes) - (a.trials + a.successes))[0];
    const others = items.filter((x) => x.id !== canon.id);
    const trials = items.reduce((n, x) => n + x.trials, 0);
    const successes = items.reduce((n, x) => n + x.successes, 0);
    merged.push({ tool, canonical: canon.id, merged_from: others.map((x) => x.id), trials, successes });
    if (dryRun) continue;
    // 把合并来的账本累加进 canonical，并记录来源（可追溯：合并过谁）
    const file = path.join(skillsDir(), canon.id, "SKILL.md");
    let md = fs.readFileSync(file, "utf-8");
    md = md.replace(/^(trials:\s*)\d+$/m, `$1${trials}`).replace(/^(successes:\s*)\d+$/m, `$1${successes}`);
    const fromLine = `merged_from: [${others.map((x) => x.id).join(", ")}]`;
    md = /^merged_from:/m.test(md) ? md.replace(/^merged_from:.*$/m, fromLine) : md.replace(/^---\n/, `---\n${fromLine}\n`);
    fs.writeFileSync(file, md, "utf-8");
    // 其余条目归档（保留证据、可 restore）
    for (const o of others) {
      const r = archiveSkill(o.id);
      if (r.ok) archived++;
    }
    audit("compact", { tool, canonical: canon.id, merged_from: others.map((x) => x.id), trials, successes });
  }
  if (!dryRun) writeManifest();
  return { ok: true, groups_scanned: groups.size, groups_merged: merged.length, archived, merged };
}
