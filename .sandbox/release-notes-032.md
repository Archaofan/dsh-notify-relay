## What this release is

A **description-accuracy fix**. No code, behaviour, or dependency changes — the plugin is byte-identical to 0.3.1 apart from one sentence in `package.json`.

## What was wrong

The English one-line description claimed **"an hourly self-check"**.

It is not hourly. The self-check rides the digest timer, so it runs **every 30 minutes by default**, configurable from 1 minute to 24 hours. What *is* hourly is the **warning**: `DEGRADED_COOLDOWN_MS` is 60 minutes, so a degraded relay is reported at most once an hour.

The Chinese description was already accurate — `外联自检告警` names the warning without stating a cadence — and both READMEs already said "at most once an hour". Only the English one-liner conflated the two.

## Why this is a release and not a README tweak

The same sentence is what the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) registry entry carries, and that registry reads a description as a claim checked against the code:

> **The description must be accurate.** It is read as a claim about your plugin, and it is checked against your code... Overstating is the one thing that gets an otherwise-good plugin sent back.

A cadence stated wrong by 2× is exactly what a reviewer finds by opening `index.js`. Shipping the corrected claim means the registry entry and the code agree.

## Verified

| | DSH 0.1.6-alpha.2 | DSH 0.1.7-rc.2 |
|---|---|---|
| host gate (zh / en) | pass | — |
| client gate (zh / en) | pass | — |
| full e2e (real browser) | pass | pass |

## Install

```bash
dsh plugin --profile web add github:Archaofan/dsh-notify-relay --ignore-scripts
# or the tarball attached to this release
dsh plugin --profile web add file:./dsh-notify-relay-0.3.2.tgz --ignore-scripts
```
