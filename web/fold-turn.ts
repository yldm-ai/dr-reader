/**
 * grabfold's page fold (https://github.com/javocsoft/grabfold, MIT), played as Web Animations.
 *
 * The geometry is grabfold's own (`web/vendor/grabfold/geometry.ts`): the crease is the
 * perpendicular bisector between where the sheet was taken and where it is now, the part beyond
 * it is the sheet's other face carried over by a reflection, and the shading is a roll band on the
 * folded face plus a shadow the standing fold casts on the uncovered page. grabfold draws each
 * frame from requestAnimationFrame (`book.ts` settle, `sheet.ts` FoldingSheet.draw). Here the same
 * frames are sampled once per 60 Hz frame of the turn and handed to the browser as keyframes.
 *
 * Only `transform` and `opacity` are animated. grabfold cuts the uncovered page and the folded face
 * with `clip-path`; animated here, that clip ran on a different clock from the folded face's
 * transform, so whenever the main thread was busy (as it is when a turn starts) the face was drawn a
 * few frames away from its cut: on the wrong side of the crease, over the destination, letting the
 * page being turned show through. Instead each cut is a window: a box whose edge is the crease,
 * turned with it, with overflow hidden, holding a plane that turns back by exactly the same amount,
 * so what is inside stays put (`half` and `plane` keyframes). Each pair is written as the same
 * transform functions with negated values in reverse order; the browser interpolates each function
 * on its own, so between keyframes too the plane undoes the window exactly.
 *
 * grabfold changes its bands' widths and gradient alphas every frame. Both scale linearly with the
 * fold's depth, so each band keeps the gradient it has at full depth and is scaled across and faded
 * by the depth instead, which composes to the same pixels.
 */
import { clipHalfPlane, foldDepth, foldGeometry, type Point, type Strip } from './vendor/grabfold/geometry.ts';

/** grabfold's defaults (`book.ts` DEFAULTS): crease shadow strength and folded-face lift. */
export const FOLD_SHADOW = .4;
/** Lift of the folded face towards white, at the height of the turn (grabfold: 45% of `--grabfold-lift`). */
export const FOLD_LIFT = .18;
/** grabfold geometry.ts: shading reach as a share of the page width, and the roll's share of it. */
const SHADOW_SPAN = .42, ROLL_SHARE = .75;
/**
 * How far (CSS px) the uncovered page reaches under the folded face. They meet at the crease, each
 * with an anti-aliased edge; their coverage there added up to less than one and the page beneath
 * showed through as a hairline shimmering along the crease.
 */
export const SEAM = 1.5;
/**
 * The pace of a turn. grabfold settles a released drag with a cubic ease-out (model.ts easeOut),
 * which starts at three times the average speed: right for a page already moving under the hand,
 * but a turn started from a click or the wheel shot off and read as hurried. A sine ease-in-out
 * lifts the page gently, peaks at half that speed mid-turn and lays it down as gently.
 */
export const turnPace = (t: number) => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, t)))) / 2;
/** A code-run grabfold turn takes the sheet by the middle of its edge; a corner turn by the corner. */
const GRAB = .1, TILT = .08;

export interface FoldPlan {
  /** Page cell, in overlay pixels. */
  width: number; height: number;
  /** A two-page spread (true) turns one half over the spine; a single page folds off its left edge. */
  spread: boolean;
  forward: boolean;
  corner: 'top' | 'bottom';
  /**
   * Taken by the middle of the free edge instead of a corner: the crease stays upright and the
   * whole edge comes over at once (grabfold's turn run from code, without a pointer).
   */
  edge?: boolean;
  duration: number;
}

/** One frame of the fold, in the coordinates of the page cell the sheet lies on. */
export interface FoldSample {
  progress: number; depth: number;
  /** A point on the crease, and the direction (radians) of its normal, away from the uncovered page. */
  through: Point; angle: number;
  /** How far the uncovered page reaches past the crease, under the folded face. */
  overlap: number;
  /** Puts the folded face (its own top-left at 0 0) where the fold carries it. */
  place: { x: number; y: number; angle: number };
  roll: Strip; cast: Strip;
  /** The uncovered part of the cell and of the folded face, for tests. */
  uncovered: Point[]; flap: Point[];
}

export interface FoldFrames {
  /** The cell the sheet lies on, from the overlay's left edge. */
  left: number;
  /** Single page backwards: the sheet arrives over the page on show, from the spine, and lands flat. */
  arriving: boolean;
  /** Side of the square windows (CSS px): long enough to outrun the cell however the crease turns. */
  reach: number;
  /** Window onto the uncovered page (crease on its right edge), and the plane inside it. */
  uncoveredHalf: Keyframe[]; uncoveredPlane: Keyframe[];
  /** Window onto the folded face's side of the crease (crease on its left edge), and its plane. */
  flapHalf: Keyframe[]; flapPlane: Keyframe[];
  /** The folded face, placed in the cell's coordinates. */
  flap: Keyframe[];
  /** Roll band on the folded face (its coordinates); the cast shadow, fixed along the crease. */
  roll: Keyframe[]; cast: Keyframe[];
  /** Lightening of a blank folded face (its depth). */
  lift: Keyframe[];
  /** Band sizes at full depth, and grabfold's gradients at full depth. */
  rollSpan: number; castSpan: number;
  rollGradient: string; castGradient: string;
  samples: FoldSample[];
}

const px = (value: number) => `${value.toFixed(3)}px`;
const rad = (value: number) => `${value.toFixed(6)}rad`;

/** Lays a band along a strip (grabfold sheet.ts placeBand), scaled across by the depth. */
const band = (strip: Strip, depth: number) =>
  `translate(${px(strip.x)}, ${px(strip.y)}) rotate(${rad(strip.angle)}) translateX(${-2 * SEAM}px) ` +
  `scaleX(${Math.max(depth, 1e-4).toFixed(4)})`;

export function foldSamples(plan: FoldPlan): FoldSample[] {
  const { width, height, spread, forward, corner } = plan;
  // A single page is bound on its left; a spread turns its right page forward, its left back.
  const spine = !spread || forward ? 'left' : 'right';
  const arriving = !spread && !forward;
  const bottom = corner === 'bottom';
  const grabY = plan.edge ? height / 2 : height * (bottom ? 1 - GRAB : GRAB);
  // Taken by the corner and carried a little towards the middle, as a hand does. grabfold's code-run
  // turns are upright; a released drag keeps its tilt and lets it run out as the sheet lands. Here it
  // grows from nothing as well: at the start the sheet has barely moved, and any tilt would fold a
  // whole corner over in the first frame.
  const tilt = plan.edge ? 0 : height * TILT * (bottom ? -1 : 1);
  const count = Math.max(2, Math.round(plan.duration / (1000 / 60)) + 1);
  const cell = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
  const samples: FoldSample[] = [];
  for (let index = 0; index < count; index++) {
    const eased = turnPace(index / (count - 1));
    const progress = arriving ? 1 - eased : eased;
    const fold = foldGeometry({ spine, width, height, progress, grabY, lift: tilt * Math.sin(Math.PI * eased) });
    const depth = foldDepth(progress);
    const { through, normal } = fold.crease;
    // The normal turns continuously; atan2 jumps by a full turn at ±π, which an interpolated rotate
    // would sweep through.
    let angle = Math.atan2(normal.y, normal.x);
    const previous = samples.at(-1)?.angle;
    if (previous !== undefined) angle += 2 * Math.PI * Math.round((previous - angle) / (2 * Math.PI));
    const side = (point: Point) => (point.x - through.x) * normal.x + (point.y - through.y) * normal.y;
    const overlap = SEAM * Math.min(1, depth * 4);
    samples.push({ progress, depth, through, angle, overlap, place: fold.place, roll: fold.roll, cast: fold.cast,
      uncovered: clipHalfPlane(cell, point => overlap - side(point)),
      flap: clipHalfPlane(cell, point => -side(point)).map(point => ({ x: width - point.x, y: point.y })) });
  }
  return samples;
}

export function foldFrames(plan: FoldPlan): FoldFrames {
  const { width, height, spread, forward } = plan;
  const samples = foldSamples(plan);
  const reach = 2 * Math.hypot(width, height);
  const frames: FoldFrames = { left: spread && forward ? width : 0, arriving: !spread && !forward, reach,
    uncoveredHalf: [], uncoveredPlane: [], flapHalf: [], flapPlane: [], flap: [], roll: [], cast: [], lift: [],
    rollSpan: SHADOW_SPAN * ROLL_SHARE * width, castSpan: SHADOW_SPAN * width,
    rollGradient: `linear-gradient(to right, rgba(0,0,0,${FOLD_SHADOW}) 0%, rgba(0,0,0,${(FOLD_SHADOW * .62).toFixed(3)}) 7%, ` +
      `rgba(255,255,255,.2) 18%, rgba(0,0,0,${(FOLD_SHADOW * .4).toFixed(3)}) 40%, rgba(0,0,0,0) 100%)`,
    castGradient: `linear-gradient(to left, rgba(0,0,0,${FOLD_SHADOW}), rgba(0,0,0,0))`, samples };
  for (const sample of samples) {
    const { through: { x, y }, angle, overlap, depth } = sample;
    // A window `reach` square, turned so its x runs along the normal. Uncovered: the crease is its
    // right edge, moved `overlap` past the crease; folded face: the crease is its left edge.
    frames.uncoveredHalf.push({ transform: `translate(${px(x)}, ${px(y)}) rotate(${rad(angle)}) translate(${px(overlap - reach)}, ${px(-reach / 2)})` });
    frames.uncoveredPlane.push({ transform: `translate(${px(reach - overlap)}, ${px(reach / 2)}) rotate(${rad(-angle)}) translate(${px(-x)}, ${px(-y)})` });
    frames.flapHalf.push({ transform: `translate(${px(x)}, ${px(y)}) rotate(${rad(angle)}) translate(0px, ${px(-reach / 2)})` });
    frames.flapPlane.push({ transform: `translate(0px, ${px(reach / 2)}) rotate(${rad(-angle)}) translate(${px(-x)}, ${px(-y)})` });
    frames.flap.push({ transform: `translate(${px(sample.place.x)}, ${px(sample.place.y)}) rotate(${rad(sample.place.angle)})` });
    frames.roll.push({ transform: band(sample.roll, depth), opacity: depth.toFixed(4) });
    // The cast shadow lies along the crease on the uncovered side: fixed in its window, at its edge.
    frames.cast.push({ transform: `scaleX(${Math.max(depth, 1e-4).toFixed(4)})`, opacity: depth.toFixed(4) });
    frames.lift.push({ opacity: (FOLD_LIFT * depth).toFixed(4) });
  }
  return frames;
}
