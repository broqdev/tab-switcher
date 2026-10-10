import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function setup(profile = '') {
  const extension = resolve('.output/chrome-mv3');
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 400, height: 600 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent('serviceworker'));
  const page = context.pages()[0]!;
  await page.goto(`${worker.url().replace(/\/[^/]*$/, '')}/popup.html`);
  await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
  return { context, worker, page };
}

const toggle = (page: Page) =>
  page.getByRole('checkbox', { name: 'Show closed tabs', exact: true });
const recorder = (page: Page) =>
  page.getByRole('button', {
    name: 'Change closed tabs shortcut',
    exact: true,
  });
const binding = (page: Page) =>
  page
    .getByRole('region', { name: 'Closed tabs shortcut', exact: true })
    .locator('kbd');
async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(recorder(page)).toBeEnabled();
}
async function hint(page: Page, suffix = '`') {
  const mac = await page.evaluate(() => navigator.platform.startsWith('Mac'));
  return mac ? `⌥${suffix}` : `Alt+${suffix === '⇧H' ? 'Shift+H' : suffix}`;
}

test('Option+backtick toggles saved history without changing the query and displays its hint', async ({}, testInfo) => {
  const { context, worker, page } = await setup();
  try {
    await worker.evaluate(() =>
      chrome.storage.local.set({
        closedTabHistory: [
          {
            kind: 'closed',
            key: 'closed-shortcut-archive',
            title: 'Archive paper',
            url: 'about:blank#closed-shortcut',
            lastAccessed: Date.now(),
            closedAt: Date.now(),
            incognito: false,
          },
        ],
      }),
    );
    const search = page.getByRole('combobox');
    await search.fill('Archive');
    await expect(page.getByRole('option')).toHaveCount(1);
    await expect(toggle(page)).toHaveAccessibleDescription(
      `(${await hint(page)})`,
    );
    await page
      .locator('.popup')
      .screenshot({ path: testInfo.outputPath('closed-shortcut-hint.png') });
    await search.press('Alt+Backquote');
    await expect(toggle(page)).not.toBeChecked();
    await expect(search).toHaveValue('Archive');
    await expect(search).toBeFocused();
    await expect(page.getByRole('option')).toHaveCount(0);
    await expect
      .poll(() =>
        worker.evaluate(
          async () =>
            (await chrome.storage.local.get('showClosedTabs')).showClosedTabs,
        ),
      )
      .toBe(false);
    await expect(toggle(page)).toBeEnabled();
    await search.press('Alt+Backquote');
    await expect(toggle(page)).toBeChecked();
    await expect(page.getByRole('option')).toHaveCount(1);
    await expect(toggle(page)).toBeEnabled();
    // macOS can report this combination as a dead key rather than a backtick.
    expect(
      await search.evaluate((element) =>
        element.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Dead',
            code: 'Backquote',
            altKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      ),
    ).toBe(false);
    await search.dispatchEvent('keyup', {
      key: 'Dead',
      code: 'Backquote',
      altKey: true,
    });
    await expect(toggle(page)).not.toBeChecked();
    await expect(toggle(page)).toBeEnabled();
    for (const options of [
      { repeat: true },
      { isComposing: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
    ])
      await search.dispatchEvent('keydown', {
        key: '`',
        code: 'Backquote',
        altKey: true,
        ...options,
      });
    await expect(toggle(page)).not.toBeChecked();
    await expect(search).toHaveValue('Archive');
  } finally {
    await context.close();
  }
});

test('a consumed macOS dead key cannot start composition or alter subsequent typing', async () => {
  const { context, page } = await setup();
  try {
    const search = page.getByRole('combobox');
    const cdp = await context.newCDPSession(page);
    await search.fill('Archive');
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 1000);
    // Native macOS Option+backtick reports keyCode 229 and then asks Chrome
    // to insert non-cancelable composition text, despite canceled keydown.
    // Hold the animation-frame boundary while CDP sends the separate IME
    // command; native keyboard input sends both within the same frame.
    await search.dispatchEvent('keydown', {
      key: 'Dead',
      code: 'Backquote',
      keyCode: 229,
      altKey: true,
    });
    await expect(toggle(page)).not.toBeChecked();
    await cdp.send('Input.imeSetComposition', {
      text: '`',
      selectionStart: 1,
      selectionEnd: 1,
    });
    await expect(search).toHaveValue('Archive');
    await page.clock.runFor(16);
    await page.clock.resume();
    await expect(search).toBeFocused();
    await search.dispatchEvent('keyup', {
      key: 'Dead',
      code: 'Backquote',
      altKey: true,
    });
    await expect(search).toBeEditable();
    await search.press('e');
    await expect(search).toHaveValue('Archivee');

    await expect(toggle(page)).toBeEnabled();
    await search.fill('Alpha beta');
    await search.evaluate((input: HTMLInputElement) =>
      input.setSelectionRange(6, 10, 'backward'),
    );
    await page.clock.pauseAt(Date.now() + 2000);
    await search.dispatchEvent('keydown', {
      key: 'Dead',
      code: 'Backquote',
      keyCode: 229,
      altKey: true,
    });
    await cdp.send('Input.imeSetComposition', {
      text: '`',
      selectionStart: 1,
      selectionEnd: 1,
    });
    await page.clock.runFor(16);
    await page.clock.resume();
    await expect(search).toHaveValue('Alpha beta');
    expect(
      await search.evaluate((input: HTMLInputElement) => [
        input.selectionStart,
        input.selectionEnd,
        input.selectionDirection,
      ]),
    ).toEqual([6, 10, 'backward']);
    await search.press('x');
    await expect(search).toHaveValue('Alpha x');
    await expect(toggle(page)).toBeChecked();

    // Literal backticks and unrelated IME input must remain usable.
    await search.fill('');
    await search.press('Backquote');
    await expect(search).toHaveValue('`');
    await search.fill('');
    await search.dispatchEvent('keydown', {
      key: 'Dead',
      code: 'KeyE',
      altKey: true,
    });
    await cdp.send('Input.imeSetComposition', {
      text: '´',
      selectionStart: 1,
      selectionEnd: 1,
    });
    await expect(search).toHaveValue('´');
    await cdp.send('Input.insertText', { text: 'é' });
    await expect(search).toHaveValue('é');
    await expect(toggle(page)).toBeChecked();
  } finally {
    await context.close();
  }
});

test('Settings captures custom shortcuts, rejects result conflicts, cancels capture and restores the default', async ({}, testInfo) => {
  const { context, worker, page } = await setup();
  try {
    await openSettings(page);
    await expect(binding(page)).toHaveText(await hint(page));
    await recorder(page).click();
    await recorder(page).press('Alt+1');
    await expect(page.getByRole('alert')).toContainText(
      'reserved for selecting results',
    );
    await expect(recorder(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle(page)).toBeChecked();
    await recorder(page).press('h');
    await expect(page.getByRole('alert')).toContainText('Include Option/Alt');
    await recorder(page).press('Escape');
    await expect(recorder(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(
      page.getByRole('region', { name: 'Settings', exact: true }),
    ).toBeVisible();
    await recorder(page).click();
    await recorder(page).press('Tab');
    await expect(recorder(page)).toHaveAttribute('aria-pressed', 'false');
    await recorder(page).click();
    for (const options of [{ repeat: true }, { isComposing: true }])
      await recorder(page).dispatchEvent('keydown', {
        key: 'H',
        code: 'KeyH',
        altKey: true,
        shiftKey: true,
        ...options,
      });
    await expect(recorder(page)).toHaveAttribute('aria-pressed', 'true');
    await recorder(page).press('Alt+Shift+H');
    await expect(binding(page)).toHaveText(await hint(page, '⇧H'));
    await expect(toggle(page)).toBeChecked();
    await expect(toggle(page)).toHaveAccessibleDescription(
      `(${await hint(page, '⇧H')})`,
    );
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect
      .poll(() =>
        worker.evaluate(
          async () =>
            (
              await chrome.storage.local.get<{
                closedTabsShortcut?: { code: string };
              }>('closedTabsShortcut')
            ).closedTabsShortcut?.code,
        ),
      )
      .toBe('KeyH');
    await page.locator('.popup').screenshot({
      path: testInfo.outputPath('closed-shortcut-settings.png'),
    });
    await page.getByRole('button', { name: 'Close settings' }).click();
    const search = page.getByRole('combobox');
    await search.fill('retain query');
    await search.dispatchEvent('keydown', {
      key: '`',
      code: 'Backquote',
      altKey: true,
    });
    await expect(toggle(page)).toBeChecked();
    await search.press('Alt+Shift+H');
    await expect(toggle(page)).not.toBeChecked();
    await expect(search).toHaveValue('retain query');
    await openSettings(page);
    await page
      .getByRole('button', { name: 'Restore default', exact: true })
      .click();
    await expect(binding(page)).toHaveText(await hint(page));
    await expect(
      page.getByRole('button', { name: 'Restore default', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await search.press('Alt+Backquote');
    await expect(toggle(page)).toBeChecked();
  } finally {
    await context.close();
  }
});

test('custom binding and history visibility sync across windows and survive browser restart', async () => {
  const profile = await mkdtemp(
    join(tmpdir(), 'tab-switcher-history-shortcut-'),
  );
  let app: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    app = await setup(profile);
    const { context, worker, page } = app;
    const opened = context.waitForEvent('page');
    await worker.evaluate(
      (url) => chrome.windows.create({ url, focused: false }),
      page.url(),
    );
    const other = await opened;
    await expect(toggle(other)).toBeEnabled();
    await openSettings(other);
    await openSettings(page);
    await recorder(page).click();
    await recorder(page).press('Alt+Shift+H');
    await expect(binding(page)).toHaveText(await hint(page, '⇧H'));
    await expect(binding(other)).toHaveText(await hint(other, '⇧H'));
    await page.getByRole('button', { name: 'Close settings' }).click();
    await other.getByRole('button', { name: 'Close settings' }).click();
    await other.getByRole('combobox').press('Alt+Shift+H');
    await expect(toggle(other)).not.toBeChecked();
    await expect(toggle(page)).not.toBeChecked();
    await expect(toggle(page)).toBeEnabled();
    await context.close();
    app = undefined;
    app = await setup(profile);
    await expect(toggle(app.page)).not.toBeChecked();
    await expect(toggle(app.page)).toHaveAccessibleDescription(
      `(${await hint(app.page, '⇧H')})`,
    );
    await openSettings(app.page);
    await expect(binding(app.page)).toHaveText(await hint(app.page, '⇧H'));
    await app.page.getByRole('button', { name: 'Close settings' }).click();
    await app.page.getByRole('combobox').press('Alt+Shift+H');
    await expect(toggle(app.page)).toBeChecked();
  } finally {
    await app?.context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('failed shortcut saves restore the previous binding and invalid stored bindings fall back to default', async () => {
  const { context, page } = await setup();
  try {
    await openSettings(page);
    await page.evaluate(() => {
      const set = chrome.storage.local.set.bind(chrome.storage.local);
      chrome.storage.local.set = (() => {
        chrome.storage.local.set = set;
        return Promise.reject(new Error('Storage unavailable'));
      }) as typeof chrome.storage.local.set;
    });
    await recorder(page).click();
    await recorder(page).press('Alt+Shift+H');
    await expect(page.getByRole('alert')).toContainText(
      'Could not save this preference',
    );
    await expect(binding(page)).toHaveText(await hint(page));
    await recorder(page).click();
    await recorder(page).press('Alt+Shift+H');
    await expect(binding(page)).toHaveText(await hint(page, '⇧H'));
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.evaluate(() =>
      chrome.storage.local.set({
        closedTabsShortcut: {
          code: 'Digit1',
          altKey: true,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
        },
      }),
    );
    await expect(binding(page)).toHaveText(await hint(page));
    await page.evaluate(() =>
      chrome.storage.local.remove('closedTabsShortcut'),
    );
    await page.reload();
    await expect(toggle(page)).toHaveAccessibleDescription(
      `(${await hint(page)})`,
    );
  } finally {
    await context.close();
  }
});
