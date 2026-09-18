#Dream-RSI web UI installer (browser half of the sidebar panel).
#Links packages/client/ui-dream-rsi into the web profile's node_modules and
#inserts its row into the profile's cordis.patch.yml, so the web boot graph
#serves the panel bundle to the browser.
#
#Invoked by install.ps1 -WithWebUI; safe to run standalone:
#   powershell -File install-webui.ps1
param(
    # Where profiles live. Defaults to $env:DSH_HOME\profiles, else ~/.dsh/profiles.
    [string]$DshHome
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot

$clientPackage = Join-Path $repoRoot 'packages/client/ui-dream-rsi'
$clientBundle = Join-Path $clientPackage 'lib/client.js'
if (-not (Test-Path $clientBundle)) {
    Write-Error "Browser bundle missing ($clientBundle). Run 'pnpm build' in $repoRoot first."
}
$packageName = '@dreamrsi/dsh-client-ui-dream-rsi'

if (-not $DshHome) {
    $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
}
$profileDir = Join-Path $DshHome 'profiles\web'
$profileManifestPath = Join-Path $profileDir 'package.json'
$profilePatchPath = Join-Path $profileDir 'cordis.patch.yml'
if (-not (Test-Path $profileManifestPath)) {
    Write-Error "Web profile not found at $profileDir. Boot 'dsh web' once, then re-run."
}

# --- 1. link the package into the profile's node_modules ---------------------
$manifest = Get-Content $profileManifestPath -Raw | ConvertFrom-Json
$dependencies = @($manifest.PSObject.Properties | Where-Object { $_.Name -eq 'dependencies' })
if ($dependencies.Count -eq 0) {
    $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
$linkSpec = "link:$($clientPackage.Replace('\', '/'))"
$existing = $manifest.dependencies.PSObject.Properties[$packageName]
if ($existing -ne $null -and $existing.Value -eq $linkSpec) {
    Write-Host "Profile dependency already present: $packageName -> $linkSpec"
} else {
    if ($existing -ne $null) { $manifest.dependencies.PSObject.Properties.Remove($packageName) }
    $manifest.dependencies | Add-Member -NotePropertyName $packageName -NotePropertyValue $linkSpec
    $manifest | ConvertTo-Json -Depth 16 | Set-Content $profileManifestPath -Encoding UTF8
    Write-Host "Added profile dependency: $packageName -> $linkSpec"
}
Push-Location $profileDir
try {
    pnpm install --silent
    if ($LASTEXITCODE -ne 0) { Write-Error "pnpm install failed in $profileDir" }
} finally {
    Pop-Location
}

# --- 2. insert the composition row (idempotent) ------------------------------
$insert = @'

# Dream-RSI web UI: the sidebar campaign dashboard (browser half). Backed by
# the @dreamrsi/dsh-client-ui-dream-rsi package (linked into this profile);
# reads the session workspace's .dreamrsi/ store READ-ONLY.
- insert:
    - id: ui-dream-rsi
      name: '@dreamrsi/dsh-client-ui-dream-rsi'
'@
if (Test-Path $profilePatchPath) {
    $patch = Get-Content $profilePatchPath -Raw
    if ($patch -match [regex]::Escape("id: ui-dream-rsi")) {
        Write-Host "Profile patch already carries the ui-dream-rsi row: $profilePatchPath"
    } else {
        Add-Content -Path $profilePatchPath -Value $insert -Encoding UTF8
        Write-Host "Inserted ui-dream-rsi row into $profilePatchPath"
    }
} else {
    Set-Content -Path $profilePatchPath -Value $insert -Encoding UTF8
    Write-Host "Created $profilePatchPath with the ui-dream-rsi row"
}

Write-Host ''
Write-Host 'Web UI mounted. Restart `dsh web` (or let the live patch reload pick it up), then'
Write-Host 'open the right Sidebar guide page and pick "Dream-RSI campaign dashboard".'
