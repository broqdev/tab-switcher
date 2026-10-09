import { afterEach, expect, it, vi } from 'vitest';
import {
  SearchWorkerClient,
  type SearchSnapshot,
  type SearchWorkerRequest,
  type SearchWorkerResponse,
} from '../../lib/search-worker-client';
import { searchTabs, type OpenTab } from '../../lib/tabs';

const tab = (index = 0): OpenTab => ({
  kind: 'open',
  key: `open-${index}`,
  id: index,
  windowId: 1,
  index,
  title: `Café TypeScript Handbook ${index}`,
  url: `https://example.org/caf%C3%A9?slot=${index}`,
  lastAccessed: index,
  pinned: false,
  incognito: false,
});
const snapshot = (query: string, tabs = [tab()]): SearchSnapshot => ({
  tabs,
  query,
  mode: 'fuzzy',
  showClosed: true,
});
function fakeWorker() {
  const worker = {
    postMessage: vi.fn<(request: SearchWorkerRequest) => void>(),
    terminate: vi.fn(),
    onmessage: null as Worker['onmessage'],
    onerror: null as Worker['onerror'],
  };
  return {
    worker,
    emit: (data: SearchWorkerResponse) =>
      worker.onmessage?.call(
        worker as unknown as Worker,
        { data } as MessageEvent,
      ),
  };
}
const response = (id: number): SearchWorkerResponse => ({
  type: 'results',
  id,
  order: new Uint32Array([0]),
  highlights: [],
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('keeps only the newest pending query and ignores obsolete results and highlights', () => {
  const { worker, emit } = fakeWorker();
  const results = vi.fn(),
    highlights = vi.fn();
  const client = new SearchWorkerClient(() => worker, results, highlights);
  const first = snapshot('type');
  const latest = { ...first, query: 'typescript' };
  client.search(first);
  client.search({ ...first, query: 'typesc' });
  client.search(latest);
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  emit(response(1));
  expect(results).not.toHaveBeenCalled();
  expect(worker.postMessage).toHaveBeenLastCalledWith({
    type: 'search',
    id: 3,
    query: 'typescript',
    mode: 'fuzzy',
    showClosed: true,
    tabs: undefined,
  });
  emit(response(3));
  expect(results).toHaveBeenCalledExactlyOnceWith(latest, response(3));
  client.highlights([0, 1]);
  client.highlights([0, 1]);
  expect(worker.postMessage).toHaveBeenCalledTimes(3);
  emit({ type: 'highlights', id: 1, highlights: [] });
  expect(highlights).not.toHaveBeenCalled();
  emit({ type: 'highlights', id: 3, highlights: [] });
  expect(highlights).toHaveBeenCalledExactlyOnceWith(latest, []);
});

it('sends changed datasets and mode/visibility together, without accepting a prior snapshot', () => {
  const { worker, emit } = fakeWorker();
  const results = vi.fn();
  const client = new SearchWorkerClient(() => worker, results, vi.fn());
  client.search(snapshot('type'));
  const next = {
    ...snapshot('^Café', [tab(2)]),
    mode: 'regex' as const,
    showClosed: false,
  };
  client.search(next);
  emit(response(1));
  expect(worker.postMessage).toHaveBeenLastCalledWith({
    type: 'search',
    id: 2,
    ...next,
  });
  emit(response(2));
  expect(results).toHaveBeenCalledExactlyOnceWith(next, response(2));
});

it('terminates on unmount and ignores late responses', () => {
  const { worker, emit } = fakeWorker();
  const results = vi.fn();
  const client = new SearchWorkerClient(() => worker, results, vi.fn());
  client.search(snapshot('type'));
  client.dispose();
  emit(response(1));
  client.search(snapshot('later'));
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(worker.postMessage).toHaveBeenCalledOnce();
  expect(results).not.toHaveBeenCalled();
});

it('reports a worker failure for the latest query and recreates the worker on retry', () => {
  const first = fakeWorker(),
    second = fakeWorker();
  const factory = vi
    .fn()
    .mockReturnValueOnce(first.worker)
    .mockReturnValueOnce(second.worker);
  const results = vi.fn();
  const client = new SearchWorkerClient(factory, results, vi.fn());
  const pending = snapshot('typescript');
  client.search(snapshot('type'));
  client.search(pending);
  first.worker.onerror?.call(
    first.worker as unknown as Worker,
    { preventDefault: vi.fn() } as unknown as ErrorEvent,
  );
  expect(results).toHaveBeenLastCalledWith(
    pending,
    expect.objectContaining({
      error: expect.stringContaining('Could not search'),
      id: 2,
    }),
  );
  expect(first.worker.terminate).toHaveBeenCalledOnce();
  client.search(snapshot('retry'));
  second.emit(response(3));
  expect(results).toHaveBeenCalledTimes(2);
  expect(factory).toHaveBeenCalledTimes(2);
});

it('worker ranking and bounded highlights match synchronous search, including offscreen Unicode and invalid regex recovery', async () => {
  const output: SearchWorkerResponse[] = [];
  const port = {
    onmessage: (_event: MessageEvent<SearchWorkerRequest>) => {},
    postMessage: vi.fn((message: SearchWorkerResponse) =>
      output.push(structuredClone(message)),
    ),
  };
  vi.stubGlobal('self', port);
  await import('../../lib/tab-search.worker');
  const tabs = Array.from({ length: 100 }, (_, index) => tab(index));
  let id = 0;
  for (const [query, mode] of [
    ['typescrpt', 'fuzzy'],
    ['cafe', 'exact'],
    ['^Café', 'regex'],
    ['[', 'regex'],
    ['Handbook', 'exact'],
  ] as const) {
    port.onmessage({
      data: { type: 'search', id: ++id, tabs, query, mode, showClosed: true },
    } as MessageEvent<SearchWorkerRequest>);
    const actual = output.at(-1)!;
    expect(actual.type).toBe('results');
    if (actual.type !== 'results') throw new Error('Expected results');
    if (query === '[') {
      expect(actual.error).toBe('Invalid regular expression.');
      continue;
    }
    const expected = searchTabs(tabs, query, { mode });
    expect(Array.from(actual.order, (index) => tabs[index]!.key)).toEqual(
      expected.map((result) => result.entry.key),
    );
    expect(actual.highlights).toHaveLength(50);
    for (const row of actual.highlights)
      expect(row).toEqual({
        index: row.index,
        title: expected[row.index]!.title,
        url: expected[row.index]!.url,
      });
  }
  port.onmessage({
    data: { type: 'highlights', id, indices: [75, 99] },
  } as MessageEvent<SearchWorkerRequest>);
  const actual = output.at(-1)!;
  const expected = searchTabs(tabs, 'Handbook', { mode: 'exact' });
  expect(actual.highlights).toEqual(
    [75, 99].map((index) => ({
      index,
      title: expected[index]!.title,
      url: expected[index]!.url,
    })),
  );
});
