import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLOSED_TABS_SHORTCUT as defaults,
  formatShortcut,
  matchesShortcut,
  readPopupShortcut,
  shortcutError,
} from '../../lib/popup-shortcut';

describe('popup shortcuts', () => {
  it.each([
    undefined,
    null,
    'Alt+`',
    {},
    { ...defaults, altKey: 'true' },
    { ...defaults, code: 'constructor' },
    { ...defaults, code: 'Escape' },
    { ...defaults, code: 'Digit1' },
    { ...defaults, altKey: false },
  ])('uses the default for invalid stored value %j', (value) => {
    expect(readPopupShortcut(value)).toEqual(defaults);
  });
  it('preserves validated custom bindings and requires every modifier to match', () => {
    const custom = { ...defaults, code: 'KeyH', shiftKey: true };
    expect(readPopupShortcut(custom)).toEqual(custom);
    expect(matchesShortcut(custom, custom)).toBe(true);
    expect(matchesShortcut({ ...custom, shiftKey: false }, custom)).toBe(false);
    expect(matchesShortcut({ ...custom, ctrlKey: true }, custom)).toBe(false);
    expect(shortcutError(custom)).toBeUndefined();
  });
  it('formats physical keys consistently for Mac and other platforms', () => {
    expect(formatShortcut(defaults, true)).toBe('⌥`');
    expect(formatShortcut(defaults, false)).toBe('Alt+`');
    expect(
      formatShortcut({ ...defaults, code: 'KeyH', shiftKey: true }, true),
    ).toBe('⌥⇧H');
    expect(
      formatShortcut({ ...defaults, code: 'KeyH', ctrlKey: true }, false),
    ).toBe('Ctrl+Alt+H');
  });
});
