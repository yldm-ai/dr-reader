# StPageFlip (vendored)

Source: [StPageFlip](https://github.com/Nodlik/StPageFlip) 2.0.7, © 2020 Nodlik, MIT licence (see `LICENSE`).
Taken from the `src/` directory of the `page-flip@2.0.7` npm package. The reader uses it in `web/motion.ts`
for soft and hard page turns.

The flip logic is upstream's: the same geometry, frame path and linear timing. `scripts/bench-flip-pose.ts`
compares 60 drawn poses (single page and spread, soft and hard, both corners and directions) with the npm
package.

## Changes

- **Compositor playback** (`Render.playOnCompositor`, setting `compositorPlayback`, default on). When a
  flip starts, it is drawn exactly as the render loop would draw it, one sample per 60 Hz frame of the
  path, and each element's resulting inline style is read back, including whatever a caller changes after
  `drawFrame` (`Render.track` adds elements outside the book). Values that stay the same become plain
  styles; `transform`, `clip-path` and `opacity` values that change become one Web Animations keyframe
  list per element, with the loop's linear timing and one shared start time. A clip-path animation is
  still advanced by the main thread, so each page's moving cut (its box cut by the fold) is then turned
  into a window: a square turned along the fold, overflow hidden, holding a plane turned back as much,
  with the page's paper and content in the plane (`cutWindows`). Otherwise, while the main thread was
  busy, a cut stood still behind its moving page and the page beneath showed through the gap. The
  compositor plays the flip and the render loop pauses, so a busy main thread no longer drops its frames. Recording takes about
  10–20 ms. After recording the elements hold the landing pose, and draws during playback are skipped, so
  that pose is what shows whenever the animations let go. If another property changes during a flip, it
  plays on the render loop as before.
- **Shadows for the compositor.** Upstream changed shadow widths and gradients every frame. Each shadow now
  keeps upstream's geometry and gradient but has a box one page wide scaled to that width, and its
  gradient on a child whose opacity is the shadow strength (the shadow's own opacity stays free for the
  reader). The soft outer shadow is clipped by a fixed box over its page, and the soft inner shadow rides
  inside the turning sheet instead of having clip-path masks of their own. The inner gradient (strength at
  5% and 35%, a fixed 0.05 at 15%) is split exactly into a fixed layer and the strength-scaled child.
  Drawn poses match the npm package: hard pages pixel for pixel, soft ones in all but ≤0.03% of pixels
  (anti-aliasing at shadow edges).
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
