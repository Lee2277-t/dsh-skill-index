# 三分钟上手
#
# 这个脚本只做两件事：
#   1. 告诉你 skill-index 会去哪些目录找技能，以及现在找到了什么
#   2. 如果一个技能都没有，给你建一个能跑通的起点
#
# 它不会删除、移动或覆盖任何已有文件。重复运行是安全的。
#
# 用法：  powershell -ExecutionPolicy Bypass -File .\setup.ps1

$ErrorActionPreference = 'Stop'

$roots = @(
  (Join-Path $HOME '.skills'),
  (Join-Path $HOME '.claude/skills'),
  (Join-Path $HOME '.codex/skills'),
  (Join-Path $HOME '.agents/skills'),
  (Join-Path $HOME '.config/skills'),
  (Join-Path (Get-Location) 'skills'),
  (Join-Path (Get-Location) '.agents/skills')
)

Write-Host ''
Write-Host 'skill-index 会扫描这些位置：' -ForegroundColor Cyan
$found = @()
foreach ($r in $roots) {
  if (Test-Path -LiteralPath $r -PathType Container) {
    $n = @(Get-ChildItem -LiteralPath $r -Recurse -Filter 'SKILL.md' -File -ErrorAction SilentlyContinue).Count
    $found += [pscustomobject]@{ Path = $r; Count = $n }
    Write-Host ("  [有] {0}  ({1} 个 SKILL.md)" -f $r, $n) -ForegroundColor Green
  } else {
    Write-Host ("  [无] {0}" -f $r) -ForegroundColor DarkGray
  }
}

$total = ($found | Measure-Object -Property Count -Sum).Sum
if ($null -eq $total) { $total = 0 }

if ($total -gt 0) {
  Write-Host ''
  Write-Host ("已经能找到 {0} 个技能，可以直接用了。" -f $total) -ForegroundColor Green
  Write-Host '在 Harness 里试一句： skill_search({ query: "你的关键词" })'
  Write-Host ''
  exit 0
}

# 一个都没有：给一个能立刻验证的起点
$target = Join-Path $HOME '.skills'
$example = Join-Path $PSScriptRoot 'examples/mini-stats'

Write-Host ''
Write-Host '这些位置里一个技能都没有。' -ForegroundColor Yellow

if (-not (Test-Path -LiteralPath $example -PathType Container)) {
  Write-Host ('找不到示例技能：{0}' -f $example) -ForegroundColor Red
  Write-Host '请确认这个脚本是在仓库根目录下运行的。'
  exit 1
}

if (Test-Path -LiteralPath $target -PathType Container) {
  Write-Host ('{0} 已存在但里面没有 SKILL.md，不覆盖。' -f $target) -ForegroundColor Yellow
} else {
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  Write-Host ('已创建 {0}' -f $target) -ForegroundColor Green
}

$dest = Join-Path $target 'mini-stats'
if (Test-Path -LiteralPath $dest) {
  Write-Host ('{0} 已存在，跳过（不覆盖你已有的内容）。' -f $dest) -ForegroundColor Yellow
} else {
  Copy-Item -LiteralPath $example -Destination $dest -Recurse
  Write-Host ('已放入示例技能：{0}' -f $dest) -ForegroundColor Green
}

Write-Host ''
Write-Host '下一步：' -ForegroundColor Cyan
Write-Host '  1. 在 Harness 里执行  skill_search({ query: "统计行数" })'
Write-Host '     应该能搜到 mini-stats 这个技能'
Write-Host '  2. 想加自己的技能，就在 ~/.skills 下建一个目录，放一个 SKILL.md：'
Write-Host ''
Write-Host '     ---' -ForegroundColor DarkGray
Write-Host '     name: 我的技能' -ForegroundColor DarkGray
Write-Host '     description: 一句话说清什么时候该用它' -ForegroundColor DarkGray
Write-Host '     when-not-to-use: 什么时候用了反而更糟' -ForegroundColor DarkGray
Write-Host '     ---' -ForegroundColor DarkGray
Write-Host '     正文写步骤。' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  3. 技能放在别的盘也行，配 roots 指过去即可。'
Write-Host ''
