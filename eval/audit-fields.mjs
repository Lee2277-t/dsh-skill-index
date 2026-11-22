// 复核每个技能的 when-not-to-use 字段。
// 用法：node eval/audit-fields.mjs
//
// 这不是"读一遍全部内容"，是按可复现的规则挑出可疑项：
//   太长      >60 字符，digest 里占的额度太多
//   套话      含「不适用于其他场景」这类等于没写的说法
//   泛开头    以「不适用于」开头但不给具体内容
//   重述描述  与 description 字面重合 >85%，等于没提供新信息
//
// 规则查不出来的（比如写错了、写反了）只能靠人看，脚本不假装能判断。

import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.argv[2] || 'D:/开发/skill'
// 只收真正等于没写的说法。「可能不全」这类是风险提示，不是套话，不能误伤。
const VAGUE = /不适用于其他场景|不适合所有情况|视情况而定|根据实际情况|需要时使用|视需求而定/

function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('_') || e.name === 'node_modules') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (e.name === 'SKILL.md') out.push(full)
  }
  return out
}

const files = walk(ROOT)
const issues = []
let total = 0

for (const f of files) {
  const text = fs.readFileSync(f, 'utf8')
  const nf = /^when-not-to-use:\s*(.+)$/m.exec(text)?.[1]?.trim()
  if (!nf) continue
  total++
  const desc = /^description:\s*["']?(.{0,300})/m.exec(text)?.[1]?.trim() ?? ''
  const bare = nf.replace(/[，。；、（）()\s]/g, '')
  let overlap = 0
  for (const ch of bare) if (desc.includes(ch)) overlap++
  const dup = bare.length ? overlap / bare.length : 0

  const problems = []
  if (nf.length > 60) problems.push(`长${nf.length}`)
  if (VAGUE.test(nf)) problems.push('套话')
  if (/^不适用于/.test(nf) && nf.length < 16) problems.push('泛开头')
  // 短句天然与描述共用名词，重合率不可靠；只在句子够长且几乎逐字重复时才报。
  if (bare.length >= 24 && dup > 0.9) problems.push(`重述描述${Math.round(dup * 100)}%`)
  if (problems.length) issues.push({ skill: path.basename(path.dirname(f)), problems, nf })
}

console.log(`扫描 ${files.length} 个技能，有字段的 ${total} 个`)
console.log(`可疑 ${issues.length} 个\n`)
for (const it of issues) {
  console.log(`- ${it.skill}  [${it.problems.join(', ')}]`)
  console.log(`    ${it.nf}`)
}
if (issues.length === 0) console.log('没有可疑项。')
