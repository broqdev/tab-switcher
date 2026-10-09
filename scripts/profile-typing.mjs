import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cpus, platform, release } from 'node:os';
import {
  makeFixture,
  expectedKeys,
  scenarios,
} from '../tests/performance/fixtures.ts';
import { installTypingProbe } from './typing-probe.mjs';

const args = process.argv.slice(2);
const option = (flag, fallback) => {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--'))
    throw new Error(`Missing value for ${flag}`);
  return args[index + 1];
};
const allowed = [
  '--extension-path',
  '--output',
  '--scenarios',
  '--intervals',
  '--repetitions',
  '--cpu-rate',
  '--profile',
];
for (const arg of args.filter((x) => x.startsWith('--')))
  if (!allowed.includes(arg)) throw new Error(`Unknown argument ${arg}`);
const extension = resolve(option('--extension-path', '.output/chrome-mv3'));
const output = resolve(
  option('--output', `test-results/performance/typing-${Date.now()}`),
);
const names = option('--scenarios', 'small,huge').split(',');
const intervals = option('--intervals', '60,120').split(',').map(Number);
const repetitions = Number(option('--repetitions', '3'));
const cpuRate = Number(option('--cpu-rate', '1'));
if (
  names.some((name) => !scenarios.some((s) => s.name === name)) ||
  intervals.some((n) => !Number.isFinite(n) || n < 10) ||
  !Number.isInteger(repetitions) ||
  repetitions < 1 ||
  repetitions > 30 ||
  !Number.isFinite(cpuRate) ||
  cpuRate < 1
)
  throw new Error('Invalid profiling options');
await mkdir(output, { recursive: true });
const environment = {
  cpu: cpus()[0]?.model,
  os: `${platform()} ${release()}`,
  node: process.version,
  popupHtml: await readFile(`${extension}/popup.html`, 'utf8'),
  intervals,
  repetitions,
  cpuRate,
  fixtureVersion: 1,
  viewport: { width: 400, height: 600 },
};
const workloads = [
  {
    name: 'multi-term',
    keys: [...'typescrpt handbook'],
    query: 'typescrpt handbook',
  },
  { name: 'no-match', keys: [...'qzxwvqzxwv'], query: 'qzxwvqzxwv' },
  {
    name: 'edit',
    keys: [...'typescrpt', 'Backspace', 'Backspace', 'p', 't'],
    query: 'typescrpt',
  },
];
const samples = [];
const percentile = (values, fraction) =>
  values.toSorted((a, b) => a - b)[
    Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)
  ] ?? 0;

async function burst(page, cdp, workload, interval) {
  const search = page.getByRole('combobox');
  await search.fill('');
  await expect(page.locator('.search-results')).toHaveAttribute(
    'data-search-query',
    '',
  );
  await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
  await search.focus();
  const startAt = Date.now() + 150;
  await page.evaluate((settings) => window.__typingPerf.arm(settings), {
    startAt,
    count: workload.keys.length,
    query: workload.query,
  });
  const sent = await Promise.all(
    workload.keys.map(
      (key, index) =>
        new Promise((resolve, reject) => {
          const intendedAt = startAt + index * interval;
          // Timers run in Node, outside the renderer. Dispatch every key on schedule
          // without awaiting the preceding key, render, or result.
          setTimeout(
            () => {
              const sentAt = Date.now();
              const isBackspace = key === 'Backspace';
              const down = cdp.send('Input.dispatchKeyEvent', {
                type: 'keyDown',
                key,
                timestamp: sentAt / 1000,
                ...(isBackspace
                  ? { code: 'Backspace', windowsVirtualKeyCode: 8 }
                  : { text: key, unmodifiedText: key }),
              });
              const up = cdp.send('Input.dispatchKeyEvent', {
                type: 'keyUp',
                key,
                timestamp: sentAt / 1000,
              });
              Promise.all([down, up]).then(
                () => resolve({ key, intendedAt, sentAt }),
                reject,
              );
            },
            Math.max(0, intendedAt - Date.now()),
          );
        }),
    ),
  );
  await page.waitForFunction(() => window.__typingPerf.result, undefined, {
    timeout: 120_000,
  });
  const result = await page.evaluate(() => window.__typingPerf.result);
  expect(result.inputs).toHaveLength(workload.keys.length);
  let prefix = '';
  const keys = sent.map((send, index) => {
    prefix = send.key === 'Backspace' ? prefix.slice(0, -1) : prefix + send.key;
    const input = result.inputs[index];
    expect(input.value).toBe(prefix);
    expect(input.trusted).toBe(true);
    const frame = result.frames.find((frame) => frame.inputIndex >= index);
    expect(frame).toBeDefined();
    return {
      ...send,
      query: prefix,
      acceptedAt: input.at,
      paintOpportunityAt: frame.at,
      supersededBeforeFrame: frame.inputIndex !== index,
      inputDelayMs: Math.max(0, input.at - send.sentAt),
      displayDelayMs: Math.max(0, frame.at - send.sentAt),
      schedulingDelayMs: send.sentAt - send.intendedAt,
    };
  });
  await expect(search).toHaveValue(workload.query);
  await expect(page.locator('.search-results')).toHaveAttribute(
    'data-search-query',
    workload.query,
  );
  return {
    keys,
    ...result,
    inputP95Ms: percentile(
      keys.map((k) => k.inputDelayMs),
      0.95,
    ),
    displayP95Ms: percentile(
      keys.map((k) => k.displayDelayMs),
      0.95,
    ),
    maxInputMs: Math.max(...keys.map((k) => k.inputDelayMs)),
    maxDisplayMs: Math.max(...keys.map((k) => k.displayDelayMs)),
    finalSettleMs: result.settledAt - sent.at(-1).sentAt,
  };
}

async function runCase(scenario, showClosed) {
  const fixture = makeFixture(scenario);
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: environment.viewport,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  try {
    const background =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent('serviceworker'));
    await expect
      .poll(() =>
        background.evaluate(async () =>
          Boolean(
            (await chrome.storage.session.get('tabHistorySession'))
              .tabHistorySession,
          ),
        ),
      )
      .toBe(true);
    await background.evaluate(
      ({ closed, showClosed }) =>
        chrome.storage.local.set({
          closedTabHistory: closed,
          showClosedTabs: showClosed,
          searchMode: 'fuzzy',
        }),
      { closed: fixture.closed, showClosed },
    );
    const page = context.pages()[0];
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ tabs }) => {
        chrome.tabs.query = async () => structuredClone(tabs);
        chrome.windows.getLastFocused = async () => ({ id: 1, focused: true });
      },
      { tabs: fixture.nativeTabs },
    );
    await page.addInitScript(installTypingProbe);
    const cdp = await context.newCDPSession(page);
    environment.chromium = (await cdp.send('Browser.getVersion')).product;
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
    await page.goto(`${background.url().replace(/\/[^/]*$/, '')}/popup.html`);
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
    for (const interval of intervals) {
      for (let repetition = 1; repetition <= repetitions; repetition++) {
        console.log(
          `Typing ${scenario.name}/closed-${showClosed}/${interval}ms ${repetition}/${repetitions}`,
        );
        for (const workload of workloads) {
          const result = await burst(page, cdp, workload, interval);
          const expected = expectedKeys(
            fixture.entries,
            workload.query,
            showClosed,
          );
          await expect(page.locator('.search-results')).toHaveAttribute(
            'data-result-count',
            String(expected.length),
          );
          const mounted = await page
            .getByRole('option')
            .evaluateAll((rows) => rows.map((row) => row.dataset.entryKey));
          expect(mounted.every((key) => expected.includes(key))).toBe(true);
          expect(mounted.length).toBeLessThanOrEqual(50);
          if (expected.length <= 50)
            expect(mounted.toSorted()).toEqual(expected);
          samples.push({
            scenario: scenario.name,
            showClosed,
            interval,
            repetition,
            workload: workload.name,
            ...result,
          });
        }
      }
    }
    if (args.includes('--profile') && scenario.name === 'huge' && showClosed) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
      await cdp.send('Tracing.start', {
        categories:
          'devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline',
        transferMode: 'ReturnAsStream',
      });
      await burst(page, cdp, workloads[0], intervals[0]);
      const finished = new Promise((resolve) =>
        cdp.once('Tracing.tracingComplete', resolve),
      );
      await cdp.send('Tracing.end');
      const { profile } = await cdp.send('Profiler.stop');
      const { stream } = await finished;
      let trace = '',
        chunk;
      do {
        chunk = await cdp.send('IO.read', { handle: stream });
        trace += chunk.base64Encoded
          ? Buffer.from(chunk.data, 'base64').toString()
          : chunk.data;
      } while (!chunk.eof);
      await cdp.send('IO.close', { handle: stream });
      await writeFile(`${output}/typing.cpuprofile`, JSON.stringify(profile));
      await writeFile(`${output}/typing.trace.json`, trace);
    }
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}

async function save(error) {
  const summary = [
    ...Map.groupBy(
      samples,
      (s) => `${s.scenario}/${s.showClosed}/${s.interval}/${s.workload}`,
    ).values(),
  ].map((group) => ({
    scenario: group[0].scenario,
    showClosed: group[0].showClosed,
    interval: group[0].interval,
    workload: group[0].workload,
    repetitions: group.length,
    inputP95Ms: percentile(
      group.flatMap((s) => s.keys.map((k) => k.inputDelayMs)),
      0.95,
    ),
    displayP95Ms: percentile(
      group.flatMap((s) => s.keys.map((k) => k.displayDelayMs)),
      0.95,
    ),
    maxDisplayMs: Math.max(...group.map((s) => s.maxDisplayMs)),
    settleP50Ms: percentile(
      group.map((s) => s.finalSettleMs),
      0.5,
    ),
    maxFrameGapMs: Math.max(...group.flatMap((s) => s.frameGapsMs)),
    longTasks: group.reduce((n, s) => n + s.longTasks.length, 0),
    superseded: group.reduce(
      (n, s) => n + s.keys.filter((k) => k.supersededBeforeFrame).length,
      0,
    ),
    maxSchedulerDelayMs: Math.max(
      ...group.flatMap((s) => s.keys.map((k) => k.schedulingDelayMs)),
    ),
  }));
  await writeFile(
    `${output}/results.json`,
    JSON.stringify(
      { environment, complete: !error, error, summary, samples },
      null,
      2,
    ),
  );
  await writeFile(
    `${output}/report.md`,
    [
      '# Continuous typing profile',
      '',
      'Keys are sent at fixed host deadlines without waiting for rendering. Input delay includes CDP transport and browser queueing; display is the first animation frame showing this prefix or a newer one. These are local lab proxies, not INP or pixel-presentation timing. Final settle waits for current-query results and two animation frames. Superseded prefixes are recorded explicitly.',
      '',
      ...(error ? [`INCOMPLETE: ${error}`, ''] : []),
      '| Dataset | Closed shown | Interval ms | Workload | n | Input p95 ms | Display p95 ms | Max display ms | Final settle p50 ms | Max frame gap ms | Long tasks | Superseded keys | Host timer max delay ms |',
      '| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...summary.map(
        (s) =>
          `| ${s.scenario} | ${s.showClosed} | ${s.interval} | ${s.workload} | ${s.repetitions} | ${s.inputP95Ms.toFixed(1)} | ${s.displayP95Ms.toFixed(1)} | ${s.maxDisplayMs.toFixed(1)} | ${s.settleP50Ms.toFixed(1)} | ${s.maxFrameGapMs.toFixed(1)} | ${s.longTasks} | ${s.superseded} | ${s.maxSchedulerDelayMs.toFixed(1)} |`,
      ),
      '',
    ].join('\n'),
  );
  console.log(`Typing reports: ${output}`);
}
try {
  for (const scenario of scenarios.filter((s) => names.includes(s.name))) {
    for (const visible of scenario.closed ? [false, true] : [false])
      await runCase(scenario, visible);
    await save('Remaining cases not completed');
  }
  await save();
} catch (error) {
  await save(error.stack || String(error));
  throw error;
}
