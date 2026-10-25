// Renders the README images from the HTML sources in this folder:
//   banner.jpg           README banner (1280 x 400 at 2x)
//   social-preview.jpg   GitHub social preview (1280 x 640, under 1 MB)
//   before-after.jpg     the default deck next to the same page in sketchy
//   gallery/*.jpg        one picture per example
// Usage: node assets/src/render.mjs   (needs the repo's pinned Playwright; run scripts/build-site.mjs first)
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const out = path.join(here, '..');
const build = path.join(here, '_build');
fs.mkdirSync(build, { recursive: true });
fs.mkdirSync(path.join(out, 'gallery'), { recursive: true });
const url = (p, q = '') => pathToFileURL(p).href + q;

const browser = await chromium.launch();
async function shot(target, file, w, h, opts = {}) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: opts.dpr || 1 });
  await p.goto(target);
  await p.evaluate(() => (window.SketchyDeck ? window.SketchyDeck.ready : document.fonts.ready));
  await p.waitForTimeout(opts.wait || 500);
  const type = file.endsWith('.png') ? 'png' : 'jpeg';
  await p.screenshot({ path: file, type, quality: type === 'jpeg' ? (opts.quality || 88) : undefined, fullPage: !!opts.full, clip: opts.clip });
  await p.close();
  console.log('wrote', path.relative(repo, file));
}

// banner and social preview
await shot(url(path.join(here, 'banner.html')), path.join(out, 'social-preview.jpg'), 1280, 640, { quality: 90 });
await shot(url(path.join(here, 'banner.html'), '?wide'), path.join(out, 'banner.jpg'), 1280, 400, { dpr: 2, quality: 90 });

// before and after
const deck = path.join(repo, 'skills', 'sketchy', 'templates', 'deck.html');
await shot(url(path.join(here, 'before.html')), path.join(build, 'before.png'), 1920, 1080);
await shot(url(deck, '?static&slide=3'), path.join(build, 'after.png'), 1920, 1080);
await shot(url(path.join(here, 'before-after.html')), path.join(out, 'before-after.jpg'), 1600, 560, { dpr: 2, quality: 86 });

// gallery: built examples (examples/*.html), one frame each
const ex = path.join(repo, 'docs', 'examples');
const gallery = [
  // one ratio for every tile (16:10) so the README grid lines up
  ['lesson.jpg', 'moon-lesson.html', '?static', 1600, 1000],
  ['report.jpg', 'q3-one-pager.html', '?static', 1600, 1000],
  ['ledger.jpg', 'cloud-ledger.html', '?static&slide=3', 1600, 1000],
  ['board.jpg', 'switch-board.html', '?static', 1600, 1000],
  ['postcard.jpg', 'release-postcard.html', '?static', 1600, 1000]
];
// the deck tile is four real slides, 2 x 2
for (const n of [1, 3, 6, 8]) await shot(url(path.join(ex, 'quarterly-post.html'), `?static&slide=${n}`), path.join(build, `deck-${n}.png`), 1920, 1080);
await shot(url(path.join(here, 'deck-tile.html')), path.join(out, 'gallery', 'deck.jpg'), 1600, 1000, { quality: 84 });
for (const [name, file, q, w, h] of gallery) {
  const src = path.join(ex, file);
  if (!fs.existsSync(src)) { console.log('skip', file, '(build the examples first)'); continue; }
  await shot(url(src, q), path.join(out, 'gallery', name), w, h, { quality: 84 });
}
await browser.close();
