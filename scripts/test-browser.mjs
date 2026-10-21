import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const edge = process.env.DR_EDGE_PATH || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!edge) throw Error('Set DR_EDGE_PATH to a Chromium/Edge executable');
const directory = resolve('build/browser-tests');
await mkdir(directory, { recursive: true });
const server = await createServer({ configFile: 'vite.tests.config.ts', server: { port: 0 } });
await server.listen();
const port = server.httpServer.address().port;
const browser = await chromium.launch({ executablePath: edge, headless: true });
try {
  for (const name of ['reader_layout', 'reader_interactions', 'settings_controls', 'production_smoke']) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(`http://127.0.0.1:${port}/tests/${name}.html`);
      await page.waitForSelector('html[data-result]', { timeout: 18000, state: 'attached' });
      const passed = await page.locator('html').getAttribute('data-result') === 'pass';
      await writeFile(resolve(directory, `${name}.html`), await page.content());
      await writeFile(resolve(directory, `${name}.log`), errors.join('\n'));
      if (!passed || errors.length) throw Error(`${name}: ${await page.locator('#result').textContent()}\n${errors.join('\n')}`);
      if (name === 'production_smoke') {
        const app = page.frames().find(frame => frame.parentFrame());
        await app.locator('#setting-fontFamily-trigger').click();
        await page.screenshot({ path: resolve(directory, 'reading-settings.png'), animations: 'disabled' });
        await app.locator('.select-search input').press('Escape');
        if (!await app.locator('#reading-settings').evaluate(el => el.open)) throw Error('Escape closed the whole drawer');
        for (const theme of ['dark', 'sepia']) {
          await app.evaluate(theme => { document.body.dataset.theme = theme; }, theme);
          await app.locator('#setting-mode-trigger').click();
          await page.screenshot({ path: resolve(directory, `reading-settings-${theme}.png`), animations: 'disabled' });
          await app.locator('#setting-mode-trigger').press('Escape');
        }
      }
      if (name === 'settings_controls') {
        await page.setViewportSize({ width: 360, height: 800 });
        await page.reload();
        await page.waitForSelector('html[data-result]', { timeout: 18000, state: 'attached' });
        if (await page.locator('html').getAttribute('data-result') !== 'pass') throw Error(`narrow settings: ${await page.locator('#result').textContent()}`);
      }
      console.log(`PASS ${name}`);
    } finally { await page.close(); }
  }
} finally { await browser.close(); await server.close(); }
