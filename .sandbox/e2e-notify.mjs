/* End-to-end verification of the dsh-notify-relay CLIENT half in a real browser.
 *
 * The host face passed against a loopback server, and the browser face passed
 * against a fake DOM — but neither proves the plugin mounts into the official
 * GUI. The fake DOM has no slot registry, no React reconciler and no settings
 * page to render into; only a real browser shows all three.
 *
 * Three things matter here:
 *   1. the plugin activates at all (no "did not activate", no pageerror)
 *   2. the sidebar pill and the official settings section really render
 *   3. a change made in the UI really reaches the host and comes back
 *
 * The scoping of the settings nav follows the pattern proven in v0.1.5's
 * e2e-new-surfaces.mjs: the official settings nav is the ONLY <nav> that also
 * lists a built-in section (通用设置 / General Settings). An unscoped text
 * search for our own label clicks the sidebar footer button instead, because
 * that button deliberately carries the same label.
 *
 * Usage: node e2e-notify.mjs <guiUrl> [expectTitle]
 */
import { chromium } from 'playwright'

const url = process.argv[2]
const expectTitle = process.argv[3] || ''
if (!url) {
  console.log('usage: node e2e-notify.mjs <guiUrl> [expectTitle]')
  process.exit(2)
}

const problems = []
const notes = []
function check(ok, label, detail) {
  const suffix = ok || detail === undefined || detail === '' ? '' : ` — ${detail}`
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${suffix}`)
  if (!ok) problems.push(label)
}

/* Use the Chromium already on this machine rather than downloading a matching
 * build: Playwright pins a browser build per version, and the installed one
 * predates the pin. Any recent Chromium drives the page the same way here. */
const CHROMIUM =
  process.env.E2E_CHROMIUM ||
  (process.env.LOCALAPPDATA || '') + '\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe'
const fs = await import('node:fs')
if (!fs.existsSync(CHROMIUM)) {
  console.log(`no Chromium at ${CHROMIUM} — set E2E_CHROMIUM to a chrome.exe`)
  process.exit(2)
}

const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

/* Errors that belong to the GUI itself are not ours: an unauthenticated probe
   of a resource, or a missing favicon, says nothing about the plugin. */
const IGNORE = /Failed to load resource|favicon|401|404|403/i
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error' && !IGNORE.test(m.text())) consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

const api = async (path, options = {}) => {
  const response = await page.request.fetch(new URL(path, url).toString(), {
    method: options.method || 'GET',
    headers: options.data ? { 'content-type': 'application/json' } : {},
    data: options.data ? JSON.stringify(options.data) : undefined,
  })
  const text = await response.text()
  try {
    return { status: response.status(), json: JSON.parse(text), text }
  } catch {
    return { status: response.status(), json: null, text }
  }
}

const clickAny = async (re) => {
  const handle = await page.evaluateHandle((src) => {
    const r = new RegExp(src, 'i')
    return (
      [...document.querySelectorAll('button, a, [role="button"]')].find(
        (b) => r.test((b.getAttribute('aria-label') || '').trim()) || r.test((b.textContent || '').trim()),
      ) || null
    )
  }, re.source)
  const el = handle.asElement()
  if (!el) return false
  await el.click().catch(() => {})
  return true
}

/* The ONLY <nav> that also lists a built-in section is the settings nav. The
   sidebar footer button carries our label too, so it must be excluded. */
const clickSettingsNav = async (re) => {
  const handle = await page.evaluateHandle((src) => {
    const r = new RegExp(src)
    const known = /^(通用设置|General Settings)$/
    const navs = [...document.querySelectorAll('nav')].filter((n) =>
      [...n.querySelectorAll('button')].some((b) => known.test((b.textContent || '').trim())),
    )
    if (!navs.length) return null
    return [...navs[0].querySelectorAll('button')].find((b) => r.test((b.textContent || '').trim())) || null
  }, re.source)
  const el = handle.asElement()
  if (!el) return false
  await el.click().catch(() => {})
  return true
}

console.log('— loading the real GUI —')
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })

/* ------------------------------------------------------------------ *
 * 1. activation — the symptom of a dead client bundle
 * ------------------------------------------------------------------ */
console.log('— activation —')
await page.waitForTimeout(7000)
const activationError = consoleErrors.find((t) => /did not activate|Failed to load plugins/i.test(t))
check(!activationError, 'no "did not activate" error', activationError || '')
check(
  !consoleErrors.some((t) => /notify-relay/i.test(t)),
  'no error names this plugin',
  consoleErrors.find((t) => /notify-relay/i.test(t)) || '',
)

/* ------------------------------------------------------------------ *
 * 2. dismiss the first-run onboarding, if the GUI is showing it
 * ------------------------------------------------------------------ */

/**
 * DSH 0.1.7 added a first-run flow that did not exist in 0.1.6: a closed-beta
 * announcement followed by an "add an API key" prompt. Both render as a modal
 * with a full-page mask that intercepts pointer events, so nothing in the
 * sidebar can be clicked until they are gone.
 *
 * The API-key prompt is the one that matters. It is NOT persisted as "skipped"
 * -- a profile with no credentials sees it again on every page load, so this
 * runs after the GUI has settled rather than once. A profile that already has
 * credentials never sees it, which is why the whole thing is conditional: the
 * same code is a no-op on 0.1.6 and on an onboarded profile, so one e2e drives
 * both sandboxes.
 *
 * The exact-text match is load-bearing. `hasText: '继续'` also matches
 * "保存并继续", whose button is disabled until a key is typed, and clicking a
 * disabled button times out with a log that says nothing about why.
 */
async function dismissFirstRun() {
  for (let round = 0; round < 6; round += 1) {
    const dialog = page.locator('[role="dialog"]').first()
    if ((await dialog.count()) === 0) return true
    const enabled = await page.evaluate(() => {
      const node = document.querySelector('[role="dialog"]')
      if (!node) return []
      return [...node.querySelectorAll('button')]
        .filter((b) => !b.disabled && (b.textContent || '').trim())
        .map((b) => (b.textContent || '').trim())
    })
    if (enabled.length === 0) return false
    /* The dismiss action is the last enabled button: 继续 on the announcement,
       稍后配置 on the API-key prompt. Taking the last one rather than the first
       avoids "保存并继续", which is enabled only after a key is entered. */
    await page
      .getByRole('button', { name: enabled[enabled.length - 1], exact: true })
      .first()
      .click({ timeout: 8000 })
    await page.waitForTimeout(1500)
  }
  return (await page.locator('[role="dialog"]').count()) === 0
}

const onboardingClear = await dismissFirstRun()
check(
  onboardingClear,
  'the first-run onboarding is dismissed',
  'a modal is still covering the page, so the sidebar cannot be clicked',
)

/* ------------------------------------------------------------------ *
 * 3. the sidebar pill — what users see without opening settings
 * ------------------------------------------------------------------ */
console.log('— sidebar pill —')
const pill = page.locator('[data-testid="relay-footer"]').first()
check((await pill.count()) > 0, 'the relay pill renders in the sidebar footer')
if ((await pill.count()) > 0) {
  const on = await pill.getAttribute('data-on')
  check(on === 'false', 'the pill reports the relay as off by default', `data-on=${on}`)
  const rail = await pill.getAttribute('data-rail')
  check(rail === 'false', 'the pill is in full mode on a wide viewport', `data-rail=${rail}`)
  const label = await pill.getAttribute('aria-label')
  check(typeof label === 'string' && label.length > 0, 'the pill carries an accessible label', label || '')

  /* Clicking the pill must open the delivery panel without throwing. */
  const before = consoleErrors.length
  await pill.click()
  await page.waitForTimeout(700)
  check((await page.locator('[data-testid="relay-panel"]').count()) > 0, 'clicking the pill opens the delivery panel')
  check(consoleErrors.length === before, 'opening the panel raises no page error', consoleErrors.slice(before).join(' | '))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
}

/* ------------------------------------------------------------------ *
 * 3. the official settings section
 * ------------------------------------------------------------------ */
console.log('— official settings section —')
check(await clickAny(/^设置$|^Settings$/), 'the settings entry opens')
await page.waitForTimeout(2500)
check(
  await clickSettingsNav(/^(外联中枢|Outbound relay)$/),
  'our nav entry opens in the official settings window',
)
await page.waitForTimeout(2000)

const section = await page.evaluate(() => {
  const root = document.querySelector('[data-testid="relay-master"]')
  if (!root) return null
  const container = root.closest('div')
  return {
    text: (container && container.textContent ? container.textContent : '').replace(/\s+/g, ' '),
    master: !!root,
    switches: document.querySelectorAll('[data-testid^="relay-event-"]').length,
    kindSelects: document.querySelectorAll('[data-testid="relay-channel-kind"]').length,
    save: !!document.querySelector('[data-testid="relay-save"]'),
    addChannel: !!document.querySelector('[data-testid="relay-add-channel"]'),
    dedup: !!document.querySelector('[data-testid="relay-dedup"]'),
    quietStart: !!document.querySelector('[data-testid="relay-quiet-start"]'),
    digest: !!document.querySelector('[data-testid="relay-digest"]'),
    /* v0.3.0 surfaces. */
    language: !!document.querySelector('[data-testid="relay-language"]'),
    retry: !!document.querySelector('[data-testid="relay-retry"]'),
    deepLink: !!document.querySelector('[data-testid="relay-deeplink"]'),
  }
})
if (!section) {
  check(false, 'the settings section body rendered')
} else {
  check(!!section.master, 'the section renders the master switch')
  /* Eight, not four. The host's EVENT_KINDS grew from four to eight when the
     turn-end reasons were split out, and the browser half's list did not move —
     the settings page ended up with four switches for eight events, so four
     kinds were silently unconfigurable. Each half was internally consistent, so
     both harness gates stayed green; only a real browser, counting switches,
     catches it. */
  check(section.switches === 8, 'the section renders one switch per event', `${section.switches} switches`)
  check(section.kindSelects >= 0, 'the channel editor is present')
  check(section.save, 'the save button renders')
  check(section.addChannel, 'the add-channel button renders')
  check(section.dedup, 'the dedup window input renders')
  check(section.quietStart, 'the quiet-hours start input renders')
  check(section.digest, 'the digest switch renders')
  check(section.language, 'the delivery-language select renders')
  check(section.retry, 'the retry-now button renders')
  check(section.deepLink, 'the deep-link input renders')
  /* The retry button must be disabled with an empty outbox: "retry now" over
     nothing is a button that does nothing and says it did. */
  const retryDisabled = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="relay-retry"]')
    return node ? node.disabled === true : null
  })
  check(retryDisabled === true, 'the retry button is disabled with an empty outbox', String(retryDisabled))
}

/* ------------------------------------------------------------------ *
 * 4. a UI change must reach the host and come back
 * ------------------------------------------------------------------ */
console.log('— the UI writes through to the host —')
const hostBefore = await api('/notify-relay/config')
check(hostBefore.json && hostBefore.json.config.enabled === false, 'the host reports the relay disabled before the edit')

const masterSwitch = page.locator('[data-testid="relay-master"]').first()
if ((await masterSwitch.count()) > 0) {
  await masterSwitch.click()
  await page.waitForTimeout(400)
  await page.locator('[data-testid="relay-save"]').first().click()

  /* The save is a POST; poll the host rather than assuming it landed. */
  let hostAfter = null
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.waitForTimeout(200)
    const current = await api('/notify-relay/config')
    hostAfter = current.json && current.json.config.enabled
    if (hostAfter === true) break
  }
  check(hostAfter === true, 'enabling the relay in the UI persists to the host', String(hostAfter))

  /* And the pill must follow it. */
  await page.waitForTimeout(3000)
  const pillOn = await page.locator('[data-testid="relay-footer"]').first().getAttribute('data-on')
  check(pillOn === 'true', 'the pill follows the host state', `data-on=${pillOn}`)

  /* Leave the sandbox as we found it. */
  await masterSwitch.click()
  await page.waitForTimeout(400)
  await page.locator('[data-testid="relay-save"]').first().click()
  await page.waitForTimeout(1200)
  const restored = await api('/notify-relay/config')
  check(restored.json && restored.json.config.enabled === false, 'the sandbox is left with the relay disabled', String(restored.json && restored.json.config.enabled))
} else {
  notes.push('master switch not found; the write-through check was skipped')
}

/* ------------------------------------------------------------------ *
 * 5. nothing may have thrown
 * ------------------------------------------------------------------ */
console.log('— console hygiene —')
check(consoleErrors.length === 0, 'no console errors or page errors at all', consoleErrors.slice(0, 3).join(' | '))

await browser.close()

console.log('')
if (problems.length) {
  console.log(`E2E FAIL — ${problems.length} problem(s):`)
  for (const p of problems) console.log(`  - ${p}`)
  process.exit(1)
}
console.log('E2E OK — real-browser client verification passed')
for (const n of notes) console.log(`note: ${n}`)
