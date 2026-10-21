const COLORS = {
  yellow: "rgba(207, 162, 76, .42)",
  green: "rgba(108, 155, 125, .34)",
  blue: "rgba(107, 159, 197, .34)",
  pink: "rgba(195, 125, 160, .30)",
  purple: "rgba(161, 138, 194, .30)",
};

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

  set(annotations, locate) {
    this.clear();
    if (!this.doc.defaultView.CSS?.highlights) return;
    this.highlightRanges = [];
    this.underlineRanges = [];
    for (const annotation of annotations) {
      const range = locate(annotation);
      if (!range) continue;
      this.ranges.set(annotation.id, range);
      (annotation.style === "underline"
        ? this.underlineRanges
        : this.highlightRanges
      ).push({
        range,
        color: COLORS[annotation.color] || COLORS.yellow,
      });
    }
    this.installColorLayers();
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
    for (const style of this.colorStyles?.values() || []) style.remove();
    this.colorStyles?.clear();
    for (const name of this.layerNames || [])
      this.doc.defaultView.CSS?.highlights?.delete(name);
    this.layerNames = [];
  }

  colorAtPoint(event) {
    for (const [kind, values] of [
      ["highlight", this.highlightRanges],
      ["underline", this.underlineRanges],
    ])
      for (const value of values || [])
        for (const rect of value.range.getClientRects())
          if (
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom
          )
            return { kind, color: value.color };
    return null;
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
