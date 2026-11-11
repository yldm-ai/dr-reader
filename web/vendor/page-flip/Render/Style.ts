/**
 * dr-reader: the engine describes each page and shadow with a complete cssText on every frame.
 * Assigning cssText re-parses it and invalidates the element's style and layout even when nothing
 * changed, which is the case for every resting page and hidden shadow on every frame of a flip.
 * This skips an assignment identical to the previous one for that element; the result on screen
 * is the same, since the element already has exactly that style.
 */
const assigned = new WeakMap<HTMLElement, string>();

export function setCssText(element: HTMLElement, cssText: string): void {
    if (assigned.get(element) === cssText) return;
    assigned.set(element, cssText);
    element.style.cssText = cssText;
}
