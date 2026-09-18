# Changelog

本项目遵循语义化版本。所有条目都是**真实发生过的改动**（含被自己的测试抓住的 bug）。

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
