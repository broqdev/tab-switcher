import Fuse from 'fuse.js';
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
  { mode = 'fuzzy', showClosed = true }: SearchOptions = {},
): T[] {
  const ordered = sortByRecent(
    showClosed ? tabs : tabs.filter((tab) => tab.kind === 'open'),
  );
  if (mode === 'regex') {
    if (!query) return ordered;
    const pattern = new RegExp(query, 'iu');
    return filterTitleFirst(ordered, (text) => pattern.test(text));
  }
  if (mode === 'exact') {
    const phrase = normalizeSearchText(query.trim());
    return filterTitleFirst(ordered, (text) =>
      normalizeSearchText(text).includes(phrase),
    );
  }
  const terms = normalizeSearchText(query).trim().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return ordered;

  const searchTerms = terms.map((term) => {
    const hostname = searchHostname(term);
    const numericIdentifier = /^[\p{N}\p{P}]+(?:v\p{N}+[\p{P}]*)?$/u.test(term);
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
  const hasDomain = searchTerms.some(({ hostname }) => hostname);
  const records = ordered.map((entry) => ({
    entry,
    title: normalizeSearchText(entry.title),
    url: [
      normalizeSearchText(entry.url),
      normalizeSearchText(decodeSearchUrl(entry.url)),
    ],
    hostname: hasDomain ? urlHostname(entry.url) : '',
  }));
  const options = {
    keys: ['title', 'url'],
    ignoreLocation: true,
    ignoreFieldNorm: true,
    shouldSort: false,
    includeMatches: true,
  };
  const index = searchTerms.some(({ literalOnly }) => !literalOnly)
    ? Fuse.createIndex(options.keys, records)
    : undefined;
  const matches = searchTerms.map(({ term, hostname, literalOnly }) => {
    const literalTitleKeys = new Set<string>();
    const literalKeys = new Set<string>();
    for (const record of records) {
      if (record.title.includes(term)) {
        literalTitleKeys.add(record.entry.key);
        literalKeys.add(record.entry.key);
      } else if (record.url.some((text) => text.includes(term))) {
        literalKeys.add(record.entry.key);
      }
    }
    if (literalOnly)
      return {
        hostname,
        literalKeys,
        literalTitleKeys,
        titleKeys: literalTitleKeys,
        keys: literalKeys,
      };
    const search = new Fuse(
      records,
      {
        ...options,
        // At most two edits, and never more than a quarter of a word.
        threshold: Math.min(0.25, 2 / term.length),
      },
      index,
    );
    const titleKeys = new Set(literalTitleKeys);
    const keys = new Set(literalKeys);
    for (const result of search.search(term)) {
      keys.add(result.item.entry.key);
      if (result.matches?.some((match) => match.key === 'title')) {
        titleKeys.add(result.item.entry.key);
      }
    }
    return { hostname, literalKeys, literalTitleKeys, titleKeys, keys };
  });
  return (
    records
      .flatMap((record) => {
        let titleMatches = 0;
        let literalTitleMatches = 0;
        let hostMatches = 0;
        let fuzzyMatches = 0;
        for (const {
          hostname,
          literalKeys,
          literalTitleKeys,
          titleKeys,
          keys,
        } of matches) {
          if (!keys.has(record.entry.key)) return [];
          if (titleKeys.has(record.entry.key)) titleMatches++;
          if (literalTitleKeys.has(record.entry.key)) literalTitleMatches++;
          if (!literalKeys.has(record.entry.key)) fuzzyMatches++;
          if (
            hostname &&
            (record.hostname === hostname ||
              record.hostname.endsWith(`.${hostname}`))
          ) {
            hostMatches++;
          }
        }
        return [
          {
            entry: record.entry,
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
      .map(({ entry }) => entry)
  );
}

function filterTitleFirst<T extends TabEntry>(
  ordered: T[],
  matches: (text: string) => boolean,
): T[] {
  const titleMatches: T[] = [];
  const urlMatches: T[] = [];
  for (const entry of ordered) {
    if (matches(entry.title)) titleMatches.push(entry);
    else if (matches(entry.url) || matches(decodeSearchUrl(entry.url)))
      urlMatches.push(entry);
  }
  return [...titleMatches, ...urlMatches];
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

function normalizeSearchText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase();
}

function decodeSearchUrl(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
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

export async function getTabEntries(): Promise<{
  tabs: TabEntry[];
  currentTabId?: number;
}> {
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
