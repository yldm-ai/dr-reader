// Soft page turn benchmark: frame intervals while the sheet moves, long animation frames and
// main-thread time per turn, for a single page and a two-page spread in both directions.
// Usage: node --experimental-strip-types scripts/bench-page-turn.ts [--throttle 4] [--rounds 5] [--busy 30]
// (--busy N blocks the main thread N ms every 50 ms while a sheet moves)
// GPU compositing stays on (ANGLE/D3D11), as in WebView2, so raster costs are realistic.
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

const option = (name: string, fallback: number) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? Number(process.argv[index + 1]) : fallback;
};
const throttle = option('throttle', 1), rounds = option('rounds', 5), busy = option('busy', 0);
const fixture = 'bench_page_turn';
const edge = process.env.DR_EDGE_PATH || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!edge) throw Error('Set DR_EDGE_PATH to a Chromium/Edge executable');
const server = await createServer({ configFile: 'vite.tests.config.ts', server: { port: 0 }, logLevel: 'error' });
await server.listen();
const port = (server.httpServer!.address() as AddressInfo).port;
const browser = await chromium.launch({ executablePath: edge, headless: true,
  args: ['--disable-prefer-compositing-to-lcd-text', '--use-angle=d3d11', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const before = await metrics();
  await browser.startTracing(page, { categories: ['blink.user_timing', 'benchmark', 'cc', 'viz', 'disabled-by-default-devtools.timeline'] });
  await page.goto(`http://127.0.0.1:${port}/tests/${fixture}.html?rounds=${rounds}&busy=${busy}`);
  await page.waitForSelector('html[data-result]', { timeout: 180000, state: 'attached' });
  const after = await metrics();
  const trace = JSON.parse((await browser.stopTracing()).toString()) as { traceEvents: { name: string; ts: number; dur?: number; ph: string; args?: Record<string, any> }[] };
  // Windows between the page's turn-start and turn-end marks.
  const marks = trace.traceEvents.filter(event => event.name === 'turn-start' || event.name === 'turn-end').sort((a, b) => a.ts - b.ts);
  const windows: [number, number][] = [];
  for (let i = 0; i < marks.length - 1; i++) if (marks[i].name === 'turn-start' && marks[i + 1].name === 'turn-end') windows.push([marks[i].ts, marks[i + 1].ts]);
  const inside = (ts: number) => windows.some(([start, end]) => ts >= start && ts <= end);
  // One PipelineReporter per display frame. A frame advanced the turn when the compositor
  // animated it, or when the main thread delivered a fresh pose in time (presented_all). A
  // partial frame without a compositor animation repeated the previous pose: a visible stall.
  const reports = trace.traceEvents.filter(event => event.name === 'PipelineReporter' && event.ph !== 'e' && inside(event.ts));
  // A display frame can have several reporters (main and compositor); it counts once, by its
  // best outcome.
  const rank = { idle: 0, dropped: 1, stalled: 2, advanced: 3 } as const;
  const outcome = new Map<string, keyof typeof rank>();
  for (const event of reports) {
    const reporter = event.args?.frame_reporter ?? {};
    const state = String(reporter.state ?? '');
    const result: keyof typeof rank = state === 'STATE_DROPPED' ? 'dropped' : state === 'STATE_NO_UPDATE_DESIRED' ? 'idle'
      : reporter.has_compositor_animation || (state === 'STATE_PRESENTED_ALL' && reporter.has_main_animation) ? 'advanced' : 'stalled';
    const key = `${reporter.frame_source}:${reporter.frame_sequence}`;
    const previous = outcome.get(key);
    if (!previous || rank[result] > rank[previous]) outcome.set(key, result);
  }
  const frames = { advanced: 0, stalled: 0, dropped: 0, idle: 0 };
  for (const result of outcome.values()) frames[result]++;
  const spent = (names: string[]) => Math.round(trace.traceEvents.filter(event => names.includes(event.name) && event.ph === 'X' && inside(event.ts))
    .reduce((sum, event) => sum + (event.dur ?? 0), 0) / 1000);
  const movingMs = Math.round(windows.reduce((sum, [start, end]) => sum + end - start, 0) / 1000);
  console.log(`while moving (${windows.length} turns, ${movingMs} ms): frames ${JSON.stringify(frames)}; main thread ${spent(['ProxyMain::BeginMainFrame'])} ms (style+layout ${spent(['LocalFrameView::RunStyleAndLayoutLifecyclePhases'])}, paint ${spent(['LocalFrameView::RunPaintLifecyclePhase'])}, commit ${spent(['Commit'])}); raster ${spent(['RasterTask'])} ms; GPU ${spent(['GPUTask'])} ms`);
  if (await page.locator('html').getAttribute('data-result') !== 'pass') throw Error(await page.locator('#result').textContent() ?? 'failed');
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return info ? gl!.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  const ms = (key: string) => Math.round((after[key] - before[key]) * 1000);
  console.log(`renderer: ${renderer}; CPU throttle ${throttle}x; main thread blocked ${busy} ms per 50 ms; ${rounds} rounds per case`);
  const table = await page.evaluate(() => (window as unknown as { benchResult?: object }).benchResult);
  if (table) console.table(table);
  console.log(`main thread over the whole run: script ${ms('ScriptDuration')} ms, style ${ms('RecalcStyleDuration')} ms (${after.RecalcStyleCount - before.RecalcStyleCount} recalcs), layout ${ms('LayoutDuration')} ms (${after.LayoutCount - before.LayoutCount} layouts), tasks ${ms('TaskDuration')} ms`);
} finally {
  await browser.close();
  await server.close();
}
