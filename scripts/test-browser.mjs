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
        const tocPanel = app.locator('#toc-panel');
        await app.locator('#book-frame').hover();
        await tocPanel.waitFor({ state: 'hidden' });
        const expandedWidth = await app.locator('#book-frame').evaluate(el => el.clientWidth);
        const revealWidth = await app.locator('#toc-reveal-zone').evaluate(el => el.getBoundingClientRect().width);
        const panelWidth = await tocPanel.evaluate(el => el.getBoundingClientRect().width);
        if (Math.abs(revealWidth * 4 - panelWidth) > 1) throw Error('reveal zone must be a quarter of the sidebar width');
        await app.locator('#toc-reveal-zone').hover({ position: { x: 8, y: 100 } });
        await tocPanel.waitFor({ state: 'visible' });
        await app.locator('.toc-entry').first().hover();
        if (await app.locator('#book-frame').evaluate(el => el.clientWidth) !== expandedWidth)
          throw Error('auto-hide sidebar must overlay without reflowing the book');
        await app.locator('#pin-toc').click();
        await app.waitForFunction(() => window.nativeProbe.data.settings.reading.tocPinned === true);
        await app.locator('#book-frame').hover();
        if (!await tocPanel.isVisible() || await app.locator('#pin-toc').getAttribute('aria-pressed') !== 'true')
          throw Error('pinned sidebar must remain visible outside hover');
        await app.locator('.toc-entry').nth(1).click();
        await app.waitForFunction(() => document.querySelectorAll('.toc-entry')[1].classList.contains('active'));
        if (!await app.locator('.toc-active-indicator').evaluate(el => el.getAnimations().some(a => a.playState === 'running')))
          throw Error('chapter capsule must animate between entries');
        await app.locator('.toc-active-indicator').evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
        if (!await app.locator('.toc-active-indicator').evaluate(el => {
          const marker = el.getBoundingClientRect(), active = document.querySelector('.toc-entry.active').getBoundingClientRect();
          return Math.abs(marker.height * 2 - active.height) < 1 &&
            Math.abs(marker.top + marker.height / 2 - active.top - active.height / 2) < 1 &&
            Math.abs(marker.left + marker.width / 2 - active.left) < 1;
        })) throw Error('chapter capsule must stay half-height and align to the active entry left edge');
        await app.locator('.toc-entry').first().click();
        await app.locator('#reader-loading').waitFor({ state: 'hidden' });
        await capture('reader-pinned-sidebar.png');
        await app.locator('#pin-toc').click();
        await app.waitForFunction(() => window.nativeProbe.data.settings.reading.tocPinned === false);
        await app.locator('#book-frame').hover();
        await tocPanel.waitFor({ state: 'hidden' });
        await app.locator('#toggle-toc').click();
        await tocPanel.waitFor({ state: 'visible' });
        await app.locator('#book-frame').hover();
        await tocPanel.waitFor({ state: 'hidden' });
        await app.locator('#book-frame').press('Control+f');
        await app.locator('#book-search-input').waitFor({ state: 'visible' });
        if (!await app.locator('#book-search-input').evaluate(el => document.activeElement === el))
          throw Error('book search must expand the sidebar and receive keyboard focus');
        await app.locator('[data-tab="toc"]').click();
        console.log('PASS auto-hide sidebar, quarter-width reveal zone, pin persistence, chapter capsule animation and keyboard search');
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
        const coverHeight = await app.locator('.continue-cover').evaluate(el => el.getBoundingClientRect().height);
        if (coverHeight > 80) throw Error('continue reading cover expanded beyond its compact card');
        // Exercise immersive mode through the shipped controls, then recover without a toolbar.
        await app.locator('.book-card').first().click();
        await app.locator('#reader-loading').waitFor({ state: 'hidden' });
        const checkToolbar = () => app.evaluate(() => {
          const back = document.querySelector('#back-library');
          const arrow = back.querySelector('.fluent-icon').getBoundingClientRect();
          const actions = document.querySelector('.reader-actions').getBoundingClientRect();
          return arrow.left >= 0 && arrow.left <= 14 && actions.right <= innerWidth &&
            back.getBoundingClientRect().right < actions.left;
        });
        if (!await checkToolbar()) throw Error('reader toolbar must align left without overlapping actions');
        await app.locator('html').evaluate(el => el.style.width = '460px');
        if (!await checkToolbar()) throw Error('narrow reader toolbar overlaps or loses left alignment');
        await app.locator('html').evaluate(el => el.style.width = '');
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
        await app.locator('#back-library').click();
        const originalTitle = await app.locator('.book-card h3').textContent();
        const fullTitle = '庄子——中华经典名著全本全注全译丛书（中华书局）· 完整书名悬浮提示';
        await app.locator('.book-card h3').evaluate((el, title) => { el.textContent = title; }, fullTitle);
        for (const [width, height] of [[180, 270], [270, 180]]) {
          const centered = await app.locator('.cover-wrap').evaluate(async (wrap, [width, height]) => {
            const image = document.createElement('img');
            image.className = 'cover-image';
            image.src = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#526b7c"/></svg>`);
            wrap.replaceChildren(image);
            await image.decode();
            const box = wrap.getBoundingClientRect(), cover = image.getBoundingClientRect();
            const title = wrap.parentElement.querySelector('h3');
            return Math.abs(box.left + box.width / 2 - cover.left - cover.width / 2) < 1 &&
              Math.abs(box.top + box.height / 2 - cover.top - cover.height / 2) < 1 &&
              cover.top >= box.top && cover.bottom <= box.bottom &&
              title.scrollWidth > title.clientWidth && getComputedStyle(title).whiteSpace === 'nowrap' &&
              getComputedStyle(title).textOverflow === 'ellipsis';
          }, [width, height]);
          if (!centered) throw Error('cover must be centered and contained; long titles must use a single-line ellipsis');
        }
        await app.locator('.book-card h3').hover();
        await app.locator('#book-title-tooltip').waitFor({ state: 'visible' });
        if (await app.locator('#book-title-tooltip').textContent() !== fullTitle) throw Error('tooltip must show the full book title');
        await capture('library-title-tooltip.png');
        await app.locator('.library-footer').hover();
        await app.locator('#book-title-tooltip').waitFor({ state: 'hidden' });
        await app.locator('.book-card h3').evaluate((el, title) => { el.textContent = title; }, originalTitle);
        if (await app.locator('.book-remove').count()) throw Error('delete must only appear in the context menu');
        await app.locator('.book-card').click({ button: 'right' });
        await app.locator('#book-context-menu').waitFor({ state: 'visible' });
        await app.locator('#book-menu-delete').press('Escape');
        await app.locator('#book-context-menu').waitFor({ state: 'hidden' });
        await app.locator('.book-card').dispatchEvent('contextmenu', {
          clientX: await app.evaluate(() => innerWidth - 2), clientY: await app.evaluate(() => innerHeight - 2),
        });
        if (!await app.locator('#book-context-menu').evaluate(el => {
          const rect = el.getBoundingClientRect();
          return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
        })) throw Error('context menu must stay within the viewport');
        await capture('library-context-menu.png');
        await app.locator('#book-menu-delete').click();
        await app.locator('#delete-book-dialog').waitFor({ state: 'visible' });
        if (!await app.locator('#reader-view').evaluate(el => el.hidden)) throw Error('delete button opened the book');
        await capture('delete-book-confirmation.png');
        await app.locator('#delete-book-dialog button[value="cancel"]').click();
        if (await app.evaluate(() => window.nativeProbe.requests.some(r => r.method === 'book.delete'))) throw Error('cancel must preserve book');
        await app.locator('#list-view').click();
        await capture('library-list-delete.png');
        await app.locator('.book-card').focus();
        await app.locator('.book-card').press('Shift+F10');
        await app.locator('#book-menu-delete').click();
        await app.locator('#delete-book-confirm').click();
        await app.locator('.book-card').waitFor({ state: 'detached' });
        if (!await app.evaluate(() => window.nativeProbe.data.books.length === 0 &&
          document.getElementById('count-all').textContent === '0' &&
          !document.getElementById('empty-state').hidden && document.getElementById('continue-section').hidden))
          throw Error('delete must persist and refresh counts, empty state and continue reading');
        console.log('PASS centered covers, title ellipsis and tooltip, context menu, deletion confirmation, cancellation and empty library');
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
