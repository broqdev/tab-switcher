# Search performance

See [the initial baseline](performance-baseline.md) and
[the measured improvements](performance-improvements.md) for before/after results.
Continuous input queueing is measured separately; see
[the typing investigation](continuous-typing.md).

Run these from the `tab-switcher` directory after `npm install` and
`npx playwright install chromium`:

```sh
# Search computation: one-shot preparation versus reused records/index.
npm run perf:search

# Production popup: all datasets, three repetitions, plus diagnostic profiles.
npm run perf:ui -- --profile

# Fixed-cadence typing, backspacing, and multi-term queries.
npm run perf:typing -- --profile

# Quick smoke run, or repeat the expensive case on a slower CPU.
npm run perf:ui -- --scenarios small --repetitions 1
npm run perf:ui -- --scenarios huge,open-only --repetitions 5 --cpu-rate 4 --profile
```

`perf:search` writes `test-results/performance/search/{results.json,report.md}`.
Set `PERF_SCENARIOS=small,huge` to select datasets, or `PERF_OUTPUT=...` to
preserve a particular computation run.

`perf:ui` builds the extension and writes a timestamped directory under
`test-results/performance/`. Override it with `--output <directory>`.
`results.json` includes every sample, environment details, and a summary;
`report.md` contains comparison tables. Failed runs preserve partial results
and explicitly mark the report incomplete. No absolute timing threshold is
part of the normal test suite.

To measure an already-built baseline, invoke the runner directly with
`node --experimental-strip-types scripts/profile-search.mjs --extension-path /path/to/build`.
This skips rebuilding the current source. Save each build's output in a separate
directory. Browser integration tests use `test-results/e2e`, so running them
does not clear saved performance profiles.

## Controlled comparisons

| Dataset           | Open tabs | Stored closed tabs | Closed visible  |
| ----------------- | --------: | -----------------: | --------------- |
| Small             |        20 |                 50 | Both off and on |
| Medium            |       200 |              1,000 | Both off and on |
| Huge              |       200 |             10,000 | Both off and on |
| Open-only control |       200 |                  0 | Off             |

Compare huge/on with huge/off for the cost of searching and rendering history.
Compare huge/off with open-only/off for the cost of **stored but hidden** history.
The open counts are identical in those comparisons. The small dataset represents
light use; it cannot isolate history costs against the 200-open control.

Fixtures have repeatable timestamps, unique URLs, multiple windows, Unicode,
encoded URLs, and interleaved recency. They cover:

- Empty and broad `t` results, which expose how rendering scales with all logical results.
- `typescrpt`, which exercises typo matching rather than literal search.
- `typescrpt handbook`, which exercises multiple fuzzy terms.
- `x.com`, which follows the literal domain path within fuzzy mode.
- `cafe`, which exercises Unicode normalization.
- An unsuccessful query, which scans records but renders no rows.

The UI runner measures first open, warm reopen, pasted queries, clearing,
individual keystrokes, keyboard selection with an empty search, and closed-tab
toggle changes with and without a query. Computation benchmarks check every
logical result key against a separate fixture oracle. The windowed UI checks
the full logical result count, every mounted key, bounded row counts, and the
presence of the active descendant. Intermediate typing checks the committed
query and exclusion of hidden closed rows. Browser regressions additionally
exercise deep scrolling, keyboard wrapping, and activation outside the initial
viewport. Existing unit/integration tests cover broader matching semantics.

## What the measurements mean

- **Computation:** synchronous search return in Node, warmed up before measurement.
  The one-shot strategy creates a searcher on each call; prepared strategy reuses
  one `createTabSearcher()` snapshot across queries. Prepared records/index are
  initialized before timed samples; the UI run includes their first-use cost.
  Highlight fields are now lazy and are not accessed by this computation bench;
  UI timings include mapping for mounted rows. Excludes Chrome storage, React,
  layout, and painting. Useful for relative algorithm comparisons; browser timing can differ. Raw samples are
  retained. Fixture creation and correctness checks are outside timed calls.
- **Commit:** DOM event capture to the committed result state. Includes the
  synchronous handler, searching, React rendering, and DOM work. A small
  production `data-search-query`/mode/visibility marker identifies that commit.
  Toggle measurements also wait for preference saving to re-enable the checkbox.
  If search rendering becomes deferred, keep the marker bound to the query used
  by the displayed results, rather than the newest input value.
- **Response:** commit followed by two animation frames, allowing a paint
  opportunity. This is a lab responsiveness proxy, **not INP or a pixel paint
  timestamp**. It excludes time waiting before the event handler begins. On
  a 60 Hz display, even trivial work incurs a frame-related baseline.
- **Startup:** navigation time origin to ready results and two animation frames.
  Includes native history storage reads, validation/merge, search, and rendering.
  First navigation and subsequent warm navigations are reported separately.
- **Event Timing:** native event entries, including processing start/end and
  duration, are saved when Chrome supports them. These can expose input delay
  missing from the response proxy. Chrome omits events under 16 ms and quantizes
  durations; absent entries do not mean zero latency. Automated interactions
  are not a field INP distribution.
- **Long tasks/frame gaps:** main-thread tasks over 50 ms and gaps between
  animation frames during an operation. Long tasks can straddle operation
  boundaries; counts are diagnostic, not additive exclusive CPU time.
- **Script/layout/style time:** differences in CDP cumulative counters around
  each interaction. Includes the automation/probe work within that interval;
  not exclusive application self time.
- **Heap/DOM:** CDP heap usage and DOM counters after each operation. Detached
  objects may await garbage collection; these are not retained-memory or leak
  measurements. Logical result counts and actually mounted row counts are also saved.

The test uses an isolated temporary Chromium profile and the production-built
popup at its normal 400 × 600 viewport. Native extension storage contains only
synthetic history. Only popup open-tab enumeration is stubbed: it avoids
opening thousands of actual tabs while retaining Chrome storage and the real
React/search/rendering path. It does not measure background tracking, actual
window switching, browser popup framing, or the native toolbar opening gesture.
All performance observers live in injected test code, not the shipped extension.

## Diagnose and compare changes

With `--profile`, a **separate, untimed** huge/history-visible pass records:

- `huge.trace.json`: load in Chrome DevTools → Performance → Load profile.
  Inspect the main thread, rendering, long tasks, and function call stacks.
- `huge.cpuprofile`: a V8 CPU sampling profile; open with a CPU profile viewer
  (for example VS Code). Production function names may be minified.
- `huge-search.png`: the actual popup after the multi-term query.

Separate diagnostic recording keeps tracing overhead out of the timing samples.
The traced sequence searches, clears, and moves keyboard selection; it includes
all work in that sequence, so inspect the timeline before attributing total
CPU samples to filtering alone.

Use the same machine, power mode, Chrome version, CPU throttle, fixture version,
and repetition count for comparisons. Close unrelated heavy workloads. Default
three-repetition p95 values are descriptive and often just the maximum; use
`--repetitions 10` for a stronger comparison. First-open has only one observation
per case. Individual keys wait for the previous result before continuing, so
they reveal per-key stalls but do not simulate a hardware input queue during
rapid typing. CPU throttling is an approximation, not a different physical CPU.

The `perf:typing` runner sends trusted CDP key events on fixed Node timers without
awaiting earlier keys, searches, or renders. Its default small/huge, history
on/off cases use 60 ms and 120 ms intervals and three repetitions. It records
host scheduling jitter, input capture time, first animation frame showing each
prefix (or a newer prefix), superseded prefixes, final-result settling, native
Event Timing entries, main-thread long tasks, and frame gaps. Sending-to-capture
includes CDP transport and browser queueing; frame observations are paint
opportunities, not pixel presentation or INP. It verifies every input prefix
and the final fixture result count and mounted keys. `--profile` records a
separate huge/history-visible CPU profile and Chrome timeline.

Typing options include `--scenarios small,huge`, `--intervals 60,120`,
`--repetitions 3`, `--cpu-rate 1`, `--extension-path /path/to/build`, and
`--output test-results/performance/typing-run`. Invoke the Node script directly
to compare a saved build without rebuilding current source, as with `perf:ui`.

Treat repeated interactive responses over 100 ms as a local investigation signal
and any 50 ms long task as potential jank; these are working budgets, not INP
compliance claims or universal hardware limits. Check p50, p95, worst samples,
and traces together. Prioritize the largest measured cost:

- Expensive search with few results: inspect normalization, Fuse index creation,
  scans, ranking, and highlight mapping; consider reusing prepared records/index.
- Expensive clear/selection with cheap computation: inspect full-list React/DOM
  work; consider rendering only visible rows and isolating selection updates.
- Slow startup even with history hidden: inspect history loading/validation and
  merge costs before considering lazy loading of closed history.

Background references: [Chrome Performance panel](https://developer.chrome.com/docs/devtools/performance/reference/),
[INP measurement](https://web.dev/articles/inp),
[Playwright extensions](https://playwright.dev/docs/chrome-extensions),
and [Vitest benchmarking](https://vitest.dev/guide/benchmarking).
