/* What do THIRD-PARTY marketplace plugins declare?
 *
 * session-suspend has always declared peerDependencies on dsh-tools and
 * dsh-home-paths; every `dsh plugin add` prints "missing peer" because the
 * profile's dependency tree does not carry them, even though Node resolves them
 * at runtime. notify-relay declared none and installed clean.
 *
 * I added the declaration to notify-relay. That is more honest -- it really does
 * import both -- but it also means the marketplace submission now prints a
 * warning where it did not before. Before keeping that, check what the rest of
 * the marketplace does: a convention followed by most third-party plugins is
 * worth more than my preference.
 *
 * Samples published entries from the registry and reads each repo's package.json
 * through the GitHub API, so nothing is cloned.
 */
const { execFileSync } = require('node:child_process')

const REGISTRY = process.argv[2]
const WANT = Number(process.argv[3] || 14)

const fs = require('node:fs')
const path = require('node:path')

/* Entries that ship a bundle and are not the deepseek org itself. */
const dir = path.join(REGISTRY, 'data', 'plugins')
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml'))

function field(text, key) {
  const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null
}

const cands = []
for (const f of files) {
  if (f.startsWith('deepseek-ai__')) continue
  const text = fs.readFileSync(path.join(dir, f), 'utf8')
  const url = field(text, 'url')
  const tarball = field(text, 'tarball')
  if (!url || !/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(url)) continue
  cands.push({ file: f, url, hasTarball: !!tarball })
}

/* Spread across the alphabet rather than the first N, which skew to one author. */
const step = Math.max(1, Math.floor(cands.length / WANT))
const sample = cands.filter((_, i) => i % step === 0).slice(0, WANT)

console.log(`=== what do third-party marketplace plugins declare? ===\n`)
console.log(`  ${cands.length} eligible entries, sampling ${sample.length}\n`)

function gh(args) {
  try {
    return { ok: true, out: execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') }
  }
}

let declares = 0
let onDshPeers = 0
let checked = 0
const rows = []

for (const c of sample) {
  const repo = c.url.replace('https://github.com/', '')
  const r = gh(['api', `repos/${repo}/contents/package.json`, '--jq', '.content'])
  if (!r.ok) { rows.push({ repo, state: 'no package.json' }); continue }
  let pkg
  try {
    pkg = JSON.parse(Buffer.from(r.out.trim(), 'base64').toString('utf8'))
  } catch {
    rows.push({ repo, state: 'unreadable' }); continue
  }
  checked += 1
  const peers = pkg.peerDependencies ? Object.entries(pkg.peerDependencies) : []
  const dshPeers = peers.filter(([k]) => k === '@deepseek-ai/dsh' || k.startsWith('@deepseek-ai/dsh-'))
  if (peers.length) declares += 1
  if (dshPeers.length) onDshPeers += 1
  rows.push({
    repo,
    state: peers.length ? 'declares' : 'none',
    dshPeers,
    isBundle: !!pkg.dsh?.bundle,
    engines: pkg.engines?.dsh,
  })
}

for (const r of rows) {
  if (r.state === 'no package.json' || r.state === 'unreadable') {
    console.log(`  (${r.state})  ${r.repo}`)
    continue
  }
  const mark = r.state === 'declares' ? 'PEERS  ' : 'none   '
  console.log(`  ${mark} ${r.repo.padEnd(46)} bundle=${r.isBundle ? 'y' : 'n'}`)
  if (r.dshPeers.length) console.log(`           dsh peers: ${r.dshPeers.map(([k, v]) => k + '@' + v).join(', ')}`)
  if (r.engines) console.log(`           engines.dsh: ${r.engines}`)
}

console.log(`\n  ${declares}/${checked} sampled third-party plugins declare peerDependencies`)
console.log(`  ${onDshPeers}/${checked} peer on a @deepseek-ai/dsh* package`)
