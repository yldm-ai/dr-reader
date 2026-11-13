import assert from 'node:assert/strict';
import test from 'node:test';
import { PAGE_EASING, spring, springEasing } from '../web/page-strip.ts';

test('a page springs from rest to its place without overshoot and lands exactly', () => {
  const duration = 500;
  let last = 0, peak = 0;
  for (let time = 0; time <= duration; time += 5) {
    const { x, velocity } = spring(0, -900, 0, duration, time);
    assert.ok(x <= last + 1e-9 && x >= -900 - 1e-9, `no overshoot at ${time} ms (${x})`);
    last = x;
    peak = Math.max(peak, -velocity);
  }
  assert.equal(spring(0, -900, 0, duration, 0).x, 0);
  assert.ok(Math.abs(spring(0, -900, 0, duration, 0).velocity) < .01, 'a page at rest eases off the mark');
  assert.ok(Math.abs(spring(0, -900, 0, duration, duration).x + 900) < 1e-9, 'it lands on the page');
  // The old ease-out left at 4.5 times the average speed; the spring peaks near 3.
  assert.ok(peak / (900 / duration) < 3.1, `peak speed ${peak / (900 / duration)} times the average`);
});

test('a retargeted page carries on at the speed it had', () => {
  const duration = 500;
  const before = spring(0, -900, 0, duration, 120);
  const after = spring(before.x, -1800, before.velocity, duration, 0);
  assert.ok(Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.velocity - before.velocity) < .01,
    'position and velocity are continuous across a retarget');
  assert.ok(Math.abs(spring(before.x, -1800, before.velocity, duration, duration).x + 1800) < 1e-9);
});

test('the spring reaches the compositor as a CSS linear() easing', () => {
  assert.match(PAGE_EASING, /^linear\(0 0%, .*, 1 100%\)$/);
  // A page sent back while moving away first carries on a little: progress below zero is kept.
  const easing = springEasing(-300, 0, -3, 500);
  assert.ok(easing.split(', ').some(point => Number(point.split(' ')[0]) < 0));
});
