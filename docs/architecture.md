# Architecture

sketchy is a skill folder plus a small browser engine. The agent writes one HTML file per artifact (a deck, an explainer, a report, a chart, a postcard), using the engine's classes and data attributes, then runs scripts that inline everything into a self-contained file, check it, and export it.

```
skills/sketchy/
  SKILL.md                  what the agent reads first
  engine/                   the browser engine (no build step, no dependencies)
    sketchy.css             tokens, paper, type, components, motion
    sketchy.js              pencil geometry, pen API, decorators, postal objects, paper, mount
    sketches.js             the sketch catalog (small pictures of things)
    sketchy-charts.js       hand-drawn charts with honest data
    sketchy-deck.js         slide runtime: stage, navigation, page turn, print, timeline
    sketchy-sound.js        procedural sound effects and generative music
    fonts/                  Caveat and Courier Prime (SIL OFL 1.1)
  themes/                   token files: day, night and the starter for your own
  templates/                starting HTML for each artifact type
  scripts/                  build, shoot, lint, deal, export, render video, doctor
  references/               the detail the SKILL.md points to
```

Everything is seeded. A deck's `data-seed` decides every wobble, so the same deck draws the same lines in the browser, the PDF, the PPTX art and the video.

## Load order

```html
<link rel="stylesheet" href="engine/sketchy.css">
<link rel="stylesheet" href="themes/<theme>.css">          <!-- optional -->
...
<script src="engine/sketchy.js"></script>
<script src="engine/sketches.js"></script>                  <!-- optional -->
<script src="engine/sketchy-charts.js"></script>            <!-- optional -->
<script src="engine/sketchy-sound.js"></script>             <!-- optional -->
<script src="engine/sketchy-deck.js"></script>              <!-- decks only -->
<script>Sketchy.mount();</script>                            <!-- decks: SketchyDeck.mount() calls it -->
```

`scripts/build.mjs page.html -o out/page.html` inlines every local stylesheet, script and font (fonts as base64) so the result opens from `file://` with no network.

## Tokens

All colors and fonts are CSS custom properties named `--sk-*` (see `engine/sketchy.css` section 1). JavaScript reads them through `Sketchy.tokens()`, which returns `{ paper, graphite, ink, red, blue, green, yellow, orange, violet, peach, gold, cream, ... , pencils: [...] }`. A theme file overrides tokens only. Never hard-code a color in a module: take it from `tokens()`.

Pencil roles (keep them, they carry meaning):

| Token | Job |
|---|---|
| `graphite` | every line, every word by default |
| `ink` | titles and the darkest text |
| `red` | the one thing to look at: now, target, correction, the main action |
| `blue`, `green`, `yellow`, `orange`, `violet` | data series and object colors, in that order |
| `peach` | selected state wash |
| `figure` | numbers in the record (ink by day, gold by night) |

## Pen API (`engine/sketchy.js`)

```js
const p = Sketchy.pen(svgOrGroup, { seed: 'name', width: 1.5, rough: 1, passes: 2 });
p.line(x1, y1, x2, y2, o)      p.rect(x, y, w, h, o)       p.frame(x, y, w, h, o)
p.circle(cx, cy, d, o)         p.ellipse(cx, cy, w, h, o)  p.poly([[x, y], ...], o)
p.polyline(points, o)          p.curve(points, o)          p.path(d, o)
p.arrow(x1, y1, x2, y2, o)     p.text(x, y, str, o)        p.dot(x, y, d, o)
p.group(attrs) -> <g>          p.into(g)                   p.random() / p.tokens
```

Style options `o`: `stroke, width, passes (0..3), rough (0..2), opacity, fill, fillStyle ('hatch'|'cross'|'scribble'|'solid'|'none'), gap, angle, fillOpacity, dash, grain (false = no graphite filter), cls`. Text options: `anchor, size, color, weight, mono, rotate, opacity`.

Postal helpers: `Sketchy.postmark(p, cx, cy, r, topText, bottomText, o)`, `Sketchy.cancelWaves(p, x, y, w, o)`, `Sketchy.postage(p, x, y, w, h, { value, label, tint, inner(p, box) })`, `Sketchy.specks(svg, w, h, o)`.

Motion: `Sketchy.drawOn(root, { stagger, duration, delay })` traces every `.sk-path` (stroke-dashoffset on a `pathLength=1` path) and fades every `.sk-hatch`. It returns a promise. CSS transitions are used on purpose: they appear in `document.getAnimations()`, so the video renderer can pause and seek them. `Sketchy.boil(svg, fps)` redraws a sketch with alternating seeds for the hand-animated shimmer.

Decorators: any element with `data-sk="frame|button|box|underline|circle|strike|highlight|bracket"` gets a pencil overlay sized to it, redrawn on resize. `data-sk-color` picks a pencil token, `data-sk-seed` fixes the wobble.

Sketches: `<svg data-sketch="name" viewBox="0 0 140 110"></svg>` is drawn by `Sketchy.mount()` from `Sketchy.catalog`. Register more with `Sketchy.register(name, (p, C, parts) => { ... })`.

## Deck contract (`engine/sketchy-deck.js`)

```html
<html class="sk" data-theme="day" lang="en">
<body class="sk">
<main class="sk-deck" data-seed="q3-board-update" data-transition="page" data-music="sketchbook">
  <section class="sk-slide" data-layout="cover" data-duration="5" data-notes="Speaker notes here.">
    ...
  </section>
  ...
</main>
```

- Stage: every slide is laid out on a fixed 1920 x 1080 CSS px stage, scaled to fit the window and letterboxed on paper. Authors use px for slide content.
- `data-layout`: `cover | title | section | split | steps | chart | big-number | compare | quote | timeline | ledger | board | letter | end`. Layout classes live in `sketchy-deck.js`'s stylesheet block.
- `data-transition` on the deck or a slide: `page` (3D page turn, default), `slide`, `fade`, `none`.
- `data-duration` (seconds) is used by autoplay and by the video renderer. Default 6.
- `data-notes` or a child `<aside class="sk-notes-speaker">` holds speaker notes (exported to PPTX notes and the presenter view).
- Elements with `data-step` reveal one by one on click or arrow key before the slide advances (`data-step="1"`, `"2"`...).

Runtime API:

```js
SketchyDeck.mount(main?)        // returns the deck; also runs Sketchy.mount()
SketchyDeck.ready               // Promise: fonts loaded, slides measured, first slide drawn
SketchyDeck.count / .index
SketchyDeck.go(i, { instant }) / .next() / .prev()
SketchyDeck.on('change', ({ from, to }) => {})
SketchyDeck.timeline()          // [{ index, start, duration, steps }], seconds
SketchyDeck.seek(seconds)       // video: jump to that moment, set slide and animation time
```

URL parameters: `?slide=3` (1-based), `?static` (no animation, everything drawn), `?print` (all slides stacked at full size, page breaks between, for PDF), `?overview` (grid of all slides), `?autoplay`, `?presenter`.

Keyboard: arrows, PageUp/PageDown, space, Home/End, `o` overview, `f` fullscreen, `s` sound, `p` presenter. Touch: swipe. At the first or last slide the stage gives a small bump instead of doing nothing.

Events: the deck dispatches `sk:slide` on `document` with `{ index, slide }` after each change, and `sk:step` for reveals. The sound module listens to these if present.

## Charts contract (`engine/sketchy-charts.js`)

```html
<figure class="sk-chart" data-chart='{"type":"bar","title":"Revenue by quarter","unit":"€k","data":[["Q1",120],["Q2",140]]}'></figure>
```

or `<script type="application/json">` inside the figure. `SketchyCharts.render(figure, spec?)` draws it; `Sketchy.mount()` calls `SketchyCharts.renderAll(root)` when the module is loaded. The data also lands in a visually hidden `<table>` for screen readers, search and the linter.

## Sound contract (`engine/sketchy-sound.js`)

Sound is off until the viewer turns it on (a `sound` button, `data-sk-sound-toggle`, or the `s` key); the choice is remembered in `localStorage['sketchy:sound']`.

```js
SketchySound.enable() / .disable() / .toggle() / .isOn
SketchySound.play(name, { gain, pan, pitch })        // 'pencil','scribble','page','flip','stamp','tap','tick','pop','whoosh','bell','chime','success','fail','paper'
                                                     // and the UI cues in SketchySound.cue.names: 'click','tap-soft','select','toggle-on', ...
SketchySound.cue.info(name)                          // -> { name, min, max, gap } in seconds
SketchySound.cue.render(name, { seed, key, level, vary })  // -> Promise<AudioBuffer>, one cue, dry, no master chain
SketchySound.hotkey = false                          // the s key stops toggling sound (for a host app with its own mute)
SketchySound.music.start({ mood, seed })            // generative; mood: 'sketchbook' | 'ledger' | 'focus' | 'calm'
SketchySound.music.section('calm' | 'build' | 'flight' | 'resolve')
SketchySound.music.stop()
SketchySound.renderOffline({ duration, seed, mood, cues: [{ t, name, opts }], sections: [{ t, name }], sampleRate })
  // -> Promise<AudioBuffer>; same seed, same music, sample for sample
SketchySound.toWav(audioBuffer)                      // -> ArrayBuffer (16-bit PCM)
```

## Scripts (`skills/sketchy/scripts/`)

All Node 18+, ES modules, no dependencies except `playwright` (pinned in the repo's `package.json`; the scripts tell you how to install it when it is missing).

| Script | Does |
|---|---|
| `build.mjs <in.html> -o <out.html>` | inline CSS, JS and fonts into one self-contained file |
| `shoot.mjs <file.html> [--out dir]` | screenshot every slide (or the page) at 1920 x 1080 and 390 x 844, write a contact sheet, report console errors |
| `lint.mjs <file.html>` | sketch-lint: overflow, overlapping text, text under strokes, small type, contrast of graphite on paper, words per slide, missing fonts, missing seed, placeholder text; exits 1 on errors |
| `deal.mjs [--brief "..."]` | deal a paper, cover, pencil set, motif and layout anatomy so decks do not converge; remembers recent draws in `~/.sketchy/draws.json` |
| `export-pdf.mjs <deck.html>` | vector PDF via `?print` |
| `export-pptx.mjs <deck.html> [--mode faithful|editable]` | dual layer: slide art as an image, real text boxes and speaker notes on top |
| `render-video.mjs <deck.html> [--fps 30]` | frame-stepped capture with a virtual clock, offline-rendered sound and music, FFmpeg mux, loudness -16 LUFS |
| `doctor.mjs` | checks Node, Playwright and its Chromium, FFmpeg, fonts, write access; prints the exact fix for each failure |

## User themes and templates

The skill looks for the user's own material before its built-ins:

1. `./.sketchy/themes/*.css` and `./.sketchy/templates/*.html` in the current project
2. `~/.sketchy/themes/*.css` and `~/.sketchy/templates/*.html` for the user
3. `skills/sketchy/themes/` and `skills/sketchy/templates/`

A theme is a token file (copy `themes/_starter.css`). A template is an HTML file built from the engine's classes; `<!-- slot:name -->` comments mark where the agent writes content.
