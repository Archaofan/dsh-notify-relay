# DEV-NOTES

Implementation notes for `dsh-notify-relay`. Everything here cost time to find
out; none of it is obvious from the API surface.

## The dual-face plugin contract

A DSH plugin is one package with two halves:

- **host face** — `index.js`, `export const name / inject / apply(ctx)`. Runs in
  Node, inside the dsh process.
- **browser face** — `client.js`, which calls
  `window.__ModuleLoader__.load({ id, factory })`. Runs in the page.

`package.json`'s `dsh` field wires them up (`bundle.patch` points at
`cordis.patch.yml`, which inserts the plugin row into `dsh.profile.bundles`;
`client.platform` / `client.inject` declare the browser half).

`inject` must list **every service the fiber can actually reach**. Reading a
service that is not listed throws `cannot get property "X" without inject`
inside `apply()`, and the whole plugin tree fails — the GUI reports
"1 entry did not activate". Listing a service that is *not reachable* from this
fiber is just as bad in the other direction: cordis waits forever for the
sibling fiber to appear.

`webServer` is exactly that case: it exists in web compositions and is absent
elsewhere. It is therefore **not** in the top-level `inject` list; it is reached
through the optional-dependency pattern:

```js
ctx.inject(['webServer'], (webCtx) => {
  webCtx.effect(() => registerRoutes(webCtx.webServer), 'notify-relay.routes')
})
```

`@cordisjs/plugin-timer` (already composed by dsh-base) is a mixin service, so
`'timer'` must be in `inject` and the digest timer is armed through
`hostCtx.timeout(...)`, which is disposal-aware.

## Pitfall 1 — one route per path, or the POST never runs

`webServer.match(pathname)` is:

```js
match(pathname) {
  const exact = this.exact.get(pathname)
  ...
}
```

A `Map` keyed by **path**. The `method` field on a route descriptor is never
consulted. Consequences:

1. A `GET /config` route and a `POST /config` route collide. The second
   `register` throws.
2. `registerRoute` deliberately swallows the duplicate, because a double mount
   of the same plugin must not fail the boot.
3. So the POST handler is **never registered**, and every write is served by the
   read handler: 200 OK, response unchanged, nothing persisted.

This shipped. Unit tests could not see it — the harness's fake webServer stored
routes in an array and matched on method, exactly like a real router would, so
the collision never reproduced. It surfaced only when a live boot read back a
config that had not changed.

**Fix:** one route per path, `req.method` dispatched inside the handler:

```js
handler: guarded(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { /* write */ return }
  /* read */
})
```

**Guard:** `.sandbox/host-harness.cjs`'s fake webServer is now byte-faithful —
a `Map` keyed by path, duplicates throwing, a `duplicateRegistrations` ledger —
and the gate asserts that no path is registered twice and that no route declares
a `method`. The broken variant re-points the `/log` route at `/config` and must
be rejected.

## Pitfall 2 — a logger passed in as the delivery log

`registerRoutes(webServer, log)` took `ctx.logger(PLUGIN_ID)` as its second
argument. Inside the `/log` route the parameter shadowed the module-level
`log` array, so `log.slice(0, 50)` threw on every request and the route answered
500.

Nothing caught it until `live-check.cjs` actually invoked the route. The
harness had only asserted that a route *exists*.

**Fix:** the parameter is gone; the route reads the module state.

**Guard:** the harness now calls `GET /log` and asserts it answers 200 with a
list. Asserting existence is not asserting function.

## Pitfall 3 — unknown secret fields were silently discarded

`validateChannel` used to rebuild `secrets` from the channel kind's canonical
schema and nothing else. Any key outside that schema was dropped on the floor.

That is invisible today — no kind declares an extra secret field — but it is a
trap for anyone who hand-edits `config.json` or adds a kind later: the channel
still looks configured, the secret is gone, and every delivery goes out
unauthenticated with nothing anywhere reporting a problem.

**Fix:** start from the caller's own `secrets` (string values only, length
capped), then overlay the canonical fields so the `REDACTED` merge still wins.

**Guard:** the harness asserts that an unknown secret field survives
validation, that the canonical field still wins, and that the unknown field is
still redacted in `redactConfig`.

Note the distinction that makes this safe: unknown **kinds** are dropped (a
config written by a newer plugin must not break an older one), but unknown
**fields inside a known kind** must survive (dropping them destroys user data).

## Pitfall 4 — the initial draft is async

`pullConfig()` is a `fetch`, so `state.loaded` is still false at mount time. Any
harness that renders the settings section immediately sees an empty editor and
passes assertions against `emptyConfig()` instead of the host's values — a green
gate over a component that only ever shows defaults.

**Guard:** the client harness awaits a settle tick after `apply()` before the
first render, and asserts specific host values (dedup window 7, quiet start
`23:00`, a masked token, chat id `4242`) rather than "some value".

## Pitfall 5 — a flaky gate trains you to ignore red

The delivery log is written through a serialized promise queue, so "sleep 200ms
and check" intermittently read a half-written file. Three runs out of six were
red for no reason.

**Fix:** `waitFor(predicate, timeout)` polls the actual condition. A gate that
is only sometimes right is worse than no gate.

## Pitfall 6 — the settings nav label must be a thunk

`ctx.slots.register({ label: () => t.settingsNav })`. A plain string is captured
at registration; DSH's settings page never reloads on a language switch, so a
static label goes stale the instant the user changes language. The same applies
to every `label` the plugin hands to a slot.

**Guard:** the client harness reads the label in the active language, switches
to the other language, and reads it again — once per language, because the
document language is fixed per page load.

## Pitfall 7 — the event vocabulary is duplicated, and the copies drifted

The browser half never receives the host's `EVENT_KINDS`, so it carries its own
`EVENT_IDS`. When the turn-end reasons were split out (`task.aborted`,
`task.blocked`, `approval.decided`, `tool.failed`), the host list grew from four
kinds to eight and the browser list did not move. The result was a settings page
with four switches for eight events: four kinds were silently unconfigurable,
and nothing in either gate noticed, because each half was internally consistent.

It surfaced only in the real browser, because the fake-DOM harness asserts what
the client renders, and the client rendered exactly what its own list said.

**Fix:** one list per half, and a cross-check between them.

**Guard:** the client harness imports the host's `EVENT_KINDS` and asserts the
two lists are equal *element for element, in order* — not just the same length,
because a reordering would silently remap every switch. It then switches the
locale both ways and asserts every kind resolves to a real string in both
dictionaries. A kind added to one half and not the other now fails the gate.

The label mapping is read back from the client's own `EVENT_LABEL_KEYS` rather
than derived from the id: `approval.asked` labels as `evApproval`, and a
`evApprovalAsked` derivation would report a false failure forever.

## Pitfall 8 — a mixin service's methods are on the context, not the service

`@cordisjs/plugin-timer` calls `ctx.mixin('timer', [...])`, so the plugin
correctly writes `hostCtx.timeout(...)` — the method lives directly on the
context, not under `ctx.timer`. The first harness offered only
`ctx.timer.timeout`, and the fail-loud proxy rightly refused `ctx.timeout`.

That mismatch stayed latent because the digest path was never reached with a
queued item, so the gate stayed green over a code path it had never executed.
It surfaced the moment an outbox test held a real failed delivery.

**Fix:** the fake ctx provides both surfaces, and `makeCtx` allows a mixin's
method names whenever the mixin service itself is declared — because that is
precisely the contract a mixin has with the runner.

## Pitfall 9 — the outbox probe read the wrong home

The variant runner restores `DSH_HOME` in its own `finally`, which runs *before*
the behavioural probe. Every write the mutated plugin made therefore landed in
the real user home while the probe read an empty scratch, so the probe reported
"no outbox" for a build that had a perfectly good outbox — and the gate
green-lit a regression it never actually saw.

**Fix:** the probe re-points `DSH_HOME` at the scratch and restores it itself.

**Guard:** the probe asserts the config POST landed *and* that the outbox file
exists before drawing any conclusion, so a probe that cannot see the plugin's
output reports that instead of reporting success.

## Pitfall 10 — `agent/*` events are dispatched under their own name

`agent/error` and `agent/request-error` are **scoped agent events**: they are
dispatched under their own names, so `ctx.on('agent/error')` is correct.
Everything in `SessionEventMap` — `turn/end`, `approval/asked`, `tool/result` —
arrives once, under `session/event`, as `(session, event)` with the real name in
`event.type`. Registering `ctx.on('turn/end')` buys a listener on an event DSH
never dispatches.

The first outbox test fed a synthetic `{ type: 'agent/error' }` pair to the
`session/event` listener. Nothing fired, no log row appeared, and the test
reported "the outbox is empty" for a build whose outbox was fine. A test that
passes for the wrong reason is worse than no test.

**Guard:** the harness keeps a `DISPATCHED_EVENT_NAMES` registry and asserts
every registered listener name is in it, that `HOST_EVENT_NAMES` matches the
real registrations, and that no listener sits on a session sub-name. Two broken
variants reproduce the dead-listener and dropped-argument forms of this bug.

## Storage and atomicity

Config, delivery log and outbox live under `dshHomePath('storages', PLUGIN_ID, …)`,
which honours `DSH_HOME` (so the harness can point it at a scratch directory).
Writes go to a `.tmp` sibling and then `rename`, so a crash mid-write cannot
leave a half-parsed JSON file that would silently reset the user's config.

All three share one serialized promise queue, so concurrent writes cannot
interleave and a `.tmp` file is never observed half-written.

## The outbox

A delivery that reached no channel, or reached one that failed, is persisted to
`outbox.json` with an attempt counter and a `nextAttemptAt`. The backoff is
`min(30s · 2^(attempts-1), 30min)`. An entry at `MAX_DELIVERY_ATTEMPTS` is
dropped, and the drop is recorded in the delivery log with the last error —
an outbox that grows without bound is a memory leak with a friendly name.

`apply()` loads the outbox and re-arms the drain timer, so a restart resumes the
queue instead of abandoning it. That is the whole reason the outbox is on disk:
an in-memory queue loses every pending retry on restart, which is the documented
limitation of the incumbent notifier in this ecosystem.

`GET /retry` reports the pending count; `POST /retry` drains immediately,
ignoring the backoff, because "the log says failed — now what?" is the question
the backoff does not answer.

## Host-side copy

The browser half has `ctx.locale` and follows the UI. The host has no such
service, so everything the host emits — digest titles, `/notify` replies,
suppression reasons — comes from `HOST_STRINGS` selected by `config.language`
(`'zh'` | `'en'`, default `'zh'`).

This matters more than it sounds. The half a user actually reads is the half
that arrives on a phone at 2am; a notification in a language they do not read is
worse than no notification, and "hardcoded Chinese runtime strings" is the
longest-standing open i18n complaint against the incumbent.

`ctx.settings.register` is deliberately **not** used. It would create a second
source of truth for the same values, and the browser half has no clean read path
to it — the settings page would show one thing while the host enforced another.

## The client half's state plumbing

`subscribe` / `useRelayState` is a hand-rolled `useReducer` + `useEffect` store,
not `useSyncExternalStore`: the plugin targets the React version DSH ships, and
the miniature React in `.sandbox/client-harness.cjs` implements hooks per
instance with a position-keyed reconciler, which is enough to prove the render
contract without dragging in a real React.

The editor keeps an explicit draft and an explicit Save. Nothing is written on
keystroke: a masked secret must be able to round-trip unchanged, and the only
way to tell "user did not touch this" from "user cleared this" is to compare
against the stored mask at save time.

## What the gates do not cover

- Real channel endpoints. Every delivery in the gates goes to a loopback server
  on `127.0.0.1`. Bark, Telegram and friends are proven only as payload
  builders.
- The slash command's output rendering inside DSH's own composer.
- Concurrent browser tabs. `GET /config` re-reads from disk on every call, so an
  external edit is picked up on the next poll, but two tabs editing at once will
  clobber each other.
- A restart under load. The outbox's restart recovery is proven by booting a
  second instance against the same home and reading the pending count back, not
  by killing a live process mid-delivery.
