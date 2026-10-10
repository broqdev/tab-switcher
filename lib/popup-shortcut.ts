export interface PopupShortcut {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export const DEFAULT_CLOSED_TABS_SHORTCUT: PopupShortcut = {
  code: 'Backquote',
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

const punctuation: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

export function shortcutError(shortcut: PopupShortcut): string | undefined {
  if (
    !/^(Key[A-Z]|Digit[0-9])$/u.test(shortcut.code) &&
    !Object.hasOwn(punctuation, shortcut.code)
  )
    return 'Choose a letter, number or punctuation key.';
  if (!shortcut.altKey && !shortcut.ctrlKey && !shortcut.metaKey)
    return 'Include Option/Alt, Control or Command in the shortcut.';
  if (
    shortcut.altKey &&
    !shortcut.ctrlKey &&
    !shortcut.metaKey &&
    !shortcut.shiftKey &&
    /^Digit[1-9]$/u.test(shortcut.code)
  )
    return 'Option/Alt+1–9 is reserved for selecting results.';
}

export function shortcutFromEvent(event: PopupShortcut): PopupShortcut {
  return {
    code: event.code,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  };
}

export function readPopupShortcut(value: unknown): PopupShortcut {
  if (!value || typeof value !== 'object') return DEFAULT_CLOSED_TABS_SHORTCUT;
  const shortcut = value as Partial<PopupShortcut>;
  if (
    typeof shortcut.code !== 'string' ||
    ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'].some(
      (key) => typeof shortcut[key as keyof PopupShortcut] !== 'boolean',
    )
  )
    return DEFAULT_CLOSED_TABS_SHORTCUT;
  const candidate = shortcutFromEvent(shortcut as PopupShortcut);
  return shortcutError(candidate) ? DEFAULT_CLOSED_TABS_SHORTCUT : candidate;
}

export function matchesShortcut(event: PopupShortcut, shortcut: PopupShortcut) {
  return (
    event.code === shortcut.code &&
    event.altKey === shortcut.altKey &&
    event.ctrlKey === shortcut.ctrlKey &&
    event.metaKey === shortcut.metaKey &&
    event.shiftKey === shortcut.shiftKey
  );
}

export function formatShortcut(shortcut: PopupShortcut, mac: boolean): string {
  const key =
    punctuation[shortcut.code] ?? shortcut.code.replace(/^(Key|Digit)/u, '');
  const modifiers = [
    shortcut.ctrlKey && (mac ? '⌃' : 'Ctrl'),
    shortcut.altKey && (mac ? '⌥' : 'Alt'),
    shortcut.shiftKey && (mac ? '⇧' : 'Shift'),
    shortcut.metaKey && (mac ? '⌘' : 'Meta'),
  ].filter(Boolean);
  return [...modifiers, key].join(mac ? '' : '+');
}
