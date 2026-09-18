// 自进化元认知引擎（MVP）：观测 tools/result 失败 → 反思 → 自动沉淀 SKILL → 滋养后续 agent。
// 闭环完全跑在 DSH 官方 seam 上（tools/result 事件 + SKILL 文件系统），零私有格式。
// 可演示：翻车 → 学习 → 不再翻车。
import { defineTool } from "@deepseek-ai/dsh-tools";
import { reflect } from "./reflector.js";
import {
  writeSkill,
  updateSkill,
  countSkills,
  skillsDir,
  listSkills,
  searchSkills,
  compactSkills,
  audit,
} from "./skillwriter.js";
import { board } from "./board.js";
import { createGate } from "./gate.js";
import { pickRepresentative } from "./selector.js";

export const name = "tool-meta";
export const inject = ["tools"];

const observers = []; // 供 verify 注入模拟事件

// 沉淀阈值（治理）：新教训需同签名失败连续 N 次才沉淀（滤掉偶发/环境性噪音）；
// 已存在的教训每次再遇都 trial+1（复发是已验证信号，不受阈值限制）。
// N 可用环境变量 META_FAIL_THRESHOLD 覆盖，默认 2。
const FAIL_THRESHOLD = Math.max(1, parseInt(process.env.META_FAIL_THRESHOLD || "2", 10) || 2);
const failCounts = new Map(); // skillId -> { tool, count }（连续失败计数）

// 高危动作闸门（不可逆操作的"执行前"硬闸门）：与"事后反思"互补——
//   事后反思（observe/reflect）覆盖"工具调用**失败**"；
//   闸门覆盖"工具调用**成功**但决策错误"（如通配符批量删除、误删受保护路径）——这类错误没有失败信号。
const gate = createGate({ audit });

function observe(exec, result) {
  if (!exec || !result) return;
  try {
    const tool = exec.name || "";
    if (result.isError === true) {
      // 失败 = 变异/再遇：新教训达阈值才沉淀（trials:0），已有教训 trial+1
      const skill = reflect(exec, result);
      if (!skill) return;
      const id = skill.id;
      const rec = failCounts.get(id) || { tool, count: 0 };
      const count = rec.count + 1;
      const already = listSkills().some((s) => s.id === id);
      if (!already && count < FAIL_THRESHOLD) {
        failCounts.set(id, { tool, count });
        console.log(`[tool-meta] 失败 #${count}/${FAIL_THRESHOLD}（未达阈值，暂不沉淀）: ${id}`);
        return;
      }
      failCounts.set(id, { tool, count: 0 }); // 沉淀后清零，重新计数
      const res = writeSkill(skill);
      console.log(`[tool-meta] 教训 ${res.written ? "新增" : "复发(trial+1)"}: ${res.file}`);
    } else if (result.isError === false) {
      // 成功 = 选择：中断该工具所有连续失败计数；命中 related_tool 的教训 → success+1（教训被验证有效）
      for (const [id, rec] of failCounts) if (rec.tool === tool) failCounts.delete(id);
      // ⚠️ 局限（v0.4.4 明确写下）：插件拿不到"宿主到底加载了哪条 skill"的记录，
      //    因此 successes 是**工具级验证信号**，不等于"这一条教训被验证"。
      //    要让这个数字可复现，代表教训的选取必须**确定性**：
      //    successes 最高 → trials 最高 → 创建最早（旧实现用 readdir 顺序，等于随机，是缺陷）。
      const cands = listSkills().filter((s) => s.tool === tool && s.id.startsWith("learn-"));
      const pick = pickRepresentative(cands);
      if (pick) {
        updateSkill(pick.id, { successes: +1 });
        audit("verify", { skill_id: pick.id, tool, scope: "tool-level", candidates: cands.length });
        console.log(`[tool-meta] 工具级验证(success+1): ${pick.id}（该工具 ${cands.length} 条候选 · 按账本确定性选取）`);
      }
    }
  } catch (e) {
    console.warn("[tool-meta] 反思/沉淀失败（不阻塞会话）:", e && e.message);
  }
}

export function apply(ctx) {
  console.log("[tool-meta] apply called");
  // ① 观测：tools/result（官方 emit 事件，exec=冻结执行快照，result=冻结结果）
  ctx.on("tools/result", observe);
  observers.push(observe);

  // ①·五 硬闸门：不可逆动作执行前要求"先声明 + 备份证据"（通配符/受保护路径一律拒绝）。
  // 用 DSH 官方 pre-execute 守卫（ctx.tools.guard）：同步、单调拒绝——注册后没有监听器能翻案。
  const guardHost = (ctx.tools && typeof ctx.tools.guard === "function")
    ? ctx.tools
    : (() => {
        const s = typeof ctx.get === "function" ? ctx.get("tools") : null;
        return s && typeof s.guard === "function" ? s : null;
      })();
  if (guardHost) {
    try {
      guardHost.guard((exec) => gate.evaluate(exec));
      console.log(`[tool-meta] 高危动作闸门已注册（pre-execute guard）: ${gate.enabled ? "on" : "off(env META_GATE=off)"}`);
    } catch (e) {
      console.log("[tool-meta] 闸门注册失败（不阻塞）:", e && e.message);
    }
  } else {
    console.log("[tool-meta] 未发现 ctx.tools.guard：闸门未启用（降级为 meta_prepare 约定）");
  }

  // ② 自省工具：meta_status（让 agent 能查"你学到了什么"）
  const statusTool = defineTool({
    name: "meta_status",
    description:
      "查询自进化元认知引擎状态：沉淀的 SKILL 数量/目录/机制。触发词：你学到了什么/你有什么经验/skill/翻车记录",
    parameters: {},
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          skills_dir: { type: "string" },
          count: { type: "integer" },
          learned: {
            type: "array",
            description: "沉淀教训列表（id/trials/successes/rate）",
            items: { type: "object", additionalProperties: true },
          },
          note: { type: "string" },
        },
        additionalProperties: false,
      },
      render(args, value) {
        return [{ type: "text", text: JSON.stringify(value, null, 2) }];
      },
    },
    async execute() {
      const list = listSkills();
      return {
        ok: true,
        skills_dir: skillsDir(),
        count: countSkills(),
        learned: list.map((s) => ({
          id: s.id,
          trials: s.trials,
          successes: s.successes,
          rate: s.rate,
        })),
        note: "演化机器：变异(失败→沉淀SKILL) → 选择(trials/successes账本) → 遗传(能力盘) → 繁殖(下次自动滋养)",
      };
    },
  });
  ctx.inject(["tools"], (t) => {
    if (!t || !t.register) return;
    try {
      t.register(statusTool);
      t.register(searchTool);
      t.register(nourishTool);
      t.register(claimTool);
      t.register(boardTool);
      t.register(prepareTool);
      t.register(compactTool);
    } catch (e) {
      console.log("[tool-meta] register error:", e && e.message);
    }
  });
  const svc = ctx.get("tools");
  if (svc && svc.register) {
    try {
      svc.register(statusTool);
      svc.register(searchTool);
      svc.register(nourishTool);
      svc.register(claimTool);
      svc.register(boardTool);
      svc.register(prepareTool);
      svc.register(compactTool);
    } catch (e) {
      console.log("[tool-meta] direct register error:", e && e.message);
    }
  }
}

// ④ 滋养工具：meta_nourish（"教育与传承"——新任务开工前检索团队经验）
const nourishTool = defineTool({
  name: "meta_nourish",
  description:
    "滋养/传承：输入任务描述或关键词，检索能力盘返回应注入的相关教训（标题/要点/效果账本），让本任务站在团队经验上不重新摸爬。触发词：开工前先看团队经验/继承经验/有什么坑要注意",
  parameters: {
    task: { type: "string", description: "任务描述或关键词（必填），如：写一个语音插件 / 对接 ROS 话题 / 调用 vision_ask" },
  },
  output: {
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        task: { type: "string" },
        lessons: { type: "array", description: "应注入的相关教训（按相关性排序）" },
        note: { type: "string" },
      },
      additionalProperties: false,
    },
    render(args, value) {
      return [{ type: "text", text: JSON.stringify(value, null, 2) }];
    },
  },
  async execute(args) {
    const task = args.task || "";
    const lessons = searchSkills(task).slice(0, 8).map((h) => ({
      id: h.id,
      title: h.title,
      tool: h.tool,
      rate: h.rate,
      trials: h.trials,
      successes: h.successes,
    }));
    return {
      ok: true,
      task,
      lessons,
      note:
        lessons.length
          ? `已从能力盘检索到 ${lessons.length} 条团队经验，开工前建议先采纳（传承，不重新摸爬）`
          : "能力盘暂无相关经验，这是一片新领域（可贡献新教训）",
    };
  },
});

// ③ 能力盘检索工具：meta_search（"文明可查阅"——按关键词检索历史教训）
const searchTool = defineTool({
  name: "meta_search",
  description:
    "检索自进化能力盘（历史教训库）：输入关键词返回相关教训（标题/触发词/效果账本）。触发词：查一下有没有相关经验/以前遇到过吗/这个坑踩过吗",
  parameters: {
    query: { type: "string", description: "检索关键词（必填），如：voice_tts / schema / 导航" },
  },
  output: {
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        query: { type: "string" },
        hits: { type: "array", description: "相关教训（按相关性排序，含效果账本）" },
      },
      additionalProperties: false,
    },
    render(args, value) {
      return [{ type: "text", text: JSON.stringify(value, null, 2) }];
    },
  },
  async execute(args) {
    const q = args.query || "";
    const hits = searchSkills(q).slice(0, 8).map((h) => ({
      id: h.id,
      title: h.title,
      tool: h.tool,
      trials: h.trials,
      successes: h.successes,
      rate: h.rate,
    }));
    return { ok: true, query: q, hits };
  },
});

// ⑦ 治理工具：meta_compact（去碎片化——把同工具同错误类的重复教训合并，原条归档可恢复）
const compactTool = defineTool({
  name: "meta_compact",
  description:
    "整理能力盘：把『同一工具 + 同一错误类』的重复教训合并成一条（账本累加、原条归档可恢复），减少检索稀释。"
    + "触发词：教训太碎/整理能力盘/去重/合并教训/compact",
  parameters: {
    dry_run: { type: "boolean", description: "true=只报告要合并什么，不改动任何文件" },
  },
  output: {
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        groups_scanned: { type: "integer" },
        groups_merged: { type: "integer" },
        archived: { type: "integer" },
        merged: { type: "array", description: "合并明细（tool/canonical/merged_from/账本合计）" },
      },
      additionalProperties: false,
    },
    render(args, value) {
      return [{ type: "text", text: JSON.stringify(value, null, 2) }];
    },
  },
  async execute(args) {
    return compactSkills({ dryRun: args.dry_run === true });
  },
});

// ⑥ 闸门声明工具：meta_prepare（不可逆操作前必须声明：目标清单 + 备份证据 + 预期条数）
const prepareTool = defineTool({
  name: "meta_prepare",
  description:
    "高危动作闸门的声明入口：在执行**不可逆操作（删除）**前声明目标清单与备份证据，闸门才会放行，并把声明写进审计流水。"
    + "显式删除用 targets（禁止通配符）；程序化删除用 scope + expected_count + backup_hash。"
    + "触发词：我要删除/清理/批量移除/先备份再删",
  parameters: {
    action: { type: "string", description: "动作类型：delete（不可逆删除）或 publish（对外不可逆动作）", required: true },
    target: { type: "string", description: "publish 用：目标（如 origin/main、owner/repo#123、要发布的包名）" },
    precondition: { type: "string", description: "publish 用（必填）：你核验了什么前置条件（例：脱敏 0 命中 / 无 open PR）" },
    targets: { type: "array", description: "要删除的完整路径清单（显式列举，禁止通配符）" },
    scope: { type: "string", description: "程序化删除的目录范围（如 Python/Node 循环删除时的根目录）" },
    expected_count: { type: "integer", description: "程序化删除的预期条数（与 scope 配对使用）" },
    backup_source: { type: "string", description: "备份所在位置（目录或文件）" },
    backup_hash: { type: "string", description: "备份的 sha256（用于事后核对备份真实存在且完整）" },
  },
  output: {
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        claim_id: { type: "string" },
        expires_at: { type: "string" },
        note: { type: "string" },
      },
      additionalProperties: false,
    },
    render(args, value) {
      return [{ type: "text", text: JSON.stringify(value, null, 2) }];
    },
  },
  async execute(args) {
    const act = (args.action || "").toLowerCase();
    if (act === "publish") {
      if (!args.target || !args.precondition) {
        return {
          ok: false, claim_id: "", expires_at: "",
          note: "对外动作的声明必须同时给出 target 与 **precondition**（你核验了什么）。"
            + "例：action:'publish', target:'origin/main', precondition:'desensitize_scan 0 命中 + 测试全绿'；"
            + "或 precondition:'gh pr list --search 3915 → 0 个 open PR'。"
            + "—— 这条要求来自真实事故：没核验前置条件就公开认领，被别人的 PR 抢先。",
        };
      }
    } else if (act !== "delete") {
      return { ok: false, claim_id: "", expires_at: "", note: `暂不支持的动作：${args.action || "(空)"}（支持 delete / publish）` };
    }
    const c = gate.prepare(args);
    return {
      ok: true,
      claim_id: c.id,
      expires_at: new Date(c.expiresAt).toISOString(),
      note: `已声明（${c.kind}）：${c.kind === "code" ? `scope=${c.scope} · 预期 ${c.expectedCount} 条` : `目标 ${c.targets.length} 个`}`
        + `；备份 ${c.backupSource || "(未填)"} · ${c.backupHash ? c.backupHash.slice(0, 12) : "(未填)"}`
        + `。声明已写入审计流水（gate:prepare），有效期内放行一次对应删除。`,
    };
  },
});

// ⑤ 协调层工具：meta_claim（声明写入域，CAS 防互踩）+ meta_board（查任务板）
const claimTool = defineTool({
  name: "meta_claim",
  description:
    "声明写入域（disjoint scopes）：写文件/改资源前登记目标路径，防止多 agent 互踩。重叠声明会被冲突拒绝（交用户 review）。触发词：我要改这个文件/声明写入/防冲突",
  parameters: {
    path: { type: "string", description: "要写入的路径/资源（必填），如：src/a.py" },
    owner: { type: "string", description: "声明者（可选，默认取 agent 名）" },
  },
  output: {
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        error: { type: "string" },
        revision: { type: "integer" },
        entry: { type: "object", additionalProperties: true, description: "本次声明条目（成功时）" },
        conflict: { type: "object", additionalProperties: true, description: "重叠声明信息（冲突时）" },
        claims: { type: "json" },
      },
      additionalProperties: false,
    },
    render(args, value) {
      return [{ type: "text", text: JSON.stringify(value, null, 2) }];
    },
  },
  async execute(args) {
    const owner = args.owner || "agent";
    return board.claim(args.path, owner);
  },
});

const boardTool = defineTool({
  name: "meta_board",
  description:
    "查看共享任务板：谁声明了哪些写入域（revision 版本 + 条目），用于多 agent 协调避免互踩。触发词：谁在改什么/任务板/声明了哪些",
  parameters: {},
  output: {
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        revision: { type: "integer" },
        entries: { type: "array" },
      },
      additionalProperties: false,
    },
    render(args, value) {
      return [{ type: "text", text: JSON.stringify(value, null, 2) }];
    },
  },
  async execute() {
    const b = board.list();
    return { ok: true, revision: b.revision, entries: b.entries };
  },
});

// 测试钩子（observers 引用模块顶部的数组）
export const __test = { observe, observers, gate };

