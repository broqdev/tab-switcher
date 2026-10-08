import { useCallback, useEffect, useRef, useState } from 'react';
import { getTabEntries, type TabEntry } from './tabs';
import { HISTORY_KEY, SESSION_KEY } from './history';

export function useTabs() {
  const [tabs, setTabs] = useState<TabEntry[]>([]);
  const [currentTabId, setCurrentTabId] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const mounted = useRef(false);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++request.current;
    try {
      const snapshot = await getTabEntries();
      if (!mounted.current || version !== request.current) return;
      setTabs(snapshot.tabs);
      setCurrentTabId(snapshot.currentTabId);
      setError(undefined);
    } catch {
      if (!mounted.current || version !== request.current) return;
      setError('Could not load your tab history. Try again.');
    } finally {
      if (mounted.current && version === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const onChange = () => {
      void refresh();
    };
    const onStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (
        (area === 'local' && HISTORY_KEY in changes) ||
        (area === 'session' && SESSION_KEY in changes)
      )
        onChange();
    };
    chrome.storage.onChanged.addListener(onStorageChange);
    chrome.tabs.onCreated.addListener(onChange);
    chrome.tabs.onRemoved.addListener(onChange);
    chrome.tabs.onUpdated.addListener(onChange);
    chrome.tabs.onActivated.addListener(onChange);
    chrome.tabs.onAttached.addListener(onChange);
    chrome.tabs.onDetached.addListener(onChange);
    chrome.tabs.onMoved.addListener(onChange);
    chrome.tabs.onReplaced.addListener(onChange);
    chrome.windows.onFocusChanged.addListener(onChange);
    void refresh();

    return () => {
      mounted.current = false;
      request.current++;
      chrome.storage.onChanged.removeListener(onStorageChange);
      chrome.tabs.onCreated.removeListener(onChange);
      chrome.tabs.onRemoved.removeListener(onChange);
      chrome.tabs.onUpdated.removeListener(onChange);
      chrome.tabs.onActivated.removeListener(onChange);
      chrome.tabs.onAttached.removeListener(onChange);
      chrome.tabs.onDetached.removeListener(onChange);
      chrome.tabs.onMoved.removeListener(onChange);
      chrome.tabs.onReplaced.removeListener(onChange);
      chrome.windows.onFocusChanged.removeListener(onChange);
    };
  }, [refresh]);

  return { tabs, currentTabId, loading, error, refresh };
}
