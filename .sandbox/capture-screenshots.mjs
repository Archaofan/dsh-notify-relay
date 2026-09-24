/**
 * Captures the plugin's own screenshots from the running sandbox GUI.
 *
 * These are declared in `screenshots.json` in the plugin's own repository, which
 * is what storefronts (dsh-market and friends) read. They live in our repo, not
 * the registry, so they can be updated by pushing here — no PR, no maintainer.
 *
 * Three shots, in the order a reader cares about:
 *   1. the settings section — the rule center itself
 *   2. the sidebar pill + delivery panel — the "what just happened" surface
 *   3. a channel card with its breaker state — the v0.3.0 self-explaining UI
 */
import { chromium } from 'playwright'
import { mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/* The plugin's own repository root, not the scratch directory: these images are
   referenced from screenshots.json by a repo-relative path, so a storefront can
   fetch them straight from GitHub. Writing them under .sandbox/ would put them
   outside both the repo and the tarball. */
const repoRoot = join(here, '..')
const outDir = join(repoRoot, 'docs', 'screenshots')
mkdirSync(outDir, { recursive: true })

const guiUrl = process.argv[2]
if (!guiUrl) {
  console.error('usage: node capture-screenshots.mjs <guiUrlWithToken>')
  process.exit(1)
}

/* Use the Chromium already on this machine rather than downloading a matching
   build: the installed Playwright pin predates the browser that is present, and
   any recent Chromium drives the page the same way here. */
const CHROMIUM =
  process.env.E2E_CHROMIUM ||
  (process.env.LOCALAPPDATA || '') + '\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe'
if (!existsSync(CHROMIUM)) {
  console.log(`no Chromium at ${CHROMIUM} — set E2E_CHROMIUM to a chrome.exe`)
  process.exit(1)
}

const browser = await chromium.launch({ executablePath: CHROMIUM })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
const problems = []
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`)
})

await page.goto(guiUrl, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)

/**
 * Clicks the first control whose aria-label or text matches, and reports whether
 * the click actually landed. Returning true on a swallowed failure is how a
 * screenshot script ends up photographing the wrong surface: the next step then
 * looks for elements that were never rendered, and the run reads as a GUI bug
 * when it is a harness bug.
 */
async function clickControl(pattern) {
  const handle = await page.evaluateHandle((src) => {
    const r = new RegExp(src)
    return (
      [...document.querySelectorAll('button, a, [role="button"]')].find(
        (b) => r.test((b.getAttribute('aria-label') || '').trim()) || r.test((b.textContent || '').trim()),
      ) || null
    )
  }, pattern)
  const element = handle.asElement()
  if (!element) return false
  try {
    await element.click({ timeout: 5000 })
    return true
  } catch {
    /* A DOM click as the fallback: the element is present, but Playwright's
       actionability check can reject a control inside a transitioning panel. */
    try {
      await element.evaluate((node) => node.click())
      return true
    } catch {
      return false
    }
  }
}

/**
 * Clicks our entry inside DSH's own settings nav.
 *
 * Deliberately NOT a text search: the sidebar footer pill carries the same
 * label, and clicking it opens the delivery panel instead of the settings
 * section — the shot then shows the wrong surface entirely. The real nav is
 * identified by the built-in "General Settings" row it also contains.
 */
async function clickSettingsNav(pattern) {
  const handle = await page.evaluateHandle((src) => {
    const r = new RegExp(src)
    const known = /^(通用设置|General Settings)$/
    const navs = [...document.querySelectorAll('nav')].filter((n) =>
      [...n.querySelectorAll('button')].some((b) => known.test((b.textContent || '').trim())),
    )
    if (!navs.length) return null
    return [...navs[0].querySelectorAll('button')].find((b) => r.test((b.textContent || '').trim())) || null
  }, pattern)
  const element = handle.asElement()
  if (!element) return false
  try {
    await element.click({ timeout: 5000 })
    return true
  } catch {
    try {
      await element.evaluate((node) => node.click())
      return true
    } catch {
      return false
    }
  }
}

/* ---- 1. the pill, then the settings section ----

   The pill comes first because the delivery panel is the surface a reader sees
   without being told where to click; opening and closing it also proves the
   plugin is live before the heavier settings window is opened. The settings
   hop then matches the e2e's own sequence exactly. */
const pill = page.locator('[data-testid="relay-footer"]').first()
if ((await pill.count()) > 0) {
  await pill.click()
  await page.waitForTimeout(900)
  await page.screenshot({ path: join(outDir, 'pill.png') })
  console.log('  ok   pill.png')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
} else {
  console.log('  FAIL the pill was not found')
}

if (!(await clickControl('^(设置|Settings)$'))) {
  console.log('  FAIL the DSH settings entry was not found')
} else {
  await page.waitForTimeout(3000)
  if (process.env.CAPTURE_DEBUG) {
    const dump = await page.evaluate(() => ({
      navs: [...document.querySelectorAll('nav')].map((n) => ({
        cls: n.className,
        buttons: [...n.querySelectorAll('button')].map((b) => (b.textContent || '').trim()),
      })),
      master: !!document.querySelector('[data-testid="relay-master"]'),
    }))
    console.log('  [dbg]', JSON.stringify(dump))
  }
  if (!(await clickSettingsNav('^(外联中枢|Outbound relay)$'))) {
    console.log('  FAIL our settings nav entry was not found')
  } else {
    await page.waitForTimeout(2000)
    const master = page.locator('[data-testid="relay-master"]').first()
    if ((await master.count()) === 0) {
      console.log('  FAIL the settings section did not render')
    } else if (!(await master.isVisible())) {
      /* Present in the DOM but not on screen is the failure mode that matters
         here: the shot would be a settings window showing some other section,
         which reads as a working capture and is not one. */
      console.log('  FAIL the settings section is in the DOM but not visible')
    } else {
      await master.scrollIntoViewIfNeeded()
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(outDir, 'settings.png') })
      console.log('  ok   settings.png')

      /* A second shot further down the same page: the channels and the deep
         link, which are the parts a reader cannot guess from the pill. */
      const addChannel = page.locator('[data-testid="relay-add-channel"]').first()
      if ((await addChannel.count()) === 0) {
        console.log('  FAIL the add-channel button was not found')
      } else {
        await addChannel.scrollIntoViewIfNeeded()
        await page.waitForTimeout(600)
        if (!(await addChannel.isVisible())) {
          console.log('  FAIL the channel editor is not visible')
        } else {
          await page.screenshot({ path: join(outDir, 'channels.png') })
          console.log('  ok   channels.png')
        }
      }
    }
  }
}

await browser.close()

if (problems.length > 0) {
  console.log(`\n${problems.length} page problem(s) during capture:`)
  for (const problem of problems.slice(0, 10)) console.log(`  - ${problem}`)
  process.exit(1)
}
console.log('\nSCREENSHOTS OK')
process.exit(0)
