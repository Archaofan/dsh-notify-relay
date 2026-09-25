/* Bump notify-relay to 0.4.0 and bring the channel lists up to date.
 *
 * Deliberately NOT done with ConvertTo-Json: that cmdlet re-serialises the
 * whole document (indent, spacing, \u0027 escapes) and rewrites all 74 lines,
 * which turns a two-word version bump into an unreviewable diff. Exact string
 * replacement keeps the diff to what actually changed.
 */
const fs = require('node:fs')
const path = require('node:path')

const file = path.join(__dirname, '..', 'package.json')
const raw = fs.readFileSync(file, 'utf8')

const edits = [
  ['"version": "0.3.3"', '"version": "0.4.0"'],
  [
    '外联到 Bark/Server酱/Telegram/企业微信/飞书/ntfy/通用 webhook。',
    '外联到 Bark/Server酱/Telegram/企业微信/飞书/钉钉/ntfy/通用 webhook。',
  ],
  [
    '严重度分级（Bark level/call、ntfy Priority）',
    '严重度分级（Bark level/call、ntfy Priority、钉钉 isAtAll）',
  ],
  [
    'digest batching into Bark, ServerChan, Telegram, WeCom, Feishu, ntfy or any webhook.',
    'digest batching into Bark, ServerChan, Telegram, WeCom, Feishu, DingTalk, ntfy or any webhook.',
  ],
  [
    "native field (Bark level/call, ntfy Priority)",
    "native field (Bark level/call, ntfy Priority, DingTalk isAtAll)",
  ],
]

let out = raw
for (const [from, to] of edits) {
  const n = out.split(from).length - 1
  if (n !== 1) {
    console.log(`FAIL expected exactly 1 occurrence of:\n  ${from}\n  found ${n}`)
    process.exit(1)
  }
  out = out.replace(from, to)
}

/* The result must still be valid JSON, and the version must be the one asked for. */
const parsed = JSON.parse(out)
if (parsed.version !== '0.4.0') {
  console.log(`FAIL version is ${parsed.version}, expected 0.4.0`)
  process.exit(1)
}

fs.writeFileSync(file, out, 'utf8')
console.log('OK -- package.json bumped to 0.4.0 with the DingTalk channel added')
console.log(`  engines.dsh unchanged: ${parsed.engines.dsh}`)
