import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tocAnchor, tocSelectionIndex } from '../web/toc-selection.ts';
const toc = [
  { href: 'book.html', depth: 0 },
  { href: 'book.html', depth: 1 },
  { href: 'book.html#first', depth: 2 },
  { href: 'book.html#second', depth: 2 },
  { href: 'book.html#third', depth: 2 },
  { href: 'other.html', depth: 1 },
];

test('shared XHTML paths select exactly the requested anchor', () => {
  assert.equal(tocSelectionIndex(toc, 'book.html', { anchor: 'second' }), 3);
  assert.equal(tocSelectionIndex(toc, 'book.html', { anchor: 'third' }), 4);
});

test('identical parent/child targets prefer the innermost title', () => {
  assert.equal(tocSelectionIndex(toc, 'book.html'), 1);
  assert.equal(tocSelectionIndex([...toc, { href: 'book.html#second', depth: 3 }], 'book.html', { anchor: 'second' }), 6);
});

test('reading position follows the last reached heading, including backward movement', () => {
  const positions = new Map([[0, -Infinity], [1, -Infinity], [2, 50], [3, 800], [4, 1600]]);
  assert.equal(tocSelectionIndex(toc, 'book.html', { positions, offset: 1000 }), 3);
  assert.equal(tocSelectionIndex(toc, 'book.html', { positions, offset: 1700 }), 4);
  assert.equal(tocSelectionIndex(toc, 'book.html', { positions, offset: 500 }), 2);
  assert.equal(tocSelectionIndex(toc, 'book.html', { positions, offset: 0 }), 1);
});

test('encoded anchors, missing targets and unrelated documents stay deterministic', () => {
  assert.equal(tocAnchor('book.html#%E7%AC%AC%E4%B8%80%E7%AB%A0'), '第一章');
  assert.equal(tocAnchor('book.html#bad%escape'), 'bad%escape');
  assert.equal(tocSelectionIndex(toc, 'missing.html'), -1);
  assert.equal(tocSelectionIndex(toc, 'book.html', { anchor: 'missing' }), 1);
  assert.equal(tocSelectionIndex(toc, 'other.html'), 5);
});
