import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fontChoices, fontStack } from '../web/fonts.ts';
import { ChapterCache } from '../web/chapter-cache.ts';
import { sameReading } from '../web/settings-state.ts';
import { pageMargins, pageClickDirection, pageCorner } from '../web/reading-layout.ts';

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
