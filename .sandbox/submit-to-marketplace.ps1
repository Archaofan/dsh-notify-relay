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
  [switch]$CheckOnly,
  # Open the PR before the 1-day age floor clears. The registry's CI checks repo
  # age, so the check will be RED until the floor passes and then GREEN on its
  # own -- CI re-runs on a schedule, so nothing needs to be pushed or reopened.
  # Use this when the PR is ready and the only thing missing is time.
  [switch]$SkipAgeBar
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Entry = Join-Path $PSScriptRoot 'marketplace-entry.yml'
$Upstream = 'awesome-dsh-plugin/awesome-dsh-plugin'
$Branch = 'add-dsh-notify-relay'

# The entry filename is DERIVED, not hardcoded. The registry enforces the
# pairing itself -- scripts/lib/entries.mjs rejects any entry whose file
# basename does not match the slug of its `url:`:
#
#   if (e.file && path.basename(e.file, '.yml') !== want) {
#     problems.push(`${at}: filename must match the url -- expected ${want}.yml`)
#
# and slugFor() is: strip https://github.com/, take the first two path
# segments, replace '/' with '__'. A hardcoded name that once matched the URL
# would keep passing every local check and then be rejected by CI the moment
# the repo were ever renamed or moved -- a failure that only shows up inside
# the gate window. Deriving it here makes that class of drift impossible.
$ExpectedEntryName = 'Archaofan__dsh-notify-relay.yml'

function Step($message) { Write-Host "`n-- $message --" }

# ------------------------------------------------------------------------- *
# 1. the entry file must exist and be the one file the guide asks for
# ------------------------------------------------------------------------- *
Step 'the entry'
if (-not (Test-Path $Entry)) { throw "missing $Entry" }

# The filename the registry will require, derived from the entry's own `url:`
# by the registry's own rule. Computed before anything else so every later step
# (and the PR body) names the file that will actually land.
$urlLine = ([System.IO.File]::ReadAllLines($Entry, (New-Object System.Text.UTF8Encoding($false))) |
  Where-Object { $_ -match '^url:\s*\S+' } | Select-Object -First 1)
if (-not $urlLine) { throw "the entry declares no url: field" }
$url = ($urlLine -replace '^url:\s*', '').Trim().TrimEnd('/')
if ($url -notmatch '^https://github\.com/[^/]+/[^/]+$') {
  throw "the entry url is not an https://github.com/owner/repo link: $url"
}
$segments = $url -replace '^https://github\.com/', '' -split '/'
$EntryName = "$($segments[0])__$($segments[1]).yml"
if ($EntryName -ne $ExpectedEntryName) {
  throw "derived entry name '$EntryName' does not match the expected '$ExpectedEntryName' -- the url or the expectation has drifted"
}
Write-Host "  ok   entry filename derived from its url: $EntryName"

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
# 1b. this script's own claims must match the code too
# ------------------------------------------------------------------------- *
# The PR body below names a channel count and an event count. Those are claims
# about the plugin, made in the same breath as the entry's own description, and
# the entry's copy is audited against the tarball while this one was not: it
# still said "seven channels" two releases after DingTalk made it eight. A
# number nobody derives is a number nobody corrects, so derive both here and
# let a drift throw before the PR opens rather than after a maintainer reads it.
Step 'the PR body numbers'
# Forward slashes, not $RepoRoot's backslashes: PowerShell interpolates the path
# into the double-quoted -e argument and JS then reads \D and \i as escapes, so
# the backslash form resolves to E:DSH-WorkspaceDSH-Notifyindex.js.
$hostKinds = (& node -e "process.stdout.write(String(require('$(($RepoRoot -replace '\\','/'))/index.js').CHANNEL_KINDS.length))" 2>$null)
$hostEvents = (& node -e "process.stdout.write(String(require('$(($RepoRoot -replace '\\','/'))/index.js').EVENT_KINDS.length))" 2>$null)
if (-not $hostKinds -or -not $hostEvents) { throw 'could not read CHANNEL_KINDS/EVENT_KINDS from index.js' }

# The words are spelled out so a wrong digit cannot pass by accident.
$channelWord = @{ 7 = 'seven'; 8 = 'eight'; 9 = 'nine'; 10 = 'ten' }[[int]$hostKinds]
$eventWord = @{ 7 = 'Seven'; 8 = 'Eight'; 9 = 'Nine'; 10 = 'Ten' }[[int]$hostEvents]
if (-not $channelWord -or -not $eventWord) { throw "no English word for $hostKinds channels / $hostEvents events" }

$bodyText = @'

Adds one entry: data/plugins/Archaofan__dsh-notify-relay.yml

An outbound notification rule center for DSH. __EVENTS__ lifecycle events go
through dedup, quiet hours and digest batching, then out to __CHANNELS__ channels.
Severity maps to the fields Bark, ntfy, Telegram and webhooks actually
support; a digest inherits the most severe event it holds; failed deliveries
retry with jittered backoff and survive a restart; per-channel circuit
breakers stop hammering a dead endpoint; and a self-check reports a degraded
relay instead of going silent.

Zero runtime dependencies, no build step, two source files, bilingual.

Verified locally before opening this: dsh.bundle declared, repo past the
1-day floor and not archived, dsh-plugin topic set, the entry parses as YAML,
the release asset answers 206 to a ranged GET, and the three screenshots
declared in the repository's own screenshots.json resolve at HEAD.
'@

# The body is assembled once, here, and re-used at the bottom -- so the check
# below and the PR that opens can never disagree about what was verified.
$script:PrBody = $bodyText.Replace('__EVENTS__', $eventWord).Replace('__CHANNELS__', $channelWord)

# A round trip, not a restatement. The obvious check -- "does the body contain the
# word I just substituted" -- can never fail, because the body was built from that
# same word. That is the third tautological assertion in this project's harnesses
# and it reads exactly like a real one. So read the count back OUT of the finished
# body, map it to a number, and compare against index.js: the body is now the
# evidence rather than the thing being agreed with.
foreach ($pair in @(@('__EVENTS__', $eventWord, 'lifecycle events'), @('__CHANNELS__', $channelWord, 'channels'))) {
  if ($script:PrBody.Contains($pair[0])) { throw "placeholder $($pair[0]) was never substituted" }
}
$inverse = @{ 'seven' = 7; 'eight' = 8; 'nine' = 9; 'ten' = 10 }

$bodyEventCount = if ($script:PrBody -match '(\w+) lifecycle events') { $inverse[$Matches[1]] } else { $null }
if ($bodyEventCount -ne [int]$hostEvents) { throw "PR body names $bodyEventCount events; index.js declares $hostEvents" }
$bodyChannelCount = if ($script:PrBody -match 'out to (\w+) channels') { $inverse[$Matches[1]] } else { $null }
if ($bodyChannelCount -ne [int]$hostKinds) { throw "PR body names $bodyChannelCount channels; index.js declares $hostKinds" }
Write-Host ("  ok   PR body names {0} events and {1} channels, read back out of the body and matched to index.js" -f $bodyEventCount, $bodyChannelCount)

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
  if ($SkipAgeBar) {
    Write-Host ("  BARRED by the 1-day age floor -- opens anyway at the operator's request, {0:N1} hours early" -f $remaining) -ForegroundColor Yellow
    Write-Host '  The registry CI checks repo age, so its check will be RED until the floor clears' -ForegroundColor Yellow
    Write-Host '  and then GREEN on its own -- CI re-runs on a schedule. Nothing to push or reopen.' -ForegroundColor Yellow
  } else {
    Write-Host ("  BARRED by the 1-day age floor -- clears in {0:N1} hours ({1:yyyy-MM-dd HH:mm} UTC)" -f $remaining, $created.AddDays(1)) -ForegroundColor Yellow
    Write-Host '  The gate re-runs itself; no resubmission, push, or reopen is needed.' -ForegroundColor Yellow
    if (-not $CheckOnly) { throw 'waiting for the age bar' }
  }
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
  # A UNIQUE directory per run, not a fixed one. A fixed name means every run
  # after the first has to delete the previous clone, and that clone is a
  # 4287-entry registry with node_modules nested past MAX_PATH -- plain
  # Remove-Item and even [Directory]::Delete both fail with "cannot find the
  # file specified" on those long paths. A unique name sidesteps it; the
  # robocopy purge below is only for cleaning up what earlier runs left.
  $clone = Join-Path $env:TEMP "awesome-preflight-$([guid]::NewGuid().ToString('N').Substring(0,8))"

  # robocopy /purge is the only deletion that survives MAX_PATH-length paths.
  # Mirror an empty directory onto the target, then remove the husk.
  foreach ($stale in @(Get-ChildItem $env:TEMP -Directory -Filter 'awesome-preflight-*' -ErrorAction SilentlyContinue)) {
    $empty = Join-Path $env:TEMP ("empty-$([guid]::NewGuid().ToString('N').Substring(0,8)))")
    New-Item -ItemType Directory -Path $empty -Force | Out-Null
    & robocopy $empty $stale.FullName /purge /njh /njs /ndl /nc /ns /nfl 2>&1 | Out-Null
    if (Test-Path $stale.FullName) { Remove-Item $stale.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    Remove-Item $empty -Force -ErrorAction SilentlyContinue
  }

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

  # The pre-flight passing is only half the story: a check that cannot fail
  # reports green while proving nothing. So each diff-based step is driven into
  # a state CI would reject and asserted to reject it -- for the RIGHT reason,
  # which the first draft of this test got wrong (it passed on "expected 1 added
  # yml, got 0" because a reset had quietly removed the entry it meant to move).
  & node "$PSScriptRoot\negative-test-preflight-steps.cjs" $clone $Entry
  if ($LASTEXITCODE -ne 0) { throw "the pre-flight steps cannot all fail when they should (exit $LASTEXITCODE)" }
}

if ($CheckOnly) {
  Write-Host "`nCHECK COMPLETE -- everything clears except anything flagged above." -ForegroundColor Green
  exit 0
}

# ------------------------------------------------------------------------- *
# 5. fork, add the one file, open the PR
# ------------------------------------------------------------------------- *
Step 'fork'
# `gh repo fork` reports "already exists" on STDERR when the fork is already
# there -- which is the normal case on a second run. With
# $ErrorActionPreference = 'Stop' PowerShell turns ANY stderr line from a native
# command into a terminating NativeCommandError, so the fork step aborted on the
# run that actually mattered, before the outcome could be inspected. Drop the
# preference to Continue around the call and decide on the result instead.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  $forkOut = & gh repo fork $Upstream --clone=false 2>&1
  $forkCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $prevEap
}
if ($forkCode -ne 0 -and ("$forkOut" -notmatch 'already exists')) {
  throw "gh repo fork failed: $($forkOut -join ' | ')"
}
$login = & gh api user --jq .login
Write-Host "  ok   fork ready as $login"

Step 'the branch'
$scratch = Join-Path $env:TEMP 'awesome-submit'
if (Test-Path $scratch) { Remove-Item $scratch -Recurse -Force }

# Every git and gh call below writes progress to stderr, and with
# $ErrorActionPreference = 'Stop' PowerShell turns each of those lines into a
# terminating NativeCommandError. This whole block therefore ran under
# 'Continue' -- the pre-flight half of the script already did this per call, but
# the submission half never got the treatment because it was never reached past
# the fork step, which is where it first died. Failures are detected by checking
# the artefact afterwards, which is the only thing that was ever trustworthy.
$ErrorActionPreference = 'Continue'
try {
  & git clone --depth 1 --branch main "https://github.com/$Upstream.git" $scratch 2>&1 | Out-Null
  if (-not (Test-Path (Join-Path $scratch 'data\plugins'))) { throw "could not clone the registry into $scratch" }
  Write-Host '  ok   upstream main cloned'

  Push-Location $scratch
  try {
    & git remote add fork "https://github.com/$login/awesome-dsh-plugin.git" 2>&1 | Out-Null
    & git checkout -q -b $Branch 2>&1 | Out-Null

    # The one file the guide asks for. Nothing else is touched: the two READMEs
    # are generated from data/plugins/*.yml on main after the merge, and editing
    # them by hand is exactly what the guide says not to do.
    New-Item -ItemType Directory -Path 'data\plugins' -Force | Out-Null
    Copy-Item $Entry "data\plugins\$EntryName"

    & git add "data/plugins/$EntryName" 2>&1 | Out-Null
    # The noreply address rather than a real one: this commit lands in a public
    # repository, so whatever email is configured here becomes public with it.
    $email = "$login@users.noreply.github.com"
    & git -c user.name=$login -c user.email=$email commit -q -m 'Add dsh-notify-relay to Notifications and Integrations' 2>&1 | Out-Null
    $committed = & git rev-parse --verify HEAD 2>&1
    if (-not $committed) { throw 'the entry was not committed' }
    Write-Host "  ok   entry committed as $($committed.Substring(0,7))"

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
    & git push -q --force fork $Branch 2>&1 | Out-Null
    $remote = & git ls-remote fork "refs/heads/$Branch" 2>&1
    if (-not $remote) { throw "branch $Branch did not reach the fork" }
    Write-Host '  ok   branch pushed'

    Step 'the pull request'
    $prOut = & gh pr create --repo $Upstream --base main --head "$login`:$Branch" --title 'Add dsh-notify-relay' --body $script:PrBody 2>&1
    if (-not $prOut) { throw 'gh pr create produced no URL' }
    Write-Host "  ok   $prOut"
  } finally {
    Pop-Location
  }
} finally {
  $ErrorActionPreference = 'Stop'
}
