import { useEffect, useState, type FormEvent } from 'react';
import ShortcutSettings from './ShortcutSettings';
import ClosedTabsShortcutSettings, {
  type ClosedTabsShortcutSettingsProps,
} from './ClosedTabsShortcutSettings';
import './style.css';
import {
  HISTORY_LIMIT,
  HISTORY_LIMIT_KEY,
  MAX_HISTORY_LIMIT,
  isHistoryLimit,
  readHistoryLimit,
} from '../../lib/history';

export default function Settings(
  shortcutProps: ClosedTabsShortcutSettingsProps,
) {
  const [value, setValue] = useState(String(HISTORY_LIMIT));
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState('');

  useEffect(() => {
    let active = true;
    let changed = false;
    const apply = (stored: unknown) => {
      setValue(String(readHistoryLimit(stored)));
      setReady(true);
      setError(undefined);
      setStatus('');
    };
    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'local' || !(HISTORY_LIMIT_KEY in changes)) return;
      changed = true;
      apply(changes[HISTORY_LIMIT_KEY]?.newValue);
    };
    chrome.storage.onChanged.addListener(onChange);
    void chrome.storage.local
      .get(HISTORY_LIMIT_KEY)
      .then((values) => {
        if (active && !changed) apply(values[HISTORY_LIMIT_KEY]);
      })
      .catch(() => {
        if (active && !changed)
          setError('Could not load settings. Reopen Settings to try again.');
      });
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || saving) return;
    const limit = Number(value);
    if (!value.trim() || !isHistoryLimit(limit)) {
      setError(
        `Enter a whole number from 1 to ${MAX_HISTORY_LIMIT.toLocaleString()}.`,
      );
      setStatus('');
      return;
    }
    setSaving(true);
    setError(undefined);
    setStatus('');
    try {
      await chrome.storage.local.set({ [HISTORY_LIMIT_KEY]: limit });
      setStatus('Saved.');
    } catch {
      setError('Could not save settings. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="preferences">
      <ShortcutSettings />
      <ClosedTabsShortcutSettings {...shortcutProps} />
      <form
        className="preferences-section"
        onSubmit={(event) => void save(event)}
        noValidate
      >
        <div className="preference-row">
          <label htmlFor="history-limit">Closed tabs:</label>
          <input
            id="history-limit"
            aria-label="Closed-tab history limit"
            type="number"
            min="1"
            max={MAX_HISTORY_LIMIT}
            step="1"
            required
            value={value}
            disabled={!ready || saving}
            aria-describedby="history-limit-help history-limit-range"
            aria-invalid={Boolean(error) && ready}
            onChange={(event) => {
              setValue(event.target.value);
              setError(undefined);
              setStatus('');
            }}
          />
        </div>
        <p id="history-limit-range" className="preference-help">
          1–{MAX_HISTORY_LIMIT.toLocaleString()} entries. Default:{' '}
          {HISTORY_LIMIT.toLocaleString()}.
        </p>
        <p id="history-limit-help" className="preference-help">
          Lowering the limit removes older entries.
        </p>
        {error && (
          <p className="preference-error" role="alert">
            {error}
          </p>
        )}
        <div className="preference-actions">
          <button type="submit" disabled={!ready || saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <span role="status" aria-live="polite">
            {status}
          </span>
        </div>
      </form>
    </div>
  );
}
