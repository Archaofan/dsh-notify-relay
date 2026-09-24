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

## Storage and atomicity

Config and delivery log live under `dshHomePath('storages', PLUGIN_ID, …)`,
which honours `DSH_HOME` (so the harness can point it at a scratch directory).
Writes go to a `.tmp` sibling and then `rename`, so a crash mid-write cannot
leave a half-parsed JSON file that would silently reset the user's config.

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
