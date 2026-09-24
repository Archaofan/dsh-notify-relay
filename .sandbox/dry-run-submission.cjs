/* Dry-run the submission's git mechanics, stopping BEFORE `gh pr create`.
 *
 * Everything up to the pull request has been verified across many rounds:
 * entry shape, repo age, asset liveness, screenshots, and the registry's own
 * ten validators. The fork -> branch -> push path has never actually run,
 * because the age bar refuses to let the script past the check. A bug there
 * would only surface inside the gate window, which is the one moment when
 * retrying is least convenient.
 *
 * So: do the real fork, the real clone, the real commit, the real push -- and
 * then stop. The branch is a script-owned artifact ("upstream main plus one
 * file") that the real submission force-pushes over anyway, so leaving it
 * behind is harmless and is in fact what a retry expects to find.
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ENTRY = process.argv[2]

/* Derive the entry filename the way the REGISTRY does (scripts/lib/entries.mjs,
 * slugFor): strip https://github.com/, take the first two path segments, and
 * replace '/' with '__'. The registry rejects any entry whose file basename
 * does not match that slug, so a dry run that names the file anything else is
 * testing a submission that would be refused. */
const entryText = fs.readFileSync(ENTRY, 'utf8')
const urlMatch = entryText.match(/^url:\s*(\S+)\s*$/m)
if (!urlMatch) { console.log('FAIL the entry declares no url: field'); process.exit(1) }
const url = urlMatch[1].trim().replace(/\/+$/, '')
if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(url)) {
  console.log(`FAIL the entry url is not an https://github.com/owner/repo link: ${url}`)
  process.exit(1)
}
const segs = url.replace(/^https:\/\/github\.com\//, '').split('/')
const ENTRY_NAME = `${segs[0]}__${segs[1]}.yml`
const BRANCH = 'add-dsh-notify-relay'
const UPSTREAM = 'awesome-dsh-plugin/awesome-dsh-plugin'
const GH = 'C:\\Program Files\\GitHub CLI\\gh.exe'

function sh(cmd, args, opts = {}) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) }
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || ''), code: e.status }
  }
}

let bad = 0
function step(label, r, extra) {
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (extra) console.log(`        ${extra}`)
  if (!r.ok) {
    console.log(`        ${r.out.split('\n').filter(Boolean).slice(0, 4).map((l) => '        ' + l).join('\n')}`)
    bad += 1
  }
  return r
}

console.log('=== submission mechanics dry run (stops before the PR) ===\n')
console.log(`  entry file will land as: data/plugins/${ENTRY_NAME}\n`)

const login = sh(GH, ['api', 'user', '--jq', '.login']).out.trim()
console.log(`  login: ${login}`)

/* 1. the fork. Idempotent: gh repo fork on an existing fork is a no-op. */
step('fork exists / is created', sh(GH, ['repo', 'fork', UPSTREAM, '--clone=false']))
const fork = sh(GH, ['repo', 'view', `${login}/awesome-dsh-plugin`, '--json', 'isFork,parent'])
const forkOk = fork.ok && JSON.parse(fork.out).isFork === true
console.log(`  ${forkOk ? 'ok  ' : 'FAIL'} fork is really a fork of upstream`)
if (!forkOk) bad += 1

/* 2. clone upstream main into a scratch dir. */
const scratch = path.join(require('node:os').tmpdir(), 'awesome-submit-dryrun')
fs.rmSync(scratch, { recursive: true, force: true })
step('clone upstream main', sh('git', ['clone', '--depth', '1', '--branch', 'main', `https://github.com/${UPSTREAM}.git`, scratch]))

const git = (args) => sh('git', ['-C', scratch, ...args])

/* 3. the fork remote, then the branch. */
step('add fork remote', git(['remote', 'add', 'fork', `https://github.com/${login}/awesome-dsh-plugin.git`]))
step('create the branch', git(['checkout', '-q', '-b', BRANCH]))

/* 4. the ONE file. Nothing else is touched -- the READMEs are generated from
 *    data/plugins/*.yml on main after the merge. */
fs.mkdirSync(path.join(scratch, 'data', 'plugins'), { recursive: true })
const dest = path.join(scratch, 'data', 'plugins', ENTRY_NAME)
fs.copyFileSync(ENTRY, dest)

const destBytes = fs.readFileSync(dest)
const srcBytes = fs.readFileSync(ENTRY)
const identical = Buffer.compare(destBytes, srcBytes) === 0
console.log(`  ${identical ? 'ok  ' : 'FAIL'} the entry lands byte-identical (${destBytes.length} B)`)
if (!identical) bad += 1

/* The staged tree must contain exactly one added file -- a stray README edit
 * or a .gitignore change would change what the PR actually is. */
const status = git(['status', '--porcelain'])
const lines = status.ok ? status.out.split('\n').filter(Boolean) : []
const others = lines.filter((l) => !l.includes(ENTRY_NAME))
const onlyOurs = lines.length === 1 && others.length === 0
console.log(`  ${onlyOurs ? 'ok  ' : 'FAIL'} exactly one file changes (${lines.length} total)`)
if (!onlyOurs) {
  console.log(`        ${others.slice(0, 5).join('\n        ')}`)
  bad += 1
}

step('stage the entry', git(['add', `data/plugins/${ENTRY_NAME}`]))

/* 5. commit, with the noreply address -- this lands in a public repo. */
const email = `${login}@users.noreply.github.com`
step('commit', git(['-c', `user.name=${login}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', 'Add dsh-notify-relay to Notifications and Integrations']))
const committed = git(['log', '--oneline', '-1'])
console.log(`        ${committed.out.trim()}`)
const author = git(['log', '-1', '--format=%ae'])
console.log(`        author: ${author.out.trim()} ${author.out.trim() === email ? 'ok' : '(expected ' + email + ')'}`)

/* 6. the force push the real submission performs. */
step('force push the branch to the fork', git(['push', '-q', '--force', 'fork', BRANCH]))

/* Confirm the push really landed, rather than trusting the exit code. */
const remote = git(['ls-remote', 'fork', BRANCH])
const remoteSha = remote.ok ? remote.out.split('\t')[0] : ''
const localSha = git(['rev-parse', 'HEAD']).out.trim()
const pushed = remoteSha && remoteSha === localSha
console.log(`  ${pushed ? 'ok  ' : 'FAIL'} the branch is on the fork (${remoteSha.slice(0, 8)})`)
if (!pushed) bad += 1

/* 7. verify the branch really is "upstream main plus one file" -- the claim the
 *    --force comment rests on. If it carried anything else, force-pushing it
 *    would silently drop someone's work. */
const files = git(['show', '--name-only', '--format=', 'HEAD'])
const fileList = files.ok ? files.out.split('\n').filter(Boolean) : []
console.log(`  ${fileList.length === 1 && fileList[0] === `data/plugins/${ENTRY_NAME}` ? 'ok  ' : 'FAIL'} the commit adds exactly one file: ${fileList.join(', ')}`)
if (fileList.length !== 1) bad += 1

/* 8. what `gh pr create` would send. */
const prBody = [
  'Adds one entry: data/plugins/Archaofan__dsh-notify-relay.yml',
  '',
  'An outbound notification rule center for DSH. Eight lifecycle events go',
  'through dedup, quiet hours and digest batching, then out to seven channels.',
  'Severity maps to the fields Bark, ntfy, Telegram and webhooks actually',
  'support; failed deliveries retry with jittered backoff and survive a restart;',
  'per-channel circuit breakers stop hammering a dead endpoint; and a self-check',
  'reports a degraded relay instead of going silent.',
  '',
  'Zero runtime dependencies, no build step, two source files, bilingual.',
].join('\n')
console.log(`\n  PR would be: title='Add dsh-notify-relay' base=main head=${login}:${BRANCH}`)
console.log(`  body: ${prBody.split('\n').length} lines, ${prBody.length} chars`)

console.log(`\n${bad === 0 ? 'OK -- the submission mechanics work end to end (PR not opened)' : `${bad} problem(s) in the submission mechanics`}`)
process.exit(bad === 0 ? 0 : 1)
