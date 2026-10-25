# CLAUDE.md

Repository rules for agents working on sketchy. This file is for contributors' agents. The skill itself is `skills/sketchy/SKILL.md`; do not paste it here.

## What this repository is

An open-source (MIT) agent skill that makes hand-drawn pencil-sketchbook slides, charts, explainers, business reports, postcards and short videos with generative sound as self-contained HTML. It ships as one skill folder (`skills/sketchy/`) plus packaging for Claude Code, Codex, Cursor and Gemini CLI. The design is in `docs/architecture.md`.

## Commands

```sh
npm ci --ignore-scripts                 # installs the pinned Playwright, runs no install scripts
npx playwright install chromium         # browser for shoot, lint and the exports
node scripts/check-skill.mjs            # repo checker, must pass before you finish
node --check <file>                     # syntax check for each .js and .mjs you changed
node skills/sketchy/scripts/lint.mjs <file.html>   # sketch lint for each HTML file you added or changed
claude plugin validate . --strict       # manifest validation, read only
```

## Rules

- Run the checker and the lint before you tell the user you are done, and paste the output. A passing run in an earlier turn does not count after more edits.
- The engine (`skills/sketchy/engine/`) has no dependencies and no build step. Do not add a package, a CDN link or an import to it. Scripts may use `playwright` at the pinned version and nothing else.
- Never copy third-party code, art, sound or text unless its license allows redistribution under MIT, and then name the source and license in the pull request. When in doubt, write it from scratch.
- Windows, macOS and Linux must behave the same. Use `node:path`, spawn without a shell, and do not rely on POSIX-only tools.
- Everything is seeded. Use the pen's random source. No `Math.random()` and no clock in anything that is drawn or heard.
- Colors come from `Sketchy.tokens()` and the `--sk-*` custom properties. Do not hard-code a color in a module.
- Charts draw exactly the data given, and the hidden table matches the drawn values.
- Versions agree in all manifests and in `package.json`. Change them together and add the CHANGELOG section. The checker fails otherwise.
- `SKILL.md` frontmatter needs `name` (equal to its folder, lowercase kebab-case) and `description` (1 to 1024 characters). Quote any value that contains a colon followed by a space. An unquoted one makes some agents drop the skill silently.
- `SKILL.md` stays under 500 lines. Put detail in `skills/sketchy/references/`, one level deep.

## Prose

Applies to comments, docs, commit messages, issue and pull request text, and release notes.

- Plain and matter-of-fact.
- No dashes used as pauses. Use commas, colons, parentheses or a new sentence. Hyphens in compound words are fine. Code blocks and flags are exempt.
- No performative warmth and no hype words (seamless, powerful, unleash, revolutionary, effortless, delve, robust, elevate).
- American spelling.

## Commits

- Maintainer identity is `OthmanAdi <github_me@outlook.de>`. Check `git config user.email` before committing for the maintainer.
- No `Co-Authored-By` trailers and no "generated with" lines in commits or pull request text. Contributors are credited in the CHANGELOG "Thanks" line and in `CONTRIBUTORS.md`.
- Commit only when asked. Never push, tag or create the remote repository unless the maintainer asks for it by name.
