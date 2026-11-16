import assert from 'node:assert/strict';
import { chromium } from 'playwright';

export async function verifyPauseInBrowser(origin, cookie, [a, b, c]) {
  const browser = await chromium.launch({ executablePath: process.env.HQ_TEST_CHROMIUM || undefined });
  const hold = Promise.withResolvers();
  try {
    const context = await browser.newContext({ viewport: { width: 1390, height: 820 } });
    const [name, value] = cookie.split('=');
    await context.addCookies([{ url: origin, name, value }]);
    await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const requests = [];
    await page.route('**/api/bots/' + a.id + '/pause', async (route) => {
      requests.push(route.request().postDataJSON().paused);
      if (requests.length === 1) await hold.promise;
      if (requests.length === 2) return route.fulfill({ status: 503, json: { error: 'Synthetic service unavailable' } });
      if (requests.length === 4) {
        assert.equal((await route.fetch()).status(), 200);
        return route.abort();
      }
      return route.continue();
    });

    const header = page.locator('.chat__pill');
    const action = (name) => page.getByRole('menuitem', { name, exact: true });
    const status = (text) => page.waitForFunction((expected) => document.querySelector('.chat__pill-status')?.textContent === expected, text);
    const composer = (bot) => page.getByRole('textbox', { name: 'Message ' + bot.name, exact: true });
    const send = page.getByRole('button', { name: 'Send', exact: true });
    const select = async (bot) => {
      const label = bot.label ? bot.name + ' · ' + bot.label : bot.name;
      await page.locator('.sidebar').getByText(label, { exact: true }).click();
      await composer(bot).waitFor();
    };
    const toggle = async (name) => {
      await header.click();
      await action(name).click();
    };

    await page.goto(origin);
    await select(a);
    await composer(a).fill('Draft during Pause');
    await header.focus();
    await page.keyboard.press('Enter');
    await action('Pause bot').focus();
    await page.keyboard.press('Enter');
    await status('Pausing…');
    assert.equal(await header.evaluate((node) => node === document.activeElement), true);
    assert.equal(await send.isDisabled(), true);
    await composer(a).press('Enter');
    for (const bot of [b, c]) {
      await select(bot);
      await status('');
      await header.click();
      assert.equal(await action('Pause bot').isEnabled(), true);
      await page.keyboard.press('Escape');
    }
    await select(a);
    assert.equal(await composer(a).inputValue(), 'Draft during Pause');
    await status('Pausing…');
    hold.resolve();
    await status('Paused');

    await page.reload();
    await status('Paused');
    await composer(a).fill('Editable while paused');
    await toggle('Resume bot');
    await page.getByText('Couldn’t resume Role A. Synthetic service unavailable', { exact: true }).waitFor();
    await status('Paused');
    assert.equal(await composer(a).inputValue(), 'Editable while paused');
    assert.equal(await send.isDisabled(), true);
    await toggle('Resume bot');
    await status('');
    assert.equal(await send.isEnabled(), true);
    await toggle('Pause bot');
    await status('Paused');
    assert.equal(await send.isDisabled(), true);
    assert.deepEqual(requests, [true, false, false, true]);
    console.log('Chromium verified per-bot controls, keyboard focus, draft preservation, failed-save recovery, reload, and reconciliation after a lost response.');
  } finally {
    hold.resolve();
    await browser.close();
  }
}
