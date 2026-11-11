// Compares page-flip poses drawn by the vendored engine with another checkout's engine (by
// default the original StPageFlip package): same pages, same flip points, pixel by pixel.
// Usage: node --experimental-strip-types scripts/bench-flip-pose.ts <other-checkout> [module]
//   module: what that checkout imports, default 'page-flip/dist/js/page-flip.module.js'
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { existsSync, realpathSync } from 'node:fs';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

const other = process.argv[2];
if (!other) throw Error('usage: bench-flip-pose.ts <other-checkout> [module]');
const trees = [
  // Long path: Vite's file-serving allow list does not match 8.3 short names.
  { name: 'before', root: realpathSync.native(resolve(other)), module: process.argv[3] ?? 'page-flip/dist/js/page-flip.module.js' },
  { name: 'after', root: resolve('.'), module: '/web/vendor/page-flip/PageFlip.ts' },
];
const edge = process.env.DR_EDGE_PATH || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!edge) throw Error('Set DR_EDGE_PATH to a Chromium/Edge executable');
const cases = [];
for (const spread of [0, 1]) for (const density of ['soft', 'hard']) for (const direction of ['forward', 'back'])
  for (const corner of ['top', 'bottom']) {
    if (!spread && direction === 'back') continue; // single pages only turn forward (motion.ts replays it backwards)
    cases.push({ spread, density, direction, corner });
  }
const points = [0.1, 0.3, 0.5, 0.7, 0.9];
const template = await readFile('tests/bench_flip_pose.html', 'utf8');
const out = resolve('build/flip-pose');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: edge, headless: true, args: ['--disable-prefer-compositing-to-lcd-text'] });
const shots: Record<string, Record<string, Buffer>> = {};
try {
  for (const tree of trees) {
    const page = resolve(tree.root, 'tests/bench_flip_pose_run.html');
    await writeFile(page, template.replace('PAGE_FLIP_MODULE', tree.module).replace('left: 20px', 'left: 640px'));
    const server = await createServer({ root: tree.root, configFile: resolve(tree.root, 'vite.tests.config.ts'), server: { port: 0 }, logLevel: 'error' });
    await server.listen();
    const port = (server.httpServer!.address() as AddressInfo).port;
    shots[tree.name] = {};
    try {
      for (const c of cases) {
        const tab = await browser.newPage({ viewport: { width: 1300, height: 440 } });
        await tab.goto(`http://127.0.0.1:${port}/tests/bench_flip_pose_run.html?spread=${c.spread}&density=${c.density}&direction=${c.direction}&corner=${c.corner}`);
        await tab.waitForSelector('html[data-result]', { state: 'attached' });
        for (const p of points) {
          await tab.evaluate(p => (window as unknown as { pose(p: number): void }).pose(p), p);
          await tab.waitForTimeout(60);
          const key = `${c.spread ? 'spread' : 'single'}-${c.density}-${c.direction}-${c.corner}-${p}`;
          shots[tree.name][key] = await tab.screenshot({ path: resolve(out, `${tree.name}-${key}.png`) });
        }
        await tab.close();
      }
    } finally {
      await server.close();
      await rm(page);
    }
  }
  // Pixel comparison in the browser: share of pixels whose colour differs noticeably.
  const tab = await browser.newPage();
  const rows: Record<string, string>[] = [];
  for (const key of Object.keys(shots.after)) {
    const result = await tab.evaluate(async ([a, b]) => {
      const load = async (data: string) => { const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode(); return image; };
      const [x, y] = await Promise.all([load(a), load(b)]);
      const pixels = (image: HTMLImageElement) => {
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      };
      const p = pixels(x), q = pixels(y);
      let differ = 0, worst = 0;
      for (let i = 0; i < p.length; i += 4) {
        const d = Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2]));
        worst = Math.max(worst, d);
        if (d > 24) differ++;
      }
      return { differ: differ / (p.length / 4), worst };
    }, [shots.before[key].toString('base64'), shots.after[key].toString('base64')]);
    rows.push({ pose: key, 'differing pixels': `${(result.differ * 100).toFixed(3)}%`, 'largest channel difference': String(result.worst) });
  }
  console.table(rows);
} finally {
  await browser.close();
}
