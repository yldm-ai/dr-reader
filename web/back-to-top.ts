/** A quiet library shortcut that follows the scroll container, including filtered results. */
export class LibraryBackToTop {
  constructor(viewport: HTMLElement, button: HTMLButtonElement, heading: HTMLElement) {
    const update = () => {
      const visible = viewport.scrollTop > Math.max(240, viewport.clientHeight * 0.6);
      button.classList.toggle('visible', visible);
      button.inert = !visible;
      button.setAttribute('aria-hidden', String(!visible));
    };
    viewport.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    for (const content of viewport.querySelectorAll('#book-grid, #shelf-grid, #empty-state')) observer.observe(content);
    button.addEventListener('click', () => {
      // Keep keyboard navigation at the destination after the shortcut disappears.
      if (button.matches(':focus-visible')) heading.focus({ preventScroll: true });
      const animate = document.body.dataset.animations !== 'false' &&
        !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      viewport.scrollTo({ top: 0, behavior: animate ? 'smooth' : 'instant' });
    });
    update();
  }
}
