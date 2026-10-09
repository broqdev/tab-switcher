import { createTabSearcher, type TabEntry, type TabSearchResult } from './tabs';
import type {
  RowHighlight,
  SearchWorkerRequest,
  SearchWorkerResponse,
} from './search-worker-client';

const scope = self as unknown as {
  onmessage: (event: MessageEvent<SearchWorkerRequest>) => void;
  postMessage: (
    message: SearchWorkerResponse,
    transfer?: Transferable[],
  ) => void;
};
let search = createTabSearcher([] as TabEntry[]);
let positions = new Map<string, number>();
let results: TabSearchResult[] = [];
let resultId = 0;
function highlights(indices: number[]): RowHighlight[] {
  return indices.flatMap((index) => {
    const result = results[index];
    return result ? [{ index, title: result.title, url: result.url }] : [];
  });
}
scope.onmessage = ({ data }) => {
  if (data.type === 'highlights') {
    if (data.id === resultId)
      scope.postMessage({
        type: 'highlights',
        id: resultId,
        highlights: highlights(data.indices),
      });
    return;
  }
  resultId = data.id;
  try {
    if (data.tabs) {
      search = createTabSearcher(data.tabs);
      positions = new Map(data.tabs.map((tab, index) => [tab.key, index]));
    }
    results = search(data.query, {
      mode: data.mode,
      showClosed: data.showClosed,
    });
    const order = Uint32Array.from(results, (result) =>
      positions.get(result.entry.key)!,
    );
    // Transfer the full ranking as compact indices. Sending every lazy result
    // would evaluate all highlight getters during structured cloning.
    scope.postMessage(
      {
        type: 'results',
        id: data.id,
        order,
        highlights: highlights(
          Array.from({ length: Math.min(50, results.length) }, (_, i) => i),
        ),
      },
      [order.buffer],
    );
  } catch (cause) {
    results = [];
    scope.postMessage({
      type: 'results',
      id: data.id,
      order: new Uint32Array(),
      highlights: [],
      error:
        data.mode === 'regex' && cause instanceof SyntaxError
          ? 'Invalid regular expression.'
          : 'Could not search tabs. Change the search to retry.',
    });
  }
};
