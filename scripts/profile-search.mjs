import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  expectedKeys,
  makeFixture,
  queries,
  scenarios,
} from '../tests/performance/fixtures.ts';
import { installPerformanceProbe } from './performance-probe.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--'))
    throw new Error(`Missing value for ${flag}`);
  return args[index + 1];
};
const allowed = [
  '--scenarios',
  '--repetitions',
  '--cpu-rate',
  '--output',
  '--profile',
  '--headed',
  '--extension-path',
];
for (const arg of args.filter((arg) => arg.startsWith('--'))) {
  if (!allowed.includes(arg)) throw new Error(`Unknown argument ${arg}`);
}
const names = value('--scenarios', 'small,medium,huge,open-only').split(',');
if (names.some((name) => !scenarios.some((scenario) => scenario.name === name)))
  throw new Error('Unknown scenario');
const repetitions = Number(value('--repetitions', '3'));
const cpuRate = Number(value('--cpu-rate', '1'));
if (
  !Number.isInteger(repetitions) ||
  repetitions < 1 ||
  repetitions > 30 ||
  !Number.isFinite(cpuRate) ||
  cpuRate < 1
)
  throw new Error('Invalid repetitions or CPU rate');
const output = resolve(
  value(
    '--output',
    `test-results/performance/ui-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`,
  ),
);
await mkdir(output, { recursive: true });
const extensionPath = resolve(value('--extension-path', '.output/chrome-mv3'));
const samples = [];
const cases = [];
const environment = {
  extensionPath,
  popupHtml: await readFile(`${extensionPath}/popup.html`, 'utf8'),
  node: process.version,
  os: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model,
  headless: !args.includes('--headed'),
  cpuRate,
  repetitions,
  git: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: Boolean(
    execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  ),
  fixtureVersion: 1,
  viewport: { width: 400, height: 600 },
};
const percentile = (values, fraction) =>
  values.toSorted((a, b) => a - b)[
    Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)
  ] || 0;
const metricMap = (result) =>
  Object.fromEntries(result.metrics.map(({ name, value }) => [name, value]));

async function readResult(page) {
  await page.waitForFunction(
    () => window.__tabSwitcherPerf?.result,
    undefined,
    { timeout: 120_000 },
  );
  return page.evaluate(() => window.__tabSwitcherPerf.result);
}

async function validate(page, fixture, query, showClosed) {
  const state = await page.evaluate(() => ({
    keys: [...document.querySelectorAll('[role="option"]')]
      .map((row) => row.dataset.entryKey)
      .sort(),
    query: document.querySelector('.search-results').dataset.searchQuery,
    mode: document.querySelector('.search-results').dataset.searchMode,
    showClosed: document.querySelector('.search-results').dataset.showClosed,
    count: Number(
      document.querySelector('.search-results').dataset.resultCount ??
        document.querySelectorAll('[role="option"]').length,
    ),
    windowed: document
      .querySelector('[role="listbox"]')
      .classList.contains('virtual-list'),
    sizes: [...document.querySelectorAll('[role="option"]')].map((row) =>
      Number(row.getAttribute('aria-setsize')),
    ),
    activeExists: Boolean(
      document.getElementById(
        document
          .querySelector('[role="combobox"]')
          .getAttribute('aria-activedescendant'),
      ),
    ),
  }));
  expect(state.query).toBe(query);
  expect(state.mode).toBe('fuzzy');
  expect(state.showClosed).toBe(String(showClosed));
  // Search benchmarks check all logical keys. The windowed UI verifies the full
  // count, every mounted key, and that the active descendant remains mounted.
  if (!query || queries.some((item) => item.text === query)) {
    const expected = expectedKeys(fixture.entries, query, showClosed);
    expect(state.count).toBe(expected.length);
    const expectedSet = new Set(expected);
    expect(state.keys.every((key) => expectedSet.has(key))).toBe(true);
    if (!state.windowed || expected.length <= 50)
      expect(state.keys).toEqual(expected);
  }
  if (state.windowed) {
    expect(state.keys.length).toBeLessThanOrEqual(50);
    expect(state.sizes.every((size) => size === state.count)).toBe(true);
  }
  expect(state.activeExists).toBe(state.count > 0);
  if (!showClosed)
    expect(state.keys.every((key) => key.startsWith('open-'))).toBe(true);
  return { rows: state.count, mountedRows: state.keys.length };
}

async function runCase(scenario, showClosed) {
  const fixture = makeFixture(scenario);
  const label = `${scenario.name}/closed-${showClosed}`;
  console.log(
    `Profiling ${label} (${scenario.open} open, ${scenario.closed} stored closed)`,
  );
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: environment.headless,
    viewport: environment.viewport,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  try {
    environment.chromium = context.browser()?.version();
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent('serviceworker'));
    // Background initialization writes history. Wait for its final session write
    // before seeding so it cannot replace our fixture with its empty history.
    await expect
      .poll(
        () =>
          worker.evaluate(async () =>
            Boolean(
              (await chrome.storage.session.get('tabHistorySession'))
                .tabHistorySession,
            ),
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await worker.evaluate(
      async ({ closed, showClosed }) => {
        await chrome.storage.local.set({
          closedTabHistory: closed,
          searchMode: 'fuzzy',
          showClosedTabs: showClosed,
        });
      },
      { closed: fixture.closed, showClosed },
    );
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(120_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ tabs }) => {
        // Keep native storage/session APIs. Only tab enumeration is synthetic;
        // opening thousands of real tabs would contaminate this UI measurement.
        chrome.tabs.query = async () => structuredClone(tabs);
        chrome.windows.getLastFocused = async () => ({ id: 1, focused: true });
      },
      { tabs: fixture.nativeTabs },
    );
    await page.addInitScript(installPerformanceProbe);
    const cdp = await context.newCDPSession(page);
    environment.chromium = (await cdp.send('Browser.getVersion')).product;
    await cdp.send('Performance.enable');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
    const url = `${worker.url().replace(/\/[^/]*$/, '')}/popup.html`;
    const addSample = async (
      operation,
      repetition,
      result,
      query,
      visibleClosed,
      before,
    ) => {
      const after = metricMap(await cdp.send('Performance.getMetrics'));
      const rowCounts = await validate(page, fixture, query, visibleClosed);
      const dom = await cdp.send('Memory.getDOMCounters');
      samples.push({
        scenario: scenario.name,
        open: scenario.open,
        closed: scenario.closed,
        initialShowClosed: showClosed,
        showClosed: visibleClosed,
        operation,
        repetition,
        query,
        ...rowCounts,
        ...result,
        heapUsedBytes: after.JSHeapUsedSize,
        domNodes: dom.nodes,
        scriptMs: before
          ? (after.ScriptDuration - before.ScriptDuration) * 1_000
          : undefined,
        layoutMs: before
          ? (after.LayoutDuration - before.LayoutDuration) * 1_000
          : undefined,
        styleMs: before
          ? (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1_000
          : undefined,
      });
    };
    const navigate = async (operation, repetition) => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const result = await readResult(page);
      await addSample(operation, repetition, result, '', showClosed);
    };
    await navigate('first-open', 0);
    const perform = async (operation, repetition, action, trigger) => {
      const before = metricMap(await cdp.send('Performance.getMetrics'));
      await page.evaluate((action) => window.__tabSwitcherPerf.arm(action), {
        name: operation,
        ...action,
      });
      await trigger();
      const result = await readResult(page);
      await addSample(
        operation,
        repetition,
        result,
        action.query,
        action.showClosed,
        before,
      );
    };
    const search = page.getByRole('combobox');
    const closedToggle = page.getByRole('checkbox', {
      name: 'Show closed tabs',
    });
    const paste = (query, repetition, name) =>
      perform(name, repetition, { kind: 'query', query, showClosed }, () =>
        search.fill(query),
      );
    const clear = (repetition, source) =>
      perform(
        `clear:${source}`,
        repetition,
        { kind: 'query', query: '', showClosed },
        () => page.getByLabel('Clear search', { exact: true }).click(),
      );

    // First-open is reported separately. Reopens and interactions use warm assets.
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      console.log(`  ${label}: repetition ${repetition}/${repetitions}`);
      await navigate('reopen', repetition);
      for (const query of queries) {
        await paste(query.text, repetition, `paste:${query.name}`);
        await clear(repetition, query.name);
      }
      let prefix = '';
      await search.focus();
      for (const character of 'typescrpt') {
        prefix += character;
        await perform(
          `type:${prefix}`,
          repetition,
          { kind: 'query', query: prefix, showClosed },
          () => search.press(character),
        );
      }
      await clear(repetition, 'typing');
      await perform(
        'arrow-down:empty',
        repetition,
        { kind: 'selection', query: '', showClosed },
        () => search.press('ArrowDown'),
      );
      for (const visibleClosed of [!showClosed, showClosed]) {
        await perform(
          `toggle:empty:${visibleClosed}`,
          repetition,
          { kind: 'toggle', query: '', showClosed: visibleClosed },
          () => closedToggle.click(),
        );
        await expect(closedToggle).toBeEnabled();
      }
      await paste('typescrpt', repetition, 'paste:before-toggle');
      for (const visibleClosed of [!showClosed, showClosed]) {
        await perform(
          `toggle:typo:${visibleClosed}`,
          repetition,
          { kind: 'toggle', query: 'typescrpt', showClosed: visibleClosed },
          () => closedToggle.click(),
        );
        await expect(closedToggle).toBeEnabled();
      }
      await clear(repetition, 'toggle');
    }
    expect(errors).toEqual([]);
    cases.push({
      scenario: scenario.name,
      showClosed,
      errors,
      supportedEntries: await page.evaluate(
        () => window.__tabSwitcherPerf.supported,
      ),
    });
    if (args.includes('--profile') && scenario.name === 'huge' && showClosed) {
      // Separate pass: tracing/profiling overhead must not affect timing samples.
      console.log(
        'Recording separate huge-history diagnostic CPU and timeline profiles',
      );
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
      await cdp.send('Tracing.start', {
        categories:
          'devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline',
        transferMode: 'ReturnAsStream',
      });
      const diagnostic = async (name, action) => {
        await page.evaluate((name) => performance.mark(`${name}:start`), name);
        await action();
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        await page.evaluate((name) => {
          performance.mark(`${name}:end`);
          performance.measure(name, `${name}:start`, `${name}:end`);
        }, name);
      };
      await diagnostic('profile:multi-term', () =>
        search.fill('typescrpt handbook'),
      );
      await page.screenshot({ path: `${output}/huge-search.png` });
      await diagnostic('profile:clear', () => search.fill(''));
      await diagnostic('profile:selection', () => search.press('ArrowDown'));
      const complete = new Promise((resolve) =>
        cdp.once('Tracing.tracingComplete', resolve),
      );
      await cdp.send('Tracing.end');
      const { profile } = await cdp.send('Profiler.stop');
      const { stream } = await complete;
      let trace = '';
      let chunk;
      do {
        chunk = await cdp.send('IO.read', { handle: stream });
        trace += chunk.base64Encoded
          ? Buffer.from(chunk.data, 'base64').toString()
          : chunk.data;
      } while (!chunk.eof);
      await cdp.send('IO.close', { handle: stream });
      await writeFile(`${output}/huge.cpuprofile`, JSON.stringify(profile));
      await writeFile(`${output}/huge.trace.json`, trace);
    }
  } finally {
    await context.close();
  }
}

async function saveReport(error) {
  const groups = Map.groupBy(
    samples,
    (sample) =>
      `${sample.scenario}|${sample.initialShowClosed}|${sample.operation}`,
  );
  const summary = [...groups.values()].map((group) => ({
    scenario: group[0].scenario,
    showClosed: group[0].initialShowClosed,
    operation: group[0].operation,
    count: group.length,
    rows: group.at(-1).rows,
    p50Ms: percentile(
      group.map((s) => s.responseMs),
      0.5,
    ),
    p95Ms: percentile(
      group.map((s) => s.responseMs),
      0.95,
    ),
    maxMs: Math.max(...group.map((s) => s.responseMs)),
    commitP50Ms: percentile(
      group.map((s) => s.commitMs),
      0.5,
    ),
    longTasks: group.reduce((sum, s) => sum + s.longTasks.length, 0),
    maxFrameGapMs: Math.max(0, ...group.flatMap((s) => s.frameGapsMs)),
    heapMiB: percentile(
      group.map((s) => s.heapUsedBytes / 1_048_576),
      0.5,
    ),
    domNodes: percentile(
      group.map((s) => s.domNodes),
      0.5,
    ),
  }));
  await writeFile(
    `${output}/results.json`,
    JSON.stringify(
      { environment, complete: !error, error, cases, summary, samples },
      null,
      2,
    ),
  );
  await writeFile(
    `${output}/report.md`,
    [
      '# Popup performance profile',
      '',
      `- Environment: ${environment.cpu}; Chromium ${environment.chromium}; CPU throttle ${cpuRate}×; ${environment.headless ? 'headless' : 'headed'}.`,
      `- Revision: ${environment.git}${environment.dirty ? ' + local changes' : ''}.`,
      '- Response = DOM event capture → committed results → two animation frames. This is a lab paint-opportunity proxy, **not INP**. Startup begins at navigation time origin.',
      '- Toggle commit/response measurements also wait for preference saving to re-enable the checkbox.',
      '- Completed queries verify logical result counts and every mounted key; computation benchmarks verify all logical keys. Prefix typing verifies committed query and hidden-history exclusion. Mounted rows and active-descendant presence are checked.',
      '- First-open is one observation. Warm reopen/interaction percentiles have small sample counts; p95 is descriptive, not a field estimate.',
      '- Heap and DOM counters include detached objects awaiting GC; no forced GC. Long-task entries can overlap operations. Profiling runs separately.',
      ...(error ? [`- **INCOMPLETE RUN:** ${error}`] : []),
      '',
      '| Dataset | Initially closed shown | Operation | n | Rows | response p50 ms | p95 ms | commit p50 ms | Long tasks | max frame gap ms | heap MiB | DOM nodes |',
      '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...summary.map(
        (s) =>
          `| ${s.scenario} | ${s.showClosed} | ${s.operation} | ${s.count} | ${s.rows} | ${s.p50Ms.toFixed(1)} | ${s.p95Ms.toFixed(1)} | ${s.commitP50Ms.toFixed(1)} | ${s.longTasks} | ${s.maxFrameGapMs.toFixed(1)} | ${s.heapMiB.toFixed(1)} | ${s.domNodes} |`,
      ),
      '',
    ].join('\n'),
  );
  console.log(`Popup reports: ${output}`);
}

try {
  for (const scenario of scenarios.filter((item) =>
    names.includes(item.name),
  )) {
    for (const showClosed of scenario.closed ? [false, true] : [false])
      await runCase(scenario, showClosed);
    await saveReport('Run in progress; remaining datasets have not completed.');
  }
  await saveReport();
} catch (error) {
  await saveReport(error.stack || String(error));
  throw error;
}
