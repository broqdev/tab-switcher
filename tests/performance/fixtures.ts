import type { ClosedTab } from '../../lib/history';
import type { OpenTab, TabEntry } from '../../lib/tabs';

export const scenarios = [
  { name: 'small', open: 20, closed: 50 },
  { name: 'medium', open: 200, closed: 1_000 },
  { name: 'huge', open: 200, closed: 10_000 },
  { name: 'open-only', open: 200, closed: 0 },
] as const;

export const queries = [
  { name: 'broad', text: 't', categories: [0, 1, 2, 3, 4, 5, 6, 7] },
  { name: 'typo', text: 'typescrpt', categories: [0, 1] },
  { name: 'multi-term', text: 'typescrpt handbook', categories: [0] },
  { name: 'domain', text: 'x.com', categories: [2] },
  { name: 'unicode', text: 'cafe', categories: [3] },
  { name: 'no-match', text: 'qzxwvqzxwv', categories: [] },
];

const templates = [
  [
    'TypeScript Handbook — Generics and Utility Types',
    'www.typescriptlang.org',
  ],
  ['Release notes and compiler updates', 'www.typescriptlang.org'],
  ['Research discussion and project announcements', 'x.com'],
  ['Café recipes — Crème brûlée and seasonal menus', 'recipes.example.org'],
  ['[2610.04518] Length Generalization in Neural Networks', 'arxiv.org'],
  ['React component library · Pull requests · GitHub', 'github.com'],
  [
    'Chrome developer documentation — Performance tools',
    'developer.chrome.com',
  ],
  [
    'A long project title with Unicode 日本語 and an encoded URL',
    'papers.example.org',
  ],
] as const;

// Fixed timestamps, unique URLs, and a deterministic permutation. Hidden and
// shown runs receive exactly the same stored history. Never uses real browsing data.
export function makeFixture(scenario: (typeof scenarios)[number]) {
  const epoch = 1_800_000_000_000;
  const make = (kind: 'open' | 'closed', i: number) => {
    const [title, host] = templates[i % templates.length]!;
    return {
      kind,
      key: `${kind}-${i + 1}`,
      title: `${title} · ${i + 1}`,
      url: `https://${host}/${kind}/${i + 1}?section=${i % 8 === 7 ? '%E6%97%A5%E6%9C%AC%E8%AA%9E' : 'overview'}`,
      lastAccessed: epoch - i * 60_000 - (kind === 'closed' ? 30_000 : 0),
      incognito: false,
    };
  };
  const open: OpenTab[] = Array.from({ length: scenario.open }, (_, i) => ({
    ...make('open', i),
    kind: 'open',
    id: i + 1,
    windowId: (i % 4) + 1,
    index: Math.floor(i / 4),
    pinned: false,
  }));
  const closed: ClosedTab[] = Array.from(
    { length: scenario.closed },
    (_, i) => ({
      ...make('closed', i),
      kind: 'closed',
      closedAt: epoch - i * 60_000,
    }),
  );
  // Odd/even split avoids benchmarking only already sorted input.
  const entries: TabEntry[] = [...closed, ...open];
  const shuffled = entries
    .filter((_, i) => i % 2)
    .concat(entries.filter((_, i) => !(i % 2)));
  const nativeTabs = open.map((tab) => ({
    ...tab,
    active: tab.id === 1,
    highlighted: tab.id === 1,
    selected: tab.id === 1,
    status: 'complete',
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
  }));
  return { open, closed, entries: shuffled, nativeTabs };
}

// An independent oracle for these deliberately disjoint templates; not a call
// back into the production search implementation being measured.
export function expectedKeys(
  entries: TabEntry[],
  query: string,
  showClosed: boolean,
) {
  const categories = queries.find((item) => item.text === query)?.categories;
  if (query && !categories) throw new Error(`No fixture oracle for ${query}`);
  return entries
    .filter((entry) => {
      const category = (Number(entry.key.split('-')[1]) - 1) % templates.length;
      return (
        (showClosed || entry.kind === 'open') &&
        (!query || categories!.includes(category))
      );
    })
    .map((entry) => entry.key)
    .sort();
}
