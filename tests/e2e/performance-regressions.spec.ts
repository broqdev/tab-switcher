import { chromium, expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';

test.use({ viewport: { width: 400, height: 600 } });

interface WorkerTest {
  blocked: boolean;
  held: (() => void)[];
  workers: Worker[];
}
async function delayWorkerResponses(page: Page) {
  await page.addInitScript(() => {
    const state: WorkerTest = { blocked: false, held: [], workers: [] };
    (window as unknown as { workerTest: WorkerTest }).workerTest = state;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        let callback: Worker['onmessage'] = null;
        this.onmessage = (event) => {
          const deliver = () => callback?.call(this, event);
          if (state.blocked && event.data.type === 'results')
            state.held.push(deliver);
          else deliver();
        };
        Object.defineProperty(this, 'onmessage', {
          get: () => callback,
          set: (value: Worker['onmessage']) => {
            callback = value;
          },
        });
        state.workers.push(this);
      }
    };
  });
  await page.reload();
  await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
}

async function seedArchives(
  worker: import('@playwright/test').Worker,
  count = 5,
) {
  await worker.evaluate(
    (count) =>
      chrome.storage.local.set({
        closedTabHistory: Array.from({ length: count }, (_, index) => ({
          kind: 'closed',
          key: `closed-archive-${index}`,
          title: `Archive ${index}`,
          url: `about:blank#archive-${index}`,
          lastAccessed: Date.now() + 100_000 - index,
          closedAt: Date.now(),
          incognito: false,
        })),
      }),
    count,
  );
}

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

test('retained results stay visually stable through typing and stale worker replies', async ({}, testInfo) => {
  const { context, worker, page } = await setup();
  try {
    await seedArchives(worker);
    await delayWorkerResponses(page);
    const search = page.getByRole('combobox');
    const list = page.getByRole('listbox');
    await search.fill('Archive');
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
    await search.press('ArrowDown');
    const selected = page.locator('[data-entry-key="closed-archive-1"]');
    await expect(selected).toHaveClass(/selected/u);
    const before = await list.screenshot({
      path: testInfo.outputPath('ready.png'),
    });
    const style = await selected.evaluate((element) => ({
      opacity: getComputedStyle(element).opacity,
      background: getComputedStyle(element).backgroundColor,
      content: element.innerHTML,
    }));
    await page.evaluate(() => {
      (window as unknown as { workerTest: WorkerTest }).workerTest.blocked =
        true;
    });
    await search.pressSequentially(' 3', { delay: 20 });
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'true');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { workerTest: WorkerTest }).workerTest.held
              .length,
        ),
      )
      .toBe(1);
    const pending = await list.screenshot({
      path: testInfo.outputPath('pending.png'),
    });
    expect(
      await selected.evaluate((element) => ({
        opacity: getComputedStyle(element).opacity,
        background: getComputedStyle(element).backgroundColor,
        content: element.innerHTML,
      })),
    ).toEqual(style);
    expect(pending.equals(before)).toBe(true);
    // Retained rows look stable but cannot activate an obsolete result.
    await expect(selected).toBeDisabled();
    const pageCount = context.pages().length;
    await selected.evaluate((element: HTMLButtonElement) => element.click());
    expect(context.pages()).toHaveLength(pageCount);
    await expect(search).not.toHaveAttribute('aria-activedescendant');
    await page.evaluate(() =>
      (
        window as unknown as { workerTest: WorkerTest }
      ).workerTest.held.shift()!(),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { workerTest: WorkerTest }).workerTest.held
              .length,
        ),
      )
      .toBe(1);
    await expect(page.locator('.search-results')).toHaveAttribute(
      'data-search-query',
      'Archive',
    );
    expect((await list.screenshot()).equals(before)).toBe(true);
    await page.evaluate(() =>
      (
        window as unknown as { workerTest: WorkerTest }
      ).workerTest.held.shift()!(),
    );
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('option', { selected: true })).toHaveAttribute(
      'data-entry-key',
      'closed-archive-3',
    );
    await expect(page.getByRole('option', { selected: true })).toBeEnabled();
  } finally {
    await context.close();
  }
});

test('an empty result keeps its message visible until replacement results commit', async () => {
  const { context, worker, page } = await setup();
  try {
    await seedArchives(worker);
    await delayWorkerResponses(page);
    const search = page.getByRole('combobox');
    await search.fill('zxqzxqzxq');
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
    const empty = page.getByText('No matching tabs', { exact: true });
    await expect(empty).toBeVisible();
    const before = await page.locator('.empty-state').screenshot();
    await page.evaluate(() => {
      (window as unknown as { workerTest: WorkerTest }).workerTest.blocked =
        true;
    });
    await search.fill('');
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'true');
    await expect(empty).toBeVisible();
    expect(
      (await page.locator('.empty-state').screenshot()).equals(before),
    ).toBe(true);
    await search.fill('Archive 3');
    await expect(empty).toBeVisible();
    await expect(page.getByRole('option')).toHaveCount(0);
    await page.evaluate(() => {
      const state = (window as unknown as { workerTest: WorkerTest })
        .workerTest;
      state.blocked = false;
      state.held.splice(0).forEach((deliver) => deliver());
    });
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
    await expect(empty).toHaveCount(0);
    await expect(page.getByRole('option', { selected: true })).toHaveAttribute(
      'data-entry-key',
      'closed-archive-3',
    );
  } finally {
    await context.close();
  }
});

test('retained results keep their scroll position until the new query commits', async () => {
  const { context, worker, page } = await setup();
  try {
    await seedArchives(worker, 200);
    await delayWorkerResponses(page);
    const search = page.getByRole('combobox');
    const list = page.getByRole('listbox');
    await search.fill('Archive');
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
    await list.evaluate((element) => {
      element.scrollTop = 48 * 100;
    });
    const deep = page.locator('[data-entry-key="closed-archive-100"]');
    await expect(deep.locator('.tab-title mark')).toHaveText('Archive');
    const before = await list.evaluate((element) => element.scrollTop);
    await page.evaluate(() => {
      (window as unknown as { workerTest: WorkerTest }).workerTest.blocked =
        true;
    });
    await search.pressSequentially(' 1', { delay: 20 });
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'true');
    expect(await list.evaluate((element) => element.scrollTop)).toBe(before);
    await expect(deep).toBeInViewport();
    await page.evaluate(() => {
      const state = (window as unknown as { workerTest: WorkerTest })
        .workerTest;
      state.blocked = false;
      state.held.splice(0).forEach((deliver) => deliver());
    });
    await expect(page.locator('.search-results')).toHaveAttribute(
      'data-search-query',
      'Archive 1',
    );
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
    expect(await list.evaluate((element) => element.scrollTop)).toBe(0);
  } finally {
    await context.close();
  }
});

for (const activation of ['keyboard', 'click'] as const) {
  test(`windows 10,000 rows, wraps selection, and reopens a distant closed row by ${activation}`, async () => {
    const { context, worker, page } = await setup();
    try {
      await worker.evaluate(() =>
        chrome.storage.local.set({
          closedTabHistory: Array.from({ length: 10_000 }, (_, index) => ({
            kind: 'closed',
            key: `closed-window-${index}`,
            title: `Archive ${index}`,
            url: `about:blank#archive-${index}`,
            lastAccessed: Date.now() + 1_000_000 - index * 10,
            closedAt: Date.now(),
            incognito: false,
          })),
        }),
      );
      const results = page.locator('.search-results');
      await expect(results).toHaveAttribute('data-result-count', '10001');
      expect(await page.getByRole('option').count()).toBeLessThanOrEqual(50);
      const search = page.getByRole('combobox');
      const list = page.getByRole('listbox');
      // A deep row must fetch its highlight payload from the worker, since
      // only the first 50 highlights accompany the full ranked order.
      await search.fill('Archive');
      await expect(results).toHaveAttribute('data-result-count', '10000');
      await list.evaluate((element) => {
        element.scrollTop = 48 * 5_000;
      });
      await expect(
        page
          .getByRole('option', {
            name: 'Archive 5000, closed tab',
            exact: true,
          })
          .locator('.tab-title mark'),
      ).toHaveText('Archive');
      await search.fill('');
      await expect(results).toHaveAttribute('data-result-count', '10001');
      await list.evaluate((element) => {
        element.scrollTop = 48 * 5_000;
      });
      await expect(
        page.getByRole('option', {
          name: 'Archive 5000, closed tab',
          exact: true,
        }),
      ).toBeInViewport();
      const activeId = await search.getAttribute('aria-activedescendant');
      await expect(page.locator(`[id="${activeId}"]`)).toHaveCount(1);
      expect(await page.getByRole('option').count()).toBeLessThanOrEqual(50);
      // Wrap from the first logical option to the last, even after mouse scrolling.
      await search.press('ArrowUp');
      await expect(
        page.getByRole('option', { selected: true }),
      ).toHaveAttribute('aria-posinset', '10001');
      await expect(
        page.getByRole('option', { selected: true }),
      ).toBeInViewport();
      await search.press('ArrowDown');
      await expect(
        page.getByRole('option', { selected: true }),
      ).toHaveAttribute('aria-posinset', '1');
      await search.press('ArrowUp');
      await search.press('ArrowUp');
      const lastClosed = page.getByRole('option', {
        name: 'Archive 9999, closed tab',
        exact: true,
      });
      await expect(lastClosed).toBeInViewport();
      await expect(lastClosed).toHaveAttribute('aria-setsize', '10001');
      await expect(lastClosed).toHaveAttribute('aria-posinset', '10000');
      await search.fill('Archive 5000');
      await expect(results).toHaveAttribute('data-result-count', '1');
      await expect(
        page.getByRole('option', { selected: true }),
      ).toBeInViewport();
      await expect
        .poll(() => list.evaluate((element) => element.scrollTop))
        .toBe(0);
      await search.fill('');
      await expect(results).toHaveAttribute('data-result-count', '10001');
      await search.press('ArrowUp');
      await search.press('ArrowUp');
      const opened = context.waitForEvent('page');
      if (activation === 'keyboard') await search.press('Enter');
      else await lastClosed.click();
      await expect(await opened).toHaveURL('about:blank#archive-9999');
    } finally {
      await context.close();
    }
  });
}

test('hidden history skips reads, ignores a stale enabled read, and loads latest data with error recovery', async () => {
  const { context, worker, page } = await setup(false);
  try {
    const toggle = page.getByRole('checkbox', { name: 'Show closed tabs' });
    await page.evaluate(() => {
      const state = window as unknown as {
        releaseHistory?: () => void;
        restoreHistory?: () => void;
        reads: number;
      };
      const original = chrome.storage.local.get.bind(chrome.storage.local);
      state.reads = 0;
      state.restoreHistory = () => {
        chrome.storage.local.get = original;
      };
      chrome.storage.local.get = new Proxy(original, {
        apply(target, thisArg, args) {
          if (args[0] !== 'closedTabHistory')
            return Reflect.apply(target, thisArg, args);
          state.reads++;
          return new Promise((resolve) => {
            state.releaseHistory = () => {
              state.restoreHistory!();
              resolve(Reflect.apply(target, thisArg, args));
            };
          });
        },
      });
    });
    await toggle.check();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { reads: number }).reads),
      )
      .toBe(1);
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'true');
    await expect(toggle).toBeEnabled();
    await toggle.uncheck();
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
    await page.evaluate(() =>
      (window as unknown as { releaseHistory: () => void }).releaseHistory(),
    );
    await worker.evaluate(() =>
      chrome.storage.local.set({
        closedTabHistory: [
          {
            kind: 'closed',
            key: 'closed-latest',
            title: 'Latest archive',
            url: 'about:blank#latest',
            lastAccessed: Date.now(),
            closedAt: Date.now(),
            incognito: false,
          },
        ],
      }),
    );
    await expect(page.locator('[data-entry-kind="closed"]')).toHaveCount(0);
    await page.evaluate(() => {
      const original = chrome.storage.local.get.bind(chrome.storage.local);
      (window as unknown as { restoreHistory: () => void }).restoreHistory =
        () => {
          chrome.storage.local.get = original;
        };
      chrome.storage.local.get = new Proxy(original, {
        apply(target, thisArg, args) {
          if (args[0] === 'closedTabHistory')
            return Promise.reject(new Error('Temporary history failure'));
          return Reflect.apply(target, thisArg, args);
        },
      });
    });
    await toggle.check();
    await expect(
      page.getByText('Could not load your tab history. Try again.'),
    ).toBeVisible();
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
    await page.evaluate(() =>
      (window as unknown as { restoreHistory: () => void }).restoreHistory(),
    );
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(
      page.getByRole('option', { name: 'Latest archive, closed tab' }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

for (const navigation of [false, true])
  test(`overlapping responses keep the latest query and queued ${navigation ? 'ArrowUp/Enter' : 'Enter'} uses its result`, async () => {
    const { context, worker, page } = await setup();
    try {
      await seedArchives(worker);
      await delayWorkerResponses(page);
      await page.evaluate(() => {
        (window as unknown as { workerTest: WorkerTest }).workerTest.blocked =
          true;
      });
      const search = page.getByRole('combobox');
      await search.fill('Archive 1');
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { workerTest: WorkerTest }).workerTest.held
                .length,
          ),
        )
        .toBe(1);
      await search.fill('Archive 2');
      const query = navigation ? 'Archive' : 'Archive 3';
      await search.fill(query);
      await expect(search).toHaveValue(query);
      await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'true');
      await expect(page.getByRole('option').first()).toBeDisabled();
      const opened = context.waitForEvent('page');
      if (navigation) await search.press('ArrowUp');
      await search.press('Enter');
      await page.evaluate(() =>
        (
          window as unknown as { workerTest: WorkerTest }
        ).workerTest.held.shift()!(),
      );
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { workerTest: WorkerTest }).workerTest.held
                .length,
          ),
        )
        .toBe(1);
      await expect(page.locator('.search-results')).toHaveAttribute(
        'data-search-query',
        '',
      );
      await page.evaluate(() =>
        (
          window as unknown as { workerTest: WorkerTest }
        ).workerTest.held.shift()!(),
      );
      await expect(await opened).toHaveURL(
        navigation ? 'about:blank#archive-4' : 'about:blank#archive-3',
      );
    } finally {
      await context.close();
    }
  });

test('mode/history changes supersede pending results and a failed worker recovers on a new query', async () => {
  const { context, worker, page } = await setup();
  try {
    await seedArchives(worker);
    await delayWorkerResponses(page);
    await page.evaluate(() => {
      (window as unknown as { workerTest: WorkerTest }).workerTest.blocked =
        true;
    });
    const search = page.getByRole('combobox');
    await search.fill('Archive');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { workerTest: WorkerTest }).workerTest.held
              .length,
        ),
      )
      .toBe(1);
    await page
      .getByRole('button', { name: 'Use regular expression', exact: true })
      .click();
    await search.fill('[');
    const closed = page.getByRole('checkbox', { name: 'Show closed tabs' });
    await closed.uncheck();
    await expect(page.locator('[data-entry-kind="closed"]')).toHaveCount(0);
    await page.evaluate(() => {
      const state = (window as unknown as { workerTest: WorkerTest })
        .workerTest;
      state.blocked = false;
      state.held.splice(0).forEach((deliver) => deliver());
    });
    await expect(
      page.getByText('Invalid regular expression.', { exact: true }),
    ).toBeVisible();
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
    await page
      .getByRole('button', { name: 'Exact match', exact: true })
      .click();
    await search.fill('Archive 3');
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('option')).toHaveCount(0);
    await closed.check();
    await expect(
      page.getByRole('option', { name: 'Archive 3, closed tab', exact: true }),
    ).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { workerTest: WorkerTest }).workerTest.workers
        .at(-1)!
        .dispatchEvent(
          new ErrorEvent('error', {
            cancelable: true,
            message: 'Simulated worker failure',
          }),
        ),
    );
    await expect(
      page.getByText('Could not search tabs. Change the search to retry.'),
    ).toBeVisible();
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
    await search.fill('Archive 4');
    await expect(
      page.getByRole('option', { name: 'Archive 4, closed tab', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('option').locator('mark')).toContainText(
      'Archive 4',
    );
  } finally {
    await context.close();
  }
});

test('Enter during a live dataset refresh retains the selected tab instead of activating the first result', async () => {
  const { context, worker, page } = await setup();
  try {
    await seedArchives(worker);
    await delayWorkerResponses(page);
    const search = page.getByRole('combobox');
    await search.fill('Archive');
    await expect(page.locator('.popup')).toHaveAttribute('aria-busy', 'false');
    await search.press('ArrowDown');
    await expect(page.getByRole('option', { selected: true })).toHaveAttribute(
      'data-entry-key',
      'closed-archive-1',
    );
    await page.evaluate(() => {
      (window as unknown as { workerTest: WorkerTest }).workerTest.blocked =
        true;
    });
    await worker.evaluate(async () => {
      const stored = await chrome.storage.local.get('closedTabHistory');
      const entries = stored.closedTabHistory as { closedAt: number }[];
      entries[0]!.closedAt += 1;
      await chrome.storage.local.set({ closedTabHistory: entries });
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { workerTest: WorkerTest }).workerTest.held
              .length,
        ),
      )
      .toBe(1);
    const opened = context.waitForEvent('page');
    await search.press('Enter');
    await page.evaluate(() =>
      (
        window as unknown as { workerTest: WorkerTest }
      ).workerTest.held.shift()!(),
    );
    await expect(await opened).toHaveURL('about:blank#archive-1');
  } finally {
    await context.close();
  }
});
