import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HISTORY_KEY,
  HISTORY_LIMIT,
  HISTORY_LIMIT_KEY,
  MAX_HISTORY_LIMIT,
  SESSION_KEY,
  closedTabFrom,
  closedTabsFromSessions,
  mergeClosedTabs,
  readClosedTabs,
  readHistorySession,
  readHistoryLimit,
  type ClosedTab,
} from '../../lib/history';
import {
  activateEntry,
  filterTabs,
  getTabEntries,
  mergeTabEntries,
  normalizeTabs,
  type OpenTab,
  type TabEntry,
} from '../../lib/tabs';
import { startHistoryTracker } from '../../lib/history-tracker';

const browserTab = (
  overrides: Partial<chrome.tabs.Tab> = {},
): chrome.tabs.Tab => ({
  id: 1,
  windowId: 10,
  index: 0,
  title: 'TypeScript Handbook',
  url: 'https://example.com/docs',
  lastAccessed: 100,
  active: false,
  selected: false,
  pinned: false,
  incognito: false,
  highlighted: false,
  autoDiscardable: true,
  discarded: false,
  groupId: -1,
  frozen: false,
  ...overrides,
});
const openTab = (overrides: Partial<chrome.tabs.Tab> = {}): OpenTab =>
  normalizeTabs([browserTab(overrides)])[0]!;
const closedTab = (overrides: Partial<ClosedTab> = {}): ClosedTab => ({
  kind: 'closed',
  key: 'closed-test',
  title: 'TypeScript Handbook',
  url: 'https://example.com/docs',
  lastAccessed: 100,
  closedAt: 200,
  incognito: false,
  ...overrides,
});

const closedHistory = (count: number, incognito = false) =>
  Array.from({ length: count }, (_, index) =>
    closedTab({
      key: `closed-${incognito ? 'private-' : ''}${index}`,
      url: `https://example.com/${index}`,
      lastAccessed: index + 1,
      closedAt: index + 2,
      incognito,
    }),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('history records', () => {
  it.each([
    undefined,
    null,
    '1000',
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    MAX_HISTORY_LIMIT + 1,
  ])('uses the default history limit for invalid stored value %s', (value) =>
    expect(readHistoryLimit(value)).toBe(HISTORY_LIMIT),
  );

  it.each([1, 1000, MAX_HISTORY_LIMIT])(
    'accepts configured history limit %s',
    (limit) => {
      expect(readHistoryLimit(limit)).toBe(limit);
    },
  );

  it('supports configured retention and trims by access time at a smaller limit', () => {
    const entries = closedHistory(750);
    expect(mergeClosedTabs([], entries, 1000)).toHaveLength(750);
    expect(
      mergeClosedTabs([], entries, 2).map((tab) => tab.lastAccessed),
    ).toEqual([750, 749]);
  });

  it.each([false, true])(
    'retains history above 5 MiB by count (incognito: %s)',
    (incognito) => {
      const entries = closedHistory(2, incognito).map((tab) => ({
        ...tab,
        title: 'x'.repeat(3 * 1024 * 1024),
      }));
      const retained = mergeClosedTabs([], entries, MAX_HISTORY_LIMIT);
      expect(retained.map((tab) => tab.lastAccessed)).toEqual([2, 1]);
      expect(
        mergeClosedTabs([], entries, 1).map((tab) => tab.lastAccessed),
      ).toEqual([2]);
    },
  );

  it('preserves last access rather than moving an old tab to the top when it closes', () => {
    expect(
      closedTabFrom(browserTab({ lastAccessed: 100 }), 200)?.lastAccessed,
    ).toBe(100);
    expect(
      closedTabFrom(browserTab({ lastAccessed: undefined }), 200)?.lastAccessed,
    ).toBe(200);
  });

  it('seeds tabs in closed windows, converts seconds to milliseconds, and skips private and ephemeral URLs', () => {
    const sessions = [
      { lastModified: 2, tab: browserTab({ lastAccessed: undefined }) },
      {
        lastModified: 3,
        window: {
          tabs: [
            browserTab({ url: 'https://other.example' }),
            browserTab({ incognito: true }),
          ],
        },
      },
      {
        lastModified: 4,
        tab: browserTab({ url: 'chrome-extension://example/popup.html' }),
      },
      { lastModified: 5, tab: browserTab({ url: 'javascript:alert(1)' }) },
    ] as chrome.sessions.Session[];
    const entries = closedTabsFromSessions(sessions);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ closedAt: 2000, lastAccessed: 2000 });
    expect(entries[1]).toMatchObject({
      url: 'https://other.example',
      closedAt: 3000,
      lastAccessed: 100,
    });
  });

  it('deduplicates URLs, preserves row identity, and keeps an observed timestamp over an older session import', () => {
    const stored = closedTab({ closedAt: 2500 });
    const imported = closedTab({
      key: 'closed-import',
      lastAccessed: 2000,
      closedAt: 2000,
    });
    expect(mergeClosedTabs([stored], [imported])).toEqual([stored]);
    const newer = closedTab({
      key: 'closed-newer',
      title: 'New title',
      closedAt: 3000,
      lastAccessed: 2900,
    });
    expect(mergeClosedTabs([stored], [newer])[0]).toEqual({
      ...newer,
      key: stored.key,
    });
  });

  it('bounds retention and keeps the most recently accessed entries', () => {
    const entries = Array.from({ length: HISTORY_LIMIT + 2 }, (_, index) =>
      closedTab({
        key: `closed-${index}`,
        url: `https://example.com/${index}`,
        lastAccessed: index + 1,
      }),
    );
    const retained = mergeClosedTabs([], entries);
    expect(retained).toHaveLength(HISTORY_LIMIT);
    expect(retained[0]?.url).toBe(`https://example.com/${HISTORY_LIMIT + 1}`);
    expect(retained.some((tab) => tab.url === 'https://example.com/0')).toBe(
      false,
    );
  });

  it('rejects corrupt storage and unsafe URL schemes', () => {
    expect(
      readClosedTabs([
        null,
        {},
        closedTab({ url: 'data:text/html,hello' }),
        closedTab(),
      ]),
    ).toEqual([closedTab()]);
    expect(
      readHistorySession({
        openTabs: [null, { kind: 'open' }, openTab()],
        privateClosed: [closedTab(), closedTab({ incognito: true })],
      }),
    ).toEqual({
      openTabs: [openTab()],
      privateClosed: [closedTab({ incognito: true })],
    });
  });

  it('suppresses closed URLs currently open while keeping distinct open tabs and globally sorting history', () => {
    const entries = mergeTabEntries(
      [openTab(), openTab({ id: 2 })],
      [
        closedTab(),
        closedTab({
          key: 'closed-other',
          url: 'https://other.example',
          lastAccessed: 300,
        }),
      ],
    );
    expect(entries.map((tab) => tab.key)).toEqual([
      'closed-other',
      'open-1',
      'open-2',
    ]);
  });

  it('fuzzy searches both kinds without losing closed entries or changing recency', () => {
    const entries: TabEntry[] = [
      openTab(),
      closedTab({
        key: 'closed-other',
        url: 'https://other.example',
        lastAccessed: 300,
      }),
    ];
    expect(filterTabs(entries, 'typescrpt').map((tab) => tab.key)).toEqual([
      'closed-other',
      'open-1',
    ]);
  });
});

function event<Args extends unknown[]>() {
  const listeners: Array<(...args: Args) => void> = [];
  return {
    addListener: (listener: (...args: Args) => void) => {
      listeners.push(listener);
    },
    emit: (...args: Args) => {
      listeners.forEach((listener) => listener(...args));
    },
  };
}

function storageArea(
  initial: Record<string, unknown> = {},
  onChange?: (changes: Record<string, chrome.storage.StorageChange>) => void,
) {
  const data = structuredClone(initial);
  return {
    data,
    get: vi.fn(async (keys: string | string[]) =>
      Object.fromEntries(
        (typeof keys === 'string' ? [keys] : keys).map((key) => [
          key,
          structuredClone(data[key]),
        ]),
      ),
    ),
    set: vi.fn(async (values: Record<string, unknown>) => {
      const changes = Object.fromEntries(
        Object.entries(values).map(([key, newValue]) => [
          key,
          {
            oldValue: structuredClone(data[key]),
            newValue: structuredClone(newValue),
          },
        ]),
      );
      Object.assign(data, structuredClone(values));
      onChange?.(changes);
    }),
  };
}

function fakeChrome(
  tabs: chrome.tabs.Tab[] = [],
  localData: Record<string, unknown> = {},
  sessionData: Record<string, unknown> = {},
) {
  const onChanged =
    event<[Record<string, chrome.storage.StorageChange>, string]>();
  const local = storageArea(localData, (changes) =>
    onChanged.emit(changes, 'local'),
  );
  const session = storageArea(sessionData, (changes) =>
    onChanged.emit(changes, 'session'),
  );
  const browser = {
    tabs: {
      query: vi.fn(async () => tabs),
      get: vi.fn(async (id: number) => {
        const tab = tabs.find((tab) => tab.id === id);
        if (!tab) throw new Error('No tab');
        return tab;
      }),
      onCreated: event<[chrome.tabs.Tab]>(),
      onUpdated: event<[number, Record<string, unknown>, chrome.tabs.Tab]>(),
      onActivated: event<[{ tabId: number }]>(),
      onRemoved: event<[number]>(),
      onReplaced: event<[number, number]>(),
    },
    sessions: {
      getRecentlyClosed: vi.fn(
        async (): Promise<chrome.sessions.Session[]> => [],
      ),
      onChanged: event<[]>(),
    },
    storage: { local, session, onChanged },
    windows: {
      getLastFocused: vi.fn(async () => ({ id: 10, incognito: false })),
    },
  };
  vi.stubGlobal('chrome', browser);
  return browser;
}

describe('background capture and persistence', () => {
  it('loads a configured limit before retaining regular and private history at startup', async () => {
    const browser = fakeChrome(
      [],
      {
        [HISTORY_KEY]: closedHistory(600),
        [HISTORY_LIMIT_KEY]: 1000,
      },
      {
        [SESSION_KEY]: {
          openTabs: [],
          privateClosed: closedHistory(600, true),
        },
      },
    );
    await startHistoryTracker().ready;
    expect(
      readClosedTabs(browser.storage.local.data[HISTORY_KEY]),
    ).toHaveLength(600);
    expect(
      readHistorySession(browser.storage.session.data[SESSION_KEY])
        .privateClosed,
    ).toHaveLength(600);
  });

  it('applies a live lower limit to both histories and uses live increases for subsequent captures', async () => {
    const browser = fakeChrome(
      [],
      {
        [HISTORY_KEY]: closedHistory(4),
      },
      {
        [SESSION_KEY]: { openTabs: [], privateClosed: closedHistory(4, true) },
      },
    );
    const tracker = startHistoryTracker();
    await tracker.ready;
    await browser.storage.local.set({ [HISTORY_LIMIT_KEY]: 2 });
    await tracker.flush();
    expect(
      readClosedTabs(browser.storage.local.data[HISTORY_KEY]).map(
        (tab) => tab.lastAccessed,
      ),
    ).toEqual([4, 3]);
    expect(
      readHistorySession(
        browser.storage.session.data[SESSION_KEY],
      ).privateClosed.map((tab) => tab.lastAccessed),
    ).toEqual([4, 3]);
    await browser.storage.local.set({ [HISTORY_LIMIT_KEY]: 3 });
    browser.tabs.onCreated.emit(
      browserTab({ id: 9, url: 'https://new.example', lastAccessed: 10 }),
    );
    browser.tabs.onRemoved.emit(9);
    await tracker.flush();
    expect(
      readClosedTabs(browser.storage.local.data[HISTORY_KEY]).map(
        (tab) => tab.lastAccessed,
      ),
    ).toEqual([10, 4, 3]);
    expect(
      readHistorySession(browser.storage.session.data[SESSION_KEY])
        .privateClosed,
    ).toHaveLength(2);
  });

  it('preserves a newer limit when the startup storage snapshot is delayed', async () => {
    const browser = fakeChrome([], {
      [HISTORY_KEY]: closedHistory(600),
      [HISTORY_LIMIT_KEY]: 2,
    });
    const get = browser.storage.local.get.getMockImplementation()!;
    let release: (() => void) | undefined;
    browser.storage.local.get.mockImplementationOnce(async (keys) => {
      const snapshot = await get(keys);
      return new Promise<Record<string, unknown>>((resolve) => {
        release = () => resolve(snapshot);
      });
    });
    const tracker = startHistoryTracker();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await browser.storage.local.set({ [HISTORY_LIMIT_KEY]: 1000 });
    release!();
    await tracker.flush();
    expect(
      readClosedTabs(browser.storage.local.data[HISTORY_KEY]),
    ).toHaveLength(600);
  });

  it('does not wipe existing history on a setting change after a failed startup read', async () => {
    const browser = fakeChrome([], { [HISTORY_KEY]: closedHistory(4) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    browser.storage.local.get.mockRejectedValueOnce(
      new Error('Unavailable storage'),
    );
    const tracker = startHistoryTracker();
    await expect(tracker.ready).rejects.toThrow('Unavailable storage');
    await browser.storage.local.set({ [HISTORY_LIMIT_KEY]: 2 });
    await tracker.flush();
    expect(
      readClosedTabs(browser.storage.local.data[HISTORY_KEY]),
    ).toHaveLength(4);
  });

  it('records concurrent closures without losing entries, preserving their original last access', async () => {
    const browser = fakeChrome([
      browserTab(),
      browserTab({ id: 2, url: 'https://other.example', lastAccessed: 50 }),
    ]);
    const tracker = startHistoryTracker();
    await tracker.ready;
    browser.tabs.onRemoved.emit(1);
    browser.tabs.onRemoved.emit(2);
    await tracker.flush();
    const history = readClosedTabs(browser.storage.local.data[HISTORY_KEY]);
    expect(history.map((tab) => tab.lastAccessed)).toEqual([100, 50]);
    expect(
      readHistorySession(browser.storage.session.data[SESSION_KEY]).openTabs,
    ).toEqual([]);
  });

  it('captures rapid create, navigate, and close events arriving during startup', async () => {
    const browser = fakeChrome();
    const tracker = startHistoryTracker();
    browser.tabs.onCreated.emit(browserTab());
    browser.tabs.onUpdated.emit(
      1,
      {},
      browserTab({ title: 'Updated', url: 'https://updated.example' }),
    );
    browser.tabs.onRemoved.emit(1);
    await tracker.flush();
    expect(
      readClosedTabs(browser.storage.local.data[HISTORY_KEY])[0],
    ).toMatchObject({ title: 'Updated', url: 'https://updated.example' });
  });

  it('retains local history and reconciles a vanished tab after the worker restarts', async () => {
    const browser = fakeChrome(
      [],
      { [HISTORY_KEY]: [closedTab({ url: 'https://older.example' })] },
      {
        [SESSION_KEY]: { openTabs: [openTab()], privateClosed: [] },
      },
    );
    await startHistoryTracker().ready;
    expect(
      readClosedTabs(browser.storage.local.data[HISTORY_KEY]).map(
        (tab) => tab.url,
      ),
    ).toEqual(
      expect.arrayContaining([
        'https://older.example',
        'https://example.com/docs',
      ]),
    );
  });

  it('keeps incognito closures only in session memory and reads them into the list', async () => {
    const browser = fakeChrome([browserTab({ incognito: true })]);
    const tracker = startHistoryTracker();
    await tracker.ready;
    browser.tabs.onRemoved.emit(1);
    await tracker.flush();
    expect(readClosedTabs(browser.storage.local.data[HISTORY_KEY])).toEqual([]);
    browser.tabs.query.mockResolvedValue([]);
    const snapshot = await getTabEntries();
    expect(snapshot.tabs).toHaveLength(1);
    expect(snapshot.tabs[0]).toMatchObject({ kind: 'closed', incognito: true });
  });

  it('tracks Chrome tab replacement without recording a false closure', async () => {
    const browser = fakeChrome([browserTab()]);
    const tracker = startHistoryTracker();
    await tracker.ready;
    browser.tabs.get.mockResolvedValue(
      browserTab({ id: 2, url: 'https://replaced.example' }),
    );
    browser.tabs.onReplaced.emit(2, 1);
    await tracker.flush();
    expect(readClosedTabs(browser.storage.local.data[HISTORY_KEY])).toEqual([]);
    expect(
      readHistorySession(browser.storage.session.data[SESSION_KEY]).openTabs[0]
        ?.id,
    ).toBe(2);
  });

  it('recovers the write queue after a storage failure', async () => {
    const browser = fakeChrome([
      browserTab(),
      browserTab({ id: 2, url: 'https://other.example' }),
    ]);
    const tracker = startHistoryTracker();
    await tracker.ready;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    browser.storage.local.set.mockRejectedValueOnce(
      new Error('Temporary storage failure'),
    );
    browser.tabs.onRemoved.emit(1);
    browser.tabs.onRemoved.emit(2);
    await tracker.flush();
    expect(
      readClosedTabs(browser.storage.local.data[HISTORY_KEY]),
    ).toHaveLength(2);
    expect(errorLog).toHaveBeenCalledOnce();
  });
});

describe('entry activation', () => {
  function activationBrowser() {
    const browser = {
      tabs: {
        update: vi.fn(async () => browserTab({ active: true })),
        create: vi.fn(async () => browserTab({ id: 2, active: true })),
        query: vi.fn(async () => [browserTab()]),
      },
      windows: {
        getLastFocused: vi.fn(async () => ({ id: 10, incognito: false })),
        get: vi.fn(async () => ({ id: 10, state: 'normal' })),
        update: vi.fn(async () => ({})),
        getAll: vi.fn(async () => []),
        create: vi.fn(async () => ({})),
      },
    };
    vi.stubGlobal('chrome', browser);
    return browser;
  }

  it('switches to an existing tab without creating a duplicate', async () => {
    const browser = activationBrowser();
    await activateEntry(openTab());
    expect(browser.tabs.update).toHaveBeenCalledWith(1, { active: true });
    expect(browser.tabs.create).not.toHaveBeenCalled();
  });

  it('opens a closed entry in a new active tab in the current window', async () => {
    const browser = activationBrowser();
    await activateEntry(closedTab());
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: 'https://example.com/docs',
      windowId: 10,
      active: true,
    });
    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(browser.windows.update).toHaveBeenCalledWith(10, { focused: true });
  });

  it('reopens a tab that closed between loading the list and clicking it', async () => {
    const browser = activationBrowser();
    browser.tabs.update.mockRejectedValueOnce(new Error('No tab'));
    browser.tabs.query.mockResolvedValue([]);
    await activateEntry(openTab());
    expect(browser.tabs.create).toHaveBeenCalledOnce();
  });

  it('does not create another tab when an existing tab fails to activate', async () => {
    const browser = activationBrowser();
    browser.tabs.update.mockRejectedValueOnce(
      new Error('Tabs cannot be edited right now'),
    );
    await expect(activateEntry(openTab())).rejects.toThrow('cannot be edited');
    expect(browser.tabs.create).not.toHaveBeenCalled();
  });

  it('reopens a private entry in an incognito window when no private window remains', async () => {
    const browser = activationBrowser();
    await activateEntry(closedTab({ incognito: true }));
    expect(browser.windows.create).toHaveBeenCalledWith({
      url: 'https://example.com/docs',
      incognito: true,
      focused: true,
    });
    expect(browser.tabs.create).not.toHaveBeenCalled();
  });
});
