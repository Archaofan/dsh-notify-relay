/* Bump notify-relay to 0.4.1: the digest inherits severity. */
const fs = require('node:fs')
const path = require('node:path')

const file = path.join(__dirname, '..', 'package.json')
const raw = fs.readFileSync(file, 'utf8')

const edits = [['"version": "0.4.0"', '"version": "0.4.1"']]

let out = raw
for (const [from, to] of edits) {
  const n = out.split(from).length - 1
  if (n !== 1) {
    console.log(`FAIL expected exactly 1 occurrence of:\n  ${from}\n  found ${n}`)
    process.exit(1)
  }
  out = out.replace(from, to)
}

const parsed = JSON.parse(out)
if (parsed.version !== '0.4.1') {
  console.log(`FAIL version is ${parsed.version}, expected 0.4.1`)
  process.exit(1)
}
/* The peer range and engines must NOT move in a bugfix release. */
if (parsed.engines.dsh !== '>=0.1.6-alpha.1 <0.1.7 || >=0.1.7-alpha.1 <0.2.0-0') {
  console.log(`FAIL engines.dsh moved to ${parsed.engines.dsh} — a bugfix must not change compatibility`)
  process.exit(1)
}

fs.writeFileSync(file, out, 'utf8')
console.log('OK -- package.json bumped to 0.4.1')
console.log(`  engines.dsh unchanged: ${parsed.engines.dsh}`)
