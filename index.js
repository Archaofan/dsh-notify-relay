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
 * Deliberately narrow in scope, and it has stayed that way:
 *   - eight event kinds, each individually switchable,
 *   - seven webhook-class channels (no SMTP, no stored browser cookies),
 *   - one rule set (fingerprint dedup, quiet hours, digest batching),
 *   - one slash command with six verbs, and five same-origin routes for the
 *     browser half.
 *
 * The counts above were written for 0.1.0 as "four event kinds, four slash
 * commands" and were never updated as the surface grew. They are load-bearing
 * documentation -- `status` prints `EVENT_KINDS.length` and the marketplace
 * entry states the same numbers -- so a stale count here contradicts both.
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
 * Event kinds, and — critically — the host event name each one really arrives on.
 *
 * `hostEvent` is not documentation. It is load-bearing: the host harness holds
 * the list of event names DSH actually dispatches and refuses any listener
 * registered on a name outside it. That check exists because the first cut of
 * this plugin listened on `turn/end` and `approval/asked` directly, and
 * **neither ever fired**. Session events are dispatched once, under the single
 * name `session/event`, as `(session, event)` where `event.type` carries the
 * real name (`dsh-session/lib/types/index.js:600` → `collectSessionCallbacks(
 * emitCtx, [carrier, 'session/event', session, event])`). There is no re-emit
 * under the individual name, so `ctx.on('turn/end')` is a listener on an event
 * that does not exist. The harness could not see it: its fake ctx records
 * whatever name you hand it.
 *
 * Only `agent/*` names are global; everything in `SessionEventMap` — turn,
 * step, message, tool, approval, command, sandbox — arrives through
 * `session/event`.
 *
 * `pierce` marks events that BLOCK WORK. Quiet hours and digest batching exist
 * to be polite, and politeness is wrong here: an approval request held until
 * 08:00 is a task dead until 08:00. Every other plugin in this ecosystem makes
 * the same mistake — or simply has no quiet hours at all — and the user's task
 * stalls for hours with nothing to blame but the notifier.
 */
export const EVENT_KINDS = [
  { id: 'task.done', defaultOn: false, hostEvent: 'session/event', sessionEvent: 'turn/end', pierce: false },
  { id: 'task.failed', defaultOn: true, hostEvent: 'agent/error', sessionEvent: '', pierce: false },
  { id: 'task.aborted', defaultOn: true, hostEvent: 'session/event', sessionEvent: 'turn/end', pierce: false },
  { id: 'task.blocked', defaultOn: true, hostEvent: 'session/event', sessionEvent: 'turn/end', pierce: false },
  { id: 'request.failed', defaultOn: true, hostEvent: 'agent/request-error', sessionEvent: '', pierce: false },
  { id: 'approval.asked', defaultOn: true, hostEvent: 'session/event', sessionEvent: 'approval/asked', pierce: true },
  { id: 'approval.decided', defaultOn: false, hostEvent: 'session/event', sessionEvent: 'approval/decided', pierce: false },
  { id: 'tool.failed', defaultOn: true, hostEvent: 'session/event', sessionEvent: 'tool/result', pierce: false },
]

const EVENT_KIND_BY_ID = new Map(EVENT_KINDS.map((e) => [e.id, e]))

/**
 * Every event name this plugin may register a listener on. The host harness
 * asserts the real listeners are a subset of this set AND a subset of the names
 * DSH actually dispatches — the second half is what catches a typo, the first
 * is what catches a listener that silently never fires.
 */
export const HOST_EVENT_NAMES = [...new Set(EVENT_KINDS.map((e) => e.hostEvent))]

/**
 * How a `turn/end` reason maps onto an event kind. `reason.kind` is a closed
 * sum (`TurnEndReasonMap` in `dsh-session/lib/types/types.d.ts:165`):
 * completed / aborted / blocked / error / max-tokens / interrupted. Mapping
 * every one of them to "task done" — which is what 0.1.0 did — reports an
 * aborted or failed turn as a success.
 */
const TURN_END_KINDS = {
  completed: 'task.done',
  aborted: 'task.aborted',
  blocked: 'task.blocked',
  error: 'task.failed',
}

/**
 * Severity, and the channel-native field each one maps to.
 *
 * A flat "it happened" is not enough. An approval request and a task-done are
 * both events, but one costs the user money if it is missed and the other is
 * trivia. Every mature notification system separates severity from content
 * (Grafana alerting, Alertmanager, PagerDuty severity to urgency); a notifier
 * that cannot express it forces the user to either miss the important one or be
 * spammed by the unimportant one.
 *
 * The mapping is not decorative - these are real API fields, verified against
 * the vendor docs:
 *
 * - Bark `level` is `'critical' | 'active' | 'timeSensitive' | 'passive'`
 *   ([API V2](https://raw.githubusercontent.com/Finb/bark-server/master/docs/API_V2.md)).
 *   `critical` plus `call: '1'` is the only primitive in this plugin's whole
 *   channel set that breaks through iOS silent mode and Do Not Disturb, which is
 *   exactly what an approval request needs and exactly what a task-done must not
 *   have.
 * - ntfy `Priority` is 1-5 (`max`/`urgent`/`high`/`default`/`low`/`min`)
 *   ([publishing](https://docs.ntfy.sh/publish/)).
 * - Telegram `disable_notification` is the inverse: it downgrades to a silent
 *   message rather than upgrading.
 *
 * A channel with no severity primitive keeps its existing shape and is not lied
 * to - inventing a field the API ignores is worse than omitting one.
 */
export const SEVERITIES = ['critical', 'high', 'normal', 'low']

/** Severity per event kind. Missing kinds default to `normal`. */
export const SEVERITY_BY_KIND = {
  'approval.asked': 'critical',
  'task.failed': 'high',
  'task.aborted': 'high',
  'task.blocked': 'high',
  'request.failed': 'high',
  'tool.failed': 'high',
  'task.done': 'normal',
  'approval.decided': 'normal',
  digest: 'normal',
  test: 'normal',
  /* The plugin reporting on itself. High, not critical: it must not be able to
     pre-empt the approval it is warning about. */
  'relay.degraded': 'high',
}

/** Severity for a notification kind. Total: unknown kinds are `normal`. */
export function severityOf(kind) {
  return SEVERITY_BY_KIND[kind] || 'normal'
}

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
/** Pending retries. A channel down for a week must not grow this without bound. */
const MAX_OUTBOX_ENTRIES = 100
/** Give up on a notification after this many attempts, and say so in the log. */
const MAX_DELIVERY_ATTEMPTS = 6
const MAX_BODY_BYTES = 64 * 1024
const DELIVERY_TIMEOUT_MS = 10_000
const DELIVERY_CONCURRENCY = 3
/** How much of a message body takes part in the dedup fingerprint. */
const FINGERPRINT_BODY_CHARS = 120

/**
 * Consecutive failures on one channel before its breaker opens. Three, not one:
 * a single failure is a blip, and a breaker that opens on a blip converts a
 * transient network error into a missing notification - the exact failure mode
 * this plugin exists to prevent.
 */
export const MAX_CHANNEL_FAILURES = 3
/**
 * How long a channel stays open after tripping, and how that grows. Doubling
 * from one minute to a thirty-minute ceiling, so a channel that is down for an
 * hour is probed twice rather than sixty times.
 */
export const CHANNEL_COOLDOWN_STEPS_MS = [60_000, 300_000, 900_000, 1_800_000]
/** An outbox entry older than this means the retry path itself is stuck. */
export const STUCK_OUTBOX_MS = 30 * 60_000
/** How often the plugin may warn the user that it is degraded. Once an hour. */
export const DEGRADED_COOLDOWN_MS = 60 * 60_000

/* ------------------------------------------------------------------ *
 * Config shape, defaults and validation
 * ------------------------------------------------------------------ */

/** A blank configuration: nothing enabled, no channels, sane rule defaults. */
export function defaultConfig() {
  const events = {}
  for (const kind of EVENT_KINDS) events[kind.id] = kind.defaultOn
  return {
    enabled: false,
    /* Language of everything the HOST produces: digest titles, command
       replies, log reasons. The browser half has its own locale service and
       follows the UI; this governs what leaves the machine, which is the half
       a user reads on a phone at 2am. Default 'zh' because the author's
       audience is Chinese-speaking, and a misread notification is worse than
       none. */
    language: 'zh',
    /* Tap target for channels that support one (Bark `url`, ntfy `Click`).
       Optional and empty by default, because the honest answer to "where should
       this open?" is deployment-specific: DSH's web server usually listens on
       127.0.0.1, which is a useless link on a phone. `{session}` is replaced by
       the session id when there is one. Guessing a URL scheme would produce a
       link that opens the wrong page, which is worse than no link. */
    deepLink: '',
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
      language: raw.language === 'en' || raw.language === 'zh' ? raw.language : base.language,
      /* Only an http(s) URL carrying a `{session}` placeholder survives. Without
         the placeholder the link cannot say WHICH session the notification is
         about, so it opens something unrelated; and a `javascript:` "deep link"
         would be a push notification that executes code on tap. */
      deepLink: /^https?:\/\/\S*\{session\}\S*$/.test(String(raw.deepLink ?? '').trim())
        ? String(raw.deepLink).trim().slice(0, 2048)
        : '',
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
 * Host-side copy (zh / en)
 *
 * The browser half has `ctx.locale` and follows the UI. The host has no such
 * service, so everything the host emits — digest titles, command replies,
 * suppression reasons — is picked from this table using `config.language`.
 * A user reading a phone notification in a language they do not read is worse
 * off than one who got no notification, which is the single most common i18n
 * complaint in this ecosystem's issue tracker.
 * ------------------------------------------------------------------ */

const HOST_STRINGS = {
  zh: {
    digestTitle: (n) => `${n} 条通知摘要`,
    held: (n) => `${n} 条待发送`,
    statusHead: 'notify-relay 状态',
    statusEnabled: (on) => (on ? '已开启' : '已关闭'),
    statusMuted: (until) => `静音中，${until} 恢复`,
    statusEvents: (on, total) => `事件开关 ${on}/${total}`,
    statusChannels: (n) => `通道 ${n} 个`,
    statusOutbox: (n) => `待重试 ${n} 条`,
    statusHeld: (n) => `合批待发 ${n} 条`,
    statusBreakers: (ids) => `熔断中：${ids}`,
    statusOldest: (age) => `最早就绪于 ${age} 前`,
    statusLastOk: (age) => `上次成功投递 ${age} 前`,
    degradedTitle: 'notify-relay 自检告警',
    degradedBreaker: (ids) => `通道连续失败，已暂停重试：${ids}`,
    degradedStuck: (n, age) => `${n} 条通知在重试队列中等待了 ${age}`,
    degradedNever: '自启动以来从未成功投递，请检查通道配置',
    mutedFor: (m) => `已静音 ${m} 分钟`,
    muteCleared: '静音已清除',
    flushed: (n) => `已发送合批的 ${n} 条`,
    nothingHeld: '没有待合批的通知',
    retried: (n) => `已重试 ${n} 条待投递通知`,
    nothingToRetry: '没有待重试的通知',
    testDelivered: (n) => `测试已投递到 ${n} 个通道`,
    testFailed: (detail) => `测试失败：${detail}`,
    usage: '用法：/notify [status|test [channel]|mute <分钟>|unmute|flush|retry]',
  },
  en: {
    digestTitle: (n) => `${n} notification${n === 1 ? '' : 's'} digest`,
    held: (n) => `${n} held`,
    statusHead: 'notify-relay status',
    statusEnabled: (on) => (on ? 'enabled' : 'disabled'),
    statusMuted: (until) => `muted until ${until}`,
    statusEvents: (on, total) => `events ${on}/${total} on`,
    statusChannels: (n) => `${n} channel${n === 1 ? '' : 's'}`,
    statusOutbox: (n) => `${n} awaiting retry`,
    statusHeld: (n) => `${n} held for digest`,
    statusBreakers: (ids) => `circuit open: ${ids}`,
    statusOldest: (age) => `oldest pending item waited ${age}`,
    statusLastOk: (age) => `last successful delivery ${age} ago`,
    degradedTitle: 'notify-relay self-check warning',
    degradedBreaker: (ids) => `channels failing repeatedly, retries paused: ${ids}`,
    degradedStuck: (n, age) => `${n} notification${n === 1 ? '' : 's'} stuck in the retry queue for ${age}`,
    degradedNever: 'nothing has been delivered since start-up; check the channel configuration',
    mutedFor: (m) => `muted for ${m} minute${m === 1 ? '' : 's'}`,
    muteCleared: 'mute cleared',
    flushed: (n) => `flushed ${n} held notification${n === 1 ? '' : 's'}`,
    nothingHeld: 'nothing held',
    retried: (n) => `retried ${n} pending notification${n === 1 ? '' : 's'}`,
    nothingToRetry: 'nothing to retry',
    testDelivered: (n) => `test delivered to ${n} channel${n === 1 ? '' : 's'}`,
    testFailed: (detail) => `test failed: ${detail}`,
    usage: 'usage: /notify [status|test [channel]|mute <minutes>|unmute|flush|retry]',
  },
}

/** The copy table for the configured language. Falls back to zh. */
function t() {
  return HOST_STRINGS[config.language] || HOST_STRINGS.zh
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

/**
 * The tap target for a notification, or `undefined` when none is configured.
 *
 * A deep link is the difference between a push that says "DSH needs you" and one
 * that says "DSH needs you, here is the exact session". Bark and ntfy both
 * support it natively; the other channels have no equivalent field, so they get
 * nothing rather than a URL pasted into the body where it is not clickable.
 */
function linkFor(notification) {
  const template = typeof config === 'undefined' ? '' : config.deepLink
  if (!template) return undefined
  const session = notification.sessionId && notification.sessionId !== '*' ? notification.sessionId : ''
  /* Without a session to substitute the link is a lie — it opens something
     unrelated to the notification it arrived with. */
  if (!session) return undefined
  return template.replace(/\{session\}/g, session).slice(0, 2048)
}

/** Bark. `level` is the only field in the whole channel set that pierces DND. */
function barkPayload(n, secrets) {
  const level = { critical: 'critical', high: 'timeSensitive', normal: 'active', low: 'passive' }[n.severity] || 'active'
  const link = linkFor(n)
  return {
    url: `https://api.day.app/${encodeURIComponent(secrets.key || '')}`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: n.title,
        body: n.body,
        group: PLUGIN_ID,
        level,
        /* `call` makes the ringtone play for 30 seconds and, with
           `level: 'critical'`, ignores the mute switch and Do Not Disturb.
           Reserved for approval requests: using it for anything else is how a
           notifier gets uninstalled. */
        ...(n.severity === 'critical' ? { call: '1', volume: '10' } : {}),
        ...(link ? { url: link } : {}),
      }),
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
        /* Telegram has no upgrade path — only a downgrade. `disable_notification`
           sends the message without a sound or a pop-over, which is the right
           shape for a task-done and the wrong one for an approval. */
        disable_notification: n.severity === 'low',
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
  const link = linkFor(n)
  return {
    url: '',
    init: {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        /* ntfy's priority scale is 1-5; `normal` sits on the default so a
           default-configured topic keeps behaving the way it always did. */
        priority: { critical: '5', high: '4', normal: '3', low: '2' }[n.severity] || '3',
        ...(link ? { click: link } : {}),
      },
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
        severity: n.severity,
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
/**
 * The outbox: notifications that failed to deliver and are waiting for a retry.
 *
 * Persisted, because the whole point is that a restart must not lose them. Every
 * competitor in this ecosystem either has no retry at all or keeps the queue in
 * memory and says so in its README — "process exit loses pending retries" is a
 * documented limitation of the best of them. A notification that evaporates on
 * restart is worse than one that never fired, because the user was told it was
 * handled.
 *
 * @type {Array<{ notification: object, attempts: number, nextAttemptAt: number, lastError: string }>}
 */
let outbox = []
/**
 * Per-channel circuit breaker state, keyed by channel id.
 *
 * Without this, a channel that is hard down — revoked token, decommissioned
 * host, DNS that stopped resolving — is retried on every single notification,
 * six times each, forever. Each retry costs a full timeout, so the outbox grows,
 * the backoff ceiling stretches to thirty minutes, and the user's *working*
 * channels are delayed behind the dead one. The fix is to stop asking the dead
 * channel and say so, rather than to keep asking politely.
 *
 * Not persisted: a breaker is a statement about the network *now*, and a
 * restart is exactly when the network may have been fixed. Re-tripping after a
 * restart costs three attempts, which is cheap; trusting a stale "unhealthy"
 * flag across a restart could suppress a channel for thirty minutes for no
 * reason.
 *
 * @type {Map<string, { failures: number, openUntil: number, cooldown: number }>}
 */
const breakers = new Map()
/** When the plugin last warned the user that it was degraded. */
let degradedNotifiedAt = 0
/** Serializes read-modify-write cycles so concurrent mutations cannot interleave. */
let queue = Promise.resolve()

function configFile() {
  return dshHomePath('storages', PLUGIN_ID, 'config.json')
}

function logFile() {
  return dshHomePath('storages', PLUGIN_ID, 'deliveries.json')
}

function outboxFile() {
  return dshHomePath('storages', PLUGIN_ID, 'outbox.json')
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

async function loadOutbox() {
  try {
    const parsed = JSON.parse(await readFile(outboxFile(), 'utf8'))
    outbox = Array.isArray(parsed) ? parsed.slice(0, MAX_OUTBOX_ENTRIES) : []
  } catch {
    outbox = []
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

function persistOutbox() {
  queue = queue.then(() => writeJson(outboxFile(), outbox)).catch(() => {})
  return queue
}

/** Appends one delivery outcome, newest first, capped. */
function recordDelivery(entry) {
  log = [{ at: new Date().toISOString(), ...entry }, ...log].slice(0, MAX_LOG_ENTRIES)
  return persistLog()
}

/**
 * Records a verdict that produced NO delivery.
 *
 * This is the difference between a notifier you can trust and one you cannot.
 * The single most common complaint about notification plugins in this ecosystem
 * is "I cannot tell whether it fired at all" — a log that only contains rows for
 * successful sends cannot answer that, because the interesting case is exactly
 * the row that is missing. So dedup, mute, quiet-hold, quiet-drop, digest and
 * "event switched off" all leave a trace, with the reason.
 */
function recordSuppressed(notification, verdict, reason) {
  return recordDelivery({
    event: notification.kind,
    title: notification.title,
    channelId: '',
    kind: '',
    ok: false,
    suppressed: verdict,
    error: reason,
    ms: 0,
  })
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
/** Disposer for the pending outbox drain, if any. */
let outboxTimer = null
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
 * Order matters, and the order is the product:
 *
 *  1. mute beats everything — an explicit `/notify mute 60` means it.
 *  2. the master switch and the per-event switch.
 *  3. dedup: a repeat is not news.
 *  4. quiet hours — EXCEPT for events marked `pierce`. An approval request
 *     held until 08:00 is a task dead until 08:00, and the user will blame the
 *     plugin, not the clock. This is the one rule where a generic "be polite"
 *     design actively destroys work, so the polite default is overridden here.
 *  5. digest batching.
 *
 * Quiet hours and digest both *hold* rather than drop when configured to, so
 * nothing is lost silently unless the user asked for exactly that.
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

  /* A piercing event ignores quiet hours entirely. `pierce` is set on the kind,
     not in the config: it encodes "this event blocks work", which is a property
     of the event, not a user preference. */
  const spec = EVENT_KIND_BY_ID.get(notification.kind)
  const piercing = !!spec?.pierce
  if (!piercing && config.quiet.enabled && isWithinQuietHours(new Date(now), config.quiet)) {
    return { verdict: config.quiet.mode === 'drop' ? 'quiet-drop' : 'quiet-hold', reason: 'quiet hours' }
  }

  /* Digest holds too, but a piercing event still goes out now — batching an
     approval request has the same cost as delaying it. */
  if (!piercing && config.digest.enabled) return { verdict: 'digest', reason: 'digest batching on' }
  return { verdict: 'send', reason: piercing ? 'pierces quiet hours and digest' : 'immediate' }
}

/** Channels that want this kind and are enabled. */
function channelsFor(notification) {
  return config.channels.filter((channel) => {
    if (!channel.enabled) return false
    return channel.events.includes('*') || channel.events.includes(notification.kind)
  })
}

/**
 * Whether a channel's breaker is currently open.
 *
 * A channel whose cooldown has elapsed gets exactly one probe — the half-open
 * state — and the caller's result decides whether the breaker resets or
 * re-arms. Exported for the harness, which needs to drive the state machine
 * without waiting on real clocks.
 *
 * @param {string} channelId
 * @param {number} [now]
 */
export function breakerOpen(channelId, now = Date.now()) {
  const state = breakers.get(channelId)
  if (!state) return false
  return state.openUntil > now
}

/** Records a delivery outcome on the channel's breaker. */
function noteOutcome(channelId, ok) {
  const state = breakers.get(channelId) || { failures: 0, openUntil: 0, cooldown: 0 }
  if (ok) {
    /* A success clears everything, including the cooldown ladder, so a channel
       that recovers does not carry a longer penalty than it earned. */
    if (state.failures > 0 || state.openUntil > 0) breakers.set(channelId, { failures: 0, openUntil: 0, cooldown: 0 })
    return
  }
  state.failures += 1
  if (state.failures >= MAX_CHANNEL_FAILURES) {
    const step = CHANNEL_COOLDOWN_STEPS_MS[Math.min(state.cooldown, CHANNEL_COOLDOWN_STEPS_MS.length - 1)]
    state.openUntil = Date.now() + step
    state.cooldown = Math.min(state.cooldown + 1, CHANNEL_COOLDOWN_STEPS_MS.length)
  }
  breakers.set(channelId, state)
}

/**
 * Delivers to one channel and records the outcome. Never throws — a failed
 * delivery must not propagate back into the event that triggered it, because
 * that would turn a notification problem into an agent-loop problem.
 *
 * A channel whose breaker is open is skipped without a network call and is NOT
 * queued for retry: retrying it per-notification is the behaviour the breaker
 * exists to stop. The skip is still logged, because a silent skip is the exact
 * failure this plugin was written to eliminate.
 *
 * @param {object} channel
 * @param {object} notification
 * @param {{ event: string, title: string }} meta notification identity, logged
 *   so the row says WHAT was delivered rather than only where it was tried.
 */
async function deliverTo(channel, notification, meta) {
  const started = Date.now()
  if (breakerOpen(channel.id)) {
    const entry = {
      ...meta,
      channelId: channel.id,
      kind: channel.kind,
      ok: false,
      error: 'circuit open',
      skipped: true,
      ms: 0,
    }
    await recordDelivery(entry)
    return entry
  }
  const built = buildDelivery(channel, notification)
  if (built.error) {
    /* A malformed channel is a config bug, not a network blip: tripping the
       breaker on it would hide the error behind a cooldown. */
    const entry = { ...meta, channelId: channel.id, kind: channel.kind, ok: false, error: built.error, ms: 0 }
    await recordDelivery(entry)
    return entry
  }
  try {
    const response = await fetch(built.url, { ...built.init, signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) })
    const entry = {
      ...meta,
      channelId: channel.id,
      kind: channel.kind,
      ok: response.ok,
      status: response.status,
      ms: Date.now() - started,
      ...(response.ok ? {} : { error: `http ${response.status}` }),
    }
    noteOutcome(channel.id, response.ok)
    await recordDelivery(entry)
    return entry
  } catch (error) {
    const entry = {
      ...meta,
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
 * Every outcome carries `event` (the notification kind) and `title`, because a
 * log that only records which channel was tried and whether it worked cannot
 * answer the only question a user actually has: *what* was delivered. 0.1.0
 * logged `kind` meaning the CHANNEL kind, so a row read "webhook, ok" and told
 * you nothing about the event.
 *
 * A failure goes to the outbox with exponential backoff rather than being
 * dropped. Nothing here throws: a failing channel must not take the plugin —
 * or the agent loop that produced the event — down with it.
 *
 * @param {object} notification
 * @param {{ retry?: boolean }} [options] when false, a failure is logged but
 *   not queued (used by the outbox's own retry pass, so a hopeless notification
 *   cannot be re-queued forever).
 */
async function deliver(notification, options = {}) {
  const targets = options.channels || channelsFor(notification)
  const meta = {
    event: notification.kind,
    title: notification.title,
    /* Recorded per row so the log can distinguish "an approval was delivered"
       from "a task finished", which a boolean `ok` cannot. */
    severity: notification.severity || severityOf(notification.kind),
  }
  const results = []
  for (let i = 0; i < targets.length; i += DELIVERY_CONCURRENCY) {
    const batch = targets.slice(i, i + DELIVERY_CONCURRENCY)
    results.push(...(await Promise.all(batch.map((channel) => deliverTo(channel, notification, meta)))))
  }
  if (options.retry !== false) {
    const failed = results.filter((result) => !result.ok)
    if (failed.length > 0) await enqueueRetry(notification, failed)
  }
  return results
}

/**
 * Puts a failed notification into the durable outbox.
 *
 * Deduplicated by fingerprint: three channels failing on the same notification
 * is one retry, not three. Capped, so a channel that is down for a week cannot
 * grow the file without bound.
 */
async function enqueueRetry(notification, failedResults) {
  const existing = outbox.find((item) => item.notification.kind === notification.kind && item.notification.title === notification.title && item.notification.body === notification.body)
  if (existing) {
    existing.attempts += 1
    existing.lastError = failedResults.map((f) => `${f.channelId}: ${f.error ?? f.status}`).join('; ').slice(0, 300)
    existing.nextAttemptAt = Date.now() + backoffMs(existing.attempts)
  } else {
    outbox.unshift({
      notification,
      attempts: 1,
      /* When this first entered the queue, not when it last failed. The
         self-monitor needs the age of the *wait*, and re-stamping it on every
         retry would make a permanently stuck notification look brand new. */
      firstSeenAt: Date.now(),
      nextAttemptAt: Date.now() + backoffMs(1),
      lastError: failedResults.map((f) => `${f.channelId}: ${f.error ?? f.status}`).join('; ').slice(0, 300),
    })
  }
  outbox = outbox.slice(0, MAX_OUTBOX_ENTRIES)
  await persistOutbox()
}

/**
 * Exponential backoff with jitter: 30s, 1m, 2m, 4m ... capped at 30 minutes,
 * then multiplied by a uniform draw in [0.75, 1.25].
 *
 * The jitter is not decoration. Without it every pending item computes the
 * *same* next-attempt time, so the moment a shared channel recovers - or the
 * moment the process restarts and reloads the whole outbox at once - every
 * queued notification fires at it simultaneously. A notifier whose own failure
 * mode is "many things failed at once" is precisely the case that produces a
 * thundering herd, and full jitter is the canonical fix (AWS Architecture Blog,
 * "Exponential Backoff and Jitter").
 *
 * +/-25% rather than full [0, cap] jitter: full jitter can schedule a retry
 * effectively immediately, which for a 10s-timeout channel means a hot loop.
 * Bounded jitter keeps the exponential shape and removes the synchronisation.
 *
 * @param {number} attempts
 * @param {() => number} [rand] injectable for the harness, which must be able to
 *   assert both the base curve and the bounds deterministically.
 */
export function backoffMs(attempts, rand = Math.random) {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000)
  return Math.round(base * (0.75 + rand() * 0.5))
}

/**
 * Retries everything in the outbox whose backoff has elapsed. Called from the
 * digest timer's tick and on boot, so a restart resumes the queue instead of
 * silently abandoning it.
 *
 * @param {{ force?: boolean }} [options] force ignores the backoff, so
 *   `/notify retry` acts now rather than at the next scheduled tick.
 */
async function drainOutbox(options = {}) {
  if (outbox.length === 0) return { retried: 0, sent: 0, dropped: 0 }
  const now = Date.now()
  const due = options.force ? outbox.slice() : outbox.filter((item) => item.nextAttemptAt <= now)
  if (due.length === 0) return { retried: 0, sent: 0, dropped: 0 }

  let sent = 0
  let dropped = 0
  const keep = []
  for (const item of outbox) {
    if (!due.includes(item)) {
      keep.push(item)
      continue
    }
    if (item.attempts >= MAX_DELIVERY_ATTEMPTS) {
      /* Give up, loudly: the log says the notification was abandoned and why,
         which is the only honest outcome left. */
      await recordDelivery({
        event: item.notification.kind,
        title: item.notification.title,
        channelId: '',
        kind: '',
        ok: false,
        error: `abandoned after ${item.attempts} attempts: ${item.lastError}`,
        ms: 0,
      })
      dropped += 1
      continue
    }
    const results = await deliver(item.notification, { retry: false })
    if (results.length > 0 && results.every((result) => result.ok)) {
      sent += 1
      continue
    }
    item.attempts += 1
    item.lastError = results.map((f) => `${f.channelId}: ${f.error ?? f.status}`).join('; ').slice(0, 300) || item.lastError
    item.nextAttemptAt = Date.now() + backoffMs(item.attempts)
    keep.push(item)
  }
  outbox = keep.slice(0, MAX_OUTBOX_ENTRIES)
  await persistOutbox()
  return { retried: due.length, sent, dropped }
}

/* ------------------------------------------------------------------ *
 * Self-monitoring: the notifier reporting on itself
 * ------------------------------------------------------------------ */

/** A compact age like `4h12m`, for humans reading a status line. */
function humanAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''}`
  return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ''}`
}

/** Channels whose breaker is currently open. */
function openBreakerIds() {
  const now = Date.now()
  return config.channels.filter((channel) => breakerOpen(channel.id, now)).map((channel) => channel.id)
}

/** Breaker state keyed by channel id, for the JSON routes. */
function breakerSummary() {
  const now = Date.now()
  return Object.fromEntries(
    config.channels.map((channel) => {
      const state = breakers.get(channel.id)
      return [
        channel.id,
        {
          open: breakerOpen(channel.id, now),
          failures: state?.failures ?? 0,
          retryInMs: state && state.openUntil > now ? state.openUntil - now : 0,
        },
      ]
    }),
  )
}

/**
 * Warns the user that the relay itself is unhealthy, at most once an hour, and
 * only through a channel that is still working.
 *
 * This is the single highest-leverage thing a notifier can do, and the one this
 * plugin was missing. Healthchecks.io is built on exactly this idea - a Period
 * plus a Grace Time, so that *silence* is itself an alert. A notifier that
 * quietly stops notifying is strictly worse than no notifier, because the user
 * believes they are covered. Every other feature here improves the message;
 * this one is the only one that can tell you the messages are not arriving.
 *
 * It is deliberately conservative:
 *
 * - **Once per hour.** A warning that fires on every tick trains the user to
 *   ignore it, and an ignored warning is worse than none.
 * - **Only through a healthy channel.** Warning through the dead channel would
 *   add a failure to the very thing being reported, and could recurse.
 * - **Never queued for retry.** A degraded warning that fails must not join the
 *   outbox it is describing, or the outbox grows because of its own alarm.
 * - **Never through `classify()`.** `relay.degraded` is not a user-configurable
 *   event, so the event switches must not be able to silence it.
 *
 * @param {{ force?: boolean }} [options]
 */
async function reportDegraded(options = {}) {
  const now = Date.now()
  if (!options.force && now - degradedNotifiedAt < DEGRADED_COOLDOWN_MS) return { reported: false }
  if (!config.enabled || config.channels.length === 0) return { reported: false }

  const s = t()
  const openIds = openBreakerIds()
  const stuck = outbox.filter((item) => now - (item.firstSeenAt || now) > STUCK_OUTBOX_MS)
  const everDelivered = log.some((entry) => !entry.suppressed && entry.ok)

  const lines = []
  if (openIds.length > 0) lines.push(s.degradedBreaker(openIds.join(', ')))
  if (stuck.length > 0) {
    const oldest = Math.min(...stuck.map((item) => item.firstSeenAt || now))
    lines.push(s.degradedStuck(stuck.length, humanAge(now - oldest)))
  }
  if (!everDelivered) lines.push(s.degradedNever)
  if (lines.length === 0) return { reported: false }

  /* Deliver through the channels that are NOT open. If every channel is open,
     there is nobody to tell - recording it in the log is the honest outcome,
     because at least it is visible to the one user who opens the panel. */
  const healthy = config.channels.filter((channel) => channel.enabled && !openIds.includes(channel.id))
  const notification = {
    kind: 'relay.degraded',
    sessionId: '*',
    severity: 'high',
    title: s.degradedTitle,
    body: lines.join('\n'),
    createdAt: new Date().toISOString(),
  }
  degradedNotifiedAt = now
  if (healthy.length === 0) {
    await recordDelivery({
      event: 'relay.degraded',
      title: notification.title,
      channelId: '',
      kind: '',
      ok: false,
      error: `no healthy channel to report through: ${lines.join('; ')}`.slice(0, 300),
      ms: 0,
    })
    return { reported: true, delivered: false }
  }
  await deliver(notification, { channels: healthy, retry: false })
  return { reported: true, delivered: true }
}

/* ------------------------------------------------------------------ *
 * Digest
 * ------------------------------------------------------------------ */

/**
 * Flushes everything held into one notification per channel set.
 *
 * The digest goes to the **union** of channels that wanted any of the held
 * kinds, not to the channels that subscribe to the literal kind `'digest'`.
 * That distinction shipped as a bug in 0.2.0: `channelsFor` matches on
 * `notification.kind`, so a channel configured `events: ['task.failed']` - the
 * README's own worked example - was filtered out of every digest and silently
 * received nothing at all. A digest is a container for the kinds it holds, so it
 * inherits their audience.
 */
async function flushDigest() {
  digestTimer = null
  if (digestQueue.length === 0) return { sent: 0 }
  const items = digestQueue
  digestQueue = []
  const heldKinds = new Set(items.map((item) => item.kind))
  const targets = config.channels.filter((channel) => {
    if (!channel.enabled) return false
    if (channel.events.includes('*')) return true
    return channel.events.some((kind) => heldKinds.has(kind))
  })
  const notification = {
    kind: 'digest',
    sessionId: '*',
    severity: 'normal',
    title: t().digestTitle(items.length),
    body: items.map((item) => `\u2022 ${item.title}${item.body ? ` \u2014 ${item.body}` : ''}`).join('\n'),
    createdAt: new Date().toISOString(),
  }
  const results = await deliver(notification, { channels: targets })
  await recordDelivery({
    channelId: '*',
    kind: 'digest',
    ok: results.length > 0 && results.every((r) => r.ok),
    detail: t().held(items.length),
    ms: 0,
  })
  /* Held notifications that failed go back for a retry like any other. */
  if (results.length > 0 && results.some((r) => !r.ok)) await enqueueRetry(notification, results.filter((r) => !r.ok))
  return { sent: items.length }
}

/** Arms the digest timer if it is not already running. */
function armDigest() {
  if (digestTimer || digestQueue.length === 0 || !hostCtx) return
  const delay = Math.max(1, config.digest.intervalMinutes) * 60_000
  digestTimer = hostCtx.timeout(() => {
    void flushDigest()
  }, delay)
  /* The outbox rides the same tick: one timer, two queues. A separate timer
     would double the disposal surface for no gain. */
  armOutboxTimer(delay)
}

/** Arms the outbox drain if it is not already running. */
function armOutboxTimer(delay) {
  if (outboxTimer || !hostCtx) return
  /* Armed even with an empty outbox: the tick is also the self-monitor's
     heartbeat, and a notifier that only checks its own health while it has
     pending work never notices that it has stopped working. */
  outboxTimer = hostCtx.timeout(() => {
    void (async () => {
      await drainOutbox()
      await reportDegraded()
      /* Re-arm while the relay is on. This is a heartbeat, not a work queue:
         the Healthchecks model is a Period plus a Grace Time, and a heartbeat
         that stops when the queue is empty cannot detect the one failure it
         exists to catch - a relay that is enabled and quietly delivering
         nothing. */
      if (config.enabled) armOutboxTimer(delay)
    })()
  }, delay)
}

function disarmDigest() {
  if (digestTimer) digestTimer()
  digestTimer = null
  if (outboxTimer) outboxTimer()
  outboxTimer = null
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
 * Every verdict leaves a trace. A delivery log that only records successes
 * cannot answer "did it fire?", which is the question users actually ask — and
 * the one this ecosystem's bug reports are dominated by.
 *
 * @param {string} kind one of EVENT_KINDS ids
 * @param {object} payload
 */
async function intake(kind, payload) {
  const source = isPlainObject(payload) ? payload : {}
  const sessionId = String(source.sessionId ?? source.session?.id ?? source.agent?.session?.id ?? '')
  const title = String(source.title ?? source.sessionTitle ?? source.label ?? '')
  /* Several host payloads carry their prose in a structured field rather than a
     string — `turn/end`'s `reason` is an object, `tool/result`'s `error` is one
     too — and `String()` on those yields the useless "[object Object]". Treat
     that as no detail at all rather than shipping it as the message body. */
  const rawBody = source.detail ?? source.message ?? source.cause ?? source.reason ?? source.error
  const body = typeof rawBody === 'string' && rawBody.trim() !== '' ? rawBody : ''
  /* A notification with no body and no title is an empty push. Several events
     really do carry no prose — a `turn/end` with no summary is the common one —
     and shipping a blank message is how a user learns to distrust the channel.
     Say what happened instead of saying nothing, and be explicit that the
     source supplied no detail so a genuine gap is not mistaken for a bug. */
  const resolvedBody = body || (config.language === 'en' ? `(no detail supplied by the ${kind} event)` : `（${kind} 事件未提供细节）`)
  const resolvedTitle = title || (config.language === 'en' ? 'DSH notification' : 'DSH 通知')
  const notification = {
    kind,
    sessionId,
    title: resolvedTitle,
    body: resolvedBody,
    severity: severityOf(kind),
    createdAt: new Date().toISOString(),
  }

  const decision = classify(notification)
  if (decision.verdict === 'send') {
    recentDeliveries.set(fingerprint(kind, sessionId, title, body), Date.now())
    const results = await deliver(notification)
    /* A delivery that reached no channel at all — because none is configured,
       or every channel filters this kind out — is the most invisible failure
       there is. Record it rather than letting the notification vanish. */
    if (results.length === 0) await recordSuppressed(notification, 'no-channel', 'no channel accepts this event')
    return
  }
  if (decision.verdict === 'digest' || decision.verdict === 'quiet-hold') {
    digestQueue.push(notification)
    armDigest()
    await recordSuppressed(notification, decision.verdict, decision.reason)
    return
  }
  await recordSuppressed(notification, decision.verdict, decision.reason)
}

/* ------------------------------------------------------------------ *
 * Slash commands
 * ------------------------------------------------------------------ */

/** `/notify` — status, test, mute, digest and outbox control. */
function notifyCommand() {
  return {
    name: 'notify',
    description: 'Outbound relay: status, test a channel, mute, flush the digest, or retry failures',
    input: { hint: '[status|test [channel]|mute <minutes>|unmute|flush|retry]' },
    handler: async (invocation) => {
      const s = t()
      const arg = String(invocation?.rawInput ?? '').trim()
      const [verb, ...rest] = arg.length > 0 ? arg.split(/\s+/) : ['status']

      if (verb === 'status' || verb === '') {
        const onCount = EVENT_KINDS.filter((kind) => config.events[kind.id]).length
        const lines = [
          `${s.statusHead}: ${s.statusEnabled(config.enabled)}`,
          `${s.statusEvents(onCount, EVENT_KINDS.length)}`,
          `${s.statusChannels(config.channels.filter((c) => c.enabled).length)}`,
          `${s.statusHeld(digestQueue.length)}`,
          `${s.statusOutbox(outbox.length)}`,
        ]
        if (mutedUntil > Date.now()) lines.push(s.statusMuted(new Date(mutedUntil).toISOString()))
        /* Health lines. A status command that reports "enabled: yes, outbox: 0"
           for a relay whose channels are all dead is exactly the false
           reassurance this command exists to prevent, so the breaker state and
           the age of the last successful delivery are reported here too. */
        const openIds = openBreakerIds()
        if (openIds.length > 0) lines.push(s.statusBreakers(openIds.join(', ')))
        if (outbox.length > 0) {
          const oldest = Math.min(...outbox.map((item) => item.firstSeenAt || Date.now()))
          lines.push(s.statusOldest(humanAge(Date.now() - oldest)))
        }
        const lastOk = log.find((entry) => !entry.suppressed && entry.ok)
        if (lastOk) lines.push(s.statusLastOk(humanAge(Date.now() - new Date(lastOk.at).getTime())))
        else if (config.enabled && config.channels.some((c) => c.enabled)) lines.push(s.degradedNever)
        return { kind: 'success', text: lines.join('\n') }
      }

      if (verb === 'test') {
        const wanted = rest[0]
        const targets = wanted
          ? config.channels.filter((c) => c.id === wanted)
          : config.channels.filter((c) => c.enabled)
        if (targets.length === 0) {
          const none = wanted
            ? (config.language === 'en' ? `no channel named ${wanted}` : `没有名为 ${wanted} 的通道`)
            : (config.language === 'en' ? 'no enabled channel' : '没有已启用的通道')
          return { kind: 'error', text: none }
        }
        const notification = {
          kind: 'test',
          sessionId: '*',
          title: 'dsh-notify-relay test',
          body: 'This is a test delivery from the DSH outbound relay.',
          createdAt: new Date().toISOString(),
        }
        const results = []
        for (const channel of targets) results.push(await deliverTo(channel, notification, { event: 'test', title: notification.title, severity: 'normal' }))
        const failed = results.filter((r) => !r.ok)
        if (failed.length > 0) {
          return { kind: 'error', text: s.testFailed(failed.map((f) => `${f.channelId} (${f.error ?? f.status})`).join(', ')) }
        }
        return { kind: 'success', text: s.testDelivered(results.length) }
      }

      if (verb === 'mute') {
        const minutes = Number.parseInt(rest[0] ?? '', 10)
        if (!Number.isFinite(minutes) || minutes <= 0) {
          return { kind: 'error', text: config.language === 'en' ? 'usage: /notify mute <minutes>' : '用法：/notify mute <分钟>' }
        }
        mutedUntil = Date.now() + Math.min(minutes, 24 * 60) * 60_000
        return { kind: 'success', text: s.mutedFor(minutes) }
      }

      if (verb === 'unmute') {
        mutedUntil = 0
        return { kind: 'success', text: s.muteCleared }
      }

      if (verb === 'flush') {
        const result = await flushDigest()
        return { kind: 'success', text: result.sent > 0 ? s.flushed(result.sent) : s.nothingHeld }
      }

      /* Retry the outbox now instead of waiting for the backoff. The one
         command that answers "it said it failed — now what?". */
      if (verb === 'retry') {
        const result = await drainOutbox({ force: true })
        if (result.retried === 0) return { kind: 'success', text: s.nothingToRetry }
        return { kind: 'success', text: s.retried(result.retried) }
      }

      return { kind: 'error', text: s.usage }
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
            /* Turning the relay on from the settings page must start the
               heartbeat too, or a freshly configured relay has no self-monitor
               until the next restart. */
            if (config.enabled) armOutboxTimer(Math.max(1, config.digest.intervalMinutes) * 60_000)
            sendJson(res, 200, { ok: true, config: redactConfig(config) })
            return
          }
          await loadConfig()
          sendJson(res, 200, {
            ok: true,
            config: redactConfig(config),
            /* Live rule state the editor shows but does not own: how many
               notifications are held for the next digest, whether a mute is
               active, and how many failed deliveries are waiting for a retry.
               Re-read from disk first so an external edit (another browser tab)
               is reflected immediately. */
            held: digestQueue.length,
            muted: mutedUntil > Date.now(),
            pending: outbox.length,
            /* Which channels the breaker has stopped calling, and how long
               until the half-open probe. The editor needs this to explain why a
               channel that is configured correctly is not receiving anything -
               otherwise a tripped breaker looks identical to a config bug. */
            breakers: breakerSummary(),
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
          for (const channel of targets) results.push(await deliverTo(channel, notification, { event: 'test', title: notification.title, severity: 'normal' }))
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

  /* One route per path, method switched inside — the same rule as /config. */
  disposers.push(
    registerRoute(
      webServer,
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/retry`,
        handler: guarded(async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 200, { ok: true, pending: outbox.length, breakers: breakerSummary() })
            return
          }
          const result = await drainOutbox({ force: true })
          sendJson(res, 200, { ok: true, ...result, pending: outbox.length, breakers: breakerSummary() })
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
  await loadOutbox()

  /* A restart must resume the retry queue, not drop it. This is the whole
     reason the outbox is persisted: an in-memory queue loses every pending
     retry on restart, which is the documented limitation of the best
     competitor in this ecosystem.

     The timer is armed when the relay is enabled, whether or not the outbox is
     non-empty, because the same tick is the self-monitor's heartbeat. Arming it
     only when work is pending would mean a relay whose channels are all broken -
     and which therefore has nothing to retry - never checks itself. */
  if (outbox.length > 0) log.info(`${outbox.length} notification(s) awaiting retry after restart`)
  if (config.enabled) armOutboxTimer(Math.max(1, config.digest.intervalMinutes) * 60_000)

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

    /* Two families of listener, and the difference is not cosmetic.

       `agent/*` are global agent events dispatched under their own name, so
       `ctx.on('agent/error')` is correct.

       Everything in `SessionEventMap` — turn/step/message/tool/approval —
       arrives ONCE, under `session/event`, as `(session, event)` with the real
       name in `event.type`. Registering `ctx.on('turn/end')` buys a listener on
       an event DSH never dispatches, which is exactly the bug 0.1.0 shipped:
       `task.done` and `approval.asked` were silently dead. */
    const listeners = [
      ['agent/error', (payload) => intake('task.failed', payload)],
      ['agent/request-error', (payload) => intake('request.failed', payload)],
      [
        'session/event',
        (session, event) => {
          const type = isPlainObject(event) ? String(event.type || '') : ''
          const data = isPlainObject(event) && isPlainObject(event.data) ? event.data : {}
          if (type === 'turn/end') {
            /* The reason decides the kind: a completed turn is "done", an
               aborted one is not. */
            const kind = TURN_END_KINDS[data.reason?.kind] || 'task.done'
            return intake(kind, { sessionId: session?.id, reason: data.reason, ...data })
          }
          if (type === 'approval/asked') {
            return intake('approval.asked', { sessionId: session?.id, title: data.toolName, body: data.reason, ...data })
          }
          if (type === 'approval/decided') {
            return intake('approval.decided', { sessionId: session?.id, title: data.id, body: data.outcome, ...data })
          }
          if (type === 'tool/result' && isPlainObject(data.error)) {
            return intake('tool.failed', {
              sessionId: session?.id,
              title: data.error.name || 'tool failed',
              body: data.error.reason || data.error.code || '',
              ...data,
            })
          }
        },
      ],
    ]
    /* Every argument must be forwarded, not just the first. `session/event`
       is dispatched as `(session, event)`; a wrapper written as
       `(payload) => handler(payload)` silently drops `event`, so `event.type`
       reads as undefined and every branch below no-ops. The plugin then looks
       perfectly healthy — it registers, it logs, it answers its routes — and
       notifies on nothing at all, which is the single most-reported failure
       mode in this whole ecosystem. */
    for (const [event, handler] of listeners) {
      ctx.on(event, (...args) => {
        void Promise.resolve(handler(...args)).catch((error) => {
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
