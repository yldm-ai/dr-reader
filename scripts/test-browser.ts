import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

const edge = process.env.DR_EDGE_PATH || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!edge) throw Error('Set DR_EDGE_PATH to a Chromium/Edge executable');
const directory = resolve('build/browser-tests');
await mkdir(directory, { recursive: true });
const server = await createServer({ configFile: 'vite.tests.config.ts', server: { port: 0 } });
await server.listen();
const port = (server.httpServer.address() as AddressInfo).port;
// Same compositing switch as the app's WebView2 environment (app/src/webview.cpp).
const browser = await chromium.launch({ executablePath: edge, headless: true, args: ['--disable-prefer-compositing-to-lcd-text'] });
try {
  for (const name of ['toc_motion', 'toc_anchors', 'reader_touchpad', 'library_context_actions', 'library_back_to_top', 'library_sort', 'toc_hierarchy', 'icon_fallback', 'footer_auto_hide', 'notifications', 'settings_interactions', 'system_theme', 'reader_completion', 'shelves', 'reader_layout', 'reader_interactions', 'settings_controls', 'reader_motion', 'book_opening', 'agent_chat', 'production_smoke']) {
    if (process.env.DR_BROWSER_TEST && name !== process.env.DR_BROWSER_TEST) continue;
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    if (name === 'reader_motion') await page.exposeFunction('captureMotion', (label: string) => page.locator('#page-surface').screenshot({ path: resolve(directory, `${label}.png`) }));
    if (name === 'book_opening') await page.exposeFunction('captureOpening', (label: string) => page.screenshot({ path: resolve(directory, `${label}.png`) }));
    try {
      await page.goto(`http://127.0.0.1:${port}/tests/${name}.html`);
      await page.waitForSelector('html[data-result]', { timeout: 18000, state: 'attached' });
      const passed = await page.locator('html').getAttribute('data-result') === 'pass';
      await writeFile(resolve(directory, `${name}.html`), await page.content());
      await writeFile(resolve(directory, `${name}.log`), errors.join('\n'));
      if (!passed || errors.length) throw Error(`${name}: ${await page.locator('#result').textContent()}\n${errors.join('\n')}`);
      if (name === 'toc_anchors') {
        const app = page.frames().find(frame => frame.parentFrame());
        await app.locator('#toc-panel').screenshot({ path: resolve(directory, 'toc-unique-leaf-light.png') });
        await app.evaluate(() => { document.body.dataset.theme = 'dark'; });
        await app.locator('#toc-panel').screenshot({ path: resolve(directory, 'toc-unique-leaf-dark.png') });
      }
      if (name === 'library_context_actions') {
        const app = page.frames().find(frame => frame.parentFrame());
        const panel = app.locator('#toc-panel');
        const box = await app.locator('#reader-view').boundingBox();
        await page.mouse.move(box.x + 4, box.y + 48);
        await page.waitForTimeout(100);
        if (await panel.getAttribute('data-expanded') === 'true') throw Error('return-button approach must not reveal the sidebar');
        await page.mouse.move(box.x + 4, box.y + 160);
        await panel.waitFor({ state: 'visible' });
        await app.locator('#book-frame').hover();
        await panel.waitFor({ state: 'hidden' });
        await page.mouse.move(box.x + 45, box.y + 20);
        await app.locator('#corner-library').waitFor({ state: 'visible' });
        if (await panel.getAttribute('data-expanded') === 'true') throw Error('return button hover must not reveal the sidebar');
        await page.mouse.move(box.x + 4, box.y + 160);
        await panel.waitFor({ state: 'visible' });
        await app.locator('#corner-library').click();
        await app.locator('#library-view').waitFor({ state: 'visible' });
        const title = app.locator('.book-card h3').first();
        let flashes = 0;
        await app.evaluate(() => {
          window.menuTitleFlashes = 0;
          document.getElementById('book-title-tooltip').addEventListener('beforetoggle', e => {
            if (e.newState === 'open') window.menuTitleFlashes++;
          });
        });
        await title.click({ button: 'right' });
        await page.waitForTimeout(500);
        flashes = await app.evaluate(() => window.menuTitleFlashes);
        if (flashes) throw Error('physical right click must not flash the title tooltip');
        await app.locator('#book-menu-category').hover();
        await app.locator('#book-shelf-menu').waitFor({ state: 'visible' });
        await app.locator('#book-shelf-menu').hover();
        await page.waitForTimeout(260);
        if (!await app.locator('#book-shelf-menu').isVisible()) throw Error('submenu must stay open while crossing the gap');
        await app.locator('#toast').evaluate((el: HTMLElement) => { el.hidden = true; });
        await page.locator('iframe').screenshot({ path: resolve(directory, 'book-menu-light.png') });
        await app.evaluate(() => { document.body.dataset.theme = 'dark'; });
        await page.locator('iframe').screenshot({ path: resolve(directory, 'book-menu-dark.png') });
        await app.locator('#book-menu-new-shelf').press('Escape');
        await app.locator('#book-menu-category').press('Escape');
        // Keyboard opening must offer every operation in a predictable order.
        await app.locator('.book-card').first().press('Shift+F10');
        await app.locator('#book-menu-open').press('ArrowDown');
        if (!await app.locator('#book-menu-info').evaluate((el: HTMLElement) => el === document.activeElement)) throw Error('keyboard menu navigation must reach info');
        await app.locator('#book-menu-info').press('ArrowDown');
        if (!await app.locator('#book-menu-export').evaluate((el: HTMLElement) => el === document.activeElement)) throw Error('keyboard menu navigation must reach export');
        await app.locator('#book-menu-export').press('Escape');
      }
      if (name === 'library_back_to_top') {
        const frame = page.frames().find(frame => frame.parentFrame());
        await frame.locator('#library-back-to-top').hover();
        await page.locator('iframe').screenshot({ path: resolve(directory, 'library-back-to-top-dark.png') });
        await frame.evaluate(() => { document.body.dataset.theme = 'light'; });
        await page.locator('iframe').screenshot({ path: resolve(directory, 'library-back-to-top-light.png') });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        if (!await frame.evaluate(() => {
          document.body.dataset.animations = 'true';
          document.getElementById('library-back-to-top').click();
          return document.getElementById('library-view').scrollTop === 0;
        })) throw Error('reduced motion must return to the top instantly');
      }
      if (name === 'agent_chat') {
        const app = page.frames().find(frame => frame.parentFrame());
        await app.locator('.ask-input').fill('用一句话概括这一章。');
        await app.locator('.ask-input').press('Enter');
        await app.locator('.ask-copy').waitFor();
        for (const theme of ['light', 'dark']) {
          await app.evaluate(value => { document.body.dataset.theme = value; }, theme);
          await app.locator('#toc-panel').screenshot({ path: resolve(directory, `agent-chat-${theme}.png`) });
        }
        await app.evaluate(() => { document.body.dataset.theme = 'light'; });
        await app.locator('.ask-history-open').click();
        await app.locator('.ask-history-row').first().waitFor();
        await app.locator('#toc-panel').screenshot({ path: resolve(directory, 'agent-history.png') });
        await app.locator('.ask-history-close').click();
        await app.locator('#reader-app-settings').click();
        await app.locator('#app-tab-agent').click();
        await app.locator('#app-section-agent').screenshot({ path: resolve(directory, 'agent-settings.png') });
        await app.locator('#app-agent-model-trigger').click();
        await app.locator('#app-agent-model-popup').waitFor();
        await page.locator('iframe').screenshot({ path: resolve(directory, 'agent-model-list.png') });
        await app.locator('#app-agent-model-popup .select-search input').press('Escape');
      }
      if (name === 'toc_hierarchy') {
        const panel = page.locator('#toc-panel');
        await panel.screenshot({ path: resolve(directory, 'toc-collapsed.png') });
        await panel.locator('.toc-toggle').first().click();
        await panel.screenshot({ path: resolve(directory, 'toc-expanded.png') });
        await page.evaluate(() => { document.body.dataset.theme = 'light'; });
        await panel.screenshot({ path: resolve(directory, 'toc-expanded-light.png') });
      }
      if (name === 'icon_fallback') {
        await page.locator('iframe').screenshot({ path: resolve(directory, 'icons-mdl2.png') });
        const app = page.frames().find(frame => frame.parentFrame());
        await app.locator('#back-library').click();
        await app.locator('#library-view').waitFor({ state: 'visible' });
        await page.locator('iframe').evaluate((frame: HTMLIFrameElement) => { frame.srcdoc = frame.srcdoc.replace('icons=mdl2', 'icons=none'); });
        await page.waitForFunction(() => document.querySelector('iframe').contentDocument?.querySelector('.book-card'));
        const refreshed = page.frames().find(frame => frame.parentFrame());
        if (await refreshed.locator('.fluent-icon').count()) throw Error('missing icon fonts must use SVG for every icon');
        if (await refreshed.locator('.sidebar .material-icon').count() < 8) throw Error('fontless library must remain usable');
        await page.locator('iframe').screenshot({ path: resolve(directory, 'icons-svg-fallback.png') });
        await refreshed.locator('.book-card').first().click();
        await refreshed.locator('#reader-loading').waitFor({ state: 'hidden' });
        if (!await refreshed.evaluate(() => {
          const doc = (document.getElementById('book-frame') as HTMLIFrameElement).contentDocument, tip = doc.querySelector('.dr-note-tip');
          const style = tip && doc.defaultView.getComputedStyle(tip, '::before');
          return style && style.maskImage.includes('data:image/svg+xml') && style.content === '""';
        })) throw Error('fontless note tip must use vector mask without adding anchor text');
      }
      if (name === 'footer_auto_hide') {
        const app = page.frames().find(frame => frame.parentFrame());
        const footer = app.locator('.reader-footer');
        const zone = app.locator('#footer-reveal-zone');
        const hidden = () => app.waitForFunction(() => getComputedStyle(document.querySelector('.reader-footer')).opacity === '0');
        const shown = () => app.waitForFunction(() => getComputedStyle(document.querySelector('.reader-footer')).opacity === '1');
        await app.locator('#reader-search').hover();
        await hidden();
        const frameSize = await app.locator('#book-frame').boundingBox();
        await zone.hover(); await shown();
        if (Math.abs((await app.locator('#book-frame').boundingBox()).height - frameSize.height) > 1) throw Error('revealing footer must not repaginate book');
        await page.locator('iframe').screenshot({ path: resolve(directory, 'footer-auto-revealed.png') });
        const book = await (await app.$('#book-frame')).contentFrame();
        await book.locator('body').hover({ position: { x: 150, y: 150 } });
        await hidden();
        await app.locator('#reader-settings').click();
        await page.keyboard.press('Escape');
        await app.locator('#reader-settings').focus();
        await page.keyboard.press('Tab');
        // Focus the slider through keyboard navigation from the final toolbar button.
        await app.locator('#reading-progress').focus();
        await shown();
        await app.locator('#reader-search').focus();
        await hidden();
        await app.locator('#reader-settings').click();
        const set = async (key: string, value: boolean) => {
          await app.evaluate(({ key, value }) => {
            const input = document.getElementById(`setting-${key}`) as HTMLInputElement; input.checked = value;
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }, { key, value });
          await app.waitForFunction(({ key, value }) => (window.nativeProbe.data.settings.reading as unknown as Record<string, unknown>)[key] === value, { key, value });
        };
        await set('showProgress', false); await set('showBookPages', false);
        if (!await app.locator('#setting-autoHideProgress').isDisabled()) throw Error('auto hide must be disabled without footer content');
        if (await zone.isVisible()) throw Error('disabled footer must not leave reveal zone');
        await set('showBookPages', true);
        if (await app.locator('#setting-autoHideProgress').isDisabled()) throw Error('whole-book pages support footer auto hide');
        await set('showProgress', true);
        await app.locator('[data-close="reading-settings"]').click();
        await app.locator('#back-library').click();
        await app.locator('.book-card').first().click();
        await app.locator('#reader-loading').waitFor({ state: 'hidden' });
        await hidden();
        if (await app.locator('#reader-view').getAttribute('data-footer-auto-hide') !== 'true') throw Error('auto hide preference must survive reopening');
        await app.locator('#reader-settings').click();
        await set('autoHideProgress', false);
        await app.locator('[data-close="reading-settings"]').click();
        await shown();
        if (await zone.isVisible()) throw Error('fixed footer must not leave reveal zone');
      }
      if (name === 'notifications') {
        const app = page.frames().find(frame => frame.parentFrame());
        const toast = app.locator('#toast');
        await toast.hover();
        for (const scheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: scheme });
          await app.waitForFunction(theme => document.body.dataset.theme === theme, scheme);
          const shape = await toast.evaluate(el => {
            const box = el.getBoundingClientRect(), style = getComputedStyle(el);
            return { width: box.width, height: box.height, font: style.fontSize, bg: style.backgroundColor,
              ink: style.color, topmost: el.matches(':popover-open'), focus: document.activeElement.id };
          });
          if (shape.width > 240 || shape.height > 44 || shape.font !== '13px' || !shape.topmost) throw Error('notification must be compact');
          if (shape.bg !== (scheme === 'dark' ? 'rgb(37, 37, 37)' : 'rgb(255, 255, 255)')) throw Error('notification must follow system theme');
          if (shape.focus === 'toast' || shape.focus === 'toast-close') throw Error('notification must not steal focus');
          await page.locator('iframe').screenshot({ path: resolve(directory, `notification-${scheme}.png`) });
        }
        await app.locator('.toast-close').click();
        await toast.waitFor({ state: 'hidden' });
        // Keyboard focus inside a notification pauses its countdown, as hovering does; leaving resumes it.
        await page.mouse.move(5, 995);
        await app.evaluate(() => document.getElementById('import-side').click());
        await toast.waitFor({ state: 'visible' });
        await app.locator('.toast-close').focus();
        await page.waitForTimeout(3200);
        if (await toast.isHidden()) throw Error('focus inside a notification must pause its countdown');
        await app.locator('#library-search').focus();
        await toast.waitFor({ state: 'hidden', timeout: 4000 });
        await app.locator('#open-settings').click();
        const errorMessage = '无法保存设置：这是一条用于检查长消息换行和暗色提示的测试文字。'.repeat(20);
        await app.evaluate(message => {
          window.nativeProbe.data.importErrors = [message];
          document.getElementById('import-side').click();
        }, errorMessage);
        await toast.waitFor({ state: 'visible' });
        if (await toast.getAttribute('data-kind') !== 'error') throw Error('error must use an error notification');
        if (!await app.locator('#application-settings').evaluate((el: HTMLDialogElement) => el.open)) throw Error('notification must preserve open modal');
        await toast.hover();
        if (!await toast.evaluate(el => {
          const box = el.getBoundingClientRect(), text = el.querySelector('.toast-message');
          const hit = document.elementFromPoint(box.left + 12, box.top + box.height / 2);
          return box.width <= 440 && box.height <= 150 && box.right <= innerWidth && el.contains(hit) &&
            text.scrollHeight > text.clientHeight;
        })) throw Error('long errors must be bounded, scrollable and above modal');
        await page.locator('iframe').screenshot({ path: resolve(directory, 'notification-modal-error.png') });
        await page.locator('iframe').evaluate(el => { el.style.width = '360px'; el.style.height = '640px'; });
        await app.waitForFunction(() => innerWidth === 360);
        if (!await toast.evaluate(el => { const box = el.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.width <= 328; }))
          throw Error('notification must fit narrow windows');
        await page.locator('iframe').screenshot({ path: resolve(directory, 'notification-narrow.png') });
        await page.locator('iframe').evaluate(el => { el.style.width = '1200px'; el.style.height = '800px'; });
        await app.waitForFunction(() => innerWidth === 1200);
        await app.locator('.toast-close').click();
        await app.locator('#application-settings-close').click();
        await app.evaluate(() => { window.nativeProbe.data.importErrors = []; });
        await app.locator('#import-side').click();
        await toast.waitFor({ state: 'visible' });
        await toast.hover();
        await page.waitForTimeout(2800);
        if (!await toast.isVisible()) throw Error('hover must pause notification timeout');
        await app.locator('.library-header').hover();
        await toast.waitFor({ state: 'hidden', timeout: 4500 });
      }
      if (name === 'settings_interactions') {
        const app = page.frames().find(frame => frame.parentFrame());
        const trigger = app.locator('#app-book-opening-trigger');
        const popup = app.locator('#app-book-opening-popup');
        const openingSwitch = app.locator('#app-book-opening-enabled');
        const label = app.locator('label:has(> #app-book-opening-enabled) .app-row-label');
        await trigger.click();
        await popup.waitFor({ state: 'visible' });
        await label.click();
        await popup.waitFor({ state: 'hidden' });
        if (!await openingSwitch.isChecked()) throw Error('dismissing dropdown must not toggle opening switch');
        await label.click();
        await app.waitForFunction(() => !window.nativeProbe.data.settings.application.bookOpeningEnabled);
        await label.click();
        await app.waitForFunction(() => window.nativeProbe.data.settings.application.bookOpeningEnabled);
        for (let i = 0; i < 2; i++) {
          await trigger.click();
          await popup.waitFor({ state: 'visible' });
          await trigger.click();
          await popup.waitFor({ state: 'hidden' });
        }
        await trigger.click();
        await popup.waitFor({ state: 'visible' });
        await page.locator('iframe').screenshot({ path: resolve(directory, 'settings-soft-focus.png') });
        await page.emulateMedia({ colorScheme: 'dark' });
        await app.waitForFunction(() => document.body.dataset.theme === 'dark');
        await page.locator('iframe').screenshot({ path: resolve(directory, 'settings-soft-focus-dark.png') });
        await page.emulateMedia({ colorScheme: 'light' });
        await app.locator('#application-settings-close').click();
        if (!await app.locator('#application-settings').evaluate((el: HTMLDialogElement) => el.open)) throw Error('outside close button must only dismiss dropdown first');
        const dialog = app.locator('#application-settings');
        const heading = app.locator('#application-settings-title');
        const original = await dialog.boundingBox(), handle = await heading.boundingBox();
        await page.mouse.move(handle.x + 30, handle.y + handle.height / 2);
        const cursorBefore = await heading.evaluate(el => getComputedStyle(el).cursor);
        await page.mouse.down();
        await page.mouse.move(handle.x + 110, handle.y + handle.height / 2 + 40, { steps: 8 });
        const cursorDuring = await dialog.evaluate(el => getComputedStyle(el).cursor);
        await page.mouse.up();
        const moved = await dialog.boundingBox();
        if (Math.abs(moved.x - original.x - 80) > 1 || Math.abs(moved.y - original.y - 40) > 1 || cursorBefore !== cursorDuring)
          throw Error('settings title drag must move dialog and retain cursor');
        await page.locator('iframe').screenshot({ path: resolve(directory, 'application-settings-dragged.png') });
        const edgeHandle = await heading.boundingBox();
        await page.mouse.move(edgeHandle.x + 30, edgeHandle.y + 10);
        await page.mouse.down();
        await page.mouse.move(1390, 990, { steps: 5 });
        await page.mouse.up();
        if (!await dialog.evaluate((el: HTMLDialogElement) => {
          const rect = el.getBoundingClientRect();
          return el.open && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
        })) throw Error('dragging beyond edge must stay on screen and not dismiss dialog');
        await app.locator('#application-settings-close').click();
        await app.locator('#open-settings').click();
        const reopened = await dialog.boundingBox();
        if (Math.abs(reopened.x - original.x) > 1 || Math.abs(reopened.y - original.y) > 1) throw Error('settings must reopen centred');
        await app.locator('#application-settings-close').click();
        await app.locator('.book-card').first().click();
        await app.locator('#reader-loading').waitFor({ state: 'hidden' });
        await app.locator('#reader-settings').click();
        for (const key of ['fontFamily', 'fontWeight', 'animation']) {
          const trigger = app.locator(`#setting-${key}-trigger`), popup = app.locator(`#setting-${key}-popup`);
          await trigger.scrollIntoViewIfNeeded();
          const before = await app.locator(`#setting-${key}`).inputValue();
          await trigger.click(); await popup.waitFor({ state: 'visible' });
          await trigger.click(); await popup.waitFor({ state: 'hidden' });
          if (await app.locator(`#setting-${key}`).inputValue() !== before) throw Error(`${key} dismissal changed saved value`);
        }
        await app.locator('[data-close="reading-settings"]').click();
        await app.locator('#back-library').click();
        await app.locator('#sort-trigger').click();
        const imports = await app.evaluate(() => window.nativeProbe.requests.filter(item => item.method === 'import').length);
        await app.locator('#book-add').click();
        if (await app.evaluate(() => window.nativeProbe.requests.filter(item => item.method === 'import').length) !== imports)
          throw Error('sort dismissal must not import a book');
      }
      if (name === 'system_theme') {
        const app = page.frames().find(frame => frame.parentFrame());
        for (const scheme of ['light', 'dark', 'light'] as const) {
          await page.emulateMedia({ colorScheme: scheme });
          await app.waitForFunction(theme => document.body.dataset.theme === theme, scheme);
          await app.waitForFunction(color => getComputedStyle((document.getElementById('book-frame') as HTMLIFrameElement).contentDocument.body).backgroundColor === color,
            scheme === 'dark' ? 'rgb(25, 25, 25)' : 'rgb(255, 255, 255)');
          if (!await app.evaluate(() => window.nativeProbe.data.settings.application.theme === 'system' && window.nativeProbe.data.settings.reading.theme === 'system'))
            throw Error('OS changes must preserve system preferences');
        }
        await app.locator('#reader-settings').click();
        await page.emulateMedia({ colorScheme: 'dark' });
        await app.waitForFunction(() => getComputedStyle((document.getElementById('book-frame') as HTMLIFrameElement).contentDocument.body).backgroundColor === 'rgb(25, 25, 25)');
        await app.locator('[data-setting-theme="reading"][data-value="sepia"]').click();
        await app.waitForFunction(() => window.nativeProbe.data.settings.reading.theme === 'sepia');
        await page.emulateMedia({ colorScheme: 'light' });
        await app.waitForFunction(() => getComputedStyle((document.getElementById('book-frame') as HTMLIFrameElement).contentDocument.body).backgroundColor === 'rgb(255, 250, 243)');
        await app.locator('[data-close="reading-settings"]').click();
        await app.locator('#reader-app-settings').click();
        await app.locator('[data-setting-theme="application"][data-value="dark"]').click();
        await app.waitForFunction(() => window.nativeProbe.data.settings.application.theme === 'dark');
        for (const scheme of ['dark', 'light'] as const) await page.emulateMedia({ colorScheme: scheme });
        if (await app.locator('body').getAttribute('data-theme') !== 'dark') throw Error('manual theme must override system');
        await app.locator('[data-setting-theme="application"][data-value="system"]').click();
        await app.waitForFunction(() => document.body.dataset.theme === 'light');
      }
      if (name === 'reader_completion') await page.locator('iframe').screenshot({ path: resolve(directory, 'reader-completion.png') });
      if (name === 'shelves') {
        const app = page.frames().find(frame => frame.parentFrame());
        await app.locator('#shelf-add').click();
        await app.locator('#shelf-name').fill('本地封面');
        await app.locator('#shelf-cover-file').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: Buffer.from(await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 240; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#668078'; ctx.fillRect(0, 0, 160, 240); return canvas.toDataURL('image/png').split(',')[1]; }), 'base64') });
        await app.waitForFunction(() => document.querySelector<HTMLImageElement>('#shelf-cover-preview img')?.src.startsWith('data:image/webp'), null, { timeout: 10000 });
        await page.locator('iframe').screenshot({ path: resolve(directory, 'shelf-editor.png') });
        const cancelWidth = await app.locator('#shelf-cancel').evaluate((el: HTMLElement) => el.getBoundingClientRect().width);
        if (cancelWidth > 100) throw Error('shelf cancel must be compact');
        await app.locator('#shelf-save').click();
        await app.waitForFunction(() => window.nativeProbe.data.shelves.length === 2);
        if (!await app.evaluate(() => window.nativeProbe.data.shelves[1].cover.image.startsWith('data:image/webp;base64,'))) throw Error('uploaded cover must persist');
        await page.locator('iframe').screenshot({ path: resolve(directory, 'shelf-cards.png') });
      }
      if (name === 'production_smoke') {
        const app = page.frames().find(frame => frame.parentFrame());
        await app.locator('#setting-fontFamily-trigger').click();
        const capture = (name: string) => page.locator('iframe').screenshot({ path: resolve(directory, name), animations: 'disabled' });
        await capture('reading-settings.png');
        await app.locator('#setting-fontFamily-popup .select-search input').press('Escape');
        if (!await app.locator('#reading-settings').evaluate((el: HTMLDialogElement) => el.open)) throw Error('Escape closed the whole drawer');
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
        const luminance = (hex: string) => hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
          .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
          .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
        const ratio = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
        for (const [a, b] of [['--text', '--bg'], ['--muted', '--surface'], ['--on-primary', '--primary']]) {
          const expand = (color: string) => color.length === 4 ? '#' + [...color.slice(1)].map(c => c + c).join('') : color;
          if (ratio(expand(colors[a]), expand(colors[b])) < 4.5) throw Error(`${a}/${b} text contrast is too low`);
        }
        await capture('application-settings-dark.png');
        // Application settings: a caption bar over vertical tabs, each showing one group on its own.
        const shown = () => app.evaluate(() => [...document.querySelectorAll<HTMLElement>('.app-section')].filter(section => !section.hidden).map(section => section.id));
        for (const section of ['selection', 'agent', 'about', 'appearance']) {
          await app.locator(`#app-tab-${section}`).click();
          const visible = await shown();
          if (visible.join() !== `app-section-${section}`) throw Error(`tab ${section} must show only its group: ${visible}`);
        }
        await app.locator('#app-tab-appearance').focus();
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        if ((await shown()).join() !== 'app-section-agent' || !await app.evaluate(() => document.activeElement?.id === 'app-tab-agent'))
          throw Error('arrow keys must move between settings tabs');
        await page.keyboard.press('End');
        if ((await shown()).join() !== 'app-section-about') throw Error('End must select the last settings tab');
        if (!await app.evaluate(() => {
          const dialog = document.getElementById('application-settings') as HTMLDialogElement;
          const caption = document.querySelector('.app-settings-caption')!.getBoundingClientRect();
          const close = document.getElementById('application-settings-close')!.getBoundingClientRect();
          const scroll = document.getElementById('application-settings-scroll')!.getBoundingClientRect();
          const selected = document.querySelector('.app-settings-tab[aria-selected="true"]')!;
          const bar = getComputedStyle(selected, '::before');
          return dialog.matches(':modal') && caption.height === 38 && caption.width >= dialog.getBoundingClientRect().width - 2 &&
            close.top >= caption.top && close.bottom <= caption.bottom && close.right <= caption.right && scroll.top >= caption.bottom &&
            document.querySelectorAll('.app-settings-tab').length === 4 && bar.content !== 'none' && bar.width === '3px' &&
            document.querySelector('#app-tab-agent .fluent-icon, #app-tab-agent .material-icon') !== null;
        })) throw Error('settings caption, close button, tabs and selected-tab bar are laid out as designed');
        await app.locator('#app-tab-appearance').click();
        await app.locator('#application-settings-close').click();
        if (await app.evaluate(() => (document.getElementById('application-settings') as HTMLDialogElement).open)) throw Error('close button must dismiss application settings');
        await app.locator('#back-library').click();
        await app.locator('#library-view').waitFor({ state: 'visible' });
        await capture('library-dark.png');
        await app.locator('.book-card').first().click();
        await app.locator('#reader-loading').waitFor({ state: 'hidden' });
        await app.locator('#reader-settings').click();
        await app.locator('[data-setting-theme="reading"][data-value="dark"]').click();
        await app.waitForFunction(() => getComputedStyle((document.getElementById('book-frame') as HTMLIFrameElement).contentDocument.body).backgroundColor === 'rgb(25, 25, 25)');
        await app.locator('#setting-fontWeight-trigger').click();
        await capture('reading-settings-dark.png');
        await app.locator('#setting-fontWeight-trigger').press('Escape');
        await app.locator('[data-close="reading-settings"]').click();
        await capture('reader-dark.png');
        // Notes: a saved note leaves a tip at the top-right of the passage's end and peeks on hover;
        // the menu shows the passage's mark pressed, and pressing it again removes the mark.
        const frameBox = await app.locator('#book-frame').boundingBox();
        const passage = () => app.evaluate(() => {
          const doc = (document.getElementById('book-frame') as HTMLIFrameElement).contentDocument, view = doc.defaultView;
          const p = [...doc.querySelectorAll('p')].find(el => {
            const rect = el.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= view.innerWidth && rect.top >= 0 && rect.bottom <= view.innerHeight;
          });
          const range = doc.createRange();
          range.setStart(p.firstChild, 2); range.setEnd(p.firstChild, 10);
          return { range: range.getBoundingClientRect().toJSON(), rects: [...range.getClientRects()].map(r => r.toJSON()), index: [...doc.querySelectorAll('p')].indexOf(p) };
        });
        const marked = await passage();
        await app.evaluate(index => {
          const doc = (document.getElementById('book-frame') as HTMLIFrameElement).contentDocument;
          const text = doc.querySelectorAll('p')[index].firstChild, range = doc.createRange();
          range.setStart(text, 2); range.setEnd(text, 10);
          doc.getSelection().removeAllRanges(); doc.getSelection().addRange(range);
          doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        }, marked.index);
        await app.locator('#selection-menu').waitFor({ state: 'visible' });
        if (await app.locator('#selection-delete').count()) throw Error('the selection menu must not offer a separate mark deletion');
        await app.locator('#highlight-color').click();
        await app.locator('#mark-palette').waitFor({ state: 'visible' });
        await capture('selection-menu.png');
        await app.locator('#highlight-color').click();
        await app.locator('#selection-note').click();
        await app.locator('#annotation-note').fill('这是一条原创的测试笔记。');
        const editor = app.locator('#annotation-dialog');
        const editorStyle = await editor.evaluate((element: HTMLDialogElement) => ({
          width: element.offsetWidth,
          titleSize: getComputedStyle(element.querySelector('h2')).fontSize,
          blur: getComputedStyle(element, '::backdrop').backdropFilter,
          english: element.textContent.includes('ANNOTATION'),
        }));
        if (editorStyle.width > 420 || editorStyle.titleSize !== '15px' || editorStyle.blur !== 'none' || editorStyle.english)
          throw Error(`note editor must be compact with a plain Chinese title and no backdrop blur: ${JSON.stringify(editorStyle)}`);
        await capture('note-editor-compact.png');
        const initialEditor = await editor.boundingBox();
        const handle = await app.locator('#annotation-dialog .annotation-header').boundingBox();
        await page.mouse.move(handle.x + 90, handle.y + handle.height / 2);
        await page.mouse.down();
        await page.mouse.move(handle.x + 190, handle.y + handle.height / 2 - 60, { steps: 8 });
        await page.mouse.up();
        const movedEditor = await editor.boundingBox();
        if (Math.abs(movedEditor.x - initialEditor.x - 100) > 1 || Math.abs(movedEditor.y - initialEditor.y + 60) > 1 ||
            await app.locator('#annotation-note').inputValue() !== '这是一条原创的测试笔记。')
          throw Error('dragging the title bar must move the note editor and preserve its draft');
        await capture('note-editor-dragged.png');
        await app.locator('#annotation-save').click();
        const tip = await app.waitForFunction(() => (document.getElementById('book-frame') as HTMLIFrameElement).contentDocument
          .querySelector('.dr-note-tip')?.getBoundingClientRect().toJSON());
        const tipRect = await tip.jsonValue(), end = marked.rects.at(-1);
        if (Math.abs(tipRect.left - end.right) > 6 || tipRect.bottom > end.top + 8 || tipRect.top < end.top - 16)
          throw Error(`note tip must sit at the passage's top-right: ${JSON.stringify({ tipRect, end })}`);
        await page.mouse.move(frameBox.x + marked.rects[0].left + 6, frameBox.y + marked.rects[0].top + marked.rects[0].height / 2);
        await app.locator('#note-peek').waitFor({ state: 'visible' });
        if (await app.locator('#note-peek-text').textContent() !== '这是一条原创的测试笔记。') throw Error('hovering a noted passage must show its note');
        await capture('note-peek.png');
        const noteBook = await (await app.$('#book-frame')).contentFrame();
        const notePage = await app.locator('#page-indicator').textContent();
        await noteBook.locator('.dr-note-tip').click();
        await app.locator('#annotation-dialog').waitFor({ state: 'visible' });
        if (await app.locator('#note-peek').isVisible() ||
            await app.locator('#annotation-note').inputValue() !== '这是一条原创的测试笔记。' ||
            await app.locator('#page-indicator').textContent() !== notePage)
          throw Error('one click on a note icon must dismiss its preview and open the correct editor without turning');
        await app.locator('[aria-label="关闭笔记"]').click();
        await page.mouse.move(frameBox.x + marked.rects[0].left + 6, frameBox.y + marked.rects[0].top + marked.rects[0].height / 2);
        await app.locator('#note-peek').waitFor({ state: 'visible' });
        await page.mouse.click(frameBox.x + marked.rects[0].left + 6, frameBox.y + marked.rects[0].top + marked.rects[0].height / 2);
        if (await app.locator('#note-peek').isVisible() || await app.locator('#selection-menu').isVisible())
          throw Error('clicking a noted passage with its preview open must only dismiss the preview');
        await page.mouse.click(frameBox.x + marked.rects[0].left + 6, frameBox.y + marked.rects[0].top + marked.rects[0].height / 2);
        await app.locator('#selection-menu').waitFor({ state: 'visible' });
        if (await app.locator('#selection-highlight').getAttribute('aria-pressed') !== 'true' ||
            await app.locator('#selection-note-delete').isHidden())
          throw Error('a highlighted note must press the highlight button and offer note deletion');
        await capture('selection-menu-marked.png');
        await app.locator('#selection-highlight').click();
        await app.waitForFunction(() => window.nativeProbe.data.annotations[0]?.style === 'note');
        if (!await app.evaluate(() => (document.getElementById('book-frame') as HTMLIFrameElement).contentDocument.querySelector('.dr-note-tip')))
          throw Error('removing the highlight must keep the note and its tip');
        await page.mouse.click(frameBox.x + marked.rects[0].left + 6, frameBox.y + marked.rects[0].top + marked.rects[0].height / 2);
        await app.locator('#selection-note-delete').click();
        await app.waitForFunction(() => !window.nativeProbe.data.annotations.length &&
          !(document.getElementById('book-frame') as HTMLIFrameElement).contentDocument.querySelector('.dr-note-tip'));
        await app.evaluate(() => { document.getElementById('toast').hidden = true; });
        await app.evaluate(() => {
          window.chapterGate = new Promise(resolve => { window.releaseChapter = resolve; });
          const frame = (document.getElementById('book-frame') as HTMLIFrameElement);
          window.chapterSwapChecks = [];
          window.chapterSwapObserver = new MutationObserver(() => {
            const snapshot = document.querySelector<HTMLIFrameElement>('.page-motion .motion-page iframe');
            window.chapterSwapChecks.push(Boolean(snapshot?.contentDocument?.body?.textContent.includes('原创的阅读测试文字') &&
              getComputedStyle(snapshot.closest('.page-motion')).visibility === 'visible' &&
              getComputedStyle(frame).visibility === 'hidden'));
          });
          window.chapterSwapObserver.observe(frame, { attributes: true, attributeFilter: ['srcdoc'] });
          const doc = frame.contentDocument, pages = Number(document.getElementById('page-indicator').textContent.split('/')[1]);
          doc.defaultView.scrollTo((pages - 1) * doc.defaultView.innerWidth, 0);
        });
        await app.waitForFunction(() => {
          const [page, pages] = document.getElementById('page-indicator').textContent.split('/').map(Number);
          return page === pages;
        });
        await app.locator('#next-page').click();
        await app.waitForFunction(() => window.chapterRequests === 2);
        if (!await app.evaluate(() => document.getElementById('reader-loading').hidden &&
          (document.getElementById('book-frame') as HTMLIFrameElement).contentDocument.body.textContent.includes('原创的阅读测试文字')))
          throw Error('cross-chapter fetch must retain the old page without a loading flash');
        await app.evaluate(() => { window.releaseChapter(); window.chapterGate = null; });
        await app.waitForFunction(() => (document.getElementById('book-frame') as HTMLIFrameElement).srcdoc.includes('second.html') &&
          document.getElementById('reader-loading').hidden && !document.querySelector('.page-motion'));
        if (!await app.evaluate(() => window.chapterSwapChecks.length > 0 && window.chapterSwapChecks.every(Boolean)))
          throw Error('cross-chapter document replacement must stay covered until the new page is ready');
        await app.evaluate(() => window.chapterSwapObserver.disconnect());
        await app.locator('#prev-page').click();
        await app.waitForFunction(() => (document.getElementById('book-frame') as HTMLIFrameElement).srcdoc.includes('/chapter.html') &&
          document.getElementById('reader-loading').hidden && !document.querySelector('.page-motion'));
        await app.waitForFunction(() => {
          const [page, pages] = document.getElementById('page-indicator').textContent.split('/').map(Number);
          return page === pages;
        });
        console.log('PASS cross-chapter fetch/replacement without loading flashes and backward last-page restoration');
        const tocPanel = app.locator('#toc-panel');
        await app.locator('#book-frame').hover();
        await tocPanel.waitFor({ state: 'hidden' });
        const expandedWidth = await app.locator('#book-frame').evaluate((el: HTMLIFrameElement) => el.clientWidth);
        const revealWidth = await app.locator('#toc-reveal-zone').evaluate((el: HTMLElement) => el.getBoundingClientRect().width);
        if (Math.abs(revealWidth - 8) > 0.1) throw Error('reveal zone must be exactly 8px wide');
        await app.locator('#toc-reveal-zone').hover({ position: { x: 4, y: 100 } });
        await tocPanel.waitFor({ state: 'visible' });
        await app.locator('.toc-entry').first().hover();
        if (await app.locator('#book-frame').evaluate((el: HTMLIFrameElement) => el.clientWidth) !== expandedWidth)
          throw Error('auto-hide sidebar must overlay without reflowing the book');
        await app.locator('#pin-toc').click();
        await app.waitForFunction(() => window.nativeProbe.data.settings.reading.tocPinned === true);
        await app.locator('#book-frame').hover();
        if (!await tocPanel.isVisible() || await app.locator('#pin-toc').getAttribute('aria-pressed') !== 'true')
          throw Error('pinned sidebar must remain visible outside hover');
        await app.locator('.toc-entry').nth(1).click();
        await app.waitForFunction(() => document.querySelectorAll('.toc-entry')[1].classList.contains('active'));
        // The capsule waits for the destination chapter layout, then moves once.
        await app.waitForFunction(() => document.querySelector('.toc-active-indicator').getAnimations().some(a => a.playState === 'running'),
          undefined, { timeout: 3000 });
        await app.locator('.toc-active-indicator').evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
        if (!await app.locator('.toc-active-indicator').evaluate(el => {
          const marker = el.getBoundingClientRect(), active = document.querySelector('.toc-entry.active').getBoundingClientRect();
          return Math.abs(marker.height * 2 - active.height) < 1 &&
            Math.abs(marker.top + marker.height / 2 - active.top - active.height / 2) < 1 &&
            Math.abs(marker.left + marker.width / 2 - active.left) < 0.1;
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
        if (!await app.locator('#book-search-input').evaluate((el: HTMLElement) => document.activeElement === el))
          throw Error('book search must expand the sidebar and receive keyboard focus');
        const searchPage = await app.locator('#page-indicator').textContent();
        const searchBook = await (await app.$('#book-frame')).contentFrame();
        const searchWidth = await searchBook.evaluate(() => innerWidth);
        await searchBook.locator('html').click({ position: { x: searchWidth - 5, y: 200 } });
        await tocPanel.waitFor({ state: 'hidden' });
        await page.waitForTimeout(300);
        if (await app.locator('#page-indicator').textContent() !== searchPage)
          throw Error('clicking the page must dismiss the search sidebar without turning');
        await app.locator('#book-frame').press('Control+f');
        await app.locator('[data-tab="toc"]').click();
        console.log('PASS auto-hide sidebar, 8px reveal zone, pin persistence, chapter capsule animation and keyboard search');
        await app.locator('#reader-app-settings').click();
        await app.locator('[data-setting-theme="application"][data-value="light"]').click();
        await app.waitForFunction(() => document.body.dataset.theme === 'light');
        await app.locator('#application-settings-close').click();
        const paper = await app.locator('#book-frame').evaluate((el: HTMLIFrameElement) => getComputedStyle(el.contentDocument.body).backgroundColor);
        if (paper !== 'rgb(25, 25, 25)') throw Error('application theme must not override the independent reading theme');
        await app.locator('#reader-settings').click();
        await app.locator('[data-setting-theme="reading"][data-value="light"]').click();
        await app.waitForFunction(() => getComputedStyle((document.getElementById('book-frame') as HTMLIFrameElement).contentDocument.body).backgroundColor === 'rgb(255, 255, 255)');
        await app.locator('[data-close="reading-settings"]').click();
        await app.locator('#back-library').click();
        await app.locator('#library-view').waitFor({ state: 'visible' });
        await capture('library-light.png');
        // Home-page labels are chrome: a select-all drag must not pick them up, while search stays editable.
        if (!await app.evaluate(() => {
          getSelection().selectAllChildren(document.getElementById('library-view'));
          const selected = getSelection().toString().trim();
          getSelection().removeAllRanges();
          const search = document.getElementById('library-search') as HTMLInputElement;
          search.value = '可编辑'; search.select();
          const editable = search.selectionEnd - search.selectionStart === 3;
          search.value = '';
          return !selected.includes('全部图书') && getComputedStyle(document.querySelector('.nav-item')).userSelect === 'none' && editable;
        })) throw Error('library home text must not be selectable while the search field stays editable');
        if (!await app.evaluate(() => {
          const field = document.querySelector('.search-field'), icon = field.querySelector('.ui-icon').getBoundingClientRect();
          const box = field.getBoundingClientRect();
          return Math.abs(icon.top + icon.height / 2 - (box.top + box.height / 2)) < 1;
        })) throw Error('library search icon must be vertically centred in its field');
        await app.locator('#library-search').focus();
        if (await app.locator('#library-search').evaluate((el: HTMLElement) => getComputedStyle(el).outlineStyle) !== 'none')
          throw Error('focused library search must not draw a square outline inside its rounded field');
        await capture('library-search-focus.png');
        await app.locator('#library-search').blur();
        // Exercise immersive mode through the shipped controls, then recover without a toolbar.
        await app.locator('.book-card').first().click();
        await app.locator('#reader-loading').waitFor({ state: 'hidden' });
        const checkToolbar = () => app.evaluate(() => {
          const back = document.querySelector('#back-library');
          const arrow = back.querySelector('.ui-icon').getBoundingClientRect();
          const actions = document.querySelector('.reader-actions').getBoundingClientRect();
          return arrow.left >= 0 && arrow.left <= 14 && actions.right <= innerWidth &&
            back.getBoundingClientRect().right < actions.left;
        });
        if (!await checkToolbar()) throw Error('reader toolbar must align left without overlapping actions');
        // Quick typesetting sits centred between navigation and actions and drives the real settings.
        if (!await app.evaluate(() => {
          const quick = document.querySelector('.toolbar-quick').getBoundingClientRect();
          const start = document.querySelector('.toolbar-start').getBoundingClientRect();
          const actions = document.querySelector('.reader-actions').getBoundingClientRect();
          return quick.width > 0 && quick.left >= start.right && quick.right <= actions.left &&
            Math.abs(quick.left + quick.width / 2 - innerWidth / 2) < 4;
        })) throw Error('quick toolbar controls must be centred without overlapping either side');
        if (!await app.evaluate(() => {
          const toc = document.getElementById('toggle-toc'), title = document.getElementById('reader-book-title');
          return toc.closest('.toolbar-start') && toc.getBoundingClientRect().right <= title.getBoundingClientRect().left &&
            toc.querySelector('.material-icon') && /^《.+》$/.test(title.textContent) &&
            !document.querySelector('.sidebar .material-icon, #library-view [data-icon] .material-icon:not(#shelves-back .material-icon, #library-back-to-top .material-icon), #book-context-menu .material-icon') &&
            document.querySelectorAll(':is(.sidebar, #library-view) .fluent-icon').length > 8;
        })) throw Error('sidebar toggle must sit before the 《title》 and library navigation must keep Fluent icons');
        // Hover tips are self-drawn: no native title survives, and hovering shows the custom tip.
        if (await app.locator('[title]:not(iframe)').count()) throw Error('native title tooltips must be replaced by self-drawn tips');
        await app.locator('#reader-search').hover();
        await app.waitForFunction(() => {
          const tip = document.querySelector('.ui-tooltip');
          return tip.matches(':popover-open') && tip.classList.contains('visible') && tip.textContent.startsWith('书内搜索');
        });
        await page.mouse.move(5, 400);
        // The toolbar title is chrome: not selectable, and only an ellipsised title shows its full name.
        if (await app.evaluate(() => getComputedStyle(document.getElementById('reader-book-title')).userSelect) !== 'none')
          throw Error('reader toolbar title must not be selectable');
        const toolbarTitle = await app.evaluate(() => {
          const title = document.getElementById('reader-book-title');
          if (title.scrollWidth <= title.clientWidth && title.hasAttribute('data-tooltip')) return null;
          title.style.maxWidth = '48px';
          return title.textContent.replace(/^《|》$/gu, '');
        });
        if (toolbarTitle === null) throw Error('an untruncated toolbar title must not show a hover tip');
        await app.waitForFunction(() => document.getElementById('reader-book-title').hasAttribute('data-tooltip'));
        await app.locator('#reader-book-title').hover();
        await app.waitForFunction(text => {
          const tip = document.querySelector('.ui-tooltip');
          return tip.matches(':popover-open') && tip.textContent.includes(text);
        }, toolbarTitle);
        const tipBox = await app.evaluate(() => {
          const tip = document.querySelector('.ui-tooltip').getBoundingClientRect();
          const title = document.getElementById('reader-book-title').getBoundingClientRect();
          return Math.abs(tip.left + tip.width / 2 - (title.left + title.width / 2)) < 2 || tip.left <= 4;
        });
        if (!tipBox) throw Error('toolbar title tip must centre under the title text');
        await page.mouse.move(5, 400);
        await app.evaluate(() => { document.getElementById('reader-book-title').style.maxWidth = ''; });
        await app.waitForFunction(() => !document.querySelector('.ui-tooltip').matches(':popover-open'));
        // The far-right button collapses the toolbar into a single expand button and persists it.
        await app.locator('#collapse-toolbar').click();
        await app.waitForFunction(() => window.nativeProbe.data.settings.reading.showToolbar === false);
        if (await app.locator('.reader-toolbar').isVisible()) throw Error('collapsed toolbar must hide the toolbar');
        const shell = await page.locator('iframe').boundingBox();
        await page.mouse.move(shell.x + shell.width / 2, shell.y + shell.height / 2);
        await app.locator('#expand-toolbar').waitFor({ state: 'hidden' });
        await page.mouse.move(shell.x + shell.width - 8, shell.y + 3);
        await app.locator('#expand-toolbar').waitFor({ state: 'visible' });
        await app.locator('#expand-toolbar').click();
        await app.waitForFunction(() => window.nativeProbe.data.settings.reading.showToolbar === true);
        await app.locator('#expand-toolbar').waitFor({ state: 'hidden' });
        await app.locator('.reader-toolbar').waitFor({ state: 'visible' });
        const fontSize = await app.evaluate(() => window.nativeProbe.data.settings.reading.fontSize);
        await app.locator('#font-larger').click();
        await app.waitForFunction(size => window.nativeProbe.data.settings.reading.fontSize === size + 1 &&
          document.getElementById('quick-font-size').textContent === String(size + 1), fontSize);
        await app.locator('#font-smaller').click();
        await app.waitForFunction(size => window.nativeProbe.data.settings.reading.fontSize === size, fontSize);
        await app.locator('[data-quick-theme="dark"]').click();
        await app.waitForFunction(() => getComputedStyle((document.getElementById('book-frame') as HTMLIFrameElement).contentDocument.body).backgroundColor === 'rgb(25, 25, 25)' &&
          document.querySelector('[data-quick-theme="dark"]').getAttribute('aria-checked') === 'true');
        await capture('reader-toolbar-dark-page.png');
        await app.locator('[data-quick-theme="light"]').click();
        await app.waitForFunction(() => window.nativeProbe.data.settings.reading.theme === 'light');
        // The reader is laid out against the window, so narrow the application frame itself.
        const appFrame = page.locator('iframe');
        await appFrame.evaluate(el => el.style.width = '460px');
        await app.waitForFunction(() => innerWidth === 460);
        if (await app.locator('.toolbar-quick').isVisible()) throw Error('quick controls must yield to actions on narrow windows');
        if (!await checkToolbar()) throw Error('narrow reader toolbar overlaps or loses left alignment');
        await appFrame.evaluate(el => el.style.width = '1200px');
        await app.waitForFunction(() => innerWidth === 1200);
        await app.locator('#reader-settings').click();
        if (await app.locator('#setting-immersive').inputValue() !== 'keep') throw Error('immersive reading must open on "keep as is"');
        // Older text-only presets switched the sidebar off; the new one must bring it back unpinned.
        await app.locator('#setting-showToc').click();
        await app.waitForFunction(() => window.nativeProbe.data.settings.reading.showToc === false);
        await app.locator('#setting-immersive-trigger').click();
        await app.getByRole('option', { name: '只看正文' }).click();
        await app.waitForFunction(() => document.getElementById('reader-view').dataset.toolbar === 'false');
        await app.waitForFunction(() => window.nativeProbe.data.settings.reading.showToc === true &&
          window.nativeProbe.data.settings.reading.tocPinned === false && !document.getElementById('toc-reveal-zone').hidden);
        for (const [key, value] of [['paddingTop', '20'], ['paddingBottom', '80'], ['paddingLeft', '10'], ['paddingRight', '90']])
          await app.locator(`#number-${key}`).fill(value);
        await app.waitForFunction(() => window.nativeProbe.data.settings.reading.paddingRight === 90);
        await app.locator('[data-close="reading-settings"]').click();
        await app.waitForFunction(() => {
          const frame = (document.getElementById('book-frame') as HTMLIFrameElement);
          return frame.clientWidth === innerWidth && frame.clientHeight === innerHeight &&
            getComputedStyle(frame.contentDocument.body).marginLeft === '10px';
        });
        const edges = await app.locator('#book-frame').evaluate((el: HTMLIFrameElement) => {
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
        // Text-only reading keeps the sidebar's 8px reveal strip, so the left tap lands just past it.
        await book.locator('html').click({ position: { x: 24, y: size.height * .5 } });
        await app.waitForFunction(previous => parseInt(document.getElementById('page-indicator').textContent) === previous, beforeTap);
        await book.evaluate(() => {
          const text = document.querySelector('p').firstChild;
          const range = document.createRange(); range.selectNodeContents(text);
          getSelection().removeAllRanges(); getSelection().addRange(range);
        });
        await book.locator('html').click({ position: { x: size.width - 5, y: size.height * .5 } });
        await page.waitForTimeout(300);
        if (await pageNumber() !== beforeTap) throw Error('clicking to dismiss a selection also turned the page');
        // Escape dismisses one colour/menu layer at a time and always keeps the book open.
        const selectPassage = async () => {
          await book.locator('p').first().evaluate(element => {
            const range = document.createRange(); range.selectNodeContents(element);
            getSelection().removeAllRanges(); getSelection().addRange(range);
            element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          });
          await app.locator('#selection-menu').waitFor({ state: 'visible' });
        };
        await selectPassage();
        await app.locator('#highlight-color').click();
        const plus = await app.locator('#highlight-swatches .color-custom').evaluate(element => {
          return ['::before', '::after'].every(pseudo => {
            const style = getComputedStyle(element, pseudo);
            const matrix = new DOMMatrix(style.transform);
            return Math.abs(parseFloat(style.left) + matrix.e + parseFloat(style.width) / 2 - element.clientWidth / 2) < .1 &&
              Math.abs(parseFloat(style.top) + matrix.f + parseFloat(style.height) / 2 - element.clientHeight / 2) < .1;
          });
        });
        if (!plus) throw Error('custom colour plus must be centred in its button');
        await app.locator('#highlight-swatches .color-custom').click();
        await app.locator('.color-picker:popover-open').waitFor();
        await app.locator('.color-picker').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
        const gaps = await app.evaluate(() => {
          const menu = document.getElementById('selection-menu').getBoundingClientRect();
          const palette = document.getElementById('mark-palette').getBoundingClientRect();
          const picker = document.querySelector('.color-picker:popover-open').getBoundingClientRect();
          return [palette.top - menu.bottom, picker.top - palette.bottom];
        });
        if (gaps.some(gap => Math.abs(gap - 1) > .1)) throw Error(`nested colour popups must leave a 1px gap: ${gaps}`);
        const otherWindow = await browser.newPage();
        await otherWindow.bringToFront();
        await app.evaluate(() => window.dispatchEvent(new Event('blur')));
        await page.bringToFront();
        await otherWindow.close();
        if (!await app.locator('.color-picker:popover-open').count() ||
            !await app.locator('#mark-palette').isVisible() || !await app.locator('#selection-menu').isVisible())
          throw Error('losing window focus must preserve every colour/menu layer');
        await page.keyboard.press('Escape');
        if (await app.locator('.color-picker:popover-open').count() ||
            !await app.locator('#mark-palette').isVisible() || !await app.locator('#selection-menu').isVisible())
          throw Error('first Escape must dismiss only the custom colour picker');
        await page.keyboard.press('Escape');
        if (await app.locator('#mark-palette').isVisible() || !await app.locator('#selection-menu').isVisible())
          throw Error('second Escape must dismiss only the colour palette');
        await page.keyboard.press('Escape');
        if (await app.locator('#selection-menu').isVisible()) throw Error('third Escape must dismiss the selection menu');
        await page.keyboard.press('Escape');
        await book.locator('html').press('Escape');
        if (!await app.locator('#reader-view').isVisible()) throw Error('Escape must never close the book');
        await selectPassage();
        await app.locator('#highlight-color').click();
        const balanced = await app.locator('#mark-palette').evaluate((element: HTMLElement) => {
          const outer = element.getBoundingClientRect();
          const row = element.querySelector('.swatch-row').getBoundingClientRect();
          return Math.abs((row.top - outer.top) - (outer.bottom - row.bottom)) < .1;
        });
        if (!balanced) throw Error('colour palette must have equal top and bottom spacing');
        await app.locator('#highlight-swatches .color-custom').click();
        const beforeDismiss = await pageNumber();
        await book.locator('html').click({ position: { x: size.width - 5, y: size.height * .5 } });
        await page.waitForTimeout(300);
        if (await pageNumber() !== beforeDismiss || await app.locator('.color-picker:popover-open').count() ||
            await app.locator('#mark-palette').isVisible() || await app.locator('#selection-menu').isVisible())
          throw Error('clicking the page must close every colour/menu layer without turning');
        // The same guard applies when only the manual colour popover remains, with no text selection.
        await selectPassage();
        await app.locator('#highlight-color').click();
        await app.locator('#highlight-swatches .color-custom').click();
        await book.evaluate(() => getSelection().removeAllRanges());
        await book.locator('html').click({ position: { x: size.width - 5, y: size.height * .5 } });
        await page.waitForTimeout(300);
        if (await pageNumber() !== beforeDismiss || await app.locator('.color-picker:popover-open').count())
          throw Error('closing a colour popover without a selection must also consume the page click');
        await selectPassage();
        await app.locator('#selection-note').click();
        await app.locator('#annotation-swatches .color-custom').click();
        await page.keyboard.press('Escape');
        if (await app.locator('.color-picker:popover-open').count() ||
            !await app.locator('#annotation-dialog').evaluate((element: HTMLDialogElement) => element.open))
          throw Error('Escape must dismiss the custom colour picker before the note dialog');
        await page.keyboard.press('Escape');
        if (await app.locator('#annotation-dialog').evaluate((element: HTMLDialogElement) => element.open)) throw Error('next Escape must dismiss the note dialog');
        await book.evaluate(() => getSelection().removeAllRanges());
        await page.keyboard.press('F8');
        await app.locator('#reading-settings').waitFor({ state: 'visible' });
        await app.locator('[data-close="reading-settings"]').click();
        // Alt+Enter only hides the title bar; fullscreen is a separate F11 toggle.
        await page.keyboard.press('Alt+Enter');
        await app.waitForFunction(() => document.body.dataset.titlebar === 'hidden');
        if (await app.evaluate(() => window.nativeProbe.data.fullscreen)) throw Error('Alt+Enter must not enter fullscreen');
        await book.locator('html').press('Alt+Enter');
        await app.waitForFunction(() => document.body.dataset.titlebar === 'shown');
        // "窗口内全屏" hides the title bar like Alt+Enter; "显示阅读界面" brings it back. The preset
        // is not remembered, so the dropdown reopens on "保持现状".
        await page.keyboard.press('F8');
        await app.locator('#reading-settings').waitFor({ state: 'visible' });
        if (await app.locator('#setting-immersive').inputValue() !== 'keep') throw Error('immersive preset must reset when the drawer reopens');
        await app.locator('#setting-immersive-trigger').click();
        await app.getByRole('option', { name: '窗口内全屏' }).click();
        await app.waitForFunction(() => document.body.dataset.titlebar === 'hidden');
        if (await app.evaluate(() => window.nativeProbe.data.fullscreen)) throw Error('window fullscreen must not enter system fullscreen');
        await app.locator('#setting-immersive-trigger').click();
        await app.getByRole('option', { name: '显示阅读界面' }).click();
        await app.waitForFunction(() => document.body.dataset.titlebar === 'shown' && document.getElementById('reader-view').dataset.toolbar === 'true');
        // Back to text-only reading for the collapsed-toolbar checks below.
        await app.locator('#setting-immersive-trigger').click();
        await app.getByRole('option', { name: '只看正文' }).click();
        await app.waitForFunction(() => document.getElementById('reader-view').dataset.toolbar === 'false');
        await app.locator('[data-close="reading-settings"]').click();
        await page.keyboard.press('F11');
        await app.waitForFunction(() => document.body.dataset.fullscreen === 'true');
        await page.keyboard.press('Escape');
        await app.waitForFunction(() => document.body.dataset.fullscreen === 'false');
        if (await app.locator('#reader-view').evaluate((el: HTMLElement) => el.hidden)) throw Error('Escape should exit fullscreen before leaving the book');
        // A collapsed toolbar leaves nothing on screen; each top corner reveals only its own button.
        const corner = () => app.evaluate(() => ['corner-library', 'expand-toolbar']
          .map(id => getComputedStyle(document.getElementById(id)).visibility).join());
        const at = (x: number, y: number) => page.mouse.move(shell.x + x, shell.y + y);
        await at(size.width * .5, size.height * .5);
        await page.waitForTimeout(700);
        if (await corner() !== 'hidden,hidden') throw Error('collapsed toolbar must not leave buttons on screen');
        // Only a 6px strip under the title bar, as wide as the right-hand buttons, reveals them.
        const stripLeft = await app.evaluate(() => document.getElementById('corner-settings').getBoundingClientRect().left);
        for (const [x, y] of [[size.width - 8, 8], [stripLeft - 12, 3]]) {
          await at(x, y);
          await page.waitForTimeout(300);
          if (await corner() !== 'hidden,hidden') throw Error(`the top-right trigger must be the 6px strip over the buttons, not ${x},${y}`);
        }
        await at(stripLeft + 4, 3);
        await app.waitForFunction(() => getComputedStyle(document.getElementById('expand-toolbar')).visibility === 'visible');
        await at(size.width * .5, size.height * .5);
        await app.waitForFunction(() => getComputedStyle(document.getElementById('expand-toolbar')).visibility === 'hidden');
        await at(size.width - 8, 3);
        await app.waitForFunction(() => getComputedStyle(document.getElementById('expand-toolbar')).visibility === 'visible');
        if (await corner() !== 'hidden,visible') throw Error('top-right corner must reveal only the expand button');
        // The top-right corner also offers reading settings beside the expand button.
        await app.waitForFunction(() => getComputedStyle(document.getElementById('corner-settings')).visibility === 'visible');
        const cornerRects = await app.evaluate(() => ['corner-settings', 'expand-toolbar'].map(id => document.getElementById(id).getBoundingClientRect().toJSON()));
        if (cornerRects[0].right > cornerRects[1].left || cornerRects[0].top !== cornerRects[1].top)
          throw Error(`reading settings must sit beside the expand button: ${JSON.stringify(cornerRects)}`);
        await app.locator('#corner-settings').click();
        await app.locator('#reading-settings').waitFor({ state: 'visible' });
        await app.locator('[data-close="reading-settings"]').click();
        await at(size.width - 8, 3);
        await at(40, 20);
        await app.waitForFunction(() => getComputedStyle(document.getElementById('corner-library')).visibility === 'visible');
        await at(size.width * .5, size.height * .5);
        await app.waitForFunction(() => getComputedStyle(document.getElementById('corner-library')).visibility === 'hidden');
        await book.locator('html').click({ position: { x: size.width * .5, y: size.height * .5 } });
        await app.waitForFunction(() => document.getElementById('reader-view').dataset.corner === 'both');
        await app.locator('#expand-toolbar').click();
        await app.locator('.reader-toolbar').waitFor({ state: 'visible' });
        console.log('PASS immersive controls, margins, side taps, selection guard, F8 and fullscreen protocol');
        await app.locator('#back-library').click();
        const originalTitle = await app.locator('.book-card h3').textContent();
        const fullTitle = '庄子——中华经典名著全本全注全译丛书（中华书局）· 完整书名悬浮提示';
        await app.locator('.book-card h3').evaluate((el, title) => { el.textContent = title; }, fullTitle);
        for (const [width, height] of [[180, 270], [270, 180]]) {
          const centered = await app.locator('.book-card .cover-wrap').evaluate(async (wrap, [width, height]) => {
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
        await app.locator('.library-header').hover();
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
        if (!await app.locator('#book-context-menu').evaluate((el: HTMLElement) => {
          const rect = el.getBoundingClientRect();
          return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
        })) throw Error('context menu must stay within the viewport');
        await capture('library-context-menu.png');
        await app.locator('#book-menu-delete').click();
        await app.locator('#delete-book-dialog').waitFor({ state: 'visible' });
        if (!await app.locator('#reader-view').evaluate((el: HTMLElement) => el.hidden)) throw Error('delete button opened the book');
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
          !document.getElementById('empty-state').hidden))
          throw Error('delete must persist and refresh counts, empty state and continue reading');
        console.log('PASS centered covers, title ellipsis and tooltip, context menu, deletion confirmation, cancellation and empty library');
      }
      if (name === 'settings_controls') {
        await page.setViewportSize({ width: 360, height: 800 });
        await page.reload();
        await page.waitForSelector('html[data-result]', { timeout: 18000, state: 'attached' });
        if (await page.locator('html').getAttribute('data-result') !== 'pass') throw Error(`narrow settings: ${await page.locator('#result').textContent()}`);
      }
      if (name === 'book_opening') {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        if (!await page.evaluate(async () => {
          for (const effect of ['circles', 'book', 'cover'])
            await new window.BookOpening(document.getElementById('busy'), true, effect).finish();
          return !document.querySelector('.book-opening');
        })) throw Error('reduced motion must skip both opening effects');
      }
      if (errors.length) throw Error(`${name}: ${errors.join('\n')}`);
      await writeFile(resolve(directory, `${name}.log`), errors.join('\n'));
      console.log(`PASS ${name}`);
    } finally { await page.close(); }
  }
} finally { await browser.close(); await server.close(); }
