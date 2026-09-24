/**
 * dsh-notify-relay — regression gate.
 *
 * Two harnesses, and both must run in BOTH languages. The client half reads the
 * document language once at module scope, exactly like a real page (a page
 * cannot change language without a reload), so a build that only materializes
 * in Chinese proves nothing about the English UI.
 *
 *   host-harness.cjs   the fail-loud inject contract, the rule engine
 *                      (dedup / quiet hours / payload builders / redaction),
 *                      a real HTTP delivery to a loopback server, and five
 *                      broken-build variants.
 *   client-harness.cjs materialization against a strict fake ctx, the inject
 *                      contract, the settings.section thunk label across a
 *                      locale switch, dictionary key parity, the rendered
 *                      editor round-trip, and four broken-build variants.
 *
 * `expect: 'reject'` means the harness MUST exit 1 — that is how the gate
 * proves it can still fail. A harness that only ever passes is worthless.
 */
const { spawnSync } = require('child_process')

let failures = 0

/**
 * Run one Node script. `expect` is 'pass' (exit 0) or 'reject' (exit 1);
 * anything else — a crash, a timeout, an unexpected code — is a gate failure.
 */
function run(args, label, expect, extraEnv) {
  // NOTE: stdio must be 'inherit'. Under this harness's file sandbox a piped
  // child spawn fails with EPERM, so the child's output goes straight to our
  // console and the verdict is read from its exit code.
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 90000,
    killSignal: 'SIGKILL',
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  })
  const wanted = expect === 'reject' ? 1 : 0
  const ok = result.status === wanted
  console.log(`=> ${label}: exit ${result.status} -> ${ok ? (expect === 'reject' ? 'REJECTED' : 'PASSES') : 'WRONG'}`)
  if (!ok) {
    if (result.signal) console.log(`  (killed by ${result.signal})`)
    failures += 1
  }
  console.log('')
  return ok
}

console.log('=== dsh-notify-relay gate ===\n')

/* ---------------- host half ---------------- */

run(['.sandbox/host-harness.cjs', 'index.js'], 'host gate (zh)', 'pass')
run(['.sandbox/host-harness.cjs', 'index.js'], 'host gate (en)', 'pass', { HARNESS_LANG: 'en' })

/* ---------------- client half ---------------- */

run(['.sandbox/client-harness.cjs', 'client.js'], 'client gate (zh)', 'pass')
run(['.sandbox/client-harness.cjs', 'client.js'], 'client gate (en)', 'pass', { HARNESS_LANG: 'en' })

/* ---------------- the good build must be clean ---------------- */

run(['--check', 'index.js'], 'index.js parses', 'pass')
run(['--check', 'client.js'], 'client.js parses', 'pass')

/* ---------------- report ---------------- */

if (failures > 0) {
  console.log(`GATE FAIL — ${failures} step(s) wrong`)
  process.exit(1)
}
console.log('GATE OK')
process.exit(0)
