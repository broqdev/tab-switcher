import {
  test as base,
  expect,
  chromium,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function launchExtension(
  profile = '',
  extensionPath = resolve('.output/chrome-mv3'),
) {
  return chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 400, height: 600 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
}

async function openPopup(context: BrowserContext) {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('chrome://extensions');
  const extension = page
    .locator('extensions-item')
    .filter({ hasText: 'Tab Switcher' });
  await expect(extension).toHaveCount(1);
  const extensionId = await extension.getAttribute('id');
  expect(extensionId).toBeTruthy();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByRole('listbox')).toBeVisible();
  await expect(page.getByRole('combobox')).toBeFocused();
  return page;
}

async function openSettings(page: Page) {
  const toggle = page.getByRole('button', { name: 'Settings', exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('region', { name: 'Settings', exact: true }),
  ).toBeVisible();
}

const test = base.extend<{ popup: Page }>({
  context: async ({}, use) => {
    const context = await launchExtension();
    try {
      await use(context);
    } finally {
      await context.close();
    }
  },
  popup: async ({ context }, use) => {
    await use(await openPopup(context));
  },
});

test('lists every window in descending native access order and fuzzy filters title / URL', async ({
  popup,
}) => {
  const ids = await popup.evaluate(async () => {
    const first = await chrome.tabs.create({
      url: 'http://127.0.0.1:4173/typescript',
      active: false,
    });
    const second = await chrome.tabs.create({
      url: 'http://127.0.0.1:4173/release',
      active: false,
    });
    const otherWindow = await chrome.windows.create({
      url: 'http://127.0.0.1:4173/recipes',
      focused: false,
    });
    return { first: first.id!, second: second.id!, windowId: otherWindow!.id! };
  });
  await expect(
    popup.getByRole('option', { name: /Dinner Recipes/u }),
  ).toBeVisible();
  await expect(
    popup.getByRole('option', { name: /TypeScript Handbook/u }),
  ).toBeVisible();
  await popup.evaluate(async ({ first, second }) => {
    await chrome.tabs.update(first, { active: true });
    await chrome.tabs.update(second, { active: true });
  }, ids);
  await expect
    .poll(async () => {
      const times = await popup
        .getByRole('option')
        .evaluateAll((rows) =>
          rows.map((row) => Number(row.getAttribute('data-last-accessed'))),
        );
      return times.every(
        (time, index) => index === 0 || time <= times[index - 1]!,
      );
    })
    .toBe(true);

  const search = popup.getByRole('combobox');
  await search.fill('typescrpt');
  await expect(popup.getByRole('option')).toHaveCount(2);
  const idsInList = await popup
    .getByRole('option')
    .evaluateAll((rows) =>
      rows.map((row) => Number(row.getAttribute('data-tab-id'))),
    );
  expect(idsInList).toEqual([ids.second, ids.first]);

  await search.fill('recipes 127.0.0.1');
  await expect(popup.getByRole('option')).toHaveCount(1);
  await expect(popup.getByRole('option')).toContainText('Dinner Recipes');
  await search.fill('zzzzzzzzzzzzzzzz');
  await expect(popup.getByText('No matching tabs')).toBeVisible();
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(popup.getByRole('option')).toHaveCount(4);
});

test('search ranks titles before URLs and retains domain priority within URL results', async ({
  popup,
  context,
}) => {
  const fixtures = [
    { url: 'https://x.com/home', title: 'Alpha Reseurch home' },
    { url: 'https://mobile.x.com/profile', title: 'Alpha profile' },
    {
      url: 'https://example.org/?next=https://x.com/home',
      title: 'Alpha x.com research discussion',
    },
    { url: 'https://notx.com/page', title: 'Alpha elsewhere' },
    { url: 'https://y.com/home', title: 'Alphe unrelated' },
    { url: 'https://example.net/alpha', title: 'URL reference' },
  ];
  // Controlled pages retain real hostnames without contacting those sites.
  await context.route('https://**/*', async (route) => {
    const fixture = fixtures.find(({ url }) => url === route.request().url());
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>${fixture?.title || 'Fixture'}</title>`,
    });
  });
  for (const { url, title } of fixtures) {
    const page = await context.newPage();
    await page.goto(url);
    await expect(page).toHaveTitle(title);
  }
  const ids = await popup.evaluate(async (fixtures) => {
    const tabs = await chrome.tabs.query({});
    return fixtures.map(({ url }) => tabs.find((tab) => tab.url === url)!.id!);
  }, fixtures);
  for (const { title } of fixtures) {
    await expect(
      popup.getByRole('option', { name: title, exact: true }),
    ).toBeVisible();
  }
  await popup.evaluate(async (ids) => {
    for (const id of ids) {
      await chrome.tabs.update(id, { active: true });
      // Give each native access timestamp a distinct value.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await chrome.storage.local.set({
      closedTabHistory: [
        {
          kind: 'closed',
          key: 'closed-domain-fixture',
          title: 'Alpha saved post',
          url: 'https://x.com/saved',
          lastAccessed: Date.now() - 60_000,
          closedAt: Date.now() - 30_000,
          incognito: false,
        },
      ],
    });
  }, ids);
  await expect(
    popup.getByRole('option', { name: 'Alpha saved post, closed tab' }),
  ).toBeVisible();
  const search = popup.getByRole('combobox');
  const rows = popup.getByRole('option');
  const keys = () =>
    rows.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-entry-key')),
    );
  const [home, profile, discussion, incidental, unrelated, urlOnly] = ids.map(
    (id) => `open-${id}`,
  );
  const closed = 'closed-domain-fixture';
  await search.pressSequentially('x.com');
  await expect
    .poll(keys)
    .toEqual([discussion, profile, home, closed, incidental]);
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
  const checkbox = popup.getByRole('checkbox', {
    name: 'Show closed tabs',
    exact: true,
  });
  await checkbox.uncheck();
  await expect.poll(keys).toEqual([discussion, profile, home, incidental]);
  await checkbox.check();
  await expect
    .poll(keys)
    .toEqual([discussion, profile, home, closed, incidental]);
  await search.fill('X.COM research');
  await expect.poll(keys).toEqual([discussion, home]);
  await search.fill('alpha');
  await expect
    .poll(keys)
    .toEqual([
      incidental,
      discussion,
      profile,
      home,
      closed,
      unrelated,
      urlOnly,
    ]);
  await popup.getByRole('button', { name: 'Exact match', exact: true }).click();
  await expect
    .poll(keys)
    .toEqual([incidental, discussion, profile, home, closed, urlOnly]);
  const regex = popup.getByRole('button', {
    name: 'Use regular expression',
    exact: true,
  });
  await regex.click();
  await expect
    .poll(keys)
    .toEqual([incidental, discussion, profile, home, closed, urlOnly]);
  await regex.click();
  await search.fill('');
  const fixtureKeys = new Set([...ids.map((id) => `open-${id}`), closed]);
  await expect
    .poll(async () => (await keys()).filter((key) => fixtureKeys.has(key!)))
    .toEqual([
      urlOnly,
      unrelated,
      incidental,
      discussion,
      profile,
      home,
      closed,
    ]);
});

test('search toggles switch between fuzzy, exact phrase, and regex without clearing text', async ({
  popup,
}) => {
  await popup.evaluate(async () => {
    for (const path of ['typescript', 'release']) {
      await chrome.tabs.create({
        url: `http://127.0.0.1:4173/${path}`,
        active: false,
      });
    }
  });
  await expect(
    popup.getByRole('option', { name: 'TypeScript Release Notes' }),
  ).toBeVisible();
  const search = popup.getByRole('combobox');
  const exact = popup.getByRole('button', { name: 'Exact match', exact: true });
  const regex = popup.getByRole('button', {
    name: 'Use regular expression',
    exact: true,
  });
  await search.fill('typescrpt');
  await expect(popup.getByRole('option')).toHaveCount(2);
  await exact.click();
  await expect(exact).toHaveAttribute('aria-pressed', 'true');
  await expect(regex).toHaveAttribute('aria-pressed', 'false');
  await expect(search).toHaveValue('typescrpt');
  await expect(search).toBeFocused();
  await expect(popup.getByRole('option')).toHaveCount(0);
  await search.fill('TypeScript Handbook');
  await expect(popup.getByRole('option')).toHaveCount(1);
  await expect(popup.getByRole('option')).toContainText('TypeScript Handbook');
  await search.fill('Handbook TypeScript');
  await expect(popup.getByRole('option')).toHaveCount(0);
  await exact.click();
  await expect(exact).toHaveAttribute('aria-pressed', 'false');
  await expect(popup.getByRole('option')).toHaveCount(1);
  await search.fill('TypeScript.*');
  await exact.click();
  await expect(popup.getByRole('option')).toHaveCount(0);
  await regex.click();
  await expect(regex).toHaveAttribute('aria-pressed', 'true');
  await expect(exact).toHaveAttribute('aria-pressed', 'false');
  await expect(search).toHaveValue('TypeScript.*');
  await expect(popup.getByRole('option')).toHaveCount(2);
});

test('regex matches titles and URLs and recovers from invalid patterns', async ({
  popup,
}) => {
  await popup.evaluate(async () => {
    for (const path of ['typescript', 'release', 'recipes']) {
      await chrome.tabs.create({
        url: `http://127.0.0.1:4173/${path}`,
        active: false,
      });
    }
  });
  await expect(
    popup.getByRole('option', { name: 'Dinner Recipes' }),
  ).toBeVisible();
  const search = popup.getByRole('combobox');
  await popup
    .getByRole('button', { name: 'Use regular expression', exact: true })
    .click();
  await search.fill('^TypeScript (Handbook|Release Notes)$');
  await expect(popup.getByRole('option')).toHaveCount(2);
  await search.fill('/recipes$');
  await expect(popup.getByRole('option')).toHaveCount(1);
  await expect(popup.getByRole('option')).toContainText('Dinner Recipes');
  await search.fill('[');
  await expect(popup.getByRole('alert')).toHaveText(
    'Invalid regular expression.',
  );
  await expect(search).toHaveAttribute('aria-invalid', 'true');
  await expect(popup.getByRole('option')).toHaveCount(0);
  await expect(
    popup.getByText('No matching tabs', { exact: true }),
  ).toHaveCount(0);
  await search.press('Enter');
  await expect(popup.getByRole('alert')).toBeVisible();
  await search.fill('^\\S+\\sHandbook$');
  await expect(popup.getByRole('option')).toHaveCount(1);
  await expect(popup.getByRole('option')).toContainText('TypeScript Handbook');
  await expect(popup.getByRole('alert')).toHaveCount(0);
  await expect(search).toHaveAttribute('aria-invalid', 'false');
  await search.fill('[');
  await popup.getByRole('button', { name: 'Exact match', exact: true }).click();
  await expect(popup.getByRole('alert')).toHaveCount(0);
  await expect(search).toHaveValue('[');
});

test('closed-tab checkbox filters every search mode and handles live closures', async ({
  popup,
}) => {
  const ids = await popup.evaluate(async () => {
    const open = await chrome.tabs.create({
      url: 'http://127.0.0.1:4173/typescript',
      active: false,
    });
    const closing = await chrome.tabs.create({
      url: 'http://127.0.0.1:4173/release',
      active: false,
    });
    return { open: open.id!, closing: closing.id! };
  });
  await expect(
    popup.getByRole('option', { name: 'TypeScript Release Notes' }),
  ).toBeVisible();
  await popup.evaluate(async (id) => chrome.tabs.remove(id), ids.closing);
  await expect(
    popup.getByRole('option', { name: 'TypeScript Release Notes, closed tab' }),
  ).toBeVisible();
  const checkbox = popup.getByRole('checkbox', {
    name: 'Show closed tabs',
    exact: true,
  });
  const search = popup.getByRole('combobox');
  await expect(checkbox).toBeChecked();
  await search.fill('TypeScript');
  for (const mode of ['fuzzy', 'exact', 'regex']) {
    if (mode === 'exact')
      await popup
        .getByRole('button', { name: 'Exact match', exact: true })
        .click();
    if (mode === 'regex')
      await popup
        .getByRole('button', { name: 'Use regular expression', exact: true })
        .click();
    await expect(popup.getByRole('option')).toHaveCount(2);
    await checkbox.uncheck();
    await expect(popup.getByRole('option')).toHaveCount(1);
    await expect(popup.getByRole('option')).toHaveAttribute(
      'data-entry-kind',
      'open',
    );
    await expect(search).toHaveValue('TypeScript');
    await checkbox.check();
    await expect(popup.getByRole('option')).toHaveCount(2);
  }
  await checkbox.uncheck();
  await popup.evaluate(async (id) => chrome.tabs.remove(id), ids.open);
  await expect(popup.getByRole('option')).toHaveCount(0);
  await checkbox.check();
  await expect(popup.getByRole('option')).toHaveCount(2);
  await expect(popup.locator('[data-entry-kind="closed"]')).toHaveCount(2);
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(checkbox).toBeChecked();
  await expect(
    popup.getByRole('button', { name: 'Use regular expression', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('remembers the closed-tab preference on reload and syncs across Chrome windows', async ({
  popup,
  context,
}) => {
  const tabId = await popup.evaluate(async () => {
    const tab = await chrome.tabs.create({
      url: 'http://127.0.0.1:4173/release',
      active: false,
    });
    return tab.id!;
  });
  await expect(
    popup.getByRole('option', {
      name: 'TypeScript Release Notes',
      exact: true,
    }),
  ).toBeVisible();
  await popup.evaluate(async (id) => chrome.tabs.remove(id), tabId);
  const closed = popup.getByRole('option', {
    name: 'TypeScript Release Notes, closed tab',
    exact: true,
  });
  await expect(closed).toBeVisible();
  const checkbox = popup.getByRole('checkbox', {
    name: 'Show closed tabs',
    exact: true,
  });
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await expect
    .poll(() =>
      popup.evaluate(
        async () =>
          (await chrome.storage.local.get('showClosedTabs')).showClosedTabs,
      ),
    )
    .toBe(false);
  await popup.reload();
  await expect(checkbox).toBeEnabled();
  await expect(checkbox).not.toBeChecked();
  await expect(closed).toHaveCount(0);

  const opened = context.waitForEvent('page');
  await popup.evaluate(async (url) => {
    await chrome.windows.create({ url, focused: false });
  }, popup.url());
  const other = await opened;
  const otherCheckbox = other.getByRole('checkbox', {
    name: 'Show closed tabs',
    exact: true,
  });
  await expect(otherCheckbox).toBeEnabled();
  await expect(otherCheckbox).not.toBeChecked();
  expect(
    await other.evaluate(
      async () => (await chrome.tabs.getCurrent())!.windowId,
    ),
  ).not.toBe(
    await popup.evaluate(
      async () => (await chrome.tabs.getCurrent())!.windowId,
    ),
  );
  const search = popup.getByRole('combobox');
  const exact = popup.getByRole('button', { name: 'Exact match', exact: true });
  await search.fill('TypeScript Release');
  await exact.click();
  await otherCheckbox.check();
  await expect(checkbox).toBeChecked();
  await expect(closed).toBeVisible();
  await expect(search).toHaveValue('TypeScript Release');
  await expect(exact).toHaveAttribute('aria-pressed', 'true');
  await checkbox.uncheck();
  await expect(otherCheckbox).not.toBeChecked();
  await expect(other.locator('[data-entry-kind="closed"]')).toHaveCount(0);
});

test('remembers the closed-tab preference after a full browser restart', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'tab-switcher-preference-'));
  let context: BrowserContext | undefined;
  try {
    context = await launchExtension(profile);
    const popup = await openPopup(context);
    await popup
      .getByRole('checkbox', { name: 'Show closed tabs', exact: true })
      .uncheck();
    await expect
      .poll(() =>
        popup.evaluate(
          async () =>
            (await chrome.storage.local.get('showClosedTabs')).showClosedTabs,
        ),
      )
      .toBe(false);
    await context.close();
    context = undefined;
    context = await launchExtension(profile);
    const reopened = await openPopup(context);
    const checkbox = reopened.getByRole('checkbox', {
      name: 'Show closed tabs',
      exact: true,
    });
    await expect(checkbox).toBeEnabled();
    await expect(checkbox).not.toBeChecked();
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('a live preference change wins over a delayed initial storage read', async ({
  popup,
}) => {
  await popup.addInitScript(() => {
    const state = window as typeof window & { releasePreference?: () => void };
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    const delayedGet = (key: string): Promise<Record<string, unknown>> => {
      if (key !== 'showClosedTabs') return get<Record<string, unknown>>(key);
      return get<Record<string, unknown>>(key).then(
        (snapshot) =>
          new Promise<Record<string, unknown>>((resolve) => {
            state.releasePreference = () => resolve(snapshot);
          }),
      );
    };
    chrome.storage.local.get = delayedGet as typeof chrome.storage.local.get;
  });
  await popup.reload();
  const checkbox = popup.getByRole('checkbox', {
    name: 'Show closed tabs',
    exact: true,
  });
  await expect(checkbox).toBeDisabled();
  await expect
    .poll(() =>
      popup.evaluate(
        () =>
          typeof (window as typeof window & { releasePreference?: () => void })
            .releasePreference,
      ),
    )
    .toBe('function');
  await popup.evaluate(async () => {
    await chrome.storage.local.set({ showClosedTabs: false });
  });
  await expect(checkbox).toBeEnabled();
  await expect(checkbox).not.toBeChecked();
  await popup.evaluate(async () => {
    (window as typeof window & { releasePreference?: () => void })
      .releasePreference!();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(checkbox).not.toBeChecked();
});

test('a failed preference write restores the saved value and allows retry', async ({
  popup,
}) => {
  await popup.evaluate(() => {
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = (() => {
      chrome.storage.local.set = set;
      return Promise.reject(new Error('Storage unavailable'));
    }) as typeof chrome.storage.local.set;
  });
  const checkbox = popup.getByRole('checkbox', {
    name: 'Show closed tabs',
    exact: true,
  });
  await expect(checkbox).toBeChecked();
  await checkbox.click();
  await expect(popup.getByRole('alert')).toHaveText(
    'Could not save this preference. Try again.',
  );
  await expect(checkbox).toBeChecked();
  await expect(checkbox).toBeEnabled();
  await checkbox.uncheck();
  await expect(checkbox).not.toBeChecked();
  await expect(popup.getByRole('alert')).toHaveCount(0);
  await expect
    .poll(() =>
      popup.evaluate(
        async () =>
          (await chrome.storage.local.get('showClosedTabs')).showClosedTabs,
      ),
    )
    .toBe(false);
});

test('short title terms and paper identifiers exclude unrelated open and closed entries', async ({
  popup,
}) => {
  const catId = await popup.evaluate(async () => {
    const cat = await chrome.tabs.create({
      url: 'http://127.0.0.1:4173/search/cats',
      active: false,
    });
    for (const path of ['cars', 'paper-a', 'paper-b']) {
      await chrome.tabs.create({
        url: `http://127.0.0.1:4173/search/${path}`,
        active: false,
      });
    }
    return cat.id!;
  });
  await expect(popup.getByRole('option', { name: 'Cat Photos' })).toBeVisible();
  await expect(
    popup.getByRole('option', { name: 'Car Insurance' }),
  ).toBeVisible();
  await expect(
    popup.getByRole('option', {
      name: '[2610.06783v1] Truly Subquadratic Attention',
    }),
  ).toBeVisible();
  await popup.evaluate(async (id) => chrome.tabs.remove(id), catId);
  await expect(
    popup.getByRole('option', { name: 'Cat Photos, closed tab' }),
  ).toBeVisible();

  const search = popup.getByRole('combobox');
  // Exercise real keystrokes, not just programmatic input replacement.
  await search.pressSequentially('cat');
  await expect(popup.getByRole('option')).toHaveCount(1);
  await expect(popup.getByRole('option')).toHaveAttribute(
    'data-entry-kind',
    'closed',
  );
  await expect(popup.getByRole('option')).toContainText('Cat Photos');
  await search.fill('car');
  await expect(popup.getByRole('option')).toHaveCount(1);
  await expect(popup.getByRole('option')).toContainText('Car Insurance');
  await search.fill('2610.04518');
  await expect(popup.getByRole('option')).toHaveCount(1);
  await expect(popup.getByRole('option')).toContainText('[2610.04518]');
});

test('matches readable and encoded URL text in both open and closed history', async ({
  popup,
}) => {
  const tabId = await popup.evaluate(
    async () =>
      (
        await chrome.tabs.create({
          url: 'http://127.0.0.1:4173/search/reading?topic=机器学习',
          active: false,
        })
      ).id!,
  );
  await expect(
    popup.getByRole('option', { name: 'Research Library' }),
  ).toBeVisible();
  const search = popup.getByRole('combobox');
  await search.fill('机器学习');
  await expect(popup.getByRole('option')).toHaveCount(1);
  await expect(popup.getByRole('option')).toContainText('Research Library');
  await search.fill('library 机器学习');
  await expect(popup.getByRole('option')).toHaveCount(1);
  await popup.evaluate(async (id) => chrome.tabs.remove(id), tabId);
  await expect(popup.getByRole('option')).toHaveAttribute(
    'data-entry-kind',
    'closed',
  );
  await search.fill('%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0');
  await expect(popup.getByRole('option')).toHaveCount(1);
  await search.fill('library 深度学习');
  await expect(popup.getByRole('option')).toHaveCount(0);
  await popup
    .getByRole('button', { name: 'Clear search', exact: true })
    .first()
    .click();
  await expect(search).toHaveValue('');
  await expect(
    popup.getByRole('option', { name: 'Research Library, closed tab' }),
  ).toBeVisible();
});

test('a pasted full URL matches its whole value instead of a shared prefix', async ({
  popup,
}) => {
  const targetUrl =
    'http://127.0.0.1:4173/search/reading?document=reinforcement-learning-notes';
  const targetId = await popup.evaluate(async (url) => {
    const target = await chrome.tabs.create({ url, active: false });
    await chrome.tabs.create({
      url: 'http://127.0.0.1:4173/search/reading?document=reinforcement-learning-other',
      active: false,
    });
    return target.id!;
  }, targetUrl);
  await expect(
    popup.getByRole('option', { name: 'Research Library' }),
  ).toHaveCount(2);
  await popup.getByRole('combobox').fill(targetUrl);
  await expect(popup.getByRole('option')).toHaveCount(1);
  await expect(popup.getByRole('option')).toHaveAttribute(
    'data-tab-id',
    String(targetId),
  );
});

test('normalizes title text while retaining typo matching and recent-first order', async ({
  popup,
}) => {
  await popup.evaluate(async () => {
    for (const path of ['desk', 'handbook']) {
      await chrome.tabs.create({
        url: `http://127.0.0.1:4173/search/${path}`,
        active: false,
      });
    }
  });
  await expect(
    popup.getByRole('option', { name: 'Café Research' }),
  ).toBeVisible();
  await expect(
    popup.getByRole('option', { name: 'ＴｙｐｅＳｃｒｉｐｔ Guide' }),
  ).toBeVisible();
  const search = popup.getByRole('combobox');
  await search.fill('  CAFE   research  ');
  await expect(popup.getByRole('option')).toHaveCount(1);
  await expect(popup.getByRole('option')).toContainText('Café Research');
  await search.fill('typescript');
  await expect(popup.getByRole('option')).toHaveCount(1);
  await expect(popup.getByRole('option')).toContainText(
    'ＴｙｐｅＳｃｒｉｐｔ Guide',
  );
  await search.fill('typescrpt guide');
  await expect(popup.getByRole('option')).toHaveCount(1);
  await search.fill('typescrpt nonexistent');
  await expect(popup.getByRole('option')).toHaveCount(0);
});

test('refreshes when tabs are created, renamed, moved, and closed', async ({
  popup,
}) => {
  const tabId = await popup.evaluate(
    async () =>
      (
        await chrome.tabs.create({
          url: 'http://127.0.0.1:4173/new-tab',
          active: false,
        })
      ).id!,
  );
  await expect(
    popup.getByRole('option', { name: /Freshly Opened Tab/u }),
  ).toBeVisible();
  await popup.evaluate(async (id) => {
    await chrome.tabs.update(id, { url: 'http://127.0.0.1:4173/recipes' });
  }, tabId);
  await expect(
    popup.getByRole('option', { name: /Dinner Recipes/u }),
  ).toBeVisible();
  await popup.evaluate(async (id) => {
    await chrome.windows.create({ tabId: id, focused: false });
  }, tabId);
  await expect(
    popup.getByRole('option', { name: /Dinner Recipes/u }),
  ).toHaveAttribute('title', /Window 2/u);
  await popup.evaluate(async (id) => {
    await chrome.tabs.remove(id);
  }, tabId);
  await expect(
    popup.getByRole('option', { name: /Dinner Recipes/u }),
  ).toHaveAttribute('data-entry-kind', 'closed');
});

test('clicking a result activates the tab and restores and focuses its minimized window', async ({
  popup,
  context,
}) => {
  const target = await popup.evaluate(async () => {
    const window = await chrome.windows.create({
      url: [
        'http://127.0.0.1:4173/other-window',
        'http://127.0.0.1:4173/recipes',
      ],
      focused: false,
    });
    await chrome.windows.update(window!.id!, { state: 'minimized' });
    return { id: window!.tabs![0]!.id!, windowId: window!.id! };
  });
  await expect(
    popup.getByRole('option', { name: /Other Window Workspace/u }),
  ).toBeVisible();
  // Inspect from a second extension page if the UI closes after switching.
  const inspector = await context.newPage();
  await inspector.goto(popup.url());
  await popup.getByRole('option', { name: /Other Window Workspace/u }).click();
  await expect
    .poll(() =>
      inspector.evaluate(async ({ id, windowId }) => {
        const [tab, window] = await Promise.all([
          chrome.tabs.get(id),
          chrome.windows.get(windowId),
        ]);
        return tab.active && window.focused && window.state !== 'minimized';
      }, target),
    )
    .toBe(true);
});

test('arrow keys and Enter switch to the selected result', async ({
  popup,
  context,
}) => {
  const targetId = await popup.evaluate(
    async () =>
      (
        await chrome.tabs.create({
          url: 'http://127.0.0.1:4173/typescript',
          active: false,
        })
      ).id!,
  );
  await popup.evaluate(async () => {
    await chrome.tabs.create({
      url: 'http://127.0.0.1:4173/release',
      active: false,
    });
  });
  const search = popup.getByRole('combobox');
  await search.fill('typescript');
  await expect(popup.getByRole('option')).toHaveCount(2);
  await search.press('ArrowDown');
  const selectedId = Number(
    (await search.getAttribute('aria-activedescendant'))?.replace(
      'tab-open-',
      '',
    ),
  );
  expect(selectedId).toBeTruthy();
  const inspector = await context.newPage();
  await inspector.goto(popup.url());
  await search.press('Enter');
  await expect
    .poll(() =>
      inspector.evaluate(
        async (id) => (await chrome.tabs.get(id)).active,
        selectedId,
      ),
    )
    .toBe(true);
  expect([
    targetId,
    await inspector.evaluate(
      async () =>
        (await chrome.tabs.query({ title: 'TypeScript Release Notes' }))[0]!
          .id!,
    ),
  ]).toContain(selectedId);
});

test('shows a readable failure when activating a tab fails', async ({
  popup,
}) => {
  await popup.evaluate(() => {
    chrome.tabs.update = (() =>
      Promise.reject(new Error('No tab with id'))) as typeof chrome.tabs.update;
  });
  await popup.getByRole('option').first().click();
  await expect(popup.getByRole('alert')).toContainText(
    'Could not switch to that tab',
  );
  await expect(popup.getByRole('option').first()).toBeEnabled();
});

test('searches a closed entry and reopens its URL in a new tab', async ({
  popup,
  context,
}) => {
  const tab = await popup.evaluate(async () =>
    chrome.tabs.create({ url: 'http://127.0.0.1:4173/new-tab', active: false }),
  );
  const row = popup.getByRole('option', { name: /Freshly Opened Tab/u });
  await expect(row).toHaveAttribute('data-entry-kind', 'open');
  await popup.evaluate(async (id) => {
    await chrome.tabs.remove(id);
  }, tab.id!);
  await expect(row).toHaveAttribute('data-entry-kind', 'closed');
  await popup.getByRole('combobox').fill('freshly 127.0.0.1');
  await expect(popup.getByRole('option')).toHaveCount(1);
  const inspector = await context.newPage();
  await inspector.goto(popup.url());
  await row.click();
  await expect
    .poll(() =>
      inspector.evaluate(async (oldId) => {
        const tabs = await chrome.tabs.query({
          url: 'http://127.0.0.1:4173/new-tab',
        });
        return tabs.length === 1 && tabs[0]!.id !== oldId && tabs[0]!.active;
      }, tab.id!),
    )
    .toBe(true);
  await inspector.getByRole('combobox').fill('freshly');
  await expect(inspector.getByRole('option')).toHaveCount(1);
  await expect(inspector.getByRole('option')).toHaveAttribute(
    'data-entry-kind',
    'open',
  );
});

test('remembers closures while the popup is absent, and retains saved history after the worker restarts', async ({
  popup,
  context,
}) => {
  const inspector = await context.newPage();
  await inspector.goto(popup.url());
  const tab = await inspector.evaluate(async () =>
    chrome.tabs.create({ url: 'http://127.0.0.1:4173/new-tab', active: false }),
  );
  await expect(
    inspector.getByRole('option', { name: /Freshly Opened Tab/u }),
  ).toBeVisible();
  await popup.goto('about:blank');
  const popupUrl = inspector.url();
  await inspector.goto('about:blank');
  const target = context
    .pages()
    .find((page) => page.url() === 'http://127.0.0.1:4173/new-tab');
  expect(target).toBeTruthy();
  await target!.close();
  await inspector.goto(popupUrl);
  await expect(
    inspector.getByRole('option', { name: /Freshly Opened Tab/u }),
  ).toHaveAttribute('data-entry-kind', 'closed');
  await expect
    .poll(() =>
      inspector.evaluate(async () => {
        const stored = await chrome.storage.local.get('closedTabHistory');
        return (stored.closedTabHistory as Array<{ url: string }>).some(
          (entry) => entry.url === 'http://127.0.0.1:4173/new-tab',
        );
      }),
    )
    .toBe(true);
  // Stop the actual MV3 worker; the next browser tab event must rehydrate it.
  const cdp = await context.newCDPSession(inspector);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await cdp.detach();
  await inspector.evaluate(async () => {
    await chrome.tabs.create({
      url: 'http://127.0.0.1:4173/recipes',
      active: false,
    });
  });
  await inspector.reload();
  await expect(
    inspector.getByRole('option', { name: /Freshly Opened Tab/u }),
  ).toHaveAttribute('data-entry-kind', 'closed');
  expect(tab.id).toBeDefined();
});

test('keeps the last-access ordering when an older tab closes and includes tabs from a closed window', async ({
  popup,
}) => {
  const window = await popup.evaluate(async () =>
    chrome.windows.create({
      url: [
        'http://127.0.0.1:4173/typescript',
        'http://127.0.0.1:4173/recipes',
      ],
      focused: false,
    }),
  );
  await expect(
    popup.getByRole('option', { name: /TypeScript Handbook/u }),
  ).toBeVisible();
  await expect(
    popup.getByRole('option', { name: /Dinner Recipes/u }),
  ).toBeVisible();
  const oldAccess = Number(
    await popup
      .getByRole('option', { name: /Dinner Recipes/u })
      .getAttribute('data-last-accessed'),
  );
  await popup.evaluate(async (id) => {
    await chrome.windows.remove(id);
  }, window!.id!);
  await expect(
    popup.getByRole('option', { name: /TypeScript Handbook/u }),
  ).toHaveAttribute('data-entry-kind', 'closed');
  await expect(
    popup.getByRole('option', { name: /Dinner Recipes/u }),
  ).toHaveAttribute('data-entry-kind', 'closed');
  expect(
    Number(
      await popup
        .getByRole('option', { name: /Dinner Recipes/u })
        .getAttribute('data-last-accessed'),
    ),
  ).toBe(oldAccess);
  const times = await popup
    .getByRole('option')
    .evaluateAll((rows) =>
      rows.map((row) => Number(row.getAttribute('data-last-accessed'))),
    );
  expect(times).toEqual([...times].sort((a, b) => b - a));
});

test('Settings opens inline and closes back to the same search with mouse and keyboard', async ({
  popup,
  context,
}, testInfo) => {
  await popup.evaluate(async () => {
    for (const path of ['typescript', 'release']) {
      await chrome.tabs.create({
        url: `http://127.0.0.1:4173/${path}`,
        active: false,
      });
    }
  });
  await expect(
    popup.getByRole('option', { name: 'TypeScript Release Notes' }),
  ).toBeVisible();
  const search = popup.getByRole('combobox');
  const toggle = popup.getByRole('button', { name: 'Settings', exact: true });
  const close = popup.getByRole('button', {
    name: 'Close settings',
    exact: true,
  });
  await search.fill('TypeScript');
  await popup.getByRole('button', { name: 'Exact match', exact: true }).click();
  await popup
    .getByRole('checkbox', { name: 'Show closed tabs', exact: true })
    .uncheck();
  await search.focus();
  await search.press('ArrowDown');
  const selectedKey = await popup
    .getByRole('option', { selected: true })
    .getAttribute('data-entry-key');
  const pageCount = context.pages().length;
  const popupUrl = popup.url();
  await openSettings(popup);
  await expect(toggle).toBeFocused();
  await expect(close).toBeVisible();
  await expect(popup.getByRole('listbox')).toBeHidden();
  await expect(search).toHaveValue('TypeScript');
  await expect(search).toHaveAttribute('aria-expanded', 'false');
  await expect(popup).toHaveURL(popupUrl);
  expect(context.pages()).toHaveLength(pageCount);
  const limit = popup.getByRole('spinbutton', {
    name: 'Closed-tab history limit',
    exact: true,
  });
  await expect(limit).toBeEnabled();
  await expect(limit).toHaveValue('10000');
  await expect(
    popup.getByRole('heading', { name: /^(Keyboard shortcut|History)$/u }),
  ).toHaveCount(0);
  await expect(
    popup.getByText('About closed history', { exact: true }),
  ).toHaveCount(0);
  await expect(
    popup.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeVisible();
  const size = await popup.evaluate(() => ({
    width: document.body.scrollWidth,
    height: document.body.scrollHeight,
  }));
  expect(size).toEqual({ width: 400, height: 600 });
  await popup
    .locator('.popup')
    .screenshot({ path: testInfo.outputPath('settings.png') });

  await close.click();
  await expect(close).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('TypeScript');
  await expect(popup.getByRole('option', { selected: true })).toHaveAttribute(
    'data-entry-key',
    selectedKey!,
  );
  await expect(
    popup.getByRole('button', { name: 'Exact match', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    popup.getByRole('checkbox', { name: 'Show closed tabs', exact: true }),
  ).not.toBeChecked();

  await toggle.focus();
  await toggle.press('Enter');
  await expect(close).toBeVisible();
  await limit.focus();
  await limit.press('Escape');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('TypeScript');
  await expect(popup.getByRole('option', { selected: true })).toHaveAttribute(
    'data-entry-key',
    selectedKey!,
  );
  await openSettings(popup);
  await toggle.click();
  await expect(search).toBeFocused();
  await expect(close).toHaveCount(0);
  await openSettings(popup);
  await search.fill('Handbook');
  await expect(close).toHaveCount(0);
  await expect(popup.getByRole('option')).toHaveCount(1);
  await expect(popup.getByRole('option')).toContainText('TypeScript Handbook');
});

test('settings validate, persist, sync across windows, and update history retention live', async ({
  popup,
  context,
}) => {
  await openSettings(popup);
  const settings = popup;
  const limit = settings.getByRole('spinbutton', {
    name: 'Closed-tab history limit',
    exact: true,
  });
  const save = settings.getByRole('button', {
    name: 'Save changes',
    exact: true,
  });
  await expect(limit).toHaveValue('10000');
  await expect(limit).toBeEnabled();
  for (const invalid of ['0', '10001', '2.5', '']) {
    await limit.fill(invalid);
    await save.click();
    await expect(settings.getByRole('alert')).toContainText(
      'Enter a whole number',
    );
    expect(
      await settings.evaluate(
        async () =>
          (await chrome.storage.local.get('historyLimit')).historyLimit,
      ),
    ).toBeUndefined();
  }
  await limit.fill('1000');
  await save.click();
  await expect(settings.getByRole('status')).toHaveText('Saved.');
  await settings.reload();
  await openSettings(settings);
  await expect(limit).toHaveValue('1000');
  const otherOpened = context.waitForEvent('page');
  await settings.evaluate(async (url) => {
    await chrome.windows.create({ url, focused: false });
  }, settings.url());
  const other = await otherOpened;
  await openSettings(other);
  const otherLimit = other.getByRole('spinbutton', {
    name: 'Closed-tab history limit',
    exact: true,
  });
  await expect(otherLimit).toHaveValue('1000');

  const ids = await settings.evaluate(async () =>
    Promise.all(
      ['typescript', 'release', 'recipes'].map(
        async (path) =>
          (
            await chrome.tabs.create({
              url: `http://127.0.0.1:4173/${path}`,
              active: false,
            })
          ).id!,
      ),
    ),
  );
  await expect
    .poll(() =>
      settings.evaluate(
        async (ids) =>
          (await Promise.all(ids.map((id) => chrome.tabs.get(id)))).every(
            (tab) => tab.status === 'complete' && tab.title !== 'Test Tab',
          ),
        ids,
      ),
    )
    .toBe(true);
  await settings.evaluate(async (ids) => chrome.tabs.remove(ids), ids);
  await expect
    .poll(() =>
      settings.evaluate(async () => {
        const { closedTabHistory } =
          await chrome.storage.local.get('closedTabHistory');
        return Array.isArray(closedTabHistory) ? closedTabHistory.length : 0;
      }),
    )
    .toBe(3);

  await otherLimit.fill('2');
  await other
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await expect(other.getByRole('status')).toHaveText('Saved.');
  await expect(limit).toHaveValue('2');
  await expect
    .poll(() =>
      settings.evaluate(async () => {
        const { closedTabHistory } =
          await chrome.storage.local.get('closedTabHistory');
        return Array.isArray(closedTabHistory) ? closedTabHistory.length : 0;
      }),
    )
    .toBe(2);
  const review = await context.newPage();
  await review.goto(settings.url());
  await expect(review.locator('[data-entry-kind="closed"]')).toHaveCount(2);

  await limit.fill('3');
  await save.click();
  await expect(otherLimit).toHaveValue('3');
  const nextId = await settings.evaluate(
    async () =>
      (
        await chrome.tabs.create({
          url: 'http://127.0.0.1:4173/new-tab',
          active: false,
        })
      ).id!,
  );
  await expect
    .poll(() =>
      settings.evaluate(
        async (id) => (await chrome.tabs.get(id)).title,
        nextId,
      ),
    )
    .toBe('Freshly Opened Tab');
  await settings.evaluate(async (id) => chrome.tabs.remove(id), nextId);
  await expect(review.locator('[data-entry-kind="closed"]')).toHaveCount(3);
  await settings.reload();
  await openSettings(settings);
  await expect(limit).toHaveValue('3');
});

test('regular history exceeds the normal storage quota and survives restart and count trimming', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'tab-switcher-large-history-'));
  let context: BrowserContext | undefined;
  try {
    context = await launchExtension(profile);
    let worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent('serviceworker'));
    const ready = () =>
      worker.evaluate(async () =>
        Boolean(
          (await chrome.storage.session.get('tabHistorySession'))
            .tabHistorySession,
        ),
      );
    await expect.poll(ready).toBe(true);
    const snapshot = () =>
      worker.evaluate(async () => {
        const { closedTabHistory } =
          await chrome.storage.local.get('closedTabHistory');
        return {
          keys: (closedTabHistory as Array<{ key: string }>).map(
            ({ key }) => key,
          ),
          bytes: await chrome.storage.local.getBytesInUse('closedTabHistory'),
        };
      });
    await worker.evaluate(async () => {
      const now = Date.now();
      const title = 'x'.repeat(3 * 1024 * 1024);
      await chrome.storage.local.set({
        closedTabHistory: Array.from({ length: 4 }, (_, index) => ({
          kind: 'closed',
          key: `closed-large-${index}`,
          title,
          url: `https://example.com/large/${index}`,
          lastAccessed: now - index * 1000,
          closedAt: now - index * 500,
          incognito: false,
        })),
      });
    });
    expect((await snapshot()).bytes).toBeGreaterThan(10 * 1024 * 1024);
    await context.close();
    context = undefined;
    context = await launchExtension(profile);
    worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent('serviceworker'));
    await expect.poll(ready).toBe(true);
    await expect
      .poll(async () =>
        (await snapshot()).keys.filter((key) =>
          key.startsWith('closed-large-'),
        ),
      )
      .toEqual([
        'closed-large-0',
        'closed-large-1',
        'closed-large-2',
        'closed-large-3',
      ]);
    const beforeTrim = await snapshot();
    expect(beforeTrim.bytes).toBeGreaterThan(10 * 1024 * 1024);
    await worker.evaluate(async () =>
      chrome.storage.local.set({ historyLimit: 3 }),
    );
    await expect
      .poll(async () => (await snapshot()).keys)
      // Chrome can also import a recently closed startup tab on restart.
      .toEqual(beforeTrim.keys.slice(0, 3));
    expect((await snapshot()).bytes).toBeGreaterThan(5 * 1024 * 1024);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('a saved custom history limit survives a browser restart and retains more than 500 entries', async () => {
  const profile = await mkdtemp(
    join(tmpdir(), 'tab-switcher-history-setting-'),
  );
  let context: BrowserContext | undefined;
  try {
    context = await launchExtension(profile);
    const popup = await openPopup(context);
    await openSettings(popup);
    const limit = popup.getByRole('spinbutton', {
      name: 'Closed-tab history limit',
      exact: true,
    });
    await expect(limit).toBeEnabled();
    await limit.fill('1000');
    await popup
      .getByRole('button', { name: 'Save changes', exact: true })
      .click();
    await expect(popup.getByRole('status')).toHaveText('Saved.');
    await popup.evaluate(async () => {
      const now = Date.now();
      await chrome.storage.local.set({
        closedTabHistory: Array.from({ length: 600 }, (_, index) => ({
          kind: 'closed',
          key: `closed-persisted-${index}`,
          title: `Saved research ${index}`,
          url: `https://example.com/retained/${index}`,
          lastAccessed: now - index * 1000,
          closedAt: now - index * 500,
          incognito: false,
        })),
      });
    });
    await context.close();
    context = undefined;
    context = await launchExtension(profile);
    const reopened = await openPopup(context);
    await expect(reopened.locator('[data-entry-kind="closed"]')).toHaveCount(
      600,
    );
    await openSettings(reopened);
    await expect(
      reopened.getByRole('spinbutton', {
        name: 'Closed-tab history limit',
        exact: true,
      }),
    ).toHaveValue('1000');
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('shortcut settings open Chrome editing, refresh the actual binding, and survive a browser restart', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'tab-switcher-shortcut-'));
  let context: BrowserContext | undefined;
  try {
    context = await launchExtension(profile);
    const settings = await openPopup(context);
    await openSettings(settings);
    await expect(settings.locator('kbd')).toHaveText('Not set');
    const limit = settings.getByRole('spinbutton', {
      name: 'Closed-tab history limit',
      exact: true,
    });
    await expect(limit).toBeEnabled();
    await limit.fill('321');
    const opened = context.waitForEvent('page');
    await settings.getByRole('button', { name: 'Change shortcut' }).click();
    const editor = await opened;
    await expect(editor).toHaveURL('chrome://extensions/shortcuts');
    await editor
      .getByRole('button', {
        name: 'Edit shortcut Activate the extension for Tab Switcher',
        exact: true,
      })
      .click();
    await editor
      .getByRole('textbox', {
        name: 'Shortcut Activate the extension for Tab Switcher',
        exact: true,
      })
      .press('Control+Shift+K');
    const readBinding = () =>
      settings.evaluate(async () => {
        const commands = await chrome.commands.getAll();
        return commands.find((command) => command.name === '_execute_action')
          ?.shortcut;
      });
    await expect.poll(readBinding).toMatch(/\S/u);
    const binding = (await readBinding())!;
    await settings.bringToFront();
    // Headless Chromium does not emit window focus when activating this tab.
    await settings.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(settings.locator('kbd')).toHaveText(binding);
    await expect(limit).toHaveValue('321');
    await context.close();
    context = undefined;
    context = await launchExtension(profile);
    const reopened = await openPopup(context);
    await openSettings(reopened);
    await expect(reopened.locator('kbd')).toHaveText(binding);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('shortcut settings report read and open failures and allow retry', async ({
  popup,
}) => {
  await popup.addInitScript(() => {
    const state = window as typeof window & { failShortcutRead?: boolean };
    state.failShortcutRead = true;
    const getAll = chrome.commands.getAll.bind(chrome.commands);
    chrome.commands.getAll = (() =>
      state.failShortcutRead
        ? Promise.reject(new Error('Unavailable commands'))
        : getAll()) as typeof chrome.commands.getAll;
  });
  await popup.reload();
  await openSettings(popup);
  await expect(popup.locator('kbd')).toHaveText('Unavailable');
  await expect(popup.getByRole('alert')).toContainText(
    'Could not read the shortcut',
  );
  await popup.evaluate(() => {
    const create = chrome.tabs.create.bind(chrome.tabs);
    chrome.tabs.create = (() => {
      chrome.tabs.create = create;
      return Promise.reject(new Error('Cannot create tab'));
    }) as typeof chrome.tabs.create;
  });
  await popup.getByRole('button', { name: 'Change shortcut' }).click();
  await expect(
    popup.getByRole('alert').filter({ hasText: 'Could not open' }),
  ).toContainText('chrome://extensions/shortcuts');
  await popup.evaluate(() => {
    (
      window as typeof window & { failShortcutRead?: boolean }
    ).failShortcutRead = false;
  });
  await popup.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(popup.locator('kbd')).toHaveText('Not set');
  await expect(
    popup.getByRole('alert').filter({ hasText: 'Could not read' }),
  ).toHaveCount(0);
  const opened = popup.context().waitForEvent('page');
  await popup.getByRole('button', { name: 'Change shortcut' }).click();
  await expect(await opened).toHaveURL('chrome://extensions/shortcuts');
  await expect(popup.getByRole('alert')).toHaveCount(0);
});

test('shortcut settings recover when updated files are loaded under the previous manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tab-switcher-upgrade-'));
  const extensionPath = join(directory, 'extension');
  let context: BrowserContext | undefined;
  try {
    await cp(resolve('.output/chrome-mv3'), extensionPath, { recursive: true });
    const manifestPath = join(extensionPath, 'manifest.json');
    const currentManifest = await readFile(manifestPath, 'utf8');
    const previousManifest = JSON.parse(
      currentManifest,
    ) as chrome.runtime.ManifestV3;
    delete previousManifest.commands;
    await writeFile(manifestPath, JSON.stringify(previousManifest));
    context = await launchExtension(join(directory, 'profile'), extensionPath);
    if (!context.serviceWorkers().length)
      await context.waitForEvent('serviceworker');
    const manager = context.pages()[0]!;
    await manager.goto('chrome://extensions');
    const developerMode = manager.getByRole('button', {
      name: 'Developer mode',
      exact: true,
    });
    // Match a manually installed unpacked extension; CLI loading bypasses this.
    await developerMode.click();
    await expect(developerMode).toHaveAttribute('aria-pressed', 'true');
    // Rebuilding files does not update the manifest already loaded by Chrome.
    await writeFile(manifestPath, currentManifest);
    const settings = await openPopup(context);
    const popupUrl = settings.url();
    await openSettings(settings);
    await expect(settings.locator('kbd')).toHaveText('Reload required');
    await expect(settings.getByRole('alert')).toContainText(
      'Refreshing this page alone won’t update the extension',
    );
    await settings.reload();
    await openSettings(settings);
    await expect(settings.locator('kbd')).toHaveText('Reload required');
    await settings.getByRole('button', { name: 'Reload extension' }).click();
    const reopened = await context.newPage();
    await reopened.goto('chrome://extensions');
    await expect(
      reopened.locator('extensions-item').filter({ hasText: 'Tab Switcher' }),
    ).toBeVisible();
    await reopened.goto(popupUrl);
    await openSettings(reopened);
    await expect(reopened.locator('kbd')).toHaveText('Not set');
    await expect(reopened.getByRole('alert')).toHaveCount(0);
    await expect(
      reopened.getByRole('button', { name: 'Change shortcut' }),
    ).toBeEnabled();
    await reopened.setViewportSize({ width: 800, height: 700 });
    await reopened.getByRole('region', { name: 'Popup shortcut' }).screenshot({
      path: test.info().outputPath('shortcut-recovered.png'),
    });
  } finally {
    await context?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('shortcut settings ignore a stale read after a newer refresh', async ({
  popup,
}) => {
  await popup.addInitScript(() => {
    const state = window as typeof window & {
      releaseShortcut?: () => void;
      delayShortcut?: boolean;
    };
    state.delayShortcut = true;
    chrome.commands.getAll = (() => {
      if (state.delayShortcut) {
        return new Promise<chrome.commands.Command[]>((resolve) => {
          state.releaseShortcut = () =>
            resolve([{ name: '_execute_action', shortcut: 'Old shortcut' }]);
        });
      }
      return Promise.resolve([
        { name: '_execute_action', shortcut: 'New shortcut' },
      ]);
    }) as typeof chrome.commands.getAll;
  });
  await popup.reload();
  await openSettings(popup);
  await expect(popup.locator('kbd')).toHaveText('Loading…');
  await popup.evaluate(() => {
    (window as typeof window & { delayShortcut?: boolean }).delayShortcut =
      false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(popup.locator('kbd')).toHaveText('New shortcut');
  await popup.evaluate(async () => {
    (window as typeof window & { releaseShortcut?: () => void })
      .releaseShortcut!();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(popup.locator('kbd')).toHaveText('New shortcut');
});

test('popup layout stays within Chrome popup bounds with many tabs', async ({
  popup,
}, testInfo) => {
  await popup.evaluate(async () => {
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        chrome.tabs.create({
          url: `http://127.0.0.1:4173/${index % 2 === 0 ? 'typescript' : 'recipes'}`,
          active: false,
        }),
      ),
    );
  });
  await expect(popup.getByRole('option')).toHaveCount(25);
  const dimensions = await popup.evaluate(() => ({
    width: document.body.scrollWidth,
    height: document.body.scrollHeight,
    listHeight: document.getElementById('tabs-list')!.clientHeight,
    listScrollHeight: document.getElementById('tabs-list')!.scrollHeight,
  }));
  expect(dimensions.width).toBeLessThanOrEqual(400);
  expect(dimensions.height).toBeLessThanOrEqual(600);
  expect(dimensions.listScrollHeight).toBeGreaterThan(dimensions.listHeight);
  const tab = popup
    .getByRole('option', { name: 'TypeScript Handbook', exact: true })
    .first();
  await expect(tab.locator('.tab-domain')).toHaveText('127.0.0.1');
  await expect(tab.locator('.tab-age')).toHaveText(/Just now|\d+ secs? ago/u);
  await popup
    .locator('.popup')
    .screenshot({ path: testInfo.outputPath('popup.png') });
});
