import { useEffect, useMemo, useRef, useState } from 'react';
import type { TabEntry, SearchMode } from './tabs';
import {
  SearchWorkerClient,
  type SearchSnapshot,
  type RowHighlight,
} from './search-worker-client';

interface SearchState {
  snapshot?: SearchSnapshot;
  entries: TabEntry[];
  highlights: Map<string, RowHighlight>;
  error?: string;
}

export function useTabSearch(
  tabs: TabEntry[],
  query: string,
  mode: SearchMode,
  showClosed: boolean,
  enabled: boolean,
) {
  const snapshot = useMemo(
    () => ({ tabs, query, mode, showClosed }),
    [tabs, query, mode, showClosed],
  );
  const client = useRef<SearchWorkerClient>(undefined);
  const [state, setState] = useState<SearchState>({
    entries: [],
    highlights: new Map(),
  });
  useEffect(() => {
    const worker = new SearchWorkerClient(
      () =>
        new Worker(new URL('./tab-search.worker.ts', import.meta.url), {
          type: 'module',
        }),
      (snapshot, response) => {
        const entries = Array.from(
          response.order,
          (index) => snapshot.tabs[index]!,
        );
        const highlights = new Map(
          response.highlights.map((row) => [entries[row.index]!.key, row]),
        );
        setState({ snapshot, entries, highlights, error: response.error });
      },
      (snapshot, rows) =>
        setState((previous) => {
          if (previous.snapshot !== snapshot) return previous;
          const highlights = new Map(previous.highlights);
          for (const row of rows) {
            const entry = previous.entries[row.index];
            if (entry) highlights.set(entry.key, row);
          }
          return { ...previous, highlights };
        }),
    );
    client.current = worker;
    return () => {
      worker.dispose();
      client.current = undefined;
    };
  }, []);
  useEffect(() => {
    if (enabled) client.current?.search(snapshot);
  }, [snapshot, enabled]);
  // Hide closed rows immediately on a visibility change, even while the next
  // snapshot is loading. Old results can stay visible while typing but cannot
  // be activated until they belong to the current query/data/mode.
  const entries = useMemo(
    () =>
      showClosed
        ? state.entries
        : state.entries.filter((entry) => entry.kind === 'open'),
    [state.entries, showClosed],
  );
  return {
    entries,
    highlights: state.highlights,
    error: state.snapshot === snapshot ? state.error : undefined,
    displayedError: state.error,
    pending: enabled && state.snapshot !== snapshot,
    committed: state.snapshot,
    loadHighlights: (indices: number[]) => client.current?.highlights(indices),
  };
}
