# Search performance improvements

This records the first optimization pass. The subsequent
[continuous-typing investigation](continuous-typing.md) addresses the remaining
main-thread matching stalls with a local worker.

With 200 open tabs and 10,000 visible closed entries, warm popup opening dropped
from 2,056.8 ms to 91.3 ms, typo search from 526.6 ms to 92.5 ms, and clearing
from 1,664.8 ms to 31.2 ms in the local comparison.

## What changed

- Window the 48 px rows with overscan instead of mounting the entire result list.
  The active option stays mounted for `aria-activedescendant`, and each option
  exposes its logical position and total count. Keyboard wrapping, scrolling,
  and clicking still reach every result.
- Reuse sorted records, normalized titles/URLs, decoded URLs, and a lazy Fuse
  index for each immutable tab snapshot. Cache empty-query results.
- Map highlight ranges only when a row reads them. ASCII offsets use a fast path;
  Unicode keeps whole graphemes highlighted and stops mapping after the last match.
- Index identical raw/decoded URL strings once. For multiple AND terms, search
  only records that survived earlier terms while preserving final ranking.
- Read only open tabs while closed entries are hidden. Enabling history loads
  the latest data; request guards ignore stale reads after mode changes.

No additional runtime dependency was added. Matching modes, title/domain ranking,
recency, saved preferences, popup dimensions, and row styling retain their behavior.

## Controlled before/after run

Measured October 8, 2026 on Apple M1 Max, macOS (`darwin 27.0.0`), Node 24.5.0,
bundled Chromium 153.0.8010.12, headless, 400 × 600 viewport, CPU rate 1,
fixture version 1. Runs were sequential with no concurrent test workloads.
Each build completed the same seven dataset/visibility cases and 637 UI samples.

The baseline was rebuilt from revision `cc6159f` with only nonvisual profiling
markers added. Its popup bundle is `popup-D8DBWwlC.js`, matching the initial
baseline bundle. The optimized bundle is `popup-BdtVbF-5.js`. Both were measured
with the updated runner, which checks full lists in the baseline and logical
counts plus mounted subsets in the optimized build.

UI values below are median milliseconds over three repetitions. Response ends
after committed results and two animation frames: a paint-opportunity proxy,
**not INP**. First open has one observation per dataset case.

### 200 open + 10,000 closed, closed entries visible

| Operation                   | Before ms | After ms | After p95 ms | Speedup |
| --------------------------- | --------: | -------: | -----------: | ------: |
| First open                  |   2,548.6 |    131.6 |        131.6 |   19.4× |
| Warm reopen                 |   2,056.8 |     91.3 |         91.8 |   22.5× |
| Broad query `t`             |   1,220.6 |     31.1 |         40.5 |   39.2× |
| Typo `typescrpt`            |     526.6 |     92.5 |         93.5 |    5.7× |
| `typescrpt handbook`        |     526.4 |     94.6 |         95.6 |    5.6× |
| Domain `x.com`              |     204.4 |     24.5 |         24.6 |    8.3× |
| Unicode `cafe`              |     257.2 |     48.6 |         49.9 |    5.3× |
| Unsuccessful query          |     274.3 |     65.7 |         67.1 |    4.2× |
| Clear unsuccessful query    |   1,664.8 |     31.2 |         31.4 |   53.4× |
| ArrowDown with empty search |     188.0 |     23.9 |         24.2 |    7.9× |

The empty-query list still contains all 10,200 logical options. Only 15 rows
were mounted at the initial viewport in the large-list measurements, compared
with 10,200 before. Lists with at most 50 results render fully. The deep-scroll
regressions also check the bounded row count and an always-mounted active option.

Warm opening, broad matching, clearing, and selection produced no observed
50 ms long tasks after optimization. Typo, multi-term, and unsuccessful queries
still produced a long task in each of their three repetitions. These paths
remain synchronous; this change substantially reduces stalls but does not
eliminate them on every query or machine.

### Small datasets and hidden history

| Dataset / operation                                | Before ms | After ms |
| -------------------------------------------------- | --------: | -------: |
| 20 open + 50 closed shown: warm reopen             |      43.3 |     45.6 |
| 20 open + 50 closed shown: typo search             |      26.1 |     26.3 |
| 20 open + 50 closed shown: clear                   |      31.4 |     31.3 |
| 20 open + 50 closed shown: selection               |      24.8 |     26.4 |
| 20 open + 50 closed hidden: warm reopen            |      43.1 |     56.7 |
| 200 open + 1,000 closed shown: warm reopen         |     220.1 |     58.7 |
| 200 open + 1,000 closed shown: typo search         |      58.2 |     25.8 |
| 200 open + 10,000 closed hidden: warm reopen       |     109.1 |     54.8 |
| 200 open, no stored closed history: warm reopen    |      56.3 |     44.6 |
| 200 open + 10,000 closed: enable history, no query |   1,954.6 |     80.0 |

Small-case search/clear/selection remained in the same frame-scale range, with
no observed long tasks. The small hidden-history warm-open median increased
13.6 ms in this three-repetition run. A follow-up with ten repetitions per build
(602 samples each) did not reproduce that median increase: hidden-history warm
opening was 44.3 → 43.6 ms, and visible-history warm opening was 44.0 → 44.3 ms.
Search, clear, and selection medians in both visibility modes differed by at
most 1.3 ms. Hidden-history warm-open p95 varied from 60.1 to 73.1 ms; startup
tails still vary, and ten samples are not a field distribution.

Avoid interpreting every few-millisecond difference as an algorithm improvement.
Hidden-history reads are independently excluded by unit and browser tests,
even though browser storage/background state can still affect overall startup timing.

## Search-only measurements

All 98 computation cases passed the independent result-key oracle. At 200 open
plus 10,000 closed entries shown:

| Query                | One-shot p50 ms | Prepared p50 ms |
| -------------------- | --------------: | --------------: |
| Empty                |            3.25 |           <0.01 |
| `t`                  |           37.86 |           18.29 |
| `typescrpt`          |           96.54 |           79.28 |
| `typescrpt handbook` |          112.57 |          111.85 |
| `x.com`              |           13.84 |            3.24 |
| `cafe`               |           66.33 |           59.85 |
| Unsuccessful         |           99.47 |           78.44 |

The prepared strategy reuses records/indexes across calls, as the popup does
between data refreshes. First-use preparation is excluded from this warmed Node
benchmark and included in UI measurements. Lazy highlight getters are excluded
here and evaluated for mounted UI rows. The original computation baseline eagerly
mapped every highlight, so use the UI comparison above for the complete effect.
Node and browser timings should not be subtracted to estimate rendering time.

## Validation and reproduction

Validation passed type checking, 88 unit tests, all 40 browser integration tests,
and the production build. New browser checks exercise deep scrolling through
10,000 rows, keyboard wrapping, click/Enter reopening, filtered scroll reset,
active-descendant accessibility, stale history reads, and error/retry recovery.
Existing coverage checks fuzzy/exact/regex results, Unicode highlights, ranking,
preferences, and open-tab activation. The diagnostic screenshot retains the
existing popup layout and background highlights.

Raw comparison artifacts are in these ignored local directories:

- `test-results/performance/baseline-rebuilt`: baseline results, full table,
  CPU profile, timeline, screenshot, and preserved `extension-build`.
- `test-results/performance/optimized`: optimized equivalents.
- `test-results/performance/optimized-search`: 98 computation cases and samples.
- `test-results/performance/baseline-small-repeat` and `optimized-small-repeat`:
  the ten-repetition small-data follow-up.

Reproduce from the extension directory:

```sh
node --experimental-strip-types scripts/profile-search.mjs \
  --extension-path test-results/performance/baseline-rebuilt/extension-build \
  --profile --output test-results/performance/baseline-repeat
PERF_OUTPUT=test-results/performance/search-repeat npm run perf:search
npm run perf:ui -- --profile --output test-results/performance/optimized-repeat
```

The preserved build is local and ignored by Git; on another checkout, build
revision `cc6159f` with the profiling markers first. For stronger tail estimates,
increase repetitions and optionally apply CPU throttling as described in
[the profiling guide](performance.md). Default three-sample p95 is generally the
maximum observation. These synthetic measurements cover the real popup/search
and native history storage with stubbed open-tab enumeration; they do not measure
the native toolbar gesture, actual window switching, or field typing latency.

For the small-data follow-up, add `--scenarios small --repetitions 10` to each
UI command and use separate output directories.
