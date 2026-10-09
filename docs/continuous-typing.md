# Continuous typing investigation

The remaining lag was reproducible after the first performance pass. That pass
reduced search time and DOM work, but Fuse still ran synchronously inside React
rendering. A long search prevented both input processing and the next frame.
Successive prefixes could also take longer than the interval between keys.

The original interaction profiler waits for each result before sending the next
key. The new `perf:typing` workload schedules trusted CDP key events from Node
at fixed 60 ms and 120 ms intervals, without waiting for earlier input or renders.
It covers a multi-term query, an unsuccessful query, and typing/backspacing/retyping.
Each build receives 72 bursts containing 984 keystrokes across small/huge datasets,
history shown/hidden, two intervals, and three repetitions.

## Cause and remedy

With 200 open and 10,000 closed entries shown, the baseline 60 ms multi-term
workload had 105.9 ms p95 input acceptance delay, 277.1 ms p95 display delay,
335.5 ms worst display delay, and 32 main-thread long tasks over three repetitions.
The separate initial smoke run reached 398.9 ms display delay. The UI CPU profile
is dominated by Fuse `searchIn` and its compiled matcher. With closed history
hidden, the same workload's display p95 was 17.4 ms with no long tasks.

The implementation now:

- Owns a local Web Worker for the lifetime of each popup. It runs the same
  prepared search implementation and matching modes outside the UI thread.
- Keeps one active search and one replaceable latest request. An already-running
  search finishes, but obsolete results are ignored and intermediate queued
  prefixes are skipped. Dataset, mode, and visibility changes use the same guard.
- Transfers the complete ranked result order as compact integer indices.
  Only 50 initial highlight records are sent, with additional visible-row
  highlights requested on scroll. Cloning every lazy search result would force
  all highlight getters and undo the earlier optimization.
- Updates input text immediately. Previous rows remain visible while searching,
  but cannot be selected or activated until they belong to the current request.
  Pending ArrowUp/ArrowDown/Enter intent is applied to the current results before
  painting. Editing the query or preferences clears old keyboard intent.
- Keeps profiling markers tied to the committed results, rather than the newest
  input value. A worker failure shows a recoverable error; changing the query
  starts a fresh worker. Closing the popup terminates its worker.

No runtime dependency or extension permission was added. The worker is a bundled
local asset, and the existing popup layout and search ranking are retained.

## Final typing comparison

The preserved baseline popup is `popup-BdtVbF-5.js`. The final popup is
`popup-fYNypSVj.js`, with local worker `tab-search.worker-BHKwJx7S.js`.
Both runs completed all 72 bursts and verified all 984 input prefixes plus the
final fixture result counts and mounted keys.

With 200 open and 10,000 closed entries shown:

| Key interval | Workload       | Display p95 before ms | After ms | Final settle p50 before ms | After ms |
| -----------: | -------------- | --------------------: | -------: | -------------------------: | -------: |
|        60 ms | Multi-term     |                 277.1 |     17.6 |                      188.5 |    114.7 |
|        60 ms | Unsuccessful   |                 186.2 |     16.3 |                       66.8 |    102.3 |
|        60 ms | Backspace/edit |                 193.0 |     16.2 |                       75.7 |    105.6 |
|       120 ms | Multi-term     |                  81.1 |     16.8 |                       82.4 |    111.3 |
|       120 ms | Unsuccessful   |                  67.0 |     17.3 |                       66.3 |     86.0 |
|       120 ms | Backspace/edit |                  70.1 |     18.1 |                       69.4 |     97.9 |

In the 60 ms multi-term case, input acceptance p95 fell from 105.9 to 2.6 ms
and worst display delay from 335.5 to 25.4 ms. Across all cases, observed
main-thread long tasks fell from 122 to zero, maximum frame gap from 236.4 to
24.2 ms, and prefixes superseded before a frame from 35 to zero. The diagnostic
UI CPU profile contains no sampled Fuse `searchIn` calls after moving matching
to the worker. Largest recorded host timer delay was 7 ms before and 13 ms after;
the input/display delays are measured from actual sends, with timer jitter
retained separately in the raw samples.

Small-data 60 ms multi-term display p95 stayed near one frame: 19.0 → 18.3 ms
with closed entries hidden and 17.3 → 17.4 ms with them shown. The large dataset
with history hidden stayed similarly stable at 17.4 → 17.2 ms.

Moving work off-thread does not remove its CPU cost. Worker messaging and React
scheduling can add a frame or more before final results arrive, as the table
shows for unsuccessful searches and backspacing. The improvement is that input
keeps responding during that interval. A running obsolete search is not forcibly
cancelled; only its result is discarded and pending obsolete queries are skipped.

The separate UI-interaction run completed 455 samples across small, huge, and
open-only controls. Compared with the previous optimized synchronous build:

| Dataset, closed shown | Operation                | Before ms | Worker ms |
| --------------------- | ------------------------ | --------: | --------: |
| Small                 | Warm reopen              |      45.6 |      60.8 |
| Small                 | Typo search              |      26.3 |      26.4 |
| Huge                  | Warm reopen              |      91.3 |     124.0 |
| Huge                  | Typo search              |      92.5 |     105.7 |
| Huge                  | Clear unsuccessful query |      31.2 |      47.9 |
| Huge                  | Keyboard selection       |      23.9 |      23.1 |

These medians expose the worker startup and result-delivery cost. Typing display
responsiveness improves substantially while some complete-result operations
take longer. They use the previous windowed/prepared-search build as baseline,
so they should not be confused with the earlier full-list-rendering comparison.

## Regression verification

Type checking, the production build, and 93 unit tests passed. Browser checks
verified 44 distinct cases: 42 passed in the full run, and the seven performance
regressions passed after correcting an ambiguous title/URL highlight selector
in the other two. New coverage verifies worker result/highlight parity,
superseded requests, snapshot replacement, termination, failure/retry, delayed
mode/history changes, queued Enter/arrow wrapping, retained selection during a
live refresh, and highlight delivery after scrolling to row 5,000.

## Follow-up: flashing while typing

The worker implementation retained old results, but disabled their buttons on
each input change. The global disabled style reduced their opacity from 1 to
0.6, and the selected background disappeared until the worker replied. Query
changes also reset a scrolled list before its replacement results arrived.
Both problems reproduced with deliberately held worker replies: the selected
background became transparent and scrollTop changed from 4,800 to zero.

Result rows now retain their brightness and selection background while pending.
Selection and virtual-list scrolling follow the committed query, mode, and
visibility, so the replacement results reset selection and scroll together.
The empty-result message and its actions remain stable during a new search.
Native disabled buttons still prevent obsolete clicks; keyboard intent still
waits for current results. Matching, ranking, and worker scheduling are unchanged.

Browser regressions compare ready/pending list screenshots byte for byte,
including after obsolete worker replies. They also verify retained scroll,
empty-state screenshots when clearing the input, blocked stale clicks, and
selection of the latest results. The full 47-case browser suite and 93 unit tests
passed; all ten performance regressions were rerun on the final build after
refining the empty-state copy. The final popup is `popup-CzIPYnzB.js`.

The comparison uses the previous worker build as baseline, with 36 bursts and
492 trusted keystrokes per build at 60 ms intervals, small/huge data, and closed
history shown/hidden. The first frame showing an input prefix or a newer one,
measured **from DOM input capture**, remained near one frame:

| Dataset | Closed shown | Input-to-frame p95 before ms | After ms |
| ------- | ------------ | ---------------------------: | -------: |
| Small   | No           |                         15.6 |     15.6 |
| Small   | Yes          |                         15.5 |     15.5 |
| Huge    | No           |                         15.7 |     15.4 |
| Huge    | Yes          |                         15.5 |     15.4 |

Both runs recorded zero UI long tasks; maximum frame gaps were 19.6 and 20.8 ms.
Host-to-display timing was noisier: the first after run's huge/history-on
multi-term p95 rose from 17.2 to 54.0 ms alongside up to 94 ms of test-driver
scheduling delay. A separate 18-burst/246-key large-data repeat measured that
case at 17.4 → 18.1 ms, while other repeat cases had host delays. Input-to-frame
p95 stayed between 15.2 and 15.8 ms across repeat groups, with zero UI long tasks.
This suggests host/transport noise rather than a repeatable renderer stall;
these runs do not establish a host-to-display speedup from the visual fix.

All runs, including the noisy samples, are retained under
`test-results/performance/flashing-typing-{before,after}` and their `-repeat`
directories. Ready/pending screenshots are under `test-results/performance/flashing`.
The previous worker build is preserved under `flashing-baseline-build`.
Reproduce the focused run with `perf:typing -- --intervals 60 --repetitions 3`;
the existing raw timestamps support subtracting `acceptedAt` from
`paintOpportunityAt` to separate renderer response from CDP input delivery.

## Measurement limits and reproduction

Runs use Apple M1 Max, macOS (`darwin 27.0.0`), Node 24.5.0, bundled Chromium
153.0.8010.12, headless, 400 × 600 viewport, fixture version 1, and CPU rate 1.
Open-tab enumeration is stubbed while native synthetic history storage and the
production popup execute normally. Timing runs are sequential, separate from
tests and diagnostic CPU/timeline recording.

Input delay is host send time to DOM input capture, including CDP transport and
browser queueing. Display delay ends at the first animation frame showing that
prefix or a newer one; superseded prefixes are recorded. It is a paint-opportunity
proxy, not pixel presentation or field INP. Host timer scheduling jitter is saved
separately. Final settling waits for current-query results and two animation
frames. Main-thread long-task counts exclude worker computation: moving work
off-thread preserves its CPU cost while letting the UI process input.
For throttled comparisons, this runner configures the page's CDP session and
does not verify worker throttling. Do not infer slower-device speedups from
`--cpu-rate` alone; the reported comparison uses unthrottled runs on the same CPU.

Raw baseline and optimized results, per-key samples, CPU profiles, and timelines
are under ignored `test-results/performance/typing-baseline` and `typing-worker`.
The additional UI-interaction run is under `worker-interactions`.
The previous build is preserved locally at `continuous-baseline-build` in that
directory. Reproduce from the extension directory:

```sh
node --experimental-strip-types scripts/profile-typing.mjs \
  --extension-path test-results/performance/continuous-baseline-build \
  --profile --output test-results/performance/typing-baseline-repeat
npm run perf:typing -- --profile --output test-results/performance/typing-worker-repeat
npm run perf:ui -- --scenarios small,huge,open-only \
  --output test-results/performance/worker-interactions-repeat
```

See [the profiling guide](performance.md) for workload controls, or inspect the
separate `typing.trace.json` and `typing.cpuprofile` diagnostic artifacts.
