# dsh-notify-relay

The outbound **rule center** for DSH: lifecycle events — task done, task
failed, request failed, approval asked — go through dedup, quiet hours and
digest batching, then out to Bark, ServerChan, Telegram, WeCom, Feishu, ntfy or
any webhook.

Zero runtime dependencies, no build step, two source files (host face +
browser face). Bilingual (zh / en) — the UI follows DSH's own language.

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
| **Routing** | Per-channel event filters: Telegram only for failures, Bark for everything |
| **Redaction** | A token in a log file. Secrets are stored under a `••••••••` mask in every API response and never appear in the delivery log |

The channel adapters are deliberately thin — seven of them, each a pure
function that builds one payload. The value is the layer above them.

## What you see

| Where | What you get |
| --- | --- |
| **Official settings page** | Settings navigation → **Outbound relay**: master switch, four event switches, dedup window, quiet hours (start / end / mode), digest interval, and the channel editor |
| **Channel editor** | Add / edit / delete channels; per-channel name, kind, endpoint, secrets, event filter, and a **Test** button that fires one real delivery to that channel |
| **Sidebar footer** | A status pill — on/off, last delivery outcome, rail mode when the sidebar is collapsed. Clicking it opens the recent delivery log |
| **Slash commands** | `/notify status`, `/notify test [channel]`, `/notify mute <minutes>`, `/notify unmute`, `/notify flush` — no model round-trip |

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
dsh plugin --profile web add file:./dsh-notify-relay-0.1.0.tgz --ignore-scripts
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
  "events": { "task.done": false, "task.failed": true, "request.failed": true, "approval.asked": true },
  "dedup": { "windowMinutes": 10 },
  "quiet": { "enabled": false, "start": "22:00", "end": "08:00", "mode": "digest" },
  "digest": { "enabled": false, "intervalMinutes": 30 },
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

## Verification

This plugin was not shipped on the strength of "it looks right". Four gates,
all of which must pass, and three of which are designed to **fail**:

| Gate | What it proves |
| --- | --- |
| `.sandbox/host-harness.cjs` | The fail-loud inject contract, the rule engine (dedup / quiet hours / payload builders / redaction), a **real HTTP delivery** to a loopback server, and 6 broken-build variants |
| `.sandbox/client-harness.cjs` | Materialization against a strict fake ctx, the inject contract, the settings-section thunk label across a language switch, dictionary key parity, the editor round-trip, and 4 broken variants |
| `.sandbox/live-check.cjs` | The plugin **booted inside a real DSH**: config write → read-back → real socket delivery → log → reset |
| `.sandbox/e2e-notify.mjs` | The browser half in a **real GUI**: pill, delivery panel, official settings section, and a UI change that round-trips through the host |

```bash
node .sandbox/gate.cjs        # both harnesses, both languages, plus variants
```

Both harnesses run once per language, because a build that only materializes in
Chinese proves nothing about the English UI.

### Two bugs the gates only caught because they were built to fail

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

Both are recorded in [DEV-NOTES.md](DEV-NOTES.md) with the exact symptom, so
the next person does not have to rediscover them.

## Uninstall

```bash
dsh plugin --profile web remove dsh-notify-relay
```

## License

MIT
