/**
 * dsh-notify-relay — host face.
 *
 * The outbound rule center. DSH emits a rich lifecycle event vocabulary
 * (`turn/end`, `agent/error`, `approval/asked`, …) but ships no way to tell
 * anyone about it: dsh-schedule states outright that "Delivery never uses
 * email, SMS, push, or browser notifications". This plugin is that missing
 * hop — it listens, then decides, then delivers:
 *
 *   event → classify → dedup → quiet hours → digest → route → channel
 *
 * Deliberately narrow for 0.1.0:
 *   - four event kinds, each individually switchable,
 *   - seven webhook-class channels (no SMTP, no stored browser cookies),
 *   - one rule set (fingerprint dedup, quiet hours, digest batching),
 *   - four slash commands and five same-origin routes for the browser half.
 *
 * The browser half owns all presentation (official settings section, sidebar
 * status). Everything here is policy and transport.
 *
 * @module dsh-notify-relay
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Cordis function-plugin name. */
export const name = 'notify-relay'

/**
 * Services required before this plugin loads.
 *
 * - `commands` sits in the same dsh-base layer as `tools`, so any composition
 *   that can run tools can run slash commands.
 * - `timer` is the `@cordisjs/plugin-timer` mixin (`ctx.timeout` / `interval`),
 *   composed by dsh-base itself. Declaring it is the honest contract: the
 *   runner's ctx is fail-loud, and an undeclared read throws inside apply()
 *   and kills the whole plugin tree. Its handles are disposal-aware, so every
 *   pending digest dies with this plugin.
 *
 * `webServer` is deliberately NOT listed: it is absent in non-web
 * compositions, so it is waited for through `ctx.inject` (see apply) instead
 * of being required up front.
 */
export const inject = ['commands', 'timer']

/** Stable identity used for the storage directory and the HTTP route prefix. */
const PLUGIN_ID = 'notify-relay'
/** Route prefix; every path below is exact under it. */
const ROUTE_PREFIX = '/notify-relay'

/** Slash-command names this plugin owns (used by logs only). */
const COMMAND_NAMES = ['notify']

/** Host context captured so module-level helpers can arm disposal-aware timers. */
let hostCtx = null

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

/**
 * The four event kinds 0.1.0 listens to. `defaultOn` reflects how noisy each
 * source is: a turn ending is routine, a failed request or an approval request
 * is not.
 */
export const EVENT_KINDS = [
  { id: 'task.done', defaultOn: false, hostEvent: 'turn/end' },
  { id: 'task.failed', defaultOn: true, hostEvent: 'agent/error' },
  { id: 'request.failed', defaultOn: true, hostEvent: 'agent/request-error' },
  { id: 'approval.asked', defaultOn: true, hostEvent: 'approval/asked' },
]

/** Channel kinds 0.1.0 can deliver to. Every one is an HTTP call to a URL. */
export const CHANNEL_KINDS = [
  { id: 'bark', secretFields: ['key'] },
  { id: 'serverchan', secretFields: ['sendkey'] },
  { id: 'telegram', secretFields: ['token', 'chatId'] },
  { id: 'wecom', secretFields: ['key'] },
  { id: 'feishu', secretFields: ['token'] },
  { id: 'ntfy', secretFields: [] },
  { id: 'webhook', secretFields: ['token'] },
]

const CHANNEL_KIND_IDS = new Set(CHANNEL_KINDS.map((c) => c.id))
const EVENT_KIND_IDS = new Set(EVENT_KINDS.map((e) => e.id))

/** Hard caps, so a broken config cannot exhaust memory or disk. */
const MAX_CHANNELS = 20
const MAX_LOG_ENTRIES = 200
const MAX_BODY_BYTES = 64 * 1024
const DELIVERY_TIMEOUT_MS = 10_000
const DELIVERY_CONCURRENCY = 3
/** How much of a message body takes part in the dedup fingerprint. */
const FINGERPRINT_BODY_CHARS = 120

/* ------------------------------------------------------------------ *
 * Config shape, defaults and validation
 * ------------------------------------------------------------------ */

/** A blank configuration: nothing enabled, no channels, sane rule defaults. */
export function defaultConfig() {
  const events = {}
  for (const kind of EVENT_KINDS) events[kind.id] = kind.defaultOn
  return {
    enabled: false,
    events,
    dedup: { windowMinutes: 10 },
    quiet: { enabled: false, start: '22:00', end: '08:00', mode: 'digest' },
    digest: { enabled: false, intervalMinutes: 30 },
    channels: [],
  }
}

/** `HH:MM` in 24h form. */
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Non-empty string, trimmed and length-capped. */
function text(value, max) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return null
  return trimmed
}

function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function intInRange(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** Monotonic counter backing generated channel ids. */
let channelSeq = 0

/**
 * Validates one channel entry.
 *
 * `secrets` are merged onto an existing channel with the same id when the
 * client sends the redacted placeholder back, so the browser half can
 * round-trip a whole config without ever holding a real token.
 *
 * @param {unknown} entry
 * @param {object} [existing] previous channel with the same id
 * @returns {object | null}
 */
function validateChannel(entry, existing) {
  if (!isPlainObject(entry)) return null
  if (!CHANNEL_KIND_IDS.has(entry.kind)) return null
  const kind = entry.kind
  const spec = CHANNEL_KINDS.find((c) => c.id === kind)
  const id = text(entry.id, 64) ?? `ch-${(++channelSeq).toString(36)}-${createHash('sha1').update(kind).digest('hex').slice(0, 6)}`

  /* Start from whatever the caller supplied, then overlay the canonical fields.
     Dropping unknown keys instead would silently destroy credentials: a
     hand-edited config, or a field a newer version of this plugin understands,
     would round-trip through validation and come back empty — the channel would
     still look configured and every delivery would go out unauthenticated. */
  const secrets = {}
  if (isPlainObject(entry.secrets)) {
    for (const [key, value] of Object.entries(entry.secrets)) {
      if (typeof value === 'string') secrets[key] = value.slice(0, 500)
    }
  }
  for (const field of spec.secretFields) {
    const incoming = isPlainObject(entry.secrets) ? entry.secrets[field] : undefined
    // The redacted placeholder means "keep whatever is stored".
    const kept = incoming === REDACTED ? existing?.secrets?.[field] : incoming
    secrets[field] = typeof kept === 'string' ? kept.slice(0, 500) : ''
  }

  let events = []
  if (Array.isArray(entry.events)) {
    events = entry.events.filter((k) => EVENT_KIND_IDS.has(k)).slice(0, EVENT_KINDS.length)
  }

  return {
    id,
    kind,
    name: text(entry.name, 40) ?? kind,
    enabled: boolOr(entry.enabled, true),
    secrets,
    events: events.length > 0 ? events : ['*'],
    url: kind === 'webhook' ? (text(entry.url, 500) ?? '') : '',
  }
}

/** Placeholder the browser half receives instead of a real secret. */
export const REDACTED = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'

/**
 * Validates and normalizes an untrusted config document.
 *
 * Returns `{ ok: true, value }` with every field coerced into range, or
 * `{ ok: false, error }` naming the first problem. Unknown keys are dropped
 * rather than rejected — the browser half may be a version behind — and an
 * absent document means "defaults", which is what a first-ever save looks like.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function validateConfig(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: defaultConfig() }
  if (!isPlainObject(raw)) return { ok: false, error: 'config must be an object' }
  const base = defaultConfig()

  const events = {}
  for (const kind of EVENT_KINDS) {
    const incoming = isPlainObject(raw.events) ? raw.events[kind.id] : undefined
    events[kind.id] = boolOr(incoming, base.events[kind.id])
  }

  const rawDedup = isPlainObject(raw.dedup) ? raw.dedup : {}
  const dedup = { windowMinutes: intInRange(rawDedup.windowMinutes, base.dedup.windowMinutes, 1, 24 * 60) }

  const rawQuiet = isPlainObject(raw.quiet) ? raw.quiet : {}
  const quiet = {
    enabled: boolOr(rawQuiet.enabled, base.quiet.enabled),
    start: typeof rawQuiet.start === 'string' && TIME_RE.test(rawQuiet.start) ? rawQuiet.start : base.quiet.start,
    end: typeof rawQuiet.end === 'string' && TIME_RE.test(rawQuiet.end) ? rawQuiet.end : base.quiet.end,
    mode: rawQuiet.mode === 'drop' || rawQuiet.mode === 'digest' ? rawQuiet.mode : base.quiet.mode,
  }

  const rawDigest = isPlainObject(raw.digest) ? raw.digest : {}
  const digest = {
    enabled: boolOr(rawDigest.enabled, base.digest.enabled),
    intervalMinutes: intInRange(rawDigest.intervalMinutes, base.digest.intervalMinutes, 1, 24 * 60),
  }

  const channels = []
  if (Array.isArray(raw.channels)) {
    const kept = new Map()
    for (const entry of raw.channels.slice(0, MAX_CHANNELS)) {
      const channel = validateChannel(entry, kept.get(entry?.id))
      if (channel) {
        kept.set(channel.id, channel)
        channels.push(channel)
      }
    }
  }

  return {
    ok: true,
    value: {
      enabled: boolOr(raw.enabled, base.enabled),
      events,
      dedup,
      quiet,
      digest,
      channels,
    },
  }
}

/**
 * Produces the client-safe view of a config: every secret replaced by the
 * placeholder. The browser half never sees a token.
 *
 * @param {object} config
 */
export function redactConfig(config) {
  return {
    ...config,
    channels: config.channels.map((channel) => ({
      ...channel,
      secrets: Object.fromEntries(Object.keys(channel.secrets).map((k) => [k, REDACTED])),
    })),
  }
}

/* ------------------------------------------------------------------ *
 * Rule primitives (pure — the unit-tested heart of the plugin)
 * ------------------------------------------------------------------ */

/**
 * Stable identity for "the same thing happening again".
 *
 * A turn ending twice in the same session is one event worth one message, so
 * the session, the title and the head of the body all take part; the kind
 * always does. Including the body keeps two *different* failures in the same
 * session from collapsing into one.
 *
 * @param {string} kind
 * @param {string} sessionId
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
export function fingerprint(kind, sessionId, title, body) {
  return createHash('sha1')
    .update([
      kind,
      String(sessionId || ''),
      String(title || '').trim().toLowerCase(),
      String(body || '').trim().toLowerCase().slice(0, FINGERPRINT_BODY_CHARS),
    ].join('\u0000'))
    .digest('hex')
    .slice(0, 16)
}

/** Minutes since midnight for a `HH:MM` string. */
function minuteOf(hhmm) {
  const [h, m] = hhmm.split(':').map((n) => Number.parseInt(n, 10))
  return h * 60 + m
}

/**
 * Is `now` inside the quiet window? The window may wrap past midnight
 * (`22:00` → `08:00` is the common case).
 *
 * @param {Date} now
 * @param {{ start: string, end: string }} quiet
 * @returns {boolean}
 */
export function isWithinQuietHours(now, quiet) {
  const start = minuteOf(quiet.start)
  const end = minuteOf(quiet.end)
  const at = now.getHours() * 60 + now.getMinutes()
  if (start === end) return false
  return start < end ? at >= start && at < end : at >= start || at < end
}

/* ------------------------------------------------------------------ *
 * Channel payloads (pure — one builder per channel kind)
 * ------------------------------------------------------------------ */

/** Bark. */
function barkPayload(n, secrets) {
  return {
    url: `https://api.day.app/${encodeURIComponent(secrets.key || '')}`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: n.title, body: n.body, group: PLUGIN_ID }),
    },
  }
}

/** Server酱. */
function serverchanPayload(n, secrets) {
  return {
    url: `https://sctapi.ftqq.com/${encodeURIComponent(secrets.sendkey || '')}.send`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: n.title, desp: n.body }),
    },
  }
}

/** Telegram Bot API. */
function telegramPayload(n, secrets) {
  return {
    url: `https://api.telegram.org/bot${encodeURIComponent(secrets.token || '')}/sendMessage`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: secrets.chatId || '',
        text: `${n.title}\n\n${n.body}`,
        disable_web_page_preview: true,
      }),
    },
  }
}

/** 企业微信群机器人. */
function wecomPayload(n, secrets) {
  return {
    url: `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(secrets.key || '')}`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: `${n.title}\n${n.body}` } }),
    },
  }
}

/** 飞书自定义机器人. */
function feishuPayload(n, secrets) {
  return {
    url: `https://open.feishu.cn/open-apis/bot/v2/hook/${encodeURIComponent(secrets.token || '')}`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: `${n.title}\n${n.body}` } }),
    },
  }
}

/** ntfy: plain text to a topic; the topic lives in the channel URL. */
function ntfyPayload(n) {
  return {
    url: '',
    init: {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: `${n.title}\n${n.body}`,
    },
  }
}

/** Generic webhook: caller supplies the URL; a token becomes a bearer header. */
function webhookPayload(n, secrets) {
  return {
    url: '',
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secrets.token ? { authorization: `Bearer ${secrets.token}` } : {}),
      },
      body: JSON.stringify({
        source: PLUGIN_ID,
        kind: n.kind,
        title: n.title,
        body: n.body,
        sessionId: n.sessionId,
        at: n.createdAt,
      }),
    },
  }
}

const PAYLOAD_BUILDERS = {
  bark: barkPayload,
  serverchan: serverchanPayload,
  telegram: telegramPayload,
  wecom: wecomPayload,
  feishu: feishuPayload,
  ntfy: ntfyPayload,
  webhook: webhookPayload,
}

/**
 * Builds the HTTP request for one channel. Pure: no fetch, no clock, no I/O —
 * which is what makes it unit-testable.
 *
 * Channels that carry their endpoint in the config (`ntfy` topic, `webhook`
 * URL) take it from `channel.url`; the fixed-endpoint kinds derive it from the
 * stored secret.
 *
 * @param {object} channel
 * @param {{ title: string, body: string }} notification
 * @returns {{ url: string, init: object } | { error: string }}
 */
export function buildDelivery(channel, notification) {
  const builder = PAYLOAD_BUILDERS[channel.kind]
  if (!builder) return { error: `unknown channel kind: ${channel.kind}` }
  const built = builder(notification, channel.secrets || {})
  const url = channel.url || built.url
  if (!url) return { error: 'channel has no endpoint' }
  if (!/^https?:\/\//i.test(url)) return { error: 'channel endpoint must be http(s)' }
  return { url, init: built.init }
}

/* ------------------------------------------------------------------ *
 * Storage: one JSON document, atomic replace, in-memory mirror.
 * ------------------------------------------------------------------ */

/** @type {object} */
let config = defaultConfig()
/** @type {Array<object>} newest-first delivery log. */
let log = []
/** Serializes read-modify-write cycles so concurrent mutations cannot interleave. */
let queue = Promise.resolve()

function configFile() {
  return dshHomePath('storages', PLUGIN_ID, 'config.json')
}

function logFile() {
  return dshHomePath('storages', PLUGIN_ID, 'deliveries.json')
}

async function writeJson(path, value) {
  await mkdir(dshHomePath('storages', PLUGIN_ID), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

async function loadConfig() {
  try {
    const parsed = JSON.parse(await readFile(configFile(), 'utf8'))
    const checked = validateConfig(parsed)
    config = checked.ok ? checked.value : defaultConfig()
  } catch {
    config = defaultConfig()
  }
}

async function loadLog() {
  try {
    const parsed = JSON.parse(await readFile(logFile(), 'utf8'))
    log = Array.isArray(parsed) ? parsed.slice(0, MAX_LOG_ENTRIES) : []
  } catch {
    log = []
  }
}

function persistConfig() {
  queue = queue.then(() => writeJson(configFile(), config)).catch(() => {})
  return queue
}

function persistLog() {
  queue = queue.then(() => writeJson(logFile(), log)).catch(() => {})
  return queue
}

/** Appends one delivery outcome, newest first, capped. */
function recordDelivery(entry) {
  log = [{ at: new Date().toISOString(), ...entry }, ...log].slice(0, MAX_LOG_ENTRIES)
  return persistLog()
}

/* ------------------------------------------------------------------ *
 * Runtime state: dedup memory, digest queue, mute
 * ------------------------------------------------------------------ */

/** fingerprint → epoch ms of the last delivery. */
const recentDeliveries = new Map()
/** Notifications held for the next digest flush. */
let digestQueue = []
/** Disposer for the pending digest timer, if any. */
let digestTimer = null
/** epoch ms until which everything is muted (0 = not muted). */
let mutedUntil = 0

function sweepRecent(now) {
  const windowMs = Math.max(1, config.dedup.windowMinutes) * 60_000
  for (const [key, at] of recentDeliveries) {
    if (now - at > windowMs) recentDeliveries.delete(key)
  }
}

/**
 * Applies the rule center to one notification.
 *
 * Order matters: mute beats everything, then the master/event switches, then
 * dedup (a repeat is not news), then quiet hours, then digest. Quiet hours and
 * digest both *hold* rather than drop when configured to, so nothing is lost
 * silently unless the user asked for exactly that.
 *
 * @param {object} notification
 * @returns {{ verdict: string, reason: string }}
 */
export function classify(notification) {
  const now = Date.now()
  if (mutedUntil > now) return { verdict: 'muted', reason: 'mute active' }
  if (!config.enabled) return { verdict: 'off', reason: 'relay disabled' }
  if (!config.events[notification.kind]) return { verdict: 'off', reason: `event ${notification.kind} disabled` }

  sweepRecent(now)
  const fp = fingerprint(notification.kind, notification.sessionId, notification.title, notification.body)
  if (recentDeliveries.has(fp)) return { verdict: 'dedup', reason: 'same fingerprint inside the dedup window' }

  if (config.quiet.enabled && isWithinQuietHours(new Date(now), config.quiet)) {
    return { verdict: config.quiet.mode === 'drop' ? 'quiet-drop' : 'quiet-hold', reason: 'quiet hours' }
  }

  if (config.digest.enabled) return { verdict: 'digest', reason: 'digest batching on' }
  return { verdict: 'send', reason: 'immediate' }
}

/** Channels that want this kind and are enabled. */
function channelsFor(notification) {
  return config.channels.filter((channel) => {
    if (!channel.enabled) return false
    return channel.events.includes('*') || channel.events.includes(notification.kind)
  })
}

/**
 * One channel, one HTTP call. Never throws: a failing channel must not take
 * the plugin (or the boot) down with it.
 *
 * @param {object} channel
 * @param {object} notification
 */
async function deliverTo(channel, notification) {
  const started = Date.now()
  const built = buildDelivery(channel, notification)
  if (built.error) {
    const entry = { channelId: channel.id, kind: channel.kind, ok: false, error: built.error, ms: 0 }
    await recordDelivery(entry)
    return entry
  }
  try {
    const response = await fetch(built.url, { ...built.init, signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) })
    const entry = {
      channelId: channel.id,
      kind: channel.kind,
      ok: response.ok,
      status: response.status,
      ms: Date.now() - started,
      ...(response.ok ? {} : { error: `http ${response.status}` }),
    }
    await recordDelivery(entry)
    return entry
  } catch (error) {
    const entry = {
      channelId: channel.id,
      kind: channel.kind,
      ok: false,
      error: error?.name === 'TimeoutError' ? 'timeout' : String(error?.message || error).slice(0, 200),
      ms: Date.now() - started,
    }
    await recordDelivery(entry)
    return entry
  }
}

/**
 * Sends one notification to every matching channel, in small batches, and
 * records the outcome per channel.
 *
 * @param {object} notification
 */
async function deliver(notification) {
  const targets = channelsFor(notification)
  const results = []
  for (let i = 0; i < targets.length; i += DELIVERY_CONCURRENCY) {
    const batch = targets.slice(i, i + DELIVERY_CONCURRENCY)
    results.push(...(await Promise.all(batch.map((channel) => deliverTo(channel, notification)))))
  }
  return results
}

/* ------------------------------------------------------------------ *
 * Digest
 * ------------------------------------------------------------------ */

/** Flushes everything held into one notification per channel set. */
async function flushDigest() {
  digestTimer = null
  if (digestQueue.length === 0) return { sent: 0 }
  const items = digestQueue
  digestQueue = []
  const notification = {
    kind: 'digest',
    sessionId: '*',
    title: `${items.length} 条通知摘要`,
    body: items.map((item) => `\u2022 ${item.title}${item.body ? ` \u2014 ${item.body}` : ''}`).join('\n'),
    createdAt: new Date().toISOString(),
  }
  const results = await deliver(notification)
  await recordDelivery({
    channelId: '*',
    kind: 'digest',
    ok: results.length > 0 && results.every((r) => r.ok),
    detail: `${items.length} held`,
    ms: 0,
  })
  return { sent: items.length }
}

/** Arms the digest timer if it is not already running. */
function armDigest() {
  if (digestTimer || digestQueue.length === 0 || !hostCtx) return
  const delay = Math.max(1, config.digest.intervalMinutes) * 60_000
  digestTimer = hostCtx.timeout(() => {
    void flushDigest()
  }, delay)
}

function disarmDigest() {
  if (digestTimer) digestTimer()
  digestTimer = null
  digestQueue = []
}

/* ------------------------------------------------------------------ *
 * Event intake
 * ------------------------------------------------------------------ */

/**
 * Turns one host event into a notification and runs it through the rules.
 *
 * Event payload shapes differ per source, so every field is probed defensively
 * and an unknown shape degrades to an empty title rather than throwing.
 *
 * @param {string} kind one of EVENT_KINDS ids
 * @param {object} payload
 */
async function intake(kind, payload) {
  const source = isPlainObject(payload) ? payload : {}
  const sessionId = String(source.sessionId ?? source.session?.id ?? source.agent?.session?.id ?? '')
  const title = String(source.title ?? source.sessionTitle ?? source.label ?? '')
  const body = String(source.detail ?? source.message ?? source.cause ?? source.reason ?? source.error ?? '')
  const notification = { kind, sessionId, title, body, createdAt: new Date().toISOString() }

  const decision = classify(notification)
  if (decision.verdict === 'send') {
    recentDeliveries.set(fingerprint(kind, sessionId, title, body), Date.now())
    await deliver(notification)
    return
  }
  if (decision.verdict === 'digest' || decision.verdict === 'quiet-hold') {
    digestQueue.push(notification)
    armDigest()
  }
}

/* ------------------------------------------------------------------ *
 * Slash commands
 * ------------------------------------------------------------------ */

/** `/notify` — status, test, mute and digest control. */
function notifyCommand() {
  return {
    name: 'notify',
    description: 'Outbound relay: status, test a channel, mute, or flush the digest',
    input: { hint: '[status|test [channel]|mute <minutes>|unmute|flush]' },
    handler: async (invocation) => {
      const arg = String(invocation?.rawInput ?? '').trim()
      const [verb, ...rest] = arg.length > 0 ? arg.split(/\s+/) : ['status']

      if (verb === 'status' || verb === '') {
        const lines = [
          `relay: ${config.enabled ? 'on' : 'off'}`,
          `channels: ${config.channels.filter((c) => c.enabled).length}/${config.channels.length} enabled`,
          `digest: ${config.digest.enabled ? `on (${config.digest.intervalMinutes}m)` : 'off'}`,
          `quiet hours: ${config.quiet.enabled ? `${config.quiet.start}-${config.quiet.end} (${config.quiet.mode})` : 'off'}`,
          `held: ${digestQueue.length}`,
          `muted: ${mutedUntil > Date.now() ? `until ${new Date(mutedUntil).toISOString()}` : 'no'}`,
        ]
        const last = log[0]
        if (last) lines.push(`last delivery: ${last.ok ? 'ok' : 'failed'} (${last.channelId})`)
        return { kind: 'success', text: lines.join('\n') }
      }

      if (verb === 'test') {
        const wanted = rest[0]
        const targets = wanted
          ? config.channels.filter((c) => c.id === wanted)
          : config.channels.filter((c) => c.enabled)
        if (targets.length === 0) {
          return { kind: 'error', text: wanted ? `no channel named ${wanted}` : 'no enabled channel' }
        }
        const notification = {
          kind: 'test',
          sessionId: '*',
          title: 'dsh-notify-relay test',
          body: 'This is a test delivery from the DSH outbound relay.',
          createdAt: new Date().toISOString(),
        }
        const results = []
        for (const channel of targets) results.push(await deliverTo(channel, notification))
        const failed = results.filter((r) => !r.ok)
        if (failed.length > 0) {
          return { kind: 'error', text: `test failed: ${failed.map((f) => `${f.channelId} (${f.error ?? f.status})`).join(', ')}` }
        }
        return { kind: 'success', text: `test delivered to ${results.length} channel(s)` }
      }

      if (verb === 'mute') {
        const minutes = Number.parseInt(rest[0] ?? '', 10)
        if (!Number.isFinite(minutes) || minutes <= 0) return { kind: 'error', text: 'usage: /notify mute <minutes>' }
        mutedUntil = Date.now() + Math.min(minutes, 24 * 60) * 60_000
        return { kind: 'success', text: `muted for ${minutes} minute(s)` }
      }

      if (verb === 'unmute') {
        mutedUntil = 0
        return { kind: 'success', text: 'mute cleared' }
      }

      if (verb === 'flush') {
        const result = await flushDigest()
        return { kind: 'success', text: result.sent > 0 ? `flushed ${result.sent} held notification(s)` : 'nothing held' }
      }

      return { kind: 'error', text: 'usage: /notify [status|test [channel]|mute <minutes>|unmute|flush]' }
    },
  }
}

/* ------------------------------------------------------------------ *
 * HTTP routes (the browser half's data channel)
 * ------------------------------------------------------------------ */

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Body-level failure carrying the HTTP status it deserves. */
class BodyError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new BodyError('payload too large', 413)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BodyError('invalid_json', 400)
  }
  return isPlainObject(parsed) ? parsed : {}
}

/**
 * Register one route, tolerating a double mount: `webServer.register` throws on
 * a duplicate (kind, path), and two mounts of this plugin would otherwise fail
 * the whole plugin tree at boot. A duplicate means another instance already
 * owns the route, so this instance stands down instead of crashing the boot.
 */
function registerRoute(webServer, route, log) {
  try {
    return webServer.register(route)
  } catch (error) {
    const message = String(error?.message || error)
    if (!/duplicate/i.test(message)) throw error
    log?.warn(`route ${route.path} is already registered by another instance; standing down`)
    return () => {}
  }
}

/** Wraps a handler so one bad request answers 4xx instead of crashing. */
function guarded(handler) {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      const status = error instanceof BodyError ? error.status : 500
      sendJson(res, status, { ok: false, error: String(error?.message || error) })
    }
  }
}

/**
 * Register the plugin's HTTP surface.
 *
 * ONE route per path, dispatching on the method inside the handler. This is not
 * a style choice: `webServer.match()` looks the path up in a Map and ignores
 * the method entirely, so a GET route and a POST route on the same path collide
 * — the second `register` throws, `registerRoute` swallows the duplicate as a
 * double-mount, and the POST handler silently never runs. Every write then
 * lands on the read handler, which answers 200 with unchanged data. That is
 * exactly what the first cut of this plugin did, and only a live boot caught
 * it: the host harness's fake webServer matched on method like a real router,
 * so the collision never reproduced there.
 *
 * The delivery log is read from the module state, NOT taken as a parameter: the
 * first cut passed `ctx.logger(PLUGIN_ID)` in under the name `log`, which
 * shadowed the array and made `/log` throw on every call.
 */
function registerRoutes(webServer) {
  const disposers = []

  /* `method` is deliberately absent: one path, one handler, method switched
     inside. Adding it back would reintroduce the collision above. */
  disposers.push(
    registerRoute(
      webServer,
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/config`,
        handler: guarded(async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            const body = await readJsonBody(req)
            const checked = validateConfig(body?.config)
            if (!checked.ok) {
              sendJson(res, 400, { ok: false, error: checked.error })
              return
            }
            config = checked.value
            await persistConfig()
            if (config.digest.enabled && digestQueue.length > 0) armDigest()
            if (!config.digest.enabled) disarmDigest()
            sendJson(res, 200, { ok: true, config: redactConfig(config) })
            return
          }
          await loadConfig()
          sendJson(res, 200, {
            ok: true,
            config: redactConfig(config),
            /* Live rule state the editor shows but does not own: how many
               notifications are held for the next digest, and whether a mute
               is active. Re-read from disk first so an external edit (another
               browser tab) is reflected immediately. */
            held: digestQueue.length,
            muted: mutedUntil > Date.now(),
          })
        }),
      },
      log,
    ),
  )

  disposers.push(
    registerRoute(
      webServer,
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/log`,
        handler: guarded(async (_req, res) => {
          sendJson(res, 200, { ok: true, entries: log.slice(0, 50) })
        }),
      },
      log,
    ),
  )

  disposers.push(
    registerRoute(
      webServer,
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/test`,
        handler: guarded(async (req, res) => {
          const body = await readJsonBody(req)
          /* Accept either spelling: the UI posts `channelId`, a hand-rolled
             curl may well post `channel`. */
          const wanted = typeof body.channelId === 'string' ? body.channelId : typeof body.channel === 'string' ? body.channel : ''
          const targets = wanted
            ? config.channels.filter((channel) => channel.id === wanted)
            : config.channels.filter((channel) => channel.enabled)
          if (targets.length === 0) {
            sendJson(res, 400, { ok: false, error: 'no matching channel' })
            return
          }
          const notification = {
            kind: 'test',
            sessionId: '*',
            title: 'dsh-notify-relay test',
            body: 'This is a test delivery from the DSH outbound relay.',
            createdAt: new Date().toISOString(),
          }
          const results = []
          for (const channel of targets) results.push(await deliverTo(channel, notification))
          sendJson(res, 200, { ok: true, results })
        }),
      },
      log,
    ),
  )

  disposers.push(
    registerRoute(
      webServer,
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/flush`,
        handler: guarded(async (_req, res) => {
          const result = await flushDigest()
          sendJson(res, 200, { ok: true, ...result })
        }),
      },
      log,
    ),
  )

  return () => {
    for (const dispose of disposers) dispose()
  }
}

/* ------------------------------------------------------------------ *
 * apply
 * ------------------------------------------------------------------ */

/**
 * Counts applies so a double mount gets distinct effect names: cordis keys
 * effects by name, so two applies sharing one name would let the second
 * instance replace — and thereby dispose — the first instance's registrations.
 */
let applySeq = 0

/**
 * Install the slash command, the event listeners, and the browser routes
 * whenever a webServer exists.
 *
 * @param {import('cordis').Context} ctx - host context.
 */
export async function apply(ctx) {
  const seq = ++applySeq
  const log = ctx.logger(PLUGIN_ID)
  hostCtx = ctx

  await loadConfig()
  await loadLog()

  ctx.effect(() => {
    let disposeCommands = () => {}
    try {
      disposeCommands = ctx.commands.register(notifyCommand())
    } catch (error) {
      const message = String(error?.message || error)
      if (!/duplicate/i.test(message)) throw error
      log.warn(`command /notify is already registered by another instance; standing down`)
      disposeCommands = () => {}
    }

    const listeners = [
      ['turn/end', (payload) => intake('task.done', payload)],
      ['agent/error', (payload) => intake('task.failed', payload)],
      ['agent/request-error', (payload) => intake('request.failed', payload)],
      ['approval/asked', (payload) => intake('approval.asked', payload)],
    ]
    for (const [event, handler] of listeners) {
      ctx.on(event, (payload) => {
        void Promise.resolve(handler(payload)).catch((error) => {
          log.warn(`notify-relay: ${event} intake failed (${String(error?.message || error)})`)
        })
      })
    }

    log.info(`command /notify registered; listening on ${listeners.map(([e]) => e).join(', ')}`)

    return () => {
      disarmDigest()
      disposeCommands()
    }
  }, `notify-relay.host(${seq})`)

  // The webServer is absent in non-web compositions; registerRoutes then never runs.
  ctx.inject(['webServer'], (webCtx) => {
    const webLog = webCtx.logger(PLUGIN_ID)
    webCtx.effect(() => {
      const dispose = registerRoutes(webCtx.webServer)
      webLog.info(`routes registered under ${ROUTE_PREFIX}`)
      return dispose
    }, `notify-relay.routes(${seq})`)
  })
}
