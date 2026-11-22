---
name: mini-stats
description: 统计代码行数和文件数：数一个目录里各语言有多少文件、多少行，判断项目规模有多大、主要用什么语言。
when-not-to-use: 需要精确的代码复杂度或圈复杂度分析时不要用它——这里只数行数，注释和空行也算在内。
---

# 数一数这个项目有多大

## 什么时候用

刚拿到一个陌生仓库，想先知道「它有多大、主要是什么语言」的时候。
不需要打开编辑器，也不需要装任何依赖。

## 怎么做

按扩展名分组统计，排除依赖目录和版本控制目录：

```powershell
$root = $args[0]
Get-ChildItem $root -Recurse -File |
  Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|dist|build)\\' } |
  Group-Object Extension |
  Sort-Object { ($_.Group | Measure-Object Length -Sum).Sum } -Descending |
  Select-Object -First 15 @{n='扩展名';e={$_.Name}},
    @{n='文件数';e={$_.Count}},
    @{n='总行数';e={ ($_.Group | ForEach-Object { (Get-Content $_.FullName -EA SilentlyContinue).Count } | Measure-Object -Sum).Sum }} |
  Format-Table -AutoSize
```

## 结果怎么读

- **行数最多但文件很少** → 可能是数据文件或生成代码，不代表工作量
- **`.md` 排第一** → 文档比代码多，先读文档
- **一个语言占 80% 以上** → 项目基本是单语言，不用准备多套工具链

## 注意

这里数的是**文本行**，含空行和注释。要评估规模用这个；要评估复杂度得另找工具。
