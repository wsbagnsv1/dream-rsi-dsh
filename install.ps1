#Dream-RSI DSH installer (Windows PowerShell).
#Copies the agent preset into your DSH home and rewrites the plugin entry
#to an absolute path so the preset mounts from anywhere.
#
#Usage:
#   pnpm install              # once, in this repo root
#   pnpm build                # produce dist/index.js
#   powershell -File install.ps1              # default: copy-install
#   powershell -File install.ps1 -PrintOverlay # print a roots overlay instead
param(
    # Where presets live. Defaults to $env:DSH_HOME\.agent-presets, else ~/.dsh/.agent-presets.
    [string]$DshHome,
    # Print the agent-presets roots overlay instead of copying the preset.
    [switch]$PrintOverlay
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot

# --- locate the plugin entry -------------------------------------------------
$distEntry = Join-Path $repoRoot 'dist/index.js'
$srcEntry = Join-Path $repoRoot 'src/index.ts'
$useDist = Test-Path $distEntry
if (-not $useDist -and -not (Test-Path $srcEntry)) {
    Write-Error "Neither dist/index.js nor src/index.ts found. Run 'pnpm install && pnpm build' in $repoRoot first."
}
# Prefer the built entry; fall back to src (works when DSH runs from source via tsx).
$entry = if (Test-Path $distEntry) { $distEntry } else { $srcEntry }
$entryAbsolute = (Resolve-Path $entry).Path.Replace('\', '/')

Write-Host "Plugin entry: $entryAbsolute"

# --- target preset directory -------------------------------------------------
if (-not $DshHome) {
    $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
}
$presetTarget = Join-Path $DshHome '.agent-presets\dream-rsi'

if ($PrintOverlay) {
    Write-Host ''
    Write-Host 'Roots-discovery mode: add this row to your Web profile patch or a --patch overlay'
    Write-Host '(it only adds a preset discovery root; nothing is mounted into the baseline):'
    Write-Host ''
    Write-Host "- insert:"
    Write-Host "    - id: agent-presets"
    Write-Host "      name: '@deepseek-ai/dsh-agent-presets'"
    Write-Host "      config:"
    Write-Host "        default: standard   # restate YOUR deployment default; patch layers replace whole configs"
    Write-Host "        roots:"
    Write-Host "          - path: '$((Join-Path $repoRoot 'preset').Replace('\', '/'))'"
    Write-Host "            trust: system"
    Write-Host ''
    Write-Host "In roots mode no copy is made; the preset row resolves '../dist/index.js' relative to"
    Write-Host "this repo's preset/ directory, so keep dist/ built."
    exit 0
}

# --- copy + rewrite ----------------------------------------------------------
New-Item -ItemType Directory -Force -Path (Split-Path $presetTarget) | Out-Null
Copy-Item (Join-Path $repoRoot 'preset/dream-rsi') $presetTarget -Recurse -Force

$composition = Join-Path $presetTarget 'agent.cordis.yml'
$content = Get-Content $composition -Raw
# The shipped row is relative to the preset dir ('../../dist/index.js'); a copy
# has no dist beside it, so rewrite to the absolute entry path.
$content = $content -replace [regex]::Escape("'../../dist/index.js'"), ("'$entryAbsolute'")
Set-Content $composition $content -NoNewline

Write-Host ''
Write-Host "Installed: $presetTarget"
Write-Host "  entry:    $entryAbsolute"
Write-Host ''
Write-Host 'Next: (re)start DSH Web, open the new-session preset picker, choose "Dream-RSI".'
Write-Host 'Only sessions started on that preset get the seven dreamrsi_* tools; the baseline stays clean.'
Write-Host 'Note: the entry path is absolute - re-run this installer if you move this repository,'
Write-Host 'and re-run it after pulling plugin code changes (preset copies are snapshots).'
