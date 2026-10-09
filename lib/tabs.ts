import Fuse, { type FuseIndex } from 'fuse.js';
import {
  decodeSearchUrl,
  literalRanges,
  matchedText,
  normalizeSearchText,
  regexRanges,
  type MatchedText,
  type MatchRange,
} from './search-text';
import {
  HISTORY_KEY,
  SESSION_KEY,
  readClosedTabs,
  readHistorySession,
  type ClosedTab,
} from './history';

export interface OpenTab {
  kind: 'open';
  key: string;
  id: number;
  windowId: number;
  index: number;
  title: string;
  url: string;
  lastAccessed: number;
  pinned: boolean;
  incognito: boolean;
}

export type TabEntry = OpenTab | ClosedTab;
export type SearchMode = 'fuzzy' | 'exact' | 'regex';

export interface SearchOptions {
  mode?: SearchMode;
  showClosed?: boolean;
}

export interface TabSearchResult<T extends TabEntry = TabEntry> {
  entry: T;
  title: MatchedText;
  url: MatchedText;
}

interface TermMatch {
  title: MatchRange[];
  url: [MatchRange[], MatchRange[]];
  titleMatched: boolean;
  literalTitle: boolean;
  literal: boolean;
}

export function normalizeTabs(tabs: chrome.tabs.Tab[]): OpenTab[] {
  return tabs.flatMap((tab) => {
    if (tab.id === undefined || tab.id < 0) return [];
    const url = tab.pendingUrl || tab.url || '';
    const lastAccessed = tab.lastAccessed ?? 0;

    return [
      {
        kind: 'open',
        key: `open-${tab.id}`,
        id: tab.id,
        windowId: tab.windowId,
        index: tab.index,
        title: tab.title?.trim() || url || 'Untitled tab',
        url,
        lastAccessed:
          Number.isFinite(lastAccessed) && lastAccessed > 0 ? lastAccessed : 0,
        pinned: tab.pinned,
        incognito: tab.incognito,
      },
    ];
  });
}

export function sortByRecent<T extends TabEntry>(tabs: T[]): T[] {
  return [...tabs].sort((a, b) => {
    const recent = b.lastAccessed - a.lastAccessed;
    if (recent) return recent;
    if (a.kind === 'open' && b.kind === 'open') {
      return a.windowId - b.windowId || a.index - b.index || a.id - b.id;
    }
    if (a.kind !== b.kind) return a.kind === 'open' ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
}

export function filterTabs<T extends TabEntry>(
  tabs: T[],
  query: string,
  options: SearchOptions = {},
): T[] {
  return searchTabs(tabs, query, options).map(({ entry }) => entry);
}

export function searchTabs<T extends TabEntry>(
  tabs: T[],
  query: string,
  options: SearchOptions = {},
): TabSearchResult<T>[] {
  return createTabSearcher(tabs)(query, options);
}

interface SearchRecord<T extends TabEntry> {
  entry: T;
  title: string;
  url: [string, string];
  decodedUrl: string;
  hostname?: string;
}

const fuseOptions = {
  keys: ['title', 'url'],
  ignoreLocation: true,
  ignoreFieldNorm: true,
  shouldSort: false,
  includeMatches: true,
};

function searchIndex<T extends TabEntry>(records: SearchRecord<T>[]) {
  // Raw and decoded URLs are usually identical. Index that string once; keep
  // both original fields for literal ranges and encoded/decoded URL coverage.
  return Fuse.createIndex(
    fuseOptions.keys,
    records.map<SearchRecord<T>>((record) => ({
      ...record,
      url: record.url[0] === record.url[1] ? [record.url[0], ''] : record.url,
    })),
  );
}

function searchDataset<T extends TabEntry>(ordered: T[]) {
  let records: SearchRecord<T>[] | undefined;
  let index: FuseIndex<SearchRecord<T>> | undefined;
  let empty: TabSearchResult<T>[] | undefined;
  const getRecords = () =>
    (records ??= ordered.map<SearchRecord<T>>((entry) => {
      const decodedUrl = decodeSearchUrl(entry.url);
      return {
        entry,
        decodedUrl,
        title: normalizeSearchText(entry.title),
        url: [normalizeSearchText(entry.url), normalizeSearchText(decodedUrl)],
      };
    }));
  return {
    ordered,
    getRecords,
    getIndex: () => (index ??= searchIndex(getRecords())),
    getEmpty: () =>
      (empty ??= ordered.map((entry) => buildSearchResult(entry))),
  };
}

// Retain this searcher for one immutable tab snapshot. Records/indexes are lazy,
// and open-only searches never prepare closed records, even after toggling modes.
export function createTabSearcher<T extends TabEntry>(tabs: T[]) {
  const all = searchDataset(sortByRecent(tabs));
  const open = searchDataset(all.ordered.filter((tab) => tab.kind === 'open'));
  return (
    query: string,
    { mode = 'fuzzy', showClosed = true }: SearchOptions = {},
  ): TabSearchResult<T>[] => {
    const dataset = showClosed ? all : open;
    if (mode === 'regex' || mode === 'exact') {
      const phrase = normalizeSearchText(query.trim());
      if (mode === 'regex' ? !query : !phrase) return dataset.getEmpty();
      const pattern = mode === 'regex' ? new RegExp(query, 'iu') : undefined;
      const rangesFor = (text: string) =>
        pattern
          ? regexRanges(text, pattern)
          : literalRanges(normalizeSearchText(text), phrase);
      return dataset
        .getRecords()
        .flatMap((record) => {
          const { entry } = record;
          const title = pattern
            ? rangesFor(entry.title)
            : literalRanges(record.title, phrase);
          const url: [MatchRange[], MatchRange[]] = [
            pattern
              ? rangesFor(entry.url)
              : literalRanges(record.url[0], phrase),
            pattern
              ? rangesFor(record.decodedUrl)
              : literalRanges(record.url[1], phrase),
          ];
          // Zero-width regex matches include an entry but have no visible glyphs.
          const titleMatched = pattern
            ? pattern.test(entry.title)
            : title.length > 0;
          if (
            !titleMatched &&
            !(pattern
              ? [entry.url, record.decodedUrl].some((text) =>
                  pattern.test(text),
                )
              : url.some((ranges) => ranges.length > 0))
          )
            return [];
          return [
            {
              result: buildSearchResult(entry, title, url, !pattern),
              titleMatched,
            },
          ];
        })
        .sort((a, b) => Number(b.titleMatched) - Number(a.titleMatched))
        .map(({ result }) => result);
    }
    const terms = normalizeSearchText(query)
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    if (terms.length === 0) return dataset.getEmpty();

    const searchTerms = terms.map((term) => {
      const hostname = searchHostname(term);
      const numericIdentifier = /^[\p{N}\p{P}]+(?:v\p{N}+[\p{P}]*)?$/u.test(
        term,
      );
      const pastedAddress = /^(?:[a-z][a-z\d+.-]*:\/\/|www\.)/u.test(term);
      return {
        term,
        hostname,
        // Domain names and IDs must not match through typos. Fuse also matches
        // any 32-character chunk of longer patterns, so keep those literal.
        literalOnly:
          term.length <= 3 ||
          term.length > 32 ||
          numericIdentifier ||
          pastedAddress ||
          Boolean(hostname),
      };
    });
    const records = dataset.getRecords();
    let candidates = records;
    const matches = searchTerms.map(({ term, hostname, literalOnly }) => {
      const byKey = new Map<string, TermMatch>();
      for (const record of candidates) {
        const title = literalRanges(record.title, term);
        const url: [MatchRange[], MatchRange[]] = [
          literalRanges(record.url[0]!, term),
          literalRanges(record.url[1]!, term),
        ];
        if (title.length || url.some((ranges) => ranges.length)) {
          byKey.set(record.entry.key, {
            title,
            url,
            titleMatched: title.length > 0,
            literalTitle: title.length > 0,
            literal: true,
          });
        }
      }
      if (!literalOnly && candidates.length) {
        const search = new Fuse(
          candidates,
          {
            ...fuseOptions,
            // At most two edits, and never more than a quarter of a word.
            threshold: Math.min(0.25, 2 / term.length),
          },
          candidates === records ? dataset.getIndex() : searchIndex(candidates),
        );
        for (const result of search.search(term)) {
          const match =
            byKey.get(result.item.entry.key) ??
            ({
              title: [],
              url: [[], []],
              titleMatched: false,
              literalTitle: false,
              literal: false,
            } satisfies TermMatch);
          for (const field of result.matches ?? []) {
            const ranges: MatchRange[] = field.indices.map(([start, end]) => [
              start,
              end + 1,
            ]);
            if (field.key === 'title') {
              match.titleMatched = true;
              if (!match.title.length) match.title = ranges;
            } else if (
              field.key === 'url' &&
              (field.refIndex === 0 || field.refIndex === 1)
            ) {
              if (!match.url[field.refIndex].length)
                match.url[field.refIndex] = ranges;
            }
          }
          byKey.set(result.item.entry.key, match);
        }
      }
      // Terms are ANDed. A record rejected by an earlier term cannot return;
      // scanning/indexing only survivors leaves matching and ranking unchanged.
      const survivors = candidates.filter((record) =>
        byKey.has(record.entry.key),
      );
      if (survivors.length !== candidates.length) candidates = survivors;
      return { hostname, byKey };
    });
    return (
      candidates
        .flatMap((record) => {
          let titleMatches = 0;
          let literalTitleMatches = 0;
          let hostMatches = 0;
          let fuzzyMatches = 0;
          const title: MatchRange[] = [];
          const url: [MatchRange[], MatchRange[]] = [[], []];
          const urlCoverage: [number, number] = [0, 0];
          for (const { hostname, byKey } of matches) {
            const match = byKey.get(record.entry.key);
            if (!match) return [];
            if (match.titleMatched) titleMatches++;
            if (match.literalTitle) literalTitleMatches++;
            if (!match.literal) fuzzyMatches++;
            title.push(...match.title);
            for (const index of [0, 1] as const) {
              url[index].push(...match.url[index]);
              if (match.url[index].length) urlCoverage[index]++;
            }
            if (
              hostname &&
              ((record.hostname ??= urlHostname(record.entry.url)) ===
                hostname ||
                record.hostname.endsWith(`.${hostname}`))
            ) {
              hostMatches++;
            }
          }
          return [
            {
              entry: record.entry,
              title,
              url,
              urlCoverage,
              titleMatches,
              literalTitleMatches,
              hostMatches,
              fuzzyMatches,
            },
          ];
        })
        // Stable sorting retains last-access order among equally relevant results.
        .sort(
          (a, b) =>
            b.titleMatches - a.titleMatches ||
            b.literalTitleMatches - a.literalTitleMatches ||
            b.hostMatches - a.hostMatches ||
            a.fuzzyMatches - b.fuzzyMatches,
        )
        .map(({ entry, title, url, urlCoverage }) =>
          buildSearchResult(entry, title, url, true, urlCoverage),
        )
    );
  };
}

function buildSearchResult<T extends TabEntry>(
  entry: T,
  title: MatchRange[] = [],
  url: [MatchRange[], MatchRange[]] = [[], []],
  normalized = true,
  coverage: [number, number] = [
    Number(url[0].length > 0),
    Number(url[1].length > 0),
  ],
): TabSearchResult<T> {
  const index = coverage[0] > coverage[1] ? 0 : 1;
  let titleMatch: MatchedText | undefined;
  let urlMatch: MatchedText | undefined;
  if (!title.length && !url[0].length && !url[1].length) {
    return {
      entry,
      title: { text: entry.title, ranges: [] },
      url: { text: decodeSearchUrl(entry.url), ranges: [] },
    };
  }
  // Only mounted rows need expensive Unicode range mapping. Keep full logical
  // results for ranking/navigation while evaluating highlights on first access.
  return {
    entry,
    get title() {
      return (titleMatch ??= matchedText(entry.title, title, normalized));
    },
    get url() {
      return (urlMatch ??= matchedText(
        index === 0 ? entry.url : decodeSearchUrl(entry.url),
        url[index],
        normalized,
      ));
    },
  };
}

function searchHostname(term: string): string | undefined {
  const scheme = /^[a-z][a-z\d+.-]*:\/\//u.test(term);
  const domain =
    /^(?:[\p{L}\p{N}-]+\.)+[\p{L}][\p{L}\p{N}-]+\.?(?::\d+)?(?:[/?#].*)?$/u;
  if (!scheme && !domain.test(term)) return undefined;
  return urlHostname(scheme ? term : `https://${term}`) || undefined;
}

function urlHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/u, '');
  } catch {
    return '';
  }
}

export function mergeTabEntries(
  open: OpenTab[],
  closed: ClosedTab[],
): TabEntry[] {
  const openUrls = new Set(open.map((tab) => `${tab.incognito}:${tab.url}`));
  return sortByRecent<TabEntry>([
    ...open,
    ...closed.filter((tab) => !openUrls.has(`${tab.incognito}:${tab.url}`)),
  ]);
}

export async function getTabEntries(includeClosed = true): Promise<{
  tabs: TabEntry[];
  currentTabId?: number;
}> {
  if (!includeClosed) return getOpenTabs();
  const [snapshot, local, session] = await Promise.all([
    getOpenTabs(),
    chrome.storage.local.get(HISTORY_KEY),
    chrome.storage.session.get(SESSION_KEY),
  ]);
  const closed = [
    ...readClosedTabs(local[HISTORY_KEY]).filter((tab) => !tab.incognito),
    ...readHistorySession(session[SESSION_KEY]).privateClosed,
  ];
  return { ...snapshot, tabs: mergeTabEntries(snapshot.tabs, closed) };
}

export async function getOpenTabs(): Promise<{
  tabs: OpenTab[];
  currentTabId?: number;
}> {
  const [tabs, focusedWindow] = await Promise.all([
    chrome.tabs.query({}),
    chrome.windows.getLastFocused(),
  ]);
  return {
    tabs: sortByRecent(normalizeTabs(tabs)),
    currentTabId: tabs.find(
      (tab) => tab.active && tab.windowId === focusedWindow.id,
    )?.id,
  };
}

export async function switchToTab(id: number): Promise<void> {
  // Use the returned window ID: the tab may have moved since the list loaded.
  const tab = await chrome.tabs.update(id, { active: true });
  if (!tab) throw new Error('The tab is no longer available.');
  await focusWindow(tab.windowId);
}

async function focusWindow(windowId: number): Promise<void> {
  const targetWindow = await chrome.windows.get(windowId);
  await chrome.windows.update(windowId, {
    focused: true,
    ...(targetWindow.state === 'minimized' ? { state: 'normal' } : {}),
  });
}

async function openNewTab(entry: TabEntry): Promise<void> {
  const focusedWindow = await chrome.windows.getLastFocused();
  const target =
    focusedWindow.incognito === entry.incognito
      ? focusedWindow
      : (await chrome.windows.getAll()).find(
          (window) =>
            window.incognito === entry.incognito && window.type === 'normal',
        );
  if (target?.id === undefined) {
    await chrome.windows.create({
      url: entry.url,
      incognito: entry.incognito,
      focused: true,
    });
    return;
  }
  const tab = await chrome.tabs.create({
    url: entry.url,
    windowId: target.id,
    active: true,
  });
  if (tab.id === undefined || tab.id < 0)
    throw new Error('Could not open the tab.');
  await focusWindow(tab.windowId);
}

export async function activateEntry(entry: TabEntry): Promise<void> {
  if (entry.kind === 'closed') {
    await openNewTab(entry);
    return;
  }
  try {
    await switchToTab(entry.id);
  } catch (error) {
    // A row can still be on screen when its tab closes. Reopen only if it is gone;
    // focus/dragging errors must not create duplicate tabs.
    const stillOpen = (await chrome.tabs.query({})).some(
      (tab) => tab.id === entry.id,
    );
    if (stillOpen) throw error;
    await openNewTab(entry);
  }
}
