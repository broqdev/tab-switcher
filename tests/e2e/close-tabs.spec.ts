import { chromium, expect, test } from '@playwright/test';
import { resolve } from 'node:path';

async function setup(showClosed = true) {
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
  await expect
    .poll(() =>
      worker.evaluate(async () =>
        Boolean(
          (await chrome.storage.session.get('tabHistorySession'))
            .tabHistorySession,
        ),
      ),
    )
    .toBe(true);
  await worker.evaluate(
    (showClosed) => chrome.storage.local.set({ showClosedTabs: showClosed }),
    showClosed,
  );
  const page = context.pages()[0]!;
  await page.goto(`${worker.url().replace(/\/[^/]*$/, '')}/popup.html`);
  await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
  return { context, worker, page };
}

for (const showClosed of [false, true]) {
  test(`closes open results without activation and keeps search usable with history ${showClosed ? 'shown' : 'hidden'}`, async ({}, testInfo) => {
    const { context, page } = await setup(showClosed);
    try {
      const targets = await page.evaluate(async () => {
        const handbook = await chrome.tabs.create({
          url: 'http://127.0.0.1:4173/typescript',
          active: false,
        });
        const release = await chrome.tabs.create({
          url: 'http://127.0.0.1:4173/release',
          active: false,
        });
        const other = await chrome.windows.create({
          url: [
            'http://127.0.0.1:4173/recipes',
            'http://127.0.0.1:4173/other-window',
          ],
          focused: false,
        });
        return {
          handbook: handbook.id!,
          release: release.id!,
          recipe: other!.tabs![0]!.id!,
          otherWindow: other!.id!,
          popupTab: (await chrome.tabs.getCurrent())!.id!,
        };
      });
      await expect(
        page.getByRole('option', { name: 'Dinner Recipes', exact: true }),
      ).toBeVisible();
      const search = page.getByRole('combobox');
      await search.fill('TypeScript');
      await expect(page.locator('.popup')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      const handbook = page.getByRole('option', {
        name: 'TypeScript Handbook',
        exact: true,
      });
      const close = page.getByRole('button', {
        name: 'Close TypeScript Handbook',
        exact: true,
      });
      // Pick a different row before checking the native hover affordance.
      await page
        .getByRole('option', { name: 'TypeScript Release Notes', exact: true })
        .hover();
      await search.hover();
      await expect(close).toHaveCSS('opacity', '0');
      const titleBefore = await handbook.locator('.tab-title').boundingBox();
      await handbook.hover();
      await expect(close).toHaveCSS('opacity', '1');
      expect(await handbook.locator('.tab-title').boundingBox()).toEqual(
        titleBefore,
      );
      await page
        .locator('.popup')
        .screenshot({ path: testInfo.outputPath('close-hover.png') });
      const popupUrl = page.url();
      await close.click();
      await expect(
        page.locator(`[data-tab-id="${targets.handbook}"]`),
      ).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(
            async (id) =>
              (await chrome.tabs.query({})).some((tab) => tab.id === id),
            targets.handbook,
          ),
        )
        .toBe(false);
      await expect(search).toHaveValue('TypeScript');
      await expect(search).toBeFocused();
      await expect(page).toHaveURL(popupUrl);
      await expect(
        page.getByRole('option', { selected: true }),
      ).toHaveAttribute('data-tab-id', String(targets.release));
      if (showClosed) {
        const closed = page.getByRole('option', {
          name: 'TypeScript Handbook, closed tab',
          exact: true,
        });
        await expect(closed).toBeVisible();
        await expect(closed).toHaveAttribute('data-entry-kind', 'closed');
      } else await expect(handbook).toHaveCount(0);
      await expect(close).toHaveCount(0);

      // Closing the active tab in another window must not focus that window.
      await search.fill('Dinner Recipes');
      await expect(page.locator('.popup')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      const recipeClose = page.getByRole('button', {
        name: 'Close Dinner Recipes',
        exact: true,
      });
      await recipeClose.focus();
      await expect(recipeClose).toHaveCSS('opacity', '1');
      await recipeClose.press('Space');
      await expect(
        page.locator(`[data-tab-id="${targets.recipe}"]`),
      ).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(
            async (id) =>
              (await chrome.tabs.query({})).some((tab) => tab.id === id),
            targets.recipe,
          ),
        )
        .toBe(false);
      await expect(search).toHaveValue('Dinner Recipes');
      await expect(search).toBeFocused();
      expect(
        await page.evaluate(
          async () =>
            (await chrome.tabs.query({ active: true, currentWindow: true }))[0]!
              .id,
        ),
      ).toBe(targets.popupTab);
      expect(
        await page.evaluate(
          async (id) => (await chrome.windows.get(id)).focused,
          targets.otherWindow,
        ),
      ).toBe(false);
      await expect(recipeClose).toHaveCount(0);
      if (showClosed)
        await expect(
          page.getByRole('option', {
            name: 'Dinner Recipes, closed tab',
            exact: true,
          }),
        ).toBeVisible();
      else
        await expect(
          page.getByText('No matching tabs', { exact: true }),
        ).toBeVisible();
    } finally {
      await context.close();
    }
  });
}

for (const active of [false, true]) {
  test(`actual toolbar popup closes ${active ? 'active' : 'inactive'} tabs and follows Chrome popup lifetime`, async () => {
    const { context, worker, page } = await setup(false);
    try {
      const activeId = await worker.evaluate(
        async (active) =>
          (
            await chrome.tabs.create({
              url: 'http://127.0.0.1:4173/typescript',
              active,
            })
          ).id!,
        active,
      );
      await expect(
        page.getByRole('option', { name: 'TypeScript Handbook', exact: true }),
      ).toBeVisible();
      const cdp = await context.browser()!.newBrowserCDPSession();
      const pageCdp = await context.newCDPSession(page);
      const ordinaryTarget = (await pageCdp.send('Target.getTargetInfo'))
        .targetInfo.targetId;
      await worker.evaluate(() => chrome.action.openPopup());
      const nativeTarget = (
        await cdp.send('Target.getTargets')
      ).targetInfos.find(
        (target) =>
          target.url.endsWith('/popup.html') &&
          target.targetId !== ordinaryTarget,
      )!;
      expect(nativeTarget).toBeTruthy();
      // Chrome does not expose toolbar popups as Playwright Pages. Attach to its
      // real CDP target to exercise popup dismissal when the active tab closes.
      const { sessionId } = await cdp.send('Target.attachToTarget', {
        targetId: nativeTarget.targetId,
        flatten: false,
      });
      let nextId = 0;
      async function sendPopup(
        method: string,
        params: Record<string, unknown>,
      ) {
        const id = ++nextId;
        let receive: (event: { sessionId: string; message: string }) => void;
        let timer: ReturnType<typeof setTimeout>;
        const response = new Promise<{ result?: { value?: unknown } }>(
          (resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Native popup command timed out')),
              5000,
            );
            receive = (event) => {
              if (event.sessionId !== sessionId) return;
              const reply = JSON.parse(event.message);
              if (reply.id !== id) return;
              if (reply.error || reply.result?.exceptionDetails)
                reject(new Error(JSON.stringify(reply)));
              else resolve(reply.result);
            };
            cdp.on('Target.receivedMessageFromTarget', receive);
          },
        );
        try {
          await cdp.send('Target.sendMessageToTarget', {
            sessionId,
            message: JSON.stringify({ id, method, params }),
          });
          return await response;
        } finally {
          clearTimeout(timer!);
          cdp.off('Target.receivedMessageFromTarget', receive!);
        }
      }
      const evaluate = async (expression: string) =>
        (
          await sendPopup('Runtime.evaluate', {
            expression,
            returnByValue: true,
          })
        ).result?.value;
      await expect
        .poll(() =>
          evaluate(
            'document.querySelector(".popup")?.getAttribute("aria-busy")',
          ),
        )
        .toBe('false');
      await sendPopup('Input.insertText', { text: 'TypeScript' });
      await expect
        .poll(() =>
          evaluate(
            'document.querySelector(".search-results")?.dataset.searchQuery',
          ),
        )
        .toBe('TypeScript');
      await evaluate(
        `document.querySelector('[data-tab-id="${activeId}"]').closest('li').querySelector('.tab-close').click()`,
      );
      await expect
        .poll(() =>
          worker.evaluate(
            async (id) =>
              (await chrome.tabs.query({})).some((tab) => tab.id === id),
            activeId,
          ),
        )
        .toBe(false);
      // The browser dismisses extension popups when their host window changes
      // active tab. Inactive-tab removal leaves the same popup and query intact.
      await expect
        .poll(async () =>
          (await cdp.send('Target.getTargets')).targetInfos.some(
            (target) => target.targetId === nativeTarget.targetId,
          ),
        )
        .toBe(!active);
      if (!active) {
        await expect
          .poll(() =>
            evaluate(
              'document.querySelector(".popup")?.getAttribute("aria-busy")',
            ),
          )
          .toBe('false');
        expect(
          await evaluate('document.querySelector("[role=combobox]").value'),
        ).toBe('TypeScript');
        expect(
          await evaluate('document.activeElement.getAttribute("role")'),
        ).toBe('combobox');
      }
    } finally {
      await context.close();
    }
  });
}

test('guards duplicate closes and Enter while closing, then retries a failed close', async () => {
  const { context, page } = await setup(false);
  try {
    const target = await page.evaluate(
      async () =>
        (
          await chrome.tabs.create({
            url: 'http://127.0.0.1:4173/typescript',
            active: false,
          })
        ).id!,
    );
    const row = page.getByRole('option', {
      name: 'TypeScript Handbook',
      exact: true,
    });
    await expect(row).toBeVisible();
    const search = page.getByRole('combobox');
    await search.fill('TypeScript');
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
    await page.evaluate(() => {
      const state = window as unknown as {
        removeCalls: number;
        activationCalls: number;
        rejectClose: () => void;
      };
      state.removeCalls = 0;
      state.activationCalls = 0;
      const original = chrome.tabs.remove.bind(chrome.tabs);
      chrome.tabs.remove = new Proxy(original, {
        apply(target, thisArg, args) {
          state.removeCalls++;
          if (state.removeCalls === 1)
            return new Promise((_, reject) => {
              state.rejectClose = () =>
                reject(new Error('Simulated tab close failure'));
            });
          return Reflect.apply(target, thisArg, args);
        },
      });
      chrome.tabs.update = new Proxy(chrome.tabs.update, {
        apply(target, thisArg, args) {
          state.activationCalls++;
          return Reflect.apply(target, thisArg, args);
        },
      });
    });
    const close = page.getByRole('button', {
      name: 'Close TypeScript Handbook',
      exact: true,
    });
    await close.focus();
    await close.press('Enter');
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'true');
    await expect(close).toBeDisabled();
    await expect(search).toBeEnabled();
    await close.evaluate((element: HTMLButtonElement) => {
      element.click();
      element.click();
    });
    await search.press('Enter');
    await search.press('Alt+1');
    expect(
      await page.evaluate(() => {
        const state = window as unknown as {
          removeCalls: number;
          activationCalls: number;
        };
        return { remove: state.removeCalls, activate: state.activationCalls };
      }),
    ).toEqual({ remove: 1, activate: 0 });
    await page.evaluate(() =>
      (window as unknown as { rejectClose: () => void }).rejectClose(),
    );
    await expect(page.getByRole('alert')).toContainText(
      'Could not close that tab. Try again.',
    );
    await expect(close).toBeEnabled();
    expect(
      await page.evaluate(async (id) => (await chrome.tabs.get(id)).id, target),
    ).toBe(target);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as unknown as { removeCalls: number }).removeCalls,
      ),
    ).toBe(2);
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('TypeScript');
  } finally {
    await context.close();
  }
});
