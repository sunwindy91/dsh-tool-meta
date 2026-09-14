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

/**
 * @param exec  冻结的 ToolExecution（exec.name / exec.arguments / exec.agent）
 * @param result 冻结的 ToolExecutionResult（result.isError / result.error）
 * @returns SKILL 对象 { id, title, triggers[], body } 或 null
 */
export function reflect(exec, result) {
  const tool = (exec && exec.name) || "unknown";
  const err = (result && result.error) || {};
  const code = (err.info && err.info.code) || "";
  const msg = (err.message || "").replace(/\s+/g, " ").trim().slice(0, 160);

  // ⓪ 负向清单命中 → 不反思不沉淀（环境噪音直接丢弃）
  if (NEGATIVE_PATTERNS.some((p) => p.test(msg))) return null;

  // ① 未注册工具：教 agent 用正确工具名（最常见的"翻车"）
  if (code === "UNKNOWN_TOOL" || /unknown tool|not registered|is not a tool/i.test(msg)) {
    return {
      id: `learn-unknown-tool-${hash(tool)}`,
      tool,
      title: `「${tool}」未注册（UNKNOWN_TOOL）`,
      triggers: [tool, "工具不存在", "未注册工具", "unknown tool"],
      body: `- DSH 工具名必须与注册列表完全一致，不能臆造。\n- 若 \`${tool}\` 不被识别，先查可用工具列表（或 \`meta_status\`）确认正确名称，再重新调用。\n- 失败信息：${msg}`,
    };
  }
  // ② 输出不符合 schema：教 agent 遵守 output.schema
  if (code === "TOOL_OUTPUT_ERROR" || /output.*schema|violation/i.test(msg)) {
    return {
      id: `learn-output-schema-${hash(tool)}`,
      tool,
      title: `「${tool}」返回不符合 output.schema`,
      triggers: [tool, "schema", "输出格式", "output"],
      body: `- 工具返回值必须符合其声明的 output.schema（字段名/类型/必填）。\n- 修正返回结构，不要自由发挥字段。\n- 失败信息：${msg}`,
    };
  }
  // ②.5 协作冲突：并发写文件失败 → 学"怎么协作"（组织学习：从冲突提炼协作协议）
  if (/FS_STALE_VERSION|stale version|concurrent|conflict|read.?before.?edit/i.test(msg)) {
    return {
      id: `learn-collab-${hash(tool)}-${hash(msg)}`,
      tool,
      title: `协作冲突：并发/版本冲突（学怎么协作）`,
      triggers: [tool, "冲突", "并发", "stale", "版本", "协作", "disjoint"],
      body: `- 并行写文件前先 read 最新版本（read-before-edit），不要基于陈旧版本写入。\n- 协作原则：多 agent 并行先划 disjoint scopes（互不重叠的写入域）；共享文件由单一 owner 写；冲突交给用户 review 而不是静默覆盖。\n- 失败信息：${msg}`,
    };
  }
  // ③ 通用失败：记录错误模式（按 tool+message 签名去重）
  if (msg) {
    return {
      id: `learn-${hash(tool)}-${hash(errorClass(msg, code))}`, // 按"错误类"而非完整消息去重（v0.4.2）
      tool,
      title: `调用「${tool}」失败`,
      triggers: [tool, "失败", "报错"],
      body: `- 调用 \`${tool}\` 曾失败：${msg}\n- 先检查参数是否齐全/类型正确；再确认依赖（桥接/后端/key）就绪；错误消息里的修复提示优先采纳。`,
    };
  }
  return null;
}
