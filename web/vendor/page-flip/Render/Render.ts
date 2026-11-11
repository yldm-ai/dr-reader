import type { PageFlip } from '../PageFlip.ts';
import type { Point, PageRect, RectPoints } from '../BasicTypes.ts';
import { FlipDirection } from '../Flip/Flip.ts';
import { PageOrientation } from '../Page/Page.ts';
import type { Page } from '../Page/Page.ts';
import { SizeType } from '../Settings.ts';
import type { FlipSetting } from '../Settings.ts';

export type FrameAction = () => void;
type AnimationSuccessAction = () => void;

/**
 * Type describing calculated values for drop shadows
 */
export type Shadow = {
    /** Shadow Position Start Point */
    pos: Point;
    /** The angle of the shadows relative to the book */
    angle: number;
    /** Base width shadow */
    width: number;
    /** Base shadow opacity */
    opacity: number;
    /** Flipping Direction, the direction of the shadow gradients */
    direction: FlipDirection;
    /** Flipping progress in percent (0 - 100) */
    progress: number;
};

/**
 * Type describing the animation process
 * Only one animation process can be started at a same time
 */
type AnimationProcess = {
    /** List of frames in playback order. Each frame is a function. */
    frames: FrameAction[];
    /** Total animation duration */
    duration: number;
    /** Animation duration of one frame */
    durationFrame: number;
    /** Сallback at the end of the animation */
    onAnimateEnd: AnimationSuccessAction | null;
    /** Animation start time (Global Timer) */
    startedAt: number;
};

/**
 * Book orientation
 */
export const Orientation = {
    PORTRAIT: 'portrait',
    LANDSCAPE: 'landscape',
} as const;
export type Orientation = (typeof Orientation)[keyof typeof Orientation];

/** dr-reader: the render loop's frame interval at 60 Hz; compositor samples are this far apart. */
const FRAME_INTERVAL = 1000 / 60;
/** dr-reader: properties the compositor animates, with their Web Animations keyframe names. */
const ANIMATED = new Map([
    ['transform', 'transform'],
    ['clip-path', 'clipPath'],
    ['opacity', 'opacity'],
]);

/** An element's inline declarations, as the browser normalises them. */
function readStyle(element: HTMLElement): Map<string, string> {
    const style = new Map<string, string>();
    for (let i = 0; i < element.style.length; i++) {
        const name = element.style[i];
        style.set(name, element.style.getPropertyValue(name));
    }
    return style;
}

/**
 * Gives every polygon in the keyframes the same number of vertices by repeating each polygon's
 * last vertex. False if a clip-path is something other than a polygon or none throughout.
 */
function padPolygons(keyframes: Keyframe[]): boolean {
    const polygons = keyframes.map(keyframe => /^polygon\((.*)\)$/.exec(String(keyframe.clipPath))?.[1].split(/,\s*/));
    if (polygons.some(points => !points)) return false;
    const most = Math.max(...polygons.map(points => points!.length));
    polygons.forEach((points, index) => {
        while (points!.length < most) points!.push(points![points!.length - 1]);
        keyframes[index].clipPath = `polygon(${points!.join(', ')})`;
    });
    return true;
}

/** Shoelace area of a polygon. */
function polygonArea(points: Point[]): number {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) / 2;
}

/** The part of a convex polygon on the side of a line where `side` is not negative. */
function keepSide(polygon: Point[], side: (point: Point) => number): Point[] {
    const kept: Point[] = [];
    for (let i = 0; i < polygon.length; i++) {
        const from = polygon[i], to = polygon[(i + 1) % polygon.length];
        const here = side(from), there = side(to);
        if (here >= 0) kept.push(from);
        if (here >= 0 !== there >= 0) {
            const at = here / (here - there);
            kept.push({ x: from.x + (to.x - from.x) * at, y: from.y + (to.y - from.y) * at });
        }
    }
    return kept;
}

/**
 * dr-reader: an element's moving clip-path, as transform keyframes of a window and a plane.
 *
 * The compositor plays transforms and opacity, but a clip-path animation is advanced by the main
 * thread. While the main thread was busy (a turn starts as the new page is laid out and loaded) the
 * page shells kept moving with their old cuts: the folded face drew away from the page it uncovers,
 * and the page under both showed through the gap as a strip (an illustration in white on a dark page).
 *
 * Every cut a soft flip makes is its page cut by one line, the fold. So each is drawn as a window: a
 * square turned so its x runs along the normal of that line, its left edge on the line, overflow
 * hidden, holding a plane turned back by exactly as much so the page inside stays put. Written as the
 * same transform functions negated in reverse order, the pair cancel between keyframes too.
 *
 * Returns null, and changes nothing, unless every keyframe's polygon is the element's box cut by a
 * line (or the whole box, or nothing of it).
 */
function cutWindows(element: HTMLElement, keyframes: Keyframe[]):
    { window: HTMLElement; plane: HTMLElement; windowFrames: Keyframe[]; planeFrames: Keyframe[] } | null {
    if (!('moveBefore' in Element.prototype)) return null;
    const width = element.offsetWidth, height = element.offsetHeight;
    if (!width || !height) return null;
    const box = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
    const diagonal = Math.hypot(width, height), reach = 4 * diagonal, slack = 1;
    const center = { x: width / 2, y: height / 2 };
    const onBox = (a: Point, b: Point) =>
        (Math.abs(a.x) < slack && Math.abs(b.x) < slack) || (Math.abs(a.x - width) < slack && Math.abs(b.x - width) < slack) ||
        (Math.abs(a.y) < slack && Math.abs(b.y) < slack) || (Math.abs(a.y - height) < slack && Math.abs(b.y - height) < slack);
    const px = (value: number) => `${value.toFixed(3)}px`;
    const windowFrames: Keyframe[] = [], planeFrames: Keyframe[] = [];
    let angle = 0;
    for (const keyframe of keyframes) {
        const body = /^polygon\((.*)\)$/.exec(String(keyframe.clipPath))?.[1];
        if (!body) return null;
        const points = body.split(/,\s*/).map(pair => {
            const [x, y] = pair.trim().split(/\s+/).map(value => /px$/.test(value) || value === '0' ? parseFloat(value) : NaN);
            return { x, y };
        });
        if (points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
        const area = polygonArea(points);
        // The cut is the longest edge that does not run along the box.
        let cut: [Point, Point] | null = null, longest = slack;
        for (let i = 0; i < points.length; i++) {
            const a = points[i], b = points[(i + 1) % points.length];
            const length = Math.hypot(b.x - a.x, b.y - a.y);
            if (length > longest && !onBox(a, b)) { cut = [a, b]; longest = length; }
        }
        let through: Point;
        if (cut) {
            const [a, b] = cut;
            const along = { x: (b.x - a.x) / longest, y: (b.y - a.y) / longest };
            const t = (center.x - a.x) * along.x + (center.y - a.y) * along.y;
            through = { x: a.x + along.x * t, y: a.y + along.y * t };
            // The side the polygon keeps: the one whose cut of the box has the polygon's area. The
            // engine's polygons may double back along an edge, so their vertices do not tell.
            const keeps = (normal: Point) =>
                Math.abs(polygonArea(keepSide(box, point => (point.x - through.x) * normal.x + (point.y - through.y) * normal.y)) - area);
            let normal = { x: -along.y, y: along.x };
            if (keeps({ x: -normal.x, y: -normal.y }) < keeps(normal)) normal = { x: -normal.x, y: -normal.y };
            // It must be the box cut by that line, or the window would show another shape.
            if (keeps(normal) > slack * (width + height)) return null;
            let next = Math.atan2(normal.y, normal.x);
            // A rotate interpolates by its number: never sweep through a full turn between keyframes.
            next += 2 * Math.PI * Math.round((angle - next) / (2 * Math.PI));
            angle = next;
        } else if (Math.abs(area - width * height) < slack * (width + height) || area < slack * (width + height)) {
            // The whole box, or none of it: the line stands a diagonal behind it, or beyond it.
            const normal = { x: Math.cos(angle), y: Math.sin(angle) };
            const sign = area < slack * (width + height) ? 1 : -1;
            through = { x: center.x + sign * normal.x * diagonal, y: center.y + sign * normal.y * diagonal };
        } else return null;
        windowFrames.push({ offset: keyframe.offset,
            transform: `translate(${px(through.x)}, ${px(through.y)}) rotate(${angle.toFixed(6)}rad) translate(0px, ${px(-reach / 2)})` });
        planeFrames.push({ offset: keyframe.offset,
            transform: `translate(0px, ${px(reach / 2)}) rotate(${(-angle).toFixed(6)}rad) translate(${px(-through.x)}, ${px(-through.y)})` });
    }
    const window = document.createElement('div');
    window.className = 'stf__cut';
    window.style.cssText = `position: absolute; left: 0; top: 0; width: ${reach}px; height: ${reach}px; overflow: hidden; ` +
        `transform-origin: 0 0; pointer-events: none; transform: ${windowFrames.at(-1)!.transform};`;
    const plane = document.createElement('div');
    plane.className = 'stf__cut-plane';
    plane.style.cssText = `position: absolute; left: 0; top: 0; width: ${width}px; height: ${height}px; ` +
        `transform-origin: 0 0; transform: ${planeFrames.at(-1)!.transform};`;
    // moveBefore keeps the snapshot frames' documents (appending them would reload them); it moves
    // only between connected nodes, so the window goes in first.
    const children = [...element.childNodes];
    window.append(plane);
    element.append(window);
    const moved: ChildNode[] = [];
    try {
        for (const child of children) { plane.moveBefore(child, null); moved.push(child); }
    } catch {
        for (const child of moved) element.moveBefore(child, window);
        window.remove();
        return null;
    }
    // The clip-path cut the page's own paper too: that now lies in the plane, cut by the window.
    const paper = getComputedStyle(element);
    for (const name of ['background-color', 'background-image', 'background-size', 'background-position', 'background-repeat'])
        plane.style.setProperty(name, paper.getPropertyValue(name));
    element.style.background = 'none';
    element.style.clipPath = 'none';
    element.style.setProperty('-webkit-clip-path', 'none');
    return { window, plane, windowFrames, planeFrames };
}

/**
 * Class responsible for rendering the book
 */
export abstract class Render {
    protected readonly setting: FlipSetting;
    protected readonly app: PageFlip;

    /** Left static book page */
    protected leftPage: Page | null = null;
    /** Right static book page */
    protected rightPage: Page | null = null;

    /** Page currently flipping */
    protected flippingPage: Page | null = null;
    /** Next page at the time of flipping */
    protected bottomPage: Page | null = null;

    /** Current flipping direction */
    protected direction: FlipDirection | null = null;
    /** Current book orientation */
    protected orientation: Orientation | null = null;
    /** Сurrent state of the shadows */
    protected shadow: Shadow | null = null;
    /** Сurrent animation process */
    protected animation: AnimationProcess | null = null;
    /** Page borders while flipping */
    protected pageRect: RectPoints | null = null;
    /** Current book area */
    private boundsRect: PageRect | null = null;

    /** Timer started from start of rendering */
    protected timer = 0;

    /** dr-reader: the render loop's pending frame, and whether the loop was stopped for good. */
    private raf = 0;
    private stopped = false;
    /** dr-reader: the flip the compositor is playing (playOnCompositor), and extra recorded elements. */
    private compositor: { animations: Animation[]; onAnimateEnd: AnimationSuccessAction } | null = null;
    private readonly tracked = new Set<HTMLElement>();

    /**
     * Safari browser definitions for resolving a bug with a css property clip-area
     *
     * https://bugs.webkit.org/show_bug.cgi?id=126207
     */
    private safari = false;

    protected constructor(app: PageFlip, setting: FlipSetting) {
        this.setting = setting;
        this.app = app;

        // detect safari
        const regex = new RegExp('Version\\/[\\d\\.]+.*Safari/');
        this.safari = regex.exec(window.navigator.userAgent) !== null;
    }

    /**
     * Rendering action on each requestAnimationFrame call. The entire rendering process is performed only in this method
     */
    public abstract drawFrame(): void;

    /**
     * Reload the render area, after update pages
     */
    public abstract reload(): void;

    /**
     * Executed when requestAnimationFrame is called. Performs the current animation process and call drawFrame()
     */
    private render(timer: number): void {
        // dr-reader: the compositor plays the current flip; nothing to draw until it lands.
        if (this.compositor !== null) {
            this.timer = timer;
            return;
        }

        if (this.animation !== null) {
            // Find current frame of animation
            const frameIndex = Math.round((timer - this.animation.startedAt) / this.animation.durationFrame);

            if (frameIndex < this.animation.frames.length) {
                this.animation.frames[frameIndex]();
            } else {
                this.animation.onAnimateEnd?.();
                this.animation = null;
            }
        }

        // dr-reader: a caller may stop the book from the end-of-animation callback (motion.ts does
        // when a flip lands); the landing pose then stays as the last frame drawn.
        if (this.stopped) return;

        this.timer = timer;
        this.drawFrame();
    }

    /**
     * Running requestAnimationFrame, and rendering process
     */
    public start(): void {
        this.update();
        this.stopped = false;

        this.raf = requestAnimationFrame(this.loop);
    }

    /**
     * dr-reader: the next frame is requested even if this one throws. Upstream requested it after
     * drawing, so one failed frame (degenerate geometry at the page edge) stopped the book for good
     * and froze a turn mid-flight. While the compositor plays a flip the loop pauses: each request
     * would otherwise make the main thread run a full frame (style, layout, paint) for nothing.
     */
    private readonly loop = (timer: number): void => {
        this.raf = 0;
        if (this.stopped) return;
        try {
            this.render(timer);
        } finally {
            if (!this.stopped && this.compositor === null) this.raf = requestAnimationFrame(this.loop);
        }
    };

    /** dr-reader: restart the loop after a compositor flip (unless stopped or already scheduled). */
    private resume(): void {
        if (!this.stopped && this.raf === 0) this.raf = requestAnimationFrame(this.loop);
    }

    /**
     * dr-reader: stop the render loop and drop any running animation (upstream never stopped it).
     */
    public stop(): void {
        this.stopped = true;
        cancelAnimationFrame(this.raf);
        this.animation = null;
        const compositor = this.compositor;
        this.compositor = null;
        // The elements' own styles already hold the landing pose (see playOnCompositor).
        for (const animation of compositor?.animations ?? []) animation.cancel();
    }

    /**
     * dr-reader: also record this element's inline style while recording a flip for the compositor,
     * for callers that style elements outside the book in step with the flip (motion.ts's spine).
     */
    public track(element: HTMLElement): void {
        this.tracked.add(element);
    }

    /** dr-reader: the Web Animations playing the current flip on the compositor, if any. */
    public getAnimations(): readonly Animation[] {
        return this.compositor?.animations ?? [];
    }

    /**
     * dr-reader: while the compositor plays a flip, its keyframes own the pages' poses and the
     * elements' own styles must stay at the landing pose (see playOnCompositor); drawing is skipped.
     */
    protected isPlayingOnCompositor(): boolean {
        return this.compositor !== null;
    }

    /**
     * Start a new animation process
     *
     * @param {FrameAction[]} frames - Frame list
     * @param {number} duration - total animation duration
     * @param {AnimationSuccessAction} onAnimateEnd - Animation callback function
     */
    public startAnimation(frames: FrameAction[], duration: number, onAnimateEnd: AnimationSuccessAction): void {
        this.finishAnimation(); // finish the previous animation process

        if (this.setting.compositorPlayback !== false && this.playOnCompositor(frames, duration, onAnimateEnd)) return;

        this.animation = {
            frames,
            duration,
            durationFrame: duration / frames.length,
            onAnimateEnd,
            startedAt: this.timer,
        };
    }

    /**
     * End the current animation process and call the callback
     */
    public finishAnimation(): void {
        const compositor = this.compositor;
        if (compositor !== null) {
            this.compositor = null;
            for (const animation of compositor.animations) animation.cancel();
            compositor.onAnimateEnd();
            this.resume();
            return;
        }

        if (this.animation !== null) {
            this.animation.frames[this.animation.frames.length - 1]();

            if (this.animation.onAnimateEnd !== null) {
                this.animation.onAnimateEnd();
            }
        }

        this.animation = null;
    }

    /**
     * dr-reader: play a flip on the compositor.
     *
     * The flip is drawn exactly as the render loop would draw it, one sample per display frame
     * (every frame of the path the loop would pick at 60 Hz), and each element's resulting inline
     * style is read back: the engine's page and shadow styles plus whatever a caller changes after
     * drawFrame (motion.ts normalises flat poses and fades the spine). Values that stay the same
     * become plain styles; transform, clip-path and opacity values that change become one keyframe
     * list per element, all sharing the duration, linear timing and start time of the loop. The
     * compositor then plays the flip without the main thread, and a busy main thread cannot drop its
     * frames.
     *
     * After recording, the elements hold the last sample, the landing pose: that is also what shows
     * whenever the compositor falls back to the underlying style as the animations end.
     *
     * @returns false, with nothing applied, when another property changes during the flip.
     */
    private playOnCompositor(frames: FrameAction[], duration: number, onAnimateEnd: AnimationSuccessAction): boolean {
        if (typeof Element.prototype.animate !== 'function' || frames.length < 2) return false;

        const count = Math.max(2, Math.min(frames.length, Math.round(duration / FRAME_INTERVAL) + 1));
        const targets = (): HTMLElement[] => [
            ...this.app.getUI().getDistElement().querySelectorAll<HTMLElement>('[style]'),
            ...this.tracked,
        ];
        const samples: Map<HTMLElement, Map<string, string>>[] = [];
        for (let i = 0; i < count; i++) {
            frames[Math.round((i / (count - 1)) * (frames.length - 1))]();
            this.drawFrame();
            const sample = new Map<HTMLElement, Map<string, string>>();
            for (const element of targets()) sample.set(element, readStyle(element));
            samples.push(sample);
        }

        const tracks: { element: HTMLElement; keyframes: Keyframe[]; hidden?: string }[] = [];
        const elements = new Set(samples.flatMap(sample => [...sample.keys()]));
        for (const element of elements) {
            const styles = samples.map(sample => sample.get(element) ?? new Map<string, string>());
            const names = new Set(styles.flatMap(style => [...style.keys()]));
            const moving: string[] = [];
            for (const name of names) {
                const values = styles.map(style => style.get(name));
                if (values.every(value => value === values[0])) continue;
                if (name === 'backface-visibility') {
                    // Only a page rotated about Y shows a back face; the reader marks flat poses
                    // 'visible' to keep them out of 3D layers. Keep the face that matters while turning.
                    if (values.includes('hidden')) element.style.backfaceVisibility = 'hidden';
                    continue;
                }
                if (!ANIMATED.has(name) || values.some(value => value === undefined)) return false;
                moving.push(name);
            }
            if (!moving.length) continue;
            const keyframes = styles.map((style, index) => {
                const keyframe: Keyframe = { offset: index / (count - 1) };
                for (const name of moving) keyframe[ANIMATED.get(name)!] = style.get(name)!;
                return keyframe;
            });
            // Polygons interpolate vertex by vertex; pad the ones that lost a vertex (the fold's
            // corner leaving an edge) with their last vertex, which does not change their shape.
            if (moving.includes('clip-path') && !padPolygons(keyframes)) return false;
            tracks.push({ element, keyframes });
        }

        // dr-reader: cuts become windows turned with transforms (see cutWindows), so the whole flip
        // plays on the compositor and a busy main thread cannot hold a cut behind its page.
        for (const track of [...tracks]) {
            if (!('clipPath' in track.keyframes[0])) continue;
            const cut = cutWindows(track.element, track.keyframes);
            if (!cut) continue;
            tracks.push({ element: cut.window, keyframes: cut.windowFrames }, { element: cut.plane, keyframes: cut.planeFrames });
            for (const keyframe of track.keyframes) delete keyframe.clipPath;
            if (Object.keys(track.keyframes[0]).every(key => key === 'offset')) tracks.splice(tracks.indexOf(track), 1);
        }

        // Started in one task, the animations share their start time.
        const animations = tracks.map(({ element, keyframes }) =>
            element.animate(keyframes, { duration, easing: 'linear', fill: 'both' })
        );
        const playback = { animations, onAnimateEnd };
        this.compositor = playback;
        Promise.all(animations.map(animation => animation.finished)).then(
            () => {
                if (this.compositor !== playback) return;
                this.compositor = null;
                onAnimateEnd();
                // The styles hold the landing pose; the next loop frame (unless stopped) draws the
                // resting book over them.
                for (const animation of animations) animation.cancel();
                this.resume();
            },
            (): void => undefined // canceled by finishAnimation or stop
        );
        return true;
    }

    /**
     * Recalculate the size of the displayed area, and update the page orientation
     */
    public update(): void {
        this.boundsRect = null;
        const orientation = this.calculateBoundsRect();

        if (this.orientation !== orientation) {
            this.orientation = orientation;
            this.app.updateOrientation(orientation);
        }
    }

    /**
     * Calculate the size and position of the book depending on the parent element and configuration parameters
     */
    private calculateBoundsRect(): Orientation {
        let orientation: Orientation = Orientation.LANDSCAPE;

        const blockWidth = this.getBlockWidth();
        const middlePoint: Point = {
            x: blockWidth / 2,
            y: this.getBlockHeight() / 2,
        };

        const ratio = this.setting.width / this.setting.height;

        let pageWidth = this.setting.width;
        let pageHeight = this.setting.height;

        let left = middlePoint.x - pageWidth;

        if (this.setting.size === SizeType.STRETCH) {
            if (blockWidth < this.setting.minWidth * 2 && this.app.getSettings().usePortrait)
                orientation = Orientation.PORTRAIT;

            pageWidth = orientation === Orientation.PORTRAIT ? this.getBlockWidth() : this.getBlockWidth() / 2;

            if (pageWidth > this.setting.maxWidth) pageWidth = this.setting.maxWidth;

            pageHeight = pageWidth / ratio;
            if (pageHeight > this.getBlockHeight()) {
                pageHeight = this.getBlockHeight();
                pageWidth = pageHeight * ratio;
            }

            left = orientation === Orientation.PORTRAIT ? middlePoint.x - pageWidth / 2 - pageWidth : middlePoint.x - pageWidth;
        } else {
            if (blockWidth < pageWidth * 2) {
                if (this.app.getSettings().usePortrait) {
                    orientation = Orientation.PORTRAIT;
                    left = middlePoint.x - pageWidth / 2 - pageWidth;
                }
            }
        }

        this.boundsRect = {
            left,
            top: middlePoint.y - pageHeight / 2,
            width: pageWidth * 2,
            height: pageHeight,
            pageWidth: pageWidth,
        };

        return orientation;
    }

    /**
     * Set the current parameters of the drop shadow
     *
     * @param {Point} pos - Shadow Position Start Point
     * @param {number} angle - The angle of the shadows relative to the book
     * @param {number} progress - Flipping progress in percent (0 - 100)
     * @param {FlipDirection} direction - Flipping Direction, the direction of the shadow gradients
     */
    public setShadowData(pos: Point, angle: number, progress: number, direction: FlipDirection): void {
        if (!this.app.getSettings().drawShadow) return;

        const maxShadowOpacity = 100 * this.getSettings().maxShadowOpacity;

        this.shadow = {
            pos,
            angle,
            width: (((this.getRect().pageWidth * 3) / 4) * progress) / 100,
            opacity: ((100 - progress) * maxShadowOpacity) / 100 / 100,
            direction,
            progress: progress * 2,
        };
    }

    /**
     * Clear shadow
     */
    public clearShadow(): void {
        this.shadow = null;
    }

    /**
     * Get parent block offset width
     */
    public getBlockWidth(): number {
        return this.app.getUI().getDistElement().offsetWidth;
    }

    /**
     * Get parent block offset height
     */
    public getBlockHeight(): number {
        return this.app.getUI().getDistElement().offsetHeight;
    }

    /**
     * Get current flipping direction
     */
    public getDirection(): FlipDirection | null {
        return this.direction;
    }

    /**
     * Сurrent size and position of the book
     */
    public getRect(): PageRect {
        if (this.boundsRect === null) this.calculateBoundsRect();

        return this.boundsRect!;
    }

    /**
     * Get configuration object
     */
    public getSettings(): FlipSetting {
        return this.app.getSettings();
    }

    /**
     * Get current book orientation
     */
    public getOrientation(): Orientation | null {
        return this.orientation;
    }

    /**
     * Set page area while flipping
     */
    public setPageRect(pageRect: RectPoints): void {
        this.pageRect = pageRect;
    }

    /**
     * Set flipping direction
     */
    public setDirection(direction: FlipDirection): void {
        this.direction = direction;
    }

    /**
     * Set right static book page
     */
    public setRightPage(page: Page | null): void {
        if (page !== null) page.setOrientation(PageOrientation.RIGHT);

        this.rightPage = page;
    }

    /**
     * Set left static book page
     */
    public setLeftPage(page: Page | null): void {
        if (page !== null) page.setOrientation(PageOrientation.LEFT);

        this.leftPage = page;
    }

    /**
     * Set next page at the time of flipping
     */
    public setBottomPage(page: Page | null): void {
        if (page !== null)
            page.setOrientation(this.direction === FlipDirection.BACK ? PageOrientation.LEFT : PageOrientation.RIGHT);

        this.bottomPage = page;
    }

    /**
     * Set currently flipping page
     */
    public setFlippingPage(page: Page | null): void {
        if (page !== null)
            page.setOrientation(
                this.direction === FlipDirection.FORWARD && this.orientation !== Orientation.PORTRAIT
                    ? PageOrientation.LEFT
                    : PageOrientation.RIGHT
            );

        this.flippingPage = page;
    }

    /**
     * Coordinate conversion function. Window coordinates -> to book coordinates
     */
    public convertToBook(pos: Point): Point {
        const rect = this.getRect();

        return {
            x: pos.x - rect.left,
            y: pos.y - rect.top,
        };
    }

    public isSafari(): boolean {
        return this.safari;
    }

    /**
     * Coordinate conversion function. Window coordinates -> to current coordinates of the working page
     *
     * Upstream's `if (!direction)` also replaced FORWARD (0) with the current direction; kept as is.
     */
    public convertToPage(pos: Point, direction?: FlipDirection | null): Point {
        if (!direction) direction = this.direction;

        const rect = this.getRect();
        const x = direction === FlipDirection.FORWARD ? pos.x - rect.left - rect.width / 2 : rect.width / 2 - pos.x + rect.left;

        return {
            x,
            y: pos.y - rect.top,
        };
    }

    /**
     * Coordinate conversion function. Coordinates relative to the work page -> Window coordinates
     */
    public convertToGlobal(pos: Point, direction?: FlipDirection | null): Point {
        if (!direction) direction = this.direction;

        const rect = this.getRect();

        const x = direction === FlipDirection.FORWARD ? pos.x + rect.left + rect.width / 2 : rect.width / 2 - pos.x + rect.left;

        return {
            x,
            y: pos.y + rect.top,
        };
    }

    /**
     * Casting the coordinates of the corners of the rectangle in the coordinates relative to the window
     */
    public convertRectToGlobal(rect: RectPoints, direction?: FlipDirection | null): RectPoints {
        if (!direction) direction = this.direction;

        return {
            topLeft: this.convertToGlobal(rect.topLeft, direction),
            topRight: this.convertToGlobal(rect.topRight, direction),
            bottomLeft: this.convertToGlobal(rect.bottomLeft, direction),
            bottomRight: this.convertToGlobal(rect.bottomRight, direction),
        };
    }
}
