/* Validate our entry against the REGISTRY's own validator.
 *
 * The pre-flight runs the registry's test suites, but those test the validator
 * against fixtures -- not against our entry. This drops our file into a clone
 * and runs scripts/lib/entries.mjs's validateEntries() over the WHOLE catalog
 * including ours. That is where the filename/url pairing is actually enforced:
 *
 *   if (e.file && path.basename(e.file, '.yml') !== want) {
 *     problems.push(`${at}: filename must match the url -- expected ${want}.yml`)
 *   }
 *
 * Two things this catches that nothing else does:
 *   1. a filename that has drifted from the entry's url (the failure mode of a
 *      hardcoded name), and
 *   2. any problem OUR entry introduces into a 4287-entry catalog -- a category
 *      typo, a duplicate url, an unknown field -- rather than in isolation.
 *
 * Note readEntries() does NOT populate `problems`; validateEntries() computes
 * them. Calling the former and reading `.problems` silently reports "clean" for
 * everything, which is exactly the kind of check that passes for the wrong
 * reason. First version of this script did precisely that.
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const REGISTRY = process.argv[2]
const ENTRY = process.argv[3]

/* Name the file the way the REGISTRY requires, not whatever the local copy is
 * called. */
const entryText = fs.readFileSync(ENTRY, 'utf8')
const urlMatch = entryText.match(/^url:\s*(\S+)\s*$/m)
if (!urlMatch) { console.log('FAIL the entry declares no url: field'); process.exit(1) }
const url = urlMatch[1].trim().replace(/\/+$/, '')
const segs = url.replace(/^https:\/\/github\.com\//, '').split('/')
const ENTRY_NAME = `${segs[0]}__${segs[1]}.yml`

const dest = path.join(REGISTRY, 'data', 'plugins', ENTRY_NAME)
fs.copyFileSync(ENTRY, dest)

const probe = path.join(REGISTRY, '.validate-ours.mjs')
fs.writeFileSync(
  probe,
  [
    `import { readEntries, validateEntries, slugFor } from './scripts/lib/entries.mjs'`,
    `const want = slugFor(${JSON.stringify(url)})`,
    `const all = readEntries()`,
    `const ours = all.filter((e) => /notify-relay/.test(e.name || ''))`,
    `console.log('EXPECTED_SLUG ' + want + '.yml')`,
    `console.log('OUR_FILE ' + ${JSON.stringify(ENTRY_NAME)})`,
    `console.log('MATCH ' + (${JSON.stringify(ENTRY_NAME)} === want + '.yml'))`,
    `for (const e of ours) console.log('ENTRY ' + JSON.stringify({ name: e.name, cat: e.category, file: e.file }))`,
    `const problems = validateEntries(all)`,
    `const mine = problems.filter((p) => /notify-relay/.test(p))`,
    `for (const p of mine) console.log('OUR_PROBLEM ' + p)`,
    `console.log('TOTAL_ENTRIES ' + all.length)`,
    `console.log('PROBLEM_ENTRIES ' + problems.length)`,
    `for (const p of problems.slice(0, 5)) console.log('PROBLEM ' + p)`,
  ].join('\n'),
)

let out
try {
  out = execFileSync(process.execPath, [probe], { cwd: REGISTRY, encoding: 'utf8' })
} finally {
  fs.rmSync(probe, { force: true })
  fs.rmSync(dest, { force: true })
}

console.log(out)

const get = (k) => {
  const line = out.split('\n').find((l) => l.startsWith(k + ' '))
  return line ? line.slice(k.length + 1).trim() : ''
}

let bad = 0
function claim(label, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`)
  if (!ok) bad += 1
}

console.log("=== our entry, validated by the registry's own validator ===\n")
claim('the registry derives the same slug we do', get('MATCH') === 'true', `expected ${get('EXPECTED_SLUG')}, ours is ${get('OUR_FILE')}`)
const entryLines = out.split('\n').filter((l) => l.startsWith('ENTRY '))
claim('our entry is found exactly once in the catalog', entryLines.length === 1, `${entryLines.length} match(es)`)
if (entryLines.length === 1) {
  const e = JSON.parse(entryLines[0].slice(6))
  claim('its category is notify', e.cat === 'notify', e.cat)
}
const ourProblems = out.split('\n').filter((l) => l.startsWith('OUR_PROBLEM ')).map((l) => l.slice(12))
claim('the registry validator reports no problems for it', ourProblems.length === 0, ourProblems.join(' | ') || 'clean')
claim('the catalog parses as a whole', Number(get('TOTAL_ENTRIES')) > 4000, `${get('TOTAL_ENTRIES')} entries`)
claim('our entry introduces no new problem entries', Number(get('PROBLEM_ENTRIES')) === 0, `${get('PROBLEM_ENTRIES')} problem entry(ies) in the whole catalog`)

console.log(`\n${bad === 0 ? "OK -- the registry's own validator accepts our entry" : `${bad} problem(s)`}`)
process.exit(bad === 0 ? 0 : 1)
