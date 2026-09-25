/* Bump notify-relay to 0.4.3. */
const fs = require('node:fs')
const path = require('node:path')

const file = path.join(__dirname, '..', 'package.json')
const raw = fs.readFileSync(file, 'utf8')

let out = raw.replace('"version": "0.4.2"', '"version": "0.4.3"')
if (out === raw) {
  console.log('FAIL: version 0.4.2 not found')
  process.exit(1)
}

const parsed = JSON.parse(out)
if (parsed.version !== '0.4.3') {
  console.log(`FAIL version is ${parsed.version}, expected 0.4.3`)
  process.exit(1)
}
if (parsed.engines.dsh !== '>=0.1.6-alpha.1 <0.1.7 || >=0.1.7-alpha.1 <0.2.0-0') {
  console.log(`FAIL engines.dsh moved to ${parsed.engines.dsh}`)
  process.exit(1)
}

fs.writeFileSync(file, out, 'utf8')
console.log('OK -- package.json bumped to 0.4.3')
console.log(`  engines.dsh unchanged: ${parsed.engines.dsh}`)
