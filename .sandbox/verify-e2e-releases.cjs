/* The real-browser e2e, for both plugins, on whichever sandbox you name.
 *
 * Everything else in this rig tests the plugin against a fake ctx, a fake DOM,
 * or a gate. None of that proves the plugin mounts into the official GUI, which
 * is the thing a user actually experiences. Only a real browser shows the slot
 * registry, the React reconciler and the settings page all at once.
 *
 * The two releases have never been e2e'd -- the code is byte-identical to the
 * version that was, so a re-run "would test the same bytes". That is an
 * inference. This runs it, on both runtimes.
 *
 * Usage: node verify-e2e-releases.cjs <sandboxRoot> <port> <bootLogOrUrl>
 *
 * The third argument may be a boot log to read the token from, or a full GUI
 * URL. Prefer the log when the sandbox is NOT running; a running sandbox holds
 * its log open with exclusive access and readFileSync fails on it, so pass the
 * URL then.
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const SB = process.argv[2]          // e.g. .sandbox  or  .sandbox-next
const PORT = process.argv[3]
const SOURCE = process.argv[4]

const PLUGIN = 'E:\\DSH-Workspace\\DSH-Plugin'
const NOTIFY = 'E:\\DSH-Workspace\\DSH-Notify'

let bad = 0
function claim(label, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`)
  if (!ok) bad += 1
}

/* The token changes on every restart, so never trust a remembered one. */
let url
if (/^https?:\/\//.test(SOURCE)) {
  url = SOURCE
} else {
  const log = fs.readFileSync(SOURCE, 'utf8')
  const m = log.match(/token=(\S+)/)
  if (!m) { console.log(`FAIL no token in ${SOURCE}`); process.exit(1) }
  url = `http://127.0.0.1:${PORT}/?token=${m[1]}`
}

const dshPkg = JSON.parse(fs.readFileSync(path.join(SB, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
console.log(`=== real-browser e2e on DSH ${dshPkg.version} (${SB}) ===\n`)

const CASES = [
  ['notify-relay v0.3.3', NOTIFY, '.sandbox\\e2e-notify.mjs'],
  ['session-suspend v0.2.5', PLUGIN, '.sandbox\\e2e\\e2e.mjs'],
]

for (const [label, cwd, script] of CASES) {
  console.log(`  ${label}`)
  const r = (() => {
    try {
      const out = execFileSync(process.execPath, [script, url], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { ok: true, out }
    } catch (e) {
      return { ok: false, out: (e.stdout || '') + (e.stderr || '') }
    }
  })()
  const passed = /E2E OK/.test(r.out)
  const checks = (r.out.match(/^\s*ok\s/gm) || []).length
  const fails = (r.out.match(/^\s*FAIL\s/gm) || []).length
  claim(`${label} passes in a real browser`, passed, `${checks} checks, ${fails} failure(s)`)
  if (!passed) {
    (r.out || '').split('\n').filter((l) => /FAIL|Error|error/.test(l)).slice(0, 6).forEach((l) => console.log(`         ${l.trim()}`))
  }
}

console.log(`\n${bad === 0 ? `OK -- both releases activate and work in a real GUI on DSH ${dshPkg.version}` : `${bad} problem(s)`}`)
process.exit(bad === 0 ? 0 : 1)
