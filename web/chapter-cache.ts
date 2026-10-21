/** Books are immutable by content ID. Keep only a few decoded chapters for back/forward. */
export class ChapterCache {
  private entries = new Map<string, string>();
  private bytes = 0;
  readonly maxEntries: number;
  readonly maxBytes: number;
  constructor(maxEntries = 4, maxBytes = 6 * 1024 * 1024) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }
  get(url: string): string | undefined {
    const value = this.entries.get(url);
    if (value !== undefined) {
      this.entries.delete(url);
      this.entries.set(url, value);
    }
    return value;
  }
  put(url: string, html: string): void {
    const old = this.entries.get(url);
    if (old !== undefined) { this.bytes -= old.length * 2; this.entries.delete(url); }
    const bytes = html.length * 2;
    if (bytes > this.maxBytes || this.maxEntries < 1) return;
    this.entries.set(url, html);
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= this.entries.get(oldest)!.length * 2;
      this.entries.delete(oldest);
    }
  }
}
