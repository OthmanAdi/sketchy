# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release notes are plain and matter-of-fact: each entry says what changed in terms a user can check. Contributors are credited in the "Thanks" line of the release that carried their change, and in [CONTRIBUTORS.md](CONTRIBUTORS.md).

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
