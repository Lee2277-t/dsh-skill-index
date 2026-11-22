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
  refreshSeconds: Schema.number().default(300).description('索引缓存有效期（秒）；0 表示每次都重建。'),
  // 这三项代码里一直在读，但 schema 没声明，等于从配置界面设不了。
  autoHint: Schema.boolean().default(true).description('每轮第一步自动检索一次，强命中就提示一行。'),
  autoHintMinScore: Schema.number().default(14).description('自动提示的分数门槛，调高更安静。'),
  followLinks: Schema.boolean()
    .default(true)
    .description('是否跟随技能库内部的目录软链/junction。关掉可以防止库里的链接指向库外。'),
})

// ---------------------------------------------------------------- 路径

function expand(p) {
  // Schema.array(Schema.string()) 会放行 null，YAML 里写 "- " 就能把 null 传进来。
  // 以前这里 undefined.startsWith 直接抛，而且是三个工具共用的前置步骤——一处崩全崩。
  if (typeof p !== 'string') return ''
  let out = p.trim()
  if (!out) return ''
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
  if (lines[0]?.trim() !== '---') return { name: '', description: '', notFor: '' }

  // 不能按固定行数截断 frontmatter：有的技能头部很长（几十条 metadata），
  // 一旦截断，name/description 全部退化成空，这个技能在索引里就等于没有。
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end < 0) return { name: '', description: '', notFor: '' }

  let name = ''
  let description = ''
  let notFor = ''
  let i = 1
  while (i < end) {
    const line = lines[i]
    const nameMatch = /^name:\s*(.+)$/.exec(line)
    if (nameMatch) {
      name = nameMatch[1].trim().replace(/^["']|["']$/g, '')
      i++
      continue
    }
    // when-not-to-use 是插件约定的字段：一行说清什么时候别用。
    const notForMatch = /^(?:when-not-to-use|when_not_to_use):\s*(.+)$/.exec(line)
    if (notForMatch) {
      notFor = notForMatch[1].trim().replace(/^["']|["']$/g, '')
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

  return { name, description: description.replace(/\s+/g, ' ').trim(), notFor: notFor.replace(/\s+/g, ' ').trim() }
}

// ---------------------------------------------------------------- 索引

let cache = { at: 0, skills: [], key: '' }

// 正文里带 frontmatter 会让「只写在 description 里的词」被算成正文命中，
// 标签就变成假的了。所以正文先剥掉头部。
function stripFrontmatter(text) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return m ? text.slice(m[0].length) : text
}

function walk(root, depth, out, visited, base, viaLink, followLinks) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return

  // 只在根和软链上做 realpath：
  // 普通目录不可能成环，每个目录都 realpath 一次是纯浪费（真实库上占冷启动的大头）。
  if (viaLink || depth === 0) {
    let real
    try {
      real = fs.realpathSync(root)
    } catch {
      return
    }
    if (visited.has(real)) return
    visited.add(real)
  }

  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return
    // _ 开头的一律当归档/备份，不进索引。
    // 之前 _备份 里的 172 份副本会被扫进来，只是恰好被同名去重挡住大半——
    // 备份目录一旦改了名，就会变成一堆重复技能冒出来。
    if (e.name.startsWith('.') || e.name.startsWith('_') || e.name === 'node_modules') continue
    const full = path.join(root, e.name)

    let isDirEntry = e.isDirectory()
    let link = false
    if (e.isSymbolicLink()) {
      // 用软链组织的技能库很常见（~/.skills/foo -> ~/repos/foo）。
      // 但跟随也意味着"库里的链接可以指到任何地方"，所以留一个开关能关掉。
      if (!followLinks) continue
      try {
        isDirEntry = fs.statSync(full).isDirectory()
        link = true
      } catch {
        continue
      }
    }

    if (isDirEntry) {
      walk(full, depth + 1, out, visited, base, link, followLinks)
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
      notFor: fm.notFor,
      path: full,
      dir,
      _text: text, // 交给 enrich 用，免得同一个文件读两遍
    })
  }
}

function buildIndex(config, force) {
  // 显式写 roots: [] 表示"我就是要空库"，只有完全没配才回落 ~/.skills。
  const configured = Array.isArray(config.roots) ? config.roots : ['~/.skills']
  const roots = configured.map(expand).filter(Boolean)
  // 缓存必须按 roots 分键：同一个进程里插件被重新挂载、或 profile 覆盖挂两份时，
  // 不区分就会拿上一份根目录的索引，而且不报错。
  const key = roots.join('|').toLowerCase()
  // 0 是合法值（每次都用新索引），|| 会把它变成 300 秒，加了技能要等五分钟。
  const ttl = (config.refreshSeconds ?? 300) * 1000
  if (!force && cache.at > 0 && cache.key === key && Date.now() - cache.at < ttl) return cache.skills

  const all = []
  for (const root of roots) {
    if (!isDir(root)) continue
    const found = []
    walk(root, 0, found, new Set(), root, false, config.followLinks !== false)
    for (const s of found) all.push(s)
  }

  // 去重键用 name+folder：只按 name 去重会让同名但不同目录的技能静默消失，
  // 文件还在、工具永远看不见，也没有任何提示。
  const byKey = new Map()
  for (const s of all) {
    const k = `${s.name.toLowerCase()}|${s.folder.toLowerCase()}`
    const prev = byKey.get(k)
    if (!prev || s.path.length < prev.path.length) byKey.set(k, s)
  }

  const skills = [...byKey.values()]
  for (const s of skills) {
    enrich(s, s._text)
    delete s._text
  }

  // 同名前缀的技能成族（seo-*、better-*、sites-*）。
  const famCount = new Map()
  for (const s of skills) {
    const fam = s.name.includes('-') ? s.name.split('-')[0] : ''
    if (fam) famCount.set(fam, (famCount.get(fam) ?? 0) + 1)
  }
  for (const s of skills) {
    const fam = s.name.includes('-') ? s.name.split('-')[0] : ''
    s.family = fam && (famCount.get(fam) ?? 0) >= 3 ? { name: fam, count: famCount.get(fam) } : null
  }

  cache = { at: Date.now(), skills, key }
  return cache.skills
}

// ---------------------------------------------------------------- 索引元信息

function enrich(skill, text) {
  if (typeof text !== 'string') {
    try {
      text = fs.readFileSync(skill.path, 'utf8')
    } catch {
      skill.chars = skill.description.length
      skill.headings = []
      skill.refs = []
      skill.body = ''
      return
    }
  }
  skill.chars = text.length
  // 正文只留前 8KB：够覆盖开头的方法与工具段，又不至于每个技能常驻 20KB。
  skill.body = stripFrontmatter(text).toLowerCase().slice(0, 8000)
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
  const head = [`# ${skill.name}  [${skill.category}]`, `全文 ≈${(skill.chars / 1.6 / 1000).toFixed(1)}k tokens · ${skill.path}`]
  if (skill.notFor) head.push('', `不适合：${skill.notFor}`)
  if (skill.description) {
    head.push('', skill.description.length > 300 ? skill.description.slice(0, 297) + '…' : skill.description)
  }

  // 这句必须出现：整个插件的节流靠它——先看 digest 判断，要照做才读全文。
  // 以前是"拼完再截尾"，结果文件多的技能（ppt-master 有 20 个文件）把这句截掉了，
  // digest 变成一张文件清单，最该传递的信息反而丢了。
  const tail = `要照它做，调 skill_read({ name: "${skill.name}", mode: "full" }) 读全文。`

  const refs = skill.refs ?? []
  const heads = skill.headings ?? []

  // 逐级压缩：先砍文件清单，再砍章节，最后才动描述。
  for (const refCap of [refs.length, 6, 0]) {
    for (const headCap of [heads.length, 8, 0]) {
      const parts = [...head]
      if (headCap) parts.push('', '## 结构', heads.slice(0, headCap).map((h) => `- ${h}`).join('\n'))
      if (refCap) {
        const list = refs.slice(0, refCap).map((r) => `- ${r.path}  ${(r.chars / 1024).toFixed(1)}KB`)
        if (refs.length > refCap) list.push(`- …还有 ${refs.length - refCap} 个`)
        parts.push('', '## 附带文件（按需读，不用整份载入）', list.join('\n'))
      }
      parts.push('', tail)
      const out = parts.join('\n')
      if (out.length <= maxChars) return out
    }
  }

  // 极端情况：连描述都太长。截描述，tail 依然保留。
  const slim = [`# ${skill.name}  [${skill.category}]`, `全文 ≈${(skill.chars / 1.6 / 1000).toFixed(1)}k tokens · ${skill.path}`, '']
  if (skill.notFor) slim.push(`不适合：${skill.notFor}`, '')
  slim.push(tail)
  const out = slim.join('\n')
  return out.length > maxChars ? out.slice(0, maxChars) + '\n…（digest 已截断）' : out
}

// ---------------------------------------------------------------- 使用账本

const USAGE_PATH = path.join(os.homedir(), '.skill-hub', 'usage.json')
let usageCache = null
let usageStamp = -1

// 用 mtime 判失效：删掉文件、或别的进程改过，都要能看见。
// 之前是纯内存缓存 + 整表覆盖写：删文件不生效，外部写入还会被静默抹掉。
function usageMtime() {
  try {
    return fs.statSync(USAGE_PATH).mtimeMs
  } catch {
    return 0
  }
}

// 唯一的读入口：坏文件先备份再当空表。
// loadUsage 和 recordUsage 都必须走这里——recordUsage 自己 try/catch 一次，
// 就会绕过备份，把坏文件直接覆盖掉（备份测出来是"无"就是这么来的）。
function readUsageFile() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'))))
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      try {
        fs.renameSync(USAGE_PATH, `${USAGE_PATH}.bad-${Date.now()}`)
      } catch {
        /* 备份不了就算了，别让它影响检索 */
      }
    }
    return new Map()
  }
}

function loadUsage() {
  const stamp = usageMtime()
  if (usageCache && stamp === usageStamp) return usageCache
  usageCache = readUsageFile()
  usageStamp = usageMtime()
  return usageCache
}

function recordUsage(name) {
  const key = name.toLowerCase()
  // 写之前重新读盘：领着旧快照整表覆盖，会把别的进程刚写的计数抹掉
  // （实测 6 进程 ×40 次读，期望 240 实际只剩 41）。
  const usage = readUsageFile()
  const prev = usage.get(key) ?? { count: 0, last: null }
  const count = (Number.isFinite(prev.count) ? prev.count : 0) + 1
  usage.set(key, { count, last: new Date().toISOString() })
  usageCache = usage
  try {
    fs.mkdirSync(path.dirname(USAGE_PATH), { recursive: true })
    // 先写临时文件再改名：写一半崩掉不会留下半截 JSON
    const tmp = `${USAGE_PATH}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(usage), null, 1), 'utf8')
    fs.renameSync(tmp, USAGE_PATH)
    usageStamp = usageMtime()
  } catch {
    // 记不上不影响检索，静默放着
  }
}

// ---------------------------------------------------------------- 检索

// ---------------------------------------------------------------- 会话级活跃技能

// 按会话记「这次读了哪些技能」。key 是 agent.id，拿不到就退化成一个全局桶。
// 记的是判断依据（token 成本、读的时间），不是内容——内容已经进了上下文，本插件动不了它。
const MAX_SESSIONS = 200
const activeBySession = new Map()

function sessionKey(exec) {
  const id = exec?.agent?.id
  return id ? String(id) : 'global'
}

// 会话数无上限时，长跑的宿主会一直涨（每个会话一个 Map）。
// 超过上限丢最早进入的那个：活跃台账本来只服务当前会话，旧的无所谓。
function trimSessions(map) {
  if (map.size <= MAX_SESSIONS) return
  const oldest = map.keys().next().value
  map.delete(oldest)
}

function activeOf(exec) {
  const key = sessionKey(exec)
  if (!activeBySession.has(key)) {
    trimSessions(activeBySession)
    activeBySession.set(key, new Map())
  }
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

// 库里有相当一部分技能是英文描述（better-*、seo-*、skills/ 下的一批）。
// 中文查询永远匹配不到，所以要一张小词表做跨语言扩展。
// 只放高频、歧义小的对，宁缺毋滥。
const GLOSSARY = {
  无障碍: ['accessibility', 'a11y', 'aria'],
  键盘: ['keyboard'],
  焦点: ['focus'],
  配色: ['color', 'colour', 'palette'],
  颜色: ['color', 'colour'],
  对比度: ['contrast'],
  排版: ['typography'],
  布局: ['layout'],
  间距: ['spacing', 'rhythm'],
  文案: ['copy', 'writing'],
  动效: ['motion', 'animation'],
  图标: ['icon'],
  组件: ['component'],
  状态: ['state'],
  交互: ['interaction'],
  计划: ['plan', 'planning'],
  测试: ['test', 'testing'],
  调试: ['debug', 'debugging'],
  审查: ['review'],
  评审: ['review'],
  提交: ['commit', 'pull request'],
  分支: ['branch'],
  技术: ['technical'],
  抓取: ['crawl', 'crawling'],
  索引: ['index', 'indexing'],
  速度: ['speed', 'performance'],
  性能: ['performance'],
  安全: ['security'],
  审计: ['audit'],
  部署: ['deploy', 'deployment'],
  测试驱动: ['tdd'],
  重构: ['refactor'],
  设计: ['design'],
  组件库: ['design system'],
  视频: ['video'],
  术语: ['jargon', 'plain language'],
  合同: ['contract'],
  磁盘: ['storage', 'disk'],
  清理: ['cleanup', 'clean'],
  报告: ['report'],
  论文: ['paper'],
  翻译: ['translation', 'translate'],
  水印: ['watermark'],
  音乐: ['music'],
  歌曲: ['song']
}

function queryTerms(words) {
  const terms = []
  const seen = new Set()
  // gloss 标记：翻译扩展出来的词是间接证据，命中名字时不能和原词同权
  const push = (text, weight, gloss = false) => {
    const k = text + '|' + weight
    if (seen.has(k)) return
    seen.add(k)
    terms.push({ text, weight, gloss })
  }
  for (const raw of words) {
    const w = raw.toLowerCase()
    if (!w) continue
    // 单个英文字符没有检索意义，但会命中几乎所有描述
    if (w.length < 2 && !/[\u4e00-\u9fff]/.test(w)) continue
    push(w, 1)
    // 中文二元组：让「去水印」能命中「去AI图片水印」
    if (/[\u4e00-\u9fff]/.test(w) && w.length >= 3) {
      for (let i = 0; i < w.length - 1; i++) {
        const bigram = w.slice(i, i + 2)
        if (/[\u4e00-\u9fff]{2}/.test(bigram)) push(bigram, 0.75)
      }
    }
    // 跨语言扩展：中文词换成英文同义词，权重打折
    for (const [zh, ens] of Object.entries(GLOSSARY)) {
      if (w.includes(zh)) for (const en of ens) push(en, 0.7, true)
    }
    // 反向：英文查询补中文。
    // 这里必须按词边界精确比，不能用 includes：
    // silicon 含 icon、latest 含 test、explain 含 plan，都会造出高分假阳性。
    for (const [zh, ens] of Object.entries(GLOSSARY)) {
      if (ens.some((en) => w === en || w.split(/[^a-z0-9]+/).includes(en))) push(zh, 0.6, true)
    }
  }
  return terms
}

// 稀有词比常用词更有信息量：「清理」出现在好几条描述里，「对账」只在一个名字里。
function termIdf(term, skills) {
  const needle = term.toLowerCase()
  let df = 0
  for (const s of skills) {
    const hay = `${s.name} ${s.description} ${(s.headings ?? []).join(' ')}`.toLowerCase()
    if (hay.includes(needle)) df++
    if (df > 60) break
  }
  return Math.log(1 + skills.length / (1 + df))
}

// 自述是"合集/入口/枢纽"的技能，多半是把人引到别的技能去，自己不做这件事。
const HUB_RE = /(合集|总入口|入口|编排|分发|路由|hub|dispatcher|collection of|entry point|router)/i

function score(skill, terms, idfMap, usage) {
  const name = skill.name.toLowerCase()
  const folder = skill.folder.toLowerCase()
  const cat = skill.category.toLowerCase()
  const desc = skill.description.toLowerCase()
  const heads = (skill.headings ?? []).join(' ').toLowerCase()
  const notFor = (skill.notFor ?? '').toLowerCase()
  let total = 0
  for (const { text: w, weight, gloss } of terms) {
    // 名字命中是最强证据；但翻译来的词只算半个证据——
    // 中文「审查」不该让 review-agent 压过名字里就有「合同」的技能。
    const nameEq = gloss ? 12 : 20
    const nameInc = gloss ? 8 : 10
    // 单字符只认整串相等：否则 "a" 会给几十个技能各加 10 分
    if (name === w) total += nameEq * weight
    else if (w.length > 1 && name.includes(w)) total += nameInc * weight
    if (folder.includes(w)) total += 6 * weight
    if (cat.includes(w)) total += 4 * weight
    // 描述/标题/「不适合」里的命中按稀有度打折：「清理」这种词不该压过「对账」
    const idf = idfMap.get(w) ?? 1.5
    const damp = Math.min(2.2, Math.max(0.25, idf / 1.6))
    if (desc.includes(w)) total += 3 * weight * damp
    if (heads.includes(w)) total += 2 * weight * damp
    if (notFor.includes(w)) total += 1 * weight * damp
  }
  total = Math.round(total)
  if (total === 0) return 0
  // 入口型技能降权：合集/枢纽的 description 往往直接写着任务词（"整站审计"），
  // 名字匹配又最重，于是它排到真正干活的技能前面。
  if (HUB_RE.test(desc)) total = Math.round(total * 0.85)
  // 读过的技能排前面：最多 +120%，十次封顶
  const uses = usage?.get(skill.name.toLowerCase())?.count ?? 0
  return uses > 0 ? Math.round(total * (1 + 0.12 * Math.min(uses, 10))) : total
}

// 正文兜底的打分：和元数据分开算，因为判据不同。
// 元数据命中看"名字里有没有"，正文命中只能看"出现了几个词、最长那个多长"——
// 正文很长，任何词都可能顺带出现一次，所以单个两字词不算数。
// 正文兜底的打分：和元数据分开算，因为判据不同。
// 元数据看"名字里有没有"，正文只能看"出现在哪、出现几次"——
// 一个词在 17k 字的正文里出现一次，几乎不构成证据。
function scoreBody(skill, terms, idfMap) {
  const body = skill.body
  if (!body) return 0
  let extra = 0
  let matched = 0
  let longest = 0
  let strong = false
  for (const { text: w, weight } of terms) {
    const at = body.indexOf(w)
    if (at < 0) continue
    const idf = idfMap.get(w) ?? 1.5
    extra += 3 * weight * Math.min(2.2, Math.max(0.25, idf / 1.6))
    matched++
    longest = Math.max(longest, w.length)
    // 开头 2000 字内出现，或全文出现两次以上，才算"这条技能真在讲这个"
    if (at < 2000) strong = true
    else if (body.indexOf(w, at + w.length) >= 0) strong = true
  }
  if (matched === 0) return 0
  if (matched < 2 && !(longest >= 4 && strong)) return 0
  if (extra < 3) return 0
  return Math.round(extra)
}

// 命中行：一行一个。路径不给——读技能要走 skill_read，那样才会记账。
// 省下来的正是每行 70 多个字符的路径。
function formatHit(s, score, uses, chars) {
  const desc = s.description.length > 90 ? s.description.slice(0, 87) + '…' : s.description
  const used = uses > 0 ? ` ·用过${uses}次` : ''
  // chars 是字符数，不是 token。这里必须换算，否则同一个技能在检索里显示 17.2k、
  // 在 digest 里显示 10.7k，两个数差了 1.6 倍，省 token 的账就没法算。
  const cost = chars ? ` ·全文≈${(chars / 1.6 / 1000).toFixed(1)}k` : ''
  const fam = s.family ? ` ·族:${s.family.name}(${s.family.count})` : ''
  return `- ${s.name} [${s.category}] ${score}${cost}${fam}${used}${desc ? ' — ' + desc : ''}`
}

// ---------------------------------------------------------------- 工具

function registerSearch(ctx, config) {
  ctx.tools.register(
    defineTool({
      name: 'skill_search',
      description:
        'Search the local skill library by keyword. Hits come back one line each with a context-cost ' +
        'label; weak matches are reported by name only. Cheap — run it at every task boundary.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Keywords, space separated. Chinese and English both work.',
        },
        limit: { type: 'number', description: 'Max hits (default from config).' },
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
        // 一次算好查询词的稀有度，避免每个技能重复统计
        const terms = queryTerms(words)
        const idfMap = new Map(terms.map((tm) => [tm.text, termIdf(tm.text, skills)]))
        const ranked = skills
          .map((s) => ({ skill: s, score: score(s, terms, idfMap, usage) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, (() => {
          // limit 传字符串/NaN/负数都不能让它变成 Infinity 或 0
          const wanted = Number(args.limit ?? config.maxResults ?? 8)
          return Math.max(1, Math.min(30, Number.isFinite(wanted) ? Math.trunc(wanted) : 8))
        })())

        // 头名 38 分、后面跟着 2 分的条目，那不是候选，是噪音——
        // 每条要花 30 多个 token，还稀释判断。低于头名 20% 的直接不显示。
        // 只在没显式指定 limit 时截断：显式要 20 条的人，不该只拿到 8 条。
        // （契约测试发现 limit=20 时召回被砍，而 README 没写这条收缩。）
        if (ranked.length > 1 && args.limit === undefined) {
          const top = ranked[0]
          const floor = Math.max(6, top.score * 0.2)
          const kept = ranked.filter((r) => r.score >= floor)
          ranked.length = 0
          ranked.push(...(kept.length ? kept : [top]))
        }

        const ledger = activeLine(exec)
        const prefix = ledger ? `[技能台账] ${ledger}` : null

        // 元数据完全没命中时，再翻正文。
        //
        // 两件事必须同时成立，否则正文匹配就是纯噪音：
        //   1. 一个词在多长的正文里出现过，几乎不构成证据；
        //   2. 出现在正文开头（技能通常先说清自己是干什么的），或者反复出现。
        //
        // 即使命中，也不把它当成"强匹配"返回——只报名字，让人自己判断。
        // 之前这里会把正文命中混进 ranked，结果一个词就顶掉了正常排序。
        if (ranked.length === 0) {
          const deep = []
          for (const s of skills) {
            const sc = scoreBody(s, terms, idfMap)
            if (sc > 0) deep.push({ skill: s, score: sc })
          }
          deep.sort((a, b) => b.score - a.score)

          if (deep.length) {
            const names = deep.slice(0, 5).map((r) => `${r.skill.name}(${r.score})`).join(', ')
            return [
              prefix,
              `没有元数据强匹配。正文里出现过这些词：${names}`,
              '只是线索，不算命中——用 skill_read 看一眼 digest 再决定，别直接照做。',
            ]
              .filter((x) => x !== null)
              .join('\n')
          }

          return (
            `No skill matched "${words.join(' ').slice(0, 60)}" among ${skills.length} indexed skills.\n` +
            'Try fewer or different keywords, or call skill_catalog to see the categories.'
          )
        }
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

        const shown = words.join(' ').slice(0, 60)
        const header = `Matched ${ranked.length} of ${skills.length} indexed skills for "${shown}${words.join(' ').length > 60 ? '…' : ''}":`
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
      description: 'List every skill grouped by category with a one-line summary. Use when keywords are unknown.',
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

        // 过滤之后还写全库总数，会让人以为这个分类有 172 个技能。
    const listed = [...groups.values()].reduce((n, arr) => n + arr.length, 0)
    const out = [`${listed} skills in ${groups.size} categories:`]
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
        "Read a skill by name. Default 'digest' is ~300 tokens (when-not-to-use, description, section " +
        "headings, bundled files); 'full' loads the whole SKILL.md (~4k). Read the digest first.",
      parameters: {
        name: { type: 'string', required: true, description: 'Skill name or folder name, case insensitive.' },
        mode: { type: 'string', description: "'digest' (default) or 'full'." },
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

        // 支持 "name @folder" 和 "name（folder）" 两种写法：
        // 重名时提示里给的就是这个格式，必须能原样贴回来。
        let raw = String(wanted).trim()
        let hint = ''
        const sepAt = raw.search(/[@（(]/)
        if (sepAt > 0) {
          hint = raw
            .slice(sepAt + 1)
            .replace(/[）)]$/, '')
            .trim()
            .toLowerCase()
          raw = raw.slice(0, sepAt).trim()
        }
        const key = raw.toLowerCase()

        // 先精确，再模糊。模糊命中必须唯一——
        // 以前 find 拿到哪个算哪个，"extract" 会静默返回 pdf-extract 并把记账记到它头上。
        let hit =
          skills.find(
            (s) => s.name.toLowerCase() === key && (!hint || s.folder.toLowerCase() === hint),
          ) ??
          skills.find((s) => s.folder.toLowerCase() === key && !hint)

        if (!hit) {
          // 只挡单字符："x" 能匹配到几乎所有技能。
          // 两字母的 mv / ai / ui 是常用缩写，砍掉它们会让 read 和 search 自相矛盾
          // （search 能列出 4 个 mv，read 却说没这个技能）。
          const partial =
            key.length < 2
              ? []
              : skills.filter(
                  (s) => s.name.toLowerCase().includes(key) || s.folder.toLowerCase().includes(key),
                )
          if (partial.length > 1) {
            // 同名不同目录时只给名字没法区分（ppt-master 就有两份）。
            // 格式必须能原样贴回来，所以用 @ 分隔并在文案里说清楚。
            const seen = new Map()
            for (const s of partial) seen.set(s.name.toLowerCase(), (seen.get(s.name.toLowerCase()) ?? 0) + 1)
            const names = partial
              .slice(0, 8)
              .map((s) => (seen.get(s.name.toLowerCase()) > 1 ? `${s.name} @${s.folder}` : s.name))
              .join(', ')
            return `"${wanted}" 匹配到多个技能：${names}。用完整名字，重名时写成 名字 @目录。`
          }
          hit = partial[0]
        }
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
        const mode = String(args.mode ?? 'digest').trim().toLowerCase()

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


// ---------------------------------------------------------------- 自动提示

// 每个 turn 的第一步入场前，拿用户这句话检索一次；有强命中就塞一行提示。
// 代价约 50 tokens，目的是消掉「模型没想到去查」这一类失败。
// 没有强命中就什么都不加——宁可漏，不可吵。

// 只有整句就是一个接续词才跳过。
// 以前是按首字判断，"再查一下字体裁剪""可以帮我做个 PPT"全被当成"继续"吞掉了。
const CONTINUATIONS = /^(继续|接着|然后呢?|好的?|嗯+|对|可以|行|ok|okay|go on|continue|yes|谢谢|多谢)[。.!！?？]*$/i

// 自动提示是否真的可用，要能被看见——静默关闭比没有更糟。
const hintStatus = { state: 'unknown', detail: '' }

// 只在这一轮第一次装配提示词时用一次，避免每步重复占用。
let pendingHint = null
const HINT_TTL = 60_000

function takeHint() {
  if (!pendingHint) return ''
  const { text, at } = pendingHint
  pendingHint = null
  // 只认刚放进去的那一条。`systemPrompt.context` 拿不到 agent 身份，
  // 做不到真正按会话隔离；把窗口压到 2 秒，至少不会把几十秒前的提示翻出来给别人用。
  if (Date.now() - at > 2000) return ''
  return text
}

function messageText(messages) {
  const parts = []
  for (const m of messages ?? []) {
    for (const block of m?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join(' ').trim()
}

function registerAutoHint(ctx, config) {
  if (config.autoHint === false) return

  // 注入消息这条路走不通：
  //   1. @deepseek-ai/dsh-llm 不暴露给插件，createUserMessage 拿不到；
  //   2. 自己构造 user 消息会被会话格式拒绝：
  //      "format v4 message requires a producer-owned source kind"，
  //      而且失败发生在持久化阶段，会把整个会话的那一轮写坏。
  // 所以改成不碰会话的通道：pre-step 只往内存放一句话，
  // 由 systemPrompt.context 在装配提示词时读走。渲染完即清空。

  const hinted = new Map() // sessionId -> Set(skill name)

  const prompt = ctx.get?.('systemPrompt')
  if (prompt?.context) {
    prompt.context({ name: 'skill-hint', order: 90, text: () => takeHint() })
    hintStatus.state = 'ok'
  } else {
    hintStatus.state = 'no-system-prompt'
    hintStatus.detail = '主机没有暴露 systemPrompt 服务'
  }

  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const decision = await next()
      try {
        if (decision.kind === 'reject' || payload.signal?.aborted || payload.step !== 1) return decision

        const text = messageText(decision.messages)
        // 下界不能是 4：中文最常用的就是 2-3 字（字体、水印、排版、小程序），
        // 卡在 4 等于把最常见的问法全排除了。
        if (text.trim().length < 2 || CONTINUATIONS.test(text.trim())) return decision

        const sessionId = String(payload.agent?.id ?? '')
        const skills = buildIndex(config, false)
        if (skills.length === 0) return decision

        const words = text.split(/[\s,，。；;？?！!]+/).filter(Boolean).slice(0, 8)
        const terms = queryTerms(words)
        const idfMap = new Map(terms.map((tm) => [tm.text, termIdf(tm.text, skills)]))
        const best = skills
          .map((s) => ({ skill: s, score: score(s, terms, idfMap, new Map()) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)[0]

        const minScore = config.autoHintMinScore ?? 14
        if (!best || best.score < minScore) return decision

        const seen = hinted.get(sessionId) ?? new Set()
        if (seen.has(best.skill.name)) return decision
        seen.add(best.skill.name)
        hinted.set(sessionId, seen)

        const cost = (best.skill.chars / 1.6 / 1000).toFixed(1)
        const hint =
          `[技能库] 可能有用的技能：${best.skill.name}（全文≈${cost}k）。` +
          `要按它做就 skill_read；不适用就忽略，不必回应这句。`

        pendingHint = { text: hint, at: Date.now() }
        hintStatus.state = 'ok'
        return decision
      } catch {
        // 提示失败绝不能让这一轮失败
        return decision
      }
    },
    { prepend: true },
  )
}
// ---------------------------------------------------------------- 停用与台账

function registerDrop(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'skill_drop',
      description:
        'Mark a loaded skill as no longer applicable when the task changes. Stops it being suggested ' +
        'again; does not free context — only compaction does.',
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

function registerActive(ctx, config) {
  ctx.tools.register(
    defineTool({
      name: 'skill_active',
      description: 'List skills loaded in this session with their context cost and age.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(_args, exec) {
        const hintLine =
          config?.autoHint === false
            ? '自动提示：已关闭（config.autoHint = false）'
            : hintStatus.state === 'ok' || hintStatus.state === 'manual'
              ? '自动提示：开（每轮第一步检索一次，强命中才注入一行）'
              : hintStatus.state === 'unknown'
                ? '自动提示：待首次触发时检测'
                : `自动提示：不可用（${hintStatus.detail || hintStatus.state}）`
        const active = activeOf(exec)
        if (active.size === 0) {
          return `本会话没有加载过技能。当前任务可以直接做，或先 skill_search 看有没有适用的。\n\n${hintLine}`
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
          '',
          hintLine,
        ].join('\n')
      },
    }),
  )
}

export function apply(ctx, config) {
  registerSearch(ctx, config)
  registerRead(ctx, config)
  registerCatalog(ctx, config)
  registerActive(ctx, config)
  registerDrop(ctx)
  registerAutoHint(ctx, config)
}
