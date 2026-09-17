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
  if (!merged.cli && !merged.code) return null;
  const isCode = merged.code && !merged.cli;
  const isCli = merged.cli;
  const forceRecurse = merged.force;
  const raw = merged.raw || text.slice(0, 300);
  const targets = !isCode ? extractTargets(raw) : [];
  const wildcard = !isCode && targets.some((t) => WILDCARD.test(t));
  return { kind: isCode ? "code" : "explicit", targets, wildcard, forceRecurse, raw: raw.slice(0, 300) };
}
  // 分类顺序很重要：**先看是不是代码式删除**。
  // 代码里的路径是运行时算出来的（例如 shutil.rmtree(D + name)），从源码里"抽目标"只会抽出噪音片段，
  // 若误判为 explicit，就会要求声明一份根本对不上的清单 → 闸门永远过不去 → 用户直接关掉它。

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
  const enabled = opts.enabled !== undefined
    ? opts.enabled
    : String(process.env.META_GATE || "on").toLowerCase() !== "off";
  const skipTools = new Set([
    ...(opts.skipTools || CONTENT_TOOLS_DEFAULT),
    ...String(process.env.META_GATE_SKIP_TOOLS || "").split(",").map((s) => s.trim()).filter(Boolean),
  ].map((s) => s.toLowerCase()));

  const claims = new Map(); // id -> {action, kind, targets, scope, expectedCount, backupSource, backupHash, expiresAt}
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
    return [...claims.values()];
  }

  function coveredBy(claim, d) {
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
    if (!enabled) return undefined;
    // 工具作用域限定：内容型工具（write/edit…）跳过——它们的内容可以合法地讨论删除
    if (skipTools.has(String((exec && exec.name) || "").toLowerCase())) return undefined;
    const d = detectDanger(exec);
    if (!d) return undefined;

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
        + `声明会被写进审计流水（谁在几点、删什么、依据什么备份），然后闸门才放行。`;
    }

    // 一次性消费（v0.4.4）：声明放行一次即失效——工具描述承诺"放行一次"，实现必须与之相称，
    // 否则同一份声明可在有效期内无限次放行同类删除（真实缺陷）。
    claims.delete(claim.id);
    audit("gate:allow", { claim_id: claim.id, kind: d.kind, targets: d.targets, force_recursive: d.forceRecurse });
    audit("gate:consume", { claim_id: claim.id, remaining: validClaims().length });
    return undefined;
  }

  return {
    enabled,
    prepare,
    evaluate,
    detect: detectDanger,
    list: () => validClaims(),
    protectedPaths,
    skipTools: [...skipTools],
    ttlMs,
  };
}
