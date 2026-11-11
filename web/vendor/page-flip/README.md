# StPageFlip (vendored)

Source: [StPageFlip](https://github.com/Nodlik/StPageFlip) 2.0.7, © 2020 Nodlik, MIT licence (see `LICENSE`).
Taken from the `src/` directory of the `page-flip@2.0.7` npm package. The reader uses it in `web/motion.ts`
for soft and hard page turns.

The flip logic is upstream's: the same geometry, frame timing, page and shadow styles. Drawn poses are
pixel-identical to the npm package (`scripts/bench-flip-pose.ts` compares 60 poses: single page and spread,
soft and hard, both corners and directions).

## Changes

- **Unchanged styles are not reassigned.** Every frame, upstream assigns each page's and shadow's complete
  `cssText`, also for every resting page and hidden shadow whose text is identical to the last frame's.
  `Render/Style.ts` skips an assignment equal to the previous one for that element. What is on screen does
  not change; the measured saving is small (about 5% less main-thread time per turn with the CPU slowed
  4×), since the turning pages and shadows still change every frame.
- **The render loop can stop.** `Render.stop()` cancels the loop, and `PageFlip.destroy()` calls it and also
  removes the UI handlers (previously a pnpm patch on the bundled build). Stopping from the end-of-flip
  callback keeps the landing pose as the last frame: upstream drew the book's resting spread in the same
  call, which after a reversed single-page flip is the page being left. The loop also requests its next
  frame even when a frame throws; upstream requested it after drawing, so one failed frame (degenerate
  geometry at the page edge) stopped the book and froze a turn mid-flight.
- **Shadow start points.** `Flip.do` skips the shadow when the fold has no start point, where upstream
  passed `null` on and failed while drawing.
- **TypeScript.** Converted to the project's settings: `const enum` became `as const` objects, strict null
  checks, `.ts` import paths and type-only imports; `Flip.do` is public (the reader drives custom paths).
- **Not included:** the canvas renderer and image pages.

## Related

- The grayscale-to-ClearType change of the text as a turn lands is handled in `web/motion.ts`, which fades
  the landed sheet into the live page.
- `scripts/bench-page-turn.ts` measures frames and main-thread, raster and GPU time while a sheet moves.
