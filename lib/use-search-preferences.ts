import { useCallback, useEffect, useRef, useState } from 'react';
import type { SearchMode } from './tabs';

export interface SearchPreferences {
  searchMode: SearchMode;
  showClosedTabs: boolean;
}

const KEYS = ['searchMode', 'showClosedTabs'] as const;
const DEFAULTS: SearchPreferences = {
  searchMode: 'fuzzy',
  showClosedTabs: true,
};

function normalize(
  values: Partial<Record<keyof SearchPreferences, unknown>>,
): Partial<SearchPreferences> {
  const next: Partial<SearchPreferences> = {};
  if ('searchMode' in values)
    next.searchMode =
      values.searchMode === 'exact' || values.searchMode === 'regex'
        ? values.searchMode
        : 'fuzzy';
  if ('showClosedTabs' in values)
    next.showClosedTabs =
      typeof values.showClosedTabs === 'boolean' ? values.showClosedTabs : true;
  return next;
}

export function useSearchPreferences() {
  const [preferences, setPreferences] = useState(DEFAULTS);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const saved = useRef(DEFAULTS);
  const revisions = useRef({ searchMode: 0, showClosedTabs: 0 });
  const mounted = useRef(false);
  const busy = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    const loaded = new Set<keyof SearchPreferences>();
    const apply = (
      values: Partial<Record<keyof SearchPreferences, unknown>>,
    ) => {
      const next = normalize(values);
      const keys = KEYS.filter((key) => key in next);
      if (!keys.length) return;
      for (const key of keys) {
        loaded.add(key);
        revisions.current[key]++;
      }
      saved.current = { ...saved.current, ...next };
      setPreferences((current) => ({ ...current, ...next }));
      setReady(loaded.size === KEYS.length);
      setError(undefined);
    };
    // A live change protects only its own field from the initial snapshot.
    const unread = (values: Record<string, unknown> = {}) =>
      Object.fromEntries(
        KEYS.filter((key) => !loaded.has(key)).map((key) => [key, values[key]]),
      );
    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'local') return;
      apply(
        Object.fromEntries(
          KEYS.filter((key) => key in changes).map((key) => [
            key,
            changes[key]?.newValue,
          ]),
        ),
      );
    };
    chrome.storage.onChanged.addListener(onChange);
    void chrome.storage.local
      .get([...KEYS])
      .then((values) => {
        if (active) apply(unread(values));
      })
      .catch(() => {
        if (!active || loaded.size === KEYS.length) return;
        apply(unread());
        setError('Could not load this preference. Try toggling it again.');
      });
    return () => {
      active = false;
      mounted.current = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);

  const updatePreferences = useCallback(
    async (changes: Partial<SearchPreferences>) => {
      if (!ready || busy.current) return;
      const next = normalize(changes);
      if (!Object.keys(next).length) return;
      busy.current = true;
      const beforeWrite = { ...revisions.current };
      setPreferences((current) => ({ ...current, ...next }));
      setSaving(true);
      setError(undefined);
      try {
        // Write only changed fields so another window's preferences stay intact.
        await chrome.storage.local.set(next);
        if (
          next.searchMode !== undefined &&
          revisions.current.searchMode === beforeWrite.searchMode
        ) {
          saved.current = { ...saved.current, searchMode: next.searchMode };
        }
        if (
          next.showClosedTabs !== undefined &&
          revisions.current.showClosedTabs === beforeWrite.showClosedTabs
        ) {
          saved.current = {
            ...saved.current,
            showClosedTabs: next.showClosedTabs,
          };
        }
      } catch {
        if (mounted.current) {
          setPreferences(saved.current);
          setError('Could not save this preference. Try again.');
        }
      } finally {
        busy.current = false;
        if (mounted.current) setSaving(false);
      }
    },
    [ready],
  );

  return { ...preferences, ready, saving, error, updatePreferences };
}
