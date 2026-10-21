declare module 'page-flip/dist/js/page-flip.module.js' {
  interface Page {
    setDensity(value: 'soft' | 'hard'): void;
    setDrawingDensity(value: 'soft' | 'hard'): void;
    newTemporaryCopy(): Page;
  }
  export class PageFlip {
    constructor(element: HTMLElement, settings: Record<string, string | number | boolean>);
    on(event: string, callback: (event: { data: unknown }) => void): this;
    off(event: string): void;
    loadFromHTML(pages: HTMLElement[]): void;
    getPage(index: number): Page;
    getRender(): {
      drawFrame(): void;
      startAnimation(frames: (() => void)[], duration: number, onAnimateEnd: () => void): void;
    };
    getPageCount(): number;
    getOrientation(): 'portrait' | 'landscape';
    getCurrentPageIndex(): number;
    flipNext(corner: 'top' | 'bottom'): void;
    flipPrev(corner: 'top' | 'bottom'): void;
    destroy(): void;
  }
}
