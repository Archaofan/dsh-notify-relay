## What this release is

A **declared-dependency fix**. No code, behaviour, or dependency changes — `index.js` and `client.js` are byte-identical to 0.3.2. What changes is `package.json`.

## What was wrong

The plugin imports `@deepseek-ai/dsh-tools` (for `defineTool`) and `@deepseek-ai/dsh-home-paths` (for `dshHomePath`) at runtime, but declared **neither** as a peer dependency. Both resolve anyway, because Node walks up from the installed plugin directory and finds DSH's own copy — so nothing ever failed, and nothing ever said the dependency existed.

That is the quiet kind of wrong: an undeclared dependency is invisible until a harness release changes the API under it, and then there is nothing in the manifest to catch the break.

## What this release does

Declares both peers, with the range the registry's own contributing guide prescribes for harness prereleases:

```jsonc
"@deepseek-ai/dsh-home-paths": ">=0.1.6-alpha.1 <0.1.7 || >=0.1.7-alpha.1 <0.2.0-0",
"@deepseek-ai/dsh-tools":       ">=0.1.6-alpha.1 <0.1.7 || >=0.1.7-alpha.1 <0.2.0-0"
```

The guide's warning is that a range which looks broad silently excludes every prerelease of a later tuple:

> A peer range without an explicit prerelease branch silently excludes every prerelease build of the harness. node-semver only lets a version's prerelease tag satisfy a range if *some* comparator in that range shares its exact `major.minor.patch` tuple and itself carries a prerelease tag.

The bare `>=0.1.6-alpha.1` looks like it covers everything. Under `npm`/`pnpm` peer resolution it **excludes `0.1.7-rc.2`** — verified with `node-semver` — so a user installing the plugin alongside DSH 0.1.7 would be walked into an `ERESOLVE` they have to work around by hand.

The explicit `||` branch is the shape the guide asks for, and it is also the dominant convention: 8 of 14 sampled third-party plugins in the registry peer on `@deepseek-ai/dsh-*` packages, and every one of them uses explicit prerelease branches (`islibaodong/dsh-login` uses `>=0.1.5-alpha.1 <0.2.0-0 || >=0.1.6-alpha.1 <0.2.0-0 || >=0.1.7-alpha.2 <0.2.0-0`).

`engines.dsh` gets the same range for consistency.

## Why the range alone was not the fix

There are two different consumers of that range and they disagree:

| consumer | how it calls semver | `>=0.1.6-alpha.1` vs `0.1.7-rc.2` |
|---|---|---|
| DSH's install gate (`dsh-app-boot`) | `satisfies(v, range, { includePrerelease: true })` | **admitted** |
| `npm` / `pnpm` peer resolution | `satisfies(v, range)` | **excluded** |

DSH's gate is the lenient one, which is exactly why the old declaration never failed a test: everything this plugin is verified against goes through that gate. The corrected range satisfies both consumers, and still admits the whole supported line — `0.1.6-alpha.1`, `0.1.6-alpha.2`, `0.1.7-alpha.1`, `0.1.7-alpha.2`, `0.1.7-rc.1`, `0.1.7-rc.2` — while excluding `0.1.5-rc.3` and `0.2.0`.

DSH's gate is real and does reject: `dsh plugin add @deepseek-ai/dsh-skill-badge` on 0.1.7-rc.2 is refused outright with *"installation rejected … Running it may cause crashes or data loss"*, because its `^0.0.1-rc.1` peer cannot match a different tuple even with `includePrerelease`. Both plugins here pass that gate on both runtimes, verified by real installs.

## Verified

| | DSH 0.1.6-alpha.2 | DSH 0.1.7-rc.2 |
|---|---|---|
| install gate admits the release | pass | pass |
| host gate (275 checks) | pass | pass |
| client gate | pass | pass |
| full e2e (real browser) | pass | pass |
| tarball ships the corrected range, 11 files | pass | — |
| `index.js` / `client.js` byte-identical to 0.3.2 | pass | — |

The e2e rows are inherited: the shipped code is byte-identical, so a re-run would test the same bytes. What this release changes is metadata, and the install gate is the only consumer of metadata that can refuse a plugin.

## Install

```bash
dsh plugin --profile web add github:Archaofan/dsh-notify-relay --ignore-scripts
# or the tarball attached to this release
dsh plugin --profile web add file:./dsh-notify-relay-0.3.3.tgz --ignore-scripts
```
