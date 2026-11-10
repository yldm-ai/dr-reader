// Globals the browser test pages (tests/native-mock.ts) and scripts/test-browser.ts share.
import type { installNativeMock } from './frontend-fixtures.ts';
import type { BookOpening } from '../web/book-opening.ts';

declare global {
  interface Window {
    nativeProbe: ReturnType<typeof installNativeMock>;
    runtimeErrors: string[];
    chapterRequests: number;
    /** Holds chapter responses back until a test releases them. */
    chapterGate?: Promise<unknown> | null;
    releaseChapter?: (value?: unknown) => void;
    shortFinalChapter?: boolean;
    chapterSwapChecks?: boolean[];
    chapterSwapObserver?: MutationObserver;
    menuTitleFlashes?: number;
    BookOpening?: typeof BookOpening;
    /** Exposed by scripts/test-browser.ts to screenshot motion frames. */
    captureMotion(label: string): Promise<void>;
    captureOpening(label: string): Promise<void>;
  }
}
export {};
