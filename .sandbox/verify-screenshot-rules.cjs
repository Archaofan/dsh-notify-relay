/* Does notify-relay's screenshots.json satisfy the registry's screenshot rules?
 *
 * contributing.md sets them out explicitly:
 *
 *   - 1-8 images.
 *   - Absolute URLs are accepted as well, but must be https on GitHub hosting
 *     (raw.githubusercontent.com, user-images.githubusercontent.com,
 *     camo.githubusercontent.com, github.com attachments) -- third-party image
 *     hosts are rejected for user-privacy reasons.
 *   - Relative paths may not leave your plugin's directory (no leading /, no ..).
 *
 * And the reason relative paths matter: "A relative path breaks visibly in your
 * own repository if you rename the file. An absolute URL written into a file
 * over here can only rot silently -- that is how 41 of the 773 published
 * screenshots became 404s."
 *
 * The pre-flight already checks the three images RESOLVE. This checks the RULES,
 * which is a different fact: a screenshots.json with 9 entries, or one pointing
 * outside the plugin directory, fails CI even though every image loads.
 */
const fs = require('node:fs')
const path = require('node:path')

const REPO = 'E:\\DSH-Workspace\\DSH-Notify'
const FILE = path.join(REPO, 'screenshots.json')

const GITHUB_HOSTS = [
  'raw.githubusercontent.com',
  'user-images.githubusercontent.com',
  'camo.githubusercontent.com',
  'github.com',
]

let bad = 0
function claim(label, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`)
  if (!ok) bad += 1
}

console.log('=== screenshots.json against the registry rules ===\n')

if (!fs.existsSync(FILE)) {
  console.log('  no screenshots.json -- storefronts fall back to README images, which is allowed')
  process.exit(0)
}

claim('screenshots.json exists next to package.json', fs.existsSync(path.join(REPO, 'package.json')), REPO)

let doc
try {
  doc = JSON.parse(fs.readFileSync(FILE, 'utf8'))
} catch (e) {
  console.log(`FAIL screenshots.json is not valid JSON: ${e.message}`)
  process.exit(1)
}

/* Both shapes are accepted: a bare array, or {"screenshots": [...]}. */
const list = Array.isArray(doc) ? doc : doc.screenshots
claim('the file is a bare array or has a "screenshots" field', Array.isArray(list), Array.isArray(doc) ? 'array' : typeof doc.screenshots)
if (!Array.isArray(list)) process.exit(1)

claim('between 1 and 8 images', list.length >= 1 && list.length <= 8, `${list.length} images`)

for (const entry of list) {
  if (typeof entry !== 'string') { claim(`every entry is a string`, false, JSON.stringify(entry)); continue }

  if (/^https?:\/\//i.test(entry)) {
    /* Absolute URL: must be https on GitHub hosting. */
    claim(`${entry} is https`, /^https:\/\//i.test(entry), entry)
    let host = null
    try { host = new URL(entry).hostname } catch { /* leave null */ }
    claim(`${entry} is on GitHub hosting`, GITHUB_HOSTS.includes(host), host || 'unparseable')
  } else {
    /* Relative path: may not leave the plugin's directory. */
    claim(`${entry} does not start with /`, !entry.startsWith('/'), entry)
    claim(`${entry} contains no ..`, !entry.split(/[\\/]/).includes('..'), entry)

    const abs = path.resolve(REPO, entry)
    const inside = abs === REPO || abs.startsWith(REPO + path.sep)
    claim(`${entry} stays inside the plugin directory`, inside, path.relative(REPO, abs))
    claim(`${entry} exists in the repository`, fs.existsSync(abs), path.relative(REPO, abs))
  }
}

/* And every declared image must be one of the three the pre-flight already
 * confirmed resolve at HEAD -- the two checks must agree. */
const EXPECTED = ['docs/screenshots/settings.png', 'docs/screenshots/channels.png', 'docs/screenshots/pill.png']
const missing = EXPECTED.filter((e) => !list.includes(e))
claim('all three expected screenshots are declared', missing.length === 0, missing.length ? `not declared: ${missing.join(', ')}` : list.join(', '))

console.log(`\n  declared: ${list.join(', ')}`)
console.log(`\n${bad === 0 ? 'OK -- the screenshots satisfy every rule the registry states' : `${bad} problem(s)`}`)
process.exit(bad === 0 ? 0 : 1)
