# dsh-tool-meta · 自进化元认知引擎

> 观测 agent 的工具调用失败 → 反思 → **自动沉淀成 SKILL** → 下次会话自动带上（滋养）。
> 全链路跑在 DSH 官方接口上：`tools/result` 事件 + SKILL 文件系统，**零私有格式**。

[![verify](https://img.shields.io/badge/verify-META__VERIFY__OK-brightgreen)](#二验证) [![unit](https://img.shields.io/badge/unit%20tests-35%2F35-brightgreen)](tests/unit.mjs) [![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

## 一句话

agent 每次"翻车"（工具调用失败）达到阈值（同签名连续 2 次）才会被记录、反思成方法论，写成
`~/.dsh/skills/<id>/SKILL.md`（单级布局，官方 skill-filesystem 自动发现）——**下次自动用上**；
环境性失败（缺凭据 / 沙箱策略拒绝等）**永不沉淀**。可演示：**翻车 → 学习 → 不再翻车**。

## 闭环（官方 seam 全映射）

| 算子 | 含义 | 官方 seam | 本插件实现 |
|---|---|---|---|
| **变异** | 失败产生新个体 | `tools/result`（emit，冻结终态） | `reflector.js` 规则模板分类 → 生成教训 |
| **选择** | 按效果保留 | 效果账本 | `trials`（复发）/`successes`（被复用后验证） |
| **遗传** | 传给下一代 | `manifest.json` + 检索 | 能力盘 + `meta_search` 关键词检索 |
| **繁殖** | 下一代自动获得 | skill-filesystem 自动发现 | 无需任何代码（官方机制） |
| **整理** | 经验别越攒越碎 | `meta_compact`：错误类归一 + 合并归档（可恢复） |
| **闸门** | 拦住"成功但错误"的动作 | `ctx.tools.guard`（pre-execute 单调守卫） | 不可逆操作（删除）执行前强制声明；通配符/受保护路径一律拒绝 |

四个算子全部实现。工具面：`meta_status`（进度 + 账本）、`meta_search`（检索教训）、`meta_nourish`（开工前继承经验）、`meta_claim`（写入域声明，CAS 防互踩）、`meta_board`（看板）、`meta_prepare`（**高危动作声明**——不可逆操作执行前必须先声明目标与备份证据）、`meta_compact`（**能力盘去碎片化**——合并同工具同错误类的重复教训）。

## 一、零依赖验证（推荐先跑这个）

```bash
git clone <this-repo> && cd dsh-tool-meta
node tests/unit.mjs        # 期望 UNIT_OK（20/20）
```

`tests/unit.mjs` **只用 Node 内置模块**，不依赖 DSH，任何干净环境都能跑（35 项）。它断言的是本项目的**治理承诺**：

- 负向清单：缺凭据 / 沙箱拒绝 / 命令不存在 → **不沉淀**
- 分类：UNKNOWN_TOOL / TOOL_OUTPUT_ERROR / 协作冲突 / 通用兜底
- 错误文本截断 ≤160 字符（只存失败特征，不存用户内容）
- 单级布局 `<root>/<id>/SKILL.md`、去重（复发 `trials+1`）、账本（`successes` 累加）
- 审计流水 `.audit/ledger.jsonl`（`precipitate`/`recur`/`verify`/`archive`/`restore` + UTC 时间戳 + `ledger_tag`）
- **归档而非删除**（可恢复）、`pinned` 技能拒绝归档
- **高危动作闸门**：通配符删除一律拒绝；受保护路径（能力盘/审计流水）拒绝；显式删除需先声明目标；代码型批量删除需声明 `scope + 预期条数 + 备份哈希`；`META_GATE=off` 可整体关闭

## 二、验证

```bash
node verify_plugin.mjs     # 期望 META_VERIFY_OK（全链路：5 工具注册 + 阈值 + 账本 + 归档 + manifest）
```

**依赖说明（干净环境必读）**：唯一外部依赖是 peerDependency `@deepseek-ai/dsh-tools`（`dependencies` 为空）。
在 DSH profile 内 link 安装后（见"安装"）依赖可解析，直接跑即可；独立复现需让本目录能解析它，例如：

```bash
# Windows（PowerShell）
New-Item -ItemType Junction -Path node_modules -Target "<DSH 安装根>\node_modules"
# 或 pnpm/npm link @deepseek-ai/dsh-tools
```
**未做此准备时报 `ERR_MODULE_NOT_FOUND` 属预期，不是插件缺陷。**

## 三、安装（link 进 DSH profile）

在 `~/.dsh/profiles/web/package.json` 中加入：

```json
"@sunwindy/dsh-tool-meta": "link:<本包绝对路径>"
```
并在 bundles 注册（本包自带 `cordis.patch.yml`，会把自身插入为一个插件层），然后 `pnpm install` 并重启 DSH。
`package.json` 的 `dsh.bundle.patch` 字段已指向该 patch 文件，无需额外配置。

## 四、环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `META_SKILLS_DIR` | `~/.dsh/skills` | SKILL 根目录（测试/换机用） |
| `META_FAIL_THRESHOLD` | `2` | 沉淀阈值：新教训需同签名连续失败 N 次才入库 |
| `META_LEDGER_TAG` | `default` | 账本命名空间，写入 audit / frontmatter / manifest |

## 五、实测观测数据（自我观测）

本插件从第一天起就在观测自己：`data/snapshots.jsonl` 是**每日本机快照的原始流水**（13 次，2026-08-30 → 2026-09-12），
`tools/observe.mjs` 是可复现的采集脚本，`data/runs.log` 记录 `prev_gap_h`（**跳跑也会留痕**）。

| 日期 | SKILL 数 | trials | successes |
|---|---|---|---|
| 2026-08-30 | 9 | 4 | 14 |
| 2026-09-02 | 10 | 4 | 35 |
| 2026-09-03 → 09-09 | 10 | 4 | 68（**五天平线**） |
| 2026-09-11 | 11 | 8 | 370 |
| 2026-09-12 | 15 | 17 | 467 |

**我不会把这张表读成"能力提升"**：n=13、单机、无对照组；五天平线既可能是"学习起效后不再翻车"，
也可能是"那几天没走到会触发的路径"——**两者无法区分**。完整的数据缺陷（早期 schema 缺字段、
`successes/trials` 不是成功率、4 天跳跑）与结论边界写在 [`docs/observation.md`](docs/observation.md)。

## 五点五、高危动作闸门（v0.4 新增）

**为什么加**：本插件原本只从 `tools/result` 的**失败**中学习。但有一类错误**没有失败信号**——
工具调用**成功了，决策却错了**：用通配符批量删除、超出计划范围地清理、误删不该删的目录。事后反思学不到它们，
只能靠**执行前的硬闸门**。

**怎么拦**（用官方 `ctx.tools.guard`，同步且单调拒绝——注册后没有任何监听器能翻案）：

| 情形 | 行为 |
|---|---|
| 通配符删除（`rm -rf dir/*`） | **一律拒绝**（任何声明都不放行——"显式列举"就是闸门的意义） |
| 受保护路径（能力盘 `.dsh/skills`、审计流水） | **一律拒绝** |
| 显式删除但未声明 | 拒绝，并指出该调用 `meta_prepare` 声明什么 |
| 已声明且覆盖全部目标 | 放行，并把声明写入审计流水（`gate:allow`） |
| 代码型批量删除（`os.remove` / `rmSync` 等运行时算目标） | 必须声明 `scope + expected_count + backup_hash` 三者 |
| **内容型工具**（write / edit / apply_patch…） | **不检查**——它们的参数是文本，可以合法地讨论删除命令（v0.4.1 修复；可用 `META_GATE_SKIP_TOOLS` 追加自己的内容型工具） |
| 普通读写调用 | 不干预（闸门太吵就会被关掉，等于没有） |

**开关与参数**：`META_GATE=off` 关闭闸门；`META_GATE_TTL_MIN` 声明有效期（默认 30 分钟）。
**审计**：新增 `gate:prepare` / `gate:allow` / `gate:deny` 三类事件，落在同一份 `.audit/ledger.jsonl`。

**诚实边界**（不吹成保险箱）：闸门能拦住**字面通配符/递归强制删除**与**未声明的删除**，
但**拦不住精心构造的绕过**（例如把目标藏在运行时计算里、或分多步化整为零）。
它的价值是"**让不可逆动作必须留下可审计的声明**"，而不是"保证万无一失"。这条边界写在 `docs/design.md`。

## 六、文档

- [`docs/design.md`](docs/design.md) — 四个算子的设计、数据流、单级布局的代价、**明确的 Non-goals 与已知局限**
- [`docs/governance.md`](docs/governance.md) — 写入闸门 / 可追溯 / 归档不删 / CAS 并发 / 隐私边界（每条都对应可跑断言）
- [`docs/observation.md`](docs/observation.md) — 13 次快照的如实转录 + **三个必须一起读的数据缺陷**

## 七、与生态的差异

"自进化/记忆"是热门方向，常见做法是自建一套记忆格式与检索。本项目的取舍不同：
**只跑官方接口，产物是标准 SKILL 文件**——因此可被官方发现机制直接滋养、可被 `git diff` 审计、可被删除即失效。
代价写在 `docs/design.md` 的局限里（只在失败时学习、规则模板泛化上限、阈值无实验依据）。

## License

MIT
