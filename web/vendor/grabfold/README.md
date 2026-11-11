# grabfold (vendored geometry)

Source: [grabfold](https://github.com/javocsoft/grabfold) 0.1.0 (commit 8035f0d), © 2026 JavocSoft, MIT
licence (see `LICENSE`).

Only `src/geometry.ts` is vendored, unchanged apart from a source header: the fold's crease, the
uncovered and folded parts of the sheet, the folded face's placement, and the roll and cast shading
strips. The reader does not use grabfold's book, gestures, sounds or WebGL renderer.

How the reader uses it:

- `web/fold-turn.ts` follows grabfold's `FoldingSheet.draw` (`src/sheet.ts`) and its settle loop
  (`src/book.ts`), with a sine ease-in-out instead of its cubic ease-out (which made click and wheel turns feel hurried), a corner turn's tilt rising and running out as the sheet lands, and an edge turn taking the sheet by the middle of its edge as grabfold's own code-run turns do, sampled once per 60 Hz frame into
  Web Animations keyframes of `transform`, `clip-path` and `opacity`. The shading bands keep their
  full-depth gradient and are scaled and faded by the fold depth, which composes to grabfold's
  per-frame gradients. Polygons use fixed vertex slots so neighbouring keyframes interpolate.
- `web/motion.ts` (`foldPage`) puts EPUB page snapshots on the sheet's faces.
- `web/book-opening.ts` (`openBoard`) swings a hard cover open about the spine, following grabfold's
  `RigidSheet` (`src/board.ts`: perspective six page widths away, faces darkening edge-on, a cast shadow
  while the board is over its own page) and its closed-book centring (`src/physics.ts` closedShift).
