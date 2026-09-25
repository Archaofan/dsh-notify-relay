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

/* Read a log that may have been written by either redirection style.

   PowerShell's `>` / `*>` writes UTF-16LE with a BOM, so every character is
   followed by a NUL and a plain utf8 decode yields "t\0o\0k\0e\0n\0=\0..." --
   which the token regex then silently fails to match. The verifier used to
   read every log as utf8, so a log produced by a PowerShell redirection lost
   its token, the stale URL stood, and the run reported a stale token when the
   real fault was the decoder. Detect the encoding from the bytes instead. */
function readLogText(p) {
  const buf = fs.readFileSync(p)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le')
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8')
  /* No BOM: PowerShell's UTF-16LE output always carries one, but a redirected
   * stream that was truncated early may not. Judge by content. */
  let nuls = 0
  const sample = buf.subarray(0, Math.min(buf.length, 512))
  for (const b of sample) if (b === 0) nuls += 1
  if (nuls > sample.length / 4) return buf.toString('utf16le')
  return buf.toString('utf8')
}

/* The token changes on every restart, so never trust a remembered one.

   A URL handed in from an earlier run goes stale the moment the sandbox is
   restarted -- and a stale token does not fail loudly. The GUI serves an
   auth-error page with no sidebar and no buttons, so the run reports "sidebar
   footer button renders -- not found", which reads exactly like a broken plugin
   and is nothing of the kind. So when a URL is supplied, re-read the token from
   the newest boot log in the sandbox anyway and prefer it. */
function newestBootLog(root) {
  let best = null
  let bestMtime = 0
  for (const name of fs.readdirSync(root)) {
    if (!/^boot.*\.log$/.test(name)) continue
    const p = path.join(root, name)
    try {
      const st = fs.statSync(p)
      if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = p }
    } catch { /* a log held open can still be stat'ed; skip anything odd */ }
  }
  return best
}

let url
if (/^https?:\/\//.test(SOURCE)) {
  url = SOURCE
  const log = newestBootLog(SB)
  if (log) {
    try {
      const m = readLogText(log).match(/token=(\S+)/)
      if (m) {
        const fresh = `http://127.0.0.1:${PORT}/?token=${m[1].trim()}`
        if (fresh !== url) {
          console.log(`  (the supplied token was stale; re-read the live one from ${path.basename(log)})`)
          url = fresh
        }
      }
    } catch { /* the log is locked by the running sandbox; the supplied URL stands */ }
  }
} else {
  const log = readLogText(SOURCE)
  const m = log.match(/token=(\S+)/)
  if (!m) { console.log(`FAIL no token in ${SOURCE}`); process.exit(1) }
  url = `http://127.0.0.1:${PORT}/?token=${m[1].trim()}`
}

/* A stale token produces a page with no plugin surfaces at all, so make that
   distinguishable from a real regression before blaming the plugin. */
try {
  const probe = execFileSync(process.execPath, [
    path.join(PLUGIN, '.sandbox', 'e2e', 'probe-modals.mjs'), url, 'auth check',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (/sidebar footer button present: false/.test(probe)) {
    console.log('FAIL the GUI served a page with no sidebar at all -- the token is almost certainly stale')
    console.log('     (restart the sandbox and re-run; this is not a plugin failure)')
    process.exit(1)
  }
} catch { /* a non-zero probe is reported by the e2e runs themselves */ }

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
  const skips = (r.out.match(/^\s*SKIP\s/gm) || []).length
  claim(`${label} passes in a real browser`, passed,
    `${checks} checks, ${fails} failure(s)${skips ? `, ${skips} skipped` : ''}`)
  if (!passed) {
    (r.out || '').split('\n').filter((l) => /FAIL|Error|error/.test(l)).slice(0, 6).forEach((l) => console.log(`         ${l.trim()}`))
  }
  if (skips) {
    (r.out || '').split('\n').filter((l) => /^\s*SKIP\s/.test(l)).slice(0, 3).forEach((l) => console.log(`         ${l.trim()}`))
  }
}

console.log(`\n${bad === 0 ? `OK -- both releases activate and work in a real GUI on DSH ${dshPkg.version}` : `${bad} problem(s)`}`)
process.exit(bad === 0 ? 0 : 1)
