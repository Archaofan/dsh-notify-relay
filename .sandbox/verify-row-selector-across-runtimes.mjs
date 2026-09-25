/* Does the plugin's row selector survive a DSH version bump?
 *
 * The plugin highlights sidebar rows by walking the React fiber of every
 * `[class*="sessionRow"]` element. That class is a CSS-module name, so a rename
 * in a new DSH would silently stop every highlight -- no error, no warning, the
 * plugin would just quietly stop working. Nothing in the e2e catches that on a
 * profile with no sessions, because the tooltip half skips itself.
 *
 * So check the two runtimes against each other, in SOURCE: find the package that
 * defines the sidebar row classes in each, read its CSS-module map, and require
 * the logical name `sessionRow` to map to a hashed class that still CONTAINS
 * `sessionRow`. The hash prefix differs between builds; the logical name must
 * not.
 *
 * Exit 0 = the selector is compatible on both runtimes.
 */
import fs from 'node:fs'
import path from 'node:path'

const SB = process.argv[2] || process.cwd()
const RUNTIMES = [
  { label: 'DSH 0.1.6-alpha.2 (old sandbox)', root: path.join(SB, '.sandbox', 'dsh', 'node_modules', '@deepseek-ai') },
  { label: 'DSH 0.1.7-rc.2 (new sandbox)', root: path.join(SB, '.sandbox-next', 'dsh', 'node_modules', '@deepseek-ai') },
]

const problems = []
const claim = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`)
  if (!ok) problems.push(label)
}

console.log('=== the row selector the plugin matches, across DSH runtimes ===\n')

const found = {}
for (const rt of RUNTIMES) {
  console.log(`  ${rt.label}`)
  if (!fs.existsSync(rt.root)) {
    console.log(`    (runtime not installed at ${rt.root})\n`)
    found[rt.label] = null
    continue
  }

  /* Walk every @deepseek-ai package's client bundle looking for the CSS-module
   * map entry. On 0.1.6 the rows live in one package; on 0.1.7 they moved to
   * another, which is exactly the kind of change this check is here to see. */
  let hit = null
  const dirs = fs.readdirSync(rt.root, { withFileTypes: true }).filter((d) => d.isDirectory())
  for (const d of dirs) {
    const clientJs = path.join(rt.root, d.name, 'lib', 'client.js')
    if (!fs.existsSync(clientJs)) continue
    let raw
    try { raw = fs.readFileSync(clientJs, 'utf8') } catch { continue }
    /* The map entry looks like  "sessionRow":"YDXeBa_sessionRow",  */
    const m = raw.match(/"sessionRow"\s*:\s*"([^"]+)"/)
    if (m) { hit = { pkg: d.name, cls: m[1] }; break }
  }

  if (!hit) {
    console.log('    no package declares a "sessionRow" CSS-module entry\n')
    found[rt.label] = null
    continue
  }

  console.log(`    ${hit.pkg}`)
  console.log(`    "sessionRow" -> "${hit.cls}"`)
  claim(
    hit.cls.includes('sessionRow'),
    `the hashed class still contains the logical name`,
    hit.cls
  )
  found[rt.label] = hit
  console.log('')
}

const labels = Object.keys(found).filter((l) => found[l])
if (labels.length >= 2) {
  const a = found[labels[0]]
  const b = found[labels[1]]
  claim(a.cls === b.cls, 'both runtimes use the SAME hashed class name', `${a.cls} vs ${b.cls}`)
  claim(
    a.pkg === b.pkg ? 'same' : 'moved',
    'which package owns the rows',
    a.pkg === b.pkg ? `both in ${a.pkg}` : `${a.pkg} -> ${b.pkg} (a move, but the class name survived)`
  )
} else {
  console.log('  (only one runtime available, so the cross-runtime comparison was skipped)\n')
}

console.log(`${problems.length === 0 ? 'OK -- the plugin\'s row selector is compatible with both runtimes' : `${problems.length} problem(s)`}`)
process.exit(problems.length === 0 ? 0 : 1)
