import { useState, type KeyboardEvent } from 'react';
import {
  DEFAULT_CLOSED_TABS_SHORTCUT,
  formatShortcut,
  matchesShortcut,
  shortcutError,
  shortcutFromEvent,
  type PopupShortcut,
} from '../../lib/popup-shortcut';

export interface ClosedTabsShortcutSettingsProps {
  shortcut: PopupShortcut;
  ready: boolean;
  saving: boolean;
  error?: string;
  onChange: (shortcut: PopupShortcut) => void;
}

export default function ClosedTabsShortcutSettings({
  shortcut,
  ready,
  saving,
  error,
  onChange,
}: ClosedTabsShortcutSettingsProps) {
  const [recording, setRecording] = useState(false);
  const [captureError, setCaptureError] = useState<string>();

  function capture(event: KeyboardEvent<HTMLButtonElement>) {
    if (!recording) return;
    event.stopPropagation();
    // Tab still leaves the control; Escape cancels without closing Settings.
    if (event.key === 'Tab') return;
    event.preventDefault();
    if (event.key === 'Escape') {
      setRecording(false);
      setCaptureError(undefined);
      return;
    }
    if (
      event.repeat ||
      event.nativeEvent.isComposing ||
      ['Alt', 'Control', 'Meta', 'Shift'].includes(event.key)
    )
      return;
    const candidate = shortcutFromEvent(event);
    const invalid = shortcutError(candidate);
    setCaptureError(invalid);
    if (invalid) return;
    setRecording(false);
    onChange(candidate);
  }

  return (
    <section className="preferences-section" aria-label="Closed tabs shortcut">
      <div className="preference-row">
        <span>Toggle closed:</span>
        <button
          type="button"
          className="shortcut-control"
          aria-label="Change closed tabs shortcut"
          aria-describedby="closed-shortcut-help"
          aria-pressed={recording}
          disabled={!ready || saving}
          onClick={() => {
            setCaptureError(undefined);
            setRecording((value) => !value);
          }}
          onKeyDown={capture}
          onBlur={() => setRecording(false)}
        >
          <kbd aria-live="polite">
            {recording
              ? 'Press shortcut…'
              : formatShortcut(shortcut, navigator.platform.startsWith('Mac'))}
          </kbd>
        </button>
      </div>
      <p id="closed-shortcut-help" className="preference-help">
        In the popup. Click to record; Esc cancels. Changes save automatically.
      </p>
      {(captureError || error) && (
        <p className="preference-error" role="alert">
          {captureError || error}
        </p>
      )}
      <div className="preference-actions">
        <button
          type="button"
          disabled={
            !ready ||
            saving ||
            matchesShortcut(shortcut, DEFAULT_CLOSED_TABS_SHORTCUT)
          }
          onClick={() => {
            setRecording(false);
            setCaptureError(undefined);
            onChange(DEFAULT_CLOSED_TABS_SHORTCUT);
          }}
        >
          Restore default
        </button>
      </div>
    </section>
  );
}
