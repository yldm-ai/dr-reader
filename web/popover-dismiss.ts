/** An outside click dismisses the flyout without activating the control underneath. */
export function dismissPopoverOnOutsidePointer(root: HTMLElement, close: () => void): void {
  let dismissed: { id: number } | undefined;
  window.addEventListener('pointerdown', event => {
    dismissed = undefined;
    if (!root.matches(':popover-open') || root.contains(event.target as Node) || event.button !== 0) return;
    close();
    dismissed = { id: event.pointerId };
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  window.addEventListener('pointerup', event => {
    if (dismissed?.id !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  window.addEventListener('click', event => {
    const pointer = dismissed;
    dismissed = undefined;
    if (!pointer || event.detail === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  window.addEventListener('pointercancel', () => { dismissed = undefined; }, true);
}
