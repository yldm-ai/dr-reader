type WheelInput = Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'> & { momentum?: boolean };

/** Wheel events expose units, not device identity. Group smooth pixel streams into gestures. */
export class WheelPaging {
  private lastTime = -Infinity;
  private direction = 0;
  private distance = 0;
  private continuous = false;
  private consumed = false;

  accept(event: WheelInput, now = performance.now()): number {
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!Number.isFinite(delta) || !delta) return 0;
    const direction = Math.sign(delta), magnitude = Math.abs(delta);
    // Line/page units describe discrete wheel steps, independently of pixel gesture grouping.
    if (event.deltaMode === 1 || event.deltaMode === 2) {
      this.lastTime = -Infinity;
      return direction;
    }
    const gap = now - this.lastTime;
    const notch = magnitude >= 40 && (magnitude % 100 === 0 || magnitude % 120 === 0);
    if (gap > 220 || gap < 0 || this.direction !== direction) {
      this.distance = 0;
      this.consumed = false;
      this.continuous = !notch;
    } else if (!notch || gap < 36) {
      this.continuous = true;
    }
    this.lastTime = now;
    this.direction = direction;
    // Honour an explicit inertia flag when provided by the browser/platform.
    if (event.momentum) {
      this.continuous = true;
      this.consumed = true;
      return 0;
    }
    if (this.continuous) {
      if (this.consumed) return 0;
      this.distance += magnitude;
      if (this.distance < 28) return 0;
    }
    this.consumed = true;
    return direction;
  }
}
