import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  filterTabs,
  createTabSearcher,
  getTabEntries,
  getOpenTabs,
  normalizeTabs,
  sortByRecent,
  switchToTab,
  type OpenTab,
} from '../../lib/tabs';

const makeTab = (overrides: Partial<OpenTab> = {}): OpenTab => ({
  kind: 'open',
  key: `open-${overrides.id ?? 1}`,
  id: 1,
  windowId: 10,
  index: 0,
  title: 'TypeScript Handbook',
  url: 'https://www.typescriptlang.org/docs/handbook/intro.html',
  lastAccessed: 100,
  pinned: false,
  incognito: false,
  ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

describe('tab ordering and fuzzy search', () => {
  it('reuses one prepared snapshot across queries, modes, and history visibility', () => {
    const entries = [
      Object.freeze(
        makeTab({
          title: 'Café TypeScript Handbook',
          url: 'https://docs.example/caf%C3%A9',
        }),
      ),
      Object.freeze(
        makeTab({
          id: 2,
          title: 'Reference',
          url: 'https://x.com/home',
          lastAccessed: 200,
        }),
      ),
      Object.freeze({
        kind: 'closed' as const,
        key: 'closed-prepared',
        title: 'TypeScript notes',
        url: 'https://example.com/notes',
        lastAccessed: 300,
        closedAt: 400,
        incognito: false,
      }),
    ];
    const search = createTabSearcher(entries);
    for (let repetition = 0; repetition < 2; repetition++) {
      expect(search('typescrpt').map(({ entry }) => entry.key)).toEqual([
        'closed-prepared',
        'open-1',
      ]);
      expect(
        search('typescrpt', { showClosed: false }).map(
          ({ entry }) => entry.key,
        ),
      ).toEqual(['open-1']);
      expect(
        search('type', { mode: 'exact' }).map(({ entry }) => entry.key),
      ).toEqual(['closed-prepared', 'open-1']);
      const [cafe] = search('cafe', { mode: 'exact' });
      expect(cafe!.title.text.slice(...cafe!.title.ranges[0]!)).toBe('Café');
      expect(
        search('^Café', { mode: 'regex' }).map(({ entry }) => entry.key),
      ).toEqual(['open-1']);
      expect(search('x.com').map(({ entry }) => entry.key)).toEqual(['open-2']);
      expect(search('').map(({ entry }) => entry.key)).toEqual([
        'closed-prepared',
        'open-2',
        'open-1',
      ]);
      expect(() => search('[', { mode: 'regex' })).toThrow(SyntaxError);
    }
    const updated = createTabSearcher([
      makeTab({ title: 'Updated guide', url: 'https://example.org/updated' }),
    ]);
    expect(updated('typescrpt')).toEqual([]);
    expect(updated('updated')[0]!.entry.title).toBe('Updated guide');
    expect(search('typescrpt')).toHaveLength(2);
  });
  const tabs = [
    makeTab(),
    makeTab({
      id: 2,
      windowId: 20,
      title: 'TypeScript release notes',
      lastAccessed: 300,
    }),
    makeTab({
      id: 3,
      title:
        'A very long page title that happens to mention TypeScript much later than usual',
      url: 'https://example.com/learning',
      lastAccessed: 200,
    }),
    makeTab({
      id: 4,
      title: 'Recipes',
      url: 'https://food.example.com/pasta',
      lastAccessed: 0,
    }),
  ];

  it('sorts all windows by descending last access without mutating input', () => {
    expect(sortByRecent(tabs).map((tab) => tab.id)).toEqual([2, 3, 1, 4]);
    expect(tabs.map((tab) => tab.id)).toEqual([1, 2, 3, 4]);
  });

  it('uses deterministic window and tab position ties', () => {
    const tied = [
      makeTab({ id: 3, windowId: 20 }),
      makeTab({ id: 2, index: 1 }),
      makeTab(),
    ];
    expect(sortByRecent(tied).map((tab) => tab.id)).toEqual([1, 2, 3]);
  });

  it('shows all tabs for an empty or whitespace query', () => {
    expect(filterTabs(tabs, '   ').map((tab) => tab.id)).toEqual([2, 3, 1, 4]);
  });

  it('matches a mistyped title, case insensitively, and preserves recency', () => {
    expect(filterTabs(tabs, 'TYPESCRPT').map((tab) => tab.id)).toEqual([
      2, 3, 1,
    ]);
  });

  it('matches URLs including fragments well beyond the start of a field', () => {
    expect(filterTabs(tabs, 'handbook').map((tab) => tab.id)).toEqual([1, 2]);
  });

  it('allows separate terms to match title and URL', () => {
    expect(filterTabs(tabs, 'recipes pasta').map((tab) => tab.id)).toEqual([4]);
  });

  it.each(['fuzzy', 'exact', 'regex'] as const)(
    '%s search prioritizes title matches across open and closed entries',
    (mode) => {
      const entries = [
        makeTab({ id: 1, title: 'Alpha guide', lastAccessed: 100 }),
        makeTab({ id: 2, title: 'Alpha notes', lastAccessed: 300 }),
        makeTab({
          id: 3,
          title: 'Reference',
          url: 'https://example.org/alpha',
          lastAccessed: 900,
        }),
        {
          kind: 'closed' as const,
          key: 'closed-title',
          title: 'Alpha article',
          url: 'https://example.org/article',
          lastAccessed: 200,
          closedAt: 500,
          incognito: false,
        },
        {
          kind: 'closed' as const,
          key: 'closed-url',
          title: 'Archive',
          url: 'https://example.org/alpha-archive',
          lastAccessed: 800,
          closedAt: 1000,
          incognito: false,
        },
      ];
      expect(
        filterTabs(entries, 'alpha', { mode }).map((tab) => tab.key),
      ).toEqual(['open-2', 'closed-title', 'open-1', 'open-3', 'closed-url']);
      expect(
        filterTabs(entries, 'alpha', { mode, showClosed: false }).map(
          (tab) => tab.key,
        ),
      ).toEqual(['open-2', 'open-1', 'open-3']);
    },
  );

  it('prioritizes title matches before actual x.com hosts, subdomains, and incidental URLs', () => {
    const entries = [
      makeTab({
        id: 1,
        title: 'Home',
        url: 'https://x.com/home',
        lastAccessed: 100,
      }),
      makeTab({
        id: 2,
        title: 'Profile',
        url: 'https://mobile.x.com/user',
        lastAccessed: 300,
      }),
      makeTab({
        id: 3,
        title: 'x.com discussion',
        url: 'https://example.org/forum',
        lastAccessed: 900,
      }),
      makeTab({
        id: 4,
        title: 'Another site',
        url: 'https://notx.com/page',
        lastAccessed: 800,
      }),
      makeTab({
        id: 5,
        title: 'Redirect',
        url: 'https://example.org/?next=https://x.com/home',
        lastAccessed: 700,
      }),
      makeTab({
        id: 6,
        title: 'Unrelated',
        url: 'https://y.com/home',
        lastAccessed: 1000,
      }),
      makeTab({
        id: 7,
        title: 'Longer domain',
        url: 'https://x.company/home',
        lastAccessed: 1100,
      }),
      makeTab({
        id: 8,
        title: 'Explore',
        url: 'https://www.x.com/explore',
        lastAccessed: 200,
      }),
      {
        kind: 'closed' as const,
        key: 'closed-x',
        title: 'Saved post',
        url: 'https://x.com/saved',
        lastAccessed: 400,
        closedAt: 500,
        incognito: false,
      },
    ];
    expect(filterTabs(entries, 'X.COM').map((tab) => tab.key)).toEqual([
      'open-3',
      'closed-x',
      'open-2',
      'open-8',
      'open-1',
      'open-7',
      'open-4',
      'open-5',
    ]);
    expect(
      filterTabs(entries, 'x.com', { showClosed: false }).map((tab) => tab.key),
    ).toEqual([
      'open-3',
      'open-2',
      'open-8',
      'open-1',
      'open-7',
      'open-4',
      'open-5',
    ]);
    expect(filterTabs(entries, '').map((tab) => tab.key)).toEqual([
      'open-7',
      'open-6',
      'open-3',
      'open-4',
      'open-5',
      'closed-x',
      'open-2',
      'open-8',
      'open-1',
    ]);
  });

  it('ranks literal and fuzzy title matches above URL-only matches', () => {
    const entries = [
      makeTab({
        id: 1,
        title: 'Alpha guide',
        url: 'https://example.org/guide',
        lastAccessed: 100,
      }),
      makeTab({
        id: 2,
        title: 'Reference',
        url: 'https://example.org/alpha',
        lastAccessed: 200,
      }),
      makeTab({
        id: 3,
        title: 'Alphe guide',
        url: 'https://example.org/typo',
        lastAccessed: 900,
      }),
      makeTab({
        id: 4,
        title: 'Alphe directory',
        url: 'https://example.org/alpha',
        lastAccessed: 1000,
      }),
    ];
    expect(filterTabs(entries, 'alpha').map((tab) => tab.id)).toEqual([
      1, 4, 3, 2,
    ]);
    expect(
      filterTabs(entries, 'alpha', { mode: 'exact' }).map((tab) => tab.id),
    ).toEqual([1, 4, 2]);
  });

  it('requires all words and prioritizes more matching title terms over domain matches', () => {
    const entries = [
      makeTab({
        id: 1,
        title: 'Reseurch notes',
        url: 'https://x.com/notes',
        lastAccessed: 100,
      }),
      makeTab({
        id: 2,
        title: 'Research about x.com',
        url: 'https://example.org/notes',
        lastAccessed: 900,
      }),
      makeTab({
        id: 3,
        title: 'Home',
        url: 'https://x.com/home',
        lastAccessed: 1000,
      }),
    ];
    expect(filterTabs(entries, 'x.com research').map((tab) => tab.id)).toEqual([
      2, 1,
    ]);
  });

  it('ranks complete title matches above split title/URL matches and URL-only matches', () => {
    const entries = [
      makeTab({ id: 1, title: 'Alpha beta', lastAccessed: 100 }),
      makeTab({ id: 2, title: 'Alpha betu', lastAccessed: 200 }),
      makeTab({
        id: 3,
        title: 'Alpha',
        url: 'https://example.org/beta',
        lastAccessed: 900,
      }),
      makeTab({
        id: 4,
        title: 'Reference',
        url: 'https://example.org/alpha-beta',
        lastAccessed: 1000,
      }),
      makeTab({ id: 5, title: 'Alpha only', lastAccessed: 1100 }),
    ];
    expect(filterTabs(entries, 'alpha beta').map((tab) => tab.id)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it.each(['x.com/home', 'https://x.com/home'])(
    'prioritizes the actual URL host for address query %s',
    (query) => {
      const entries = [
        makeTab({
          id: 1,
          title: 'Home',
          url: 'https://x.com/home',
          lastAccessed: 100,
        }),
        makeTab({
          id: 2,
          title: 'Redirect',
          url: 'https://example.org/?next=https://x.com/home',
          lastAccessed: 900,
        }),
      ];
      expect(filterTabs(entries, query).map((tab) => tab.id)).toEqual([1, 2]);
    },
  );

  it('exact mode searches a literal phrase without typos or reordered terms', () => {
    expect(filterTabs(tabs, 'typescrpt', { mode: 'exact' })).toEqual([]);
    expect(
      filterTabs(tabs, ' TypeScript Handbook ', { mode: 'exact' }).map(
        (tab) => tab.id,
      ),
    ).toEqual([1]);
    expect(filterTabs(tabs, 'Handbook TypeScript', { mode: 'exact' })).toEqual(
      [],
    );
    expect(filterTabs(tabs, 'recipes pasta', { mode: 'exact' })).toEqual([]);
    expect(filterTabs(tabs, 'TypeScript.*', { mode: 'exact' })).toEqual([]);
    expect(
      filterTabs(tabs, '/docs/handbook', { mode: 'exact' }).map(
        (tab) => tab.id,
      ),
    ).toEqual([2, 1]);
  });

  it('exact mode retains case, accent, and full-width normalization', () => {
    const entries = [
      makeTab({
        title: 'Ｃａｆé Research',
        url: 'https://example.com/?topic=%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0',
      }),
    ];
    expect(filterTabs(entries, 'CAFE research', { mode: 'exact' })).toEqual(
      entries,
    );
    expect(filterTabs(entries, '机器学习', { mode: 'exact' })).toEqual(entries);
  });

  it('regex mode supports anchors, alternatives, and URLs while preserving recency', () => {
    expect(
      filterTabs(tabs, '^TypeScript (Handbook|release notes)$', {
        mode: 'regex',
      }).map((tab) => tab.id),
    ).toEqual([2, 1]);
    expect(
      filterTabs(tabs, 'food\\.example\\.com/pasta$', { mode: 'regex' }).map(
        (tab) => tab.id,
      ),
    ).toEqual([4]);
    expect(
      filterTabs(tabs, '^\\S+\\sHandbook$', { mode: 'regex' }).map(
        (tab) => tab.id,
      ),
    ).toEqual([1]);
    expect(
      filterTabs(tabs, ' Handbook$', { mode: 'regex' }).map((tab) => tab.id),
    ).toEqual([1]);
  });

  it('regex mode uses Unicode semantics and readable URLs without normalizing the pattern', () => {
    const entries = [
      makeTab({
        title: 'Research Library',
        url: 'https://example.com/?topic=%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0',
      }),
    ];
    expect(filterTabs(entries, '\\p{Script=Han}+', { mode: 'regex' })).toEqual(
      entries,
    );
    expect(
      filterTabs(entries, '^research\\sLIBRARY$', { mode: 'regex' }),
    ).toEqual(entries);
    expect(() => filterTabs(entries, '[', { mode: 'regex' })).toThrow(
      SyntaxError,
    );
  });

  it('can hide closed entries in all search modes without mutating the history', () => {
    const entries = [
      makeTab(),
      {
        kind: 'closed' as const,
        key: 'closed-test',
        title: 'TypeScript Handbook',
        url: 'https://example.com/handbook',
        lastAccessed: 200,
        closedAt: 300,
        incognito: false,
      },
    ];
    for (const mode of ['fuzzy', 'exact', 'regex'] as const) {
      expect(
        filterTabs(entries, 'handbook', { mode }).map((tab) => tab.key),
      ).toEqual(['closed-test', 'open-1']);
      expect(
        filterTabs(entries, 'handbook', { mode, showClosed: false }).map(
          (tab) => tab.key,
        ),
      ).toEqual(['open-1']);
      expect(
        filterTabs(entries, '', { mode, showClosed: false }).map(
          (tab) => tab.key,
        ),
      ).toEqual(['open-1']);
      expect(filterTabs(entries, '', { mode })).toHaveLength(2);
    }
    expect(entries).toHaveLength(2);
    expect(entries[1]?.kind).toBe('closed');
  });

  it('returns no matches for unrelated text', () => {
    expect(filterTabs(tabs, 'zzzzzzzzzzzzzzzz')).toEqual([]);
  });

  it('requires an exact substring for short terms instead of accepting one-letter changes', () => {
    const entries = [
      makeTab({ id: 1, title: 'Cat Photos', url: 'https://example.com/cats' }),
      makeTab({
        id: 2,
        title: 'Car Insurance',
        url: 'https://example.com/cars',
      }),
      makeTab({
        id: 3,
        title: 'Subquadratic Attention',
        url: 'https://example.com/papers',
      }),
    ];
    expect(filterTabs(entries, 'cat').map((tab) => tab.id)).toEqual([1]);
    expect(filterTabs(entries, 'car').map((tab) => tab.id)).toEqual([2]);
  });

  it('does not correct numeric identifiers to a different paper or version', () => {
    const entries = [
      makeTab({
        id: 1,
        title: '[2610.04518] Length Generalization',
        url: 'https://arxiv.org/abs/2610.04518',
      }),
      makeTab({
        id: 2,
        title: '[2610.06783v1] Truly Subquadratic Attention',
        url: 'https://arxiv.org/abs/2610.06783',
      }),
    ];
    expect(filterTabs(entries, '2610.04518').map((tab) => tab.id)).toEqual([1]);
    expect(filterTabs(entries, '2610.99999')).toEqual([]);
  });

  it('searches both readable and original percent-encoded URL text', () => {
    const entries = [
      makeTab({
        title: 'Research Library',
        url: 'https://example.com/?topic=%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0',
      }),
    ];
    expect(filterTabs(entries, 'library 机器学习')).toEqual(entries);
    expect(filterTabs(entries, '%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0')).toEqual(
      entries,
    );
    expect(filterTabs(entries, 'library 深度学习')).toEqual([]);
  });

  it('matches a whole pasted URL rather than accepting matching 32-character chunks', () => {
    const target =
      'https://example.com/research/library/machine-learning-notes';
    const entries = [
      makeTab({ id: 1, title: 'Research Library', url: target }),
      makeTab({
        id: 2,
        title: 'Research Library',
        url: 'https://example.com/research/library/machine-learning-other',
      }),
    ];
    expect(filterTabs(entries, target).map((tab) => tab.id)).toEqual([1]);
    expect(filterTabs(entries, target.replace('notes', 'missing'))).toEqual([]);
  });

  it('normalizes accents and compatibility characters in the query and fields', () => {
    const entries = [
      makeTab({
        title: 'Ｃａｆé · ＴｙｐｅＳｃｒｉｐｔ Guide',
        url: 'https://example.com/reading',
      }),
    ];
    expect(filterTabs(entries, 'cafe typescrpt')).toEqual(entries);
    expect(filterTabs(entries, 'ＴＹＰＥＳＣＲＩＰＴ　café')).toEqual(entries);
  });

  it('tolerates an invalid percent escape without breaking other search terms', () => {
    const entries = [
      makeTab({ title: 'Research Guide', url: 'https://example.com/100%done' }),
    ];
    expect(filterTabs(entries, 'research')).toEqual(entries);
    expect(filterTabs(entries, '100%done')).toEqual(entries);
  });

  it('handles missing titles, pending URLs, invalid timestamps, and unassigned IDs', () => {
    const browserTabs = [
      {
        id: 1,
        windowId: 10,
        index: 0,
        pinned: true,
        incognito: false,
        pendingUrl: 'https://pending.example',
        lastAccessed: NaN,
      },
      {
        id: 2,
        windowId: 20,
        index: 0,
        pinned: false,
        incognito: true,
        title: '   ',
        lastAccessed: -1,
      },
      { id: -1, windowId: 20 },
      { windowId: 20 },
    ] as chrome.tabs.Tab[];
    const normalized = normalizeTabs(browserTabs);
    expect(normalized).toHaveLength(2);
    expect(normalized[0]).toMatchObject({
      title: 'https://pending.example',
      url: 'https://pending.example',
      lastAccessed: 0,
      pinned: true,
    });
    expect(normalized[1]).toMatchObject({
      title: 'Untitled tab',
      url: '',
      lastAccessed: 0,
      incognito: true,
    });
  });
});

describe('Chrome integration', () => {
  it('does not access closed storage when history is hidden', async () => {
    const get = vi
      .fn()
      .mockRejectedValue(new Error('Storage should not be read'));
    vi.stubGlobal('chrome', {
      tabs: {
        query: vi.fn().mockResolvedValue([{ ...makeTab(), active: true }]),
      },
      windows: { getLastFocused: vi.fn().mockResolvedValue({ id: 10 }) },
      storage: { local: { get }, session: { get } },
    });
    const snapshot = await getTabEntries(false);
    expect(snapshot.tabs.map((tab) => tab.key)).toEqual(['open-1']);
    expect(get).not.toHaveBeenCalled();
  });

  it('reads current history when it is included and propagates storage failures', async () => {
    const closed = {
      kind: 'closed',
      key: 'closed-current',
      title: 'Saved',
      url: 'https://example.com/saved',
      lastAccessed: 300,
      closedAt: 400,
      incognito: false,
    };
    const get = vi.fn().mockResolvedValue({ closedTabHistory: [closed] });
    vi.stubGlobal('chrome', {
      tabs: {
        query: vi.fn().mockResolvedValue([{ ...makeTab(), active: true }]),
      },
      windows: { getLastFocused: vi.fn().mockResolvedValue({ id: 10 }) },
      storage: {
        local: { get },
        session: { get: vi.fn().mockResolvedValue({}) },
      },
    });
    expect((await getTabEntries()).tabs.map((tab) => tab.key)).toEqual([
      'closed-current',
      'open-1',
    ]);
    get.mockRejectedValue(new Error('Storage unavailable'));
    await expect(getTabEntries()).rejects.toThrow('Storage unavailable');
  });
  it('queries all windows and identifies only the active tab in the last focused window as current', async () => {
    const query = vi.fn().mockResolvedValue([
      { ...makeTab(), active: true },
      { ...makeTab({ id: 2, windowId: 20, lastAccessed: 200 }), active: true },
    ]);
    vi.stubGlobal('chrome', {
      tabs: { query },
      windows: { getLastFocused: vi.fn().mockResolvedValue({ id: 20 }) },
    });
    const snapshot = await getOpenTabs();
    expect(query).toHaveBeenCalledWith({});
    expect(snapshot.currentTabId).toBe(2);
    expect(snapshot.tabs.map((tab) => tab.id)).toEqual([2, 1]);
  });

  it('activates the tab and focuses its actual window after a move', async () => {
    const updateTab = vi.fn().mockResolvedValue({ id: 1, windowId: 99 });
    const updateWindow = vi.fn().mockResolvedValue({ id: 99 });
    vi.stubGlobal('chrome', {
      tabs: { update: updateTab },
      windows: {
        get: vi.fn().mockResolvedValue({ state: 'maximized' }),
        update: updateWindow,
      },
    });
    await switchToTab(1);
    expect(updateTab).toHaveBeenCalledWith(1, { active: true });
    expect(updateWindow).toHaveBeenCalledWith(99, { focused: true });
    expect(updateTab.mock.invocationCallOrder[0]).toBeLessThan(
      updateWindow.mock.invocationCallOrder[0]!,
    );
  });

  it('restores a minimized target window', async () => {
    const updateWindow = vi.fn().mockResolvedValue({ id: 10 });
    vi.stubGlobal('chrome', {
      tabs: { update: vi.fn().mockResolvedValue({ windowId: 10 }) },
      windows: {
        get: vi.fn().mockResolvedValue({ state: 'minimized' }),
        update: updateWindow,
      },
    });
    await switchToTab(1);
    expect(updateWindow).toHaveBeenCalledWith(10, {
      focused: true,
      state: 'normal',
    });
  });

  it('propagates errors when the tab has already closed', async () => {
    const updateWindow = vi.fn();
    vi.stubGlobal('chrome', {
      tabs: {
        update: vi.fn().mockRejectedValue(new Error('No tab with id: 1')),
      },
      windows: { update: updateWindow },
    });
    await expect(switchToTab(1)).rejects.toThrow('No tab');
    expect(updateWindow).not.toHaveBeenCalled();
  });
});
