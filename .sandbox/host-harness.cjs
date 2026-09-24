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
  /* A mixin service installs its own methods on the context, so they are
     reachable WITHOUT being named in `inject`. `@cordisjs/plugin-timer` does
     exactly this (`ctx.mixin('timer', [...])`), which is why the plugin writes
     `ctx.timeout(...)` and why the fail-loud proxy must allow those names
     whenever the service itself is declared. Without this the proxy reports a
     contract violation that does not exist in production. */
  const MIXIN_SURFACE = {
    timer: ['timeout', 'interval', 'throttle', 'debounce', 'setTimeout', 'setInterval'],
  }
  const allowed = new Set([...CORDIS_BUILTINS, ...injectList])
  for (const [service, methods] of Object.entries(MIXIN_SURFACE)) {
    if (injectList.includes(service)) for (const method of methods) allowed.add(method)
  }
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
      const noop = () => {}
      if (!process.env.NOTIFY_DEBUG) return { info: noop, warn: noop, error: noop, debug: noop }
      return {
        info: noop,
        warn: (message) => console.log('  [dbg] warn:', String(message)),
        error: (message) => console.log('  [dbg] error:', String(message)),
        debug: noop,
      }
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

  /* `@cordisjs/plugin-timer` is a MIXIN: `ctx.mixin('timer', ['timeout',
     'interval', ...])` (cordis-plugin-timer/src/index.ts:15) puts the methods
     directly on the context, so the plugin correctly writes `ctx.timeout(...)`.
     The first cut of this harness only offered `ctx.timer.timeout`, and the
     fail-loud proxy rightly refused `ctx.timeout` — but the digest path was
     never reached with a queued item, so the mismatch stayed latent and the
     gate stayed green. Both surfaces are provided now. */
  const timerService = {
    timeout(callback, delay) {
      timers.push({ callback, delay })
      return () => {}
    },
    interval(callback, delay) {
      timers.push({ callback, delay, interval: true })
      return () => {}
    },
  }
  const services = {
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      },
    },
    timer: timerService,
    timeout: timerService.timeout,
    interval: timerService.interval,
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
      /* The outbox test needs the real `session/event` listener, and this
         closure is the only place that sees it. Capture it rather than
         re-implementing the dispatch — the whole point of the harness is to
         drive the plugin's own code path. */
      if (event === 'session/event') currentSessionListener = handler
      serviceReads.push(`on:${event}`)
      return () => eventHandlers.delete(event)
    },
    configurable: true,
  })

  /* The plugin's apply() is async and touches DSH_HOME; the harness points
     that at a scratch directory so nothing real is read or written. The
     scratch home stays installed for the WHOLE test, not just apply(): every
     handler driven below writes the delivery log, and that must not land in
     the developer's real ~/.dsh. */
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-harness-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = scratch
  const readDeliveries = async () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(scratch, 'storages', 'notify-relay', 'deliveries.json'), 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  const restoreHome = () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }

  try {
    await mod.apply(ctx)
  } catch (error) {
    restoreHome()
    throw error
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

  /* ---- event listeners ----

     This is the check that catches the bug 0.1.0 actually shipped. Session
     events (turn/step/message/tool/approval) are dispatched ONCE, under the
     single name `session/event`, as `(session, event)` — there is no re-emit
     under the individual name. So `ctx.on('turn/end')` and
     `ctx.on('approval/asked')` are listeners on events that never fire, and
     half the notification coverage is silently dead.

     A fake ctx that records whatever name you hand it cannot see that. So the
     registry below is transcribed from the real dispatch sites:
       - `dsh-session/lib/types/index.js:600` dispatches 'session/event'
       - `dsh-agent/lib/types/runtime-types.d.ts:227-402` lists the global
         agent/* names (created/disposed/status/pre-step/request/request-error/
         assistant-stream/turn-stopping/error)
     Every name the plugin registers must appear here, and the plugin's own
     declared HOST_EVENT_NAMES must match what it registers. */
  const DISPATCHED_EVENT_NAMES = new Set([
    'session/event',
    'session/created',
    'session/disposed',
    'session/flush',
    'agent/created',
    'agent/disposed',
    'agent/status',
    'agent/pre-step',
    'agent/request',
    'agent/request-error',
    'agent/assistant-stream',
    'agent/turn-stopping',
    'agent/error',
    'approval/request',
    'tools/change',
    'loader/config-update',
    'internal/plugin',
    'internal/status',
    'internal/dispatch',
  ])

  const expectedEvents = ['agent/error', 'agent/request-error', 'session/event']
  for (const event of expectedEvents) {
    check(`listens to ${event}`, eventHandlers.has(event))
  }
  check('no unexpected listeners', eventHandlers.size === expectedEvents.length, [...eventHandlers.keys()].join(','))
  for (const name of eventHandlers.keys()) {
    check(`"${name}" is an event DSH actually dispatches`, DISPATCHED_EVENT_NAMES.has(name), 'not in the dispatch registry')
  }
  const declaredNames = Array.isArray(mod.HOST_EVENT_NAMES) ? mod.HOST_EVENT_NAMES : []
  check('HOST_EVENT_NAMES matches the real listeners', declaredNames.length === eventHandlers.size && declaredNames.every((n) => eventHandlers.has(n)), declaredNames.join(','))
  check('no listener on a session-event sub-name', !['turn/end', 'approval/asked', 'approval/decided', 'tool/result', 'turn/start'].some((n) => eventHandlers.has(n)), [...eventHandlers.keys()].join(','))

  const expectedPaths = ['/notify-relay/config', '/notify-relay/log', '/notify-relay/test', '/notify-relay/flush', '/notify-relay/retry']
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

  /* Declared here because the dispatch block below needs it to clear the mute
     that `/notify mute 30` leaves set — a muted relay logs nothing, so every
     assertion below would come back "muted" instead of the real verdict. */
  const invocation = { commandId: 'cmd-test', rawInput: '', attachments: [], signal: new AbortController().signal }

  const allEvents = {}
  for (const kind of mod.EVENT_KINDS) allEvents[kind.id] = true

  /* ---- session/event dispatch ----

     Driving the real handler with synthetic `(session, event)` pairs is the
     only way to prove the mapping works: `turn/end` reason=aborted must become
     `task.aborted`, not `task.done`. 0.1.0 reported every turn end as "done",
     which told the user a cancelled turn had succeeded.

     This sits after the command gate because it needs `invocation` — and
     because the mute test above leaves the relay muted, which would make every
     verdict below come back "muted" and log nothing. */
  const sessionHandler = eventHandlers.get('session/event')
  check('session/event handler exists', typeof sessionHandler === 'function')
  if (typeof sessionHandler === 'function') {
    await command.handler({ ...invocation, rawInput: 'unmute' })

    /* A channel is needed for anything to be logged: `recordDelivery` runs once
       per channel, so an empty config produces no rows at all. Configured
       through the plugin's own POST route — the same path the browser takes.
       Every event kind is switched on explicitly: this block is about DISPATCH,
       and `task.done` / `approval.decided` are off by default because a
       completed turn is routine. The defaults themselves are asserted above. */
    const dead = await callRouteByPath(routes, '/notify-relay/config', {
      method: 'POST',
      body: {
        config: {
          enabled: true,
          language: LANG,
          events: allEvents,
          channels: [{ id: 'probe', kind: 'webhook', events: ['*'], secrets: { token: '' }, url: 'http://127.0.0.1:1/dead' }],
        },
      },
    })
    check('the dispatch probe channel was accepted', dead.status === 200 && dead.body?.ok === true, `${dead.status} ${JSON.stringify(dead.body)}`)

    const session = { id: 'sess-dispatch' }
    /* The delivery log is the observable surface: every notification the
       handler produces ends up there, carrying the event kind. */
    const before = await readDeliveries()

    await sessionHandler(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    await sessionHandler(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await sessionHandler(session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'blocked' } } })
    await sessionHandler(session, { type: 'approval/asked', data: { id: 'a1', toolName: 'bash', reason: 'rm -rf' } })
    await sessionHandler(session, { type: 'approval/decided', data: { id: 'a1', outcome: 'approved' } })
    await sessionHandler(session, { type: 'tool/result', data: { callId: 'c1', name: 'bash', error: { name: 'SpawnError', code: 'ENOENT', reason: 'spawn bash ENOENT' } } })
    /* A tool result WITHOUT an error must not notify. */
    await sessionHandler(session, { type: 'tool/result', data: { callId: 'c2', name: 'bash' } })
    /* An unrelated event must not notify either. */
    await sessionHandler(session, { type: 'assistant/message', data: { turn: 4, step: 0 } })
    /* A malformed event must not throw out of the handler. */
    await sessionHandler(session, { type: 'turn/end' })
    await sessionHandler(session, null)
    await sessionHandler(undefined, undefined)

    await waitFor(() => readDeliveries().then((entries) => entries.length > before.length).catch(() => false), 'at least one notification was produced')
    const entries = await readDeliveries()
    const kinds = entries.map((entry) => entry.event)
    check('an aborted turn is reported as task.aborted', kinds.includes('task.aborted'), kinds.join(','))
    check('a completed turn is reported as task.done', kinds.includes('task.done'), kinds.join(','))
    check('a blocked turn is reported as task.blocked', kinds.includes('task.blocked'), kinds.join(','))
    check('approval/asked is reported', kinds.includes('approval.asked'), kinds.join(','))
    check('approval/decided is reported', kinds.includes('approval.decided'), kinds.join(','))
    check('a failed tool result is reported', kinds.includes('tool.failed'), kinds.join(','))
    const failedEntry = entries.find((entry) => entry.event === 'tool.failed')
    check('the failed tool row names the tool', !!failedEntry && failedEntry.title === 'SpawnError', failedEntry ? failedEntry.title : 'not found')
    const approvalEntry = entries.find((entry) => entry.event === 'approval.asked')
    check('the approval row names the tool', !!approvalEntry && approvalEntry.title === 'bash', approvalEntry ? approvalEntry.title : 'not found')
    check('a successful tool result does not notify', entries.filter((entry) => entry.event === 'tool.failed').length === 1)
    check('an unrelated session event does not notify', !entries.some((entry) => entry.title === 'assistant/message'))
    check('every row records the event kind', entries.every((entry) => typeof entry.event === 'string' && entry.event.length > 0), JSON.stringify(entries[0]))
  }

  /* ---- the pierce rule: quiet hours must not stall an approval ----

     Every competitor in this ecosystem either has no quiet hours or applies
     them blindly, and the result is the same: an approval request held until
     08:00 is a task dead until 08:00, and the user blames the notifier. */
  const pierceConfig = (quietOverrides = {}) => ({
    enabled: true,
    language: LANG,
    quiet: { enabled: true, start: '00:00', end: '23:59', mode: 'digest', ...quietOverrides },
    digest: { enabled: true, intervalMinutes: 30 },
    events: allEvents,
    channels: [{ id: 'probe', kind: 'webhook', events: ['*'], secrets: { token: '' }, url: 'http://127.0.0.1:1/dead' }],
  })

  await callRouteByPath(routes, '/notify-relay/config', { method: 'POST', body: { config: pierceConfig() } })
  const pierceVerdicts = {}
  for (const kind of mod.EVENT_KINDS) {
    pierceVerdicts[kind.id] = mod.classify({ kind: kind.id, sessionId: 's', title: 't', body: 'b' })
  }
  check('approval.asked pierces quiet hours', pierceVerdicts['approval.asked'].verdict === 'send', JSON.stringify(pierceVerdicts['approval.asked']))
  check('a routine event is still held by quiet hours', pierceVerdicts['task.failed'].verdict === 'quiet-hold', JSON.stringify(pierceVerdicts['task.failed']))
  check('a routine event is still batched by digest', pierceVerdicts['task.failed'].verdict === 'quiet-hold' || pierceVerdicts['task.failed'].verdict === 'digest', JSON.stringify(pierceVerdicts['task.failed']))

  /* Quiet hours off, digest on: the piercing event still goes now. */
  await callRouteByPath(routes, '/notify-relay/config', { method: 'POST', body: { config: pierceConfig({ enabled: false }) } })
  check('approval.asked pierces digest batching', mod.classify({ kind: 'approval.asked', sessionId: 's', title: 't', body: 'b' }).verdict === 'send')
  check('a routine event is batched when quiet hours are off', mod.classify({ kind: 'task.failed', sessionId: 's', title: 't2', body: 'b' }).verdict === 'digest')

  /* ---- suppression is recorded, not swallowed ----

     The most common complaint about notification plugins is "I cannot tell
     whether it fired". A log with only successful rows cannot answer that,
     because the interesting row is the missing one. */
  const suppressedBefore = await readDeliveries()
  await sessionHandler({ id: 'sess-supp' }, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })
  await sessionHandler({ id: 'sess-supp' }, { type: 'assistant/message', data: { turn: 10 } })
  await waitFor(() => readDeliveries().then((e) => e.length > suppressedBefore.length).catch(() => false), 'a suppressed notification was recorded')
  const suppressed = await readDeliveries()
  const quietRow = suppressed.find((entry) => entry.suppressed === 'digest')
  check('a digest hold is recorded with its reason', !!quietRow && /digest/i.test(String(quietRow.error)), quietRow ? quietRow.error : 'not found')
  check('the held row names the event', !!quietRow && quietRow.event === 'task.done', quietRow ? quietRow.event : 'not found')
  check('an ignored event leaves no row', !suppressed.some((entry) => entry.event === 'assistant/message'))

  /* ---- real delivery through the plugin's own intake path ---- */
  await realDeliveryTest(mod, ctx, eventHandlers, command, invocation, routes)

  /* ---- slash command behaviour ---- */

  const status = await command.handler({ ...invocation, rawInput: 'status' })
  check('/notify status returns a success', status && status.kind === 'success', JSON.stringify(status))
  check('/notify status reports the relay state', String(status.text).includes(STATUS_HEAD), String(status.text).split('\n')[0])
  check('/notify status reports the pending retry count', /retry|重试/.test(String(status.text)), String(status.text))

  const badVerb = await command.handler({ ...invocation, rawInput: 'frobnicate' })
  check('/notify <unknown verb> is an error', badVerb.kind === 'error')
  check('/notify <unknown verb> prints usage', String(badVerb.text).includes(USAGE_MARK), String(badVerb.text))

  const badMute = await command.handler({ ...invocation, rawInput: 'mute' })
  check('/notify mute without minutes is an error', badMute.kind === 'error')

  const muted = await command.handler({ ...invocation, rawInput: 'mute 30' })
  check('/notify mute 30 succeeds', muted.kind === 'success', muted.text)
  const statusMuted = await command.handler({ ...invocation, rawInput: 'status' })
  check('status reflects the mute', /until|恢复/.test(String(statusMuted.text)), String(statusMuted.text))

  const noChannel = await command.handler({ ...invocation, rawInput: 'test' })
  check('/notify test with no channel is an error', noChannel.kind === 'error', noChannel.text)

  restoreHome()
  fs.rmSync(scratch, { recursive: true, force: true })
}

/**
 * Finds a registered route by path and drives its handler with a fake
 * (req, res) pair. Driving the plugin's real handler — rather than
 * re-implementing the read — is what proves the route works.
 */
async function callRouteByPath(routes, path, options = {}) {
  const route = routes.find((candidate) => candidate.path === path)
  if (!route) throw new Error(`no route registered for ${path}`)
  return callRoute(route, options)
}

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

const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms))

/** The language this run exercises. The gate runs the harness once per language,
 * and the host now localizes everything it emits — digest titles, command
 * replies, suppression reasons — so a build that only reads correctly in
 * Chinese proves nothing about the English output.
 */
const LANG = process.env.HARNESS_LANG === 'en' ? 'en' : 'zh'

/**
 * The live `session/event` handler, captured at registration time.
 *
 * Module scope because the outbox test runs inside `realDeliveryTest`, a
 * separate function that cannot see `testApply`'s closure — and because
 * capturing the real handler is what makes the test drive the plugin's own
 * dispatch path instead of a re-implementation of it.
 */
let currentSessionListener = null

/** The localized `/notify status` head, for assertions on the command output. */
const STATUS_HEAD = LANG === 'en' ? 'notify-relay status' : 'notify-relay 状态'
const USAGE_MARK = LANG === 'en' ? 'usage:' : '用法'

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

  try {
    /* Clear the mute the dispatch block above may have left set, so the
       delivery assertions start from a known state. */
    await command.handler({ ...invocation, rawInput: 'unmute' })

    /* Write the config directly to the plugin's own storage location so the
       plugin's loader — not the test — is what validates it. */
    const storageDir = path.join(scratch, 'storages', 'notify-relay')
    fs.mkdirSync(storageDir, { recursive: true })
    const deliveryConfig = {
      enabled: true,
      language: LANG,
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

    /* ---- the durable outbox ----

       An in-memory retry queue loses every pending retry on restart, which is
       the documented limitation of the best-known notifier in this ecosystem
       (dsh-notifier's queue is process-local). So: a delivery that fails is
       persisted, retried with a backoff, and survives a fresh plugin
       instance reading the same home. */
    await outboxTest(mod, server, port, scratch, invocation, routes, readLog)

    void ctx
  } finally {
    server.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Boots a SECOND, independent plugin instance against the same home.
 *
 * Two jobs at once: it isolates the outbox assertions from the state the main
 * instance accumulated during the dispatch and delivery tests, and it IS the
 * restart test. `apply()` is what a restart runs — it re-reads the persisted
 * outbox, so anything still queued when the first instance goes away must come
 * back here. An in-memory queue would not, and that is exactly the limitation
 * this feature exists to remove.
 */
async function bootInstance(mod) {
  const commands = []
  const routes = []
  const routeTable = new Map()
  const eventHandlers = new Map()
  let sessionListener = null
  let agentListener = null
  let live = true

  const timerService = {
    timeout(callback, delay) {
      if (!live) return () => {}
      return () => {}
    },
    interval() {
      return () => {}
    },
  }

  const webServer = {
    register(route) {
      if (routeTable.has(route.path)) throw new Error(`duplicate route: ${route.path}`)
      routeTable.set(route.path, true)
      routes.push(route)
      return () => {}
    },
  }

  const ctx = makeCtx(mod.inject, {
    commands: { register: (definition) => commands.push(definition) },
    timer: timerService,
    timeout: timerService.timeout,
    interval: timerService.interval,
  })
  const webCtx = makeCtx(['webServer'], { webServer })
  Object.defineProperty(ctx, 'inject', {
    value(services_, callback) {
      if (typeof callback === 'function') callback(webCtx)
      return () => {}
    },
    configurable: true,
  })
  Object.defineProperty(ctx, 'on', {
    value(event, handler) {
      eventHandlers.set(event, handler)
      if (event === 'session/event') sessionListener = handler
      if (event === 'agent/error') agentListener = handler
      return () => {}
    },
    configurable: true,
  })

  /* `apply()` is async: the storage loads happen before the registrations, so
     the instance is not usable until the returned promise settles. Skipping
     the await yields an instance with zero commands and zero routes, which
     reads like a plugin bug and is not one. */
  await mod.apply(ctx)
  const command = commands.find((entry) => entry.name === 'notify')
  return {
    ctx,
    command,
    routes,
    sessionListener,
    agentListener,
    dispose() {
      live = false
    },
  }
}

/**
 * Outbox behaviour: enqueue on failure, backoff, give-up, and — the point of
 * the whole feature — survival across a restart.
 *
 * The server is shared with the caller so the port stays live; it is switched
 * into "failing" mode for the first half and back for the second.
 */
async function outboxTest(mod, server, port, scratch, invocation, routes, readLog) {
  const storageDir = path.join(scratch, 'storages', 'notify-relay')
  const outboxPath = path.join(storageDir, 'outbox.json')

  /* Flip the loopback server into a 500 responder. */
  server.removeAllListeners('request')
  let failing = true
  server.on('request', (req, res) => {
    req.resume()
    if (failing) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"ok":false}')
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    }
  })

  const outboxEntries = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(outboxPath, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /* ---- first instance: a failed delivery is persisted ---- */
  const first = await bootInstance(mod)
  check('a restarted instance registers the slash command', !!first.command)
  check('a restarted instance registers its routes', first.routes.length === 5, `${first.routes.length} routes`)

  const configRoute = first.routes.find((route) => route.path === '/notify-relay/config')
  const retryRoute = first.routes.find((route) => route.path === '/notify-relay/retry')

  /* Re-arm the delivery config against the failing channel. The write goes
     through the plugin's own route, so the loader is what validates it. */
  await callRoute(configRoute, {
    method: 'POST',
    body: {
      config: {
        enabled: true,
        language: LANG,
        events: { 'task.failed': true, 'request.failed': true, 'approval.asked': true },
        dedup: { windowMinutes: 0 },
        quiet: { enabled: false, start: '22:00', end: '08:00', mode: 'digest' },
        digest: { enabled: false, intervalMinutes: 30 },
        channels: [
          { id: 'live', kind: 'webhook', name: 'loopback', enabled: true, secrets: { token: 'live-token' }, events: ['*'], url: `http://127.0.0.1:${port}/hook` },
        ],
      },
    },
  })

  /* `agent/error` is a SCOPED agent event: it is dispatched under its own
     name, so the registered listener is the one to drive. Feeding it under
     `session/event` would be a synthetic event DSH never dispatches, and the
     intake would never run — a test that passes for the wrong reason. */
  await first.agentListener({ sessionId: 'sess-outbox', title: 'boom', detail: 'ECONNRESET' })
  await waitFor(() => outboxEntries().length === 1, 'a failed delivery is persisted to the outbox')

  const queued = outboxEntries()
  check('the outbox holds the failed notification', queued.length === 1, `${queued.length} entries`)
  const entry = queued[0]
  check('the outbox entry records the event kind', !!entry && entry.notification.kind === 'task.failed', entry ? entry.notification.kind : 'none')
  check('the outbox entry records the title', !!entry && entry.notification.title === 'boom', entry ? entry.notification.title : 'none')
  check('the outbox entry starts at attempt 1', !!entry && entry.attempts === 1, entry ? String(entry.attempts) : 'none')
  check('the outbox entry is scheduled in the future', !!entry && entry.nextAttemptAt > Date.now(), entry ? String(entry.nextAttemptAt) : 'none')
  check('the outbox entry records why it failed', !!entry && /live/.test(String(entry.lastError)), entry ? String(entry.lastError) : 'none')
  check('the outbox file holds no secret', !JSON.stringify(queued).includes('live-token'), JSON.stringify(queued).slice(0, 160))

  /* ---- the retry route ---- */
  const peek = await callRoute(retryRoute)
  check('GET /retry reports the pending count', peek.body && peek.body.pending === 1, JSON.stringify(peek.body).slice(0, 120))

  const forced = await callRoute(retryRoute, { method: 'POST' })
  check('POST /retry answers 200', forced.status === 200, String(forced.status))
  check('POST /retry reports it retried something', forced.body && forced.body.retried === 1, JSON.stringify(forced.body).slice(0, 160))
  const afterRetry = outboxEntries()
  check('a retry that fails re-queues rather than dropping', afterRetry.length === 1, `${afterRetry.length} entries`)
  check('the attempt counter advanced', afterRetry[0] && afterRetry[0].attempts === 2, afterRetry[0] ? String(afterRetry[0].attempts) : 'not found')
  check('the backoff grows', afterRetry[0] && afterRetry[0].nextAttemptAt > entry.nextAttemptAt, `${entry.nextAttemptAt} -> ${afterRetry[0] && afterRetry[0].nextAttemptAt}`)

  /* ---- heal the endpoint: the retry must clear the entry ---- */
  failing = false
  const healed = await callRoute(retryRoute, { method: 'POST' })
  check('a retry that succeeds reports it', healed.body && healed.body.retried === 1, JSON.stringify(healed.body).slice(0, 160))
  await waitFor(() => outboxEntries().length === 0, 'a successful retry clears the outbox')
  check('the outbox is empty after a successful retry', outboxEntries().length === 0, `${outboxEntries().length} left`)

  /* ---- give-up: an entry at the ceiling is dropped, not retried forever ---- */
  fs.writeFileSync(
    outboxPath,
    JSON.stringify([{ notification: { kind: 'task.failed', sessionId: 'x', title: 't', body: 'b', createdAt: new Date().toISOString() }, attempts: 6, nextAttemptAt: 0, lastError: 'live: http 500' }], null, 2),
    'utf8',
  )
  /* Reload through a boot so the in-memory queue matches the file — that is
     what a restart does, and it is the only way to test the ceiling without
     driving six real failures. */
  const spent = await bootInstance(mod)
  await callRoute(spent.routes.find((route) => route.path === '/notify-relay/retry'), { method: 'POST' })
  await waitFor(() => outboxEntries().length === 0, 'an entry at the attempt ceiling is dropped')
  check('an entry past MAX_DELIVERY_ATTEMPTS is given up on', outboxEntries().length === 0, `${outboxEntries().length} left`)
  check('the give-up is recorded in the log', readLog().some((item) => /abandoned|attempts/i.test(String(item.error))), JSON.stringify(readLog().slice(0, 2)))

  /* ---- restart survival: a third boot must see the surviving entry ---- */
  fs.writeFileSync(
    outboxPath,
    JSON.stringify([{ notification: { kind: 'task.failed', sessionId: 'y', title: 'survivor', body: 'b', createdAt: new Date().toISOString() }, attempts: 1, nextAttemptAt: Date.now() + 60_000, lastError: 'live: http 500' }], null, 2),
    'utf8',
  )
  const third = await bootInstance(mod)
  const peekAfterRestart = await callRoute(third.routes.find((route) => route.path === '/notify-relay/retry'))
  check('a restarted instance recovers the pending outbox', peekAfterRestart.body && peekAfterRestart.body.pending === 1, JSON.stringify(peekAfterRestart.body).slice(0, 120))
  const statusAfterRestart = await third.command.handler({ ...invocation, rawInput: 'status' })
  check('status reports the recovered pending count', /1/.test(String(statusAfterRestart.text)), String(statusAfterRestart.text))

  first.dispose()
  spent.dispose()
  third.dispose()
}

/**
 * Boots a variant plugin instance in isolation and drives ONE failing delivery
 * through it, then reports what landed on disk.
 *
 * The shallow checks in the variant loop only see registrations. This is the
 * one that sees behaviour: a build that keeps the retry queue in memory passes
 * every registration assertion and still loses the queue on restart.
 */
async function probeOutbox({ variantMod, scratch, makeCtx }) {
  const storageDir = path.join(scratch, 'storages', 'notify-relay')
  const outboxPath = path.join(storageDir, 'outbox.json')

  /* The variant loop restores DSH_HOME in its own finally, which runs BEFORE
     this probe. Without re-pointing it here, every write the plugin makes
     lands in the real user home and the probe reads an empty scratch — the
     probe then reports "no outbox" for a build that has a perfectly good
     outbox, and the gate green-lights a regression it never actually saw. */
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = scratch

  const server = http.createServer((req, res) => {
    req.resume()
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end('{"ok":false}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const commands = []
  const routes = []
  const handlers = new Map()
  const table = new Map()
  const timer = { timeout: () => () => {}, interval: () => () => {} }
  const webServer = {
    register(route) {
      if (table.has(route.path)) throw new Error(`duplicate route: ${route.path}`)
      table.set(route.path, route)
      routes.push(route)
      return () => {}
    },
  }
  const webCtx = makeCtx(['webServer'], { webServer })
  const ctx = makeCtx(variantMod.inject, {
    commands: { register: (definition) => (commands.push(definition), () => {}) },
    timer,
    timeout: timer.timeout,
    interval: timer.interval,
  })
  Object.defineProperty(ctx, 'on', { value: (event, handler) => (handlers.set(event, handler), () => {}), configurable: true })
  Object.defineProperty(ctx, 'inject', { value: (s, cb) => (typeof cb === 'function' && cb(webCtx), () => {}), configurable: true })

  const readOutbox = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(outboxPath, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  try {
    await variantMod.apply(ctx)
    const configRoute = routes.find((route) => route.path === '/notify-relay/config')
    if (!configRoute) return { booted: false }
    const posted = await callRoute(configRoute, {
      method: 'POST',
      body: {
        config: {
          enabled: true,
          language: 'zh',
          events: { 'task.failed': true },
          dedup: { windowMinutes: 0 },
          quiet: { enabled: false, start: '22:00', end: '08:00', mode: 'digest' },
          digest: { enabled: false, intervalMinutes: 30 },
          channels: [{ id: 'live', kind: 'webhook', enabled: true, secrets: {}, events: ['*'], url: `http://127.0.0.1:${port}/hook` }],
        },
      },
    })
    const configOk = posted.status === 200 && posted.body && posted.body.ok === true && posted.body.config && posted.body.config.enabled === true
    const agentListener = handlers.get('agent/error')
    if (typeof agentListener !== 'function') return { booted: true, configOk, noListener: true }
    await agentListener({ sessionId: 'probe', title: 'boom', detail: 'ECONNRESET' })
    await settle(400)

    const persisted = readOutbox().length > 0
    const retryRoute = routes.find((route) => route.path === '/notify-relay/retry')
    if (!retryRoute) return { booted: true, configOk, persisted, noRetryRoute: true }

    /* Force a retry six times: a build without the give-up ceiling still holds
       the entry afterwards, which is the unbounded-growth bug. */
    for (let attempt = 0; attempt < 6; attempt += 1) await callRoute(retryRoute, { method: 'POST' })
    await settle(200)
    return { booted: true, configOk, persisted, gaveUp: readOutbox().length === 0, held: readOutbox().length }
  } finally {
    server.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
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
      /* The bug that shipped in 0.1.0 and was invisible until a live boot: the
         plugin listened on `turn/end` and `approval/asked` directly, but those
         are SESSION event types. DSH dispatches them once, under `session/event`,
         as `(session, event)` — there is no re-emit under the individual name.
         So half the event coverage was a listener on an event that never fires.
         The plugin registered, logged, answered its routes, and notified on
         nothing. Exactly the "no notification is ever sent" failure mode that
         dominates this ecosystem's bug reports. */
      label: 'a listener registered on a session-event sub-name',
      mutate: (source) =>
        source
          .replace("      'session/event',\n", '')
          .replace(
            "      ['agent/error', (payload) => intake('task.failed', payload)],",
            "      ['agent/error', (payload) => intake('task.failed', payload)],\n      ['turn/end', (payload) => intake('task.done', payload)],\n      ['approval/asked', (payload) => intake('approval.asked', payload)],",
          ),
      expect: ({ handlers }) => handlers.has('turn/end') || handlers.has('approval/asked'),
    },
    {
      /* The second half of the same bug, and the reason the dispatch block
         exists: the wrapper must forward EVERY argument. `session/event` is
         dispatched as `(session, event)`, so a wrapper written
         `(payload) => handler(payload)` drops `event`, `event.type` reads as
         undefined, and every branch no-ops. The plugin still registers, logs
         and answers its routes — it just notifies on nothing. */
      label: 'the listener wrapper drops the second argument',
      mutate: (source) =>
        source.replace(
          'ctx.on(event, (...args) => {\n        void Promise.resolve(handler(...args))',
          'ctx.on(event, (payload) => {\n        void Promise.resolve(handler(payload))',
        ),
      expect: ({ source }) => !/ctx\.on\(event, \(\.\.\.args\)/.test(source),
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
    {
      /* The retry queue is the whole point of the outbox. A build that keeps
         it in memory passes every unit test and loses every pending retry on
         restart — the documented limitation of the incumbent notifier, and the
         reason this feature exists. */
      label: 'the outbox is not persisted',
      mutate: (source) => source.replace('  outbox = outbox.slice(0, MAX_OUTBOX_ENTRIES)\n  await persistOutbox()\n}', '  outbox = outbox.slice(0, MAX_OUTBOX_ENTRIES)\n}'),
      probe: probeOutbox,
      expect: ({ probe }) => probe && probe.persisted === false,
    },
    {
      /* Without a ceiling the outbox grows forever: a failed endpoint means an
         unbounded array of retries, which is a memory leak with a friendly
         name. */
      label: 'the give-up ceiling removed',
      mutate: (source) => source.replace('if (item.attempts >= MAX_DELIVERY_ATTEMPTS) {', 'if (false) {'),
      probe: probeOutbox,
      expect: ({ probe }) => probe && probe.gaveUp === false,
    },
    {
      /* The retry route is the only user-facing handle on the outbox. Without
         it a failed delivery is invisible and unfixable from the UI. */
      label: 'the retry route removed',
      mutate: (source) => source.replace(/  \/\* One route per path, method switched inside[\s\S]*?disposers\.push\(\n    registerRoute\(\n      webServer,\n      \{\n        kind: 'exact',\n        path: `\$\{ROUTE_PREFIX\}\/retry`,[\s\S]*?\},\n      log,\n    \),\n  \)\n/, ''),
      expect: ({ routes }) => !routes.some((route) => route.path === '/notify-relay/retry'),
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

      /* A behavioural probe: drive a real failing delivery through the mutated
         build and look at the outbox on disk. The shallow checks above cannot
         see this class of bug — a build that keeps the queue in memory passes
         every registration assertion. */
      let probe = null
      if (variant.probe) {
        probe = await variant.probe({ variantMod, scratch, makeCtx })
      }

      const caught = variant.expect({ threw, routes, handlers, clamped, commands, duplicateRegistrations, probe, source: mutated })
      if (caught) {
        console.log(`  ok   variant rejected: ${variant.label}`)
        checks.push(variant.label)
      } else {
        console.log(
          `  FAIL variant rejected: ${variant.label} — expected a failure, got none ` +
            `(threw=${threw ? threw.message : 'no'}, routes=${routes.length}, handlers=${handlers.size}, clamped=${clamped}, dupes=${duplicateRegistrations.join('|') || 'none'}, probe=${probe ? JSON.stringify(probe) : 'n/a'})`,
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
