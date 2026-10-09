import { afterAll, expect, test } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTabSearcher, searchTabs } from '../../lib/tabs';
import { expectedKeys, makeFixture, queries, scenarios } from './fixtures';

const output = resolve(
  process.env.PERF_OUTPUT || 'test-results/performance/search',
);
const selected = process.env.PERF_SCENARIOS?.split(',');
if (
  selected?.some(
    (name) => !scenarios.some((scenario) => scenario.name === name),
  )
) {
  throw new Error('Unknown PERF_SCENARIOS dataset');
}
const selectedScenarios = scenarios.filter(
  (item) => !selected || selected.includes(item.name),
);
const expectedCases = selectedScenarios.reduce(
  (sum, scenario) => sum + (scenario.closed ? 2 : 1) * (queries.length + 1) * 2,
  0,
);
const results: Record<string, unknown>[] = [];
let checksum = 0;

for (const scenario of selectedScenarios) {
  const fixture = makeFixture(scenario);
  for (const showClosed of scenario.closed ? [false, true] : [false]) {
    for (const strategy of ['one-shot', 'prepared'] as const) {
      const prepared = createTabSearcher(fixture.entries);
      const search = (query: string) =>
        strategy === 'prepared'
          ? prepared(query, { mode: 'fuzzy', showClosed })
          : searchTabs(fixture.entries, query, { mode: 'fuzzy', showClosed });
      for (const query of [{ name: 'empty', text: '' }, ...queries]) {
        test(`${scenario.name} / closed ${showClosed} / ${strategy} / ${query.name}`, async ({
          bench,
        }) => {
          const actual = search(query.text);
          expect(actual.map(({ entry }) => entry.key).sort()).toEqual(
            expectedKeys(fixture.entries, query.text, showClosed),
          );
          const result = await bench('searchTabs', () => {
            const matches = search(query.text);
            checksum ^= matches.length;
          }).run({
            iterations: 10,
            time: 100,
            warmupIterations: 3,
            warmupTime: 50,
            retainSamples: true,
          });
          const samples = [...(result.latency.samples || [])];
          results.push({
            scenario: scenario.name,
            open: scenario.open,
            closed: scenario.closed,
            showClosed,
            strategy,
            query: query.name,
            text: query.text,
            resultCount: actual.length,
            samplesMs: samples,
            p50Ms: result.latency.p50,
            p95Ms: percentile(samples, 0.95),
            maxMs: result.latency.max,
          });
        }, 60_000);
      }
    }
  }
}

function percentile(values: number[], fraction: number) {
  const sorted = values.toSorted((a, b) => a - b);
  return (
    sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
    ] || 0
  );
}

afterAll(async () => {
  await mkdir(output, { recursive: true });
  await writeFile(
    `${output}/results.json`,
    JSON.stringify(
      {
        environment: {
          node: process.version,
          os: `${platform()} ${release()}`,
          cpu: cpus()[0]?.model,
          git: execFileSync('git', ['rev-parse', 'HEAD'], {
            encoding: 'utf8',
          }).trim(),
          dirty: Boolean(
            execFileSync('git', ['status', '--porcelain'], {
              encoding: 'utf8',
            }).trim(),
          ),
          fixtureVersion: 1,
        },
        metric:
          'Synchronous search return in Node (one-shot or reused preparation); excludes lazy highlight getters, Chrome storage, React, layout and paint.',
        checksum,
        complete: results.length === expectedCases,
        results,
      },
      null,
      2,
    ),
  );
  await writeFile(
    `${output}/report.md`,
    [
      '# Search computation benchmark',
      '',
      'Node timings exclude lazy highlight getters, storage, React, layout and paint. Prepared strategy reuses one snapshot across queries. Compare runs on the same machine.',
      ...(results.length === expectedCases
        ? []
        : ['**INCOMPLETE RUN: some benchmark cases failed.**']),
      '',
      '| Dataset | Closed shown | Strategy | Query | Results | p50 ms | p95 ms | max ms |',
      '| --- | --- | --- | --- | ---: | ---: | ---: | ---: |',
      ...results.map(
        (r) =>
          `| ${r.scenario} | ${r.showClosed} | ${r.strategy} | ${r.query} | ${r.resultCount} | ${Number(r.p50Ms).toFixed(1)} | ${Number(r.p95Ms).toFixed(1)} | ${Number(r.maxMs).toFixed(1)} |`,
      ),
      '',
    ].join('\n'),
  );
  console.log(`Search reports: ${output}`);
});
