# COL-02 membership refresh browser regression

Base: `0415a98994624fcc2c50bf211d3c489ee18637be` on `fix/group-history-browser`.

The upstream Verify run `33951835479`, code job `101267973285`, failed the exact
`History: Since 2026-09-04T00:00:00.000Z` visibility assertion in
`apps/web/tests/e2e/group-bots.spec.ts`. The preceding cap-conflict and retained
time-value assertions had passed. This change only synchronizes the test with
the visible completion of its existing Refresh memberships interaction.

## Diagnosis

The original focused scenario passed five ordinary local repetitions. A temporary
750 ms route hold for `bots/__data.json` did not intercept the refresh, including
after a temporary hydration readiness probe. Five instrumented repetitions
showed no network request for Refresh memberships: SvelteKit handled the same
route from cached data. The subsequent invitation used a native form POST and
GET. A delayed data-request hypothesis therefore did not explain this path.

Inspection of the installed SvelteKit client showed that a link click schedules
navigation after `requestAnimationFrame` and `setTimeout(0)`, with a 100 ms
fallback. Navigation clears the prior action form. The page's bound history
mode consequently resets from the retained `since-time` value to `future-only`.

The alternatives considered were a stale form reset during navigation, a fixture
history serialization problem, and slow rendering of an already created grant.
The controlled failure below observed no new invitation attempt and a reset
form, which isolates the stale form sequence rather than the latter two cases.

## Controlled RED and GREEN

This temporary browser-only scheduling probe was inserted immediately before
the existing Refresh memberships click. It delayed the existing navigation
window without changing the link, field selections, submission, fixture, or
final history assertion:

```ts
await page.waitForLoadState('networkidle');
await page.evaluate(() => {
  const scheduleTimeout = window.setTimeout.bind(window);
  const scheduleFrame = window.requestAnimationFrame.bind(window);
  window.setTimeout = ((callback, delay, ...args) =>
    scheduleTimeout(callback, delay === 100 ? 750 : delay, ...args)) as typeof window.setTimeout;
  window.requestAnimationFrame = (callback) =>
    scheduleFrame(() => scheduleTimeout(() => callback(performance.now()), 750));
});
```

Command from the repository root:

```sh
pnpm --filter @openbot/web exec playwright test group-bots.spec.ts --grep 'supports explicit event/time choices' --retries=0
```

RED: exit 1. The scenario failed in 7.8 seconds on the original exact history
label after the unchanged 5,000 ms assertion timeout. At the time fill completed,
the old conflict alert count was still 1. After the Invite click, the history
mode was `future-only`; the failure snapshot showed “Choose a Bot” selected,
no time field, and only the closed prior grant. Fixture state had three attempts
(initial invite, removal, rejected cap invite), so the intended new invitation
had never been sent.

GREEN: add only the readiness assertion below after clicking Refresh memberships
and before selecting the Bot. Run the same probe with `--repeat-each=3`:
3 passed, exit 0, 27.5 seconds including the web build. All three runs had no
conflict alert before filling, four fixture attempts and two grants, and passed
the unchanged exact since-time label, permission-conflict and cookie assertions.

```ts
await expect(page.getByLabel('History access')).toHaveValue('future-only');
```

Because the prior cap form is explicitly asserted to retain its since-time
input, the new assertion observes the refresh transition rather than accepting
an unrelated initially true state. It waits for the refreshed form before the
test supplies new choices. It neither retries the scenario nor relaxes the
history contract or assertion timeout.

## Final verification

All temporary route, timer, hydration and logging instrumentation was removed
from the executable test. No production source or Playwright configuration was
changed. The executable diff is exactly two inserted lines: an explanatory
comment and the observable form-readiness assertion.

Final normal-timing verification on the two-line fix:

```sh
pnpm --filter @openbot/web exec playwright test group-bots.spec.ts --retries=0 --repeat-each=3
# 6 passed (35.2s), exit 0
pnpm exec prettier --check apps/web/tests/e2e/group-bots.spec.ts .scratch/openbot/COL-02-BROWSER-RETRY.md
# All matched files use Prettier code style, exit 0
git diff --check
# exit 0
```

Both original scenarios passed all three repetitions. The unchanged since-time,
permission-conflict and cookie assertions passed. A scan of the executable test
found no temporary route, scheduler, hydration or console instrumentation.
The browser runner exited normally and released its fixture/application servers.
The dedicated merge gate and downstream CI/native/PostgreSQL checks remain the
responsibility of the parent integration flow.
