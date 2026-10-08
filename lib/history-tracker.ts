import { normalizeTabs, type OpenTab } from './tabs';
import {
  HISTORY_KEY,
  HISTORY_LIMIT_KEY,
  HISTORY_LIMIT,
  SESSION_KEY,
  closedTabFrom,
  closedTabsFromSessions,
  mergeClosedTabs,
  readClosedTabs,
  readHistorySession,
  readHistoryLimit,
  type ClosedTab,
} from './history';

export function startHistoryTracker() {
  const openTabs = new Map<number, OpenTab>();
  let closedTabs: ClosedTab[] = [];
  let privateClosed: ClosedTab[] = [];
  let historyLimit = HISTORY_LIMIT;
  let limitChanged = false;
  let historyLoaded = false;
  let pending: Promise<void> = Promise.resolve();

  // One writer serializes closures, imports, and snapshots across all windows.
  function enqueue(work: () => Promise<void>) {
    const next = pending.then(work);
    pending = next.catch((error: unknown) =>
      console.error('Could not save tab history:', error),
    );
    return next;
  }

  function remember(tab: OpenTab, closedAt: number) {
    const entry = closedTabFrom(tab, closedAt);
    if (!entry) return;
    if (tab.incognito)
      privateClosed = mergeClosedTabs(privateClosed, [entry], historyLimit);
    else closedTabs = mergeClosedTabs(closedTabs, [entry], historyLimit);
  }

  async function saveSession() {
    await chrome.storage.session.set({
      [SESSION_KEY]: { openTabs: [...openTabs.values()], privateClosed },
    });
  }

  async function saveHistory() {
    await chrome.storage.local.set({ [HISTORY_KEY]: closedTabs });
    await saveSession();
  }

  async function importRecent() {
    const sessions = await chrome.sessions.getRecentlyClosed();
    closedTabs = mergeClosedTabs(
      closedTabs,
      closedTabsFromSessions(sessions),
      historyLimit,
    );
    await saveHistory();
  }

  // Subscribe before reading: a newer setting must win over a stale snapshot.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(HISTORY_LIMIT_KEY in changes)) return;
    limitChanged = true;
    historyLimit = readHistoryLimit(changes[HISTORY_LIMIT_KEY]?.newValue);
    void enqueue(async () => {
      // Never replace saved history with empty state after a failed startup read.
      if (!historyLoaded) return;
      closedTabs = mergeClosedTabs(closedTabs, [], historyLimit);
      privateClosed = mergeClosedTabs(privateClosed, [], historyLimit);
      await saveHistory();
    });
  });

  const ready = enqueue(async () => {
    const [local, session, liveTabs] = await Promise.all([
      chrome.storage.local.get([HISTORY_KEY, HISTORY_LIMIT_KEY]),
      chrome.storage.session.get(SESSION_KEY),
      chrome.tabs.query({}),
    ]);
    if (!limitChanged)
      historyLimit = readHistoryLimit(local[HISTORY_LIMIT_KEY]);
    closedTabs = readClosedTabs(local[HISTORY_KEY]).filter(
      (tab) => !tab.incognito,
    );
    const previousState = readHistorySession(session[SESSION_KEY]);
    privateClosed = mergeClosedTabs(
      previousState.privateClosed,
      [],
      historyLimit,
    );
    historyLoaded = true;
    const live = normalizeTabs(liveTabs);
    const liveIds = new Set(live.map((tab) => tab.id));
    const previous = previousState.openTabs;
    for (const tab of previous) {
      if (!liveIds.has(tab.id)) remember(tab, Date.now());
    }
    for (const tab of live) openTabs.set(tab.id, tab);
    await importRecent();
  });

  function track(tab: chrome.tabs.Tab) {
    const normalized = normalizeTabs([tab])[0];
    if (!normalized) return;
    void enqueue(async () => {
      openTabs.set(normalized.id, normalized);
      await saveSession();
    });
  }

  chrome.tabs.onCreated.addListener(track);
  chrome.tabs.onUpdated.addListener((_id, _changes, tab) => track(tab));
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    const accessedAt = Date.now();
    void enqueue(async () => {
      let tab = openTabs.get(tabId);
      try {
        tab = normalizeTabs([await chrome.tabs.get(tabId)])[0] ?? tab;
      } catch {
        /* The removal event will use the snapshot if the tab closed. */
      }
      if (tab) {
        openTabs.set(tabId, {
          ...tab,
          lastAccessed: Math.max(tab.lastAccessed, accessedAt),
        });
        await saveSession();
      }
    });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    const closedAt = Date.now();
    void enqueue(async () => {
      const tab = openTabs.get(tabId);
      if (tab) remember(tab, closedAt);
      openTabs.delete(tabId);
      await saveHistory();
    });
  });
  chrome.tabs.onReplaced.addListener((addedId, removedId) => {
    void enqueue(async () => {
      const previous = openTabs.get(removedId);
      openTabs.delete(removedId);
      try {
        const tab = normalizeTabs([await chrome.tabs.get(addedId)])[0];
        if (tab) openTabs.set(addedId, tab);
      } catch {
        if (previous)
          openTabs.set(addedId, {
            ...previous,
            id: addedId,
            key: `open-${addedId}`,
          });
      }
      await saveSession();
    });
  });
  chrome.sessions.onChanged.addListener(() => {
    void enqueue(importRecent);
  });

  return { ready, flush: () => pending };
}
