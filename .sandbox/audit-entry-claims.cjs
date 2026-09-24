/* Audit every factual claim in the marketplace entry against the shipped code.
 *
 * The entry is the one thing a stranger reads. Each sentence is a claim about
 * the plugin that a user can falsify in thirty seconds by installing it. The
 * registry's CI checks the YAML SHAPE -- allowed keys, parseable, README
 * regenerates -- and nothing about whether the description is true. So this
 * checks the claims, against the actual v0.3.3 tarball rather than the working
 * tree, because the tarball is what the entry points at.
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const TARBALL = 'https://github.com/Archaofan/dsh-notify-relay/releases/download/v0.3.3/dsh-notify-relay-0.3.3.tgz'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-audit-'))
const tgz = path.join(tmp, 'r.tgz')
execFileSync('powershell', ['-NoProfile', '-Command', `Invoke-WebRequest -Uri '${TARBALL}' -OutFile '${tgz}' -TimeoutSec 240`], { stdio: 'ignore' })
const unpacked = path.join(tmp, 'x')
fs.mkdirSync(unpacked, { recursive: true })
execFileSync('tar', ['-xzf', tgz, '-C', unpacked])
const pkg = path.join(unpacked, 'package')

const index = fs.readFileSync(path.join(pkg, 'index.js'), 'utf8')
const client = fs.readFileSync(path.join(pkg, 'client.js'), 'utf8')
const both = index + '\n' + client

let bad = 0
function claim(label, ok, evidence) {
  console.log(`  ${ok ? 'ok  ' : 'LIE '} ${label}`)
  if (evidence) console.log(`        ${evidence}`)
  if (!ok) bad += 1
}

/* Count entries inside a named exported array. A naive global regex for
 * `id: '...'` matches unrelated object literals elsewhere in the file (test
 * fixtures, command result shapes, self-check kinds) and produces a wrong
 * count -- the audit must parse the block it claims to be auditing.
 *
 * And the block must be the DECLARATION, not the first mention. indexOf found
 * the module-header comment that says "`status` prints `EVENT_KINDS.length`",
 * which sits ~70 lines above `export const EVENT_KINDS = [`; the next `[` after
 * that comment is an unrelated array, so the audit reported "EVENT_KINDS has 0"
 * against a tarball that has eight. Anchor on `header = [` instead. */
function countInBlock(source, header) {
  const m = source.match(new RegExp(`${header}\\s*=\\s*\\[`))
  if (!m) return null
  const open = m.index + m[0].length - 1
  let depth = 0
  let end = open
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '[') depth += 1
    else if (source[i] === ']') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  const block = source.slice(open, end)
  const ids = [...block.matchAll(/\bid\s*:\s*'([^']+)'/g)].map((m) => m[1])
  return [...new Set(ids)]
}

console.log('=== the marketplace entry\'s claims, against the shipped v0.3.3 ===\n')

/* 1. "eight DSH lifecycle events" */
const events = countInBlock(index, 'EVENT_KINDS') || []
claim('eight lifecycle events', events.length === 8, `EVENT_KINDS has ${events.length}: ${events.join(', ')}`)

/* 2. "seven channels" */
const channels = countInBlock(index, 'CHANNEL_KINDS') || []
claim('seven channels', channels.length === 7, `CHANNEL_KINDS has ${channels.length}: ${channels.join(', ')}`)

/* 3. dedup, quiet hours, digest batching */
claim('dedup', /dedup|duplicate/i.test(both))
claim('quiet hours', /quiet|免打扰|dnd/i.test(both))
claim('digest batching', /digest|batch/i.test(both))

/* 4. severity maps to real fields for bark/ntfy/telegram/webhook.
 * Checking that the channel NAME appears would pass on a comment. The claim is
 * that severity reaches a field that channel actually supports, so look for the
 * field each one really takes. */
const sev = /severity/i.test(both)
claim('severity concept exists', sev)
const sevFields = {
  bark: /call\s*:\s*'1'|volume\s*:\s*'10'/,
  ntfy: /priority\s*:\s*\{[^}]*critical[^}]*\}/,
  telegram: /disable_notification\s*:/,
  webhook: /severity\s*:\s*n\.severity/,
}
for (const [ch, re] of Object.entries(sevFields)) {
  const ok = re.test(both)
  claim(`severity maps a real field for ${ch}`, ok, ok ? '' : `no ${ch}-specific severity field found`)
}

/* 5. retry with jittered backoff, surviving restart */
claim('retry with jittered backoff', /jitter/i.test(both) && /backoff|retry/i.test(both))
claim('survives a restart', /persist|restart|resume|recover/i.test(both))

/* 6. per-channel circuit breakers */
claim('per-channel circuit breakers', /breaker/i.test(both) && /per[- ]?channel|each channel|channel breaker/i.test(both))

/* 7. self-check reports a degraded relay */
claim('self-check reports degradation', /self[- ]?check|selfcheck|health/i.test(both) && /degrad/i.test(both))

console.log(`\n${bad === 0 ? 'OK -- every claim in the entry is backed by the shipped code' : `${bad} claim(s) NOT backed by the shipped code`}`)
process.exit(bad === 0 ? 0 : 1)
