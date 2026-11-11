import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldFrames, foldSamples, SEAM } from '../web/fold-turn.ts';
import { settle } from '../web/motion.ts';

type Point = { x: number; y: number };
/** Shoelace area of a polygon. */
const area = (polygon: Point[]) => Math.abs(polygon.reduce((sum, point, index) => {
  const next = polygon[(index + 1) % polygon.length];
  return sum + point.x * next.y - next.x * point.y;
}, 0)) / 2;
const width = 600, height = 800;

/** A CSS transform list of translate/rotate/scaleX functions, as a matrix [a b c d e f]. */
function matrix(transform: string) {
  let m = [1, 0, 0, 1, 0, 0];
  const multiply = (n: number[]) => {
    m = [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  };
  for (const [, name, args] of transform.matchAll(/(\w+)\(([^)]*)\)/g)) {
    const values = args.split(',').map(value => parseFloat(value));
    if (name === 'translate') multiply([1, 0, 0, 1, values[0], values[1] ?? 0]);
    else if (name === 'translateX') multiply([1, 0, 0, 1, values[0], 0]);
    else if (name === 'rotate') multiply([Math.cos(values[0]), Math.sin(values[0]), -Math.sin(values[0]), Math.cos(values[0]), 0, 0]);
    else if (name === 'scaleX') multiply([values[0], 0, 0, 1, 0, 0]);
    else throw Error(name);
  }
  return m;
}
/** The transform a browser shows half way between two keyframes: each function's numbers half way. */
const between = (a: string, b: string) => {
  const numbers = b.match(/-?[\d.]+(?:e-?\d+)?/g)!.map(Number);
  let index = 0;
  return a.replace(/-?[\d.]+(?:e-?\d+)?/g, value => String((Number(value) + numbers[index++]) / 2));
};

test('a fold uncovers the destination from nothing to the whole page, or covers the page on show', () => {
  for (const corner of ['top', 'bottom'] as const) {
    const forward = foldSamples({ width, height, spread: false, forward: true, corner, duration: 800 });
    assert.ok(area(forward[0].uncovered) < width * 2, 'forward starts with the page on show');
    assert.ok(Math.abs(area(forward.at(-1)!.uncovered) - width * height) < 1, 'forward lands on the new page');
    const back = foldSamples({ width, height, spread: false, forward: false, corner, duration: 800 });
    assert.ok(Math.abs(area(back[0].uncovered) - width * height) < 1, 'backward starts with the page on show');
    assert.ok(area(back.at(-1)!.uncovered) < width * 2, 'backward lands on the previous page');
  }
});

test('a spread turns the right half forward and the left half back, landing square on the facing page', () => {
  const forward = foldFrames({ width, height, spread: true, forward: true, corner: 'top', duration: 800 });
  assert.equal(forward.left, width);
  const landed = matrix(String(forward.flap.at(-1)!.transform));
  assert.ok(Math.abs(landed[4] + width) < .5 && Math.abs(landed[5]) < .5 && Math.abs(landed[1]) < 1e-3 && landed[0] > 0);
  const back = foldFrames({ width, height, spread: true, forward: false, corner: 'bottom', duration: 800 });
  assert.equal(back.left, 0);
  const flap = matrix(String(back.flap.at(-1)!.transform));
  assert.ok(Math.abs(flap[4] - width) < .5 && Math.abs(flap[5]) < .5);
});

test('every window is undone by its plane, at each keyframe and between keyframes', () => {
  for (const spread of [false, true]) for (const forward of [false, true]) for (const corner of ['top', 'bottom'] as const) {
    const frames = foldFrames({ width, height, spread, forward, corner, duration: 600 });
    for (const [halves, planes] of [[frames.uncoveredHalf, frames.uncoveredPlane], [frames.flapHalf, frames.flapPlane]]) {
      for (let index = 0; index < halves.length; index++) {
        const pairs = [[String(halves[index].transform), String(planes[index].transform)]];
        if (index) pairs.push([between(String(halves[index - 1].transform), String(halves[index].transform)),
          between(String(planes[index - 1].transform), String(planes[index].transform))]);
        for (const [half, plane] of pairs) {
          const m = matrix(`${half} ${plane}`);
          assert.ok(Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6 && Math.abs(m[4]) < 1e-3 && Math.abs(m[5]) < 1e-3,
            `window ${index} does not cancel: ${m.map(v => v.toFixed(4))}`);
        }
      }
    }
    // A rotation never sweeps through a full turn between neighbouring frames.
    const angles = frames.samples.map(sample => sample.angle);
    assert.ok(angles.slice(1).every((angle, index) => Math.abs(angle - angles[index]) < .3));
  }
});

test('the windows cut the page at the crease, the uncovered one reaching just under the folded face', () => {
  const frames = foldFrames({ width, height, spread: false, forward: true, corner: 'top', edge: true, duration: 1000 });
  const sample = frames.samples[30];
  // In the uncovered window, x runs along the crease normal; its right edge lies `overlap` past the crease.
  const m = matrix(String(frames.uncoveredHalf[30].transform));
  const rightEdge = { x: m[0] * frames.reach + m[4], y: m[1] * frames.reach + m[5] };
  const normal = { x: Math.cos(sample.angle), y: Math.sin(sample.angle) };
  const past = (rightEdge.x - sample.through.x) * normal.x + (rightEdge.y - sample.through.y) * normal.y;
  assert.ok(Math.abs(past - SEAM) < 1e-2, `uncovered window ends ${past} past the crease`);
  const flap = matrix(String(frames.flapHalf[30].transform));
  const leftEdge = { x: flap[4], y: flap[5] };
  assert.ok(Math.abs((leftEdge.x - sample.through.x) * normal.x + (leftEdge.y - sample.through.y) * normal.y) < 1e-2);
  // At the ends of the turn there is nothing to reach under.
  assert.equal(frames.samples[0].overlap, 0);
});

test('an edge turn brings the whole free edge over with an upright crease', () => {
  for (const spread of [false, true]) for (const forward of [false, true]) {
    for (const sample of foldSamples({ width, height, spread, forward, corner: 'bottom', edge: true, duration: 800 })) {
      assert.ok(Math.abs(Math.sin(sample.angle)) < 1e-6, `tilted by ${sample.angle}`);
      assert.ok(Math.abs(Math.sin(sample.place.angle)) < 1e-6);
    }
  }
});

test('a fold starts and lands gently', () => {
  const samples = foldSamples({ width, height, spread: true, forward: true, corner: 'top', edge: true, duration: 1000 });
  const steps = samples.slice(1).map((sample, index) => Math.abs(sample.through.x - samples[index].through.x));
  const average = width / steps.length;
  // A sine ease-in-out peaks at pi/2 times the average speed; the cubic ease-out started at 3 times.
  assert.ok(Math.max(...steps) < average * 1.65, `fastest frame ${Math.max(...steps).toFixed(1)}px against ${average.toFixed(1)}px`);
  assert.ok(steps[0] < average * .1 && steps.at(-1)! < average * .1, 'the first and last frames barely move');
});

test('a StPageFlip turn keeps its pace and then slows to rest on the page', () => {
  const frames = Array.from({ length: 401 }, (_, index) => index);
  const { frames: eased, time } = settle(frames, 800);
  assert.equal(time, 800 * 1.22);
  assert.equal(eased[0], 0);
  assert.equal(eased.at(-1), 400);
  const steps = eased.slice(1).map((frame, index) => frame - eased[index]);
  // The middle runs at the library's pace (one frame per frame), never backwards, and the last
  // steps barely move.
  assert.ok(steps.every(step => step >= 0 && step <= 2));
  assert.ok(steps.slice(0, 300).every(step => step === 1));
  assert.ok(steps.slice(-20).reduce((sum, step) => sum + step, 0) <= 3);
});
