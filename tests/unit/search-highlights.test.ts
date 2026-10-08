import { describe, expect, it } from 'vitest';
import { searchTabs, type OpenTab } from '../../lib/tabs';
import { matchExcerpt, type MatchedText } from '../../lib/search-text';

const tab = (overrides: Partial<OpenTab> = {}): OpenTab => ({
  kind: 'open',
  key: 'open-1',
  id: 1,
  windowId: 1,
  index: 0,
  title: 'TypeScript Handbook',
  url: 'https://example.org/reading',
  lastAccessed: 100,
  pinned: false,
  incognito: false,
  ...overrides,
});
const highlights = ({ text, ranges }: MatchedText) =>
  ranges.map(([start, end]) => text.slice(start, end));

describe('search highlights', () => {
  it('highlights literal occurrences without unrelated fuzzy characters', () => {
    const [result] = searchTabs(
      [tab({ title: 'Alpha alphabet Alpha' })],
      'alpha',
    );
    expect(highlights(result!.title)).toEqual(['Alpha', 'alpha', 'Alpha']);
  });

  it('highlights the matching characters around a typo', () => {
    const [result] = searchTabs([tab()], 'typescrpt');
    expect(highlights(result!.title)).toEqual(['TypeScr', 'pt']);
    expect(result!.title.text).toBe('TypeScript Handbook');
  });

  it('maps normalization back to full-width letters, accents, ligatures, and emoji offsets', () => {
    const [result] = searchTabs(
      [tab({ title: '🙂 Ｃａｆe\u0301 ﬃ Research' })],
      'cafe ffi',
    );
    expect(highlights(result!.title)).toEqual(['Ｃａｆe\u0301', 'ﬃ']);
    const [exact] = searchTabs(
      [tab({ title: '🙂 Ｃａｆé Research' })],
      'cafe',
      { mode: 'exact' },
    );
    expect(highlights(exact!.title)).toEqual(['Ｃａｆé']);
  });

  it('merges overlapping word matches into one highlight', () => {
    const [result] = searchTabs([tab({ title: 'Banana' })], 'ana nana');
    expect(highlights(result!.title)).toEqual(['anana']);
  });

  it('highlights an exact phrase and every regex occurrence', () => {
    const entries = [tab({ title: 'Alpha beta Alpha' })];
    const [exact] = searchTabs(entries, 'ALPHA BETA', { mode: 'exact' });
    expect(highlights(exact!.title)).toEqual(['Alpha beta']);
    const [regex] = searchTabs(entries, 'alpha|beta', { mode: 'regex' });
    expect(highlights(regex!.title)).toEqual(['Alpha', 'beta', 'Alpha']);
  });

  it.each(['fuzzy', 'exact', 'regex'] as const)(
    'highlights readable URL text in %s mode',
    (mode) => {
      const [result] = searchTabs(
        [
          tab({
            url: 'https://example.org/?topic=%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0',
          }),
        ],
        '机器学习',
        { mode },
      );
      expect(result!.url.text).toBe('https://example.org/?topic=机器学习');
      expect(highlights(result!.url)).toEqual(['机器学习']);
    },
  );

  it('retains encoded URL text when it covers more of the query', () => {
    const url =
      'https://example.org/?topic=%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0';
    const [result] = searchTabs(
      [tab({ url })],
      'example %E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0',
    );
    expect(result!.url.text).toBe(url);
    expect(highlights(result!.url)).toEqual([
      'example',
      '%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0',
    ]);
  });

  it('handles malformed URL encoding without losing matches', () => {
    const [result] = searchTabs(
      [tab({ url: 'https://example.org/%ZZ/notes' })],
      'notes',
    );
    expect(highlights(result!.url)).toEqual(['notes']);
  });

  it('highlights closed entries and preserves title-first ordering', () => {
    const closed = {
      kind: 'closed' as const,
      key: 'closed-1',
      title: 'Alpha article',
      url: 'https://example.org/article',
      lastAccessed: 10,
      closedAt: 20,
      incognito: false,
    };
    const results = searchTabs(
      [tab({ url: 'https://example.org/alpha' }), closed],
      'alpha',
    );
    expect(results.map(({ entry }) => entry.key)).toEqual([
      'closed-1',
      'open-1',
    ]);
    expect(highlights(results[0]!.title)).toEqual(['Alpha']);
    expect(highlights(results[1]!.url)).toEqual(['alpha']);
  });

  it.each(['fuzzy', 'exact', 'regex'] as const)(
    'clearing %s search removes all highlights',
    (mode) => {
      const [result] = searchTabs([tab()], '', { mode });
      expect(result!.title.ranges).toEqual([]);
      expect(result!.url.ranges).toEqual([]);
    },
  );

  it('keeps zero-width regex results without empty highlights or infinite loops', () => {
    const [result] = searchTabs([tab()], '^|(?=a)|$', { mode: 'regex' });
    expect(result!.entry.id).toBe(1);
    expect(result!.title.ranges).toEqual([]);
    expect(result!.url.ranges).toEqual([]);
    expect(() => searchTabs([tab()], '[', { mode: 'regex' })).toThrow(
      SyntaxError,
    );
    const [emoji] = searchTabs([tab({ title: '🙂🙂' })], '.', {
      mode: 'regex',
    });
    expect(highlights(emoji!.title)).toEqual(['🙂🙂']);
  });

  it('brings a deep URL match into the visible excerpt without breaking emoji', () => {
    const [result] = searchTabs(
      [tab({ url: `https://example.org/${'🙂'.repeat(40)}/notes` })],
      'notes',
    );
    const excerpt = matchExcerpt(result!.url, 16);
    expect(excerpt.text.startsWith('…🙂')).toBe(true);
    expect(highlights(excerpt)).toEqual(['notes']);
    expect(excerpt.ranges[0]![0]).toBeLessThanOrEqual(19);
  });
});
