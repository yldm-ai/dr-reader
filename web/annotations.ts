import { fluentGlyph } from "./icons.ts";
import { materialPaths } from "./material-icons.ts";
import { paint } from "./highlight-colors.ts";
import type { Annotation } from "./types.ts";

export interface NoteMark { id: string; range: Range; note: string; ink: string }
interface ColoredRange { range: Range; color: string }
/** The pointer coordinates (and target) the layer hit-tests; any MouseEvent provides them. */
export type PointerLike = Pick<MouseEvent, "clientX" | "clientY"> & { target?: EventTarget | null };
export type ShellRect = Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height">;

export class AnnotationLayer {
  doc: Document;
  ranges = new Map<string, Range>();
  colorStyles = new Map<string, HTMLStyleElement>();
  highlightRanges: ColoredRange[] = [];
  underlineRanges: ColoredRange[] = [];
  notes: NoteMark[] = [];
  layerNames: string[] = [];
  tipLayer: HTMLElement | null = null;

  constructor(doc: Document) {
    this.doc = doc;
  }

  /** The chapter frame's window: its CSS.highlights registry and Highlight class paint this document. */
  private get view(): Window & typeof globalThis {
    return this.doc.defaultView as Window & typeof globalThis;
  }

  /** `paper` is the reading palette: highlight fills and underline inks depend on it. */
  set(annotations: Annotation[], locate: (annotation: Annotation) => Range | null, paper = { paper: "#ffffff", dark: false }): void {
    this.clear();
    if (!this.view.CSS?.highlights) return;
    this.highlightRanges = [];
    this.underlineRanges = [];
    this.notes = [];
    for (const annotation of annotations) {
      const range = locate(annotation);
      if (!range) continue;
      this.ranges.set(annotation.id, range);
      const colors = paint(annotation.color, paper.paper, paper.dark);
      if (annotation.note)
        this.notes.push({ id: annotation.id, range, note: annotation.note, ink: colors.ink });
      // Note-only annotations have no mark; their tip alone shows where the note is.
      if (annotation.style === "note") continue;
      const underline = annotation.style === "underline";
      (underline ? this.underlineRanges : this.highlightRanges).push({
        range,
        color: underline ? colors.ink : colors.fill,
      });
    }
    this.installColorLayers();
    this.placeTips();
  }

  /**
   * Puts a small tip icon at the top-right corner of the end of every passage with a note. The
   * icons live outside <body> (like the page tail), carry no text so anchors and search are
   * unaffected, and are in document coordinates so they move with the page and its snapshots.
   */
  placeTips(): void {
    this.tipLayer?.remove();
    this.tipLayer = null;
    if (!this.notes.length) return;
    const doc = this.doc;
    const view = this.view;
    const pixelRatio = view.devicePixelRatio || 1;
    const snap = (value: number) => Math.round(value * pixelRatio) / pixelRatio;
    let style = doc.getElementById("dr-note-tip-style");
    if (!style) {
      style = doc.createElement("style");
      style.id = "dr-note-tip-style";
      doc.head.append(style);
    }
    const glyph = fluentGlyph('tip');
    const family = glyph?.font === 'mdl2' ? '"Segoe MDL2 Assets"' : glyph?.font === 'fluent' ? '"Segoe Fluent Icons"' : '"Segoe Fluent Icons","Segoe MDL2 Assets"';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="${materialPaths.chat_bubble}"/></svg>`;
    const content = glyph ? `content:"\\${glyph.code.toString(16)}"!important;font-family:${family}!important;`
      : `content:""!important;background:currentColor!important;mask:url("data:image/svg+xml,${encodeURIComponent(svg)}") center/contain no-repeat!important;`;
    const css = `.dr-note-tips{position:absolute!important;left:0!important;top:0!important;width:0!important;height:0!important;overflow:visible!important;z-index:7!important;pointer-events:none!important}
.dr-note-tip{position:absolute!important;display:block!important;width:14px!important;height:14px!important;box-sizing:border-box!important;pointer-events:auto!important;margin:0!important;padding:0!important;color:var(--dr-tip,#dfab01)!important;cursor:pointer!important;user-select:none!important;-webkit-user-select:none!important;opacity:1!important}
.dr-note-tip::before{display:block!important;width:14px!important;height:14px!important;font:normal 400 14px/14px ${family}!important;letter-spacing:0!important;text-indent:0!important;text-transform:none!important;text-align:center!important;${content}}`;
    if (style.textContent !== css) style.textContent = css;
    const layer = doc.createElement("div");
    layer.className = "dr-note-tips";
    layer.setAttribute("aria-hidden", "true");
    for (const note of this.notes) {
      const rects = [...note.range.getClientRects()].filter((rect) => rect.width && rect.height);
      const end = rects.at(-1);
      if (!end) continue;
      const tip = doc.createElement("span");
      tip.className = "dr-note-tip";
      tip.dataset.id = note.id;
      tip.style.setProperty("--dr-tip", note.ink);
      tip.style.left = `${snap(end.right + view.scrollX - 3)}px`;
      tip.style.top = `${snap(end.top + view.scrollY - 9)}px`;
      layer.append(tip);
    }
    doc.documentElement.append(layer);
    this.tipLayer = layer;
  }

  /** Takes the tips out of the layout while pages are measured; `placeTips` brings them back. */
  hideTips(): void {
    this.tipLayer?.remove();
    this.tipLayer = null;
  }

  /** The note under the pointer: on its tip, or anywhere on the noted passage. */
  noteAtPoint(event: PointerLike): NoteMark | null {
    const tip = (event.target as Element | null | undefined)?.closest?.<HTMLElement>(".dr-note-tip");
    for (const note of this.notes) {
      if (tip?.dataset.id === note.id) return note;
      for (const rect of note.range.getClientRects())
        if (event.clientX >= rect.left && event.clientX <= rect.right &&
            event.clientY >= rect.top && event.clientY <= rect.bottom)
          return note;
    }
    return null;
  }

  installColorLayers(): void {
    for (const style of this.colorStyles.values()) style.remove();
    this.colorStyles.clear();
    for (const name of this.layerNames)
      this.view.CSS.highlights.delete(name);
    this.layerNames = [];
    for (const [kind, values] of [
      ["highlight", this.highlightRanges],
      ["underline", this.underlineRanges],
    ] as const) {
      const byColor = new Map<string, Range[]>();
      for (const value of values) {
        if (!byColor.has(value.color)) byColor.set(value.color, []);
        byColor.get(value.color)!.push(value.range);
      }
      for (const [color, ranges] of byColor) {
        const name = `dr-${kind}-${[...byColor.keys()].indexOf(color)}`;
        this.layerNames.push(name);
        const highlight = new this.view.Highlight(...ranges);
        this.view.CSS.highlights.set(name, highlight);
        const style = this.colorStyles.get(name) || this.doc.createElement("style");
        style.textContent =
          kind === "highlight"
            ? `::highlight(${name}) { background-color: ${color}; }`
            : `::highlight(${name}) { text-decoration: underline 2px ${color}; text-underline-offset: 3px; }`;
        if (!style.isConnected) this.doc.head.append(style);
        this.colorStyles.set(name, style);
      }
    }
  }

  clear(): void {
    this.ranges.clear();
    this.notes = [];
    this.hideTips();
    for (const style of this.colorStyles.values()) style.remove();
    this.colorStyles.clear();
    for (const name of this.layerNames)
      this.view.CSS?.highlights?.delete(name);
    this.layerNames = [];
  }

  /** The range's bounds in the shell window's coordinates. */
  rect(range: Range | null | undefined): ShellRect | null {
    if (!range) return null;
    const value = range.getBoundingClientRect();
    if (!value.width && !value.height) return null;
    const frame = this.view.frameElement!.getBoundingClientRect();
    return {
      left: frame.left + value.left,
      right: frame.left + value.right,
      top: frame.top + value.top,
      bottom: frame.top + value.bottom,
      width: value.width,
      height: value.height,
    };
  }

  rangeAtPoint(event: PointerLike | null | undefined): { id: string; range: Range } | null {
    if (!event) return null;
    const position = this.doc.caretPositionFromPoint?.(
      event.clientX,
      event.clientY,
    );
    if (!position) {
      const range = this.doc.caretRangeFromPoint?.(
        event.clientX,
        event.clientY,
      );
      if (range)
        for (const [id, candidate] of this.ranges)
          if (candidate.isPointInRange(range.startContainer, range.startOffset))
            return { id, range: candidate };
      return null;
    }
    for (const [id, candidate] of this.ranges)
      if (candidate.isPointInRange(position.offsetNode, position.offset))
        return { id, range: candidate };
    return null;
  }
}
