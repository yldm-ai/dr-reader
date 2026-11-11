/**
 * grabfold's page fold (https://github.com/javocsoft/grabfold, MIT), played as Web Animations.
 *
 * The geometry is grabfold's own (`web/vendor/grabfold/geometry.ts`): the crease is the
 * perpendicular bisector between where the sheet was taken and where it is now, the part beyond
 * it is the sheet's other face carried over by a reflection, and the shading is a roll band on the
 * folded face plus a shadow the standing fold casts on the uncovered page. grabfold draws each
 * frame from requestAnimationFrame (`book.ts` settle, `sheet.ts` FoldingSheet.draw). Here the same
 * frames are sampled once per 60 Hz frame of the turn and handed to the browser as keyframes of
 * `transform`, `clip-path` and `opacity` only, so the turn needs no script while it plays.
 *
 * grabfold changes its bands' widths and gradient alphas every frame. Both scale linearly with the
 * fold's depth, so each band keeps the gradient it has at full depth and is scaled across and faded
 * by the depth instead, which composes to the same pixels.
 */
import { foldDepth, foldGeometry, type Point, type Strip } from './vendor/grabfold/geometry.ts';

/** grabfold's defaults (`book.ts` DEFAULTS): crease shadow strength and folded-face lift. */
export const FOLD_SHADOW = .4;
/** Lift of the folded face towards white, at the height of the turn (grabfold: 45% of `--grabfold-lift`). */
export const FOLD_LIFT = .18;
/** grabfold geometry.ts: shading reach as a share of the page width, and the roll's share of it. */
const SHADOW_SPAN = .42, ROLL_SHARE = .75;
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

export interface FoldFrames {
  /** The cell the sheet lies on, from the overlay's left edge. */
  left: number;
  /** Single page backwards: the sheet arrives over the page on show, from the spine, and lands flat. */
  arriving: boolean;
  /** Clip of the page uncovered by the fold, and of the shadow cast on it (overlay coordinates). */
  uncovered: Keyframe[];
  /** The folded face: placed by a transform, clipped in its own coordinates. */
  flap: Keyframe[];
  /** Roll band on the folded face (its coordinates), and the shadow band on the uncovered page (overlay). */
  roll: Keyframe[];
  cast: Keyframe[];
  /** Lightening of a blank folded face (its depth). */
  lift: Keyframe[];
  /** Band sizes at full depth. */
  rollSpan: number; castSpan: number; reach: number;
  /** grabfold's gradients at full depth. */
  rollGradient: string; castGradient: string;
}

const px = (value: number) => `${value.toFixed(2)}px`;

/**
 * The part of the page rectangle on the non-negative side of a line (`side` is linear), as eight
 * vertices in fixed slots: corner i, then the point of edge i nearest to where the line meets it.
 * grabfold's clipHalfPlane returns three to five vertices whose positions in the list shift as
 * corners cross the crease; interpolating such lists between two keyframes pairs unrelated
 * vertices and cuts across the page. Here a slot off the kept side is projected onto the crease
 * (within the page), so it reaches the crease at the moment its corner does, and whenever a slot
 * changes place between two keyframes it slides along a straight edge of the region: every
 * in-between shape is a real fold.
 */
export function slottedClip(width: number, height: number, side: (point: Point) => number): Point[] {
  const corners = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
  const base = side({ x: 0, y: 0 });
  const normal = { x: side({ x: 1, y: 0 }) - base, y: side({ x: 0, y: 1 }) - base };
  const square = normal.x ** 2 + normal.y ** 2;
  const values = corners.map(side);
  const crossings: Point[] = [];
  const slots: Point[] = [];
  corners.forEach((from, index) => {
    const to = corners[(index + 1) % 4], here = values[index], there = values[(index + 1) % 4];
    // Where the line meets this edge's line, held to the edge.
    const at = here === there ? 0 : Math.min(1, Math.max(0, here / (here - there)));
    const point = { x: from.x + (to.x - from.x) * at, y: from.y + (to.y - from.y) * at };
    if (here >= 0 !== there >= 0) crossings.push(point);
    slots.push(from, point);
  });
  const [start, end] = crossings;
  return slots.map(point => {
    const value = side(point);
    if (value >= 0 || !square) return point;
    // Onto the crease, and along it no further than the page.
    const foot = { x: point.x - value * normal.x / square, y: point.y - value * normal.y / square };
    if (!start || !end) return foot;
    const dx = end.x - start.x, dy = end.y - start.y, length = dx * dx + dy * dy;
    const t = length ? Math.min(1, Math.max(0, ((foot.x - start.x) * dx + (foot.y - start.y) * dy) / length)) : 0;
    return { x: start.x + dx * t, y: start.y + dy * t };
  });
}

const polygon = (points: readonly Point[], offset = 0) =>
  `polygon(${points.map(point => `${px(point.x + offset)} ${px(point.y)}`).join(', ')})`;

/** Lays a band along a strip (grabfold sheet.ts placeBand), scaled across by the depth. */
const band = (strip: Strip, depth: number) =>
  `translate(${px(strip.x)}, ${px(strip.y)}) rotate(${strip.angle.toFixed(4)}rad) scaleX(${Math.max(depth, 1e-4).toFixed(4)})`;

export function foldFrames(plan: FoldPlan): FoldFrames {
  const { width, height, spread, forward, corner } = plan;
  // A single page is bound on its left; a spread turns its right page forward, its left back.
  const spine = !spread || forward ? 'left' : 'right';
  const arriving = !spread && !forward;
  const left = spread && forward ? width : 0;
  const bottom = corner === 'bottom';
  const grabY = plan.edge ? height / 2 : height * (bottom ? 1 - GRAB : GRAB);
  // Taken by the corner and carried a little towards the middle, as a hand does. grabfold's code-run
  // turns are upright; a released drag keeps its tilt and lets it run out as the sheet lands. Here it
  // grows from nothing as well: at the start the sheet has barely moved, and any tilt would fold a
  // whole corner over in the first frame.
  const tilt = plan.edge ? 0 : height * TILT * (bottom ? -1 : 1);
  const count = Math.max(2, Math.round(plan.duration / (1000 / 60)) + 1);
  const frames: FoldFrames = { left, arriving, uncovered: [], flap: [], roll: [], cast: [], lift: [],
    rollSpan: SHADOW_SPAN * ROLL_SHARE * width, castSpan: SHADOW_SPAN * width, reach: 2 * Math.hypot(width, height),
    rollGradient: `linear-gradient(to right, rgba(0,0,0,${FOLD_SHADOW}) 0%, rgba(0,0,0,${(FOLD_SHADOW * .62).toFixed(3)}) 7%, ` +
      `rgba(255,255,255,.2) 18%, rgba(0,0,0,${(FOLD_SHADOW * .4).toFixed(3)}) 40%, rgba(0,0,0,0) 100%)`,
    castGradient: `linear-gradient(to right, rgba(0,0,0,${FOLD_SHADOW}), rgba(0,0,0,0))` };
  for (let index = 0; index < count; index++) {
    const eased = turnPace(index / (count - 1));
    const progress = arriving ? 1 - eased : eased;
    const fold = foldGeometry({ spine, width, height, progress, grabY, lift: tilt * Math.sin(Math.PI * eased) });
    const depth = foldDepth(progress);
    const { through, normal } = fold.crease;
    const uncovered = slottedClip(width, height, point => -((point.x - through.x) * normal.x + (point.y - through.y) * normal.y));
    const flap = uncovered.map(point => ({ x: width - point.x, y: point.y }));
    frames.uncovered.push({ clipPath: polygon(uncovered, left) });
    frames.flap.push({ clipPath: polygon(flap),
      transform: `translate(${px(fold.place.x)}, ${px(fold.place.y)}) rotate(${fold.place.angle.toFixed(4)}rad)` });
    frames.roll.push({ transform: band(fold.roll, depth), opacity: depth.toFixed(4) });
    frames.cast.push({ transform: `translate(${px(left)}, 0) ${band(fold.cast, depth)}`, opacity: depth.toFixed(4) });
    frames.lift.push({ opacity: (FOLD_LIFT * depth).toFixed(4) });
  }
  return frames;
}
