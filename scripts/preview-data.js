// Browser-only fixtures. This file is never bundled into the extension.
(() => {
  const now = Date.now();
  const samples = [
    [
      '(99+ 封私信) 贝尔曼策略优化',
      'https://www.zhihu.com/question/123456',
      'open',
    ],
    [
      'Stabilizing Reinforcement Learning',
      'https://arxiv.org/abs/2610.01234',
      'open',
    ],
    [
      '[2610.04518] Length Generalization',
      'https://arxiv.org/abs/2610.04518',
      'closed',
    ],
    [
      'mlc-ai/kcoral: Lightweight Benchmark',
      'https://github.com/mlc-ai/kcoral',
      'open',
    ],
    [
      'MLC | KCoral: Lightweight Benchmark',
      'https://example.com/kcoral',
      'open',
    ],
    [
      '[2606.19802] Flow Map Denoising',
      'https://arxiv.org/abs/2606.19802',
      'closed',
    ],
    ['LoGo', 'https://example.com/logo', 'open'],
    [
      '[2610.06783v1] Truly Subquadratic Attention',
      'https://arxiv.org/abs/2610.06783',
      'open',
    ],
    [
      '[2610.02726] SymRegFlow: Symbolic Regression',
      'https://arxiv.org/abs/2610.02726',
      'closed',
    ],
    [
      'Research: Qwen3.8 27B additions',
      'https://example.com/research/qwen',
      'open',
    ],
    [
      'briaai/fibo-scene-analyzer - Hugging Face',
      'https://huggingface.co/briaai/fibo-scene-analyzer',
      'open',
    ],
    [
      'Paper page - Rollout-Marginal',
      'https://huggingface.co/papers/2610.01235',
      'closed',
    ],
    [
      'texel-org/windfoil-paper: code',
      'https://github.com/texel-org/windfoil-paper',
      'open',
    ],
    [
      'rehan-remade/universal-memory',
      'https://github.com/rehan-remade/universal-memory',
      'closed',
    ],
    [
      '[2610.01742] World Motion Models',
      'https://arxiv.org/abs/2610.01742',
      'open',
    ],
  ];
  let nextId = 100;
  const tabs = samples.flatMap(([title, url, kind], index) =>
    kind === 'open'
      ? [
          {
            id: index + 1,
            windowId: index < 7 ? 1 : 2,
            index,
            title,
            url,
            lastAccessed: now - index * 60_000,
            pinned: false,
            incognito: false,
            active: index === 0,
          },
        ]
      : [],
  );
  const closed = samples.flatMap(([title, url, kind], index) =>
    kind === 'closed'
      ? [
          {
            kind,
            key: `closed-preview-${index}`,
            title,
            url,
            lastAccessed: now - index * 60_000,
            closedAt: now - index * 30_000,
            incognito: false,
          },
        ]
      : [],
  );
  const event = () => {
    const listeners = new Set();
    return {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
      emit: (...args) => listeners.forEach((listener) => listener(...args)),
    };
  };
  const tabEvents = Object.fromEntries(
    [
      'onCreated',
      'onRemoved',
      'onUpdated',
      'onActivated',
      'onAttached',
      'onDetached',
      'onMoved',
      'onReplaced',
    ].map((name) => [name, event()]),
  );
  const windows = [1, 2].map((id) => ({
    id,
    focused: id === 1,
    state: 'normal',
    type: 'normal',
    incognito: false,
  }));
  const focusEvent = event();
  const storageEvent = event();
  const preferenceKey = 'tab-switcher-preview-show-closed';
  const historyLimitKey = 'tab-switcher-preview-history-limit';
  const readHistoryLimit = (value = localStorage.getItem(historyLimitKey)) => {
    const limit = value === null ? undefined : Number(value);
    return Number.isInteger(limit) && limit >= 1 && limit <= 10_000
      ? limit
      : undefined;
  };
  const readPreference = (value = localStorage.getItem(preferenceKey)) =>
    value === 'true' ? true : value === 'false' ? false : undefined;
  window.addEventListener('storage', (change) => {
    if (change.key === historyLimitKey || change.key === null)
      storageEvent.emit(
        {
          historyLimit: {
            oldValue: readHistoryLimit(change.oldValue),
            newValue: readHistoryLimit(),
          },
          closedTabHistory: {
            newValue: structuredClone(
              closed.slice(0, readHistoryLimit() ?? 10_000),
            ),
          },
        },
        'local',
      );
    if (change.key !== preferenceKey && change.key !== null) return;
    storageEvent.emit(
      {
        showClosedTabs: {
          oldValue: readPreference(change.oldValue),
          newValue: readPreference(),
        },
      },
      'local',
    );
  });
  const activate = (tab) => {
    for (const item of tabs)
      if (item.windowId === tab.windowId) item.active = item.id === tab.id;
    tab.lastAccessed = Date.now();
    tabEvents.onActivated.emit({ tabId: tab.id, windowId: tab.windowId });
  };
  window.chrome = {
    commands: {
      getAll: async () => [{ name: '_execute_action', shortcut: '' }],
    },
    runtime: {
      getURL: (path) => new URL(path, location.origin).href,
    },
    tabs: {
      ...tabEvents,
      query: async () => structuredClone(tabs),
      get: async (id) => structuredClone(tabs.find((tab) => tab.id === id)),
      update: async (id) => {
        const tab = tabs.find((item) => item.id === id);
        if (!tab) throw new Error('Unknown preview tab');
        activate(tab);
        return structuredClone(tab);
      },
      create: async ({ url, windowId }) => {
        if (url === 'chrome://extensions/shortcuts') {
          window.alert(
            'Chrome manages keyboard shortcuts. In the installed extension, this button opens chrome://extensions/shortcuts.',
          );
          return;
        }
        const sample = samples.find((entry) => entry[1] === url);
        const tab = {
          id: nextId++,
          windowId,
          index: tabs.length,
          title: sample?.[0] || url,
          url,
          lastAccessed: Date.now(),
          active: true,
          pinned: false,
          incognito: false,
        };
        tabs.push(tab);
        activate(tab);
        tabEvents.onCreated.emit(structuredClone(tab));
        return structuredClone(tab);
      },
    },
    windows: {
      onFocusChanged: focusEvent,
      getLastFocused: async () =>
        structuredClone(windows.find((item) => item.focused)),
      getAll: async () => structuredClone(windows),
      get: async (id) =>
        structuredClone(windows.find((item) => item.id === id)),
      update: async (id) => {
        for (const item of windows) item.focused = item.id === id;
        focusEvent.emit(id);
        return structuredClone(windows.find((item) => item.id === id));
      },
    },
    storage: {
      onChanged: storageEvent,
      local: {
        get: async () => ({
          closedTabHistory: structuredClone(
            closed.slice(0, readHistoryLimit() ?? 10_000),
          ),
          historyLimit: readHistoryLimit(),
          showClosedTabs: readPreference(),
        }),
        set: async (values) => {
          const changes = {};
          if (typeof values.showClosedTabs === 'boolean') {
            const oldValue = readPreference();
            localStorage.setItem(preferenceKey, String(values.showClosedTabs));
            changes.showClosedTabs = {
              oldValue,
              newValue: values.showClosedTabs,
            };
          }
          if (
            Number.isInteger(values.historyLimit) &&
            values.historyLimit >= 1 &&
            values.historyLimit <= 10_000
          ) {
            const oldValue = readHistoryLimit();
            localStorage.setItem(historyLimitKey, String(values.historyLimit));
            changes.historyLimit = { oldValue, newValue: values.historyLimit };
            changes.closedTabHistory = {
              newValue: structuredClone(closed.slice(0, values.historyLimit)),
            };
          }
          if (Object.keys(changes).length) storageEvent.emit(changes, 'local');
        },
      },
      session: { get: async () => ({}) },
    },
  };
  // Keep the preview visible after selecting a row or pressing Escape.
  window.close = () => {};
})();
