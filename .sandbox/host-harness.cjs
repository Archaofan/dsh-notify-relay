/**
 * dsh-notify-relay — host-half gate.
 *
 * Three jobs, in order of how much damage each prevents:
 *
 *  1. FAIL-LOUD CONTRACT. The real runner's ctx throws "cannot get property X
 *     without inject" the moment apply() reads a service that exports.inject
 *     does not declare — and that throw kills the whole plugin tree ("web boot:
 *     1 entry did not activate"). This harness builds a Proxy that reproduces
 *     that exactly and runs the real apply() through it, so the inject list is
 *     proved rather than assumed. A listed-but-unreachable service is caught
 *     too: cordis would then wait forever.
 *
 *  2. RULE ENGINE. dedup / quiet hours / digest / routing is where the bug
 *     surface actually is, and it is pure — so every branch is exercised
 *     directly, including the ones a boot never reaches.
 *
 *  3. REAL DELIVERY. A local HTTP server stands in for a webhook and the
 *     plugin's own intake path drives a genuine fetch to it, so "the payload
 *     builder is right" and "the delivery actually happens" are proved
 *     separately instead of being conflated.
 */
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const file = process.argv[2] || 'index.js'

const failures = []
const checks = []

function check(label, condition, detail) {
  checks.push(label)
  if (condition) {
    console.log(`  ok   ${label}`)
    return true
  }
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  failures.push(label)
  return false
}

/** Deep-equal that is strict about arrays and NaN. */
function same(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b)
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    return a.every((entry, index) => same(entry, b[index]))
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((key) => same(a[key], b[key]))
}

/* ------------------------------------------------------------------ *
 * The fail-loud fake ctx.
 * ------------------------------------------------------------------ */

/**
 * Cordis built-ins that are always readable. Everything else must come from
 * `inject`; the list mirrors what the client runner and the host runner both
 * expose before any plugin loads.
 */
const CORDIS_BUILTINS = [
  'effect',
  'inject',
  'set',
  'get',
  'on',
  'emit',
  'once',
  'off',
  'logger',
  'scope',
  'module',
  'fiber',
  'extend',
  'plugin',
  'flush',
  'start',
  'dispose',
  'define',
  'isActive',
  'resolve',
  'provide',
  'collect',
  'serialize',
  'create',
]

/**
 * Builds a ctx that behaves like the runner's: undeclared service reads throw
 * the same message the real one throws.
 *
 * @param {string[]} injectList the plugin's exports.inject
 * @param {object} services service name -> fake implementation
 */
function makeCtx(injectList, services) {
  const allowed = new Set([...CORDIS_BUILTINS, ...injectList])
  const reads = []

  const base = {
    effect(factory, name) {
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on(event, handler) {
      reads.push(`on:${event}`)
      return () => {}
    },
    logger() {
      return { info() {}, warn() {}, error() {}, debug() {} }
    },
    inject(services_, callback) {
      /* Opportunistic wait: the real ctx.inject runs the callback only once
         every named service exists, and never throws. The harness runs it
         immediately so route registration is observable. */
      reads.push(`inject:${services_.join(',')}`)
      if (typeof callback === 'function') callback({})
      return () => {}
    },
  }

  for (const [name, service] of Object.entries(services)) {
    base[name] = service
  }

  return new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
      if (!allowed.has(prop)) {
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      }
      reads.push(String(prop))
      return Reflect.get(target, prop, receiver)
    },
    has(target, prop) {
      return allowed.has(prop)
    },
  })
}

/* ------------------------------------------------------------------ *
 * Rule-engine unit tests.
 * ------------------------------------------------------------------ */

function testValidateConfig(mod) {
  const { validateConfig, defaultConfig } = mod

  const blank = validateConfig(undefined)
  check('validateConfig(undefined) -> ok', blank.ok === true, JSON.stringify(blank))
  if (!blank.ok) return
  check('default config is disabled', blank.value.enabled === false)
  check(
    'default events: failures on, task-done off',
    blank.value.events['task.failed'] === true &&
      blank.value.events['request.failed'] === true &&
      blank.value.events['approval.asked'] === true &&
      blank.value.events['task.done'] === false,
    JSON.stringify(blank.value.events),
  )

  const full = validateConfig({
    enabled: true,
    events: { 'task.done': true, 'task.failed': false, 'request.failed': true, 'approval.asked': false },
    dedup: { windowMinutes: 3 },
    quiet: { enabled: true, start: '23:30', end: '06:15', mode: 'drop' },
    digest: { enabled: true, intervalMinutes: 45 },
    channels: [
      {
        id: 'c1',
        kind: 'bark',
        name: '我的手机',
        enabled: true,
        secrets: { key: 'abc' },
        events: ['task.failed'],
      },
    ],
  })
  check('validateConfig(full) -> ok', full.ok === true, JSON.stringify(full))
  if (full.ok) {
    check('full config events honoured', full.value.events['task.failed'] === false && full.value.events['approval.asked'] === false)
    check('full config dedup honoured', full.value.dedup.windowMinutes === 3)
    check('full config quiet honoured', full.value.quiet.start === '23:30' && full.value.quiet.end === '06:15' && full.value.quiet.mode === 'drop')
    check('full config digest honoured', full.value.digest.intervalMinutes === 45)
    check('channel kept with its secret', full.value.channels.length === 1 && full.value.channels[0].secrets.key === 'abc')
    check('channel keeps its event filter', full.value.channels[0].events.join(',') === 'task.failed')
  }

  /* Clamping: an out-of-range number must not become NaN or 0. */
  const clamped = validateConfig({ dedup: { windowMinutes: 99999 }, digest: { intervalMinutes: -5 } })
  check('dedup window clamped to 1440', clamped.ok && clamped.value.dedup.windowMinutes === 1440, clamped.ok ? String(clamped.value.dedup.windowMinutes) : 'rejected')
  check('digest interval clamped to 1', clamped.ok && clamped.value.digest.intervalMinutes === 1, clamped.ok ? String(clamped.value.digest.intervalMinutes) : 'rejected')

  /* A garbage clock must fall back, not poison the window. */
  const badClock = validateConfig({ quiet: { start: '25:99', end: 'not-a-time' } })
  check('invalid quiet clock falls back', badClock.ok && badClock.value.quiet.start === '22:00' && badClock.value.quiet.end === '08:00')

  /* Unknown kinds are dropped rather than trusted. */
  const junk = validateConfig({ channels: [{ id: 'x', kind: 'carrier-pigeon' }, null, 'nope'] })
  check('unknown channel kinds dropped', junk.ok && junk.value.channels.length === 0, junk.ok ? String(junk.value.channels.length) : 'rejected')

  /* A non-object is a hard error. */
  check('validateConfig("string") rejected', validateConfig('nope').ok === false)
  check('validateConfig([]) rejected', validateConfig([]).ok === false)
}

function testFingerprint(mod) {
  const { fingerprint } = mod
  const a = fingerprint('task.failed', 's1', 'Build broke', 'ECONNRESET')
  const b = fingerprint('task.failed', 's1', 'Build broke', 'ECONNRESET')
  const c = fingerprint('task.failed', 's2', 'Build broke', 'ECONNRESET')
  const d = fingerprint('request.failed', 's1', 'Build broke', 'ECONNRESET')
  const e = fingerprint('task.failed', 's1', 'Build broke', 'ETIMEDOUT')
  const f = fingerprint('task.failed', 's1', 'BUILD BROKE', 'ECONNRESET')

  check('fingerprint is stable', a === b)
  check('fingerprint is 16 hex chars', /^[0-9a-f]{16}$/.test(a), a)
  check('different session -> different fingerprint', a !== c)
  check('different kind -> different fingerprint', a !== d)
  check('different body -> different fingerprint', a !== e)
  check('title is case-insensitive', a === f, `${a} vs ${f}`)
}

function testQuietHours(mod) {
  const { isWithinQuietHours } = mod
  const at = (h, m) => new Date(2026, 8, 24, h, m, 0, 0)
  const wrap = { start: '22:00', end: '08:00' }

  check('inside a wrapping window (23:00)', isWithinQuietHours(at(23, 0), wrap) === true)
  check('inside a wrapping window (03:00)', isWithinQuietHours(at(3, 0), wrap) === true)
  check('outside a wrapping window (12:00)', isWithinQuietHours(at(12, 0), wrap) === false)
  check('window start is inclusive', isWithinQuietHours(at(22, 0), wrap) === true)
  check('window end is exclusive', isWithinQuietHours(at(8, 0), wrap) === false)

  const day = { start: '09:00', end: '17:00' }
  check('inside a daytime window', isWithinQuietHours(at(10, 0), day) === true)
  check('before a daytime window', isWithinQuietHours(at(8, 59), day) === false)
  check('after a daytime window', isWithinQuietHours(at(17, 1), day) === false)

  const empty = { start: '12:00', end: '12:00' }
  check('equal start/end never matches', isWithinQuietHours(at(12, 0), empty) === false)
}

function testBuildDelivery(mod) {
  const { buildDelivery } = mod
  const note = { kind: 'task.failed', title: 'Build broke', body: 'ECONNRESET', sessionId: 's1', createdAt: 'x' }

  const cases = [
    ['bark', { id: 'c', kind: 'bark', secrets: { key: 'K' }, url: '' }, 'api.day.app/K'],
    ['serverchan', { id: 'c', kind: 'serverchan', secrets: { sendkey: 'S' }, url: '' }, 'sctapi.ftqq.com/S.send'],
    ['telegram', { id: 'c', kind: 'telegram', secrets: { token: 'T', chatId: 'C' }, url: '' }, 'api.telegram.org/botT/sendMessage'],
    ['wecom', { id: 'c', kind: 'wecom', secrets: { key: 'W' }, url: '' }, 'qyapi.weixin.qq.com/cgi-bin/webhook/send?key=W'],
    ['feishu', { id: 'c', kind: 'feishu', secrets: { token: 'F' }, url: '' }, 'open.feishu.cn/open-apis/bot/v2/hook/F'],
    ['ntfy', { id: 'c', kind: 'ntfy', secrets: {}, url: 'https://ntfy.sh/topic' }, 'ntfy.sh/topic'],
    ['webhook', { id: 'c', kind: 'webhook', secrets: { token: 'X' }, url: 'https://example.com/hook' }, 'example.com/hook'],
  ]

  for (const [label, channel, expectedUrl] of cases) {
    const built = buildDelivery(channel, note)
    const ok = check(`${label} builds a request`, !built.error && typeof built.url === 'string', built.error || built.url)
    if (ok) {
      check(`${label} url carries the secret/topic`, built.url.includes(expectedUrl), built.url)
      check(`${label} body is non-empty`, typeof built.init.body === 'string' && built.init.body.length > 0)
      check(`${label} uses POST`, built.init.method === 'POST')
    }
  }

  /* Telegram must quote the chat id, and the body must carry both lines. */
  const tg = buildDelivery({ id: 'c', kind: 'telegram', secrets: { token: 'T', chatId: '123' }, url: '' }, note)
  const tgBody = tg.init ? JSON.parse(tg.init.body) : {}
  check('telegram chat_id survives as a string', tgBody.chat_id === '123', JSON.stringify(tgBody))
  check('telegram text carries title and body', String(tgBody.text).includes('Build broke') && String(tgBody.text).includes('ECONNRESET'))

  /* A missing endpoint is an error object, never a throw. */
  const noUrl = buildDelivery({ id: 'c', kind: 'webhook', secrets: {}, url: '' }, note)
  check('webhook without a url reports an error', !!noUrl.error, JSON.stringify(noUrl))

  const notHttp = buildDelivery({ id: 'c', kind: 'webhook', secrets: {}, url: 'ftp://example.com' }, note)
  check('non-http endpoint rejected', !!notHttp.error)

  const unknown = buildDelivery({ id: 'c', kind: 'nope', secrets: {}, url: '' }, note)
  check('unknown channel kind reports an error', !!unknown.error)

  /* A secret with URL-hostile characters must not corrupt the endpoint. */
  const weird = buildDelivery({ id: 'c', kind: 'bark', secrets: { key: 'a b/c?d' }, url: '' }, note)
  check('bark key is url-encoded', !!weird.url && weird.url.includes('a%20b%2Fc%3Fd'), weird.url)
}

function testRedaction(mod) {
  const { redactConfig, validateConfig, REDACTED } = mod
  const checked = validateConfig({
    channels: [
      { id: 'c1', kind: 'telegram', secrets: { token: 'SECRET-TOKEN', chatId: '999' } },
      { id: 'c2', kind: 'bark', secrets: { key: 'SECRET-KEY' } },
    ],
  })
  if (!checked.ok) {
    check('redaction setup', false, 'config rejected')
    return
  }
  const view = redactConfig(checked.value)
  const leaked = JSON.stringify(view)
  check('no secret appears in the redacted view', !leaked.includes('SECRET-TOKEN') && !leaked.includes('SECRET-KEY'), leaked.slice(0, 120))
  check('every secret field is the placeholder', view.channels.every((c) => Object.values(c.secrets).every((v) => v === REDACTED)))

  /* The round-trip contract: sending the placeholder back must keep the
     original secret rather than overwriting it with the mask. */
  const roundTrip = validateConfig({ channels: [{ id: 'c1', kind: 'telegram', secrets: { token: REDACTED, chatId: '999' } }] }, undefined)
  check('placeholder in a fresh config is dropped', roundTrip.ok && roundTrip.value.channels[0].secrets.token === '')

  /* An unknown secret field must survive validation. Dropping it silently
     destroys credentials: the channel still looks configured, every delivery
     goes out unauthenticated, and nothing anywhere reports a problem. */
  const extra = validateConfig({ channels: [{ id: 'c3', kind: 'webhook', secrets: { token: 'T3', header: 'X-Api-Key', value: 'V3' } }] })
  check('an unknown secret field survives validation', extra.ok && extra.value.channels[0].secrets.header === 'X-Api-Key', extra.ok ? JSON.stringify(extra.value.channels[0].secrets) : 'rejected')
  check('the canonical field still wins', extra.ok && extra.value.channels[0].secrets.token === 'T3')
  check('an unknown secret field is still redacted', extra.ok && redactConfig(extra.value).channels[0].secrets.value === REDACTED)
}

/* ------------------------------------------------------------------ *
 * The apply() gate: fail-loud contract + registrations + real delivery.
 * ------------------------------------------------------------------ */

async function testApply(mod) {
  const commands = []
  const routes = []
  const routeTable = new Map()
  const duplicateRegistrations = []
  const eventHandlers = new Map()
  const timers = []
  const serviceReads = []
  const injectCalls = []

  /* Faithful to @deepseek-ai/dsh-host-webserver: routes live in a Map keyed by
     PATH, `match()` ignores the method, and a duplicate path THROWS. A fake
     that stores a list and matches on method hides the collision where a GET
     route silently shadows a POST route on the same path — which is a bug this
     plugin actually shipped once, and no amount of unit testing caught. */
  const webServer = {
    register(route) {
      if (routeTable.has(route.path)) {
        duplicateRegistrations.push(route.path)
        throw new Error(`duplicate route: ${route.path}`)
      }
      routeTable.set(route.path, route)
      routes.push(route)
      return () => {
        if (routeTable.get(route.path) === route) routeTable.delete(route.path)
        const at = routes.indexOf(route)
        if (at !== -1) routes.splice(at, 1)
      }
    },
  }

  const services = {
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      },
    },
    timer: {
      timeout(callback, delay) {
        timers.push({ callback, delay })
        return () => {}
      },
      interval(callback, delay) {
        timers.push({ callback, delay, interval: true })
        return () => {}
      },
    },
  }

  const ctx = makeCtx(mod.inject, services)
  /* The web ctx the plugin receives from ctx.inject must itself carry the
     cordis built-ins the callback uses (webCtx.effect, webCtx.logger). */
  const webCtx = makeCtx(['webServer'], { webServer })

  Object.defineProperty(ctx, 'inject', {
    value(services_, callback) {
      injectCalls.push(services_)
      if (typeof callback === 'function') callback(webCtx)
      return () => {}
    },
    configurable: true,
  })
  Object.defineProperty(ctx, 'on', {
    value(event, handler) {
      eventHandlers.set(event, handler)
      serviceReads.push(`on:${event}`)
      return () => eventHandlers.delete(event)
    },
    configurable: true,
  })

  /* The plugin's apply() is async and touches DSH_HOME; the harness points
     that at a scratch directory so nothing real is read or written. */
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-harness-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = scratch
  try {
    await mod.apply(ctx)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }

  /* ---- the contract itself ---- */
  check('apply() did not read an undeclared service', true, serviceReads.join(', '))
  check(
    'inject declares commands and timer',
    mod.inject.includes('commands') && mod.inject.includes('timer'),
    mod.inject.join(','),
  )
  check('inject does NOT declare webServer (it is waited for)', !mod.inject.includes('webServer'), mod.inject.join(','))
  check('webServer is waited through ctx.inject', injectCalls.some((list) => list.includes('webServer')), injectCalls.map((l) => l.join('+')).join(' | '))

  /* ---- registrations ---- */
  check('one slash command registered', commands.length === 1, commands.map((c) => c.name).join(','))
  const command = commands[0]
  if (command) {
    check('command name is lowercase and valid', /^[a-z0-9_-]+$/.test(command.name), command.name)
    check('command has a description', typeof command.description === 'string' && command.description.length > 0)
    check('command exposes a hint', !!(command.input && command.input.hint))
  }

  const expectedEvents = ['turn/end', 'agent/error', 'agent/request-error', 'approval/asked']
  for (const event of expectedEvents) {
    check(`listens to ${event}`, eventHandlers.has(event))
  }
  check('no unexpected listeners', eventHandlers.size === expectedEvents.length, [...eventHandlers.keys()].join(','))

  const expectedPaths = ['/notify-relay/config', '/notify-relay/log', '/notify-relay/test', '/notify-relay/flush']
  for (const expected of expectedPaths) {
    check(`route ${expected} registered`, routes.some((route) => route.path === expected))
  }
  check('all routes are exact-kind', routes.every((route) => route.kind === 'exact'))
  check('all route paths share the prefix', routes.every((route) => route.path.startsWith('/notify-relay/')))
  check('no path is registered twice', duplicateRegistrations.length === 0, duplicateRegistrations.join(','))
  check('exactly one route per path', routes.length === expectedPaths.length, `${routes.length} routes for ${expectedPaths.length} paths`)

  /* The method must be dispatched INSIDE the handler. Declaring `method` on a
     route does nothing — the real webserver ignores it — so a POST declared as
     its own route is simply unreachable, and the write silently lands on the
     read handler. Checked behaviourally below (the POST must not answer with
     the read shape); asserting on the handler's source text would only prove
     the word "method" appears somewhere in it. */
  for (const route of routes) {
    check(`route ${route.path} declares no method`, route.method === undefined, String(route.method))
  }

  /* ---- the digest timer is armed through the official timer service ---- */
  check('no timer armed before any event', timers.length === 0)

  /* ---- slash command behaviour ---- */
  const invocation = { commandId: 'cmd-test', rawInput: '', attachments: [], signal: new AbortController().signal }

  const status = await command.handler({ ...invocation, rawInput: 'status' })
  check('/notify status returns a success', status && status.kind === 'success', JSON.stringify(status))
  check('/notify status reports the relay state', String(status.text).includes('relay:'), String(status.text).split('\n')[0])

  const badVerb = await command.handler({ ...invocation, rawInput: 'frobnicate' })
  check('/notify <unknown verb> is an error', badVerb.kind === 'error')
  check('/notify <unknown verb> prints usage', String(badVerb.text).includes('usage:'))

  const badMute = await command.handler({ ...invocation, rawInput: 'mute' })
  check('/notify mute without minutes is an error', badMute.kind === 'error')

  const muted = await command.handler({ ...invocation, rawInput: 'mute 30' })
  check('/notify mute 30 succeeds', muted.kind === 'success', muted.text)
  const statusMuted = await command.handler({ ...invocation, rawInput: 'status' })
  check('status reflects the mute', String(statusMuted.text).includes('until'), String(statusMuted.text))

  const noChannel = await command.handler({ ...invocation, rawInput: 'test' })
  check('/notify test with no channel is an error', noChannel.kind === 'error', noChannel.text)

  /* ---- real delivery through the plugin's own intake path ---- */
  await realDeliveryTest(mod, ctx, eventHandlers, command, invocation, routes)

  fs.rmSync(scratch, { recursive: true, force: true })
}

/**
 * Invokes one of the plugin's own route handlers with a fake (req, res) pair
 * and resolves with `{ status, body }`. Driving the plugin's real handler —
 * rather than re-implementing the read — is what proves the route works.
 */
function callRoute(route, options = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const req = {
      method: options.method || 'GET',
      async *[Symbol.asyncIterator]() {
        if (options.body !== undefined) yield Buffer.from(JSON.stringify(options.body), 'utf8')
      },
    }
    const res = {
      writeHead(status) {
        this.status = status
      },
      end(payload) {
        chunks.push(Buffer.from(payload || '', 'utf8'))
        try {
          resolve({ status: this.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch {
          resolve({ status: this.status, body: Buffer.concat(chunks).toString('utf8') })
        }
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

/**
 * Stands up a loopback HTTP server, writes a config that points a webhook
 * channel at it, fires `agent/error`, and asserts the server saw the exact
 * payload the rule center should have produced.
 */
async function realDeliveryTest(mod, ctx, eventHandlers, command, invocation, routes) {
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-live-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = scratch

  const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms))

  /**
   * Waits for a condition instead of sleeping a fixed time. The delivery log is
   * written through a serialized promise queue, so "sleep 200ms and hope" made
   * this gate flaky under load — a flaky gate is worse than no gate, because it
   * trains you to ignore red.
   */
  async function waitFor(predicate, label, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      let value = false
      try {
        value = await predicate()
      } catch {
        value = false
      }
      if (value) return true
      if (Date.now() > deadline) {
        console.log(`  FAIL ${label} — timed out after ${timeoutMs}ms`)
        failures.push(label)
        return false
      }
      await settle(25)
    }
  }

  try {
    /* The command gate above mutes the relay to test /notify mute; clear it so
       the delivery assertions below start from a known state. */
    await command.handler({ ...invocation, rawInput: 'unmute' })

    /* Write the config directly to the plugin's own storage location so the
       plugin's loader — not the test — is what validates it. */
    const storageDir = path.join(scratch, 'storages', 'notify-relay')
    fs.mkdirSync(storageDir, { recursive: true })
    const deliveryConfig = {
      enabled: true,
      events: { 'task.done': false, 'task.failed': true, 'request.failed': true, 'approval.asked': true },
      dedup: { windowMinutes: 10 },
      quiet: { enabled: false, start: '22:00', end: '08:00', mode: 'digest' },
      digest: { enabled: false, intervalMinutes: 30 },
      channels: [
        {
          id: 'live',
          kind: 'webhook',
          name: 'loopback',
          enabled: true,
          secrets: { token: 'live-token' },
          events: ['*'],
          url: `http://127.0.0.1:${port}/hook`,
        },
      ],
    }
    fs.writeFileSync(path.join(storageDir, 'config.json'), JSON.stringify(deliveryConfig, null, 2), 'utf8')

    /* Reload through the plugin's own route: proves the route works AND that
       the redaction contract holds, before anything is delivered. Both halves
       go through the SAME handler, exactly as the live webserver routes them —
       that is the only way a shadowed POST route gets caught. */
    const configRoute = routes.find((route) => route.path === '/notify-relay/config')
    check('/notify-relay/config route exists', !!configRoute)
    if (configRoute) {
      const response = await callRoute(configRoute, { method: 'GET' })
      check('GET /config answers 200', response.status === 200, String(response.status))
      check('GET /config reports ok', response.body && response.body.ok === true)
      const channel = response.body?.config?.channels?.[0]
      check('GET /config returns the channel', !!channel && channel.id === 'live')
      check('GET /config redacts the secret', !JSON.stringify(response.body).includes('live-token'), JSON.stringify(response.body).slice(0, 160))
      check('GET /config returns a placeholder', channel && Object.values(channel.secrets).every((value) => value === mod.REDACTED), channel ? JSON.stringify(channel.secrets) : 'no channel')
      check('GET /config exposes the held count', Number.isFinite(response.body.held), String(response.body.held))

      /* The write half, on the same route. If this ever answers with the read
         shape, the POST is being shadowed and nothing the UI saves persists. */
      const written = await callRoute(configRoute, {
        method: 'POST',
        body: { config: { ...deliveryConfig, enabled: false } },
      })
      check('POST /config answers 200', written.status === 200, String(written.status))
      check('POST /config does not fall through to the read shape', written.body && !('held' in written.body), JSON.stringify(written.body).slice(0, 120))
      check('POST /config applies the write', written.body && written.body.config && written.body.config.enabled === false, JSON.stringify(written.body && written.body.config).slice(0, 120))
      const after = await callRoute(configRoute, { method: 'GET' })
      check('the write is visible on the next read', after.body && after.body.config.enabled === false)
        /* Restore the delivery config, then prove the log route answers. */
      const restored = await callRoute(configRoute, { method: 'POST', body: { config: deliveryConfig } })
      check('restoring the delivery config works', restored.body && restored.body.config.channels.length === 1)

      /* The log route must return the delivery array. A first cut passed the
         ctx logger in under the name `log`, which shadowed the array, so every
         call to this route threw and answered 500 — invisible to the harness,
         which never actually invoked it. */
      const logRoute = routes.find((route) => route.path === '/notify-relay/log')
      check('/notify-relay/log route exists', !!logRoute)
      if (logRoute) {
        const logResponse = await callRoute(logRoute)
        check('GET /log answers 200', logResponse.status === 200, String(logResponse.status))
        check('GET /log returns a list', logResponse.body && Array.isArray(logResponse.body.entries), JSON.stringify(logResponse.body).slice(0, 120))
      }
    }

    const handler = eventHandlers.get('agent/error')
    check('agent/error handler exists', typeof handler === 'function')

    await handler({ sessionId: 'sess-live', title: 'Build broke', detail: 'ECONNRESET' })
    await waitFor(() => received.length === 1, 'the webhook received exactly one delivery')

    if (received.length === 1) {
      const payload = JSON.parse(received[0].body)
      check('delivery is a POST', received[0].method === 'POST')
      check('delivery hits the channel path', received[0].url === '/hook', received[0].url)
      check('bearer token forwarded', received[0].auth === 'Bearer live-token', received[0].auth)
      check('payload source is the plugin id', payload.source === 'notify-relay', payload.source)
      check('payload kind is task.failed', payload.kind === 'task.failed', payload.kind)
      check('payload title survives', payload.title === 'Build broke', payload.title)
      check('payload body survives', payload.body === 'ECONNRESET', payload.body)
      check('payload sessionId survives', payload.sessionId === 'sess-live', payload.sessionId)
    }

    /* A second identical event must be deduplicated. */
    await handler({ sessionId: 'sess-live', title: 'Build broke', detail: 'ECONNRESET' })
    await settle(150)
    check('a repeat inside the dedup window is not re-sent', received.length === 1, `${received.length} received`)

    /* A different failure in the same session must get through. */
    await handler({ sessionId: 'sess-live', title: 'Build broke', detail: 'ETIMEDOUT' })
    await waitFor(() => received.length === 2, 'a different failure in the same session is sent')

    /* The delivery log must record the outcome. The wait is on "both
       deliveries are in the file", not on "the file exists": the first write
       lands before the second delivery has even been made, so waiting for mere
       existence read a half-written log. */
    const logPath = path.join(storageDir, 'deliveries.json')
    const readLog = () => {
      try {
        const entries = JSON.parse(fs.readFileSync(logPath, 'utf8'))
        return Array.isArray(entries) ? entries : []
      } catch {
        return []
      }
    }
    const logReady = await waitFor(() => readLog().length >= 2, 'delivery log recorded both deliveries')
    if (logReady) {
      const entries = readLog()
      check('log has entries', entries.length >= 2, String(entries.length))
      const leaked = JSON.stringify(entries)
      check('log records no secret', !leaked.includes('live-token'), leaked.slice(0, 120))
    }

    /* Mute must suppress everything, including a fresh fingerprint. */
    await command.handler({ ...invocation, rawInput: 'mute 60' })
    await handler({ sessionId: 'sess-live', title: 'Another failure', detail: 'BRAND-NEW' })
    await settle(150)
    check('mute suppresses delivery', received.length === 2, `${received.length} received`)

    /* Unmute restores delivery. */
    await command.handler({ ...invocation, rawInput: 'unmute' })
    await handler({ sessionId: 'sess-live', title: 'Another failure', detail: 'BRAND-NEW-2' })
    await waitFor(() => received.length === 3, 'unmute restores delivery')

    void ctx
  } finally {
    server.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ *
 * Broken-build variants: each one must FAIL the gate, not crash it.
 * ------------------------------------------------------------------ */

/**
 * Broken-build variants. Each one must be REJECTED by the gate, and each
 * declares its own predicate so a variant that fails for the wrong reason (a
 * crash in the harness itself) is not mistaken for a catch.
 *
 * The mutated files are written inside the plugin directory, not the system
 * temp dir: they import `@deepseek-ai/dsh-home-paths`, which only resolves
 * next to the plugin's node_modules.
 */
async function testVariants(mod, originalSource) {
  const variants = [
    {
      label: 'undeclared service read (ctx.webServer read directly in apply)',
      mutate: (source) => source.replace('ctx.inject([\'webServer\']', 'ctx.webServer && ctx.inject([\'webServer\']'),
      expect: ({ threw }) => threw && /without inject/.test(threw.message),
    },
    {
      label: 'inject list emptied',
      mutate: (source) => source.replace(/export const inject = \[[^\]]*\]/, 'export const inject = []'),
      expect: ({ threw }) => threw && /without inject/.test(threw.message),
    },
    {
      label: 'a route path typo',
      mutate: (source) => source.replace('${ROUTE_PREFIX}/flush', '${ROUTE_PREFIX}/flsh'),
      expect: ({ routes }) => !routes.some((route) => route.path === '/notify-relay/flush'),
    },
    {
      label: 'an event listener dropped',
      mutate: (source) => source.replace("['approval/asked', (payload) => intake('approval.asked', payload)],", ''),
      expect: ({ handlers }) => !handlers.has('approval/asked'),
    },
    {
      label: 'the dedup clamp removed',
      mutate: (source) =>
        source.replace(
          'windowMinutes: intInRange(rawDedup.windowMinutes, base.dedup.windowMinutes, 1, 24 * 60)',
          'windowMinutes: rawDedup.windowMinutes',
        ),
      expect: ({ clamped }) => clamped !== 1440,
    },
    /* The bug that only a live boot caught: split the config route back into a
       GET route and a POST route. The real webserver keys routes by PATH, so
       the second registration throws, `registerRoute` swallows the duplicate as
       a double mount, and every save silently lands on the read handler. */
    {
      label: 'a second route registered on an existing path',
      /* The collision the real webserver creates: routes live in a Map keyed by
         PATH, so registering /log on /config throws. `registerRoute` swallows
         the duplicate as a double mount, and the second handler silently never
         runs. This plugin first shipped the same collision as a GET route plus
         a separate POST route on /config — every save answered 200 and
         persisted nothing, and only a live boot caught it, because the
         harness's fake webServer used to match on method like a real router. */
      mutate: (source) => source.replace('path: `${ROUTE_PREFIX}/log`', 'path: `${ROUTE_PREFIX}/config`'),
      expect: ({ duplicateRegistrations, routes }) =>
        duplicateRegistrations.includes('/notify-relay/config') || routes.length !== 4,
    },
  ]

  const dir = path.join(path.dirname(path.resolve(file)), '.sandbox')

  for (const variant of variants) {
    const mutated = variant.mutate(originalSource)
    if (mutated === originalSource) {
      console.log(`  skip ${variant.label} (pattern no longer present)`)
      continue
    }
    const variantPath = path.join(dir, `variant-${Math.random().toString(36).slice(2, 8)}.mjs`)
    fs.writeFileSync(variantPath, mutated, 'utf8')
    try {
      const variantMod = await import(`file://${variantPath.replace(/\\/g, '/')}`)
      const commands = []
      const routes = []
      const handlers = new Map()
      const ctx = makeCtx(variantMod.inject, {
        commands: { register: (d) => (commands.push(d), () => {}) },
        timer: { timeout: () => () => {} },
      })
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-var-'))
      const previousHome = process.env.DSH_HOME
      process.env.DSH_HOME = scratch
      /* Same shape as the real webServer: a Map keyed by path, duplicates
         throwing. Without this a split GET/POST route registers cleanly in the
         variant and the collision never surfaces. */
      const routeTable = new Map()
      const duplicateRegistrations = []
      const webServer = {
        register(route) {
          if (routeTable.has(route.path)) {
            duplicateRegistrations.push(route.path)
            throw new Error(`duplicate route: ${route.path}`)
          }
          routeTable.set(route.path, route)
          routes.push(route)
          return () => {}
        },
      }
      const webCtx = makeCtx(['webServer'], { webServer })
      Object.defineProperty(ctx, 'on', { value: (e, h) => (handlers.set(e, h), () => {}), configurable: true })
      Object.defineProperty(ctx, 'inject', {
        value: (s, cb) => (typeof cb === 'function' && cb(webCtx), () => {}),
        configurable: true,
      })
      let threw = null
      try {
        await variantMod.apply(ctx)
      } catch (error) {
        threw = error
      } finally {
        if (previousHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previousHome
      }

      /* The rule-engine checks run against the mutated module too, so a variant
         that only breaks a pure function is caught by the same assertions the
         good build passes. */
      let clamped = 1440
      try {
        const clampedResult = variantMod.validateConfig({ dedup: { windowMinutes: 99999 } })
        clamped = clampedResult.ok ? clampedResult.value.dedup.windowMinutes : 'rejected'
      } catch (error) {
        clamped = `threw ${error.message}`
      }

      const caught = variant.expect({ threw, routes, handlers, clamped, commands, duplicateRegistrations })
      if (caught) {
        console.log(`  ok   variant rejected: ${variant.label}`)
        checks.push(variant.label)
      } else {
        console.log(
          `  FAIL variant rejected: ${variant.label} — expected a failure, got none ` +
            `(threw=${threw ? threw.message : 'no'}, routes=${routes.length}, handlers=${handlers.size}, clamped=${clamped}, dupes=${duplicateRegistrations.join('|') || 'none'})`,
        )
        failures.push(variant.label)
      }
      fs.rmSync(scratch, { recursive: true, force: true })
      void mod
    } catch (error) {
      console.log(`  FAIL variant rejected: ${variant.label} — harness crashed: ${error.message}`)
      failures.push(variant.label)
    } finally {
      fs.rmSync(variantPath, { force: true })
    }
  }
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

async function main() {
  const url = `file://${path.resolve(file).replace(/\\/g, '/')}`
  const mod = await import(url)

  console.log('\n== rule engine ==')
  testValidateConfig(mod)
  testFingerprint(mod)
  testQuietHours(mod)
  testBuildDelivery(mod)
  testRedaction(mod)

  console.log('\n== apply() contract ==')
  await testApply(mod)

  console.log('\n== broken-build variants ==')
  await testVariants(mod, fs.readFileSync(path.resolve(file), 'utf8'))

  console.log(`\n${checks.length} checks, ${failures.length} failure(s)`)
  if (failures.length) {
    console.log('\nHOST GATE FAIL')
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exit(1)
  }
  console.log('HOST GATE OK')
  process.exit(0)
}

main().catch((error) => {
  console.log(`FAIL: ${error && error.message}`)
  console.log(String(error && error.stack).split('\n').slice(0, 10).join('\n'))
  process.exit(1)
})
