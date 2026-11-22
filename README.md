# dsh-skill-index

给 DeepSeek Harness 加两个工具，让 agent 找得到**没进系统提示**的技能。

## 为什么

agent 启动时只看得见自己那几十个技能的描述。你把几百个技能整理在别的目录，
它一个都不知道——于是每次都从零现写一套流程，而不是用你已经验证过的那套。

把上百条描述全塞进系统提示也不是办法：会稀释注意力，反而更难命中。

## 工具

### `skill_search`

按关键词检索技能库，返回命中的技能名、描述和 `SKILL.md` 的绝对路径。

```
skill_search({ query: "PPT 排版" })
```

```
Matched 5 of 171 indexed skills for "PPT 排版":

- ppt-master  [08-办公文档]  score=19
  生成可编辑 PPTX：复用模板、定向改稿、加备注旁白……
  D:\skills\08-办公文档\PPT原生生成与改稿\SKILL.md
```

命中后直接读那个 `SKILL.md` 就行。中英文关键词都支持。

### `skill_read`

按名字读某个技能的 `SKILL.md` 正文，并且**记一次使用**。

```
skill_read({ name: "ai-mv-production" })
```

名字或文件夹名都行，大小写不敏感。

为什么不用直接读文件：记账这件事必须有落点，而 agent 读一个技能的唯一目的就是用它是。
把「读」和「记」合成一步，排序就能靠真实使用数据变准，不需要额外工具调用，也不需要人手动维护。

### `skill_active`

看本会话加载了哪些技能、各占多少 token、多久之前读的：

```
本会话加载了 2 个技能，合计约 5.0k tokens：

  music-mv  [09-设计与创意]  3.1k tokens · 刚刚
  ai-mv-production  [09-设计与创意]  1.9k tokens · 3 分钟前
```

### `skill_drop`

判定某个技能对当前任务不再适用时停用它：

```
skill_drop({ name: "ai-mv-production", reason: "换成排版任务" })

已停用 ai-mv-production（1.9k tokens）。
从现在起不要再用它的流程、清单或判断标准。
注意：它的正文仍在上下文里，只有压缩才会真正释放这 1.9k token。
```

**这一步改变的是行为，不是上下文体积。** 技能正文已经进了上下文，本插件收不回来——
真释放要靠压缩。所以最省的做法不是"用完再删"，而是"别一次装太多"：

| 动作 | 成本 |
|---|---|
| `skill_search` | 300–600 tokens，只在换任务时发生 |
| `skill_read` 一个中位技能 | 3,850 tokens，**之后每轮都在** |
| `skill_drop` | ~200 tokens |

读 3 个"以防万一"的技能 ≈ 11k tokens 常驻，50 轮就是 55 万。
**搜索可以每次都做，加载只做一次。**

### `skill_catalog`

按分类列出全部技能，每条一句话。用在「我都有什么」这类问题上。

```
skill_catalog({ category: "translation" })
```

## 安装

```
dsh plugin add github:Lee2277-t/dsh-skill-index
```

或在插件市场的 Discover 里搜 `skill index`。

## 配置

```yaml
roots:
  - '~/.skills'
  - 'D:/work/skills'
maxResults: 8
refreshSeconds: 300
```

`roots` 支持 `~`、`$ENV`、`%ENV%`，可以给多个。索引会缓存 5 分钟，`skill_catalog({refresh:true})` 可强制重建。

## 一处细节：块标量

很多技能这么写描述：

```yaml
description: >
  第一行
  第二行
```

只抓 `description:` 那一行会得到 `>`，索引里就是空描述，永远检索不到。
这个插件认 `>`、`|`、`>-`、`|-` 四种写法，也会跳过 `_` 开头的存档目录。

## 换任务时会发生什么

`skill_search` 的输出前面会挂一行台账：

```
[技能台账] 已加载：ai-mv-production(1.9k)、music-mv(3.1k) —— 若本次任务与它们无关，先调 skill_drop 停用，不要沿用它的流程。
Matched 2 of 171 indexed skills for "MV 分镜":
```

台账只在**检索时**出现，也就是换任务的时刻，所以不构成每轮的固定开销。
所有停用的技能不再出现在台账里。

**会话之间是隔离的**：A 会话加载的技能不会出现在 B 会话的台账里。
## 检索会随使用变准

读过的技能在后续检索里加权，最多 +120%（十次封顶）：

```
读之前:   ai-mv-production > music-mv > jian-character-mv-director
读三次后: jian-character-mv-director > ai-mv-production > music-mv
```

账面记在 `~/.skill-hub/usage.json`：

```json
{
  "jian-character-mv-director": { "count": 3, "last": "2026-11-21T12:00:00.000Z" }
}
```

删掉这个文件就回到原始排序。它只影响顺序，不影响命中——没读过的技能依然能搜到。
## 限制

- 关键词匹配，不是语义检索。中文同义词要自己给全。
- 只认 `SKILL.md` 这个约定。
- 只索引 frontmatter，不读正文。

## 许可

AGPL-3.0-only。