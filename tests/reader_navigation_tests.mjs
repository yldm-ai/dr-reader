import assert from 'node:assert/strict';
import { test } from 'node:test';

// Exercise the reader's navigation without native storage or a WebView window.
globalThis.window = {};
globalThis.document = {
  // Every stub element doubles as a 700×600 book page at the window origin.
  getElementById: () => ({ hidden: false, getBoundingClientRect: () => ({ left: 0, top: 0, width: 700, height: 600 }) }),
  querySelector: () => null,
};
const { Reader } = await import('../web/reader.js');

function reader() {
  const value = Object.create(Reader.prototype);
  const view = { innerWidth: 700, scrollX: 0, scrollTo(x) { this.scrollX = x; } };
  Object.assign(value, {
    doc: { defaultView: view }, generation: 1, navigationRevision: 0, settings: { mode: 'paged' },
    turnQueue: Promise.resolve(), page: 0, pages: 8, chapter: 0,
    book: { chapters: [{}, {}] }, loading: false, reflowing: false,
    hideSelection() {},
    report() { this.page = Math.round(view.scrollX / view.innerWidth); },
    corners: [],
    async animatePageChange(direction, update, corner) {
      this.corners.push(corner);
      await new Promise(resolve => setTimeout(resolve, 5));
      update();
    },
  });
  return value;
}
function wheel(deltaY, extra = {}) {
  return { deltaX: 0, deltaY, clientY: 100, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
}

test('the wheel curls a soft page from the corner on the half under the pointer', async () => {
  const value = reader();
  await value.wheel(wheel(120, { clientY: 120 }));
  await value.wheel(wheel(120, { clientY: 480 }));
  await value.wheel(wheel(-120, { clientY: 599 }));
  assert.deepEqual(value.corners, ['top', 'bottom', 'bottom']);
});

test('each wheel event turns exactly one page regardless of scroll distance', async () => {
  const value = reader();
  for (const delta of [1, 120, 960]) {
    const event = wheel(delta);
    const previous = value.page;
    await value.wheel(event);
    assert.equal(value.page, previous + 1);
    assert.equal(event.prevented, true);
  }
  await value.wheel(wheel(-120));
  assert.equal(value.page, 2);
});

test('consecutive notches complete in order instead of cancelling animations', async () => {
  const value = reader();
  await Promise.all([120, 120, 120, -120].map(delta => value.wheel(wheel(delta))));
  assert.equal(value.page, 2);
});

test('wheel backlog speeds up motion but waits for each visible page to finish', async () => {
  const value = reader();
  const pages = [], speeds = [];
  let finish;
  value.animatePageChange = async (direction, update) => { update(); pages.push(value.doc.defaultView.scrollX / 700); };
  value.motion = {
    setSpeed(speed) { speeds.push(speed); },
    finished() { return new Promise(resolve => { finish = resolve; }); },
  };
  const turns = [120, 120, 120, -120].map(delta => value.wheel(wheel(delta)));
  for (const [index, page] of [1, 2, 3, 2].entries()) {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(value.page, page);
    assert.equal(pages.length, index + 1, 'later pages must wait for the current animation');
    finish();
  }
  await Promise.all(turns);
  assert.deepEqual(pages, [1, 2, 3, 2]);
  assert.ok(Math.max(...speeds) > 1);
  assert.ok(Math.max(...speeds) <= 10);
  assert.equal(speeds.at(-1), 1);
});

test('scroll mode, zoom gestures and zero deltas retain their default behavior', async () => {
  const value = reader();
  const zoom = wheel(120, { ctrlKey: true });
  await value.wheel(zoom);
  assert.equal(zoom.prevented, false);
  const zero = wheel(0);
  await value.wheel(zero);
  assert.equal(zero.prevented, false);
  value.settings.mode = 'scroll';
  const scroll = wheel(120);
  await value.wheel(scroll);
  assert.equal(scroll.prevented, false);
  assert.equal(value.page, 0);
});

test('pending turns cannot affect an explicit navigation or a different reading mode', async () => {
  const value = reader();
  const queued = value.wheel(wheel(120));
  value.navigationRevision++;
  await queued;
  assert.equal(value.page, 0);
  const modeChange = value.wheel(wheel(120));
  value.settings.mode = 'scroll';
  await modeChange;
  assert.equal(value.page, 0);
});

test('wheel notches survive a chapter boundary, including input during loading', async () => {
  const value = reader();
  value.page = 7;
  let finishLoad;
  let started;
  const loading = new Promise(resolve => { started = resolve; });
  value.load = async function(chapter) {
    this.loading = true;
    this.generation++;
    started();
    await new Promise(resolve => { finishLoad = resolve; });
    this.chapter = chapter;
    this.doc = { defaultView: this.doc.defaultView };
    this.doc.defaultView.scrollTo(0);
    this.page = 0;
    this.loading = false;
  };
  const turns = [value.wheel(wheel(120)), value.wheel(wheel(120))];
  await loading;
  turns.push(value.wheel(wheel(120)), value.wheel(wheel(120)), value.wheel(wheel(-120)));
  finishLoad();
  await Promise.all(turns);
  assert.equal(value.chapter, 1);
  assert.equal(value.page, 2);
  assert.equal(value.corners.length, 4);
});

test('forward at chapter end and backward at chapter start navigate chapters', async () => {
  const value = reader();
  const loads = [];
  value.load = async (...args) => { loads.push(args); };
  value.page = 7;
  await value.wheel(wheel(120));
  assert.deepEqual(loads[0], [1, 0, '', '', '', 1, 'top']);
  value.page = 0;
  value.chapter = 1;
  await value.wheel(wheel(-120, { clientY: 500 }));
  assert.deepEqual(loads[1], [0, 1, '', '', '', -1, 'bottom']);
});
