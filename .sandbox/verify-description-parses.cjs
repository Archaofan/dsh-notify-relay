/* Does the entry's description survive the YAML parse as written?
 *
 * contributing.md flags this as the common silent breakage:
 *
 *   "A description containing `: ` must be quoted -- otherwise YAML reads it as
 *    a nested key."
 *
 * The failure is quiet: the file still parses, the entry still lands, and the
 * listing shows a truncated or empty description. Nothing in pr-check.yml looks
 * at description CONTENT -- it checks the keys are allowed and the READMEs
 * regenerate.
 *
 * So: parse the entry with the registry's own reader and assert the descriptions
 * come back as the exact strings we wrote, in both locales, ending with a
 * period as the guide asks.
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

const dest = path.join(REGISTRY, 'data', 'plugins', ENTRY_NAME)
fs.copyFileSync(ENTRY_SRC, dest)

const probe = path.join(REGISTRY, '.probe-desc.mjs')
fs.writeFileSync(
  probe,
  [
    `import { readEntries } from './scripts/lib/entries.mjs'`,
    `const all = readEntries()`,
    `const e = all.find((x) => /notify-relay/.test(x.name || ''))`,
    `if (!e) { console.log('NOTFOUND'); process.exit(0) }`,
    `console.log('KEYS ' + JSON.stringify(Object.keys(e)))`,
    `console.log('EN ' + JSON.stringify(e.description?.en ?? null))`,
    `console.log('ZH ' + JSON.stringify(e.description?.zh ?? null))`,
    `console.log('EN_TYPE ' + typeof e.description?.en)`,
    `console.log('ZH_TYPE ' + typeof e.description?.zh)`,
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
  return line ? line.slice(k.length + 1) : ''
}

let bad = 0
function claim(label, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`)
  if (!ok) bad += 1
}

console.log("=== the description as the registry's parser sees it ===\n")

if (get('NOTFOUND') === '') {
  claim('our entry is found', true)
} else {
  claim('our entry is found', false, 'readEntries() did not return it')
}

const enType = get('EN_TYPE')
const zhType = get('ZH_TYPE')
claim('en parses as a STRING, not a nested map', enType === 'string', `typeof = ${enType}`)
claim('zh parses as a STRING, not a nested map', zhType === 'string', `typeof = ${zhType}`)

let en = null
let zh = null
try { en = JSON.parse(get('EN')) } catch { /* leave null */ }
try { zh = JSON.parse(get('ZH')) } catch { /* leave null */ }

claim('en is non-empty', typeof en === 'string' && en.trim().length > 0, en ? `${en.length} chars` : 'null')
claim('zh is non-empty', typeof zh === 'string' && zh.trim().length > 0, zh ? `${zh.length} chars` : 'null')

if (typeof en === 'string') {
  claim('en ends with a period (the guide asks for one line, period-terminated)', /\.$/.test(en.trim()), `...${en.slice(-40)}`)
  claim('en is a single line', !/\n/.test(en), /\n/.test(en) ? 'contains a newline' : 'no newline')
  claim('en carries no stray nested key', !/^[a-z]+:\s/.test(en), en.slice(0, 40))
  /* "Routes eight DSH lifecycle events" -- the DSH sits between the count and
   * the noun, so match on the count and the noun separately rather than as one
   * phrase. The first version of this regex demanded "eight lifecycle events"
   * and failed on text that was correct. */
  claim('en names eight events', /eight\b/i.test(en) && /lifecycle events/i.test(en), '')
  claim('en names seven channels', /seven channels/i.test(en), '')
}
if (typeof zh === 'string') {
  claim('zh ends with a full stop', /。$/.test(zh.trim()), `...${zh.slice(-30)}`)
  claim('zh is a single line', !/\n/.test(zh), /\n/.test(zh) ? 'contains a newline' : 'no newline')
  claim('zh really is Chinese', /[\u4e00-\u9fff]/.test(zh), /[\u4e00-\u9fff]/.test(zh) ? 'CJK present' : 'no CJK characters found')
  claim('zh carries the same counts', /八类/.test(zh) && /七个通道/.test(zh), '')
}

/* Both locales must describe the same plugin, not drift apart. */
if (typeof en === 'string' && typeof zh === 'string') {
  const enHas = (re) => re.test(en)
  const zhHas = (re) => re.test(zh)
  claim(
    'both locales mention the same channel count',
    enHas(/seven channels/) && zhHas(/七个通道/),
    '',
  )
  claim(
    'both locales mention severity mapping',
    enHas(/[Ss]everity maps/) && zhHas(/严重度映射/),
    '',
  )
}

console.log(`\n${bad === 0 ? 'OK -- the descriptions survive the parse as written, in both locales' : `${bad} problem(s)`}`)
process.exit(bad === 0 ? 0 : 1)
