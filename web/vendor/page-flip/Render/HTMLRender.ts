import { Orientation, Render } from './Render.ts';
import type { Shadow } from './Render.ts';
import type { PageFlip } from '../PageFlip.ts';
import { FlipDirection } from '../Flip/Flip.ts';
import { PageDensity, PageOrientation } from '../Page/Page.ts';
import type { HTMLPage } from '../Page/HTMLPage.ts';
import type { FlipSetting } from '../Settings.ts';
import { setCssText } from './Style.ts';

/**
 * Class responsible for rendering the HTML book
 *
 * dr-reader: upstream logic; only the cssText assignments go through setCssText, which skips an
 * assignment identical to the previous one (every resting page and hidden shadow, every frame).
 */
export class HTMLRender extends Render {
    /** Parent HTML Element */
    private readonly element: HTMLElement;

    private outerShadowClip!: HTMLElement;
    private outerShadow!: HTMLElement;
    private innerShadow!: HTMLElement;
    private hardShadow!: HTMLElement;
    private hardInnerShadow!: HTMLElement;

    /**
     * @param {PageFlip} app - PageFlip object
     * @param {FlipSetting} setting - Configuration object
     * @param {HTMLElement} element - Parent HTML Element
     */
    constructor(app: PageFlip, setting: FlipSetting, element: HTMLElement) {
        super(app, setting);

        this.element = element;

        this.createShadows();
    }

    /**
     * dr-reader: each shadow keeps upstream's geometry and gradient, arranged so that a flip only
     * changes transform, clip-path and opacity, which the compositor animates:
     * - a shadow box is one page wide and scaled to upstream's changing width;
     * - its gradient sits on a child ("tone") whose opacity is upstream's changing strength, so
     *   the shadow element's own opacity stays free for the reader's landing fade, as before;
     * - the soft outer shadow is clipped by a fixed box over the page it falls on, and the soft
     *   inner shadow rides inside the turning sheet, clipped by its box and clip-path. Upstream
     *   clipped both with a clip-path of their own, a mask the compositor would redraw per frame.
     */
    private createShadows(): void {
        this.element.insertAdjacentHTML(
            'beforeend',
            `<div class="stf__outerShadowClip"><div class="stf__outerShadow"><div class="stf__shadowTone"></div></div></div>
             <div class="stf__innerShadow"><div class="stf__shadowTone"></div></div>
             <div class="stf__hardShadow"><div class="stf__shadowTone"></div></div>
             <div class="stf__hardInnerShadow"><div class="stf__shadowTone"></div></div>`
        );

        this.outerShadowClip = this.element.querySelector<HTMLElement>('.stf__outerShadowClip')!;
        this.outerShadow = this.element.querySelector<HTMLElement>('.stf__outerShadow')!;
        this.innerShadow = this.element.querySelector<HTMLElement>('.stf__innerShadow')!;
        this.hardShadow = this.element.querySelector<HTMLElement>('.stf__hardShadow')!;
        this.hardInnerShadow = this.element.querySelector<HTMLElement>('.stf__hardInnerShadow')!;
    }

    private tone(shadow: HTMLElement): HTMLElement {
        return shadow.firstElementChild as HTMLElement;
    }

    public clearShadow(): void {
        super.clearShadow();

        setCssText(this.outerShadowClip, 'display: none');
        setCssText(this.innerShadow, 'display: none');
        setCssText(this.hardShadow, 'display: none');
        setCssText(this.hardInnerShadow, 'display: none');
        // Back from the sheet it rode on, which may be a temporary copy about to be removed.
        if (this.innerShadow.parentElement !== this.element) this.element.append(this.innerShadow);
    }

    /**
     * Upstream placed a shadow box of width `width` with translate(x, y) and rotate(angle) about
     * (originX, originY). The same placement for a box one page wide, scaled to that width.
     */
    private shadowTransform(x: number, y: number, originX: number, originY: number, angle: number, width: number): string {
        const scale = Math.max(width, 0.01) / this.getRect().pageWidth;
        return `translate(${x + originX}px, ${y + originY}px) rotate(${angle}rad) translate(${-originX}px, ${-originY}px) scale(${scale}, 1)`;
    }

    public reload(): void {
        const testShadow = this.element.querySelector('.stf__outerShadow');

        if (!testShadow) {
            this.createShadows();
        }
    }

    /**
     * Draw inner shadow to the hard page
     */
    private drawHardInnerShadow(shadow: Shadow): void {
        const rect = this.getRect();

        const progress = shadow.progress > 100 ? 200 - shadow.progress : shadow.progress;

        let innerShadowSize = ((100 - progress) * (2.5 * rect.pageWidth)) / 100 + 20;
        if (innerShadowSize > rect.pageWidth) innerShadowSize = rect.pageWidth;

        // Upstream mirrored the box with rotateY(180deg) about its left edge: a negative scale.
        const facing =
            (this.getDirection() === FlipDirection.FORWARD && shadow.progress > 100) ||
            (this.getDirection() === FlipDirection.BACK && shadow.progress <= 100);
        const scale = innerShadowSize / rect.pageWidth;

        setCssText(
            this.hardInnerShadow,
            `display: block; z-index: ${this.getSettings().startZIndex + 5}; width: ${rect.pageWidth}px; height: ${rect.height}px;
            left: ${rect.left + rect.width / 2}px; transform-origin: 0 0; transform: scale(${facing ? scale : -scale}, 1);`
        );
        setCssText(
            this.tone(this.hardInnerShadow),
            `background: linear-gradient(to right, #000 5%, transparent 100%); opacity: ${(shadow.opacity * progress) / 100};`
        );
    }

    /**
     * Draw outer shadow to the hard page
     */
    private drawHardOuterShadow(shadow: Shadow): void {
        const rect = this.getRect();

        const progress = shadow.progress > 100 ? 200 - shadow.progress : shadow.progress;

        let shadowSize = ((100 - progress) * (2.5 * rect.pageWidth)) / 100 + 20;
        if (shadowSize > rect.pageWidth) shadowSize = rect.pageWidth;

        const mirrored =
            (this.getDirection() === FlipDirection.FORWARD && shadow.progress > 100) ||
            (this.getDirection() === FlipDirection.BACK && shadow.progress <= 100);
        const scale = shadowSize / rect.pageWidth;

        setCssText(
            this.hardShadow,
            `display: block; z-index: ${this.getSettings().startZIndex + 4}; width: ${rect.pageWidth}px; height: ${rect.height}px;
            left: ${rect.left + rect.width / 2}px; transform-origin: 0 0; transform: scale(${mirrored ? -scale : scale}, 1);`
        );
        setCssText(
            this.tone(this.hardShadow),
            `background: linear-gradient(to left, #000 5%, transparent 100%); opacity: ${shadow.opacity};`
        );
    }

    /**
     * Draw inner shadow to the soft page
     */
    private drawInnerShadow(shadow: Shadow, sheet: HTMLPage): void {
        const rect = this.getRect();

        const innerShadowSize = (shadow.width * 3) / 4;
        const shadowTranslate = this.getDirection() === FlipDirection.FORWARD ? innerShadowSize : 0;

        const shadowDirection = this.getDirection() === FlipDirection.FORWARD ? 'to left' : 'to right';

        const shadowPos = this.convertToGlobal(shadow.pos);

        const angle = shadow.angle + (3 * Math.PI) / 2;

        // Upstream clipped this shadow to the turning sheet's rectangle. Inside the sheet it is
        // clipped by the sheet itself and carried by its transform, which it undoes here.
        const element = sheet.getElement();
        if (this.innerShadow.parentElement !== element) element.append(this.innerShadow);
        const pose = sheet.getPose();

        // Upstream's gradient: the strength s at 5% and 35%, a fixed 0.05 at 15%, 0 at 100%.
        // Piecewise linear, it is exactly a fixed 0.05 bump at 15% (this element) plus s times a
        // fixed profile (the tone, with opacity s).
        setCssText(
            this.innerShadow,
            `display: block; z-index: 1; width: ${rect.pageWidth}px; height: ${rect.height * 2}px;
            background: linear-gradient(${shadowDirection}, transparent 5%, rgba(0, 0, 0, 0.05) 15%, transparent 35%);
            transform-origin: 0 0;
            transform: rotate(${-pose.angle}rad) translate(${-pose.x}px, ${-pose.y}px) ${this.shadowTransform(
                shadowPos.x - shadowTranslate, shadowPos.y - 100, shadowTranslate, 100, angle, innerShadowSize)};`
        );
        setCssText(
            this.tone(this.innerShadow),
            `background: linear-gradient(${shadowDirection}, #000 5%, transparent 15%, #000 35%, transparent 100%); opacity: ${shadow.opacity};`
        );
    }

    /**
     * Draw outer shadow to the soft page
     */
    private drawOuterShadow(shadow: Shadow): void {
        const rect = this.getRect();

        const shadowPos = this.convertToGlobal({ x: shadow.pos.x, y: shadow.pos.y });

        const angle = shadow.angle + (3 * Math.PI) / 2;
        const shadowTranslate = this.getDirection() === FlipDirection.BACK ? shadow.width : 0;

        const shadowDirection = this.getDirection() === FlipDirection.FORWARD ? 'to right' : 'to left';

        // Upstream clipped this shadow to the page it falls on, which does not move during a flip.
        const left = rect.left + rect.width / 2 - (this.getDirection() === FlipDirection.FORWARD ? 0 : rect.pageWidth);
        setCssText(
            this.outerShadowClip,
            `display: block; z-index: ${this.getSettings().startZIndex + 10}; left: ${left}px; top: ${rect.top}px;
            width: ${rect.pageWidth}px; height: ${rect.height}px;`
        );
        setCssText(
            this.outerShadow,
            `display: block; width: ${rect.pageWidth}px; height: ${rect.height * 2}px; transform-origin: 0 0;
            transform: ${this.shadowTransform(shadowPos.x - shadowTranslate - left, shadowPos.y - 100 - rect.top, shadowTranslate, 100, angle, shadow.width)};`
        );
        setCssText(
            this.tone(this.outerShadow),
            `background: linear-gradient(${shadowDirection}, #000, transparent); opacity: ${shadow.opacity};`
        );
    }
    /**
     * Draw left static page
     */
    private drawLeftPage(): void {
        if (this.orientation === Orientation.PORTRAIT || this.leftPage === null) return;

        if (
            this.direction === FlipDirection.BACK &&
            this.flippingPage !== null &&
            this.flippingPage.getDrawingDensity() === PageDensity.HARD
        ) {
            (this.leftPage as HTMLPage).getElement().style.zIndex = (this.getSettings().startZIndex + 5).toString(10);

            this.leftPage.setHardDrawingAngle(180 + this.flippingPage.getHardAngle());
            this.leftPage.draw(this.flippingPage.getDrawingDensity());
        } else {
            this.leftPage.simpleDraw(PageOrientation.LEFT);
        }
    }

    /**
     * Draw right static page
     */
    private drawRightPage(): void {
        if (this.rightPage === null) return;

        if (
            this.direction === FlipDirection.FORWARD &&
            this.flippingPage !== null &&
            this.flippingPage.getDrawingDensity() === PageDensity.HARD
        ) {
            (this.rightPage as HTMLPage).getElement().style.zIndex = (this.getSettings().startZIndex + 5).toString(10);

            this.rightPage.setHardDrawingAngle(180 + this.flippingPage.getHardAngle());
            this.rightPage.draw(this.flippingPage.getDrawingDensity());
        } else {
            this.rightPage.simpleDraw(PageOrientation.RIGHT);
        }
    }

    /**
     * Draw the next page at the time of flipping
     */
    private drawBottomPage(): void {
        if (this.bottomPage === null) return;

        const tempDensity = this.flippingPage != null ? this.flippingPage.getDrawingDensity() : null;

        if (!(this.orientation === Orientation.PORTRAIT && this.direction === FlipDirection.BACK)) {
            (this.bottomPage as HTMLPage).getElement().style.zIndex = (this.getSettings().startZIndex + 3).toString(10);

            this.bottomPage.draw(tempDensity);
        }
    }

    public drawFrame(): void {
        // dr-reader: a draw during compositor playback (motion.ts poses an uncurl's first frame
        // after starting it) would replace the landing pose the elements must keep underneath.
        if (this.isPlayingOnCompositor()) return;

        this.clear();

        this.drawLeftPage();

        this.drawRightPage();

        this.drawBottomPage();

        if (this.flippingPage != null) {
            (this.flippingPage as HTMLPage).getElement().style.zIndex = (this.getSettings().startZIndex + 5).toString(10);

            this.flippingPage.draw();
        }

        if (this.shadow != null && this.flippingPage !== null) {
            if (this.flippingPage.getDrawingDensity() === PageDensity.SOFT) {
                this.drawOuterShadow(this.shadow);
                this.drawInnerShadow(this.shadow, this.flippingPage as HTMLPage);
            } else {
                this.drawHardOuterShadow(this.shadow);
                this.drawHardInnerShadow(this.shadow);
            }
        }
    }

    private clear(): void {
        for (const page of this.app.getPageCollection().getPages()) {
            if (
                page !== this.leftPage &&
                page !== this.rightPage &&
                page !== this.flippingPage &&
                page !== this.bottomPage
            ) {
                (page as HTMLPage).hide();
            }

            if (page.getTemporaryCopy() !== this.flippingPage) {
                page.hideTemporaryCopy();
            }
        }
    }

    public update(): void {
        super.update();

        if (this.rightPage !== null) {
            this.rightPage.setOrientation(PageOrientation.RIGHT);
        }

        if (this.leftPage !== null) {
            this.leftPage.setOrientation(PageOrientation.LEFT);
        }
    }
}
