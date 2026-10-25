// Builds the GitHub Pages site in docs/ from the templates and examples:
//   docs/index.html          the landing page (docs/src/index.html, inlined)
//   docs/examples/*.html     every example as one self-contained file
//   docs/gallery/*.jpg       copied from assets/gallery (run assets/src/render.mjs after this)
//   docs/social-preview.jpg  copied from assets
// Usage: node scripts/build-site.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = path.join(repo, 'skills', 'sketchy');
const build = path.join(skill, 'scripts', 'build.mjs');
const docs = path.join(repo, 'docs');

const jobs = [
  [path.join(skill, 'templates', 'deck.html'), 'examples/quarterly-post.html'],
  [path.join(skill, 'templates', 'explainer.html'), 'examples/moon-lesson.html'],
  [path.join(skill, 'templates', 'report.html'), 'examples/q3-one-pager.html'],
  [path.join(skill, 'templates', 'board.html'), 'examples/switch-board.html'],
  [path.join(skill, 'templates', 'postcard.html'), 'examples/release-postcard.html'],
  [path.join(skill, 'templates', 'chart.html'), 'examples/churn-charts.html'],
  [path.join(repo, 'examples', 'src', 'cloud-ledger.html'), 'examples/cloud-ledger.html'],
  [path.join(docs, 'src', 'index.html'), 'index.html']
];

// the landing page inlines the gallery pictures, so they must exist first
// (order: build-site, then assets/src/render.mjs, then build-site again)
const gal = path.join(repo, 'assets', 'gallery');
const haveGallery = fs.existsSync(gal) && fs.readdirSync(gal).length > 0;
if (haveGallery) {
  fs.mkdirSync(path.join(docs, 'src', 'gallery'), { recursive: true });
  for (const f of fs.readdirSync(gal)) fs.copyFileSync(path.join(gal, f), path.join(docs, 'src', 'gallery', f));
}

// search and share metadata for each live example page
const SITE = 'https://othmanadi.github.io/sketchy/';
const META = {
  'examples/quarterly-post.html': ['Board update deck, hand-drawn · sketchy', 'A 12-slide hand-drawn board update made by an AI agent with sketchy: big number, plan versus record, the bill, a decision board. Opens offline.', 'gallery/deck.jpg'],
  'examples/moon-lesson.html': ['Why the Moon changes shape: a hand-drawn lesson · sketchy', 'A sketchnote-style lesson page made with sketchy: picture first, numbered steps, the math in the margin and a check question.', 'gallery/lesson.jpg'],
  'examples/q3-one-pager.html': ['One-page report, hand-drawn · sketchy', 'A printable one-page business report made with sketchy: figures with benchmarks, plan versus record, a hand-drawn bar chart and a receipt.', 'gallery/report.jpg'],
  'examples/cloud-ledger.html': ['Cloud bill explained: night ledger deck · sketchy', 'A night-ledger slide deck made with sketchy: a cloud bill explained to a CFO with gold figures, a printed receipt and verdict stamps.', 'gallery/ledger.jpg'],
  'examples/switch-board.html': ['Keep or remove: a hand-drawn decision board · sketchy', 'A decision board made with sketchy: each feature on a plate with a pencil sketch, plain words and keep or remove buttons.', 'gallery/board.jpg'],
  'examples/release-postcard.html': ['Release postcard, hand-drawn · sketchy', 'A hand-drawn release postcard made with sketchy, with a stamp, a postmark and a DELIVERED rubber stamp.', 'gallery/postcard.jpg'],
  'examples/churn-charts.html': ['Hand-drawn charts with honest numbers · sketchy', 'Hand-drawn slope and line charts made with sketchy: exact values in a hidden table, the plan dashed, the record solid.', 'gallery/report.jpg']
};
const esc = (t) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
function addMeta(file, rel) {
  const m = META[rel];
  if (!m) return;
  let html = fs.readFileSync(file, 'utf8');
  const [title, desc, img] = m;
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`);
  html = html.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(desc)}">`);
  const head = [
    `<link rel="canonical" href="${SITE}${rel}">`,
    `<meta property="og:type" content="article">`, `<meta property="og:site_name" content="sketchy">`,
    `<meta property="og:url" content="${SITE}${rel}">`, `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`, `<meta property="og:image" content="${SITE}${img}">`,
    `<meta name="twitter:card" content="summary_large_image">`, `<meta name="twitter:image" content="${SITE}${img}">`,
    `<link rel="icon" type="image/svg+xml" href="${SITE}favicon.svg">`
  ].join('\n');
  html = html.replace('</head>', head + '\n</head>');
  // every page gets one h1 for search engines and screen readers
  if (!/<h1[\s>]/.test(html)) html = html.replace(/<body([^>]*)>/, `<body$1>\n<h1 class="sk-sr">${esc(title.split(' · ')[0])}</h1>`);
  fs.writeFileSync(file, html);
}

let failed = 0;
for (const [src, rel] of jobs) {
  if (rel === 'index.html' && !haveGallery) { console.log('skip index.html until assets/gallery exists (run assets/src/render.mjs, then this again)'); continue; }
  const out = path.join(docs, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync(process.execPath, [build, src, '-o', out], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.error('failed:', rel); continue; }
  addMeta(out, rel);
}
// gallery pictures are served next to the site for share cards
fs.mkdirSync(path.join(docs, 'gallery'), { recursive: true });
if (haveGallery) for (const f of fs.readdirSync(gal)) fs.copyFileSync(path.join(gal, f), path.join(docs, 'gallery', f));
fs.copyFileSync(path.join(repo, 'assets', 'social-preview.jpg'), path.join(docs, 'social-preview.jpg'));
console.log(failed ? `${failed} build(s) failed` : 'site built in docs/');
process.exit(failed ? 1 : 0);
