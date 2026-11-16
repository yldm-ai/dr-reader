/**
 * Files dragged in from Explorer. The shell forwards OLE drag and drop to the composition-hosted
 * page (app/src/webview.cpp DropTarget), so these are ordinary DOM drag events; the dropped File
 * objects go back to the host, which reads their native paths and filters the EPUB books.
 * Drags that carry no files (text or links from within the page) are left alone.
 */
export interface FileDropOptions {
  /** The overlay shown while files are held over the window. */
  overlay: HTMLElement;
  /** Whether a drop would be taken now (the library is showing and nothing else is busy). */
  accepts(): boolean;
  drop(files: File[]): void;
}

const carriesFiles = (event: DragEvent) => !!event.dataTransfer?.types.includes("Files");

export function installFileDrop({ overlay, accepts, drop }: FileDropOptions): void {
  const show = (visible: boolean) => { overlay.hidden = !visible; };
  const hover = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    // Always handled, so a refused drop shows the "no" cursor instead of the browser's default.
    event.preventDefault();
    const taken = accepts();
    event.dataTransfer!.dropEffect = taken ? "copy" : "none";
    show(taken);
  };
  window.addEventListener("dragenter", hover);
  window.addEventListener("dragover", hover);
  // Moving between elements also fires dragleave; only one without a next target leaves the window.
  window.addEventListener("dragleave", (event) => { if (!event.relatedTarget) show(false); });
  window.addEventListener("dragend", () => show(false));
  window.addEventListener("drop", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    show(false);
    const files = [...event.dataTransfer!.files];
    if (files.length && accepts()) drop(files);
  });
}
