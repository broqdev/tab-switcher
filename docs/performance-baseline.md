# Initial performance baseline

This records the first run before optimization. Its raw profiles were cleared
by Playwright's former shared output directory. The comparison in
[performance improvements](performance-improvements.md) uses a fresh baseline
rebuilt from the same revision and measured with the same runner as the optimized
build. Browser test output now has a separate directory to preserve profiles.

Measured October 8, 2026 with fixture version 1 on Apple M1 Max, macOS
(`darwin 27.0.0`), Node 24.5.0, bundled Chromium 153.0.8010.12, headless,
400 × 600 viewport, no CPU throttling. Revision `cc6159f` plus the profiling
harness and nonvisual commit markers; search/rendering behavior is unchanged.

The completed run verified 49 computation cases and 637 UI samples across
seven dataset/visibility cases. Type checking, all 85 unit tests, production
build, and formatting also passed. These are local synthetic measurements,
not a field performance estimate or a universal capacity limit.

## UI results

Median milliseconds over three repetitions. “Search” pastes `typescrpt`;
“Clear” clears an unsuccessful query and recreates the full list. “Selection”
presses ArrowDown on the empty search. UI response ends after committed results
and two animation frames; it is a paint-opportunity proxy, not INP.

| Open | Stored closed | Closed shown | Warm reopen | Search |   Clear | Selection |
| ---: | ------------: | :----------: | ----------: | -----: | ------: | --------: |
|   20 |            50 |      No      |        42.9 |   26.6 |    31.0 |      26.7 |
|   20 |            50 |     Yes      |        44.1 |   26.5 |    31.1 |      26.5 |
|  200 |         1,000 |      No      |        63.3 |   23.7 |    30.5 |      24.6 |
|  200 |         1,000 |     Yes      |       234.5 |   59.5 |   116.2 |      19.3 |
|  200 |        10,000 |      No      |       102.3 |   23.7 |    31.2 |      23.8 |
|  200 |        10,000 |     Yes      |     1,951.5 |  471.3 | 1,169.8 |     168.4 |
|  200 |             0 |      No      |        61.3 |   24.5 |    31.1 |      18.6 |

With 10,000 closed entries shown, search response p95 was 518.2 ms, clear
p95 was 1,213.7 ms, and selection p95 was 170.2 ms. Each operation produced
a long task in all three repetitions. With only three samples, p95 is simply
the largest observation and should not be treated as a reliable tail estimate.

The broad `t` query matched all 10,200 entries and took 1,146.5 ms median.
An unsuccessful query rendered zero entries but still took 214.6 ms median.

## Search computation

Node `searchTabs()` measurements exclude Chrome storage and UI rendering.
At 200 open plus 10,000 closed entries, with closed entries shown:

| Query                | Results | p50 ms | p95 ms |
| -------------------- | ------: | -----: | -----: |
| Empty                |  10,200 |    4.1 |    4.3 |
| `t`                  |  10,200 |  233.4 |  261.9 |
| `typescrpt`          |   2,550 |  156.5 |  162.6 |
| `typescrpt handbook` |   1,275 |  236.4 |  249.4 |
| `x.com`              |   1,275 |   29.9 |   31.0 |
| `cafe`               |   1,275 |   93.0 |   98.6 |
| Unsuccessful         |       0 |  110.0 |  115.1 |

Hiding closed entries reduced `typescrpt` computation to 2.9 ms median,
close to the 2.8 ms open-only control. Node and browser measurements use
different execution environments; do not subtract one from the other to
derive an exact rendering cost.

## Findings and next experiments

1. **Full-list rendering is expensive.** Clearing takes about 1.17 seconds
   even though empty-query computation takes only 4.1 ms in Node. Keyboard
   selection also stalls despite reusing the memoized search results. The
   current popup maps every result to a React row and rerenders the list for
   selection changes. Test windowing the list and limiting selection updates
   to affected rows first; preserve keyboard navigation and scrolling behavior.
2. **Search preparation and matching also block.** The current implementation
   normalizes records and creates a Fuse index on every fuzzy query. Even a
   zero-result search performs substantial work. Test cached prepared records
   and an index tied to the dataset, then compare the unsuccessful, typo, and
   multi-term cases. Deferring work can improve responsiveness but does not
   remove the computation cost.
3. **Hidden history still affects startup.** With the same 200 open tabs,
   warm reopen increased from 61.3 ms without history to 102.3 ms with 10,000
   hidden closed entries, while search response stayed near 24 ms. Source
   inspection confirms that popup loading reads, validates, and merges all
   history before the visibility filter. Test loading open entries first and
   delaying closed-history preparation until needed.

The separate diagnostic profile contains Fuse `searchIn`, DOM `setAttribute`
and `removeChild`, and garbage collection. Its named `profile:multi-term`,
`profile:clear`, and `profile:selection` timeline spans help separate these
paths. It also includes automation work; total sampled CPU time should not
be attributed entirely to the application.

Reproduce the measurements with:

```sh
npm run perf:search
npm run perf:ui -- --profile --output test-results/performance/baseline
```

Raw JSON, full tables, Chrome trace, CPU profile, and a popup screenshot are
generated under `test-results/performance/`, which is intentionally ignored
by Git. See [the profiling guide](performance.md) for controls, metric
definitions, limitations, and longer comparison runs.
