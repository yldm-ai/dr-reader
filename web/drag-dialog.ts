/** Drag a dialog from its heading or title strip without changing the cursor. */
export function dragDialog(dialog: HTMLDialogElement, handleSelector: string): void {
  let drag: { id: number; x: number; y: number; left: number; top: number; moved: boolean } | undefined;
  let suppressClick = false;
  const position = (left: number, top: number) => {
    dialog.style.inset = 'auto';
    dialog.style.margin = '0';
    dialog.style.left = `${Math.max(8, Math.min(left, innerWidth - dialog.offsetWidth - 8))}px`;
    dialog.style.top = `${Math.max(8, Math.min(top, innerHeight - dialog.offsetHeight - 8))}px`;
  };
  const finish = () => {
    const id = drag?.id;
    if (drag?.moved) suppressClick = true;
    drag = undefined;
    if (id !== undefined && dialog.hasPointerCapture(id)) dialog.releasePointerCapture(id);
  };
  dialog.addEventListener('pointerdown', event => {
    suppressClick = false;
    const target = event.target as Element;
    if (event.button !== 0 || !target.closest(handleSelector) || target.closest('button, a, input, select, textarea')) return;
    event.preventDefault();
    const rect = dialog.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
    dialog.setPointerCapture(event.pointerId);
  });
  dialog.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    drag.moved ||= Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 3;
    position(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
  });
  dialog.addEventListener('click', event => {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) dialog.addEventListener(type, finish);
  dialog.addEventListener('close', () => {
    finish();
    suppressClick = false;
    for (const property of ['inset', 'margin', 'left', 'top']) dialog.style.removeProperty(property);
  });
  window.addEventListener('resize', () => {
    if (dialog.open && dialog.style.left) position(parseFloat(dialog.style.left), parseFloat(dialog.style.top));
  });
}
