/**
 * Live delivery check against the running sandbox GUI.
 *
 * This is not a unit test: it talks to the real plugin half that booted inside
 * the real dsh process on 12997. It writes a webhook channel pointing at a
 * loopback receiver on 12998, fires the plugin's own /test route, and then
 * reads what the receiver actually saw.
 *
 * What it proves that the host harness cannot:
 *   - the route really is registered by the running process
 *   - the payload builder's fetch really reaches a socket
 *   - the config really round-trips through the plugin's own GET /config
 */
const fs = require('fs')

const BASE = process.env.GATE_BASE || 'http://127.0.0.1:12997'
const OUT = 'E:\\DSH-Workspace\\DSH-Notify\\.sandbox\\received.json'
const failures = []

function check(ok, label, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* keep the raw text for the report */
  }
  return { status: response.status, json, text }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  console.log('— the plugin is live in the running dsh process —')
  const config = await api('/notify-relay/config')
  check(config.status === 200 && config.json && config.json.ok === true, 'GET /notify-relay/config answers', `${config.status} ${config.text.slice(0, 80)}`)
  check(config.json && config.json.config && Array.isArray(config.json.config.channels), 'the live config has the shape the UI expects')

  console.log('\n— configure a webhook channel at the loopback receiver —')
  const webhookConfig = {
    enabled: true,
    events: { 'task.done': false, 'task.failed': true, 'request.failed': true, 'approval.asked': true },
    dedup: { windowMinutes: 10 },
    quiet: { enabled: false, start: '22:00', end: '08:00', mode: 'digest' },
    digest: { enabled: false, intervalMinutes: 30 },
    channels: [
      {
        id: 'live',
        name: '回环验证',
        kind: 'webhook',
        url: 'http://127.0.0.1:12998/hook',
        secrets: { token: 'live-secret' },
        events: ['task.failed'],
      },
    ],
  }
  const posted = await api('/notify-relay/config', { method: 'POST', body: { config: webhookConfig } })
  check(posted.status === 200 && posted.json && posted.json.ok === true, 'POST /notify-relay/config is accepted', `${posted.status} ${posted.text.slice(0, 120)}`)
  /* The write must not answer with the read shape. `webServer.match()` keys
     routes by path and ignores the method, so a POST route declared beside a
     GET route on the same path is unreachable — the write then lands on the
     read handler and answers 200 with unchanged data. That is the exact bug
     this check exists for. */
  check(posted.json && !('held' in posted.json), 'the write does not fall through to the read shape', JSON.stringify(posted.json).slice(0, 120))
  check(posted.json && posted.json.config && posted.json.config.enabled === true, 'the POST response carries the written config', JSON.stringify(posted.json && posted.json.config).slice(0, 120))

  /* Read it back through the plugin's own route: the value the UI would see. */
  const readBack = await api('/notify-relay/config')
  const stored = readBack.json && readBack.json.config
  check(stored && stored.enabled === true, 'the enabled flag round-trips')
  check(stored && stored.channels.length === 1, 'the channel round-trips', stored ? String(stored.channels.length) : 'none')
  check(stored && stored.channels[0].url === 'http://127.0.0.1:12998/hook', 'the channel url round-trips', stored && stored.channels[0] && stored.channels[0].url)
  check(stored && stored.channels[0].secrets.token === '••••••••', 'the secret comes back masked', stored && stored.channels[0] ? JSON.stringify(stored.channels[0].secrets) : '')

  console.log('\n— fire the plugin\'s own test delivery —')
  const tested = await api('/notify-relay/test', {
    method: 'POST',
    body: { channelId: 'live' },
  })
  check(tested.status === 200, 'POST /notify-relay/test answers', `${tested.status} ${tested.text.slice(0, 200)}`)
  check(tested.json && Array.isArray(tested.json.results), 'the test route reports per-channel results', tested.text.slice(0, 200))

  /* Poll the receiver: the delivery is awaited by the route, but the write is
     a separate process, so give it a moment rather than assuming. */
  let seen = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(100)
    try {
      const entries = JSON.parse(fs.readFileSync(OUT, 'utf8'))
      if (Array.isArray(entries) && entries.length > 0) {
        seen = entries[entries.length - 1]
        break
      }
    } catch {
      /* not written yet */
    }
  }
  check(seen !== null, 'the loopback receiver actually got the POST')
  if (seen) {
    check(seen.method === 'POST', 'it is a POST', seen.method)
    check(seen.url === '/hook', 'it hit the configured path', seen.url)
    /* The webhook builder sends the token as a bearer authorization header. */
    check(seen.headers.authorization === 'Bearer live-secret', 'the channel token is forwarded as a bearer header', String(seen.headers.authorization))
    let payload = null
    try {
      payload = JSON.parse(seen.body)
    } catch {
      /* reported below */
    }
    check(payload !== null, 'the body is JSON', seen.body.slice(0, 160))
    if (payload) {
      check(payload.title !== undefined, 'the payload carries a title', JSON.stringify(Object.keys(payload)))
      check(payload.body !== undefined, 'the payload carries a body')
      check(payload.source === 'notify-relay', 'the payload identifies its source', JSON.stringify(Object.keys(payload)))
      check(payload.kind === 'test', 'the payload kind is test', payload.kind)
      check(!JSON.stringify(payload).includes('live-secret'), 'the secret is not echoed into the payload', JSON.stringify(payload).slice(0, 160))
    }
  }

  console.log('\n— the delivery log route —')
  const log = await api('/notify-relay/log')
  check(log.status === 200, 'GET /notify-relay/log answers', `${log.status}`)
  if (log.json) {
    const entries = Array.isArray(log.json) ? log.json : log.json.entries
    check(Array.isArray(entries), 'the log is a list', typeof entries)
    check(!JSON.stringify(log.json).includes('live-secret'), 'the log exposes no secret', JSON.stringify(log.json).slice(0, 200))
    /* Every row must say WHICH EVENT it is about. A log of "webhook, ok"
       cannot answer "did it fire?", which is the question users actually
       ask — and the one this ecosystem's bug reports are dominated by. */
    check(entries.every((entry) => typeof entry.event === 'string' && entry.event.length > 0), 'every log row names its event', JSON.stringify(entries[0]).slice(0, 160))
    check(entries.some((entry) => entry.event === 'test'), 'the test delivery is attributed to the test event', JSON.stringify(entries[0]).slice(0, 160))
    check(entries.every((entry) => typeof entry.title === 'string'), 'every log row carries a title', JSON.stringify(entries[0]).slice(0, 160))
  }

  console.log('\n— the retry route and the language field —')
  const pending = await api('/notify-relay/retry')
  check(pending.status === 200, 'GET /notify-relay/retry answers', `${pending.status} ${pending.text.slice(0, 120)}`)
  check(pending.json && Number.isFinite(pending.json.pending), 'the retry route reports the pending count', pending.text.slice(0, 120))
  const flushed = await api('/notify-relay/retry', { method: 'POST', body: {} })
  check(flushed.status === 200, 'POST /notify-relay/retry answers', `${flushed.status} ${flushed.text.slice(0, 160)}`)
  check(flushed.json && Number.isFinite(flushed.json.retried), 'POST /retry reports how many it retried', flushed.text.slice(0, 160))

  /* The delivery language is the field the host uses for everything it emits.
     An invalid value must fall back rather than throw. */
  const langProbe = await api('/notify-relay/config', {
    method: 'POST',
    body: { config: { ...webhookConfig, language: 'en', events: { 'task.failed': true } } },
  })
  check(langProbe.json && langProbe.json.config.language === 'en', 'the delivery language round-trips', langProbe.text.slice(0, 160))
  const langBack = await api('/notify-relay/config')
  check(langBack.json && langBack.json.config.language === 'en', 'the delivery language persists', langBack.text.slice(0, 160))
  const langJunk = await api('/notify-relay/config', {
    method: 'POST',
    body: { config: { ...webhookConfig, language: 'klingon' } },
  })
  check(langJunk.json && langJunk.json.config.language === 'zh', 'an unknown language falls back to zh', langJunk.text.slice(0, 160))

  console.log('\n— reset the plugin to its defaults —')
  const reset = await api('/notify-relay/config', { method: 'POST', body: { config: null } })
  check(reset.status === 200 && reset.json && reset.json.config && reset.json.config.channels.length === 0, 'a null config restores the defaults', reset.text.slice(0, 120))

  console.log(`\n${failures.length} failure(s)`)
  if (failures.length) {
    console.log('LIVE GATE FAIL')
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exit(1)
  }
  console.log('LIVE GATE OK')
  process.exit(0)
}

main().catch((error) => {
  console.log(`FAIL: ${error && error.message}`)
  process.exit(1)
})
