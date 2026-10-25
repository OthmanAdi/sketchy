# Contributing to sketchy

sketchy is a small project with strict rules. A pull request that follows them gets merged quickly. One that breaks them gets a short note saying which rule.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through [SECURITY.md](SECURITY.md), not through public issues.

## Rules

1. The engine has no runtime dependencies. Everything under `skills/sketchy/engine/` runs in a browser from a single `<script>` tag with no build step and no imports. Do not add a library, a CDN link or a package for it. The Node scripts may use `playwright` (pinned to 1.63.0) and nothing else.
2. Windows, macOS and Linux behave the same. Build paths with `node:path`, spawn processes without a shell, avoid POSIX-only tools in scripts, and write files with `\n` line endings. Say in the pull request which operating systems you ran it on. CI runs on Ubuntu only, so Windows and macOS rely on contributors saying so.
3. The checker and the lint pass. See [Before you open a pull request](#before-you-open-a-pull-request).
4. Every new sketch or chart type ships with a screenshot in the pull request. Attach what you see in the browser, at the size the engine draws it.
5. Clean-room only. Never paste code, art, sounds or text from another project unless its license allows redistribution under MIT and you say so in the pull request, with the license and the source. Reading another project for ideas is fine. Copying its implementation is not. Do not trace or re-draw another artist's work, and do not add recordings or samples: sound in this project is generated.
6. Everything stays seeded. The same `data-seed` must draw the same lines in the browser, the PDF, the PPTX art and the video. Use the pen's own random source (`pen.random()`), never `Math.random()` or the clock, anywhere that affects what is drawn or heard.
7. Colors come from tokens. Modules read colors through `Sketchy.tokens()`. A hard-coded color in a module is a bug.
8. Charts draw the data they are given. No smoothing, no rounding past the stated unit, no 3D, no second value axis, no truncated bar axis. The hidden table next to a chart must match the drawn values.
9. Prose is plain. See [Writing rules](#writing-rules).

## Set up

```sh
git clone https://github.com/OthmanAdi/sketchy.git
cd sketchy
npm ci --ignore-scripts
npx playwright install chromium
```

`npm ci --ignore-scripts` installs only the pinned Playwright from the lockfile and runs no install scripts. Node 18 or newer is required, and the CI uses Node 20.

The layout and the engine contracts are described in [docs/architecture.md](docs/architecture.md). Read it before you change anything under `skills/sketchy/engine/`.

## Before you open a pull request

Run these from the repository root and paste the result into the pull request:

```sh
node scripts/check-skill.mjs
node --check scripts/check-skill.mjs
node --check skills/sketchy/scripts/<each script you changed>.mjs
node --check skills/sketchy/engine/<each engine file you changed>.js
node skills/sketchy/scripts/lint.mjs <each HTML file you added or changed>
```

- `scripts/check-skill.mjs` parses the frontmatter of every `SKILL.md` with a strict parser, checks that every manifest agrees on name and version, resolves the relative links in the Markdown files that ship, checks that all text files are UTF-8, and checks that `SKILL.md` stays under 500 lines. It prints each failure with its fix.
- `lint.mjs` is the sketch lint. Run it on every template, theme sample or example you touch. It must exit 0.
- If you have the Claude CLI, `claude plugin validate . --strict` checks the plugin manifests.

## Add a sketch

A sketch is a small picture of a thing, registered in `skills/sketchy/engine/sketches.js`.

1. Pick a lowercase name that is not already in `Sketchy.catalog`.
2. Register it with `Sketchy.register(name, (p, C, parts) => { ... })`. The element is `<svg data-sketch="name" viewBox="0 0 140 110"></svg>`. Keep that view box so the sketch fits wherever the others do.
3. Draw with the pen (`p.line`, `p.rect`, `p.circle`, `p.poly`, `p.curve` and so on) and take colors from `C`. Use the pencil roles as intended: graphite for lines and words, red only for the one thing to look at.
4. Check that it looks right at the smallest size the deck uses and that the same seed draws the same picture twice.
5. Document it where the other sketches are documented under `skills/sketchy/references/`.
6. Add a screenshot of the sketch to the pull request.

## Add a chart type

Chart types live in `skills/sketchy/engine/sketchy-charts.js` and are driven by the `data-chart` JSON described in [docs/architecture.md](docs/architecture.md). A new type needs:

- A spec shape that keeps the exact data in the DOM and a hidden `<table>` that matches it.
- Axes and labels that state the unit. If a form misleads (a truncated axis, a stacked area that hides a series), do not add it.
- A screenshot with realistic data, one with a single point and one with many, so overflow shows up.
- A reference entry saying when to use the chart and when not to.

## Add a theme

A theme is a CSS file that overrides `--sk-*` tokens and nothing else.

1. Copy `skills/sketchy/themes/_starter.css` to `skills/sketchy/themes/<name>.css`. The name is lowercase kebab-case.
2. Change tokens only: paper, pencil colors, fonts, the `figure` color. Do not add selectors for components.
3. Keep graphite readable on paper. The lint reports the contrast and fails on low values.
4. Add a screenshot of a deck in your theme next to one in the default theme.
5. A theme must work on its own. It cannot depend on another theme being loaded.

Fonts: only add a font with a license that allows redistribution and embedding, such as the SIL Open Font License. Put the license text beside the font file in `skills/sketchy/engine/fonts/` and name the font in the pull request. The bundled Caveat and Courier Prime are under the SIL Open Font License 1.1, and their texts are in that folder.

## Add a template

A template is the starting HTML for one artifact type, in `skills/sketchy/templates/<type>.html`.

1. Build it from engine classes and data attributes. Do not copy engine code into it.
2. Mark every place where the agent writes content with a `<!-- slot:name -->` comment.
3. Load the engine in the documented order and call `mount()` as shown in [docs/architecture.md](docs/architecture.md).
4. It must pass `lint.mjs` with the slots filled with realistic text, not lorem ipsum. Placeholder text is a lint error.
5. Add screenshots of the filled template at 1920 x 1080 and 390 x 844.

## Writing rules

These apply to code comments, docs, issue and pull request text, release notes and the skill itself.

- Plain and matter-of-fact. Say what a thing does and what it costs.
- No dashes used as pauses. Use a comma, a colon, parentheses or a new sentence. Hyphens inside compound words are fine, and code blocks and flags are exempt.
- No performative warmth and no hype words such as seamless, powerful, unleash, revolutionary, effortless, delve, robust or elevate.
- American spelling.
- Release notes name the symptom a user saw, then the cause, and include an honest "Known issue" when there is one.

## Commits and credit

- Maintainer commits use `OthmanAdi <github_me@outlook.de>`. Check `git config user.name` and `git config user.email` before the first commit in a clone.
- Contributors commit under their own name and email.
- There are no `Co-Authored-By` trailers, and no "generated with" lines in commits or pull request text, including when an AI agent wrote part of the change. The person who opens the pull request is its author.
- Contributors are credited in the "Thanks" line of the [CHANGELOG](CHANGELOG.md) entry for their release and in [CONTRIBUTORS.md](CONTRIBUTORS.md). A maintainer adds both when merging.
- Use short commit subjects in the imperative, for example `Add pencil-case sketch`.

## Releases

A release changes the version in every manifest at once: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `gemini-extension.json` and `package.json`. The checker fails when they differ. The CHANGELOG gets a section for the same version.

## Licensing

Contributions are accepted under the MIT license in [LICENSE](LICENSE). The bundled fonts Caveat and Courier Prime are under the SIL Open Font License 1.1, and their license texts are in `skills/sketchy/engine/fonts/`. See the notice at the end of [INSTALL.md](INSTALL.md).
