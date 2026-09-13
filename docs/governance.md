# 治理：让"会自动写文件的东西"可控

> 一个会自动往磁盘写东西的插件，必须先回答"它凭什么写、写错了怎么办、谁改的"。
> 本文是这四个问题的答案，也都是**代码里真实生效**的约束（每条都对应可跑的断言或可查的文件）。

## 一、写入闸门：不是所有失败都值得学

| 闸门 | 规则 | 代码位置 |
|---|---|---|
| **负向清单** | 命中 `MISSING_CREDENTIAL` / `no API key` / `not configured` / `command not found` / `sandbox` 的失败**永不沉淀** | `lib/reflector.js` `NEGATIVE_PATTERNS` |
| **沉淀阈值** | 同签名失败需**连续 N 次**（默认 2，`META_FAIL_THRESHOLD` 可调）才入库；单次失败只计数不落盘 | `lib/index.js` |
| **签名去重** | 同 `工具 + 错误签名` 只产生一条教训；再遇到只做 `trials+1` | `lib/reflector.js` hash + `lib/skillwriter.js` |
| **长度截断** | 错误文本截断到 160 字符再入签名——**不保存用户消息全文**，只保存失败特征 | `lib/reflector.js` |

理由：环境性失败（缺 key、被沙箱拒绝）学不到任何方法论，只会把能力盘变成噪音堆。

## 二、可追溯：每条教训都能回答"谁在几点改的"

| 机制 | 实现 |
|---|---|
| **溯源标记** | frontmatter 写 `created_by: agent`（区分人工写的技能） |
| **时间戳** | `created_at`（日期）+ `updated_at`（ISO 毫秒，每次账本变更刷新） |
| **账本命名空间** | `ledger_tag`（`META_LEDGER_TAG`，默认 `default`）——每套模式一个 tag，写进 frontmatter / audit / manifest |
| **审计流水** | `<root>/.audit/ledger.jsonl` append-only，记录五类操作：`precipitate` / `recur` / `verify` / `archive` / `restore`，每条带 UTC ISO 时间戳 |

审计流水是**只追加**的：任何"这条教训什么时候被谁归档过"都能逐事件追问，而不是只看最终状态。

## 三、归档而非删除：给错误留退路

| 操作 | 行为 |
|---|---|
| `archiveSkill(id)` | 移到 `<root>/.archive/<id>/`，**不再出现在活动库/检索/账本**，但文件仍在，可恢复 |
| `restoreSkill(id)` | 从 `.archive/` 移回活动库 |
| `pinned: true` | 被标记的技能**拒绝归档**（防止误操作掉关键教训） |

原则：自动化系统有权"停用"自己的产物，但**不该有不可逆的删除权**。

## 四、并发：两个 agent 同时写怎么办

`meta_claim` / `meta_board` 用 **CAS（compare-and-swap）** 语义声明写入域：登记"谁在改哪个路径 + revision 版本"，
重叠声明会被拒绝并交给使用者裁定，而不是静默互相覆盖。配套的协作教训（`learn-collab-*`）会教后续 agent
"read-before-edit / disjoint scopes"。

## 五、隐私边界（明确写死）

- 插件**只保存失败特征**：工具名 + 错误码 + 截断后的错误文本（≤160 字符）+ 时间戳。
- **不保存**：用户消息、简历/文档内容、文件内容、凭据值。
- 落盘位置只在 `<META_SKILLS_DIR | ~/.dsh/skills>`，**不联网、不外发**。
- 失败文本里若恰好含路径/密钥形状的片段，也只会作为"签名"参与去重，不会出现在任何网络请求里（本插件没有任何网络代码）。

## 六、这份治理怎么被验证

```bash
node tests/unit.mjs        # 零依赖：反射分类 / 负向清单 / 去重 / 账本 / 审计 / 归档恢复 / pinned
node verify_plugin.mjs     # 全链路（需能解析 @deepseek-ai/dsh-tools，见 README）
```

`tests/unit.mjs` 专门设计为**干净环境可跑**（只用 Node 内置模块），因此这些治理约束不是文档承诺，而是 CI 每次都会执行的断言。
