import { UI } from './UI.ts';
import type { PageFlip } from '../PageFlip.ts';
import type { FlipSetting } from '../Settings.ts';

/**
 * UI for HTML mode
 */
export class HTMLUI extends UI {
    private items: NodeListOf<HTMLElement> | HTMLElement[];

    constructor(inBlock: HTMLElement, app: PageFlip, setting: FlipSetting, items: NodeListOf<HTMLElement> | HTMLElement[]) {
        super(inBlock, app, setting);

        // Second wrapper to HTML page
        this.wrapper.insertAdjacentHTML('afterbegin', '<div class="stf__block"></div>');

        this.distElement = inBlock.querySelector<HTMLElement>('.stf__block')!;

        this.items = items;
        for (const item of items) {
            this.distElement.appendChild(item);
        }

        this.setHandlers();
    }

    public clear(): void {
        for (const item of this.items) {
            this.parentElement.appendChild(item);
        }
    }

    /**
     * Update page list from HTMLElements
     */
    public updateItems(items: NodeListOf<HTMLElement> | HTMLElement[]): void {
        this.removeHandlers();

        this.distElement.innerHTML = '';

        for (const item of items) {
            this.distElement.appendChild(item);
        }
        this.items = items;

        this.setHandlers();
    }

    public update(): void {
        this.app.getRender().update();
    }
}
