# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release notes are plain and matter-of-fact: each entry says what changed in terms a user can check. Contributors are credited in the "Thanks" line of the release that carried their change, and in [CONTRIBUTORS.md](CONTRIBUTORS.md).

## [Unreleased]

### Added

- **UI cues** (`engine/sketchy-sound.js`): 14 short, dry cues for buttons and flows that a deck or any other web page plays with `SketchySound.play(name)`: `click`, `tap-soft`, `select`, `toggle-on`, `toggle-off`, `step-next`, `step-back`, `page-next`, `page-back`, `reveal`, `dismiss`, `sketch-done`, `celebrate` and `error-soft`. They take their pitch from the music's key and use only intervals every mood shares. Each lasts 30 to 330 ms, except `celebrate` at about 0.8 s. The frequent cues sit at the level of the `tap` effect and none comes near `stamp`. Each cue has a minimum gap, and two cues that start within 30 ms of each other play only the first.
- `SketchySound.cue.names`, `cue.info(name)` and `cue.render(name, opts)`: the list of cues, each cue's declared length and gap, and an offline render of one cue for a WAV file or for checking a port.
- `SketchySound.hotkey = false` stops the `s` key from toggling sound, for a host app with its own mute control.
- `dev/check-cues.mjs`: renders every cue offline in headless Chromium and fails on NaN, a peak at or above 0.9, a length outside the declared span, sound in the 50 ms after it, a cut end, a second render that differs, or two near-identical cues. It also plays every cue through the live path. `--wav <dir>` writes the cues as WAV files.
- `references/sound.md`: the cue table and a section on using the cues in a host app (unlock on the first gesture, the user's mute preference, rate limits, short cues). `dev/sound-test.html` has a button for every cue.

### Changed

- Effects on a page without music could lag behind a click, because the audio context asked the browser for playback latency. A page without `data-music` now asks for interactive latency. Pages with music keep the larger buffers.
- The swept-noise voice inside the engine takes an optional low-pass. The existing effects do not use it, and they and the music render the same samples as before.

The cue design was informed by studying UI SFX (https://github.com/romainsimon/uisfx, MIT code, CC0 audio by Yuki Capital): semantic cue names, short dry envelopes, frequent cues quieter than outcomes, per-cue rate limits. No code or audio was copied.

Known issue: the cues were checked by measurement (levels, lengths, tails, similarity) in Chromium only. The listening pass on a phone speaker, a laptop and headphones has not been done yet, and Safari and Firefox were not tested.

## [0.1.0] - 2026-10-25

First public release.

### Added

- **The skill** (`skills/sketchy/`): one workflow for decks, lessons, one-page reports, charts, decision boards, postcards and videos. Brief, deal a style, storyboard in text, build, check by looking, subtract, export. Nine verbs: `deck`, `explain`, `report`, `chart`, `board`, `postcard`, `video`, `audit`, `theme`.
- **The pencil engine** (`engine/sketchy.js`, `sketchy.css`): seeded hand-drawn geometry, double strokes, coloured-pencil hatching and cross-hatching, graphite grain, lines that boil at 10 frames per second (2 with reduced motion), paper with grain and fibers, a sky of pencil specks, decorators for frames, buttons, underlines, rings and highlights, and postal objects: covers with an elastic band, labels, rubber stamps, postmarks, perforated postage stamps, slips, receipts, tape labels and postcards.
- **109 sketches** of things (business, people, tech, teaching, health and life science, postal and space), drawn in four boil variants each.
- **17 chart types** (`engine/sketchy-charts.js`): bar, horizontal bar, stacked, grouped, line, area, pie, donut, scatter, slope, waffle, tally, gauge, timeline, funnel, big number and ledger. Bars start at zero, units and sources print on the page, the plan is dashed and the record solid, and every chart writes its exact values to a hidden table.
- **A slide runtime** (`engine/sketchy-deck.js`): a 1920 x 1080 stage, page turns on the spine, a cover that swings open, 14 layouts, step reveals, receipts that print line by line, counters that count up in any locale, speaker notes, overview, keyboard and swipe, print and video modes.
- **Sound** (`engine/sketchy-sound.js`): procedural effects (pencil, page, stamp, paper, bells in key) and generative music in four moods, off until the viewer turns it on, rendered offline from the deck seed for video.
- **Six papers**: day sketchbook, night ledger, kraft, blueprint, graph and cartridge, plus a starter file for your own theme.
- **Six templates**: deck, explainer, report, chart, board and postcard. Your own themes and templates in `./.sketchy/` or `~/.sketchy/` come first.
- **Scripts**: `new`, `deal`, `build` (one self-contained file), `lint` (overflow, collisions, small type, contrast, wordy slides, placeholders, network requests), `shoot` (screenshots and a contact sheet), `export-pdf`, `export-pptx` (faithful and editable), `render-video` (frame-stepped MP4 at -16 LUFS) and `doctor`.
- **Packaging** for Claude Code (plugin with `/sketchy:setup` and `/sketchy:doctor`), Codex, Cursor and Gemini CLI, and `npx skills add OthmanAdi/sketchy` for every other agent.
- **Checks**: `scripts/check-skill.mjs` and a GitHub Actions workflow.
