# dsh-notify-relay

The outbound **rule center** for DSH: lifecycle events — task done, task failed,
task aborted, task blocked, request failed, approval asked, approval decided,
tool failed — go through dedup, quiet hours and digest batching, then out to
Bark, ServerChan, Telegram, WeCom, Feishu, ntfy or any webhook. Failed deliveries
retry with backoff and survive a restart.

Zero runtime dependencies, no build step, two source files (host face +
browser face). Bilingual (zh / en) — the UI follows DSH's own language, and the
language of the text pushed to your phone is set separately.

[中文说明](README.zh.md)

## Why another notifier

There are already plenty of DSH plugins that forward a message somewhere. What
none of them do is decide **whether the message should be sent at all**. That
decision is the whole product:

| Rule | What it stops |
| --- | --- |
| **Dedup** | The same failure re-firing every second. A fingerprint of (kind, session, title, body) suppresses a repeat inside a 1–1440 minute window |
| **Quiet hours** | A build breaking at 02:40. Wrap-aware (`22:00 → 08:00` crosses midnight); each repeat is either dropped or held for the next digest |
| **Digest** | Twenty failures arriving as twenty pushes. Held notifications are batched into one message every N minutes, flushed on demand |
| **Mute** | `/notify mute 60` while you are in the middle of something. Suppresses everything, including fresh fingerprints |
| **Approval pierce** | Quiet hours and digest **never hold an approval request**. Holding one until 08:00 stalls the task until 08:00, and the user blames the notifier, not the clock |
| **Retry** | A channel that is briefly down. A failed delivery goes into a durable outbox and retries with 30s → 1m → 2m → … → 30min backoff; the queue survives a restart |
| **Routing** | Per-channel event filters: Telegram only for failures, Bark for everything |
| **Redaction** | A token in a log file. Secrets are stored under a `••••••••` mask in every API response and never appear in the delivery log |

The channel adapters are deliberately thin — seven of them, each a pure
function that builds one payload. The value is the layer above them.

## What you see

| Where | What you get |
| --- | --- |
| **Official settings page** | Settings navigation → **Outbound relay**: master switch, eight event switches, dedup window, quiet hours (start / end / mode), digest interval, delivery language, pending-retry queue, and the channel editor |
| **Channel editor** | Add / edit / delete channels; per-channel name, kind, endpoint, secrets, event filter, and a **Test** button that fires one real delivery to that channel |
| **Sidebar footer** | A status pill — on/off, last delivery outcome, rail mode when the sidebar is collapsed. Clicking it opens the recent delivery log |
| **Slash commands** | `/notify status`, `/notify test [channel]`, `/notify mute <minutes>`, `/notify unmute`, `/notify flush`, `/notify retry` — no model round-trip |

Rows where the rule center decided **not** to deliver also appear in the delivery
log, with the reason (dedup / muted / quiet-hold / digest / no channel). "Did it
fire at all?" is the most common complaint about notification plugins in this
ecosystem, and a log of successful sends cannot answer it — the interesting row
is the missing one.

The channel editor shows a masked secret and only sends it back to the host if
you actually change it, so opening the editor and pressing Save never wipes a
token you did not touch.

## Channels

| Kind | Endpoint | Notes |
| --- | --- | --- |
| `bark` | your Bark server URL | iOS push, `group` = `dsh-notify-relay` |
| `serverchan` | your SendKey | ServerChan (Server酱) |
| `telegram` | bot token + chat id | `sendMessage`, silent on task-done |
| `wecom` | webhook key | WeCom robot markdown |
| `feishu` | webhook token | Feishu interactive card |
| `ntfy` | topic (+ optional server) | ntfy JSON publish |
| `webhook` | any URL | Generic JSON POST; an optional custom header carries the secret |

Each channel has its own event filter (`*` for everything). Unknown kinds are
dropped at validation time rather than failing the boot, so a config written by
a newer version cannot take the plugin down. Unknown secret *fields* inside a
known kind are kept — dropping them would silently destroy credentials.

## Install

```bash
# production profile
dsh plugin --profile web add github:Archaofan/dsh-notify-relay --ignore-scripts

# or from a local checkout / tarball
dsh plugin --profile web add file:./dsh-notify-relay-0.2.0.tgz --ignore-scripts
```

`--ignore-scripts` matters: the plugin has no install scripts and no runtime
dependencies, so refusing to run them is both faster and safer.

After installing, restart DSH (or reload the web app) and open
Settings → **Outbound relay**.

## Configure

The fastest path is the settings page. If you prefer to seed the file directly,
it lives at `<DSH_HOME>/storages/notify-relay/config.json` and is validated on
every load — a bad value falls back to the default rather than crashing:

```json
{
  "enabled": true,
  "language": "en",
  "events": {
    "task.done": false,
    "task.failed": true,
    "task.aborted": true,
    "task.blocked": true,
    "request.failed": true,
    "approval.asked": true,
    "approval.decided": false,
    "tool.failed": true
  },
  "dedup": { "windowMinutes": 10 },
  "quiet": { "enabled": false, "start": "22:00", "end": "08:00", "mode": "digest" },
  "digest": { "enabled": false, "intervalMinutes": 30 },
  "deepLink": "",
  "channels": [
    {
      "id": "phone",
      "name": "My phone",
      "kind": "bark",
      "url": "https://api.day.app/YOUR_KEY",
      "secrets": {},
      "events": ["*"]
    }
  ]
}
```

`mode` is `digest` (hold the repeats, flush as one message) or `drop`.

`language` is the **delivery language** (`zh` / `en`). It governs the text that
leaves the machine — the digest title, the `/notify` replies, the suppression
reasons. The UI language still follows DSH's own setting, because the person
reading the settings page and the person reading a push at 2am are not
necessarily the same person. An unrecognised value falls back to `zh`.

`deepLink` is optional. Only Bark (`url`) and ntfy (`Click`) have a native
tap-target field; the other channels have no equivalent and get nothing rather
than a URL pasted into the body where it is not clickable. It must be an
`http(s)` URL containing `{session}`, which is substituted per notification —
a link without a session is a lie, so it is not sent:

```json
"deepLink": "https://dsh.example.com/session/{session}"
```

## Severity

A flat "it happened" is not enough. An approval request and a task-done are both
events, but one costs you money if it is missed and the other is trivia. Every
mature notification system separates severity from content; a notifier that
cannot forces you to either miss the important one or be spammed by the
unimportant one.

| Kind | Severity |
| --- | --- |
| `approval.asked` | **critical** |
| `task.failed`, `task.aborted`, `task.blocked`, `request.failed`, `tool.failed`, `relay.degraded` | high |
| `task.done`, `approval.decided`, digest, test | normal |
| (nothing maps to low; it exists so a channel can downgrade) | low |

Severity is not decoration — it lands on real API fields, verified against the
vendor docs:

| Channel | Field | Critical | Normal |
| --- | --- | --- | --- |
| Bark | `level` | `critical` + `call: '1'` + `volume: '10'` | `active` |
| Bark | — | low → `passive`, high → `timeSensitive` | |
| ntfy | `Priority` | `5` | `3` (low → `2`, high → `4`) |
| Telegram | `disable_notification` | `false` | `true` only for `low` |
| webhook | JSON `severity` | `"critical"` | `"normal"` |

Bark's `critical` + `call` is the only primitive in this plugin's whole channel
set that breaks through iOS silent mode and Do Not Disturb. It is reserved for
approval requests, because using it for anything else is how a notifier gets
uninstalled. Server酱, WeCom and Feishu have no severity primitive at all, so
they keep their existing shape — inventing a field the API ignores is worse than
omitting one.

## Circuit breakers

Without one, a channel that is hard down — revoked token, decommissioned host,
DNS that stopped resolving — is retried on every single notification, six times
each, forever. Each retry costs a full timeout, so the outbox grows, the backoff
ceiling stretches to thirty minutes, and your **working** channels are delayed
behind the dead one.

Three consecutive failures open a channel's breaker. It then gets no requests at
all until the cooldown elapses (1m → 5m → 15m → 30m, doubling from one minute),
when exactly one probe goes out. A success resets everything, including the
ladder, so a channel that recovers does not carry a longer penalty than it
earned.

Two deliberate choices:

- **A tripped channel is not queued for retry.** Retrying it per-notification is
  the behaviour the breaker exists to stop. The skip is still written to the log
  with `error: "circuit open"` — a silent skip is the exact failure this plugin
  was written to eliminate.
- **Breakers are not persisted.** A breaker is a statement about the network
  *now*, and a restart is exactly when the network may have been fixed. Re-tripping
  after a restart costs three attempts; trusting a stale "unhealthy" flag across a
  restart could suppress a channel for thirty minutes for no reason.

The channel card in the settings page shows the breaker state and how long until
the probe, so a tripped channel explains itself instead of looking like a config
bug.

## The relay reports on itself

This is the single highest-leverage thing a notifier can do, and the one this
plugin was missing. A notifier that quietly stops notifying is **strictly worse
than no notifier**, because you believe you are covered. Healthchecks.io is built
on exactly this idea — a Period plus a Grace Time, so that *silence* is itself an
alert.

Every tick of the heartbeat timer (the same one that drains the outbox) checks
three things and, at most once an hour, warns you through a **healthy** channel:

- a channel whose breaker is open, with its id
- notifications stuck in the retry queue for more than 30 minutes, with their age
- nothing delivered at all since start-up, with an enabled channel configured

It is deliberately conservative. Once an hour, because a warning that fires on
every tick trains you to ignore it. Only through a healthy channel, because
warning through the dead one adds a failure to the thing being reported and could
recurse. Never queued for retry, because a degraded warning that fails must not
join the outbox it is describing. And never through `classify()`, because
`relay.degraded` is not a user-configurable event and the event switches must not
be able to silence it.

If every channel is open there is nobody to tell, so the warning is recorded as a
log row instead — at least it is visible to the one person who opens the panel.

`/notify status` reports the same state on demand: breaker ids, the age of the
oldest queued item, and how long since the last successful delivery.

## Where the events come from

Eight kinds, two arrival paths, and the difference is not cosmetic:

| Kind | Source | Default |
| --- | --- | --- |
| `task.done` | `turn/end`, `reason.kind = completed` | off |
| `task.failed` | `agent/error` | on |
| `task.aborted` | `turn/end`, `reason.kind = aborted` | on |
| `task.blocked` | `turn/end`, `reason.kind = blocked` | on |
| `request.failed` | `agent/request-error` | on |
| `approval.asked` | `approval/asked` | on, **pierces quiet hours and digest** |
| `approval.decided` | `approval/decided` | off |
| `tool.failed` | `tool/result` with an object `data.error` | on |

`turn/end` carries a `reason` (`completed` / `aborted` / `blocked` / `error` /
`max-tokens` / `interrupted`), so "the task finished" and "the task was aborted"
are two different notifications rather than one bland "task done".

Session events (`turn/*`, `approval/*`, `tool/result`) are dispatched **once,
under the single name `session/event`**, as `(session, event)` with the real name
in `event.type`. Registering `ctx.on('turn/end')` buys a listener on an event DSH
never dispatches — which is exactly the dead half of the first release's event
coverage, and the reason the harness carries a "listener on a session-event
sub-name" broken variant.

## How the rule engine decides

Every event goes through `classify()`, which returns exactly one verdict:

```
off          → the master switch is off; nothing happens
muted        → inside a mute window; nothing happens
dedup        → the same fingerprint was already delivered inside the window
quiet-drop   → inside quiet hours with mode = drop
quiet-hold   → inside quiet hours with mode = digest; queued for the next flush
digest       → digest batching is on; queued for the next flush
send         → delivered now
```

Delivery itself never throws and never blocks the event: a channel that times
out (10s) or refuses the connection is recorded as `failed` in the log and the
other channels still get their message. Concurrency is capped at 3 so a
misconfigured endpoint cannot flood the socket.

Backoff is exponential with **bounded jitter**: 30s, 1m, 2m, 4m … capped at 30
minutes, then multiplied by a uniform draw in `[0.75, 1.25]`. Without jitter every
pending item computes the *same* next-attempt time, so the moment a shared channel
recovers — or the moment the process restarts and reloads the whole outbox at
once — every queued notification fires at it simultaneously. A notifier whose own
failure mode is "many things failed at once" is precisely the case that produces a
thundering herd. The bound is ±25% rather than full `[0, cap]` jitter, because
full jitter can schedule a retry effectively immediately, which for a 10s-timeout
channel means a hot loop.

A digest inherits the audience of the kinds it holds. That distinction shipped as
a bug in 0.2.0: the digest was delivered with `kind: 'digest'`, so `channelsFor`
matched it against each channel's `events` list and filtered it out — a channel
configured `events: ['task.failed']`, which is this README's own worked example,
silently received no digest at all.

## Verification

This plugin was not shipped on the strength of "it looks right". Four gates,
all of which must pass, and three of which are designed to **fail**:

| Gate | What it proves |
| --- | --- |
| `.sandbox/host-harness.cjs` | The fail-loud inject contract, the rule engine (dedup / quiet hours / severity mapping / payload builders / redaction), a **real HTTP delivery** to a loopback server, the deep link on the wire, the breaker state machine, the durable outbox (enqueue / backoff / retry / give-up / restart recovery), and **16 broken-build variants** |
| `.sandbox/client-harness.cjs` | Materialization against a strict fake ctx, the inject contract, the settings-section thunk label across a language switch, dictionary key parity, the editor round-trip, **event-vocabulary parity with the host**, and 4 broken variants |
| `.sandbox/live-check.cjs` | The plugin **booted inside a real DSH**: config write → read-back → real socket delivery → log → reset → `/retry` → delivery language |
| `.sandbox/e2e-notify.mjs` | The browser half in a **real GUI**: pill, delivery panel, official settings section, and a UI change that round-trips through the host |

```bash
node .sandbox/gate.cjs        # both harnesses, both languages, plus variants
```

Both harnesses run once per language, because a build that only materializes in
Chinese proves nothing about the English UI.

### Bugs the gates only caught because they were built to fail

**A POST route that never ran.** The first cut declared `GET /config` and
`POST /config` as two routes. `webServer.match()` looks the path up in a Map and
**ignores the method entirely**, so the second registration threw, the
duplicate was swallowed as a double-mount, and every save landed on the read
handler — 200 OK, nothing persisted. Unit tests could not see it, because the
harness's fake webServer matched on method like a real router. It took a live
boot, reading back a config that had not changed. The fix is one route per path
with the method dispatched inside; the harness's fake is now byte-faithful to
the real one (Map keyed by path, duplicates throw), and a broken variant
re-registers a path on purpose.

**A logger passed in as the delivery log.** `registerRoutes(server, log)` took
`ctx.logger(PLUGIN_ID)` under the name `log`, which shadowed the array, so
`/log` threw on every call and answered 500. Nothing caught it until
`live-check.cjs` actually invoked the route. The parameter is gone and the
harness now calls the route rather than only asserting that it exists.

**Half the event coverage was dead.** The first release registered both
`ctx.on('turn/end')` and `ctx.on('approval/asked')`. Neither event is ever
dispatched under that name — session events appear only under `session/event` —
so neither listener ran, and two whole notification categories were silently
never sent. The fix is `session/event` plus an inner switch on `event.type`. The
harness now keeps a `DISPATCHED_EVENT_NAMES` registry and asserts that every
registered name is in it, that `HOST_EVENT_NAMES` matches the real
registrations, and that no listener sits on a session sub-name. Two broken
variants reproduce the dead-listener and dropped-argument forms.

**A mixin service's methods live on the context, not on the service.**
`@cordisjs/plugin-timer` calls `ctx.mixin('timer', [...])`, so
`hostCtx.timeout(...)` is correct. The first harness offered only
`ctx.timer.timeout`, and the fail-loud proxy rightly refused `ctx.timeout` — but
the digest path was never reached with a queued item, so the gate stayed green
over code it had never executed. The fake ctx now provides both surfaces and
allows a mixin's method names whenever the mixin service itself is declared.

**The event vocabulary is duplicated, and the copies drifted.** The browser half
never receives the host's `EVENT_KINDS`, so it carries its own list. When the
turn-end reasons were split out, the host list grew from four kinds to eight and
the browser list did not move — the settings page ended up with four switches
for eight events, and four kinds were silently unconfigurable. Each half was
internally consistent, so both gates stayed green; only a real browser, counting
switches, caught it. The client harness now imports the host's `EVENT_KINDS`
and compares the two lists element for element, in order.

**The outbox probe read the wrong home.** The variant runner restores `DSH_HOME`
in its own `finally`, which runs *before* the behavioural probe — so every write
the mutated plugin made landed in the real user home while the probe read an
empty scratch, and the gate green-lit a regression it never actually saw. The
probe now re-points `DSH_HOME` itself and asserts that both the config write and
the outbox file landed before drawing any conclusion.

All ten are recorded in [DEV-NOTES.md](DEV-NOTES.md) with the exact symptom, so
the next person does not have to rediscover them.

## Uninstall

```bash
dsh plugin --profile web remove dsh-notify-relay
```

## License

MIT
