import { paint } from "./highlight-colors.ts";
export class AnnotationLayer {
  constructor(doc, callbacks = {}) {
    this.doc = doc;
    this.callbacks = callbacks;
    this.ranges = new Map();
    this.installStyles();
  }

  installStyles() {
    this.colorStyles = new Map();
  }

  /** `paper` is the reading palette: highlight fills and underline inks depend on it. */
  set(annotations, locate, paper = { paper: "#ffffff", dark: false }) {
    this.clear();
    if (!this.doc.defaultView.CSS?.highlights) return;
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
  placeTips() {
    this.tipLayer?.remove();
    this.tipLayer = null;
    if (!this.notes?.length) return;
    const doc = this.doc;
    const view = doc.defaultView;
    const pixelRatio = view.devicePixelRatio || 1;
    const snap = (value) => Math.round(value * pixelRatio) / pixelRatio;
    if (!doc.getElementById("dr-note-tip-style")) {
      const style = doc.createElement("style");
      style.id = "dr-note-tip-style";
      style.textContent = `.dr-note-tips{position:absolute!important;left:0!important;top:0!important;width:0!important;height:0!important;margin:0!important;padding:0!important;border:0!important}
.dr-note-tip{position:absolute!important;display:block!important;width:14px!important;height:14px!important;margin:0!important;padding:0!important;color:var(--dr-tip,#dfab01)!important;cursor:pointer!important;user-select:none!important;-webkit-user-select:none!important;opacity:1!important}
.dr-note-tip::before{content:"\\e8bd"!important;display:block!important;width:14px!important;height:14px!important;font:normal 400 14px/14px "Segoe Fluent Icons","Segoe MDL2 Assets"!important;letter-spacing:0!important;text-indent:0!important;text-transform:none!important;text-align:center!important}`;
      doc.head.append(style);
    }
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
  hideTips() {
    this.tipLayer?.remove();
    this.tipLayer = null;
  }

  /** The note under the pointer: on its tip, or anywhere on the noted passage. */
  noteAtPoint(event) {
    const tip = event.target?.closest?.(".dr-note-tip");
    for (const note of this.notes || []) {
      if (tip?.dataset.id === note.id) return note;
      for (const rect of note.range.getClientRects())
        if (event.clientX >= rect.left && event.clientX <= rect.right &&
            event.clientY >= rect.top && event.clientY <= rect.bottom)
          return note;
    }
    return null;
  }

  installColorLayers() {
    this.layerNames ||= [];
    for (const style of this.colorStyles.values()) style.remove();
    this.colorStyles.clear();
    for (const name of this.layerNames)
      this.doc.defaultView.CSS.highlights.delete(name);
    this.layerNames = [];
    for (const [kind, values] of [
      ["highlight", this.highlightRanges],
      ["underline", this.underlineRanges],
    ]) {
      const byColor = new Map();
      for (const value of values) {
        if (!byColor.has(value.color)) byColor.set(value.color, []);
        byColor.get(value.color).push(value.range);
      }
      for (const [color, ranges] of byColor) {
        const name = `dr-${kind}-${[...byColor.keys()].indexOf(color)}`;
        this.layerNames.push(name);
        const highlight = new this.doc.defaultView.Highlight(...ranges);
        this.doc.defaultView.CSS.highlights.set(name, highlight);
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

  clear() {
    this.ranges.clear();
    this.notes = [];
    this.hideTips();
    for (const style of this.colorStyles?.values() || []) style.remove();
    this.colorStyles?.clear();
    for (const name of this.layerNames || [])
      this.doc.defaultView.CSS?.highlights?.delete(name);
    this.layerNames = [];
  }

  rect(range) {
    if (!range) return null;
    const value = range.getBoundingClientRect();
    if (!value.width && !value.height) return null;
    const frame = this.doc.defaultView.frameElement.getBoundingClientRect();
    return {
      left: frame.left + value.left,
      right: frame.left + value.right,
      top: frame.top + value.top,
      bottom: frame.top + value.bottom,
      width: value.width,
      height: value.height,
    };
  }

  rangeAtPoint(event) {
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
