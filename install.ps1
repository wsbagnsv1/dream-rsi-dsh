#Dream-RSI DSH installer (Windows PowerShell).
#Copies the agent preset into your DSH home and rewrites the plugin entry
#to an absolute path so the preset mounts from anywhere.
#
#Usage:
#   pnpm install              # once, in this repo root
#   pnpm build                # produce dist/index.js + the web UI bundle
#   powershell -File install.ps1              # default: copy-install
#   powershell -File install.ps1 -PrintOverlay # print a roots overlay instead
#   powershell -File install.ps1 -WithWebUI    # also mount the web UI panel
#
#-WithWebUI links packages/client/ui-dream-rsi into the web profile's
#node_modules and inserts its row into the profile's cordis.patch.yml, so the
#browser boots the Dream-RSI sidebar panel (the preset row alone mounts only
#the package's host half; preset subtrees never reach the browser boot graph).
param(
    # Where presets live. Defaults to $env:DSH_HOME\.agent-presets, else ~/.dsh/.agent-presets.
    [string]$DshHome,
    # Print the agent-presets roots overlay instead of copying the preset.
    [switch]$PrintOverlay,
    # Also mount the web UI panel into the web profile (link + patch insert).
    [switch]$WithWebUI
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
    Write-Host "In roots mode no copy is made; the preset rows resolve '../../dist/index.js' and"
    Write-Host "'../../packages/client/ui-dream-rsi/lib/index.js' relative to this repo's preset/"
    Write-Host "directory, so keep both built (pnpm build)."
    exit 0
}

# --- copy + rewrite ----------------------------------------------------------
New-Item -ItemType Directory -Force -Path (Split-Path $presetTarget) | Out-Null
# Remove any previous install first: Copy-Item -Recurse into an EXISTING
# directory nests the source inside it (preset\dream-rsi\dream-rsi\...),
# which would leave the stale composition at the top level.
if (Test-Path $presetTarget) { Remove-Item $presetTarget -Recurse -Force }
Copy-Item (Join-Path $repoRoot 'preset/dream-rsi') $presetTarget -Recurse -Force

$composition = Join-Path $presetTarget 'agent.cordis.yml'
$content = Get-Content $composition -Raw
# The shipped rows are relative to the preset dir; a copy has no dist/ or
# packages/ beside it, so rewrite both to absolute paths.
$webuiEntry = Join-Path $repoRoot 'packages/client/ui-dream-rsi/lib/index.js'
$webuiAbsolute = (Resolve-Path $webuiEntry).Path.Replace('\', '/')
$content = $content -replace [regex]::Escape("'../../dist/index.js'"), ("'$entryAbsolute'")
$content = $content -replace [regex]::Escape("'../../packages/client/ui-dream-rsi/lib/index.js'"), ("'$webuiAbsolute'")
Set-Content $composition $content -NoNewline

Write-Host ''
Write-Host "Installed: $presetTarget"
Write-Host "  entry:    $entryAbsolute"
Write-Host "  webui:    $webuiAbsolute (host half; see -WithWebUI for the browser half)"

if ($WithWebUI) {
    & "$PSScriptRoot\install-webui.ps1" -DshHome $DshHome
}

Write-Host ''
Write-Host 'Next: (re)start DSH Web, open the new-session preset picker, choose "Dream-RSI".'
Write-Host 'Only sessions started on that preset get the seven dreamrsi_* tools; the baseline stays clean.'
if (-not $WithWebUI) {
    Write-Host 'The sidebar panel needs the browser half mounted too: re-run with -WithWebUI.'
}
Write-Host 'Note: the entry paths are absolute - re-run this installer if you move this repository,'
Write-Host 'and re-run it after pulling plugin code changes (preset copies are snapshots).'
