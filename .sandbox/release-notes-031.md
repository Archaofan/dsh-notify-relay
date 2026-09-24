## What this release is

`dsh-notify-relay` is now confirmed on **DSH 0.1.7** as well as **0.1.6-alpha.2**.

**The plugin code is identical to 0.3.0.** Nothing is version-gated at runtime, and the only 0.1.7 difference found was environmental — so this release is the compatibility statement, not a behaviour change.

## The one 0.1.7 difference found

DSH 0.1.7 added a first-run flow that 0.1.6 did not have: a closed-beta announcement followed by an "add an API key" prompt. Both render as a modal with a full-page `role="presentation"` mask that intercepts pointer events, so nothing in the sidebar can be clicked until they are gone.

That broke the **test harness**, not the plugin — the e2e failed on its first click. The API-key prompt is the subtle part: it is **not** persisted as "skipped", so a credential-less profile sees it again on every page load. The dismissal therefore runs after the GUI settles rather than once, and every locator is `exact: true` — `hasText: '继续'` also matches the disabled "保存并继续", which times out with a log that says nothing about why.

The same code is a no-op on 0.1.6 and on an onboarded profile, so one e2e drives both sandboxes.

## Verification

| | DSH 0.1.6-alpha.2 | DSH 0.1.7-rc.2 |
|---|---|---|
| host gate (zh) | pass | — |
| host gate (en) | pass | — |
| client gate (zh) | pass | — |
| client gate (en) | pass | — |
| full e2e (real browser, pill, settings, delivery write-through) | pass | pass |

The gates are version-independent (they run against strict fake contexts), so they run once; the e2e ran against both sandboxes.

## Install

```bash
dsh plugin --profile web add github:Archaofan/dsh-notify-relay --ignore-scripts
# or the tarball attached to this release
dsh plugin --profile web add file:./dsh-notify-relay-0.3.1.tgz --ignore-scripts
```
