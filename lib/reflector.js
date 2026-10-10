// 反思：失败样本 → 方法论 SKILL（规则模板，确定性优先；LLM 增强留升级口）。
import crypto from "node:crypto";

function hash(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
}

/** 把失败消息归一化成稳定的"错误类"：抹掉路径/数字/引号/十六进制等易变片段。
 *  为什么需要：按"完整消息哈希"当 id，会让同一种失败因为路径或行号不同而各占一条教训——
 *  实测中 edit 一次就攒了 8 条同类教训，检索时互相稀释。归一到"类"后再去重才有意义。 */
export function errorClass(msg, code) {
  let m = String(msg || "");
  m = m
    .replace(/[A-Za-z]:\\[^\s"']+/g, "<path>")
    .replace(/[\\/][^\s"']{2,}/g, "/<path>")
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/[A-Za-z0-9_\-]+\.[A-Za-z0-9]{1,6}\b/g, "<file>")  // 裸文件名（如 shared.md）也要归一
    .replace(/\d+/g, "<n>")
    .replace(/["'`][^"'`]*["'`]/g, "<str>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return (code ? String(code).toLowerCase() + ":" : "") + m.slice(0, 60);
}

// 负向清单（治理第一道闸，借鉴 Hermes"不得捕获"清单，规则化）：
// 环境性/策略性失败——缺凭据、未配置、命令缺失、沙箱策略拒绝——永不沉淀（与 N=2 阈值互补）。
const NEGATIVE_PATTERNS = [
  /MISSING_CREDENTIAL/i,
  /no API key/i,
  /not configured/i,
  /command not found/i,
  /sandbox/i, // 沙箱策略性拒绝（文件访问被拒/升级提示），非真实方法论信号
];

/* ============================================================
 * v0.6.0：错误模式表 —— 把「症状」映射到「根因 + 对策」
 *
 * 为什么改：v0.5.x 的通用分支只写「一行失败特征 + 一行所有条目共用的套话」，
 * 触发词全是「<tool>/失败/报错」→ 模型**分不出该看哪一条**（实测 edit 类攒了 10 条同质条目）。
 *
 * 两条设计规矩：
 *   ① **一条模式必须能指向一次真实事故**；找不到对应事故的模式不加（避免正则无限增长）。
 *   ② id 用「工具 + 错误类」而不是「工具 + 完整消息哈希」→ 同一类失败**只占一条**，
 *      再遇到走 recur（trials+1），不再新增条目。
 *
 * 前缀兼容：collab / output-schema / unknown-tool 三个前缀保留 ——
 *   skillwriter.compactSkills 用它们区分「专类教训不参与自动合并」（v0.4.3 的规则）。
 * ============================================================ */
export const ERROR_PATTERNS = [
  {
    id: "concurrent-write", prefix: "collab", label: "并发写冲突",
    test: /file changed since it was read|FS_STALE_VERSION|stale version|read.?before.?edit|concurrent|conflict/i,
    when: "edit/write 报 file changed since it was read；或多个会话/子代理同时写同一个文件",
    cause: "read 与 edit 之间，文件被另一个写者改动过；并行 agent 没有划清写入域",
    fix: [
      "重新 read 再 edit（read-before-edit），不要基于陈旧版本写入",
      "多 agent 并行前先划互不重叠的写入域（disjoint scopes）；共享文件由单一 owner 写",
      "冲突交给用户 review，不要静默覆盖",
    ],
    triggers: ["冲突", "并发", "stale", "read-before-edit", "disjoint"],
  },
  {
    id: "proxy-stale", label: "代理配置失效",
    test: /via 127\.0\.0\.1|proxy|代理/i,
    when: "命令报 Failed to connect … via 127.0.0.1 / proxy 连接失败（常见于 git push、gh、抓取）",
    cause: "本机代理（Clash 等）没在运行，但 git 全局配置或环境变量仍指向它",
    fix: [
      "先确认代理端口在不在监听（不是看系统代理开关）",
      "临时绕过：给单条命令清掉代理（如 git -c http.proxy= -c https.proxy= …）",
      "长期：不用代理时清掉 git config --global http.proxy，避免它变成'每次都失败'的默认值",
    ],
    triggers: ["代理", "proxy", "127.0.0.1", "git push 失败"],
  },
  {
    id: "network-unreachable", label: "网络不可达",
    test: /fetch failed|ECONNREFUSED|ECONNRESET|getaddrinfo|ENOTFOUND|ETIMEDOUT|TLS handshake|socket hang up/i,
    when: "抓取/请求类工具报 fetch failed、连接被拒、DNS 解析失败",
    cause: "目标不可达：网络中断、DNS 失败，或代理/直连选错了路径",
    fix: [
      "分别验证「直连」与「走代理」哪条通，再决定用哪条",
      "确认是环境问题（不是代码问题）后，不要把它当逻辑 bug 反复重试",
      "需要长期稳定时，给这类任务加降级标记，而不是静默当成'没有结果'",
    ],
    triggers: ["网络", "fetch failed", "ECONNREFUSED", "DNS", "超时不可达"],
  },
  {
    id: "generated-code-syntax", label: "生成代码语法错",
    test: /SyntaxError|Unexpected (reserved word|token|identifier)|unterminated|invalid character|IndentationError|invalid syntax/i,
    when: "用脚本生成 JS/Python 后执行报语法错（Unexpected token / unterminated / invalid character）",
    cause: "生成代码时的转义或插入位置出错：引号被写成字面量、代码被插进多行语句中间、缩进错",
    fix: [
      "生成后先做语法检查再执行：node --check <file>；Python 用 compile(open(f).read(), f, 'exec')",
      "不要用正则往 import 块或多行语句中间插代码（真实踩过：插进 import { … } 里）",
      "引号层级要统一：外层单引号或 raw string，避免 \\\" 变成字面量",
    ],
    triggers: ["语法错", "SyntaxError", "转义", "node --check", "生成代码"],
  },
  {
    id: "unknown-tool", prefix: "unknown-tool", label: "工具未注册",
    codes: ["UNKNOWN_TOOL"],
    test: /unknown tool|not registered|is not a tool/i,
    when: "调用了一个不存在的工具名（UNKNOWN_TOOL）",
    cause: "工具名臆造，或插件根本没被宿主加载（后者见 dsh-plugin-host-compat）",
    fix: [
      "工具名必须与注册列表完全一致；先查可用工具列表（或 meta_status）再调用",
      "若整个插件都不见了（不只是名字错），查宿主是否因版本不兼容**静默跳过**了它",
    ],
    triggers: ["工具不存在", "未注册工具", "unknown tool"],
  },
  {
    id: "output-schema", prefix: "output-schema", label: "输出不符合 schema",
    codes: ["TOOL_OUTPUT_ERROR"],
    test: /additionalProperties|not a declared property|invalid output|output.*schema|violation/i,
    when: "工具返回值不符合声明的 output.schema（多了字段/类型不对）",
    cause: "返回结构自由发挥，或用了未声明的字段名",
    fix: [
      "严格按 output.schema 的字段名与类型返回，不要附加未声明字段",
      "schema 里写 additionalProperties:false 时，多一个字段就整条失败",
    ],
    triggers: ["schema", "输出格式", "output", "additionalProperties"],
  },
  {
    id: "timeout", label: "超时",
    test: /timed out|timeout|超时/i,
    when: "调用超时（timed out / timeout）",
    cause: "任务比预期慢，或默认超时太短",
    fix: ["给长任务加超时参数，或改后台运行并轮询结果", "先确认是'慢'还是'卡死'（有无心跳/日志增长）"],
    triggers: ["超时", "timeout", "timed out"],
  },
  {
    id: "path-missing", label: "路径不存在",
    test: /no such file|cannot find|not found|ENOENT|系统找不到|不存在/i,
    when: "读写文件报 No such file / Cannot find / 系统找不到指定的文件",
    cause: "路径不存在：拼写、分隔符（\\ 与 /）、相对路径的工作目录不一致",
    fix: ["用绝对路径；写之前先确认父目录存在", "同一 shell 会话内先校验存在性再做操作（不要跨会话假设）"],
    triggers: ["路径", "不存在", "ENOENT", "no such file"],
  },
  {
    id: "encoding", label: "编码问题",
    test: /UnicodeDecodeError|UnicodeEncodeError|codec can't|mojibake|gbk/i,
    when: "脚本报 UnicodeDecodeError / 输出乱码（Windows 控制台常见）",
    cause: "默认编码不是 UTF-8（Windows 控制台 GBK），或文件没有按 UTF-8 读写",
    fix: [
      "读写一律显式指定 encoding='utf-8'；需要时设 PYTHONIOENCODING=utf-8",
      "不要把非 ASCII 结果靠 print 传递——写进文件再用 read 工具看（本机真实验证过）",
    ],
    triggers: ["编码", "乱码", "UnicodeDecodeError", "GBK"],
  },
  {
    id: "args-invalid", label: "参数不合法",
    test: /missing required|required option|invalid type|expected .*but/i,
    when: "调用报缺少必填参数 / 类型不符（missing required、invalid type）",
    cause: "参数名或类型与工具声明不符",
    fix: ["对照工具的参数声明逐项检查（必填、类型、枚举值）", "把参数写全再调用，不要靠默认值猜"],
    triggers: ["参数", "必填", "missing required", "invalid type"],
  },
  {
    id: "misc", label: "未归类",
    test: /[\s\S]*/, // 兜底：永远匹配
    when: "上面所有模式都没匹配上时的兜底条目",
    cause: "未匹配到已知模式——**这条只记录症状，不含诊断**",
    fix: [
      "错误消息里若自带修复提示，优先采纳",
      "做一次最小复现再判断（把失败缩到一条命令/一个文件）",
      "定位到根因后，把这条升级成一条带「根因 + 对策」的模式（或补进 ERROR_PATTERNS）",
    ],
    triggers: ["未归类"],
  },
];

/** 从错误文本里抽少量有区分度的英文关键词（用于触发词，帮助将来被检索命中） */
function keywordsOf(msg) {
  const stop = new Set([
    "error", "failed", "failure", "cannot", "could", "would", "should", "with", "from", "this", "that",
    "retry", "please", "file", "files", "path", "code", "type", "value", "true", "false", "null",
  ]);
  const seen = [];
  for (const t of String(msg).match(/[A-Za-z][A-Za-z0-9_.-]{3,}/g) || []) {
    const w = t.toLowerCase().replace(/[.]+$/, "");
    if (stop.has(w) || seen.includes(w)) continue;
    seen.push(w);
    if (seen.length >= 4) break;
  }
  return seen;
}

function build(tool, msg, p) {
  const th = hash(tool);
  const id = p.prefix === "unknown-tool" ? `learn-unknown-tool-${th}`
    : p.prefix === "output-schema" ? `learn-output-schema-${th}`
    : p.prefix === "collab" ? `learn-collab-${th}-${hash(p.id)}`
    : `learn-${th}-${hash(p.id)}`;
  const triggers = [...new Set([tool, p.label, ...(p.triggers || []), ...keywordsOf(msg)])].slice(0, 10);
  const body = [
    "## 症状",
    `- 调用 \`${tool}\` 失败：${msg}`,
    "",
    "## 根因",
    `- ${p.cause}`,
    "",
    "## 对策",
    ...p.fix.map((f) => `- ${f}`),
  ].join("\n");
  return { id, tool, title: `[${p.label}] 调用「${tool}」失败`, when: p.when, triggers, body };
}

/**
 * @param exec  冻结的 ToolExecution（exec.name / exec.arguments / exec.agent）
 * @param result 冻结的 ToolExecutionResult（result.isError / result.error）
 * @returns SKILL 对象 { id, tool, title, when, triggers[], body } 或 null
 */
export function reflect(exec, result) {
  const tool = (exec && exec.name) || "unknown";
  const err = (result && result.error) || {};
  const code = (err.info && err.info.code) || "";
  const msg = (err.message || "").replace(/\s+/g, " ").trim().slice(0, 160);

  if (!msg && !code) return null;
  // ⓪ 负向清单命中 → 不反思不沉淀（环境噪音直接丢弃）
  if (NEGATIVE_PATTERNS.some((p) => p.test(msg))) return null;

  // v0.6.0：按错误模式表分类（先按 code 精确匹配，再按消息正则；misc 兜底在表尾）
  const byCode = ERROR_PATTERNS.find((p) => p.codes && code && p.codes.includes(code));
  const byMsg = ERROR_PATTERNS.find((p) => p.id !== "misc" && p.test.test(msg));
  return build(tool, msg || `(${code})`, byCode || byMsg || ERROR_PATTERNS[ERROR_PATTERNS.length - 1]);
}
