import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { chromium } from 'playwright';

test('linked Bots render collapsed and Archive and Unarchive update the sidebar immediately', { timeout: 30_000 }, async () => {
  const hq = spawn(process.execPath, ['server/dist/index.js'], {
    env: {
      ...process.env, PORT: '0', HQ_HOST: '127.0.0.1', APP_URL: 'http://localhost',
      SESSION_SECRET: 'loopback-archive-browser', DEV_LOGIN: '1', DB_PATH: ':memory:',
      PRIMARY_BOT_NAME: 'Parent Bot', PRIMARY_BOT_LABEL: '', ALLOWED_EMAILS: '', HQ_LOCAL_ENGINES: '0',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = once(hq, 'exit');
  const lines = createInterface({ input: hq.stdout });
  const holdArchive = Promise.withResolvers();
  const holdRestore = Promise.withResolvers();
  let browser;
  try {
    let origin;
    for await (const line of lines) {
      const port = line.match(/\[grokbot\] server on http:\/\/localhost:(\d+)/)?.[1];
      if (port) {
        origin = 'http://127.0.0.1:' + port;
        break;
      }
    }
    assert(origin, 'Bot HQ failed to start');

    browser = await chromium.launch({ executablePath: process.env.HQ_TEST_CHROMIUM || undefined });
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const login = await context.request.post(origin + '/api/auth/dev', { data: { email: 'archive-browser@example.test' } });
    assert.equal(login.status(), 200);
    const { bots: [parent] } = await (await context.request.get(origin + '/api/bots')).json();
    const created = await context.request.post(origin + '/api/bots', {
      data: { name: 'Linked Bot', avatarShape: 'heart', avatarColor: 'red' },
    });
    assert.equal(created.status(), 200);
    const { bot: child } = await created.json();

    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const archiveRequests = [];
    const requestedArchive = Promise.withResolvers();
    const requestedRestore = Promise.withResolvers();
    await page.route('**/api/bots/' + child.id + '/archive', async (route) => {
      archiveRequests.push(route.request().postDataJSON().archived);
      if (archiveRequests.length === 1) {
        requestedArchive.resolve();
        await holdArchive.promise;
      } else if (archiveRequests.length === 2) {
        requestedRestore.resolve();
        await holdRestore.promise;
      }
      await route.continue();
    });

    const sidebar = page.locator('.sidebar');
    const childRow = sidebar.locator('.bot-row').filter({ hasText: 'Linked Bot' });
    const parentAvatar = sidebar.locator('.pinned .bot-avatar');
    const linked = sidebar.getByRole('button', { name: 'Linked Bots for Parent Bot' });
    const settings = page.getByRole('dialog', { name: 'Linked Bot settings' });
    const archive = settings.getByRole('button', { name: 'Archive', exact: true });
    const unarchive = settings.getByRole('button', { name: 'Unarchive', exact: true });
    const chat = page.locator('.chat__pill');

    const openBotSettings = async () => {
      await childRow.click();
      await chat.click();
      await page.getByRole('menuitem', { name: 'Bot settings' }).click();
    };
    const saved = (archived) => page.waitForResponse((response) =>
      response.url().endsWith('/archive') && response.request().postDataJSON().archived === archived);
    const avatar = (locator) => locator.locator('svg path').last().evaluate((path) =>
      [path.getAttribute('d'), path.getAttribute('fill')]);

    await page.goto(origin);
    await childRow.waitFor();
    const initialChildX = (await childRow.boundingBox()).x;
    assert.notDeepEqual(await avatar(childRow.locator('.bot-avatar')), await avatar(parentAvatar));

    await openBotSettings();
    await settings.getByLabel('Parent Bot').selectOption(parent.id);
    await settings.getByRole('button', { name: 'Save changes' }).click();
    await linked.waitFor();
    assert.equal(await linked.getAttribute('aria-expanded'), 'false');
    assert.equal(await childRow.count(), 0);
    await page.keyboard.press('Escape');
    await linked.focus();
    await page.keyboard.press('Enter');
    await childRow.waitFor();
    assert((await childRow.boundingBox()).x > initialChildX, 'child is indented');
    assert.deepEqual(await avatar(childRow.locator('.bot-avatar')), await avatar(parentAvatar));
    assert.equal(await childRow.locator('xpath=ancestor::div[@id="linked-' + parent.id + '"]').count(), 1);

    await openBotSettings();
    await archive.click();
    await requestedArchive.promise;
    await childRow.waitFor({ state: 'hidden' });
    assert.equal(await chat.locator('.chat__pill-name').textContent(), 'Parent Bot');
    await unarchive.click();
    await childRow.waitFor();
    await archive.click();
    await childRow.waitFor({ state: 'hidden' });
    const archived = saved(true);
    holdArchive.resolve();
    assert.equal((await archived).status(), 200);
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+,');
    const appSettings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await appSettings.getByRole('button', { name: 'Archived', exact: true }).click();
    const restore = appSettings.getByRole('button', { name: 'Unarchive Linked Bot' });
    const undo = appSettings.getByRole('button', { name: 'Undo unarchive Linked Bot' });
    await restore.click();
    await requestedRestore.promise;
    await childRow.waitFor();
    await undo.click();
    await childRow.waitFor({ state: 'hidden' });
    const restored = saved(false);
    const rearchived = saved(true);
    holdRestore.resolve();
    assert.equal((await restored).status(), 200);
    assert.equal((await rearchived).status(), 200);
    assert.deepEqual(archiveRequests, [true, false, true]);

    const restoredAgain = saved(false);
    await restore.click();
    assert.equal((await restoredAgain).status(), 200);
    await appSettings.getByText('No archived Bots.').waitFor();
    await appSettings.getByRole('button', { name: 'Close settings' }).click();
    await childRow.waitFor();

    await page.reload();
    await linked.waitFor();
    assert.equal(await linked.getAttribute('aria-expanded'), 'false');
    assert.equal(await childRow.count(), 0);
    await linked.click();
    await childRow.waitFor();
  } finally {
    holdArchive.resolve();
    holdRestore.resolve();
    await browser?.close();
    lines.close();
    hq.kill();
    await exited;
  }
});
