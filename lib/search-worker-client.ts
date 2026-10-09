import type { TabEntry, SearchMode } from './tabs';
import type { MatchedText } from './search-text';

export interface SearchSnapshot {
  tabs: TabEntry[];
  query: string;
  mode: SearchMode;
  showClosed: boolean;
}
export interface RowHighlight {
  index: number;
  title: MatchedText;
  url: MatchedText;
}
export type SearchWorkerRequest =
  | {
      type: 'search';
      id: number;
      tabs?: TabEntry[];
      query: string;
      mode: SearchMode;
      showClosed: boolean;
    }
  | { type: 'highlights'; id: number; indices: number[] };
export type SearchWorkerResponse =
  | {
      type: 'results';
      id: number;
      order: Uint32Array;
      highlights: RowHighlight[];
      error?: string;
    }
  | { type: 'highlights'; id: number; highlights: RowHighlight[] };
type WorkerPort = Pick<
  Worker,
  'postMessage' | 'terminate' | 'onmessage' | 'onerror'
>;
type Job = { id: number; snapshot: SearchSnapshot };

// One active search and one replaceable pending job keep obsolete prefixes from
// building an unbounded worker queue. Snapshot identity also guards tab refreshes.
export class SearchWorkerClient {
  private worker?: WorkerPort;
  private nextId = 0;
  private latest?: Job;
  private active?: Job;
  private displayed?: Job;
  private sentTabs?: TabEntry[];
  private requestedHighlights = new Set<number>();
  private disposed = false;

  constructor(
    private createWorker: () => WorkerPort,
    private onResults: (
      snapshot: SearchSnapshot,
      response: Extract<SearchWorkerResponse, { type: 'results' }>,
    ) => void,
    private onHighlights: (
      snapshot: SearchSnapshot,
      highlights: RowHighlight[],
    ) => void,
  ) {}

  search(snapshot: SearchSnapshot) {
    if (this.disposed) return;
    this.latest = { id: ++this.nextId, snapshot };
    this.startNext();
  }

  highlights(indices: number[]) {
    if (
      !this.displayed ||
      this.displayed.id !== this.latest?.id ||
      !this.worker
    )
      return;
    const missing = indices.filter(
      (index) => !this.requestedHighlights.has(index),
    );
    if (!missing.length) return;
    missing.forEach((index) => this.requestedHighlights.add(index));
    this.worker.postMessage({
      type: 'highlights',
      id: this.displayed.id,
      indices: missing,
    } satisfies SearchWorkerRequest);
  }

  dispose() {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = undefined;
  }

  private fail() {
    const latest = this.latest;
    this.worker?.terminate();
    this.worker = undefined;
    this.sentTabs = undefined;
    this.active = undefined;
    this.displayed = undefined;
    if (!this.disposed && latest)
      this.onResults(latest.snapshot, {
        type: 'results',
        id: latest.id,
        order: new Uint32Array(),
        highlights: [],
        error: 'Could not search tabs. Change the search to retry.',
      });
  }

  private startNext() {
    if (
      this.disposed ||
      this.active ||
      !this.latest ||
      this.displayed?.id === this.latest.id
    )
      return;
    try {
      if (!this.worker) {
        const worker = this.createWorker();
        this.worker = worker;
        worker.onmessage = (event: MessageEvent<SearchWorkerResponse>) => {
          if (this.disposed || this.worker !== worker) return;
          const response = event.data;
          if (response.type === 'highlights') {
            if (
              response.id === this.displayed?.id &&
              response.id === this.latest?.id
            )
              this.onHighlights(this.displayed.snapshot, response.highlights);
            return;
          }
          if (response.id !== this.active?.id) return;
          const active = this.active;
          this.active = undefined;
          if (response.id === this.latest?.id) {
            this.displayed = active;
            this.requestedHighlights = new Set(
              response.highlights.map((row) => row.index),
            );
            this.onResults(active.snapshot, response);
          }
          this.startNext();
        };
        worker.onerror = (event) => {
          event.preventDefault();
          if (this.worker === worker) this.fail();
        };
      }
      this.active = this.latest;
      const { snapshot, id } = this.active;
      this.worker.postMessage({
        type: 'search',
        id,
        query: snapshot.query,
        mode: snapshot.mode,
        showClosed: snapshot.showClosed,
        tabs: this.sentTabs === snapshot.tabs ? undefined : snapshot.tabs,
      } satisfies SearchWorkerRequest);
      this.sentTabs = snapshot.tabs;
    } catch {
      this.fail();
    }
  }
}
