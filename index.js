// dsh-skill-index —— 让 agent 在自己的技能库里按关键词检索。
//
// 解决的问题：技能多了以后，agent 只看得见系统提示里那几十条描述，
// 散落在其他目录的几百个技能它不知道存在。给它一个 skill_search 工具，
// 比把上百条描述塞进上下文更省 token，也更容易命中。
//
// 工具：
//   skill_search  按关键词在多根源码里检索，返回命中技能的名称、描述与路径
//   skill_catalog 按分类列出全部技能（用于「我都有什么」这类问题）

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

  cache = { at: Date.now(), skills: [...byName.values()] }
  return cache.skills
}

// ---------------------------------------------------------------- 检索

function score(skill, words) {
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
  return total
}

function formatHit(s, score) {
  const desc = s.description.length > 160 ? s.description.slice(0, 157) + '…' : s.description
  return [
    `- ${s.name}  [${s.category}]  score=${score}`,
    desc ? `  ${desc}` : '  (no description)',
    `  ${s.path}`,
  ].join('\n')
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
      async execute(args) {
        const words = String(args.query ?? '')
          .split(/\s+/)
          .filter(Boolean)
        if (words.length === 0) return 'ERROR: query is empty.'

        const skills = buildIndex(config, false)
        if (skills.length === 0) {
          const roots = (config.roots ?? []).map(expand).join(', ')
          return `No skills indexed. Checked roots: ${roots || '(none configured)'}`
        }

        const ranked = skills
          .map((s) => ({ skill: s, score: score(s, words) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.max(1, Math.min(30, args.limit ?? config.maxResults ?? 8)))

        if (ranked.length === 0) {
          return (
            `No skill matched "${words.join(' ')}" among ${skills.length} indexed skills.\n` +
            'Try fewer or different keywords, or call skill_catalog to see the categories.'
          )
        }

        const header = `Matched ${ranked.length} of ${skills.length} indexed skills for "${words.join(' ')}":`
        return [header, '', ...ranked.map((r) => formatHit(r.skill, r.score))].join('\n')
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

export function apply(ctx, config) {
  registerSearch(ctx, config)
  registerCatalog(ctx, config)
}
