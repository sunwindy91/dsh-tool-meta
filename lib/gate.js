import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 高危动作闸门（pre-execute 硬闸门）
// ============================================================
// 为什么需要它：本插件原本只从 tools/result 的**失败**里学习。但有一类错误没有失败信号——
// **工具调用成功了，决策却错了**：用通配符批量删除超出计划范围、把不该删的目录删掉、误覆盖。
// 这类错误"事后反思"学不到（没有失败可反射），只能靠**执行前闸门**拦住。
//
// 设计原则：
//   1. 只拦"不可逆 + 高危"的动作（删除），不干扰正常读写——闸门太吵就会被关掉，等于没有。
//   2. 拦的方式不是"禁止"，而是**要求先声明**：不可逆操作前，必须显式声明目标清单 + 备份证据，
//      并由闸门在放行时把它写进审计流水（谁在几点、要删什么、依据什么备份）。
//   3. 通配符删除、受保护路径：**一律拒绝**，任何声明都不能放行（因为"显式列举"就是闸门的意义）。
//   4. 诚实边界：闸门能拦"字面通配符/递归强制删除"与"未声明的删除"，但**拦不住精心构造的绕过**
//      （例如把目标藏在运行时计算里）。它的价值是"让不可逆动作必须留下可审计的声明"，
//      不是"保证万无一失"。这一条写在 docs 里，不吹成保险箱。

/** 删除类动作的信号（命令行式） */
export const CLI_DELETE_SIGNALS = [
  /\brm\s+-/i, /\brm\s+["'$\w.\/~]/i, /\brmdir\b/i, /\brd\s+\/s/i, /\bdel\s+\/[a-z]/i,
  /Remove-Item\b/i, /\bri\s+-Recurse/i, /\bgit\s+clean\s+-[a-z]*f/i, /\btruncate\s+-s\s*0/i,
];

/** 删除类动作的信号（代码式：程序化循环删除 —— 目标在运行时才算出来，抽不出可靠清单） */
export const CODE_DELETE_SIGNALS = [
  /os\.remove|os\.rmdir|os\.unlink|shutil\.rmtree|Path\([^)]*\)\.unlink|fs\.rmSync|fs\.rm\(|fs\.unlink|unlinkSync|rmdirSync|removeSync/i,
];

/** 兼容旧名（原有的 DELETE_SIGNALS 语义 = 两者的并集） */
export const DELETE_SIGNALS = [...CLI_DELETE_SIGNALS, ...CODE_DELETE_SIGNALS];

/** 递归 / 强制 标记（命中即视为高危，必须声明） */
export const FORCE_RECURSE = [/-rf\b|-fr\b|--recursive|--force|-Recurse|-Force|\/s\b|\/q\b|-r\b|-f\b/i];

/** 默认受保护路径：能力盘与审计流水本身（学习成果不可被误删） */
export const PROTECTED_DEFAULT = [".dsh/skills", ".dsh\\skills", "skills/.audit", ".audit/ledger.jsonl"];

/**
 * 内容型工具：参数是**要被写下来的文本**，不是要执行的动作。
 * 必须跳过——否则"一份讨论删除 API 的文档"会被判成"程序化删除"而拒绝。
 * 这是真实发生过的误报（本插件在给自己写文档时被自己拦下），回归用例见 tests/unit.mjs。
 * 可用 META_GATE_SKIP_TOOLS 追加（逗号分隔）。
 */
export const CONTENT_TOOLS_DEFAULT = [
  "write", "write_file", "edit", "edit_file", "multi_edit", "multiedit", "str_replace",
  "apply_patch", "patch", "create", "create_file", "append", "insert", "update_file",
  "notebook_edit", "present", "todo_write",
];

const WILDCARD = /[*?]|\[\d|\[\^/;

/** 从参数里抽候选路径（引号串、类路径 token） */
function extractTargets(text) {
  const out = new Set();
  for (const m of text.matchAll(/["'`]([^"'`\n]{1,200})["'`]/g)) {
    const v = m[1];
    if (/[\\/]|^[A-Za-z]:|\.\w{1,6}$|[*?]/.test(v)) out.add(v.trim());
  }
  for (const m of text.matchAll(/(?:^|[\s(=,])((?:[A-Za-z]:)?[\\/]?[\w.\-\\/]{2,}[\\/][\w.\-\\/*?]*)/g)) {
    out.add(m[1].trim());
  }
  return [...out];
}

/**
 * 判定一次调用是否属于"高危删除"。
 * @returns null（不干预）或 { kind:'explicit'|'code', targets:string[], wildcard:boolean, forceRecurse:boolean, raw:string }
 */

/* ============================================================
 * v0.4.5：只在"命令位"判删除
 * 起因（真实误报）：一条只读命令用搜索工具去找若干删除写法，却被判成删除动作而拒绝。
 * 修法：① 只分析参数里的字符串叶子；② 按语句分隔符切段；③ 段首是"读/搜/打印类命令"就跳过
 *      （它的参数是**文本**）；④ 段首是执行器（python/node/pwsh…）就递归解析它真正执行的内部命令。
 * ============================================================ */

/** 读 / 搜 / 打印类命令：参数是文本，不是动作 */
export const READER_COMMANDS = [
  "grep", "rg", "egrep", "fgrep", "findstr", "select-string", "sls",
  "get-content", "gc", "type", "cat", "bat", "head", "tail", "more",
  "echo", "write-output", "write-host", "print",
  "get-childitem", "gci", "ls", "dir", "where", "which", "test-path",
  "select-object", "measure-object", "compare-object", "sort-object",
];
const READERS = new Set(READER_COMMANDS);

/** 执行器：它后面跟的是"要执行的命令/代码"，需要递归解析 */
export const EXECUTOR_COMMANDS = [
  "python", "python3", "py", "node", "deno", "bun", "bash", "sh", "zsh",
  "pwsh", "powershell", "cmd", "perl", "ruby", "php",
];
const EXECUTORS = new Set(EXECUTOR_COMMANDS);

/** 按语句分隔符切段（; && || | 换行） */
function splitSegments(text) {
  return String(text)
    .split(/\r?\n|;|&&|\|\||\|/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 取一段的命令名（首词），去掉前导 & $ 与路径、.exe 后缀 */
function commandOf(seg) {
  const m = String(seg).trim().replace(/^[&$]\s*/, "").match(/^([\w.\-\/:\\]+)/);
  if (!m) return "";
  const base = m[1].split(/[\\/]/).pop() || m[1];
  return base.toLowerCase().replace(/\.exe$/, "");
}

/** 取执行器真正执行的东西：-Command / -c / -e / --eval 之后的参数（去掉外层引号） */
function innerCommandOf(seg) {
  const m = String(seg).match(/(?:-command|-c|-e|--eval)\s+(.+)$/i);
  if (!m) return null;
  const raw = m[1].trim();
  const q = raw.match(/^["'`]([\s\S]*)["'`]$/);
  return q ? q[1] : raw;
}

/** 递归分析一段文本，返回是否命中删除类信号 */
function analyzeCommandText(text, depth = 0) {
  const hit = { cli: false, code: false, force: false, raw: "" };
  for (const seg of splitSegments(text)) {
    const cmd = commandOf(seg);
    if (!cmd) continue;
    if (READERS.has(cmd)) continue; // 读/搜/打印：内容当文本看
    if (EXECUTORS.has(cmd)) {
      if (CODE_DELETE_SIGNALS.some((re) => re.test(seg))) {
        hit.code = true;
        hit.raw = hit.raw || seg;
      }
      const inner = innerCommandOf(seg);
      if (inner && depth < 2) {
        const sub = analyzeCommandText(inner, depth + 1);
        if (sub.cli || sub.code) {
          hit.cli = hit.cli || sub.cli;
          hit.code = hit.code || sub.code;
          hit.force = hit.force || sub.force;
          hit.raw = hit.raw || sub.raw;
        }
      }
      continue;
    }
    if (CLI_DELETE_SIGNALS.some((re) => re.test(seg))) {
      hit.cli = true;
      hit.raw = hit.raw || seg;
    }
    if (CODE_DELETE_SIGNALS.some((re) => re.test(seg))) {
      hit.code = true;
      hit.raw = hit.raw || seg;
    }
    if (FORCE_RECURSE.some((re) => re.test(seg))) hit.force = true;
  }
  return hit;
}

/** 递归取参数里的字符串叶子（只分析"值"，不分析 JSON 外壳） */
function stringLeaves(value, out = [], depth = 0) {
  if (depth > 4 || out.length > 60) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out, depth + 1);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringLeaves(v, out, depth + 1);
  return out;
}


/* ============================================================
 * v0.5：对外不可逆动作
 * 与"删除"并列的第二类：动作本身**对外可见、且撤不回来**（推送、公开评论、发布）。
 * 真实事故：① 没查 open PR 就公开认领 issue（被早 8 天的 PR 抢先）
 *          ② 脱敏扫描与 push 并行，没等结果就推（带出本地路径 17 处）
 * 共同点：缺少**强制的前置核验**。所以对外动作的声明里，precondition 字段是必填的。
 * ============================================================ */

/** 对外动作信号：需要先声明（声明里必须写前置核验） */
export const OUTWARD_SIGNALS = [
  /\bgit\s+push\b/i,
  /\bgh\s+(pr|issue|release|discussion)\s+(create|comment|close|reopen|merge|edit|delete)\b/i,
  /\bgh\s+api\b[^\n]*(-X|--method)\s*(POST|PATCH|PUT|DELETE)/i,
  /\b(npm|yarn|pnpm)\s+publish\b/i,
  /\bdocker\s+push\b/i,
  /\bcurl\b[^\n]*\s-X\s*(POST|PUT|PATCH|DELETE)/i,
  /Invoke-RestMethod[^\n]*-Method\s+(Post|Put|Patch|Delete)/i,
];

/** 强制型对外动作：一律拒绝，声明也不能豁免（改写共享历史 / 删远端） */
export const FORCE_OUTWARD_SIGNALS = [
  /\bgit\s+push\b[^\n]*--force(-with-lease)?\b/i,
  /\bgit\s+push\b[^\n]*\s-f\b/i,
  /\bgit\s+push\b[^\n]*--delete\b/i,
];

/** 只读命令白名单（对外类）：这些不算对外动作 */
const OUTWARD_READERS = [
  /\bgh\s+(pr|issue|release|discussion)\s+(list|view|status|diff|checks)\b/i,
  /\bgh\s+api\b(?![^\n]*(-X|--method)\s*(POST|PATCH|PUT|DELETE))/i,
  /\bgit\s+(status|log|diff|show|fetch|branch|remote|config)\b/i,
];

/** 常见"包裹层"：pwsh -c "git push"、cmd /c "..."、python -c "..." 等 */
const OUTWARD_WRAPPERS = /^(sudo\s+)?(pwsh|powershell|cmd|bash|sh|python3?|node)\b[^\n]*?(?:-c|-Command|\/c|-e)\s+/i;
/** 命令位的第一个词必须是这些之一，才算"真的在发" */
const OUTWARD_CMDS = /^(sudo\s+)?(git|gh|npm|yarn|pnpm|docker|curl|Invoke-RestMethod|wrangler|vercel|netlify|twine|cargo)\b/i;

/** 剥掉提示符与包裹层，拿到"这一行真正要执行的命令" */
function outwardTail(seg) {
  let s = String(seg || "").trim().replace(/^([>$#]|\d+>)\s*/, "").replace(/^["'`]/, "");
  for (let i = 0; i < 2; i++) {
    const m = s.match(OUTWARD_WRAPPERS);
    if (!m) break;
    s = s.slice(m[0].length).replace(/^["'`]/, "");
  }
  return s;
}

function detectOutward(text) {
  const t = String(text || "");
  if (!OUTWARD_SIGNALS.some((re) => re.test(t))) return null;
  // v0.5.1：**必须在命令位**才算对外动作。
  // 真实误报（第三次同族）：给子代理的提示词里提到「例如 git push、公开评论」，被判成要推送。
  // 所以按行/分号切开，逐段剥掉提示符与包裹层，要求该段**以命令词开头**且命中信号。
  const segs = t.split(/\r?\n|;|&&|\|\||\|/);
  let hit = null;
  for (const seg of segs) {
    const tail = outwardTail(seg);
    if (!OUTWARD_CMDS.test(tail)) continue;
    if (!OUTWARD_SIGNALS.some((re) => re.test(tail))) continue;
    hit = tail;
    break;
  }
  if (!hit) return null;
  const forced = FORCE_OUTWARD_SIGNALS.some((re) => re.test(hit));
  return { forced, raw: hit.slice(0, 300) };
}

export function detectDanger(exec) {
  const name = (exec && exec.name) || "";
  let argsText = "";
  try {
    argsText = JSON.stringify((exec && exec.arguments) || {});
  } catch {
    argsText = String((exec && exec.arguments) || "");
  }
  const text = `${name} ${argsText}`;

  // 只分析参数里的字符串叶子（v0.4.5）：JSON 外壳里的键名/结构不参与判定
  const leaves = stringLeaves((exec && exec.arguments) || {});
  const merged = { cli: false, code: false, force: false, raw: "" };
  for (const leaf of leaves) {
    const h = analyzeCommandText(leaf);
    if (h.cli || h.code) {
      merged.cli = merged.cli || h.cli;
      merged.code = merged.code || h.code;
      merged.force = merged.force || h.force;
      merged.raw = merged.raw || h.raw;
    }
  }
  if (!merged.cli && !merged.code) {
    // 无删除信号 → 再看是不是"对外不可逆动作"（v0.5）。注意：这一支必须在提前 return 之前判断，
    // 否则对外检测永远不可达（v0.5 首个版本就踩了这个顺序坑，被自己的测试抓住）。
    const outLeaf = leaves.map(detectOutward).find(Boolean);
    if (outLeaf) {
      return { kind: "outward", forced: outLeaf.forced, targets: [], wildcard: false, forceRecurse: false, raw: outLeaf.raw };
    }
    return null;
  }
  const isCode = merged.code && !merged.cli;
  const raw = merged.raw || text.slice(0, 300);
  const targets = !isCode ? extractTargets(raw) : [];
  const wildcard = !isCode && targets.some((t) => WILDCARD.test(t));
  return { kind: isCode ? "code" : "explicit", targets, wildcard, forceRecurse: merged.force, raw: raw.slice(0, 300) };
}


/* ============================================================
 * v0.5.3：声明与"关掉"都必须有**不依赖工具注册**的路径
 *
 * 起因（真实卡点 2026-09-22）：闸门拒绝了作者的推送，要求先调 meta_prepare 声明，
 * 但那个工具**不在当次会话的工具列表里**（工具列表是会话开始时的快照，而插件代码会热重载）
 * → **闸门要求声明，却给不出可达的声明途径** → 结局必然是被绕过或被卸载。
 *
 * 修法两条：
 *   ① 文件式声明：<skills_root>/.audit/declarations.jsonl（任何 agent 都能写，不依赖工具）
 *   ② 逃生阀改成**每次判定时读取**：环境变量 + 哨兵文件（<skills_root>/.audit/gate.off 等）
 * ============================================================ */

/** 能力盘目录（与 skillwriter 一致）：META_SKILLS_DIR 可覆盖 */
function skillsRoot() {
  return process.env.META_SKILLS_DIR || join(homedir(), ".dsh", "skills");
}

const declFile = () => join(skillsRoot(), ".audit", "declarations.jsonl");
const sentinelMain = () => join(skillsRoot(), ".audit", "gate.off");
const sentinelOutward = () => join(skillsRoot(), ".audit", "gate.outward.off");

function envOff(name) {
  return String(process.env[name] || "on").toLowerCase() === "off";
}

function sentinelOff(which) {
  try {
    return existsSync(which === "outward" ? sentinelOutward() : sentinelMain());
  } catch {
    return false;
  }
}

/**
 * 读文件式声明（追加式 JSONL，一行一条；用 {"id":..,"consumed":true} 标记已消费）。
 * 每次判定都重新读——保证"刚写的声明立刻生效"，不需要重启。
 */
function fileClaims() {
  let raw = "";
  try {
    raw = readFileSync(declFile(), "utf8");
  } catch {
    return [];
  }
  const consumed = new Set();
  const rows = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    if (o.consumed && o.id) consumed.add(String(o.id));
    else if (o.id) rows.push(o);
  }
  return rows
    .filter((o) => !consumed.has(String(o.id)))
    .map((o) => {
      const exp = o.expires_at ? Date.parse(o.expires_at) : NaN;
      return {
        id: String(o.id),
        action: String(o.action || "delete"),
        kind: o.scope ? "code" : "explicit",
        targets: Array.isArray(o.targets) ? o.targets.map(String) : [],
        scope: o.scope ? String(o.scope) : null,
        expectedCount: Number.isInteger(o.expected_count) ? o.expected_count : null,
        backupSource: o.backup_source ? String(o.backup_source) : null,
        backupHash: o.backup_hash ? String(o.backup_hash) : null,
        target: o.target ? String(o.target) : null,
        precondition: o.precondition ? String(o.precondition) : null,
        expiresAt: Number.isFinite(exp) ? exp : Number.MAX_SAFE_INTEGER,
        source: "file",
      };
    });
}

/** 消费一条文件式声明（追加 consumed 标记；写不进去也不影响本次放行） */
function consumeFileClaim(id) {
  try {
    appendFileSync(
      declFile(),
      JSON.stringify({ id: String(id), consumed: true, consumed_at: new Date().toISOString() }) + "\n",
      "utf8",
    );
  } catch {
    /* 诚实边界：标记写不进去时，该声明下次仍可能命中——已写进 docs/known-evasions.md */
  }
}

/**
 * 创建闸门实例（会话级内存声明表 + 可选落盘审计）。
 * @param {object} opts
 *   audit        (op, data) => void   审计写入（默认 no-op）
 *   protectedPaths string[]           受保护路径片段（默认 PROTECTED_DEFAULT）
 *   ttlMs        number               声明有效期（默认 30 分钟，META_GATE_TTL_MIN 可调）
 *   enabled      boolean              总开关（META_GATE=off 关闭）
 */
export function createGate(opts = {}) {
  const audit = opts.audit || (() => {});
  const protectedPaths = opts.protectedPaths || PROTECTED_DEFAULT;
  const ttlMs = opts.ttlMs || Math.max(1, parseInt(process.env.META_GATE_TTL_MIN || "30", 10) || 30) * 60_000;
  // v0.5.3：开关**每次判定时**读取（此前在 createGate 时固化 → 运行中改了没用）
  const enabledAtCreate = opts.enabled !== undefined
    ? opts.enabled
    : String(process.env.META_GATE || "on").toLowerCase() !== "off";
  const gateEnabled = () => (opts.enabled !== undefined ? opts.enabled : !envOff("META_GATE")) && !sentinelOff("main");
  const skipTools = new Set([
    ...(opts.skipTools || CONTENT_TOOLS_DEFAULT),
    ...String(process.env.META_GATE_SKIP_TOOLS || "").split(",").map((s) => s.trim()).filter(Boolean),
  ].map((s) => s.toLowerCase()));

  const outwardEnabled = opts.outward !== undefined
    ? opts.outward
    : String(process.env.META_GATE_OUTWARD || "on").toLowerCase() !== "off";
  // 同上：对外闸门也每次判定时读（含哨兵文件 gate.outward.off，5 秒内可关）
  const outwardOn = () => (opts.outward !== undefined ? opts.outward : !envOff("META_GATE_OUTWARD")) && !sentinelOff("outward");
  const claims = new Map(); // id -> {action, kind, targets, scope, expectedCount, backupSource, backupHash, precondition, target, expiresAt}
  let seq = 0;

  function prepare(input = {}) {
    const id = `gate-${Date.now().toString(36)}-${++seq}`;
    const claim = {
      id,
      action: input.action || "delete",
      kind: input.kind || (input.scope ? "code" : "explicit"),
      targets: Array.isArray(input.targets) ? input.targets.map(String) : [],
      scope: input.scope ? String(input.scope) : null,
      expectedCount: Number.isInteger(input.expected_count) ? input.expected_count : null,
      backupSource: input.backup_source ? String(input.backup_source) : null,
      backupHash: input.backup_hash ? String(input.backup_hash) : null,
      target: input.target ? String(input.target) : null,
      precondition: input.precondition ? String(input.precondition) : null,
      expiresAt: Date.now() + ttlMs,
    };
    claims.set(id, claim);
    audit("gate:prepare", {
      claim_id: id, action: claim.action, kind: claim.kind,
      targets: claim.targets, scope: claim.scope,
      expected_count: claim.expectedCount,
      backup_source: claim.backupSource, backup_hash: claim.backupHash,
      expires_at: new Date(claim.expiresAt).toISOString(),
    });
    return claim;
  }

  function validClaims() {
    const now = Date.now();
    for (const [id, c] of claims) if (c.expiresAt <= now) claims.delete(id);
    // v0.5.3：内存声明 + **文件声明**（后者不依赖工具注册，任何 agent 都能写）
    const fromFile = fileClaims().filter((c) => c.expiresAt > now);
    return [...claims.values(), ...fromFile];
  }

  /** 放行后消费声明：内存的直接删；文件式的追加 consumed 标记 */
  function consume(claim) {
    if (claim.source === "file") consumeFileClaim(claim.id);
    else claims.delete(claim.id);
  }

  function coveredBy(claim, d) {
    if (d.kind === "outward") {
      // 对外动作：需要 action='publish' + target 命中 + **必须写了前置核验**
      if (claim.action !== "publish") return false;
      if (!claim.precondition) return false;
      if (!claim.target) return false;
      // 归一化后比较：'origin/main' 与命令里的 'origin main' 应该算命中
      const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
      const t = norm(claim.target);
      const raw = norm(d.raw);
      return Boolean(t) && (raw.includes(t) || t.includes(raw));
    }
    if (claim.action !== "delete") return false;
    if (d.kind === "code") {
      // 代码型删除：必须声明 scope + 预期条数 + 备份证据（三者缺一不可）
      if (!claim.scope || !claim.expectedCount || !claim.backupHash) return false;
      return d.raw.includes(claim.scope);
    }
    if (claim.kind !== "explicit" || !claim.targets.length) return false;
    // 显式删除：声明必须覆盖调用里的每一个目标（子串匹配，容忍引号/路径分隔差异）
    return d.targets.every((t) => claim.targets.some((c) => t.includes(c) || c.includes(t)));
  }

  /**
   * 守卫：同步检查，返回字符串 = 拒绝执行（DSH 的 guard 是单调拒绝，后续监听器无法翻案）。
   * @returns string | undefined
   */
  function evaluate(exec) {
    if (!gateEnabled()) return undefined;
    // 工具作用域限定：内容型工具（write/edit…）跳过——它们的内容可以合法地讨论删除
    if (skipTools.has(String((exec && exec.name) || "").toLowerCase())) return undefined;
    const d = detectDanger(exec);
    if (!d) return undefined;

    // ---- v0.5：对外不可逆动作 ----
    if (d.kind === "outward") {
      if (!outwardOn()) return undefined;
      if (d.forced) {
        audit("gate:deny", { reason: "force_outward", raw: d.raw });
        return "⛔ 高危动作闸门：**强制推送 / 删除远端分支**会改写共享历史且无法撤销，一律拒绝（声明也不豁免）。"
          + "如确需如此，请人工执行并说明原因。";
      }
      const claimOut = validClaims().find((c) => coveredBy(c, d));
      if (!claimOut) {
        audit("gate:deny", { reason: "no_claim_outward", raw: d.raw });
        return "⛔ 高危动作闸门：这是**对外、不可逆**的动作（推送 / 公开评论 / 发布），但没有先声明。"
          + "请先调用 meta_prepare —— action:'publish', target:'<远端或仓库>', "
          + "**precondition:'<你核验了什么>'**（例：'desensitize_scan 0 命中 + 测试全绿' 或 "
          + "'gh pr list --search 3915 → 0 个 open PR'）。"
          + "声明会被写进审计流水，且**一次性有效**。"
          + "\n【可达的两条路】① 文件式声明（推荐，不依赖工具注册）："
          + "往 <skills_root>/.audit/declarations.jsonl 追加一行 "
          + "{\"id\":\"<唯一id>\",\"action\":\"publish\",\"target\":\"origin/main\",\"precondition\":\"<你核验了什么>\"}"
          + " ② 关掉这一类：环境变量 META_GATE_OUTWARD=off，或创建哨兵文件 <skills_root>/.audit/gate.outward.off（立即生效）";
      }
      consume(claimOut);
      audit("gate:allow", { claim_id: claimOut.id, kind: "outward", source: claimOut.source || "memory", raw: d.raw });
      audit("gate:consume", { claim_id: claimOut.id, remaining: validClaims().length });
      return undefined;
    }

    // ① 受保护路径：一律拒绝
    const hitProtected = protectedPaths.filter((p) => d.raw.includes(p));
    if (hitProtected.length) {
      audit("gate:deny", { reason: "protected_path", paths: hitProtected, raw: d.raw });
      return `⛔ 高危动作闸门：目标是受保护路径（${hitProtected.join("、")}）。`
        + `这类路径存放能力盘/审计流水，禁止删除；如确需处理，请人工操作并说明原因。`;
    }

    // ② 通配符删除：一律拒绝（任何声明都不放行）
    if (d.wildcard) {
      audit("gate:deny", { reason: "wildcard", targets: d.targets, raw: d.raw });
      return `⛔ 高危动作闸门：删除目标含通配符（${d.targets.filter((t) => WILDCARD.test(t)).join("、")}）。`
        + `闸门要求**逐个显式列举**目标，不接受通配/模式匹配——请先列出完整清单并核对，再执行；`
        + `如数量很多，请先复制并校验哈希（meta_prepare），再分批按清单删除。`;
    }

    // ③ 未声明的删除：拒绝并给出声明模板
    const claim = validClaims().find((c) => coveredBy(c, d));
    if (!claim) {
      const need = d.kind === "code"
        ? `这是"程序化删除"（抽不出显式目标清单），必须声明：action:'delete', scope:'<目录>', expected_count:<条数>, backup_source:'<备份位置>', backup_hash:'<sha256>'`
        : `请声明：action:'delete', targets:[${d.targets.map((t) => `'${t}'`).join(", ")}], backup_source:'<备份位置>', backup_hash:'<sha256>'`;
      audit("gate:deny", { reason: "no_claim", kind: d.kind, targets: d.targets, force_recursive: d.forceRecurse, raw: d.raw });
      return `⛔ 高危动作闸门：这是一次不可逆删除${d.forceRecurse ? "（含递归/强制标记）" : ""}，但**没有先声明**。`
        + `请先调用 meta_prepare —— ${need}；`
        + `声明会被写进审计流水（谁在几点、删什么、依据什么备份），然后闸门才放行。`
        + `\n【可达的两条路】① 文件式声明：往 <skills_root>/.audit/declarations.jsonl 追加一行 JSON`
        + `（action/targets/backup_source/backup_hash）② 关掉闸门：META_GATE=off 或哨兵文件 <skills_root>/.audit/gate.off`;
    }

    // 一次性消费（v0.4.4）：声明放行一次即失效——工具描述承诺"放行一次"，实现必须与之相称，
    // 否则同一份声明可在有效期内无限次放行同类删除（真实缺陷）。
    consume(claim);
    audit("gate:allow", { claim_id: claim.id, kind: d.kind, source: claim.source || "memory", targets: d.targets, force_recursive: d.forceRecurse });
    audit("gate:consume", { claim_id: claim.id, remaining: validClaims().length });
    return undefined;
  }

  return {
    enabled: enabledAtCreate,
    enabledNow: () => gateEnabled(),
    outwardEnabledNow: () => outwardOn(),
    skillsRoot: () => skillsRoot(),
    prepare,
    evaluate,
    detect: detectDanger,
    list: () => validClaims(),
    protectedPaths,
    skipTools: [...skipTools],
    ttlMs,
  };
}
