import { Orientation } from '../Render/Render.ts';
import type { Render } from '../Render/Render.ts';
import type { PageFlip } from '../PageFlip.ts';
import { Helper } from '../Helper.ts';
import type { PageRect, Point } from '../BasicTypes.ts';
import { FlipCalculation } from './FlipCalculation.ts';
import { PageDensity } from '../Page/Page.ts';
import type { Page } from '../Page/Page.ts';

/**
 * Flipping direction
 */
export const FlipDirection = {
    FORWARD: 0,
    BACK: 1,
} as const;
export type FlipDirection = (typeof FlipDirection)[keyof typeof FlipDirection];

/**
 * Active corner when flipping
 */
export const FlipCorner = {
    TOP: 'top',
    BOTTOM: 'bottom',
} as const;
export type FlipCorner = (typeof FlipCorner)[keyof typeof FlipCorner];

/**
 * State of the book
 */
export const FlippingState = {
    /** The user folding the page */
    USER_FOLD: 'user_fold',

    /** Mouse over active corners */
    FOLD_CORNER: 'fold_corner',

    /** During flipping animation */
    FLIPPING: 'flipping',

    /** Base state */
    READ: 'read',
} as const;
export type FlippingState = (typeof FlippingState)[keyof typeof FlippingState];

/**
 * Class representing the flipping process
 */
export class Flip {
    private readonly render: Render;
    private readonly app: PageFlip;

    private flippingPage: Page | null = null;
    private bottomPage: Page | null = null;

    private calc: FlipCalculation | null = null;

    private state: FlippingState = FlippingState.READ;

    constructor(render: Render, app: PageFlip) {
        this.render = render;
        this.app = app;
    }

    /**
     * Called when the page folding (User drags page corner)
     *
     * @param globalPos - Touch Point Coordinates (relative window)
     */
    public fold(globalPos: Point): void {
        this.setState(FlippingState.USER_FOLD);

        // If the process has not started yet
        if (this.calc === null) this.start(globalPos);

        this.do(this.render.convertToPage(globalPos));
    }

    /**
     * Page turning with animation
     *
     * @param globalPos - Touch Point Coordinates (relative window)
     */
    public flip(globalPos: Point): void {
        if (this.app.getSettings().disableFlipByClick && !this.isPointOnCorners(globalPos)) return;

        // the flipiing process is already running
        if (this.calc !== null) this.render.finishAnimation();

        if (!this.start(globalPos) || this.calc === null) return;

        const rect = this.getBoundsRect();

        this.setState(FlippingState.FLIPPING);

        // Margin from top to start flipping
        const topMargins = rect.height / 10;

        // Defining animation start points
        const yStart = this.calc.getCorner() === FlipCorner.BOTTOM ? rect.height - topMargins : topMargins;

        const yDest = this.calc.getCorner() === FlipCorner.BOTTOM ? rect.height : 0;

        // Сalculations for these points
        this.calc.calc({ x: rect.pageWidth - topMargins, y: yStart });

        // Run flipping animation
        this.animateFlippingTo({ x: rect.pageWidth - topMargins, y: yStart }, { x: -rect.pageWidth, y: yDest }, true);
    }

    /**
     * Start the flipping process. Find direction and corner of flipping. Creating an object for calculation.
     *
     * @param {Point} globalPos - Touch Point Coordinates (relative window)
     *
     * @returns {boolean} True if flipping is possible, false otherwise
     */
    public start(globalPos: Point): boolean {
        this.reset();

        const bookPos = this.render.convertToBook(globalPos);
        const rect = this.getBoundsRect();

        // Find the direction of flipping
        const direction = this.getDirectionByPoint(bookPos);

        // Find the active corner
        const flipCorner = bookPos.y >= rect.height / 2 ? FlipCorner.BOTTOM : FlipCorner.TOP;

        if (!this.checkDirection(direction)) return false;

        try {
            const flippingPage = this.app.getPageCollection().getFlippingPage(direction);
            const bottomPage = this.app.getPageCollection().getBottomPage(direction);
            this.flippingPage = flippingPage;
            this.bottomPage = bottomPage;

            // In landscape mode, needed to set the density  of the next page to the same as that of the flipped
            if (this.render.getOrientation() === Orientation.LANDSCAPE) {
                if (direction === FlipDirection.BACK) {
                    const nextPage = this.app.getPageCollection().nextBy(flippingPage);

                    if (nextPage !== null) {
                        if (flippingPage.getDensity() !== nextPage.getDensity()) {
                            flippingPage.setDrawingDensity(PageDensity.HARD);
                            nextPage.setDrawingDensity(PageDensity.HARD);
                        }
                    }
                } else {
                    const prevPage = this.app.getPageCollection().prevBy(flippingPage);

                    if (prevPage !== null) {
                        if (flippingPage.getDensity() !== prevPage.getDensity()) {
                            flippingPage.setDrawingDensity(PageDensity.HARD);
                            prevPage.setDrawingDensity(PageDensity.HARD);
                        }
                    }
                }
            }

            this.render.setDirection(direction);
            this.calc = new FlipCalculation(
                direction,
                flipCorner,
                rect.pageWidth.toString(10), // fix bug with type casting
                rect.height.toString(10) // fix bug with type casting
            );

            return true;
        } catch {
            return false;
        }
    }

    /**
     * Perform calculations for the current page position. Pass data to render object
     *
     * dr-reader: public, so a caller can drive a flip along its own path (see motion.ts).
     *
     * @param {Point} pagePos - Touch Point Coordinates (relative active page)
     */
    public do(pagePos: Point): void {
        const calc = this.calc, flippingPage = this.flippingPage, bottomPage = this.bottomPage;
        if (calc === null || flippingPage === null || bottomPage === null) return; // Flipping process not started

        if (calc.calc(pagePos)) {
            // Perform calculations for a specific position
            const progress = calc.getFlippingProgress();

            bottomPage.setArea(calc.getBottomClipArea());
            bottomPage.setPosition(calc.getBottomPagePosition());
            bottomPage.setAngle(0);
            bottomPage.setHardAngle(0);

            flippingPage.setArea(calc.getFlippingClipArea());
            flippingPage.setPosition(calc.getActiveCorner());
            flippingPage.setAngle(calc.getAngle());

            if (calc.getDirection() === FlipDirection.FORWARD) {
                flippingPage.setHardAngle((90 * (200 - progress * 2)) / 100);
            } else {
                flippingPage.setHardAngle((-90 * (200 - progress * 2)) / 100);
            }

            this.render.setPageRect(calc.getRect());

            this.render.setBottomPage(bottomPage);
            this.render.setFlippingPage(flippingPage);

            const shadowStart = calc.getShadowStartPoint();
            if (shadowStart !== null)
                this.render.setShadowData(shadowStart, calc.getShadowAngle(), progress, calc.getDirection());
        }
    }

    /**
     * Turn to the specified page number (with animation)
     *
     * @param {number} page - New page number
     * @param {FlipCorner} corner - Active page corner when turning
     */
    public flipToPage(page: number, corner: FlipCorner): void {
        const current = this.app.getPageCollection().getCurrentSpreadIndex();
        const next = this.app.getPageCollection().getSpreadIndexByPage(page);
        if (next === null) return;

        try {
            if (next > current) {
                this.app.getPageCollection().setCurrentSpreadIndex(next - 1);
                this.flipNext(corner);
            }
            if (next < current) {
                this.app.getPageCollection().setCurrentSpreadIndex(next + 1);
                this.flipPrev(corner);
            }
        } catch {
            //
        }
    }

    /**
     * Turn to the next page (with animation)
     *
     * @param {FlipCorner} corner - Active page corner when turning
     */
    public flipNext(corner: FlipCorner): void {
        this.flip({
            x: this.render.getRect().left + this.render.getRect().pageWidth * 2 - 10,
            y: corner === FlipCorner.TOP ? 1 : this.render.getRect().height - 2,
        });
    }

    /**
     * Turn to the prev page (with animation)
     *
     * @param {FlipCorner} corner - Active page corner when turning
     */
    public flipPrev(corner: FlipCorner): void {
        this.flip({
            x: 10,
            y: corner === FlipCorner.TOP ? 1 : this.render.getRect().height - 2,
        });
    }

    /**
     * Called when the user has stopped flipping
     */
    public stopMove(): void {
        if (this.calc === null) return;

        const pos = this.calc.getPosition();
        const rect = this.getBoundsRect();

        const y = this.calc.getCorner() === FlipCorner.BOTTOM ? rect.height : 0;

        if (pos.x <= 0) this.animateFlippingTo(pos, { x: -rect.pageWidth, y }, true);
        else this.animateFlippingTo(pos, { x: rect.pageWidth, y }, false);
    }

    /**
     * Fold the corners of the book when the mouse pointer is over them.
     * Called when the mouse pointer is over the book without clicking
     */
    public showCorner(globalPos: Point): void {
        if (!this.checkState(FlippingState.READ, FlippingState.FOLD_CORNER)) return;

        const rect = this.getBoundsRect();
        const pageWidth = rect.pageWidth;

        if (this.isPointOnCorners(globalPos)) {
            if (this.calc === null) {
                if (!this.start(globalPos) || this.calc === null) return;
                const calc: FlipCalculation = this.calc;

                this.setState(FlippingState.FOLD_CORNER);

                calc.calc({ x: pageWidth - 1, y: 1 });

                const fixedCornerSize = 50;
                const yStart = calc.getCorner() === FlipCorner.BOTTOM ? rect.height - 1 : 1;

                const yDest = calc.getCorner() === FlipCorner.BOTTOM ? rect.height - fixedCornerSize : fixedCornerSize;

                this.animateFlippingTo(
                    { x: pageWidth - 1, y: yStart },
                    { x: pageWidth - fixedCornerSize, y: yDest },
                    false,
                    false
                );
            } else {
                this.do(this.render.convertToPage(globalPos));
            }
        } else {
            this.setState(FlippingState.READ);
            this.render.finishAnimation();

            this.stopMove();
        }
    }

    /**
     * Starting the flipping animation process
     *
     * @param {Point} start - animation start point
     * @param {Point} dest - animation end point
     * @param {boolean} isTurned - will the page turn over, or just bring it back
     * @param {boolean} needReset - reset the flipping process at the end of the animation
     */
    private animateFlippingTo(start: Point, dest: Point, isTurned: boolean, needReset = true): void {
        const points = Helper.GetCordsFromTwoPoint(start, dest);

        // Create frames
        const frames = points.map(p => () => this.do(p));

        const duration = this.getAnimationDuration(points.length);

        this.render.startAnimation(frames, duration, () => {
            // callback function
            if (!this.calc) return;

            if (isTurned) {
                if (this.calc.getDirection() === FlipDirection.BACK) this.app.turnToPrevPage();
                else this.app.turnToNextPage();
            }

            if (needReset) {
                this.render.setBottomPage(null);
                this.render.setFlippingPage(null);
                this.render.clearShadow();

                this.setState(FlippingState.READ);
                this.reset();
            }
        });
    }

    /**
     * Get the current calculations object
     */
    public getCalculation(): FlipCalculation | null {
        return this.calc;
    }

    /**
     * Get current flipping state
     */
    public getState(): FlippingState {
        return this.state;
    }

    private setState(newState: FlippingState): void {
        if (this.state !== newState) {
            this.app.updateState(newState);
            this.state = newState;
        }
    }

    private getDirectionByPoint(touchPos: Point): FlipDirection {
        const rect = this.getBoundsRect();

        if (this.render.getOrientation() === Orientation.PORTRAIT) {
            if (touchPos.x - rect.pageWidth <= rect.width / 5) {
                return FlipDirection.BACK;
            }
        } else if (touchPos.x < rect.width / 2) {
            return FlipDirection.BACK;
        }

        return FlipDirection.FORWARD;
    }

    private getAnimationDuration(size: number): number {
        const defaultTime = this.app.getSettings().flippingTime;

        if (size >= 1000) return defaultTime;

        return (size / 1000) * defaultTime;
    }

    private checkDirection(direction: FlipDirection): boolean {
        if (direction === FlipDirection.FORWARD) return this.app.getCurrentPageIndex() < this.app.getPageCount() - 1;

        return this.app.getCurrentPageIndex() >= 1;
    }

    private reset(): void {
        this.calc = null;
        this.flippingPage = null;
        this.bottomPage = null;
    }

    private getBoundsRect(): PageRect {
        return this.render.getRect();
    }

    private checkState(...states: FlippingState[]): boolean {
        return states.includes(this.state);
    }

    private isPointOnCorners(globalPos: Point): boolean {
        const rect = this.getBoundsRect();
        const pageWidth = rect.pageWidth;

        const operatingDistance = Math.sqrt(Math.pow(pageWidth, 2) + Math.pow(rect.height, 2)) / 5;

        const bookPos = this.render.convertToBook(globalPos);

        return (
            bookPos.x > 0 &&
            bookPos.y > 0 &&
            bookPos.x < rect.width &&
            bookPos.y < rect.height &&
            (bookPos.x < operatingDistance || bookPos.x > rect.width - operatingDistance) &&
            (bookPos.y < operatingDistance || bookPos.y > rect.height - operatingDistance)
        );
    }
}
