// dsh-skill-index —— 让 agent 在自己的技能库里按关键词检索。
//
// 解决的问题：技能多了以后，agent 只看得见系统提示里那几十条描述，
// 散落在其他目录的几百个技能它不知道存在。给它一个 skill_search 工具，
// 比把上百条描述塞进上下文更省 token，也更容易命中。
//
// 工具：
//   skill_search  按关键词在多根源码里检索，返回命中技能的名称、描述与路径
//   skill_read    读某个技能的 SKILL.md，并记一次使用
//   skill_catalog 按分类列出全部技能（用于「我都有什么」这类问题）
//   skill_active  看本会话加载了哪些技能、各占多少 token
//   skill_drop    判定某个已加载技能不再适用时停用它
//
// 记账的意义：检索排序会按你真正读过的技能加权。第一次搜出来的第 5 名，
// 读过三次之后应该排在前面——它已经被验证过对这类任务有用。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'skill-index'
export const inject = ['tools']

const MAX_FILES = 3000
const MAX_DEPTH = 5

export const Config = Schema.object({
  roots: Schema.array(Schema.string())
    .default(['~/.skills'])
    .description('技能库根目录。支持 ~ 与 $ENV 变量；可以给多个。'),
  maxResults: Schema.number().default(8).description('搜索结果条数上限。'),
  refreshSeconds: Schema.number().default(300).description('索引缓存有效期（秒）。'),
})

// ---------------------------------------------------------------- 路径

function expand(p) {
  let out = p
  if (out.startsWith('~')) out = path.join(os.homedir(), out.slice(1))
  out = out.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, k) => process.env[k] ?? m)
  out = out.replace(/%([A-Za-z0-9_()]+)%/g, (m, k) => process.env[k] ?? m)
  return path.resolve(out)
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- frontmatter
//
// 关键点：description 支持 >、|、>-、|- 四种块标量。
// 只抓 "description:" 那一行会得到 ">"，索引里就成了空描述，永远检索不到。

function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { name: '', description: '' }

  let end = -1
  for (let i = 1; i < Math.min(lines.length, 200); i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end < 0) return { name: '', description: '' }

  let name = ''
  let description = ''
  let i = 1
  while (i < end) {
    const line = lines[i]
    const nameMatch = /^name:\s*(.+)$/.exec(line)
    if (nameMatch) {
      name = nameMatch[1].trim().replace(/^["']|["']$/g, '')
      i++
      continue
    }
    const descMatch = /^(?:description|summary|when_to_use):\s*(.*)$/.exec(line)
    if (descMatch) {
      const first = descMatch[1].trim()
      if (first === '>' || first === '|' || first === '>-' || first === '|-') {
        const buf = []
        i++
        while (i < end && (/^\s+\S/.test(lines[i]) || lines[i].trim() === '')) {
          buf.push(lines[i].trim())
          i++
        }
        description = buf.filter(Boolean).join(' ')
      } else {
        description = first.replace(/^["']|["']$/g, '')
        i++
        while (i < end && /^\s+\S/.test(lines[i]) && !/^\s*[a-z_]+:/.test(lines[i])) {
          description += ' ' + lines[i].trim()
          i++
        }
      }
      continue
    }
    i++
  }

  return { name, description: description.replace(/\s+/g, ' ').trim() }
}

// ---------------------------------------------------------------- 索引

let cache = { at: 0, skills: [] }

function walk(root, depth, out, visited, base) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return

  // 真实路径去重：junction / symlink 指回祖先时，不加这一步会无限递归直到 OOM。
  let real
  try {
    real = fs.realpathSync(root)
  } catch {
    return
  }
  if (visited.has(real)) return
  visited.add(real)

  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    if (e.isSymbolicLink()) continue
    const full = path.join(root, e.name)
    if (e.isDirectory()) {
      walk(full, depth + 1, out, visited, base)
      continue
    }
    if (e.name !== 'SKILL.md') continue
    let text = ''
    try {
      text = fs.readFileSync(full, 'utf8')
    } catch {
      continue
    }
    const fm = parseFrontmatter(text)
    const dir = path.dirname(full)
    const rel = path.relative(base, dir)
    const parts = rel.split(path.sep)
    out.push({
      name: fm.name || path.basename(dir),
      folder: path.basename(dir),
      category: parts.length > 1 ? parts[0] : '(uncategorized)',
      description: fm.description,
      path: full,
      dir,
    })
  }
}

function buildIndex(config, force) {
  const ttl = (config.refreshSeconds || 300) * 1000
  if (!force && cache.skills.length > 0 && Date.now() - cache.at < ttl) return cache.skills

  const roots = (config.roots?.length ? config.roots : ['~/.skills']).map(expand)
  const all = []
  for (const root of roots) {
    if (!isDir(root)) continue
    const found = []
    walk(root, 0, found, new Set(), root)
    for (const s of found) all.push(s)
  }

  // 同一技能在同一根里出现多次时按 name 去重，保留路径最短的那个
  const byName = new Map()
  for (const s of all) {
    const key = s.name.toLowerCase()
    const prev = byName.get(key)
    if (!prev || s.path.length < prev.path.length) byName.set(key, s)
  }

  // 索引时把「判断要不要读」需要的元信息算好：字符数、章节标题、references 清单。
  // 这些一次算完缓存 5 分钟，之后命中行和 digest 都不额外读文件。
  const skills = [...byName.values()]
  for (const s of skills) enrich(s)

  cache = { at: Date.now(), skills }
  return cache.skills
}

// ---------------------------------------------------------------- 索引元信息

function enrich(skill) {
  let text
  try {
    text = fs.readFileSync(skill.path, 'utf8')
  } catch {
    skill.chars = skill.description.length
    skill.headings = []
    skill.refs = []
    return
  }
  skill.chars = text.length
  skill.headings = [...text.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 14)

  const dir = path.dirname(skill.path)
  const refs = []
  for (const sub of ['references', 'scripts', 'assets']) {
    const full = path.join(dir, sub)
    if (!fs.existsSync(full)) continue
    let entries
    try {
      entries = fs.readdirSync(full, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries.slice(0, 12)) {
      if (!e.isFile()) continue
      try {
        const st = fs.statSync(path.join(full, e.name))
        refs.push({ path: `${sub}/${e.name}`, chars: st.size })
      } catch {
        /* 读不到就跳过 */
      }
    }
  }
  skill.refs = refs
}

// digest：只够判断"要不要用它"，不够照着做。
// 中位 310 tokens，全文 3,853 —— 判断阶段贵 12 倍没有道理。
function buildDigest(skill, maxChars = 1400) {
  const lines = []
  lines.push(`# ${skill.name}  [${skill.category}]`)
  lines.push(`全文 ≈${(skill.chars / 1.6 / 1000).toFixed(1)}k tokens · ${skill.path}`)
  if (skill.description) {
    lines.push('')
    lines.push(skill.description.length > 300 ? skill.description.slice(0, 297) + '…' : skill.description)
  }
  // 描述很少写清「什么时候不该用」，但判断阶段这条信息最值钱。
  // 只有少数技能有这一节，有就带上，没有就不硬凑。
  if (skill.text) {
    const notFor = skill.text.match(/^#{1,3}[^\n]*(?:不该用|不适用|什么时候不用|何时不用)[^\n]*\n([\s\S]{0,320})/m)
    if (notFor) {
      lines.push('')
      lines.push('## 什么时候不该用（原文）')
      lines.push(notFor[1].trim().slice(0, 300))
    }
  }
  if (skill.headings.length) {
    lines.push('')
    lines.push('## 结构')
    lines.push(skill.headings.map((h) => `- ${h}`).join('\n'))
  }
  if (skill.refs.length) {
    lines.push('')
    lines.push('## 附带文件（按需读，不用整份载入）')
    for (const r of skill.refs) lines.push(`- ${r.path}  ${(r.chars / 1024).toFixed(1)}KB`)
  }
  lines.push('')
  lines.push(`要照它做，调 skill_read({ name: "${skill.name}", mode: "full" }) 读全文。`)
  const out = lines.join('\n')
  return out.length > maxChars ? out.slice(0, maxChars) + '\n…（digest 已截断）' : out
}

// ---------------------------------------------------------------- 使用账本

const USAGE_PATH = path.join(os.homedir(), '.skill-hub', 'usage.json')
let usageCache = null

function loadUsage() {
  if (usageCache) return usageCache
  try {
    usageCache = new Map(Object.entries(JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'))))
  } catch {
    usageCache = new Map()
  }
  return usageCache
}

function recordUsage(name) {
  const usage = loadUsage()
  const key = name.toLowerCase()
  const prev = usage.get(key) ?? { count: 0, last: null }
  usage.set(key, { count: prev.count + 1, last: new Date().toISOString() })
  try {
    fs.mkdirSync(path.dirname(USAGE_PATH), { recursive: true })
    fs.writeFileSync(USAGE_PATH, JSON.stringify(Object.fromEntries(usage), null, 1), 'utf8')
  } catch {
    // 记不上不影响检索，静默放着
  }
}

// ---------------------------------------------------------------- 检索

// ---------------------------------------------------------------- 会话级活跃技能

// 按会话记「这次读了哪些技能」。key 是 agent.id，拿不到就退化成一个全局桶。
// 记的是判断依据（token 成本、读的时间），不是内容——内容已经进了上下文，本插件动不了它。
const activeBySession = new Map()

function sessionKey(exec) {
  const id = exec?.agent?.id
  return id ? String(id) : 'global'
}

function activeOf(exec) {
  const key = sessionKey(exec)
  if (!activeBySession.has(key)) activeBySession.set(key, new Map())
  return activeBySession.get(key)
}

function estimateTokens(text) {
  return Math.round(text.length / 1.6)
}

function activeLine(exec) {
  const active = activeOf(exec)
  if (active.size === 0) return null
  const parts = [...active.entries()].map(([name, info]) => `${name}(${(info.tokens / 1000).toFixed(1)}k)`)
  return `已加载：${parts.join('、')} —— 若本次任务与它们无关，先调 skill_drop 停用，不要沿用它的流程。`
}

function score(skill, words, usage) {
  const name = skill.name.toLowerCase()
  const folder = skill.folder.toLowerCase()
  const cat = skill.category.toLowerCase()
  const desc = skill.description.toLowerCase()
  let total = 0
  for (const raw of words) {
    const w = raw.toLowerCase()
    if (!w) continue
    if (name === w) total += 20
    else if (name.includes(w)) total += 10
    if (folder.includes(w)) total += 6
    if (cat.includes(w)) total += 4
    if (desc.includes(w)) total += 3
  }
  if (total === 0) return 0
  // 读过的技能排前面：最多 +120%，十次封顶
  const uses = usage?.get(skill.name.toLowerCase())?.count ?? 0
  return uses > 0 ? Math.round(total * (1 + 0.12 * Math.min(uses, 10))) : total
}

// 命中行：一行一个。路径不给——读技能要走 skill_read，那样才会记账。
// 省下来的正是每行 70 多个字符的路径。
function formatHit(s, score, uses, tokens) {
  const desc = s.description.length > 90 ? s.description.slice(0, 87) + '…' : s.description
  const used = uses > 0 ? ` ·用过${uses}次` : ''
  const cost = tokens ? ` ·全文≈${(tokens / 1000).toFixed(1)}k` : ''
  return `- ${s.name} [${s.category}] ${score}${cost}${used}${desc ? ' — ' + desc : ''}`
}

// ---------------------------------------------------------------- 工具

function registerSearch(ctx, config) {
  ctx.tools.register(
    defineTool({
      name: 'skill_search',
      description:
        'Search the local agent-skill library by keyword and return ranked matches with the exact ' +
        'SKILL.md path of each. Use this before improvising a workflow: if a skill already covers ' +
        'the task, read its SKILL.md and follow it. Works across every configured skills root, not ' +
        'just the ones this agent was started with.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Keywords, space separated. Chinese and English both work, e.g. "PPT 排版" or "code review".',
        },
        limit: {
          type: 'number',
          description: 'Maximum hits to return. Defaults to the configured maxResults.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const words = String(args.query ?? '')
          .split(/\s+/)
          .filter(Boolean)
        if (words.length === 0) return 'ERROR: query is empty.'

        const skills = buildIndex(config, false)
        if (skills.length === 0) {
          const roots = (config.roots ?? []).map(expand).join(', ')
          return `No skills indexed. Checked roots: ${roots || '(none configured)'}`
        }

        const usage = loadUsage()
        const ranked = skills
          .map((s) => ({ skill: s, score: score(s, words, usage) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.max(1, Math.min(30, args.limit ?? config.maxResults ?? 8)))

        if (ranked.length === 0) {
          return (
            `No skill matched "${words.join(' ')}" among ${skills.length} indexed skills.\n` +
            'Try fewer or different keywords, or call skill_catalog to see the categories.'
          )
        }

        const ledger = activeLine(exec)
        const prefix = ledger ? `[技能台账] ${ledger}` : null

        // 弱匹配不铺开：最高分不够就别浪费 token 列描述，只报名字让人换词重搜
        const MIN_STRONG = 6
        if (ranked[0].score < MIN_STRONG) {
          const names = ranked.slice(0, 5).map((r) => r.skill.name).join(', ')
          return [
            prefix,
            `没有强匹配（最高 ${ranked[0].score} 分，阈值 ${MIN_STRONG}）。可能相关：${names}`,
            '这些不太可能适用——直接做，或换个说法再搜。硬读一个弱匹配的技能，比不读更贵。',
          ]
            .filter((x) => x !== null)
            .join('\n')
        }

        const header = `Matched ${ranked.length} of ${skills.length} indexed skills for "${words.join(' ')}":`
        const body = ranked.map((r) =>
          formatHit(r.skill, r.score, usage.get(r.skill.name.toLowerCase())?.count ?? 0, r.skill.chars),
        )
        return [prefix, header, '', ...body].filter((x) => x !== null).join('\n')
      },
    }),
  )
}

function registerCatalog(ctx, config) {
  ctx.tools.register(
    defineTool({
      name: 'skill_catalog',
      description:
        'List the local agent-skill library grouped by category, with a one-line summary per skill. ' +
        'Use it to see what is available when you do not know which keywords to search for.',
      parameters: {
        category: {
          type: 'string',
          description: 'Only show this category (case-insensitive substring). Omit for every category.',
        },
        refresh: {
          type: 'boolean',
          description: 'Rebuild the index before listing.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const skills = buildIndex(config, Boolean(args.refresh))
        if (skills.length === 0) {
          return `No skills indexed. Configured roots: ${(config.roots ?? []).join(', ') || '(none)'}`
        }

        const filter = String(args.category ?? '').toLowerCase()
        const groups = new Map()
        for (const s of skills) {
          if (filter && !s.category.toLowerCase().includes(filter)) continue
          if (!groups.has(s.category)) groups.set(s.category, [])
          groups.get(s.category).push(s)
        }
        if (groups.size === 0) return `No category matched "${args.category}".`

        const out = [`${skills.length} skills in ${groups.size} categories:`]
        for (const cat of [...groups.keys()].sort()) {
          const items = groups.get(cat).sort((a, b) => a.name.localeCompare(b.name))
          out.push('', `## ${cat} (${items.length})`)
          for (const s of items) {
            const d = s.description.length > 80 ? s.description.slice(0, 77) + '…' : s.description
            out.push(`- ${s.name}${d ? ' — ' + d : ''}`)
          }
        }
        return out.join('\n')
      },
    }),
  )
}

function registerRead(ctx, config) {
  ctx.tools.register(
    defineTool({
      name: 'skill_read',
      description:
        "Read a skill's SKILL.md by name and return its text. Records the read so later skill_search " +
        'calls rank skills you have actually used higher — prefer this over reading the path by hand, ' +
        'since it is the same content and it keeps the ranking honest.',
      parameters: {
        name: {
          type: 'string',
          required: true,
          description: 'Skill name or its folder name, case insensitive.',
        },
        mode: {
          type: 'string',
          description:
            'digest (default, ~300 tokens: description, section headings, bundled files) or full ' +
            '(the whole SKILL.md, a median ~3,850 tokens). Use digest to decide whether the skill ' +
            'applies; switch to full only when you are going to follow it.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const wanted = String(args.name ?? '').trim()
        if (!wanted) return 'ERROR: name is required.'

        const skills = buildIndex(config, false)
        if (skills.length === 0) {
          const roots = (config.roots ?? []).map(expand).join(', ')
          return `No skills indexed. Checked roots: ${roots || '(none configured)'}`
        }

        const key = wanted.toLowerCase()
        const hit =
          skills.find((s) => s.name.toLowerCase() === key) ??
          skills.find((s) => s.folder.toLowerCase() === key) ??
          skills.find((s) => s.name.toLowerCase().includes(key)) ??
          skills.find((s) => s.folder.toLowerCase().includes(key))
        if (!hit) {
          return (
            `No skill named "${wanted}" among ${skills.length} indexed skills.\n` +
            'Call skill_search with keywords to find it first.'
          )
        }

        let text
        try {
          text = fs.readFileSync(hit.path, 'utf8')
        } catch (e) {
          return `ERROR: cannot read ${hit.path}: ${e.message}`
        }
        recordUsage(hit.name)
        const mode = String(args.mode ?? 'digest').toLowerCase()

        if (mode !== 'full') {
          const digest = buildDigest({ ...hit, chars: text.length, text })
          activeOf(exec).set(hit.name, { tokens: estimateTokens(digest), at: Date.now(), category: hit.category, mode: 'digest' })
          return digest
        }

        activeOf(exec).set(hit.name, { tokens: estimateTokens(text), at: Date.now(), category: hit.category, mode: 'full' })
        const MAX = 40000
        const body =
          text.length > MAX
            ? text.slice(0, MAX) + `\n\n… truncated (${text.length} chars total); full text at ${hit.path}`
            : text
        return `# ${hit.name}\ncategory: ${hit.category}\npath: ${hit.path}\n\n${body}`
      },
    }),
  )
}

// ---------------------------------------------------------------- 停用与台账

function registerDrop(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'skill_drop',
      description:
        'Mark a previously read skill as no longer applicable to the current task. Call this when the ' +
        'task has changed and the skill you loaded earlier no longer applies: it removes the skill ' +
        'from this session\'s active set and stops it being suggested again. Its text stays in the ' +
        'context until compaction, but nothing should follow it after this call.',
      parameters: {
        name: { type: 'string', required: true, description: '要停用的技能名，大小写不敏感。' },
        reason: { type: 'string', description: '一句话说明为什么不再适用（用于台账）。' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args, exec) {
        const wanted = String(args.name ?? '').trim()
        if (!wanted) return 'ERROR: name is required.'
        const active = activeOf(exec)
        const key = [...active.keys()].find((k) => k.toLowerCase() === wanted.toLowerCase())
        if (!key) {
          const list = active.size ? [...active.keys()].join(', ') : '(空)'
          return `当前会话没有加载过 "${wanted}"。已加载：${list}`
        }
        const info = active.get(key)
        active.delete(key)
        const rest = active.size ? `仍在用：${[...active.keys()].join(', ')}` : '当前会话已无活跃技能。'
        return [
          `已停用 ${key}（${(info.tokens / 1000).toFixed(1)}k tokens）。`,
          `从现在起不要再用它的流程、清单或判断标准。${args.reason ? `原因：${args.reason}` : ''}`,
          rest,
          '',
          `注意：它的正文仍在上下文里，只有压缩才会真正释放这 ${(info.tokens / 1000).toFixed(1)}k token。`,
          '这一步改变的是行为，不是上下文体积。',
        ].join('\n')
      },
    }),
  )
}

function registerActive(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'skill_active',
      description:
        'Show the skills loaded in this session, with the context cost of each and how long ago it ' +
        'was read. Use it before starting a different task to decide which ones still apply; then ' +
        'call skill_drop for the ones that do not.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(_args, exec) {
        const active = activeOf(exec)
        if (active.size === 0) {
          return '本会话没有加载过技能。当前任务可以直接做，或先 skill_search 看有没有适用的。'
        }
        const now = Date.now()
        const rows = [...active.entries()]
          .sort((a, b) => b[1].at - a[1].at)
          .map(([name, info]) => {
            const mins = Math.round((now - info.at) / 60000)
            const when = mins < 1 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : `${Math.round(mins / 60)} 小时前`
            return `  ${name}  [${info.category}]  ${(info.tokens / 1000).toFixed(1)}k tokens · ${when}`
          })
        const total = [...active.values()].reduce((s, i) => s + i.tokens, 0)
        return [
          `本会话加载了 ${active.size} 个技能，合计约 ${(total / 1000).toFixed(1)}k tokens：`,
          '',
          ...rows,
          '',
          '如果当前任务和其中某些无关，用 skill_drop 停用它们——停用会改变后续行为，但不减少上下文，',
          '真正释放要等压缩。技能里最贵的不是搜索，是「加载了却用不上还一直占着」。',
        ].join('\n')
      },
    }),
  )
}

export function apply(ctx, config) {
  registerSearch(ctx, config)
  registerRead(ctx, config)
  registerCatalog(ctx, config)
  registerActive(ctx)
  registerDrop(ctx)
}
