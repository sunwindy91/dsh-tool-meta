// tools/rewrite-lessons.mjs — 把既有的"薄教训"重写成 v0.6.0 三段式
//   node tools/rewrite-lessons.mjs            # 真写
//   node tools/rewrite-lessons.mjs --dry-run  # 只看要改什么
//
// 为什么需要：v0.6.0 的错误模式表只影响**新沉淀**的教训；存量条目仍是
// 「一行失败特征 + 一行所有条目共用的套话」，触发词也全是「工具/失败/报错」——
// 检索时互相稀释、模型分不出该看哪一条。
//
// 原则（沿用插件的治理规矩）：
//   · **id 不改**（账本历史里引用着它）· **trials/successes 原样保留**
//   · 手写条目不碰（`pinned` 与手写成果优先）· 先备份（由调用方负责）
//   · 只重写"能从原正文里取回失败文本"的条目；取不回就跳过并报告

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { reflect } from '../lib/reflector.js'

const ROOT = process.env.META_SKILLS_DIR || path.join(os.homedir(), '.dsh', 'skills')
const DRY = process.argv.includes('--dry-run')
const FORCE = process.argv.includes('--force') // 重新生成已含「何时看」的条目（用于换了模式表之后）

/** 手写条目：不参与机械重写 */
const HANDWRITTEN = new Set(['radar-opportunities', 'dsh-plugin-host-compat'])

function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/)
  return m ? m[1] : ''
}
function field(fm, key) {
  const m = fm.match(new RegExp('^' + key + ':\\s*(.+)$', 'm'))
  return m ? m[1].trim().replace(/^"|"$/g, '') : ''
}
/** 从旧正文里取回失败文本（兼容两种旧写法） */
function failureOf(md) {
  const m = md.match(/(?:失败信息：|曾失败：)([\s\S]{0,300})/)
  if (m) return m[1].split('\n')[0].trim()
  const n = md.match(/^-\s*调用 `[^`]+` (?:曾失败|失败)：(.+)$/m)
  return n ? n[1].trim() : ''
}

let rewritten = 0
let skipped = 0
const report = []

for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!d.isDirectory()) continue
  if (HANDWRITTEN.has(d.name)) {
    skipped++
    continue
  }
  const file = path.join(ROOT, d.name, 'SKILL.md')
  if (!fs.existsSync(file)) continue
  const md = fs.readFileSync(file, 'utf8')
  if (/何时看：/.test(md) && !FORCE) {
    skipped++
    continue // 已是新格式（除非 --force）
  }
  const fm = frontmatter(md)
  const pinned = /^pinned:\s*true\s*$/m.test(md)
  if (pinned) {
    skipped++
    continue
  }
  const tool = field(fm, 'related_tool') || (field(fm, 'name') || d.name).replace(/^learn-/, '').slice(0, 16)
  const msg = failureOf(md)
  if (!msg) {
    skipped++
    report.push(`  跳过（取不到失败文本）: ${d.name}`)
    continue
  }
  const skill = reflect({ name: tool }, { error: { message: msg } })
  if (!skill) {
    skipped++
    report.push(`  跳过（反射拒绝，可能是环境性失败）: ${d.name}`)
    continue
  }
  const desc = JSON.stringify(
    `${skill.title}。${skill.when ? `何时看：${skill.when}。` : ''}Triggers: ${skill.triggers.join('、')}`,
  ).replace(/\\"/g, "'")
  const nf = fm
    .replace(/^description:.*$/m, `description: ${desc}`)
    .replace(/^related_tool:.*$/m, `related_tool: ${tool}`)
  const out = `---\n${nf}\n---\n\n${skill.body}\n`
  if (!DRY) fs.writeFileSync(file, out, 'utf8')
  rewritten++
  report.push(`  ${DRY ? '[dry] ' : ''}${d.name} → ${skill.title}`)
}

console.log(report.join('\n'))
console.log(`\n${DRY ? '[dry-run] ' : ''}重写 ${rewritten} 条 · 跳过 ${skipped} 条 · 目录 ${ROOT}`)
