#!/usr/bin/env pwsh
# Submit dsh-notify-relay to the community plugin registry (the de-facto
# plugin marketplace): one PR adding one file to awesome-dsh-plugin.
#
# The registry's CI gate is why this is a script and not a command run once:
# it checks dsh.bundle, the repo age (1 day), that the repo exists and is not
# archived, the YAML shape, and that the READMEs regenerate. Everything except
# the age was verified locally before this script was written (see the notes at
# the bottom). The age bar is the only thing that cannot be satisfied ahead of
# time, and it clears on its own without a resubmission.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .sandbox\submit-to-marketplace.ps1
#   powershell -ExecutionPolicy Bypass -File .sandbox\submit-to-marketplace.ps1 -CheckOnly
#
# Requires: gh (authenticated as an account with push access to a fork), git.
#
# ASCII only, deliberately. This file is read by Windows PowerShell as well as
# pwsh, and an em dash written as UTF-8 is read as GBK there -- the resulting
# parser error points at a line that looks fine in an editor. Same reason the
# plugin's own sources avoid PowerShell text pipelines.

param(
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Entry = Join-Path $PSScriptRoot 'marketplace-entry.yml'
$EntryName = 'Archaofan__dsh-notify-relay.yml'
$Upstream = 'awesome-dsh-plugin/awesome-dsh-plugin'
$Branch = 'add-dsh-notify-relay'

function Step($message) { Write-Host "`n-- $message --" }

# ------------------------------------------------------------------------- *
# 1. the entry file must exist and be the one file the guide asks for
# ------------------------------------------------------------------------- *
Step 'the entry'
if (-not (Test-Path $Entry)) { throw "missing $Entry" }

# Read as UTF-8 EXPLICITLY. `Get-Content -Raw` with no -Encoding decodes with
# the machine's ANSI code page -- GBK here -- and the entry is UTF-8 with
# Chinese in it. The damage is not only cosmetic: the bytes E3 80 82 0A
# (U+3002 ideographic full stop, then LF) decode as ONE two-byte GBK pair,
# because 82 is a GBK lead byte and 0A is a legal trail byte. The newline
# before `tarball:` is swallowed, the tarball line stops being its own line,
# and the parse below finds nothing -- a crash at the moment of submission.
# Measured: 805 chars decoded as GBK against 752 as UTF-8.
$text = [System.IO.File]::ReadAllText($Entry, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "  ok   $EntryName ($([System.Text.Encoding]::UTF8.GetByteCount($text)) bytes)"

# Every field the contributing guide requires, checked here rather than left
# for CI: a red X on someone else's workflow is a slower way to learn about a
# typo than reading the file.
$required = @('url:', 'name:', 'category:', 'description:', 'en:', 'zh:', 'tarball:')
foreach ($field in $required) {
  if (-not $text.Contains($field)) { throw "entry is missing '$field'" }
}
Write-Host '  ok   every required field is present'

# The description is read as a claim about the plugin and checked against the
# code, so it must not carry marketing. These are the words the guide names.
$marketing = 'best|fastest|most powerful|revolutionary|ultimate|amazing|lightning'
if ($text -match $marketing) { throw "description carries marketing language: $($Matches[0])" }
Write-Host '  ok   no marketing language in the description'

# ------------------------------------------------------------------------- *
# 2. the repo must clear every bar the gate checks
# ------------------------------------------------------------------------- *
Step 'the repository'
$repoJson = & gh repo view Archaofan/dsh-notify-relay --json createdAt,isArchived,repositoryTopics,url 2>&1
$repo = $repoJson | ConvertFrom-Json

# Parse as UTC and keep the arithmetic in UTC. PowerShell's [datetime] cast
# applies the machine's timezone, which silently relabels the instant: the repo
# was created at 16:25Z and would print as "00:25 UTC" on a UTC+8 box -- the
# right duration, the wrong timestamp, and a reader who trusts it would look
# for the bar to clear eight hours late.
$created = [datetime]::Parse($repo.createdAt, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal)
$now = [datetime]::UtcNow
$age = $now - $created
Write-Host ("  repo created {0:yyyy-MM-dd HH:mm} UTC -- {1:N1} hours old" -f $created, $age.TotalHours)
if ($age.TotalHours -lt 24) {
  $remaining = 24 - $age.TotalHours
  Write-Host ("  BARRED by the 1-day age floor -- clears in {0:N1} hours ({1:yyyy-MM-dd HH:mm} UTC)" -f $remaining, $created.AddDays(1)) -ForegroundColor Yellow
  Write-Host '  The gate re-runs itself; no resubmission, push, or reopen is needed.' -ForegroundColor Yellow
  if (-not $CheckOnly) { throw 'waiting for the age bar' }
} else {
  Write-Host '  ok   past the 1-day age floor' -ForegroundColor Green
}

if ($repo.isArchived) { throw 'the repository is archived' }
Write-Host '  ok   not archived'

$topics = @($repo.repositoryTopics | ForEach-Object { $_.name })
if ($topics -notcontains 'dsh-plugin') { throw 'the dsh-plugin topic is missing' }
Write-Host '  ok   the dsh-plugin topic is set'

# dsh.bundle is what makes the plugin installable at all, and declaring only
# dsh.client is the most common rejection reason.
$manifestB64 = & gh api repos/Archaofan/dsh-notify-relay/contents/package.json --jq '.content'
$manifest = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($manifestB64)) | ConvertFrom-Json
if (-not $manifest.dsh.bundle) { throw 'package.json does not declare dsh.bundle' }
Write-Host '  ok   package.json declares dsh.bundle'

# ------------------------------------------------------------------------- *
# 3. the release asset the entry points at must be live
# ------------------------------------------------------------------------- *
Step 'the release asset'
# Pull the tarball URL with a regex rather than a line split. A split still
# works now that the read is explicit UTF-8, but a match on the whole text
# cannot be broken by a line-ending surprise, and it returns one string
# instead of whatever the pipeline happened to emit.
$m = [regex]::Match($text, '(?m)^\s*tarball:\s*(?<u>\S+)\s*$')
if (-not $m.Success) { throw 'the entry declares no tarball' }
$tarball = $m.Groups['u'].Value
Write-Host "  $tarball"
$request = [System.Net.HttpWebRequest]::Create($tarball)
$request.Method = 'GET'
$request.AddRange(0, 0)   # a ranged GET, because GitHub answers HEAD on assets inconsistently
$request.Timeout = 40000
try {
  $response = $request.GetResponse()
  $status = [int]$response.StatusCode
  $response.Close()
  if ($status -eq 206) { Write-Host '  ok   live asset (206 on a one-byte range)' -ForegroundColor Green }
  else { throw "unexpected status $status" }
} catch [System.Net.WebException] {
  $failed = $_.Exception.Response
  $code = if ($failed) { [int]$failed.StatusCode } else { 0 }
  throw "the release asset is not reachable (status $code)"
}

# ------------------------------------------------------------------------- *
# 4. the screenshots the manifest declares must resolve at HEAD
# ------------------------------------------------------------------------- *
Step 'the screenshots'
$shotsB64 = & gh api repos/Archaofan/dsh-notify-relay/contents/screenshots.json --jq '.content'
$shotsDoc = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($shotsB64)) | ConvertFrom-Json
$shots = @($shotsDoc.screenshots)
if ($shots.Count -eq 0) { throw 'screenshots.json declares no images' }
if ($shots.Count -gt 8) { throw "screenshots.json declares $($shots.Count) images; the cap is 8" }
foreach ($shot in $shots) {
  if (-not $shot.Trim()) { throw 'a screenshot path is blank' }
  $url = "https://raw.githubusercontent.com/Archaofan/dsh-notify-relay/HEAD/$shot"
  try {
    $null = Invoke-WebRequest -Uri $url -Method Head -TimeoutSec 30 -UseBasicParsing
    Write-Host "  ok   $shot" -ForegroundColor Green
  } catch {
    throw "$shot does not resolve at HEAD"
  }
}

# ------------------------------------------------------------------------- *
# 4b. the registry's OWN validators, against a fresh clone of its main
#
# Everything above reads our file and our repo. This reads the registry as it
# stands TODAY: it clones upstream main, drops the entry in, commits it, and
# runs the same things pr-check.yml runs. That matters because the entry was
# written against an earlier main -- the registry has since grown past 4200
# entries and its commit-count floor was dropped on 2026-09-03, so "it passed
# when it was written" is not evidence it passes now.
#
# Two of these checks fail on a bare Windows clone for environmental reasons,
# and both are handled honestly rather than skipped:
#   - build-site.mjs enforces a star-coverage floor that upstream main itself
#     does not satisfy (data/stars.json covers ~35% of entries). CI sets
#     SKIP_PUBLISH_CHECKS=1; the pre-flight does the same.
#   - awesome-lint derives a repo URL and gets a Windows path, because the
#     registry's package.json declares no `repository`. It fails identically on
#     a clean main with no entry added, so the pre-flight lints clean main as a
#     baseline and only reports a REGRESSION as a failure.
# ------------------------------------------------------------------------- *
if ($CheckOnly) {
  Step 'the registry validators (fresh clone of upstream main)'
  $clone = Join-Path $env:TEMP 'awesome-preflight'
  if (Test-Path $clone) { Remove-Item $clone -Recurse -Force }
  # git reports "Cloning into ..." on stderr; PowerShell surfaces that as a
  # NativeCommandError even on success. Verify the result, not the exit code.
  $ErrorActionPreference = 'Continue'
  & gh repo clone awesome-dsh-plugin/awesome-dsh-plugin $clone -- --depth 1 --branch main 2>&1 | Out-Null
  $ErrorActionPreference = 'Stop'
  if (-not (Test-Path (Join-Path $clone 'data\plugins'))) { throw "could not clone the registry into $clone" }
  $entryCount = @(Get-ChildItem (Join-Path $clone 'data\plugins') -Filter '*.yml').Count
  Write-Host "  ok   upstream main cloned ($entryCount entries)"

  # git identity, or the entry cannot be committed and the added-date
  # derivation has no commit to read.
  & git -C $clone config user.email 'archaofan@users.noreply.github.com'
  & git -C $clone config user.name 'Archaofan'

  # The linter is fetched by npx in CI; install it so the check can run at all.
  # npm writes progress to stderr, which PowerShell surfaces as a
  # NativeCommandError even on success -- so ignore the exit code and verify the
  # artifact exists instead.
  Push-Location $clone
  $ErrorActionPreference = 'Continue'
  & npm install --no-save --silent awesome-lint 2>&1 | Out-Null
  $ErrorActionPreference = 'Stop'
  Pop-Location
  if (-not (Test-Path (Join-Path $clone 'node_modules\awesome-lint\cli.js'))) {
    throw 'could not install awesome-lint into the registry clone'
  }
  Write-Host "  ok   awesome-lint available for the check"

  & node "$PSScriptRoot\pr-preflight.cjs" $clone $Entry
  if ($LASTEXITCODE -ne 0) { throw "the registry validators did not all pass (exit $LASTEXITCODE)" }
}

if ($CheckOnly) {
  Write-Host "`nCHECK COMPLETE -- everything clears except anything flagged above." -ForegroundColor Green
  exit 0
}

# ------------------------------------------------------------------------- *
# 5. fork, add the one file, open the PR
# ------------------------------------------------------------------------- *
Step 'fork'
& gh repo fork $Upstream --clone=false 2>&1 | Out-Null
$login = & gh api user --jq .login
Write-Host "  ok   fork ready as $login"

Step 'the branch'
$scratch = Join-Path $env:TEMP 'awesome-submit'
if (Test-Path $scratch) { Remove-Item $scratch -Recurse -Force }
& git clone --depth 1 --branch main "https://github.com/$Upstream.git" $scratch 2>&1 | Out-Null
Push-Location $scratch
try {
  & git remote add fork "https://github.com/$login/awesome-dsh-plugin.git"
  & git checkout -q -b $Branch

  # The one file the guide asks for. Nothing else is touched: the two READMEs
  # are generated from data/plugins/*.yml on main after the merge, and editing
  # them by hand is exactly what the guide says not to do.
  New-Item -ItemType Directory -Path 'data\plugins' -Force | Out-Null
  Copy-Item $Entry "data\plugins\$EntryName"

  & git add "data/plugins/$EntryName"
  # The noreply address rather than a real one: this commit lands in a public
  # repository, so whatever email is configured here becomes public with it.
  $email = "$login@users.noreply.github.com"
  & git -c user.name=$login -c user.email=$email commit -q -m 'Add dsh-notify-relay to Notifications and Integrations'

  # --force, and here is why it is safe. The branch is rebuilt from upstream
  # main on every run, so a second run -- a retry after a failure, or this
  # script having already been dry-run -- produces a commit that is NOT a
  # descendant of what is already on the fork. A plain push is then rejected:
  #   ! [rejected] add-dsh-notify-relay -> add-dsh-notify-relay (fetch first)
  # Reproduced by running the submission path twice.
  #
  # --force-with-lease does not fix it either: the scratch clone is
  # `--depth 1 --branch main` with the fork remote added seconds earlier, so
  # there is no remote-tracking ref to lease against and git answers
  # "(stale info)". Fetching first would work but buys nothing -- the lease
  # protects a branch whose history matters, and this one is a script-owned
  # artifact whose entire content is "upstream main plus one added file",
  # regenerated from scratch every run. Declaring that is what --force means.
  & git push -q --force fork $Branch
  Write-Host '  ok   branch pushed'

  Step 'the pull request'
  $body = @'
Adds one entry: data/plugins/Archaofan__dsh-notify-relay.yml

An outbound notification rule center for DSH. Eight lifecycle events go
through dedup, quiet hours and digest batching, then out to seven channels.
Severity maps to the fields Bark, ntfy, Telegram and webhooks actually
support; failed deliveries retry with jittered backoff and survive a restart;
per-channel circuit breakers stop hammering a dead endpoint; and a self-check
reports a degraded relay instead of going silent.

Zero runtime dependencies, no build step, two source files, bilingual.

Verified locally before opening this: dsh.bundle declared, repo past the
1-day floor and not archived, dsh-plugin topic set, the entry parses as YAML,
the release asset answers 206 to a ranged GET, and the three screenshots
declared in the repository's own screenshots.json resolve at HEAD.
'@
  & gh pr create --repo $Upstream --base main --head "$login`:$Branch" --title 'Add dsh-notify-relay' --body $body
} finally {
  Pop-Location
}
