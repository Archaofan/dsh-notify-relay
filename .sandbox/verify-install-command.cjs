/* What install command will a user actually see?
 *
 * build-site.mjs folds the entry into a display string:
 *
 *   install: e.npm ? `dsh plugin --profile web add ${e.npm}` : (e.cmdTarball ?? e.cmdGit)
 *
 * We are not on npm, so the command is cmdTarball -- but only if the entry's
 * `tarball:` survives into tarballMap. That map is filtered by
 * data/tarballs.json verdicts, and that file is ABSENT from a fresh clone, so
 * the question is whether a missing-verdict build keeps the field. Reading the
 * source says yes (a verdict is only about the URL it was recorded against, and
 * "no verdict" means the probe has not run). Reading the source is not the same
 * as seeing the output.
 *
 * So: build, then read the generated detail page and plugins.json for our entry
 * and print the exact command a user would copy. If it ever fell back to
 * `github:owner/repo`, that installs from source -- fine for a zero-dependency
 * plugin, but a different artifact from the one the listing promises.
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const REGISTRY = process.argv[2]
const ENTRY_SRC = process.argv[3]
const ENTRY_NAME = 'Archaofan__dsh-notify-relay.yml'

function sh(cmd, args, opts = {}) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) }
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || ''), code: e.status }
  }
}

/* The entry must be committed, or the added-date derivation has no commit. */
const dest = path.join(REGISTRY, 'data', 'plugins', ENTRY_NAME)
fs.copyFileSync(ENTRY_SRC, dest)
sh('git', ['-C', REGISTRY, 'add', 'data/plugins/' + ENTRY_NAME])
sh('git', ['-C', REGISTRY, 'commit', '-q', '-m', 'seed entry'])

/* READMEs first: build-site parses entries out of the generated READMEs. */
sh('node', [path.join(REGISTRY, 'scripts', 'generate-readme.mjs')], { cwd: REGISTRY })
const build = sh('node', [path.join(REGISTRY, 'scripts', 'build-site.mjs')], {
  cwd: REGISTRY,
  env: { ...process.env, SKIP_PUBLISH_CHECKS: '1' },
})
if (!build.ok) {
  console.log('FAIL build-site.mjs did not run')
  console.log(build.out.split('\n').filter(Boolean).slice(0, 6).map((l) => '    ' + l).join('\n'))
  process.exit(1)
}

let bad = 0
function claim(label, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`)
  if (!ok) bad += 1
}

console.log('=== the install command the registry will show users ===\n')

/* 1. plugins.json -- the machine-readable field. */
const pj = path.join(REGISTRY, 'docs', 'plugins.json')
if (!fs.existsSync(pj)) { console.log('FAIL docs/plugins.json was not written'); process.exit(1) }
const doc = JSON.parse(fs.readFileSync(pj, 'utf8'))
const list = Array.isArray(doc) ? doc : doc.plugins
const ours = (list || []).find((e) => /dsh-notify-relay/.test(e.url || ''))
if (!ours) { console.log('FAIL our entry is not in the built plugins.json'); process.exit(1) }

console.log(`  plugins.json entry:`)
console.log(`    name:     ${ours.name}`)
console.log(`    owner:    ${ours.owner}`)
console.log(`    npm:      ${ours.npm}`)
console.log(`    tarball:  ${ours.tarball}`)
console.log(`    install:  ${ours.install}`)
console.log('')

claim('the entry declares a tarball', typeof ours.tarball === 'string' && ours.tarball.length > 0, ours.tarball)
claim('npm is null (we are not published there)', ours.npm === null || ours.npm === undefined, String(ours.npm))
claim(
  'install uses the tarball, not the github fallback',
  typeof ours.install === 'string' && /releases\/download\/v\d+\.\d+\.\d+\//.test(ours.install),
  ours.install,
)
claim(
  'the install command is well-formed',
  typeof ours.install === 'string' && /^dsh plugin --profile web add "https:\/\/github\.com\/Archaofan\/dsh-notify-relay\/releases\/download\/.+\.tgz"$/.test(ours.install),
  ours.install,
)

/* 2. The detail page a human reads. The command is rendered into HTML there. */
const detail = path.join(REGISTRY, 'docs', 'p', 'Archaofan', 'dsh-notify-relay', 'index.html')
if (fs.existsSync(detail)) {
  const html = fs.readFileSync(detail, 'utf8')
  const m = html.match(/dsh plugin --profile web add [^<"]*/)
  const rendered = m ? m[0] : ''
  claim('the detail page renders the same command', rendered.length > 0 && /releases\/download\/v\d+\.\d+\.\d+\//.test(rendered), rendered || '(none found)')
} else {
  claim('the detail page exists', false, `not found at ${path.relative(REGISTRY, detail)}`)
}

/* 3. The URL inside the command must be the release asset we actually shipped.
 *    Liveness is a separate fact, verified by the submission script's ranged
 *    GET; this checks the string names the current release asset and nothing
 *    else. Note the command ends with a closing quote, so allow it. */
claim(
  'the URL inside the command names the current release asset',
  /dsh-notify-relay-\d+\.\d+\.\d+\.tgz"?$/.test(ours.install || ''),
  ours.install,
)

console.log(`\n${bad === 0 ? 'OK -- users will be shown the tarball install command' : `${bad} problem(s)`}`)
process.exit(bad === 0 ? 0 : 1)
