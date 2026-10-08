import { useEffect, useState } from 'react';

export default function ShortcutSettings() {
  const [shortcut, setShortcut] = useState<string>();
  const [loadError, setLoadError] = useState<'reload' | 'read'>();
  const [openError, setOpenError] = useState(false);
  const [reloadError, setReloadError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    let request = 0;
    async function refresh() {
      const current = ++request;
      if (typeof chrome.commands?.getAll !== 'function') {
        setLoadError('reload');
        return;
      }
      try {
        const commands = await chrome.commands.getAll();
        if (!active || current !== request) return;
        setShortcut(
          commands.find((command) => command.name === '_execute_action')
            ?.shortcut || '',
        );
        setLoadError(undefined);
      } catch {
        if (!active || current !== request) return;
        setLoadError('read');
      }
    }
    const onFocus = () => void refresh();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    void refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [retry]);

  function reloadExtension() {
    setReloadError(false);
    try {
      chrome.runtime.reload();
    } catch {
      setReloadError(true);
    }
  }

  async function changeShortcut() {
    setOpenError(false);
    try {
      await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    } catch {
      setOpenError(true);
    }
  }

  return (
    <section className="preferences-section" aria-label="Popup shortcut">
      <div className="preference-row">
        <span>Open popup:</span>
        <button
          type="button"
          className="shortcut-control"
          aria-label={
            loadError === 'reload' ? 'Reload extension' : 'Change shortcut'
          }
          aria-describedby="shortcut-help"
          title={
            loadError === 'reload'
              ? 'Reload extension'
              : 'Change shortcut in Chrome'
          }
          onClick={() =>
            loadError === 'reload' ? reloadExtension() : void changeShortcut()
          }
        >
          <kbd aria-live="polite">
            {loadError === 'reload'
              ? 'Reload required'
              : loadError
                ? 'Unavailable'
                : shortcut === undefined
                  ? 'Loading…'
                  : shortcut || 'Not set'}
          </kbd>
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M9 3h4v4M13 3 7 9M7 3H3v10h10V9"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <p id="shortcut-help" className="preference-help">
        Choose “Activate the extension” in Chrome.
      </p>
      {loadError === 'reload' && (
        <p className="preference-error" role="alert">
          Reload the extension to enable shortcut access, then reopen Settings.
          Refreshing this page alone won’t update the extension.
        </p>
      )}
      {loadError === 'read' && (
        <p className="preference-error" role="alert">
          Could not read the shortcut. Click Retry to try again.
        </p>
      )}
      {openError && (
        <p className="preference-error" role="alert">
          Could not open shortcut settings. Try again or open
          chrome://extensions/shortcuts in Chrome.
        </p>
      )}
      {reloadError && (
        <p className="preference-error" role="alert">
          Could not reload the extension. Open chrome://extensions and click
          Reload for Tab Switcher.
        </p>
      )}
      {loadError === 'read' && (
        <div className="preference-actions">
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </button>
        </div>
      )}
    </section>
  );
}
