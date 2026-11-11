import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldFrames, slottedClip } from '../web/fold-turn.ts';

type Point = { x: number; y: number };
const points = (clip: unknown): Point[] => String(clip).replace(/^polygon\(|\)$/g, '').split(', ')
  .map(pair => { const [x, y] = pair.split(' ').map(value => parseFloat(value)); return { x, y }; });
/** Shoelace area of a polygon. */
const area = (polygon: Point[]) => Math.abs(polygon.reduce((sum, point, index) => {
  const next = polygon[(index + 1) % polygon.length];
  return sum + point.x * next.y - next.x * point.y;
}, 0)) / 2;
const width = 600, height = 800;

test('a fold uncovers the destination from nothing to the whole page, or covers the page on show', () => {
  for (const corner of ['top', 'bottom'] as const) {
    const forward = foldFrames({ width, height, spread: false, forward: true, corner, duration: 800 });
    assert.ok(area(points(forward.uncovered[0].clipPath)) < width * 2, 'forward starts with the page on show');
    assert.ok(Math.abs(area(points(forward.uncovered.at(-1)!.clipPath)) - width * height) < 1, 'forward lands on the new page');
    const back = foldFrames({ width, height, spread: false, forward: false, corner, duration: 800 });
    assert.equal(back.arriving, true);
    assert.ok(Math.abs(area(points(back.uncovered[0].clipPath)) - width * height) < 1, 'backward starts with the page on show');
    assert.ok(area(points(back.uncovered.at(-1)!.clipPath)) < width * 2, 'backward lands on the previous page');
  }
});

test('a spread turns the right half forward and the left half back, landing square on the facing page', () => {
  const forward = foldFrames({ width, height, spread: true, forward: true, corner: 'top', duration: 800 });
  assert.equal(forward.left, width);
  const xs = points(forward.uncovered.at(-1)!.clipPath).map(point => point.x);
  assert.ok(Math.min(...xs) >= width - .01 && Math.max(...xs) <= 2 * width + .01, 'uncovered page stays on its own half');
  // Landed, the folded face lies exactly over the left cell: translated one page width back, upright.
  const landed = /translate\((\S+)px, (\S+)px\) rotate\((\S+)rad\)/.exec(String(forward.flap.at(-1)!.transform))!;
  assert.ok(Math.abs(Number(landed[1]) + width) < .5 && Math.abs(Number(landed[2])) < .5, landed[0]);
  assert.ok(Math.abs(Math.sin(Number(landed[3]))) < 1e-3 && Math.cos(Number(landed[3])) > 0, landed[0]);
  const back = foldFrames({ width, height, spread: true, forward: false, corner: 'bottom', duration: 800 });
  assert.equal(back.left, 0);
  const flap = /translate\((\S+)px, (\S+)px\)/.exec(String(back.flap.at(-1)!.transform))!;
  assert.ok(Math.abs(Number(flap[1]) - width) < .5 && Math.abs(Number(flap[2])) < .5, flap[0]);
});

test('fold keyframes interpolate into shapes between their neighbours', () => {
  for (const spread of [false, true]) for (const forward of [false, true]) for (const corner of ['top', 'bottom'] as const) {
    const frames = foldFrames({ width, height, spread, forward, corner, duration: 1000 });
    assert.equal(frames.uncovered.length, 61);
    const offset = frames.left;
    for (const list of [frames.uncovered, frames.flap]) {
      for (let index = 1; index < list.length; index++) {
        const before = points(list[index - 1].clipPath), after = points(list[index].clipPath);
        assert.equal(after.length, 8);
        // What the browser draws half way between two keyframes: each vertex half way.
        const middle = after.map((point, slot) => ({ x: (point.x + before[slot].x) / 2, y: (point.y + before[slot].y) / 2 }));
        const low = Math.min(area(before), area(after)), high = Math.max(area(before), area(after));
        const between = area(middle);
        // A vertex pairing across the page would fold the shape over itself and lose area.
        assert.ok(between > low - .02 * width * height && between < high + .02 * width * height,
          `frame ${index}: ${between.toFixed(0)} outside ${low.toFixed(0)}–${high.toFixed(0)}`);
        if (list === frames.uncovered) assert.ok(middle.every(point => point.x > offset - .5 && point.x < offset + width + .5 &&
          point.y > -.5 && point.y < height + .5), `frame ${index} leaves the page`);
      }
    }
    // Shading is off at both ends of the turn.
    assert.equal(Number(frames.roll[0].opacity), 0);
    assert.ok(Number(frames.roll.at(-1)!.opacity) < 1e-3);
  }
});

test('an edge turn brings the whole free edge over with an upright crease', () => {
  for (const spread of [false, true]) for (const forward of [false, true]) {
    const frames = foldFrames({ width, height, spread, forward, corner: 'bottom', edge: true, duration: 800 });
    for (const frame of frames.flap) {
      const angle = Number(/rotate\((\S+)rad\)/.exec(String(frame.transform))![1]);
      // Upright: the folded face is only mirrored across a vertical crease, never turned.
      assert.ok(Math.abs(Math.sin(angle)) < 1e-6, `tilted by ${angle}`);
    }
    for (const frame of frames.uncovered) {
      const xs = points(frame.clipPath).filter(point => point.y > 0 && point.y < height).map(point => point.x);
      assert.equal(xs.length, 0, 'an upright crease meets only the top and bottom edges');
    }
  }
});

test('a turn starts and lands gently', () => {
  const frames = foldFrames({ width, height, spread: true, forward: true, corner: 'top', edge: true, duration: 1000 });
  const crease = frames.uncovered.map(frame => Math.min(...points(frame.clipPath).map(point => point.x)));
  const steps = crease.slice(1).map((x, index) => Math.abs(x - crease[index]));
  const average = width / (steps.length);
  // A sine ease-in-out peaks at pi/2 times the average speed; the cubic ease-out started at 3 times.
  assert.ok(Math.max(...steps) < average * 1.65, `fastest frame ${Math.max(...steps).toFixed(1)}px against ${average.toFixed(1)}px`);
  assert.ok(steps[0] < average * .1 && steps.at(-1)! < average * .1, 'the first and last frames barely move');
});

test('slotted clips match a plain half-plane clip', () => {
  const side = (point: Point) => point.x - .3 * point.y - 200;
  const slots = slottedClip(width, height, side);
  assert.equal(slots.length, 8);
  // Kept: corners (600,0) and (600,800) and the crossings at y=0 (x=200) and y=800 (x=440).
  assert.ok(Math.abs(area(slots) - (600 * 800 - (200 + 440) / 2 * 800)) < 1e-6);
  assert.ok(slots.every(point => side(point) >= -1e-9));
});
