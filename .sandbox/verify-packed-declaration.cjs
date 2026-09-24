/* Is notify-relay's new peerDependencies actually inside the packed tarball,
 * and does it still ship every file `files` promises?
 *
 * The declaration is the whole point of v0.3.3 -- without it the release is
 * indistinguishable from v0.3.2. And a pack that silently drops a file is the
 * failure mode that only shows up when a user installs it.
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const TARBALL = process.argv[2]
const EXPECTED = '>=0.1.6-alpha.1 <0.1.7 || >=0.1.7-alpha.1 <0.2.0-0'

let bad = 0
function claim(label, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`)
  if (!ok) bad += 1
}

if (!fs.existsSync(TARBALL)) { console.log(`FAIL no such tarball: ${TARBALL}`); process.exit(1) }

console.log(`=== inside the packed tarball: ${path.basename(TARBALL)} ===\n`)

const raw = execFileSync('tar', ['-xzOf', TARBALL, 'package/package.json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const pkg = JSON.parse(raw)

console.log(`    version:     ${pkg.version}`)
console.log(`    engines.dsh: ${pkg.engines?.dsh}`)
for (const [k, v] of Object.entries(pkg.peerDependencies || {})) console.log(`    peer ${k}: ${v}`)
console.log('')

claim('version is 0.3.3', pkg.version === '0.3.3', pkg.version)
claim('peerDependencies is present at all', !!pkg.peerDependencies && Object.keys(pkg.peerDependencies).length === 2, JSON.stringify(pkg.peerDependencies || {}))
claim('dsh-home-paths peer is the corrected range', pkg.peerDependencies?.['@deepseek-ai/dsh-home-paths'] === EXPECTED, String(pkg.peerDependencies?.['@deepseek-ai/dsh-home-paths']))
claim('dsh-tools peer is the corrected range', pkg.peerDependencies?.['@deepseek-ai/dsh-tools'] === EXPECTED, String(pkg.peerDependencies?.['@deepseek-ai/dsh-tools']))
claim('engines.dsh is the corrected range', pkg.engines?.dsh === EXPECTED, String(pkg.engines?.dsh))

/* Nothing else may have changed -- this is a metadata-only release. */
claim('dependencies is still empty', !pkg.dependencies || Object.keys(pkg.dependencies).length === 0, JSON.stringify(pkg.dependencies || {}))
claim('dsh.bundle manifest is intact', !!pkg.dsh?.bundle?.patch, JSON.stringify(pkg.dsh?.bundle || {}))
claim('dsh.client manifest is intact', !!pkg.dsh?.client?.platform, JSON.stringify(pkg.dsh?.client || {}))

const listing = execFileSync('tar', ['-tzf', TARBALL], { encoding: 'utf8' }).split('\n').map((l) => l.trim()).filter(Boolean)
const missing = (pkg.files || []).filter((f) => !listing.some((l) => l === `package/${f}` || l.startsWith(`package/${f}/`)))
claim('every file in `files` is in the tarball', missing.length === 0, missing.length ? missing.join(', ') : `${listing.length} entries, all present`)

/* index.js and client.js must be byte-identical to the working tree: this is a
 * metadata-only release, so any drift would mean an unintended code change. */
/* The working tree is two levels up from .sandbox/pack/, not three. */
const REPO = path.join(path.dirname(TARBALL), '..', '..')
const idx = execFileSync('tar', ['-xzOf', TARBALL, 'package/index.js'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const cli = execFileSync('tar', ['-xzOf', TARBALL, 'package/client.js'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const workIdx = fs.readFileSync(path.join(REPO, 'index.js'), 'utf8')
const workCli = fs.readFileSync(path.join(REPO, 'client.js'), 'utf8')
claim('index.js is unchanged from the working tree', idx === workIdx, `packed ${idx.length} vs working ${workIdx.length}`)
claim('client.js is unchanged from the working tree', cli === workCli, `packed ${cli.length} vs working ${workCli.length}`)

console.log(`\n${bad === 0 ? 'OK -- v0.3.3 ships the corrected declaration and nothing else changed' : `${bad} problem(s)`}`)
process.exit(bad === 0 ? 0 : 1)
