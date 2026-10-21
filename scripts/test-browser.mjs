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
  for (const name of ['reader_layout', 'reader_interactions', 'settings_controls', 'reader_motion', 'production_smoke']) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (name === 'reader_motion') await page.exposeFunction('captureMotion', label => page.locator('#page-surface').screenshot({ path: resolve(directory, `${label}.png`) }));
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
        const capture = name => page.locator('iframe').screenshot({ path: resolve(directory, name), animations: 'disabled' });
        await capture('reading-settings.png');
        await app.locator('.select-search input').press('Escape');
        if (!await app.locator('#reading-settings').evaluate(el => el.open)) throw Error('Escape closed the whole drawer');
        await app.locator('[data-close="reading-settings"]').click();
        await app.locator('#reader-app-settings').click();
        await app.locator('[data-setting-theme="application"][data-value="dark"]').click();
        await app.waitForFunction(() => document.body.dataset.theme === 'dark');
        const colors = await app.evaluate(() => {
          const style = getComputedStyle(document.body);
          return Object.fromEntries(['--bg', '--surface', '--sidebar', '--text', '--muted', '--primary', '--on-primary'].map(key => [key, style.getPropertyValue(key).trim()]));
        });
        for (const key of ['--bg', '--surface', '--sidebar']) {
          const channels = colors[key].slice(1).match(/../g).map(value => parseInt(value, 16));
          if (Math.max(...channels) - Math.min(...channels) > 1) throw Error(`dark surface ${key} must be neutral gray`);
        }
        const luminance = hex => hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
          .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
          .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
        const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
        for (const [a, b] of [['--text', '--bg'], ['--muted', '--surface'], ['--on-primary', '--primary']]) {
          const expand = color => color.length === 4 ? '#' + [...color.slice(1)].map(c => c + c).join('') : color;
          if (ratio(expand(colors[a]), expand(colors[b])) < 4.5) throw Error(`${a}/${b} text contrast is too low`);
        }
        await capture('application-settings-dark.png');
        await app.locator('#application-settings-back').click();
        await app.locator('#back-library').click();
        await app.locator('#library-view').waitFor({ state: 'visible' });
        await capture('library-dark.png');
        await app.locator('.book-card').first().click();
        await app.locator('#reader-loading').waitFor({ state: 'hidden' });
        await app.locator('#reader-settings').click();
        await app.locator('[data-setting-theme="reading"][data-value="dark"]').click();
        await app.waitForFunction(() => getComputedStyle(document.getElementById('book-frame').contentDocument.body).backgroundColor === 'rgb(25, 25, 25)');
        const preview = await app.locator('#type-preview').evaluate(el => getComputedStyle(el).backgroundColor);
        if (preview !== 'rgb(25, 25, 25)') throw Error('reading preview must use the same dark paper as the EPUB');
        await app.locator('#setting-mode-trigger').click();
        await capture('reading-settings-dark.png');
        await app.locator('#setting-mode-trigger').press('Escape');
        await app.locator('[data-close="reading-settings"]').click();
        await capture('reader-dark.png');
        await app.locator('#reader-app-settings').click();
        await app.locator('[data-setting-theme="application"][data-value="light"]').click();
        await app.waitForFunction(() => document.body.dataset.theme === 'light');
        await app.locator('#application-settings-back').click();
        const paper = await app.locator('#book-frame').evaluate(el => getComputedStyle(el.contentDocument.body).backgroundColor);
        if (paper !== 'rgb(25, 25, 25)') throw Error('application theme must not override the independent reading theme');
        await app.locator('#reader-settings').click();
        await app.locator('[data-setting-theme="reading"][data-value="light"]').click();
        await app.waitForFunction(() => getComputedStyle(document.getElementById('type-preview')).backgroundColor === 'rgb(255, 255, 255)');
        await app.locator('[data-close="reading-settings"]').click();
        await app.locator('#back-library').click();
        await app.locator('#library-view').waitFor({ state: 'visible' });
        await capture('library-light.png');
        // Exercise immersive mode through the shipped controls, then recover without a toolbar.
        await app.locator('.book-card').first().click();
        await app.locator('#reader-loading').waitFor({ state: 'hidden' });
        await app.locator('#reader-settings').click();
        await app.locator('#immersive-reading').click();
        await app.waitForFunction(() => document.getElementById('reader-view').dataset.toolbar === 'false');
        for (const [key, value] of [['paddingTop', '20'], ['paddingBottom', '80'], ['paddingLeft', '10'], ['paddingRight', '90']])
          await app.locator(`#number-${key}`).fill(value);
        await app.waitForFunction(() => window.nativeProbe.data.settings.reading.paddingRight === 90);
        await app.locator('[data-close="reading-settings"]').click();
        await app.waitForFunction(() => {
          const frame = document.getElementById('book-frame');
          return frame.clientWidth === innerWidth && frame.clientHeight === innerHeight &&
            getComputedStyle(frame.contentDocument.body).marginLeft === '10px';
        });
        const edges = await app.locator('#book-frame').evaluate(el => {
          const s = getComputedStyle(el.contentDocument.body);
          return [s.marginTop, s.marginRight, s.marginBottom, s.marginLeft];
        });
        if (edges.join(',') !== '20px,90px,80px,10px') throw Error(`independent margins were lost: ${edges}`);
        for (const selector of ['.reader-toolbar', '#toc-panel', '.chapter-label', '.reader-pagination', '.reader-footer'])
          if (await app.locator(selector).isVisible()) throw Error(`${selector} remains visible in immersive mode`);
        await capture('reader-immersive.png');
        const book = await (await app.$('#book-frame')).contentFrame();
        const size = await book.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const pageNumber = () => app.locator('#page-indicator').textContent().then(text => parseInt(text));
        const beforeTap = await pageNumber();
        await book.locator('html').click({ position: { x: size.width - 5, y: size.height * .5 } });
        await app.waitForFunction(previous => parseInt(document.getElementById('page-indicator').textContent) === previous + 1, beforeTap);
        await book.locator('html').click({ position: { x: 5, y: size.height * .5 } });
        await app.waitForFunction(previous => parseInt(document.getElementById('page-indicator').textContent) === previous, beforeTap);
        await book.evaluate(() => {
          const text = document.querySelector('p').firstChild;
          const range = document.createRange(); range.selectNodeContents(text);
          getSelection().removeAllRanges(); getSelection().addRange(range);
        });
        await book.locator('html').click({ position: { x: size.width - 5, y: size.height * .5 } });
        await page.waitForTimeout(300);
        if (await pageNumber() !== beforeTap) throw Error('clicking to dismiss a selection also turned the page');
        await page.keyboard.press('F8');
        await app.locator('#reading-settings').waitFor({ state: 'visible' });
        await app.locator('[data-close="reading-settings"]').click();
        await page.keyboard.press('Alt+Enter');
        await app.waitForFunction(() => document.body.dataset.fullscreen === 'true');
        await page.keyboard.press('Escape');
        await app.waitForFunction(() => document.body.dataset.fullscreen === 'false');
        if (await app.locator('#reader-view').evaluate(el => el.hidden)) throw Error('Escape should exit fullscreen before leaving the book');
        await book.locator('html').click({ position: { x: size.width * .5, y: size.height * .5 } });
        await app.locator('#quick-settings').waitFor({ state: 'visible' });
        await app.locator('#quick-settings').click();
        await app.locator('#restore-reader-chrome').click();
        await app.locator('[data-close="reading-settings"]').click();
        await app.locator('.reader-toolbar').waitFor({ state: 'visible' });
        console.log('PASS immersive controls, margins, side taps, selection guard, F8 and fullscreen protocol');
      }
      if (name === 'settings_controls') {
        await page.setViewportSize({ width: 360, height: 800 });
        await page.reload();
        await page.waitForSelector('html[data-result]', { timeout: 18000, state: 'attached' });
        if (await page.locator('html').getAttribute('data-result') !== 'pass') throw Error(`narrow settings: ${await page.locator('#result').textContent()}`);
      }
      if (errors.length) throw Error(`${name}: ${errors.join('\n')}`);
      await writeFile(resolve(directory, `${name}.log`), errors.join('\n'));
      console.log(`PASS ${name}`);
    } finally { await page.close(); }
  }
} finally { await browser.close(); await server.close(); }
