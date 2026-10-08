export const HISTORY_KEY = 'closedTabHistory';
export const SESSION_KEY = 'tabHistorySession';
export const HISTORY_LIMIT_KEY = 'historyLimit';
export const HISTORY_LIMIT = 10_000;
export const MAX_HISTORY_LIMIT = 10_000;

export function isHistoryLimit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_HISTORY_LIMIT
  );
}

export function readHistoryLimit(value: unknown): number {
  return isHistoryLimit(value) ? value : HISTORY_LIMIT;
}

export interface ClosedTab {
  kind: 'closed';
  key: string;
  title: string;
  url: string;
  lastAccessed: number;
  closedAt: number;
  incognito: boolean;
}

export function readHistorySession(value: unknown): {
  openTabs: OpenTab[];
  privateClosed: ClosedTab[];
} {
  const state =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  return {
    openTabs: Array.isArray(state.openTabs)
      ? state.openTabs.filter(
          (tab): tab is OpenTab =>
            tab &&
            tab.kind === 'open' &&
            typeof tab.key === 'string' &&
            Number.isInteger(tab.id) &&
            tab.id >= 0 &&
            Number.isInteger(tab.windowId) &&
            Number.isInteger(tab.index) &&
            typeof tab.url === 'string' &&
            typeof tab.title === 'string' &&
            Number.isFinite(tab.lastAccessed) &&
            tab.lastAccessed >= 0 &&
            typeof tab.incognito === 'boolean' &&
            typeof tab.pinned === 'boolean',
        )
      : [],
    privateClosed: readClosedTabs(state.privateClosed).filter(
      (tab) => tab.incognito,
    ),
  };
}

export function canReopenUrl(url: string): boolean {
  try {
    return ['http:', 'https:', 'file:', 'chrome:', 'about:'].includes(
      new URL(url).protocol,
    );
  } catch {
    return false;
  }
}

export function closedTabFrom(
  tab: Pick<
    chrome.tabs.Tab,
    'title' | 'url' | 'pendingUrl' | 'lastAccessed' | 'incognito'
  >,
  closedAt: number,
): ClosedTab | undefined {
  const url = tab.pendingUrl || tab.url || '';
  if (!canReopenUrl(url)) return;
  return {
    kind: 'closed',
    key: `closed-${crypto.randomUUID()}`,
    title: tab.title?.trim() || url,
    url,
    lastAccessed:
      Number.isFinite(tab.lastAccessed) && (tab.lastAccessed ?? 0) > 0
        ? tab.lastAccessed!
        : closedAt,
    closedAt,
    incognito: tab.incognito,
  };
}

export function readClosedTabs(value: unknown): ClosedTab[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (tab): tab is ClosedTab =>
      tab !== null &&
      typeof tab === 'object' &&
      tab.kind === 'closed' &&
      typeof tab.key === 'string' &&
      /^closed-[\w-]+$/u.test(tab.key) &&
      typeof tab.title === 'string' &&
      typeof tab.url === 'string' &&
      canReopenUrl(tab.url) &&
      typeof tab.incognito === 'boolean' &&
      Number.isFinite(tab.lastAccessed) &&
      tab.lastAccessed > 0 &&
      Number.isFinite(tab.closedAt) &&
      tab.closedAt > 0,
  );
}

export function mergeClosedTabs(
  existing: ClosedTab[],
  incoming: ClosedTab[],
  limit = HISTORY_LIMIT,
): ClosedTab[] {
  const byUrl = new Map<string, ClosedTab>();
  for (const tab of [...existing, ...incoming]) {
    const identity = `${tab.incognito}:${tab.url}`;
    const previous = byUrl.get(identity);
    if (!previous || tab.closedAt > previous.closedAt) {
      byUrl.set(identity, { ...tab, key: previous?.key ?? tab.key });
    }
  }
  const recent = [...byUrl.values()].sort(
    (a, b) => b.lastAccessed - a.lastAccessed || b.closedAt - a.closedAt,
  );
  return recent.slice(0, readHistoryLimit(limit));
}

export function closedTabsFromSessions(
  sessions: chrome.sessions.Session[],
): ClosedTab[] {
  return sessions.flatMap((session) => {
    const tabs = session.tab ? [session.tab] : (session.window?.tabs ?? []);
    return tabs.flatMap((tab) => {
      if (tab.incognito) return [];
      const entry = closedTabFrom(tab, session.lastModified * 1000);
      return entry ? [entry] : [];
    });
  });
}
import type { OpenTab } from './tabs';
