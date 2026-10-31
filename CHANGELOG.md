# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release notes are plain and matter-of-fact: each entry says what changed in terms a user can check. Contributors are credited in the "Thanks" line of the release that carried their change, and in [CONTRIBUTORS.md](CONTRIBUTORS.md).

## [Unreleased]

### Added

- **UI cues** (`engine/sketchy-sound.js`): 14 short, dry cues for buttons and flows that a deck or any other web page plays with `SketchySound.play(name)`: `click`, `tap-soft`, `select`, `toggle-on`, `toggle-off`, `step-next`, `step-back`, `page-next`, `page-back`, `reveal`, `dismiss`, `sketch-done`, `celebrate` and `error-soft`. They take their pitch from the music's key and use only intervals every mood shares. Each lasts 30 to 330 ms, except `celebrate` at about 0.8 s. The frequent cues sit under the quietest deck effect, `tick`, and none comes near `stamp`. Each cue has a minimum gap, and two cues that start within 30 ms of each other play only the first.
- `SketchySound.cue.names`, `cue.info(name)` and `cue.render(name, opts)`: the list of cues, each cue's declared length and gap, and an offline render of one cue for a WAV file or for checking a port.
- `SketchySound.hotkey = false` stops the `s` key from toggling sound, for a host app with its own mute control.
- `dev/check-cues.mjs`: renders every cue offline in headless Chromium and fails on NaN, a peak at or above 0.9, a length outside the declared span, sound in the 50 ms after it, a cut end, a second render that differs, or two near-identical cues. It also plays every cue through the live path. `--wav <dir>` writes the cues as WAV files.
- `references/sound.md`: the cue table and a section on using the cues in a host app (unlock on the first gesture, the user's mute preference, rate limits, short cues). `dev/sound-test.html` has a button for every cue.
- **Textures** (`engine/sketchy-sound.js`): a pen that follows the line, soft key taps under typed text and a quiet swell of paper air, through `SketchySound.texture.pen`, `.typing`, `.air`, `.cancel`, `.stopAll` and `.state`. The pen's speed comes from the stroke's own easing, so it slows as the line on screen does; an ellipse swings its band and pans around, a check mark lifts between its legs, boxes and polygons tick at the corners. One lane sounds at a time (typing over pen over air, with 200 to 250 ms hand-overs), every cue ducks them, no stop cuts, nothing plays under reduced motion, and every texture stays under -48 dBFS, 6 dB under the quietest cue. `texture.plan.*` are the pure planners (node runs them), `texture.render` renders textures with cues and music offline, with stems. A deck opts in with `data-sound-texture` on `.sk-deck`; without it nothing changes and existing renders keep their samples.
- `dev/check-textures.mjs`: the plan checks in node and the audio checks in headless Chromium (one lane at a time, duck depth and return, fade shapes, no clicks, levels and the margin, peaks, determinism, one voice, silence after a stop, reduced motion and mute, cues bit-identical with and without textures, air yielding) plus the live path. `--calibrate` prints the level trims to freeze, `--wav <dir>` writes the fixture mixes and stems. `dev/sound-test.html` has buttons for the textures.

### Changed

- Effects on a page without music could lag behind a click, because the audio context asked the browser for playback latency. A page without `data-music` now asks for interactive latency. Pages with music keep the larger buffers.
- The swept-noise voice inside the engine takes an optional low-pass. The existing effects do not use it, and they and the music render the same samples as before.

### Fixed

- Seven cues without a pan (`click`, `tap-soft`, `select`, `toggle-on`, `toggle-off`, `dismiss`, `error-soft`) played about 6 dB louder than documented, so `click` came out above `step-next` and `error-soft` above `celebrate`. The offline measurement split the mono effect bus with a channel splitter, which put a cue without a pan on the left channel only, while the speakers play it on both. `cue.render` now lifts the bus to stereo as the speakers do and takes `master: true` to render through the live master chain, the seven trims were measured again on that render, and `check-cues.mjs` checks the loudness ladder as heard.

The cue design was informed by studying UI SFX (https://github.com/romainsimon/uisfx, MIT code, CC0 audio by Yuki Capital): semantic cue names, short dry envelopes, frequent cues quieter than outcomes, per-cue rate limits. No code or audio was copied.

Known issues: the texture level trims in the engine are the starting values until `check-textures.mjs --calibrate` has run and its values are frozen, and the textures have not had a listening pass yet. The cues were checked by measurement (levels, lengths, tails, similarity) in Chromium only. The listening pass on a phone speaker, a laptop and headphones has not been done yet, and Safari and Firefox were not tested. In `renderOffline`, an effect or cue without a pan comes out on the left channel only while no panned sound plays at the same moment (a render with `mood: 'none'`, for example); with music it is centered. Fixing that changes the samples of existing renders, so it is left for a release that says so.

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
