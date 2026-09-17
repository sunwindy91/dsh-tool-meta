# dsh-tool-meta

**A self-evolving metacognitive engine for [DSH](https://github.com/deepseek-ai/deepseek-harness) — it learns from its own tool failures, governs what it learns, and gates irreversible actions before they run.**

[中文主文档](README.md) · [Design notes](docs/design.md) · [Governance](docs/governance.md) · [Observation data](docs/observation.md) · [Unit tests (50/50)](tests/unit.mjs)

---

## Why this exists

Agents forget. A session ends, the context is compacted away, and the same mistake is made again next week — by the same agent, on the same machine.

This plugin takes a different position: **treat every tool failure as a teachable event, write the lesson to disk in a format the host already understands, and let the next agent inherit it for free.** No fine-tuning, no external database, no private format — it runs entirely on official seams: the `tools/result` event and the `skill-filesystem` (a directory of `SKILL.md` files that DSH discovers automatically).

Then, after using it in production, one more thing became obvious — and it turned out to be the more interesting half:

> The engine could only learn from failures that *the harness reported as failures*. But some of the worst mistakes are **tool calls that succeed while the decision was wrong** (deleting more than intended, removing files outside the plan). There is no failure signal to learn from — so a second mechanism was needed: a **pre-execution gate**, not a post-mortem.

---

## What it does

| Mechanism | Plain description | Implementation |
|---|---|---|
| **Variation** | A tool call fails → reflect → write down the lesson | `tools/result` event → rule-based `reflect()` → one `SKILL.md` per lesson |
| **Selection** | Nice, but is the lesson any *good*? | Every recurrence bumps `trials`; every later success bumps `successes` → each lesson carries its own scoreboard |
| **Inheritance** | Next time, look up prior experience before starting | `meta_search` / `meta_nourish` (search the capability library before working) |
| **Reproduction** | Don't write a loader — let the host adopt it | Official `skill-filesystem` discovery (single-level `<root>/<id>/SKILL.md`) |
| **Governance** | Lessons must not rot, and must be undoable | Archive-not-delete, `pinned` refusal, append-only audit ledger, negative list (environment noise never precipitates) |
| **Coordination** | Multiple agents on one machine must not collide | `meta_claim` (write-domain declaration with CAS) + `meta_board` |
| **Gate (v0.4)** | Stop irreversible actions *before* they run | Official `ctx.tools.guard` (pre-execute, synchronous, monotonic deny) + `meta_prepare` declaration |
| **Compaction (v0.4.2)** | Lessons fragment; merge them without losing evidence | Error-class normalisation + `meta_compact` (ledger merged, sources archived, restorable) |

**Tool surface (7):** `meta_status` · `meta_search` · `meta_nourish` · `meta_claim` · `meta_board` · `meta_prepare` · `meta_compact`

**Audit ledger (10 event types):** `precipitate` · `recur` · `verify` · `archive` · `restore` · `compact` · `gate:prepare` · `gate:allow` · `gate:deny` · `gate:consume`
— one append-only `JSONL`, so "what did it learn, and what did it allow?" can be answered on a single timeline.

---

## The gate, in one table

| Situation | Behaviour |
|---|---|
| Wildcard deletion (`rm -rf dir/*`) | **Denied** — and no declaration can override it; the point is explicit enumeration |
| Protected paths (the capability library itself, the audit ledger) | **Denied** |
| Explicit deletion without a prior declaration | Denied, with an explanation of exactly what to declare |
| Declared, covering every target | Allowed, and the declaration is written to the audit ledger |
| Code-origin deletion (targets only exist at runtime) | Requires `scope` + `expected_count` + `backup_hash` |
| Content tools (`write` / `edit` / `apply_patch` …) | **Not inspected** — their arguments are text, and text may legitimately discuss deletion (v0.4.1 regression) |
| Anything else | Untouched. A gate that is too noisy gets uninstalled, which is worse than no gate |

**Switches:** `META_GATE=off` disables the gate entirely; `META_GATE_TTL_MIN` sets declaration lifetime; `META_GATE_SKIP_TOOLS` extends the content-tool list.

---

## Quick start

```bash
git clone https://github.com/sunwindy91/dsh-tool-meta
cd dsh-tool-meta

node tests/unit.mjs        # 50/50 · zero dependencies (Node built-ins only) → prints UNIT_OK
node verify_plugin.mjs     # full chain against a fake host context → prints META_VERIFY_OK
```

Install into a DSH profile as a plugin layer (see `cordis.patch.yml`). Environment variables: `META_SKILLS_DIR` (where lessons live, default `~/.dsh/skills`), `META_FAIL_THRESHOLD` (consecutive failures before precipitating, default 2), `META_LEDGER_TAG` (namespace for the ledger), plus the `META_GATE_*` switches above.

---

## Verification, not vibes

- `tests/unit.mjs` — **50 assertions, zero dependencies**: reflection rules, threshold, negative list, ledger, archive/restore, gate (both directions), error-class normalisation, compaction, and the two regression classes.
- `verify_plugin.mjs` — full-chain run against a fake context: observation loop, threshold, single-level layout, provenance, ledger tags, manifest freshness, archive/restore, board CAS, gate (6 assertion classes), compaction.
- `docs/observation.md` — **honest self-observation**: snapshots of the library over time, including skipped days and a flat stretch that is explicitly documented as **not** evidence of improvement (single machine, n = 13, no control group).
- Every claim in this README maps to a file you can run.

---

## Related work — and how this differs

**Self-evolving skill libraries** are an active area. [Ratchet](https://github.com/amazon-science/Self-Evolving-Agents-Ratchet) (Amazon Science, with a paper and an ICML'26 workshop paper on *library drift*) is the strongest neighbour, and it is deeper than this project in several respects: failure **clustering**, embedding-based dedup, meta-skills that improve *how* lessons are written, bounded library size, and rollback thresholds.

Two honest differences:

1. **No ground truth.** Ratchet assumes a reliable metric already grades each attempt (benchmarks). Here there is none — the only signal is whether a real tool call succeeded. Learning from a weak, noisy signal in a live session is a harder and different problem.
2. **Weight class and seams.** Ratchet needs Python + Bedrock + Docker. This is a handful of dependency-free JS modules running *inside* the host on official extension points, with a pre-execution gate and one shared audit ledger for both learning and permission.

**Pre-execution authorization** is also an occupied category: [Permit0](https://github.com/permit0-ai/permit0) is a Rust policy engine with its own action taxonomy, risk scoring, human-in-the-loop routing and signed audit chain — a platform, where this is a lightweight in-host gate scoped to irreversible file deletion. A normalisation problem found while building that gate is filed upstream as [permit0#65](https://github.com/permit0-ai/permit0/issues/65).

**What this project does not claim:** novelty. It claims a working, testable, dependency-free integration of learning + governance + permission on official seams, with the audit trail to prove what happened.

---

## Known limitations

- **Detection is pattern-based** (CLI commands + common language APIs), not a canonical action taxonomy. New tool shapes need new patterns.
- **The gate reduces, it does not eliminate.** Runtime-computed targets and multi-step obfuscation can slip through. Its value is that irreversible actions must leave an auditable declaration.
- **Declarations are recorded, not verified.** `backup_hash` is written to the ledger but not yet compared against an actual backup.
- **Reflection is rule-templated**, not model-generated (the upgrade path is left open on purpose, so behaviour stays deterministic and testable).
- **Compaction is manual** and conservative: it merges only generic lessons; specialised ones (collaboration conflicts, schema violations, unknown tools) are never auto-merged — the same failure class does not imply the same advice.
- **Single machine, small n.** The observation data is one developer's machine. Treat the trend lines as instrumentation, not evidence.

---

## License

MIT
