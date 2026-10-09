# Changelog

本项目遵循语义化版本。所有条目都是**真实发生过的改动**（含被自己的测试抓住的 bug）。

## 0.5.5 — 2026-10-09

### Fixed（真实事故：插件被宿主**静默跳过**）

- **放宽 peer 区间**：`^0.1.5-rc.2` → `>=0.1.5-rc.2 <1.0.0`。

  事故经过：09-18 为了让声明看起来更"规范"，把 `peerDependencies` 从 `*` 收紧成 `^0.1.5-rc.2`；
  宿主（DSH）随后升级到 **0.2.0-rc.2**，该区间不再满足 → DSH 输出
  `skipping profile bundle "@sunwindy/dsh-tool-meta": Plugin … is incompatible` → **整个插件不加载**，
  没有闸门、没有观测、没有工具，而且**没有任何面向用户的提示**（只有 `dsh --profile web --dump-config`
  或启动日志里能看到）。

  **教训**：对一个"要被别人安装"的插件，收紧兼容区间 = 在下一次宿主升级时把自己静默下架。
  宁可区间宽、失败大声，也不要区间紧、失败无声。

## 0.5.4 — 2026-10-09

### Fixed（真实漏判：闸门放过了一次真实的对外推送）

- **赋值前缀不再是绕过路径**：`$o = git push origin main` / `OUT=$(git push …)` / `FOO=1 git push …`
  此前因"该段不以命令词开头"而未被识别。
  来源：作者本人的一次真实推送就是**因为漏判**通过的（审计流水里没有 gate:allow，声明也未被消费）
  —— 也就是说，那次"成功"不是治理生效，而是**闸门没看见**。
- 新增 3 条回归：赋值前缀必须被识别；中文/说明性文字里的赋值语句不误报。

### Verification
- `node tests/unit.mjs` → **73/73 通过**

## 0.5.3 — 2026-10-09

### Fixed（两个结构缺陷：都是"闸门要求声明，却给不出可达出路"）

- **声明路径不再只依赖工具**：新增**文件式声明** `<skills_root>/.audit/declarations.jsonl`。
  起因：闸门拒绝了作者的推送并要求先调 `meta_prepare`，但该工具**不在当次会话的工具列表里**
  （工具列表是会话开始时的快照，而插件代码会热重载）→ 声明途径不可达。
  现在任何 agent 都能往文件里追加一行 JSON 完成声明；消费时追加 `consumed` 标记（一次性语义不变）。
- **逃生阀改成每次判定时读取**：此前 `META_GATE` / `META_GATE_OUTWARD` 在 `createGate()` 时被固化，
  运行中改动无效（唯一出路失效）。现在每次 `evaluate()` 重新读环境变量，
  并新增**哨兵文件** `<skills_root>/.audit/gate.off` 与 `.audit/gate.outward.off`（创建即生效，5 秒内可关）。
- 拒绝文案补上**两条可达出路**（文件式声明 / 哨兵或环境变量），不再只指向不可达的工具。

### Verification
- `node tests/unit.mjs` → **70/70 通过**（新增 7 条：文件式声明放行与一次性、缺 precondition 仍拒、
  哨兵生效、环境变量"创建后再设置"也生效、文件式删除声明、整闸门哨兵、拒绝文案含可达出路）

## 0.5.2 — 2026-09-22

### Fixed
- **插件日志不再写 stdout**（9 处 `console.log` → stderr，`META_LOG=off` 可静音）。

  核验依据：headless 入口的契约是 "stream reasoning to stderr, **print the final assistant message**"，
  即 stdout 是**结果通道**。实测 `dsh --profile headless --help` 的 stdout 里混入了其他插件的
  apply 日志（`[imagegen] apply called` 等），调用方无法区分日志与结果。本插件不制造这个问题。
- 新增**可执行的规矩断言**：`lib/` 下不得出现 `console.log`（写进单测，防止回退）。

## 0.5.0 — 2026-09-18

### Added
- **对外不可逆动作闸门**（v0.5）：`git push` / 公开评论 / 发 issue / 发布，未声明即拒绝；
  声明需 `action:'publish'` + `target` + **`precondition`（必填：你核验了什么）**；强制推送一律拒绝；
  只读命令不干预；`META_GATE_OUTWARD=off` 可单独关闭。
- `docs/known-evasions.md`：**主动列出闸门拦不住的 7 类删除方式与 2 类误判**，并声明它是"流程闸门，不是安全边界"。
- `docs/stability-and-impact.md`：定义"什么时候算完工"（四条稳定判据 + 三条停止线）与"如何界定母体收益"。

### Fixed
- **闸门作用域**（v0.4.1）：内容型工具（write/edit）不再被检查——此前"一份讨论删除的文档"会被误拦。
- **闸门只在命令位判定**（v0.4.5）：读/搜/打印类命令的参数视为文本；执行器（python/node/pwsh）递归解析其内部命令。
- **账本可复现**（v0.4.4）：成功加分不再依赖目录顺序（抽为纯函数 `lib/selector.js`），审计标注 `scope: tool-level`。
- **声明一次性**（v0.4.4）：声明放行一次即失效（此前可在 TTL 内无限复用）。

### Changed
- 去碎片化（v0.4.2/v0.4.3）：错误类归一 + `meta_compact`；真实能力盘实测 17 → 13 条；
  且暴露语义 bug（同类失败 ≠ 同类建议）→ 只合并通用型教训。

### Verification
- `node tests/unit.mjs` → **58/58 通过**（零依赖）
- `node verify_plugin.mjs` → `META_VERIFY_OK`

## 0.4.0 及更早

见 git 历史与 `docs/design.md`（含每次变更是哪次真实事故促成的）。
