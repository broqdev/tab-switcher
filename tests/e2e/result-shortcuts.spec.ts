import { chromium, expect, test } from '@playwright/test';
import { resolve } from 'node:path';

async function setup(showClosed = false) {
  const extension = resolve('.output/chrome-mv3');
  const context = await chromium.launchPersistentContext('', {
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
  await worker.evaluate(
    (showClosed) => chrome.storage.local.set({ showClosedTabs: showClosed }),
    showClosed,
  );
  const page = context.pages()[0]!;
  await page.goto(`${worker.url().replace(/\/[^/]*$/, '')}/popup.html`);
  await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
  return { context, worker, page };
}

for (const number of [1, 2, 9]) {
  test(`Option+${number} switches to filtered result ${number} in another window`, async () => {
    const { context, worker, page } = await setup();
    try {
      const windowId = await worker.evaluate(async () => {
        const window = await chrome.windows.create({
          url: Array.from(
            { length: 9 },
            (_, index) => `http://127.0.0.1:4173/typescript?shortcut=${index}`,
          ),
          focused: false,
          state: 'minimized',
        });
        return window!.id!;
      });
      const search = page.getByRole('combobox');
      await search.fill('shortcut');
      await expect(page.locator('.search-results')).toHaveAttribute(
        'data-result-count',
        '9',
      );
      await expect(page.locator('.popup')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      const target = Number(
        await page
          .getByRole('option')
          .nth(number - 1)
          .getAttribute('data-tab-id'),
      );
      // Activation closes the popup before Playwright can send keyup. Keep this
      // extension page inspectable and assert the close request separately.
      await page.evaluate(() => {
        (
          window as unknown as { popupCloseRequested: boolean }
        ).popupCloseRequested = false;
        window.close = () => {
          (
            window as unknown as { popupCloseRequested: boolean }
          ).popupCloseRequested = true;
        };
      });
      // The shortcut uses absolute result order, not the highlighted selection.
      await search.press('ArrowDown');
      await search.press(`Alt+${number}`);
      await expect
        .poll(() =>
          worker.evaluate(
            async ({ target, windowId }) => {
              const tab = await chrome.tabs.get(target);
              const window = await chrome.windows.get(windowId);
              return tab.active && window.focused && window.state === 'normal';
            },
            { target, windowId },
          ),
        )
        .toBe(true);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { popupCloseRequested: boolean })
                .popupCloseRequested,
          ),
        )
        .toBe(true);
      await expect(search).toHaveValue('shortcut');
    } finally {
      await context.close();
    }
  });
}

test('macOS Option symbols reopen the corresponding closed result without shortcut setup', async () => {
  const { context, worker, page } = await setup(true);
  try {
    await worker.evaluate(() =>
      chrome.storage.local.set({
        closedTabHistory: Array.from({ length: 3 }, (_, index) => ({
          kind: 'closed',
          key: `closed-shortcut-${index}`,
          title: `Shortcut archive ${index}`,
          url: `about:blank#shortcut-${index}`,
          lastAccessed: Date.now() + 10_000 - index,
          closedAt: Date.now(),
          incognito: false,
        })),
      }),
    );
    const search = page.getByRole('combobox');
    await search.fill('archive');
    await expect(page.getByRole('option')).toHaveCount(3);
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
    const opened = context.waitForEvent('page');
    const defaultAllowed = await search.evaluate((element) =>
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '™',
          code: 'Digit2',
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(defaultAllowed).toBe(false);
    await expect(await opened).toHaveURL('about:blank#shortcut-1');
  } finally {
    await context.close();
  }
});

test('hint fits each search mode and shortcut guards preserve Settings and prevent duplicate activation', async ({}, testInfo) => {
  const { context, page } = await setup();
  try {
    const search = page.getByRole('combobox');
    const hint = await page.evaluate(() =>
      navigator.platform.startsWith('Mac') ? '⌥1–9' : 'Alt+1–9',
    );
    for (const [button, placeholder] of [
      [undefined, 'Search Tabs'],
      ['Exact match', 'Search exact text'],
      ['Use regular expression', 'Search with regex'],
    ] as const) {
      if (button)
        await page.getByRole('button', { name: button, exact: true }).click();
      await expect(search).toHaveAttribute(
        'placeholder',
        `${placeholder} (${hint} to select)`,
      );
      const fits = await search.evaluate((element: HTMLInputElement) => {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d')!;
        context.font = getComputedStyle(element).font;
        return (
          context.measureText(element.placeholder).width <= element.clientWidth
        );
      });
      expect(fits).toBe(true);
    }
    await page
      .getByRole('button', { name: 'Use regular expression', exact: true })
      .click();
    await expect(search).toHaveAccessibleDescription(
      /Press (Option|Alt) and a number from 1 to 9/u,
    );
    await page
      .locator('.popup')
      .screenshot({ path: testInfo.outputPath('shortcut-hint.png') });
    await page.evaluate(() => {
      const state = window as unknown as {
        activations: number;
        releaseActivation: () => void;
      };
      state.activations = 0;
      window.close = () => {};
      const update = chrome.tabs.update.bind(chrome.tabs);
      chrome.tabs.update = ((
        id: number,
        properties: chrome.tabs.UpdateProperties,
      ) => {
        state.activations++;
        return new Promise<chrome.tabs.Tab | undefined>((resolve, reject) => {
          state.releaseActivation = () =>
            update(id, properties).then(resolve, reject);
        });
      }) as typeof chrome.tabs.update;
    });
    await expect(page.getByRole('option')).toHaveCount(1);
    for (const options of [
      { code: 'Digit9' },
      { repeat: true },
      { isComposing: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: false },
      { code: 'Digit0' },
      { code: 'Numpad1' },
    ]) {
      await search.dispatchEvent('keydown', {
        key: '1',
        code: 'Digit1',
        altKey: true,
        ...options,
      });
    }
    const activations = () =>
      page.evaluate(
        () => (window as unknown as { activations: number }).activations,
      );
    expect(await activations()).toBe(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const limit = page.getByRole('spinbutton', {
      name: 'Closed-tab history limit',
      exact: true,
    });
    await limit.focus();
    await limit.press('Alt+1');
    expect(await activations()).toBe(0);
    await page.getByRole('button', { name: 'Close settings' }).click();
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
    // Popup-local shortcuts also work when a search control has keyboard focus.
    const toggle = page.getByRole('button', {
      name: 'Exact match',
      exact: true,
    });
    await toggle.focus();
    await toggle.press('Alt+1');
    await expect.poll(activations).toBe(1);
    await search.press('Alt+1');
    await search.dispatchEvent('keydown', {
      key: '1',
      code: 'Digit1',
      altKey: true,
      repeat: true,
    });
    expect(await activations()).toBe(1);
    await page.evaluate(() =>
      (
        window as unknown as { releaseActivation: () => void }
      ).releaseActivation(),
    );
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
  } finally {
    await context.close();
  }
});
