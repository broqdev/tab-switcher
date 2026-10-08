import { useCallback, useEffect, useRef, useState } from 'react';

export const SHOW_CLOSED_KEY = 'showClosedTabs';

export function useShowClosed() {
  const [showClosed, setValue] = useState(true);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const savedValue = useRef(true);
  const revision = useRef(0);
  const mounted = useRef(false);
  const busy = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    let changed = false;
    const apply = (value: unknown) => {
      const checked = typeof value === 'boolean' ? value : true;
      savedValue.current = checked;
      revision.current++;
      setValue(checked);
      setReady(true);
    };
    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'local' || !(SHOW_CLOSED_KEY in changes)) return;
      changed = true;
      apply(changes[SHOW_CLOSED_KEY]?.newValue);
    };
    // Subscribe first so a change in another popup wins over a stale read.
    chrome.storage.onChanged.addListener(onChange);
    void chrome.storage.local
      .get(SHOW_CLOSED_KEY)
      .then((values) => {
        if (active && !changed) apply(values[SHOW_CLOSED_KEY]);
      })
      .catch(() => {
        if (!active || changed) return;
        apply(undefined);
        setError('Could not load this preference. Try toggling it again.');
      });
    return () => {
      active = false;
      mounted.current = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);

  const setShowClosed = useCallback(
    async (checked: boolean) => {
      if (!ready || busy.current) return;
      busy.current = true;
      const beforeWrite = revision.current;
      setValue(checked);
      setSaving(true);
      setError(undefined);
      try {
        await chrome.storage.local.set({ [SHOW_CLOSED_KEY]: checked });
        if (revision.current === beforeWrite) savedValue.current = checked;
      } catch {
        if (mounted.current) {
          setValue(savedValue.current);
          setError('Could not save this preference. Try again.');
        }
      } finally {
        busy.current = false;
        if (mounted.current) setSaving(false);
      }
    },
    [ready],
  );

  return { showClosed, ready, saving, error, setShowClosed };
}
