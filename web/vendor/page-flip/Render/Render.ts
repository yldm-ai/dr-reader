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

        // dr-reader: the next frame is requested even if this one throws. Upstream requested it after
        // drawing, so one failed frame (degenerate geometry at the page edge) stopped the book for good
        // and froze a turn mid-flight.
        const loop = (timer: number): void => {
            if (this.stopped) return;
            try {
                this.render(timer);
            } finally {
                if (!this.stopped) this.raf = requestAnimationFrame(loop);
            }
        };

        this.raf = requestAnimationFrame(loop);
    }

    /**
     * dr-reader: stop the render loop and drop any running animation (upstream never stopped it).
     */
    public stop(): void {
        this.stopped = true;
        cancelAnimationFrame(this.raf);
        this.animation = null;
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
        if (this.animation !== null) {
            this.animation.frames[this.animation.frames.length - 1]();

            if (this.animation.onAnimateEnd !== null) {
                this.animation.onAnimateEnd();
            }
        }

        this.animation = null;
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
