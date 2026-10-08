import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  searchTabs,
  activateEntry,
  type TabEntry,
  type SearchMode,
} from '../../lib/tabs';
import { matchExcerpt, type MatchedText } from '../../lib/search-text';
import { useTabs } from '../../lib/use-tabs';
import {
  useSearchPreferences,
  type SearchPreferences,
} from '../../lib/use-search-preferences';
import Settings from '../../components/settings/Settings';

function HighlightedText({ text, ranges }: MatchedText) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    parts.push(text.slice(cursor, start));
    parts.push(
      <mark className="search-match" key={`${start}-${end}`}>
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function SearchIcon() {
  // Chromium's tab-search:search-old icon; see THIRD_PARTY_NOTICES.
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10.8619 10.2981L10.6177 10.0578C11.484 9.05905 12.0874 7.68174 12.0874 5.97468C12.0874 2.82136 9.23365 0 6.04368 0C2.85486 0 0 2.82136 0 5.97468C0 9.12687 3.45353 11.9462 6.17606 11.9482C7.77044 11.9494 9.0094 11.5085 9.98871 10.6796L10.2341 10.921V11.6156L14.6752 16L16 14.6904L11.5681 10.2981H10.8619ZM6.04422 10.2423C3.65985 10.2423 1.72676 8.33212 1.72676 5.97468C1.72676 3.61724 3.65985 1.70705 6.04422 1.70705C8.42749 1.70705 10.3606 3.61724 10.3606 5.97468C10.3606 8.33212 8.42749 10.2423 6.04422 10.2423V10.2423Z"
      />
    </svg>
  );
}

function TabIcon({ url }: { url: string }) {
  const [unavailable, setUnavailable] = useState(false);
  const faviconUrl = new URL(chrome.runtime.getURL('/_favicon/'));
  faviconUrl.searchParams.set('pageUrl', url);
  faviconUrl.searchParams.set('size', '32');
  return (
    <span className="tab-icon" aria-hidden="true">
      {url && !unavailable ? (
        <img
          src={faviconUrl.href}
          alt=""
          draggable={false}
          onError={() => setUnavailable(true)}
        />
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
          <ellipse
            cx="8"
            cy="8"
            rx="2.5"
            ry="6"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <path d="M2 8h12" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )}
    </span>
  );
}

function tabDomain(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.hostname.replace(/^www\./u, '');
    }
    return parsed.protocol === 'file:'
      ? 'Local file'
      : `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return url || 'New tab';
  }
}

function accessAge(timestamp: number, now: number): string {
  if (!timestamp) return 'Not viewed yet';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 5) return 'Just now';
  const units: [number, string][] = [
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'min'],
    [1, 'sec'],
  ];
  const [divisor, unit] = units.find(([size]) => seconds >= size)!;
  const value = Math.floor(seconds / divisor);
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}

export default function App() {
  const { tabs, currentTabId, loading, error, refresh } = useTabs();
  const [query, setQuery] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const {
    searchMode: mode,
    showClosedTabs: showClosed,
    ready: preferenceReady,
    saving: preferenceSaving,
    error: preferenceError,
    updatePreferences,
  } = useSearchPreferences();
  const isLoading = loading || !preferenceReady;
  const [now, setNow] = useState(Date.now);
  const [selectedKey, setSelectedKey] = useState<string>();
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string>();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const switchingRef = useRef(false);
  const {
    tabs: visibleTabs,
    results,
    error: searchError,
  } = useMemo(() => {
    try {
      const results = searchTabs(preferenceReady ? tabs : [], query, {
        mode,
        showClosed,
      });
      return {
        tabs: results.map(({ entry }) => entry),
        results,
        error: undefined,
      };
    } catch (cause) {
      if (mode !== 'regex' || !(cause instanceof SyntaxError)) throw cause;
      return { tabs: [], results: [], error: 'Invalid regular expression.' };
    }
  }, [tabs, query, mode, showClosed, preferenceReady]);
  const hasSearchQuery =
    mode === 'regex' ? query.length > 0 : query.trim().length > 0;
  const selectedIndex = Math.max(
    0,
    visibleTabs.findIndex((tab) => tab.key === selectedKey),
  );
  const selectedTab = visibleTabs[selectedIndex];
  const windows = useMemo(
    () =>
      [
        ...new Set(
          tabs.flatMap((tab) => (tab.kind === 'open' ? [tab.windowId] : [])),
        ),
      ].sort((a, b) => a - b),
    [tabs],
  );

  useEffect(() => {
    searchRef.current?.focus();
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (selectedTab) {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-entry-key="${selectedTab.key}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedTab?.key]);

  async function activate(tab: TabEntry) {
    if (switchingRef.current) return;
    switchingRef.current = true;
    setSwitching(true);
    setSwitchError(undefined);
    try {
      await activateEntry(tab);
      window.close();
    } catch {
      setSwitchError(
        tab.kind === 'closed'
          ? 'Could not reopen that tab. Try again.'
          : 'Could not switch to that tab. Try again.',
      );
      await refresh();
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  }

  function changeQuery(value: string) {
    setSettingsOpen(false);
    setQuery(value);
    setSelectedKey(undefined);
  }

  function closeSettings() {
    setSettingsOpen(false);
    searchRef.current?.focus();
  }

  function changePreferences(changes: Partial<SearchPreferences>) {
    setSettingsOpen(false);
    void updatePreferences(changes);
    setSelectedKey(undefined);
  }

  function toggleMode(next: Exclude<SearchMode, 'fuzzy'>) {
    changePreferences({ searchMode: mode === next ? 'fuzzy' : next });
    searchRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (settingsOpen) {
        closeSettings();
      } else if (query) {
        changeQuery('');
        searchRef.current?.focus();
      } else window.close();
      return;
    }
    if (settingsOpen) return;
    const target = event.target;
    const isSearch = target === searchRef.current;
    const isTab =
      target instanceof HTMLElement && target.hasAttribute('data-entry-key');
    if (!isSearch && !isTab) return;
    if (
      (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
      visibleTabs.length > 0
    ) {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const next =
        (selectedIndex + direction + visibleTabs.length) % visibleTabs.length;
      setSelectedKey(visibleTabs[next]!.key);
      searchRef.current?.focus();
    } else if (event.key === 'Enter' && isSearch && selectedTab) {
      event.preventDefault();
      void activate(selectedTab);
    }
  }

  return (
    <main
      className="popup"
      onKeyDown={handleKeyDown}
      aria-busy={!settingsOpen && (isLoading || switching)}
    >
      <h1 className="sr-only">Tab Switcher</h1>

      <div
        className={`search-box${!settingsOpen && searchError ? ' invalid' : ''}`}
      >
        <SearchIcon />
        <input
          ref={searchRef}
          type="text"
          placeholder={
            mode === 'regex'
              ? 'Search with regex'
              : mode === 'exact'
                ? 'Search exact text'
                : 'Search Tabs'
          }
          value={query}
          onFocus={() => setSettingsOpen(false)}
          onChange={(event) => changeQuery(event.target.value)}
          aria-label="Search tabs and history by title or URL"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={!settingsOpen}
          aria-controls="tabs-list"
          aria-invalid={Boolean(searchError)}
          aria-describedby={
            !settingsOpen && searchError ? 'search-error' : undefined
          }
          aria-activedescendant={
            !settingsOpen && selectedTab ? `tab-${selectedTab.key}` : undefined
          }
          autoComplete="off"
          spellCheck={false}
        />
        {query && (
          <button
            className="clear-search"
            aria-label="Clear search"
            onClick={() => {
              changeQuery('');
              searchRef.current?.focus();
            }}
          >
            ×
          </button>
        )}
        <button
          type="button"
          className="search-toggle exact-toggle"
          aria-label="Exact match"
          aria-pressed={mode === 'exact'}
          title="Match exact text (no fuzzy matching)"
          disabled={!preferenceReady || preferenceSaving}
          onClick={() => toggleMode('exact')}
        >
          <span aria-hidden="true">ab</span>
        </button>
        <button
          type="button"
          className="search-toggle"
          aria-label="Use regular expression"
          aria-pressed={mode === 'regex'}
          title="Use regular expression"
          disabled={!preferenceReady || preferenceSaving}
          onClick={() => toggleMode('regex')}
        >
          <span aria-hidden="true">.*</span>
        </button>
      </div>

      <div className="history-controls">
        <label className="history-filter">
          <input
            type="checkbox"
            checked={showClosed}
            disabled={!preferenceReady || preferenceSaving}
            onChange={(event) =>
              changePreferences({ showClosedTabs: event.target.checked })
            }
          />
          Show closed tabs
        </label>
        <div className={`settings-tab${settingsOpen ? ' active' : ''}`}>
          <button
            id="settings-toggle"
            className="settings-button"
            type="button"
            aria-pressed={settingsOpen}
            aria-controls="settings-panel"
            onClick={() =>
              settingsOpen ? closeSettings() : setSettingsOpen(true)
            }
          >
            Settings
          </button>
          {settingsOpen && (
            <button
              className="close-settings"
              type="button"
              aria-label="Close settings"
              onClick={closeSettings}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {settingsOpen && (
        <section
          id="settings-panel"
          className="settings-panel"
          aria-labelledby="settings-toggle"
        >
          <Settings />
        </section>
      )}

      <div className="search-results" hidden={settingsOpen}>
        {searchError && (
          <div id="search-error" className="search-error" role="alert">
            {searchError}
          </div>
        )}

        {preferenceError && (
          <div className="search-error" role="alert">
            {preferenceError}
          </div>
        )}

        <div className="sr-only" role="status" aria-live="polite">
          {isLoading
            ? 'Loading tab history…'
            : hasSearchQuery
              ? `${visibleTabs.length} matching entries`
              : `${visibleTabs.filter((tab) => tab.kind === 'open').length} open tabs${showClosed ? ` · ${visibleTabs.filter((tab) => tab.kind === 'closed').length} closed tabs` : ''}`}
        </div>

        {(error || switchError) && (
          <div className="error-message" role="alert">
            <span>{switchError || error}</span>
            <button
              onClick={() => {
                setSwitchError(undefined);
                void refresh();
              }}
            >
              Retry
            </button>
          </div>
        )}

        <ul
          id="tabs-list"
          className="tab-list"
          role="listbox"
          aria-label={showClosed ? 'Open and closed tabs' : 'Open tabs'}
          ref={listRef}
        >
          {results.map(({ entry: tab, title, url }) => {
            const isCurrent = tab.kind === 'open' && tab.id === currentTabId;
            const details =
              tab.kind === 'open'
                ? `Window ${windows.indexOf(tab.windowId) + 1}${tab.pinned ? ' · Pinned' : ''}`
                : `Closed ${new Date(tab.closedAt).toLocaleString()} · Opens in a new tab`;
            return (
              <li key={tab.key} role="none">
                <button
                  id={`tab-${tab.key}`}
                  className={`tab-row${tab.kind === 'closed' ? ' closed' : ''}${isCurrent ? ' current' : ''}${selectedTab?.key === tab.key ? ' selected' : ''}`}
                  role="option"
                  aria-selected={selectedTab?.key === tab.key}
                  aria-label={
                    tab.kind === 'closed'
                      ? `${tab.title}, closed tab`
                      : tab.title
                  }
                  aria-describedby={`meta-${tab.key}`}
                  aria-current={isCurrent ? 'page' : undefined}
                  data-tab-id={tab.kind === 'open' ? tab.id : undefined}
                  data-entry-key={tab.key}
                  data-entry-kind={tab.kind}
                  data-last-accessed={tab.lastAccessed}
                  onClick={() => {
                    void activate(tab);
                  }}
                  onFocus={() => setSelectedKey(tab.key)}
                  onMouseEnter={() => setSelectedKey(tab.key)}
                  disabled={switching}
                  title={`${tab.title}\n${tab.url}\n${details}${tab.lastAccessed > 0 ? ` · Last accessed ${new Date(tab.lastAccessed).toLocaleString()}` : ''}${tab.incognito ? ' · Incognito' : ''}`}
                >
                  <TabIcon key={tab.url} url={tab.url} />
                  <span className="tab-info">
                    <span className="tab-title">
                      <HighlightedText {...matchExcerpt(title, 24)} />
                    </span>
                    <span id={`meta-${tab.key}`} className="tab-meta">
                      <span className="tab-domain">
                        {url.ranges.length > 0 ? (
                          <HighlightedText {...matchExcerpt(url, 16)} />
                        ) : (
                          tabDomain(tab.url)
                        )}
                      </span>
                      <span aria-hidden="true">•</span>
                      <span className="tab-age">
                        {accessAge(tab.lastAccessed, now)}
                      </span>
                    </span>
                  </span>
                  {tab.kind === 'closed' && (
                    <svg
                      className="history-icon"
                      width="13"
                      height="13"
                      viewBox="0 0 16 16"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M2 5.5A6 6 0 1 1 2 10M2 2v3.5h3.5M8 4.5V8l2.5 1.5"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        {!isLoading && !error && !searchError && visibleTabs.length === 0 && (
          <div className="empty-state">
            <strong>
              {hasSearchQuery
                ? 'No matching tabs'
                : showClosed
                  ? 'No tab history yet'
                  : 'No open tabs'}
            </strong>
            <p>
              {hasSearchQuery
                ? mode === 'regex'
                  ? 'Try another pattern or turn off regex.'
                  : 'Try a shorter title or part of a URL.'
                : 'Open a tab to see it here.'}
            </p>
            {hasSearchQuery && (
              <button
                onClick={() => {
                  changeQuery('');
                  searchRef.current?.focus();
                }}
              >
                Clear search
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
