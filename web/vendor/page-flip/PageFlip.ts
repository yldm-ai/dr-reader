import type { PageCollection } from './Collection/PageCollection.ts';
import { HTMLPageCollection } from './Collection/HTMLPageCollection.ts';
import type { PageRect, Point } from './BasicTypes.ts';
import { Flip, FlipCorner } from './Flip/Flip.ts';
import type { FlippingState } from './Flip/Flip.ts';
import type { Orientation, Render } from './Render/Render.ts';
import { HTMLUI } from './UI/HTMLUI.ts';
import { Helper } from './Helper.ts';
import type { Page } from './Page/Page.ts';
import { EventObject } from './Event/EventObject.ts';
import { HTMLRender } from './Render/HTMLRender.ts';
import { Settings } from './Settings.ts';
import type { FlipSetting } from './Settings.ts';
import type { UI } from './UI/UI.ts';

import './Style/stPageFlip.css';

/**
 * Class representing a main PageFlip object
 *
 * dr-reader: vendored from StPageFlip 2.0.7 (MIT, see LICENSE and README.md) with HTML pages
 * only; the canvas/image renderer is not included.
 *
 * @extends EventObject
 */
export class PageFlip extends EventObject {
    private mousePosition: Point = { x: 0, y: 0 };
    private isUserTouch = false;
    private isUserMove = false;
    private destroyed = false;

    private readonly setting: FlipSetting;
    private readonly block: HTMLElement; // Root HTML Element

    private pages!: PageCollection;
    private flipController!: Flip;
    private render!: Render;

    private ui!: UI;

    /**
     * Create a new PageFlip instance
     *
     * @param {HTMLElement} inBlock - Root HTML Element
     * @param {Object} setting - Configuration object
     */
    constructor(inBlock: HTMLElement, setting: Partial<FlipSetting>) {
        super();

        this.setting = new Settings().getSettings(setting);
        this.block = inBlock;
    }

    /**
     * Destructor. Remove a root HTML element and all event handlers
     *
     * dr-reader: also stops the render loop (upstream kept it running), and is safe before loading.
     */
    public destroy(): void {
        this.destroyed = true;
        this.render?.stop();
        this.ui?.destroy();
        this.block.remove();
    }

    /**
     * Update the render area. Re-show current page.
     */
    public update(): void {
        this.render.update();
        this.pages.show();
    }

    /**
     * Load pages from HTML elements on the HTML mode
     *
     * @param {(NodeListOf<HTMLElement>|HTMLElement[])} items - List of pages as HTML Element
     */
    public loadFromHTML(items: NodeListOf<HTMLElement> | HTMLElement[]): void {
        this.ui = new HTMLUI(this.block, this, this.setting, items);

        this.render = new HTMLRender(this, this.setting, this.ui.getDistElement());

        this.flipController = new Flip(this.render, this);

        this.pages = new HTMLPageCollection(this, this.render, items);
        this.pages.load();

        this.render.start();

        this.pages.show(this.setting.startPage);

        // safari fix
        setTimeout(() => {
            if (this.destroyed) return;
            this.ui.update();
            this.trigger('init', this, {
                page: this.setting.startPage,
                mode: this.render.getOrientation(),
            });
        }, 1);
    }

    /**
     * Update current pages from HTML
     *
     * @param {(NodeListOf<HTMLElement>|HTMLElement[])} items - List of pages as HTML Element
     */
    public updateFromHtml(items: NodeListOf<HTMLElement> | HTMLElement[]): void {
        const current = this.pages.getCurrentPageIndex();

        this.pages.destroy();
        this.pages = new HTMLPageCollection(this, this.render, items);
        this.pages.load();
        (this.ui as HTMLUI).updateItems(items);
        this.render.reload();

        this.pages.show(current);
        this.trigger('update', this, {
            page: current,
            mode: this.render.getOrientation(),
        });
    }

    /**
     * Clear pages from HTML (remove to initinalState)
     */
    public clear(): void {
        this.pages.destroy();
        (this.ui as HTMLUI).clear();
    }

    /**
     * Turn to the previous page (without animation)
     */
    public turnToPrevPage(): void {
        this.pages.showPrev();
    }

    /**
     * Turn to the next page (without animation)
     */
    public turnToNextPage(): void {
        this.pages.showNext();
    }

    /**
     * Turn to the specified page number (without animation)
     */
    public turnToPage(page: number): void {
        this.pages.show(page);
    }

    /**
     * Turn to the next page (with animation)
     */
    public flipNext(corner: FlipCorner = FlipCorner.TOP): void {
        this.flipController.flipNext(corner);
    }

    /**
     * Turn to the prev page (with animation)
     */
    public flipPrev(corner: FlipCorner = FlipCorner.TOP): void {
        this.flipController.flipPrev(corner);
    }

    /**
     * Turn to the specified page number (with animation)
     */
    public flip(page: number, corner: FlipCorner = FlipCorner.TOP): void {
        this.flipController.flipToPage(page, corner);
    }

    /**
     * Call a state change event trigger
     */
    public updateState(newState: FlippingState): void {
        this.trigger('changeState', this, newState);
    }

    /**
     * Call a page number change event trigger
     */
    public updatePageIndex(newPage: number): void {
        this.trigger('flip', this, newPage);
    }

    /**
     * Call a page orientation change event trigger. Update UI and rendering area
     */
    public updateOrientation(newOrientation: Orientation): void {
        this.ui.setOrientationStyle(newOrientation);
        this.update();
        this.trigger('changeOrientation', this, newOrientation);
    }

    /**
     * Get the total number of pages in a book
     */
    public getPageCount(): number {
        return this.pages.getPageCount();
    }

    /**
     * Get the index of the current page in the page list (starts at 0)
     */
    public getCurrentPageIndex(): number {
        return this.pages.getCurrentPageIndex();
    }

    /**
     * Get page from collection by number
     */
    public getPage(pageIndex: number): Page {
        return this.pages.getPage(pageIndex);
    }

    /**
     * Get the current rendering object
     */
    public getRender(): Render {
        return this.render;
    }

    /**
     * Get current object responsible for flipping
     */
    public getFlipController(): Flip {
        return this.flipController;
    }

    /**
     * Get current page orientation
     */
    public getOrientation(): Orientation | null {
        return this.render.getOrientation();
    }

    /**
     * Get current book sizes and position
     */
    public getBoundsRect(): PageRect {
        return this.render.getRect();
    }

    /**
     * Get configuration object
     */
    public getSettings(): FlipSetting {
        return this.setting;
    }

    /**
     * Get UI object
     */
    public getUI(): UI {
        return this.ui;
    }

    /**
     * Get current flipping state
     */
    public getState(): FlippingState {
        return this.flipController.getState();
    }

    /**
     * Get page collection
     */
    public getPageCollection(): PageCollection {
        return this.pages;
    }

    /**
     * Start page turning. Called when a user clicks or touches
     *
     * @param {Point} pos - Touch position in coordinates relative to the book
     */
    public startUserTouch(pos: Point): void {
        this.mousePosition = pos; // Save touch position
        this.isUserTouch = true;
        this.isUserMove = false;
    }

    /**
     * Called when a finger / mouse moves
     *
     * @param {Point} pos - Touch position in coordinates relative to the book
     * @param {boolean} isTouch - True if there was a touch event, not a mouse click
     */
    public userMove(pos: Point, isTouch: boolean): void {
        if (!this.isUserTouch && !isTouch && this.setting.showPageCorners) {
            this.flipController.showCorner(pos); // fold Page Corner
        } else if (this.isUserTouch) {
            if (Helper.GetDistanceBetweenTwoPoint(this.mousePosition, pos) > 5) {
                this.isUserMove = true;
                this.flipController.fold(pos);
            }
        }
    }

    /**
     * Сalled when the user has stopped touching
     *
     * @param {Point} pos - Touch end position in coordinates relative to the book
     * @param {boolean} isSwipe - true if there was a mobile swipe event
     */
    public userStop(pos: Point, isSwipe = false): void {
        if (this.isUserTouch) {
            this.isUserTouch = false;

            if (!isSwipe) {
                if (!this.isUserMove) this.flipController.flip(pos);
                else this.flipController.stopMove();
            }
        }
    }
}
