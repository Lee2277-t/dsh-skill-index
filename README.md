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

## 限制

- 关键词匹配，不是语义检索。中文同义词要自己给全。
- 只认 `SKILL.md` 这个约定。
- 只索引 frontmatter，不读正文。

## 许可

AGPL-3.0-only。