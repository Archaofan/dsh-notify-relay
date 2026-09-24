/* Negative tests for the three steps added to pr-preflight.cjs.
 *
 * A check that cannot fail is worse than no check: it reports green while
 * proving nothing. Each of the three new steps is driven into a state CI would
 * reject, and the step's own logic is run against it.
 *
 * NOTE the trap this script itself fell into first time round. `restore()`
 * resets to origin/main, which DISCARDS the locally-committed entry -- so a
 * later test that assumed the entry file was still on disk silently tested
 * nothing and "passed" with the verdict "expected 1 added yml, got 0". A
 * rejection for the wrong reason is the exact failure mode these tests exist
 * to catch, so the entry's bytes are captured up front and re-written where
 * each test needs them, and every verdict is asserted on its DETAIL, not just
 * on pass/fail.
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const REGISTRY = process.argv[2]
const ENTRY_SRC = process.argv[3]

function sh(cmd, args, opts = {}) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) }
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || ''), code: e.status }
  }
}
const g = (args) => sh('git', ['-C', REGISTRY, ...args])

let bad = 0
function expect(label, cond, detail) {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`)
  if (!cond) bad += 1
}

const baseRef = 'origin/main'
const ENTRY_NAME = 'Archaofan__dsh-notify-relay.yml'
const ENTRY_PATH = path.join(REGISTRY, 'data', 'plugins', ENTRY_NAME)
const ENTRY_BYTES = fs.readFileSync(ENTRY_SRC)

/* The three verdicts, verbatim from pr-preflight.cjs. */
function guardVerdict() {
  const count = (filter) => {
    const r = g(['diff', '--name-status', `--diff-filter=${filter}`, `${baseRef}...HEAD`, '--', 'data/plugins'])
    if (!r.ok) return { ok: false, n: 0 }
    return { ok: true, n: r.out.split('\n').filter((l) => l.trim().endsWith('.yml')).length }
  }
  const added = count('A')
  const removed = count('D')
  if (!added.ok || !removed.ok) return { ok: false, detail: 'diff failed' }
  if (removed.n > 2 && removed.n > added.n) {
    return { ok: false, detail: `deletes ${removed.n} entry files against ${added.n} added` }
  }
  if (added.n !== 1) return { ok: false, detail: `expected +1, got +${added.n}` }
  return { ok: true, detail: `+${added.n}/-${removed.n}` }
}

function strayVerdict() {
  const dir = path.join(REGISTRY, 'data', 'plugins')
  const stray = fs.readdirSync(dir).filter((f) => {
    const p = path.join(dir, f)
    return fs.statSync(p).isFile() && !f.endsWith('.yml')
  })
  return { ok: stray.length === 0, detail: stray.length ? `stray: ${stray.slice(0, 3).join(', ')}` : 'none' }
}

function placementVerdict() {
  const r = g(['diff', '--name-only', '--diff-filter=A', `${baseRef}...HEAD`, '--', 'data'])
  if (!r.ok) return { ok: false, detail: 'diff failed' }
  const added = r.out.split('\n').filter((l) => l.trim().endsWith('.yml'))
  const misplaced = added.filter((f) => !/^data\/plugins\/[^/]+\.yml$/.test(f.trim()))
  if (misplaced.length) return { ok: false, detail: `misplaced: ${misplaced.join(', ')}` }
  if (added.length !== 1) return { ok: false, detail: `expected 1 added yml, got ${added.length}` }
  return { ok: true, detail: added[0].trim() }
}

/* contributing.md: at most 3 entries per PR, checked before anything is
 * fetched. Our PR adds one; the point of the negative test is that the bar is
 * real, so seed four and confirm it trips. */
function countVerdict() {
  const r = g(['diff', '--name-only', '--diff-filter=A', `${baseRef}...HEAD`, '--', 'data/plugins'])
  if (!r.ok) return { ok: false, detail: 'diff failed' }
  const added = r.out.split('\n').filter((l) => l.trim())
  if (added.length > 3) return { ok: false, detail: `adds ${added.length} entries; CI rejects above 3` }
  return { ok: true, detail: `${added.length} added` }
}

/* Put the clone back to pristine upstream main. */
function restore() {
  g(['reset', '-q', '--hard', baseRef])
  g(['clean', '-qfd'])
}

/* Commit the entry in its correct place, so later tests start from the state a
 * real submission would be in. */
function seedEntry() {
  fs.mkdirSync(path.dirname(ENTRY_PATH), { recursive: true })
  fs.writeFileSync(ENTRY_PATH, ENTRY_BYTES)
  g(['add', 'data/plugins/' + ENTRY_NAME])
  g(['commit', '-q', '-m', 'seed entry'])
}

console.log('=== negative tests: each new step must be able to FAIL ===\n')

/* Baseline, from the state a real submission is in. */
seedEntry()
const b1 = guardVerdict()
const b2 = strayVerdict()
const b3 = placementVerdict()
expect('baseline guard passes', b1.ok, b1.detail)
expect('baseline stray passes', b2.ok, b2.detail)
expect('baseline placement passes', b3.ok, b3.detail)

/* 1. A stale fork: delete several existing entries. CI fails when removed > 2
 *    AND removed > added. Assert on the DETAIL so it cannot pass for the
 *    "expected +1, got 0" reason. */
const victims = fs.readdirSync(path.join(REGISTRY, 'data', 'plugins'))
  .filter((f) => f.endsWith('.yml') && f !== ENTRY_NAME)
  .slice(0, 4)
expect('found 4 entries to delete for the stale-fork case', victims.length === 4, `${victims.length} victims`)
for (const v of victims) fs.rmSync(path.join(REGISTRY, 'data', 'plugins', v))
g(['add', '-A'])
g(['commit', '-q', '-m', 'stale fork: drops entries'])
const s1 = guardVerdict()
expect('guard REJECTS a branch that deletes entries', !s1.ok && /deletes \d+ entry files/.test(s1.detail || ''), s1.detail)
restore()

/* 2. A stray non-yml file under data/plugins. readEntries() globs *.yml, so a
 *    file that loses its extension is skipped in silence. */
seedEntry()
fs.writeFileSync(path.join(REGISTRY, 'data', 'plugins', 'README'), 'stray')
const s2 = strayVerdict()
expect('stray check REJECTS a non-yml file under data/plugins', !s2.ok && /stray/.test(s2.detail || ''), s2.detail)
fs.rmSync(path.join(REGISTRY, 'data', 'plugins', 'README'))

/* 3. The entry one level too DEEP -- #3622's exact shape, which went green. */
const deep = path.join(REGISTRY, 'data', 'plugins', 'data', 'plugins')
fs.mkdirSync(deep, { recursive: true })
fs.writeFileSync(path.join(deep, ENTRY_NAME), ENTRY_BYTES)
fs.rmSync(ENTRY_PATH)
g(['add', '-A'])
g(['commit', '-q', '-m', 'misplaced: one level too deep'])
const s3 = placementVerdict()
expect('placement check REJECTS a file one level too deep', !s3.ok && /misplaced/.test(s3.detail || ''), s3.detail)
restore()

/* 4. The entry one level too SHALLOW: data/<owner>__<repo>.yml -- #3914's shape. */
seedEntry()
fs.writeFileSync(path.join(REGISTRY, 'data', ENTRY_NAME), ENTRY_BYTES)
fs.rmSync(ENTRY_PATH)
g(['add', '-A'])
g(['commit', '-q', '-m', 'misplaced: one level too shallow'])
const s4 = placementVerdict()
expect('placement check REJECTS a file one level too shallow', !s4.ok && /misplaced/.test(s4.detail || ''), s4.detail)
restore()

/* 5. Four entries in one PR -- CI rejects above three, before anything is
 *    fetched. */
seedEntry()
const others = fs.readdirSync(path.join(REGISTRY, 'data', 'plugins'))
  .filter((f) => f.endsWith('.yml') && f !== ENTRY_NAME)
  .slice(0, 3)
for (const o of others) fs.copyFileSync(path.join(REGISTRY, 'data', 'plugins', o), path.join(REGISTRY, 'data', 'plugins', 'zz-extra-' + o))
g(['add', '-A'])
g(['commit', '-q', '-m', 'four entries in one PR'])
const s6 = countVerdict()
expect('count check REJECTS four entries in one PR', !s6.ok && /adds \d+ entries/.test(s6.detail || ''), s6.detail)
restore()

/* 6. A branch that adds nothing at all -- the "merging lists nothing" case. */
seedEntry()
fs.rmSync(ENTRY_PATH)
g(['add', '-A'])
g(['commit', '-q', '-m', 'no entry added'])
const s5 = guardVerdict()
expect('guard REJECTS a branch that adds no entry', !s5.ok, s5.detail)
restore()

/* Final state: pristine upstream main, so the clone is reusable. */
const status = g(['status', '--porcelain'])
expect('clone restored to pristine upstream main', status.ok && status.out.trim() === '', (status.out || '').split('\n').slice(0, 3).join(' '))

console.log(`\n${bad === 0 ? 'OK -- all three new steps can fail, for the right reasons, and the clone is reusable afterwards' : `${bad} problem(s)`}`)
process.exit(bad === 0 ? 0 : 1)
