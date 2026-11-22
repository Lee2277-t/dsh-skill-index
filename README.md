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

按名字读某个技能的 `SKILL.md`，并且**记一次使用**。默认只给 digest：

```
skill_read({ name: "wechat-miniprogram-privacy-audit" })

# wechat-miniprogram-privacy-audit  [02-微信小程序]
全文 ≈0.6k tokens · C:\...\小程序隐私合规审计\SKILL.md

扫描微信小程序可能涉及隐私的接口、组件、声明与失败处理，形成带代码位置的待核对清单。...

## 结构
- 范围与依据
- 工作流程
- 失败处理与完成标准

## 附带文件（按需读，不用整份载入）
- scripts/privacy_audit.py  13.4KB

要照它做，调 skill_read({ name: "...", mode: "full" }) 读全文。
```

要照着做时再加 `mode: "full"`。


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

## 召回：中文不靠空格

中文查询常常整串写（"去水印"、"字体太大"），整词子串匹配会漏掉「去**AI图片**水印」这种名字。
这一版在匹配时补了两层：

1. **二元组**：`去水印` 会拆出 `去水`、`水印`，`水印` 命中名字即算命中，权重 0.75。
2. **章节标题**：`## 字体与排版规范` 这类标题也参与匹配，权重 2。
3. **正文兜底**：元数据几乎没命中时，才翻正文（权重 3，阈值同时降到 3）。`woff2`、`pyftsubset` 这类词通常只写在正文里。

效果（同一批查询）：

| 查询 | 改前 | 改后 |
|---|---|---|
| 去水印 | 0 命中 | `ai-image-watermark-removal` |
| 字体 / 字体太大 | 0 命中 | `webfont-subsetting` |
| woff2 | 0 命中 | `webfont-subsetting`（按正文命中） |
| 对账 / MV 分镜 / 小程序 隐私 | 正常 | 排名不变 |

正文兜底只在主匹配不足时启用，并且绕开"强匹配"闸门——否则它永远过不了元数据的阈值。

## `when-not-to-use` 约定字段

判断要不要用一个技能，最值钱的信息是**什么时候不该用**，但它不在标准字段里。
本插件认一个可选字段：

```yaml
---
name: webfont-subsetting
description: 网页字体按实际用字裁剪与缺字检查……
when-not-to-use: 不是字体设计或选型；不判断字体授权；缺字检查需要 ttf/otf 原件
---
```

`skill_read` 的 digest 会把它放在描述的**前面**，因为判断阶段先看这条。

只写一句、要具体（"不用于打包安装包、代码签名"），不要写"不适用于其他场景"这种套话——
套话等于没写，还占 token。
## 省了多少

对一个 172 个技能的库实测（`skill_search` 每次 5 条命中，`skill_read` 取 4 个样本）：

| 动作 | 改前 | 改后 | 省 |
|---|---|---|---|
| 检索输出（8 个查询合计） | 3,358 tokens | 2,416 tokens | **28%** |
| 单次检索（命中 5 条时） | ≈760 tokens | ≈455 tokens | **40%** |
| 判断要不要用一个技能 | 6,834 tokens（全文） | 1,452 tokens（digest） | **79%** |

省下来的地方很具体：

1. **不再输出路径。** 命中行从 3 行变 1 行，每行少 70 多个字符的路径。读技能要走 `skill_read`，那样才会记账——顺带把记账变成唯一入口。
2. **digest 代替全文。** 判断"这个技能适用吗"只需要描述 + 章节标题 + 附带文件清单，中位 310 tokens；照它做才需要 3,853 tokens 的全文。
3. **弱匹配不铺开。** 最高分不到阈值时只报名字，不列描述。硬读一个弱相关的技能，比不读更贵。

## 设计依据

这三步不是拍脑袋，是照着 **progressive disclosure** 的标准模型做的：

- 官方定义的三层：**Discovery**（启动时只载入 name 与 description）→ **Activation**（匹配后读完整 `SKILL.md`）→ **Execution**（按需执行附带脚本、读取 `references/`）。
- 参考：[Anthropic 工程博客](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) 与
  [Agent Skills 开放标准](https://agentskills.io/)（2025-12 公开）。

对照之后发现原版有三个不符合的地方，这一版补齐了：

| 环节 | 标准 | 原版 | 现在 |
|---|---|---|---|
| Discovery | 元数据要轻 | 每次 3 行带路径 | 一行 + 成本标注 |
| Activation | 匹配后载入 | 只能全量载入 | digest → full 两级 |
| Execution | 按需读附带文件 | 完全没提及 | digest 里列出 `references/` 与 `scripts/` |

标准里有一句话值得抄下来：**"Full instructions load only when a task calls for them, so agents can keep many skills on hand with only a small context footprint."**
172 个技能塞不进系统提示（那是每轮 2.6 万 tokens），但可以"放在手边"——这就是检索 + 两级加载的意义。
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