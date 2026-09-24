/* Full local pre-flight of the marketplace PR against the CURRENT registry
 * main, not a snapshot from an earlier round. The registry has grown to 4287
 * entries since the entry was built, and the commit-count floor was dropped on
 * 2026-09-03, so what CI enforces today is not necessarily what it enforced
 * when the entry was written.
 *
 * Mirrors pr-check.yml exactly -- all ten steps, in CI's order:
 *   1. stale-fork guard        (entry files +added/-removed vs base)
 *   2. every entry file ends in .yml
 *   3. entry files live in data/plugins/ (added ymls, exactly one level deep)
 *   4. READMEs match data/plugins  (generate-readme.mjs --check)
 *   5. awesome-lint
 *   6. added-dates / capabilities / adopt-discussions tests
 *   7. build-site.mjs (locale parity, date derivation, templates)
 *
 * Steps 1-3 are diff-based and were missing from the first version of this
 * file, which claimed the mirror was exact while running seven of ten. The
 * stale-fork guard is the one that matters: a branch built from a stale main
 * shows up as a PR that deletes entries, and every content check still passes
 * because the deletion is symmetric across both locales.
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const REGISTRY = process.argv[2]
const ENTRY_SRC = process.argv[3]
const ENTRY_NAME = 'Archaofan__dsh-notify-relay.yml'

function sh(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    return { ok: true, out }
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || ''), code: e.status }
  }
}

const steps = []
function step(name, fn) {
  const r = fn()
  steps.push({ name, ok: r.ok, detail: r.detail })
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${name}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`)
}

console.log('=== marketplace PR pre-flight (against current registry main) ===\n')

/* 1 + 2. Entry placement. */
step('entry file ends in .yml and lives in data/plugins/', () => {
  const dest = path.join(REGISTRY, 'data', 'plugins', ENTRY_NAME)
  if (!ENTRY_NAME.endsWith('.yml')) return { ok: false, detail: 'name does not end in .yml' }
  fs.copyFileSync(ENTRY_SRC, dest)
  return { ok: true }
})

step('entry yml parses and declares only allowed keys', () => {
  const raw = fs.readFileSync(path.join(REGISTRY, 'data', 'plugins', ENTRY_NAME), 'utf8')
  const keys = raw.split('\n').filter((l) => /^[a-zA-Z]+:/.test(l)).map((l) => l.split(':')[0])
  const allowed = new Set(['url', 'name', 'category', 'description', 'tarball', 'file'])
  const extra = keys.filter((k) => !allowed.has(k))
  if (extra.length) return { ok: false, detail: `extra keys: ${extra.join(', ')}` }
  const needed = ['url', 'name', 'category', 'description', 'tarball']
  const missing = needed.filter((k) => !keys.includes(k))
  if (missing.length) return { ok: false, detail: `missing keys: ${missing.join(', ')}` }
  return { ok: true }
})

/* The build derives the added-date from the entry file's own first commit, so
 * it must be committed -- exactly as the real PR would have it.
 *
 * Idempotent: a pre-flight is re-runnable against a clone that already carries
 * the entry, and "already committed" satisfies the requirement just as well as
 * "committed it now". The first version only accepted the latter and failed on
 * a reused clone, because git answers "no changes added to commit" there --
 * which the `/nothing to commit/` guard did not match. */
step('entry committed (the build needs a commit to date it from)', () => {
  const g = (args) => sh('git', ['-C', REGISTRY, ...args])
  const inHead = g(['cat-file', '-e', `HEAD:data/plugins/${ENTRY_NAME}`])
  if (inHead.ok) return { ok: true, detail: 'already committed in HEAD' }
  g(['add', 'data/plugins/' + ENTRY_NAME])
  const c = g(['commit', '-m', 'Add dsh-notify-relay'])
  const benign = /nothing to commit|no changes added to commit|nothing added/.test(c.out)
  if (!c.ok && !benign) return { ok: false, detail: c.out.split('\n').filter(Boolean).slice(0, 3).join(' ') }
  const after = g(['cat-file', '-e', `HEAD:data/plugins/${ENTRY_NAME}`])
  if (!after.ok) return { ok: false, detail: 'commit reported success but the file is not in HEAD' }
  return { ok: true }
})

/* The next three steps are pr-check.yml's stale-fork guard, its stray-file
 * check, and its placement check. They are all diff-based and all three were
 * missing from this pre-flight, which claimed to mirror the workflow exactly.
 *
 * The stale-fork guard matters most: a fork built from a stale main shows up as
 * a PR that DELETES entries, and every content check still passes because the
 * deletion is symmetric across both locales. Our branch is cloned from upstream
 * main on every run, so it is +1/-0 by construction -- but "by construction" is
 * an assumption, and this is where it gets verified. */
const baseRef = 'origin/main'

step('stale-fork guard (entry files: +added -removed)', () => {
  const g = (args) => sh('git', ['-C', REGISTRY, ...args])
  const count = (filter) => {
    const r = g(['diff', '--name-status', `--diff-filter=${filter}`, `${baseRef}...HEAD`, '--', 'data/plugins'])
    if (!r.ok) return { ok: false, n: 0, out: r.out }
    const n = r.out.split('\n').filter((l) => l.trim().endsWith('.yml')).length
    return { ok: true, n }
  }
  const added = count('A')
  const removed = count('D')
  if (!added.ok || !removed.ok) {
    return { ok: false, detail: 'could not diff against ' + baseRef }
  }
  /* CI fails only when removed > 2 AND removed > added. A submission is +1/-0;
   * anything else means the branch was not built from current upstream main. */
  if (removed.n > 2 && removed.n > added.n) {
    return { ok: false, detail: `deletes ${removed.n} entry files against ${added.n} added — the fork looks stale` }
  }
  if (added.n !== 1) {
    return { ok: false, detail: `expected exactly +1 entry file, got +${added.n}` }
  }
  return { ok: true, detail: `+${added.n}/-${removed.n} against upstream main` }
})

step('no stray files under data/plugins (all end in .yml)', () => {
  /* readEntries() globs *.yml, so a file that loses its extension is skipped in
   * silence and every other check still passes. CI runs
   * `find data/plugins -type f ! -name '*.yml'`. */
  const dir = path.join(REGISTRY, 'data', 'plugins')
  if (!fs.existsSync(dir)) return { ok: false, detail: 'data/plugins missing' }
  const stray = fs.readdirSync(dir).filter((f) => {
    const p = path.join(dir, f)
    return fs.statSync(p).isFile() && !f.endsWith('.yml')
  })
  if (stray.length) return { ok: false, detail: `stray: ${stray.slice(0, 5).join(', ')}` }
  return { ok: true, detail: `${fs.readdirSync(dir).length} files, all .yml` }
})

step('added entry lands exactly one level deep', () => {
  /* CI greps the added files for `^data/plugins/[^/]+\.yml$`. A file one level
   * up or one too deep is never read by readEntries(), the READMEs regenerate
   * without it, and every other check passes -- the PR merges and lists
   * nothing. #3622 landed data/plugins/data/plugins/<name>.yml and went green. */
  const r = sh('git', ['-C', REGISTRY, 'diff', '--name-only', '--diff-filter=A', `${baseRef}...HEAD`, '--', 'data'])
  if (!r.ok) return { ok: false, detail: r.out.split('\n').slice(0, 3).join(' ') }
  const added = r.out.split('\n').filter((l) => l.trim().endsWith('.yml'))
  const misplaced = added.filter((f) => !/^data\/plugins\/[^/]+\.yml$/.test(f.trim()))
  if (misplaced.length) return { ok: false, detail: `misplaced: ${misplaced.join(', ')}` }
  if (added.length !== 1) return { ok: false, detail: `expected 1 added yml, got ${added.length}` }
  return { ok: true, detail: added[0].trim() }
})

/* `sh()` records `code` ONLY on failure -- a successful execFileSync leaves it
 * undefined. Reading `code !== 0` therefore reports every success as a
 * difference. Use `ok`, which is the only field that is set both ways. */
step('READMEs (yml-only PR: generator runs and the tree stays consistent)', () => {
  const before = sh('git', ['-C', REGISTRY, 'diff', '--quiet', 'origin/main...HEAD', '--', 'README.md', 'README.zh.md'])
  const touches = !before.ok
  if (touches) {
    const r = sh('node', [path.join(REGISTRY, 'scripts', 'generate-readme.mjs'), '--check'], { cwd: REGISTRY })
    return { ok: r.ok, detail: r.out.split('\n').filter(Boolean).slice(0, 3).join(' ') }
  }
  const gen = sh('node', [path.join(REGISTRY, 'scripts', 'generate-readme.mjs')], { cwd: REGISTRY })
  if (!gen.ok) return { ok: false, detail: gen.out.split('\n').filter(Boolean).slice(0, 3).join(' ') }
  /* Regenerating must have actually picked the new entry up. */
  const readme = fs.readFileSync(path.join(REGISTRY, 'README.md'), 'utf8')
  if (!/dsh-notify-relay/.test(readme)) {
    return { ok: false, detail: 'regenerated README does not mention our entry' }
  }
  return { ok: true, detail: 'regenerated; READMEs now carry the new entry' }
})

/* awesome-lint needs a resolvable GitHub repo URL. This registry's package.json
 * declares no `repository`, so the linter falls back to deriving one, and on a
 * Windows clone that yields a local path -- it fails IDENTICALLY on a clean
 * upstream main with no entry added (verified below). CI runs ubuntu-latest
 * with actions/checkout, where it passes. So the verdict is taken against a
 * clean-main baseline rather than in isolation: a failure that reproduces
 * without our entry is the environment, not the submission. */
step('awesome-lint (against a clean-main baseline)', () => {
  const cli = path.join(REGISTRY, 'node_modules', 'awesome-lint', 'cli.js')
  if (!fs.existsSync(cli)) return { ok: false, detail: 'awesome-lint not installed' }

  /* Stash our entry, lint clean main, restore. */
  const entryPath = path.join(REGISTRY, 'data', 'plugins', ENTRY_NAME)
  const stash = fs.readFileSync(entryPath)
  fs.rmSync(entryPath)
  const base = sh(process.execPath, [cli], { cwd: REGISTRY })
  fs.writeFileSync(entryPath, stash)

  const withEntry = sh(process.execPath, [cli], { cwd: REGISTRY })

  if (base.ok && withEntry.ok) return { ok: true, detail: 'clean on both' }
  if (!base.ok && !withEntry.ok) {
    const same = base.out === withEntry.out
    return {
      ok: true,
      detail: `environmental — fails on clean main too${same ? ' (identical output)' : ''}: ${base.out.split('\n').filter(Boolean)[0] || ''}`,
    }
  }
  return {
    ok: false,
    detail: `REGRESSION — clean main ${base.ok ? 'passes' : 'fails'} but our entry ${withEntry.ok ? 'passes' : 'fails'}: ${withEntry.out.split('\n').filter(Boolean).slice(0, 3).join(' ')}`,
  }
})

for (const t of ['added-dates', 'capabilities', 'adopt-discussions']) {
  step(`${t} tests`, () => {
    const r = sh('node', ['--test', path.join(REGISTRY, 'scripts', `${t}.test.mjs`)], { cwd: REGISTRY })
    return { ok: r.ok, detail: r.out.split('\n').filter((l) => /fail|not ok/i.test(l)).slice(0, 3).join(' ') }
  })
}

step('build-site.mjs (locale parity, date derivation, templates)', () => {
  /* SKIP_PUBLISH_CHECKS is what pr-check.yml sets. Without it build-site.mjs
   * enforces a star-coverage floor against data/stars.json, which upstream main
   * itself does not satisfy (1477 of 4287 entries have a star count) -- so a
   * bare run fails identically on a clean main with no entry added. Verified
   * that way; the floor is a deploy guard, not a PR guard. */
  const r = sh('node', [path.join(REGISTRY, 'scripts', 'build-site.mjs')], {
    cwd: REGISTRY,
    env: { ...process.env, SKIP_PUBLISH_CHECKS: '1' },
  })
  return { ok: r.ok, detail: r.out.split('\n').filter(Boolean).slice(-3).join(' ') }
})

step('our entry survives into the built plugins.json', () => {
  const p = path.join(REGISTRY, 'docs', 'plugins.json')
  if (!fs.existsSync(p)) return { ok: false, detail: 'docs/plugins.json not written' }
  const built = JSON.parse(fs.readFileSync(p, 'utf8'))
  const list = Array.isArray(built) ? built : built.plugins
  const hit = (list || []).find((e) => /dsh-notify-relay/.test(e.url || ''))
  if (!hit) return { ok: false, detail: 'entry absent from the built site data' }
  if (!hit.description || !hit.description.en) return { ok: false, detail: 'built entry has no en description' }
  if (!hit.tarball || !/releases\/download\/v0\.3\.2\//.test(hit.tarball)) {
    return { ok: false, detail: `unexpected tarball: ${hit.tarball}` }
  }
  /* The install command is what a user copies. build-site.mjs folds it as
   *   install: e.npm ? `... add ${e.npm}` : (e.cmdTarball ?? e.cmdGit)
   * We are not on npm, so it must be the tarball command. If the tarball ever
   * failed to survive into tarballMap it would silently fall back to
   * `github:owner/repo` -- which installs from source, a different artifact
   * from the one the listing promises. */
  if (hit.npm !== null && hit.npm !== undefined) {
    return { ok: false, detail: `expected npm null (we are not published), got ${hit.npm}` }
  }
  if (typeof hit.install !== 'string' || !/releases\/download\/v0\.3\.2\//.test(hit.install)) {
    return { ok: false, detail: `install command is not the tarball command: ${hit.install}` }
  }
  if (!/^dsh plugin --profile web add "https:\/\/github\.com\/Archaofan\/dsh-notify-relay\/releases\/download\/.+\.tgz"$/.test(hit.install)) {
    return { ok: false, detail: `install command is malformed: ${hit.install}` }
  }
  return { ok: true }
})

const bad = steps.filter((s) => !s.ok)
console.log(`\n${bad.length === 0 ? 'PRE-FLIGHT OK' : `PRE-FLIGHT FAILED — ${bad.length} step(s)`}`)
process.exit(bad.length === 0 ? 0 : 1)
