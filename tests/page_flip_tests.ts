import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FlipCalculation } from '../web/vendor/page-flip/Flip/FlipCalculation.ts';
import { FlipCorner, FlipDirection } from '../web/vendor/page-flip/Flip/Flip.ts';

// A spread of odd width (a pinned sidebar dragged to another width) has half-pixel pages. The fold
// must be computed for the page that is drawn and cropped; cut to whole pixels, a turn near the
// spine showed a stale curl of the old page for one frame.
test('fold geometry keeps a half-pixel page width', () => {
  const pageWidth = 595.5, height = 885, margin = height / 10, inset = .1;
  for (const corner of [FlipCorner.TOP, FlipCorner.BOTTOM]) {
    const calc = new FlipCalculation(FlipDirection.FORWARD, corner, String(pageWidth), String(height));
    // motion.ts's soft-spread path: from near the outer corner to just inside the far edge.
    for (let i = 0; i <= 50; i++) {
      const t = i / 50, edge = margin + (inset - margin) * t;
      const x = pageWidth - margin + (inset - 2 * pageWidth + margin) * t;
      assert.ok(calc.calc({ x, y: corner === FlipCorner.BOTTOM ? height - edge : edge }), `frame ${i} fails`);
      const right = Math.max(...calc.getBottomClipArea().filter(point => point !== null).map(point => point.x));
      assert.ok(Math.abs(right - pageWidth) < 1e-6,
        `${corner} frame ${i}: the page beneath must span the whole drawn page (${right})`);
    }
    assert.ok(calc.getFlippingProgress() > 99.9 && calc.getFlippingProgress() <= 100, 'the turn lands at the spine');
  }
  const back = new FlipCalculation(FlipDirection.BACK, FlipCorner.TOP, String(pageWidth), String(height));
  assert.deepEqual(back.getBottomPagePosition(), { x: pageWidth, y: 0 });
});
