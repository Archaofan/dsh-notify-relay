param()

$nt = 'E:\DSH-Workspace\DSH-Notify'
$clone = Join-Path $env:TEMP 'awesome-preflight-run'

Write-Output '--- clone the registry main ---'
if (Test-Path $clone) { Remove-Item $clone -Recurse -Force -ErrorAction SilentlyContinue }
$ErrorActionPreference = 'Continue'
& 'C:\Program Files\GitHub CLI\gh.exe' repo clone awesome-dsh-plugin/awesome-dsh-plugin $clone -- --depth 1 --branch main 2>&1 | Out-Null
$ErrorActionPreference = 'Stop'
if (-not (Test-Path (Join-Path $clone 'data\plugins'))) { Write-Output '  FAILED to clone'; exit 1 }
$n = @(Get-ChildItem (Join-Path $clone 'data\plugins') -Filter '*.yml').Count
Write-Output ("  cloned, {0} entries" -f $n)

# The pre-flight commits the entry to derive its added-date from the commit, so
# the clone needs an identity. Without it git refuses and three diff-based steps
# fail for a reason that has nothing to do with the entry.
& git -C $clone config user.email 'archaofan@users.noreply.github.com'
& git -C $clone config user.name 'Archaofan'
Write-Output '  git identity set'

Write-Output ''
Write-Output '--- install awesome-lint (what CI uses) ---'
Push-Location $clone
$ErrorActionPreference = 'Continue'
& npm install --no-save --silent awesome-lint 2>&1 | Out-Null
$ErrorActionPreference = 'Stop'
Pop-Location
if (-not (Test-Path (Join-Path $clone 'node_modules\awesome-lint\cli.js'))) {
  Write-Output '  FAILED to install awesome-lint'
  exit 1
}
Write-Output '  available'

Write-Output ''
Write-Output '--- run the pre-flight ---'
Set-Location $nt
& node "$nt\.sandbox\pr-preflight.cjs" $clone "$nt\.sandbox\marketplace-entry.yml" 2>&1 | ForEach-Object { "  $_" }
$code = $LASTEXITCODE
Write-Output ("  exit=$code")
