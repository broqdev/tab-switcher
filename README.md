# Tab Switcher

Open the toolbar popup to search open tabs and closed-tab history across all Chrome windows. The list starts in last-access order; fuzzy searches prioritize direct matches. Click an open tab to switch to it and focus its window. Click a closed entry to open its URL in a new active tab.

Built with **WXT** (Vite-based extension tooling), **React**, **TypeScript**, and **Fuse.js**. Node.js runs the development and build tools; the extension runs in Chrome, with no server.

## Run

Requires Node.js 22.12+ (Node.js 24 recommended) and Chrome 121+.

```sh
cd tab-switcher
npm install
npm run build
```

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select `tab-switcher/.output/chrome-mv3`.
4. Pin **Tab Switcher** using Chrome's extensions menu, then click its icon.

After code changes, rebuild and click the extension's **Reload** button on `chrome://extensions`. For development with hot reload, run `npm run dev`; WXT launches a separate development browser profile.

To review or annotate the popup in an ordinary browser, run `npm run preview` and open `http://127.0.0.1:4174`. It uses the built popup with sample open and closed tabs; searching and selection work, and selecting entries only changes the preview. The **Settings** toggle opens preferences inside that same popup; preview preferences are saved separately from the installed extension. Reload the preview after UI edits and a rebuild.

## Use

- Search matches titles and URLs, ignores case, accents, and full-width character differences, and searches both readable and percent-encoded URL text. Every search word must match; words can match different fields.
- Words of 4–32 characters tolerate limited typos. Short terms, numeric IDs (such as paper IDs), domain names, pasted addresses, and longer terms require a literal substring, so common URL prefixes and similar IDs do not return unrelated entries.
- Title matches rank above URL-only matches in fuzzy, exact, and regex modes, across both open and closed entries. Fuzzy searches prefer more matching words in the title, then more literal title matches. Matching URL hosts and subdomains rank next, followed by fewer typo matches; equally relevant results stay most-recent-first. For example, `x.com` puts a matching title first, then actual `x.com` and `mobile.x.com` URLs, then other URLs mentioning `x.com`, and excludes typo-only matches such as `y.com`. Exact and regex results keep recency within their title and URL groups. Clearing search restores the full last-access order.
- The **ab** toggle inside search enables **Exact match**: a literal phrase in a title or URL, without typo tolerance. Case, accents, and full-width characters remain normalized.
- The **.\*** toggle enables **Regex**: a JavaScript regular expression, case-insensitive and Unicode-aware, tested against the title, original URL, and readable URL separately. For example, `^TypeScript.*(Handbook|Notes)$` matches specific titles. Enter the pattern without `/…/` delimiters; invalid patterns show an inline error.
- Exact and regex are alternative modes. Click the active toggle again to return to fuzzy search; switching modes keeps the search text.
- The **Show closed tabs** checkbox below search hides or shows closed entries without changing the query or deleting history. It defaults to checked on first use, then remembers your choice in extension storage across all windows in the same Chrome profile, popup reloads, and browser restarts. Other open popups update immediately when the preference changes.
- Click **Settings** beside that checkbox to open compact preferences inside the popup. The selected toggle shows an **×**; click it, click Settings again, or press **Esc** to return to your search with its query, mode, and selected result intact. Focusing or typing in search also returns to results. There is no separate Settings page. Closing the Settings tab discards unsaved edits.
- Under **Settings**, enter a **Closed tabs** limit from **1 to 10,000** and click **Save changes**. The default is **10,000** when no valid preference is saved; existing saved limits are preserved. The setting is shared across windows in the same Chrome profile and persists across browser restarts. Other open Settings panels update immediately.
- **Settings → Open popup** shows the current shortcut. Click the shortcut control to open Chrome’s shortcut editor, find **Tab Switcher → Activate the extension**, and enter your preferred combination. Chrome saves it automatically for the profile, across windows and restarts. Reopen the popup and Settings to see the updated binding. The shortcut starts unassigned. Chrome’s [Commands API](https://developer.chrome.com/docs/extensions/reference/api/commands) exposes the current binding but has no setter, so the popup cannot assign a shortcut directly; assignment is managed in `chrome://extensions/shortcuts`. The ordinary-browser preview displays this section but cannot assign Chrome shortcuts.
- After updating an unpacked extension, **Reload required** means Chrome is still using the previous manifest. Click **Reload extension**, then reopen Settings. Refreshing the settings tab alone does not load the new manifest. A temporary lookup failure offers **Retry** without discarding unsaved history-limit edits.
- **↑ / ↓** selects a result; **Enter** switches to an open tab or reopens a closed entry.
- **Esc** closes the Settings tab first if it is open; otherwise it clears the search, or closes the popup when the search is empty.
- The popup is 400px wide and 600px tall, and keeps that size when filtering or showing fewer tabs. It uses [Chrome's tab-search typography](https://github.com/chromium/chromium/blob/main/chrome/browser/resources/tab_search/app.css): 48px rows, 12px medium-weight titles, 11px regular domain/time text, and 40px favicon tiles with 8px corners. The font is Chrome's macOS `system-ui, sans-serif`, with normal browser font rendering. Colors reproduce the supplied green Chrome theme after converting the screenshots' monitor profile to sRGB. The panel has a 12px radius and a 4px scrollbar. Chrome [limits extension popups to 600px tall](https://developer.chrome.com/docs/extensions/reference/api/action#popup) and [draws their outer window without rounded corners](https://github.com/chromium/chromium/blob/main/chrome/browser/ui/views/extensions/extension_popup.cc); CSS cannot reproduce native Tab Search's taller window or round its outer frame. Hover a row for its full URL, window, and exact last access datetime.
- A small history icon marks closed entries. URLs already open are represented by their open tabs; multiple open tabs with the same URL remain separate.
- Closed, created, moved, renamed, and activated tabs update while the popup is open.
- Selecting a tab in a minimized window restores and focuses that window.

The extension uses Chrome's native [`tabs.Tab.lastAccessed`](https://developer.chrome.com/docs/extensions/reference/api/tabs#property-Tab-lastAccessed), available since Chrome 121. Chrome defines this timestamp as the last time the tab became active in its window. Closed tabs retain their last access time; closing an older tab does not move it ahead of more recently accessed tabs. Merely focusing another window is not a separate access event under that API's definition.

The background worker records closures even when the popup is closed. Regular history persists locally across browser restarts, with one closed entry per URL, up to your configured count. There is no extension-imposed byte cap; the [`unlimitedStorage` permission](https://developer.chrome.com/docs/extensions/reference/api/storage#property-local-QUOTA_BYTES) exempts regular history from Chrome's normal local-storage quota. Available disk space still applies. Lowering the count immediately removes older retained entries by last access time; increasing it lets future captures retain more entries. A limit of **1,000 or less** is recommended for responsiveness; larger lists can slow popup loading and search. Chrome's [recently closed sessions](https://developer.chrome.com/docs/extensions/reference/api/sessions) seed the history on first load and supplement captures; tabs inside closed windows are included. For imported entries whose last access time is unavailable, their closing time is used. Older tabs closed before this version was installed are available only if Chrome still exposes their recent session. Unsupported temporary URLs (`blob:`, `data:`, and extension pages) are excluded from closed history.

All windows accessible to the extension are included. To include incognito tabs, enable **Allow in Incognito** in the extension's Chrome settings; Chrome otherwise hides them. The configured count applies separately to regular and private history. Private closed entries stay in session memory, are reopened in an incognito window, and are cleared when Chrome restarts or the extension reloads. Chrome's own [10 MiB session-storage quota](https://developer.chrome.com/docs/extensions/reference/api/storage#property-session-QUOTA_BYTES) still applies to private history and the worker's open-tab snapshots; `unlimitedStorage` does not exempt session memory. The extension does not persist private history to disk.

## Checks

```sh
npm run check                 # TypeScript, unit tests, production build
npx playwright install chromium
npm run test:e2e              # Build and exercise the loaded extension in Chromium
npm run zip                   # Produce a distributable ZIP in .output/
```

The `tabs` permission reads titles and URLs; [`favicon`](https://developer.chrome.com/docs/extensions/how-to/ui/favicons) displays Chrome's cached icons; `sessions` reads recently closed tabs/windows; `storage` saves the closed-tab list, worker snapshots, checkbox preference, and history limit; and `unlimitedStorage` removes Chrome's normal local-storage quota for regular history. Search and storage stay local. There is no full browsing-history permission, content script, or external service. Removing the extension clears its saved history and preferences.

## Files

- `wxt.config.ts`: Manifest V3 configuration and permissions.
- `entrypoints/popup/`: React popup and styles.
- `components/settings/`: Embedded preference rows, shortcut controls, validation, and shared settings.
- `lib/tabs.ts`: Chrome operations, recency ordering, and fuzzy matching.
- `lib/history.ts`: Closed-tab records, recent-session import, and configurable retention limits.
- `lib/history-tracker.ts` / `entrypoints/background.ts`: Persistent closure capture with serialized storage writes.
- `lib/use-tabs.ts`: Live tab updates with protection against stale async responses.
- `lib/use-show-closed.ts`: Saved checkbox preference with live updates across windows.
- `tests/`: Unit tests and browser integration tests.
- `scripts/generate-icons.mjs`: Reproducible toolbar icon generator (`npm run icons`).

Tool documentation: [WXT](https://wxt.dev/), [Fuse.js](https://www.fusejs.io/), [Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs), [Playwright extension tests](https://playwright.dev/docs/chrome-extensions).
