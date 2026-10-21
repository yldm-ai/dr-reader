import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fontChoices, fontStack } from '../web/fonts.ts';
import { ChapterCache } from '../web/chapter-cache.ts';
import { sameReading } from '../web/settings-state.ts';
import { pageMargins, pageClickDirection, pageCorner } from '../web/reading-layout.ts';
import { DEFAULT_PALETTE, normalizeColor, paint, pushColor } from '../web/highlight-colors.ts';
import { bookPages, chapterTextLength } from '../web/book-pages.ts';
import { htmlFromXhtml } from '../web/xhtml.ts';
import { shortTitle } from '../web/title.ts';

test('book titles past twenty characters end in an ellipsis', () => {
  assert.equal(shortTitle('仙逆'), '仙逆');
  assert.equal(shortTitle('一二三四五六七八九十一二三四五六七八九十'), '一二三四五六七八九十一二三四五六七八九十');
  assert.equal(shortTitle('早起的奇迹：那些能够在早晨8:00前改变人生的秘密'), '早起的奇迹：那些能够在早晨8:00前改变…');
  assert.equal(shortTitle('😀'.repeat(21)), `${'😀'.repeat(20)}…`);
});

test('self-closing non-void XHTML elements become HTML-safe; void elements stay', () => {
  assert.equal(htmlFromXhtml('<head><title/><link href="a.css" rel="stylesheet"/></head><p>正文<br/></p>'),
    '<head><title></title><link href="a.css" rel="stylesheet"/></head><p>正文<br/></p>');
  assert.equal(htmlFromXhtml('<div class="x" data-a="1/2>3"/><svg:path d="M0 0"/><img src="a.png"/>'),
    '<div class="x" data-a="1/2>3"></div><svg:path d="M0 0"></svg:path><img src="a.png"/>');
  // The parsed document keeps its text instead of swallowing it into the title.
  assert.equal(htmlFromXhtml('<title/>').includes('</title>'), true);
});

test('a picked highlight colour takes the first slot and pushes the oldest out', () => {
  assert.deepEqual(pushColor(DEFAULT_PALETTE, '#A1B2C3'), ['#a1b2c3', ...DEFAULT_PALETTE.slice(0, 4)]);
  assert.deepEqual(pushColor(DEFAULT_PALETTE, DEFAULT_PALETTE[3]),
    [DEFAULT_PALETTE[3], DEFAULT_PALETTE[0], DEFAULT_PALETTE[1], DEFAULT_PALETTE[2], DEFAULT_PALETTE[4]]);
  assert.equal(normalizeColor('green'), '#ddedea');
});
test('Notion highlight presets keep their exact dark values; tinted papers multiply the fill', () => {
  assert.deepEqual(paint('yellow', '#191919', true), { fill: '#59563b', ink: '#ffdc49' });
  assert.equal(paint('#fbf3db', '#ffffff', false).fill, '#fbf3db');
  assert.equal(paint('#fbf3db', '#fffaf3', false).fill, '#fbeed1');
  assert.equal(paint('#fbf3db', '#ffffff', false).ink, '#dfab01');
});
test('whole-book pages use exact counts for read chapters and estimate the rest', () => {
  assert.equal(chapterTextLength('<style>p{}</style><p>一 二</p><p>&amp;三</p>'), 4);
  assert.equal(bookPages({ chars: [100, undefined], exact: new Map(), chapter: 0, page: 0, fallbackPerPage: 50 }), null);
  const exact = new Map([[1, 4]]);
  assert.deepEqual(bookPages({ chars: [400, 800, 1600], exact, chapter: 1, page: 2, fallbackPerPage: 50 }),
    { current: 5, total: 14, estimated: true });
  assert.deepEqual(bookPages({ chars: [200, 200], exact: new Map([[0, 2], [1, 2]]), chapter: 1, page: 1, fallbackPerPage: 50 }),
    { current: 4, total: 4, estimated: false });
});

test('font choices distinguish saved values from labels and preserve missing current fonts', () => {
  const choices = fontChoices(['Microsoft YaHei', '', '宋体', ' 宋体 '], 'Missing Font');
  assert.equal(choices.filter(item => item.value === '宋体').length, 1);
  assert.equal(choices[0].value, 'serif');
  assert.notEqual(choices[0].label, choices[0].value);
  assert.ok(choices.find(item => item.value === 'Missing Font'));
  assert.ok(fontStack('sans-serif').startsWith("'Microsoft YaHei'"));
  assert.ok(fontStack('宋体').startsWith('"宋体"'));
});
test('chapter cache evicts least recently used chapters and bounds decoded memory', () => {
  const cache = new ChapterCache(2, 16);
  cache.put('a', '甲乙'); cache.put('b', '丙丁');
  assert.equal(cache.get('a'), '甲乙');
  cache.put('c', '戊己');
  assert.equal(cache.get('b'), undefined);
  cache.put('huge', 'x'.repeat(20));
  assert.equal(cache.get('huge'), undefined);
  assert.equal(cache.get('a'), '甲乙');
  cache.put('c', 'x'.repeat(7));
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('c'), 'x'.repeat(7));
});
test('transport object changes do not require reflow, typography changes do', () => {
  const reading = { fontFamily: 'serif', fontSize: 20, mode: 'paged' };
  assert.ok(sameReading(reading, structuredClone(reading)));
  assert.equal(sameReading(reading, { ...reading, fontSize: 21 }), false);
  assert.equal(sameReading(undefined, reading), false);
});
test('asymmetric margins preserve a readable region even in a small viewport', () => {
  assert.deepEqual(pageMargins({ paddingTop: 20, paddingBottom: 80, paddingLeft: 10, paddingRight: 90 }, 800, 600),
    { top: 20, bottom: 80, left: 10, right: 90 });
  const clamped = pageMargins({ paddingLeft: 240, paddingRight: 240, paddingTop: 240, paddingBottom: 240 }, 360, 300);
  assert.ok(360 - clamped.left - clamped.right >= 80 && 300 - clamped.top - clamped.bottom >= 80);
  assert.deepEqual(pageMargins({ paddingX: 60, paddingY: 30 }, 800, 600), { top: 30, bottom: 30, left: 60, right: 60 });
});
test('page click zones leave the center available for reader controls', () => {
  assert.equal(pageClickDirection(10, 800), -1);
  assert.equal(pageClickDirection(400, 800), 0);
  assert.equal(pageClickDirection(790, 800), 1);
});
test('the pointer half of the page picks the soft-page curl corner', () => {
  assert.equal(pageCorner(10, 600), 'top');
  assert.equal(pageCorner(300, 600), 'top');
  assert.equal(pageCorner(301, 600), 'bottom');
  assert.equal(pageCorner(100, 0), 'top');
});
