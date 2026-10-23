import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WheelPaging } from '../web/wheel-paging.ts';
const event = (deltaY, extra = {}) => ({ deltaX: 0, deltaY, deltaMode: 0, ...extra });

test('a smooth swipe ignores a long decaying tail, then rearms after quiet', () => {
  const paging = new WheelPaging();
  const deltas = [2, 9, 24, 64, 120, 98, 77, 52, 38, 22, 12, 8, 5, 3, 1];
  const turns = deltas.map((delta, i) => paging.accept(event(delta), i * 16));
  assert.equal(turns.filter(Boolean).length, 1);
  assert.equal(paging.accept(event(32), 800), 1);
});

test('fast quantized pixel events are one gesture rather than dozens of notches', () => {
  const paging = new WheelPaging();
  const turns = Array.from({ length: 120 }, (_, i) => paging.accept(event(120), i * 8));
  assert.equal(turns.filter(Boolean).length, 1);
});

test('ordinary pixel wheel notches and line/page wheels stay discrete', () => {
  const pixels = new WheelPaging();
  assert.deepEqual([0, 80, 160, 240].map(now => pixels.accept(event(100), now)), [1, 1, 1, 1]);
  const lines = new WheelPaging();
  assert.deepEqual([1, 3, -1, 20].map((delta, i) => lines.accept(event(delta, { deltaMode: 1 }), i * 8)), [1, 1, -1, 1]);
  assert.equal(lines.accept(event(-1, { deltaMode: 2 }), 40), -1);
});

test('small touchpad jitter does not turn a page; a deliberate reversal can turn back', () => {
  const paging = new WheelPaging();
  assert.deepEqual([1, 2, 3, 4].map((delta, i) => paging.accept(event(delta), i * 16)), [0, 0, 0, 0]);
  assert.equal(paging.accept(event(32), 80), 1);
  assert.equal(paging.accept(event(-2), 96), 0);
  assert.equal(paging.accept(event(-30), 112), -1);
});

test('horizontal gestures work and explicit momentum never turns a page', () => {
  const paging = new WheelPaging();
  assert.equal(paging.accept(event(2, { deltaX: -40 }), 0), -1);
  assert.equal(paging.accept(event(100, { momentum: true }), 16), 0);
  assert.equal(paging.accept(event(60), 32), 0);
  assert.equal(paging.accept(event(0), 48), 0);
});
