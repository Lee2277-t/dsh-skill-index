// 评测：给定 SQL 查询，看 skill_search 把预期技能排到第几名。
// 用法：node eval/run.mjs [--verbose]
//
// 指标：
//   hit@1  第一条就是预期
//   hit@3  前三条里有预期
//   MRR    第一个预期技能排名的倒数（0 表示没出现）
//   tokens 每次检索输出的平均 token 数（改排版时不能变贵）
//
// 负例（expect 为空）的判定是"没有强匹配"，即输出不以 Matched 开头。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const tmpHome = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'eval-home-'))
process.env.USERPROFILE = tmpHome
process.env.HOME = tmpHome

const { apply } = await import(pathToFileURL(path.join(root, 'index.js')).href)
const tools = new Map()
apply({ tools: { register: (t) => tools.set(t.name, t) }, on: () => {} }, { roots: ['D:/开发/skill'], maxResults: 8, autoHint: false })

const cases = JSON.parse(fs.readFileSync(path.join(here, 'queries.json'), 'utf8'))
const S = { agent: { id: 'eval' } }
const est = (s) => {
  const cjk = (s.match(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/g) || []).length
  return Math.round(cjk / 1.6 + (s.length - cjk) / 4)
}

let hits1 = 0, hits3 = 0, mrr = 0, tokens = 0
const rows = []

for (const c of cases) {
  const out = await tools.get('skill_search').execute({ query: c.q, limit: 5 }, S)
  tokens += est(out)
  const names = [...out.matchAll(/^- (\S+) \[/gm)].map((m) => m[1])

  if (c.expect.length === 0) {
    const ok = !out.startsWith('Matched')
    rows.push({ q: c.q, got: ok ? '(无强匹配 ✓)' : names[0], rank: 0, ok })
    if (ok) { hits1++; hits3++; mrr += 1 }
    continue
  }

  const rank = names.findIndex((n) => c.expect.includes(n))
  const r = rank < 0 ? 0 : rank + 1
  if (r === 1) hits1++
  if (r >= 1 && r <= 3) hits3++
  if (r > 0) mrr += 1 / r
  rows.push({ q: c.q, got: names[0] ?? '(空)', rank: r, ok: r === 1 })
}

const n = cases.length
console.log('查询'.padEnd(26) + '命中'.padStart(6) + '  第一条结果')
console.log('-'.repeat(80))
for (const r of rows) {
  const mark = r.ok ? '✓' : r.rank >= 1 && r.rank <= 3 ? '~' : '✗'
  console.log(`${mark} ${r.q.padEnd(24)}${String(r.rank || '-').padStart(4)}  ${r.got}`)
}
console.log('-'.repeat(80))
console.log(`hit@1 ${hits1}/${n} = ${((hits1 / n) * 100).toFixed(1)}%`)
console.log(`hit@3 ${hits3}/${n} = ${((hits3 / n) * 100).toFixed(1)}%`)
console.log(`MRR   ${(mrr / n).toFixed(3)}`)
console.log(`检索输出平均 ≈${Math.round(tokens / n)} tokens`)

fs.rmSync(tmpHome, { recursive: true, force: true })
