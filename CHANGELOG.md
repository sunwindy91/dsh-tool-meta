# Changelog

本项目遵循语义化版本。所有条目都是**真实发生过的改动**（含被自己的测试抓住的 bug）。

## 0.6.3 — 2026-10-10

### Fixed（覆盖洞：闸门看不见 GraphQL mutation）
- **新增 `gh api graphql` 的 mutation 检测**。真实来源：当天两次**公开发布**（在讨论区发评论、编辑已发布正文）
  都是通过 GraphQL mutation 完成的，而对外信号表不匹配 `gh api graphql` → **闸门完全没有评估**，
  声明也因此未被消费（已补记为作废并注明原因）。
  精确性要求：**只拦 mutation，不拦 query** —— 只读查询几乎每天在用，若一并拦会造成
  "每次查询都要声明"的摩擦，而那正是闸门被卸载的路径。做法：把 `@文件` 参数读进来一起判断。

### Verification
- `node tests/unit.mjs` → **92/92 通过**（新增 3 条：@文件 mutation 拦、@文件 query 不拦、内联 mutation 拦）

## 0.6.2 — 2026-10-10

### Fixed
- **检测前剥掉引号里的内容**。第 5 次同族误报：一条提交信息在 `-m "…"` 里**描述**了刚刚完成的一次公开评审评论，
  被判成"要发表评论"而整条命令被拒。引号里是**数据**（提交信息、`--body` 正文、说明文字），不是要执行的命令。
  修法：包裹层剥离之后、信号匹配之前，去掉成对引号串；真实动作仍被拦（已加正反两向断言），
  `pwsh -c "…"` 这类包裹层也仍能识别。

### Verification
- `node tests/unit.mjs` → **89/89 通过**

## 0.6.1 — 2026-10-10

### Fixed
- **对外声明的 target 改为 token 匹配**。真实缺陷：声明 `target:"a2aproject/A2A#2250"` 而命令是
  `gh issue comment 2250 -R a2aproject/A2A` —— 归一化成连续串后互不包含（token 顺序不同）→ **被拒**，
  而人一眼认为这是同一次动作。这正是"机制正确但摩擦过大"的误报，会把人推向关掉闸门。
  修法：target 与命令都切 token（长度≥2 的字母数字/汉字串），要求 target 的每个 token 都出现在命令里；
  保留原连续匹配作为快路径。反向用例（无关声明）仍必须被拒，已加断言。

### Verification
- `node tests/unit.mjs` → **86/86 通过**

## 0.6.0 — 2026-10-10

### Changed（沉淀质量：从「症状 + 套话」到「症状 → 根因 → 对策」）

- **新增错误模式表**（`lib/reflector.js` 的 `ERROR_PATTERNS`，11 条模式）：每条模式给出
  **何时看 / 症状 / 根因 / 对策 / 触发词**。规矩：**一条模式必须能指向一次真实事故**，
  找不到对应事故的模式不加（避免正则无限增长）。
- **id 改为「工具 + 错误类」**：`learn-<toolhash>-<classid>`。同一类失败**只占一条**，再遇到走 recur。
  这是治「实测 edit 类攒了 10 条同质条目、模型分不出该看哪条」的关键改动。
- **描述改为「标题。何时看：…。Triggers: …」**，并做消毒（引号→单引号、换行压空格），
  让将来读到它的模型能判断「什么时候该看这一条」。
- 真实事故覆盖：并发写冲突（read-before-edit）· 代理配置失效（via 127.0.0.1）· 网络不可达 ·
  生成代码语法错（引号/插入位置）· 未注册工具 · schema 不符 · 超时 · 路径不存在 · 编码 · 参数不合法。
- 未归类条目**诚实标注**「不含诊断」，并给出升级路径（定位到根因后补进模式表）。

- **修 frontmatter 缩进 bug（潜在脏数据）**：`description:` 那行被缩进了 4 个空格，而它的兄弟键在第 0 列
  → YAML 把它当成 `name` 的多行续行：`parseSkillMeta` 读回的 `title` 变成 id、`triggers` 变成空数组（**检索直接失效**），
  DSH 侧解析出的技能名也不再符合命名正则。
  已修的当时，现存 22 条能力盘文件抽样全部干净（**尚未污染真实数据**），并新增两条断言：
  ① frontmatter 每个键必须在第 0 列；② `parseSkillMeta` 必须能读回 title 与 triggers。
- **`skillsDir()` 改为每次调用读取**（此前 `BASE` 在模块加载时固化 → 运行中改 `META_SKILLS_DIR` 无效，
  单测也无法把写入隔离到临时目录）。与闸门 v0.5.3 修的是同一族缺陷。

### Verification
- `node tests/unit.mjs` → **83/83 通过**（新增 8 条：四类真实事故归类、同类同 id、异类异 id、未归类诚实、描述含何时看且无残留引号）

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
