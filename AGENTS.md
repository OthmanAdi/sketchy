# sketchy

Skill for hand-drawn pencil-sketchbook slides, charts, explainers, business reports, postcards and short videos with generative sound, as self-contained HTML. Looks sketchy. The numbers are real.

## Using the skill

When the user asks for a deck, slides, a chart, an explainer, a one-page report, a postcard or a short video in a hand-drawn or pencil-sketch style, follow the skill below. Agents that do not expand `@` imports should open `skills/sketchy/SKILL.md` and read it before writing any HTML.

@./skills/sketchy/SKILL.md

## Working on this repository

Rules for agents that change files here. The full version is in `CONTRIBUTING.md`.

- Run `node scripts/check-skill.mjs` and `node --check` on every script you touched before you stop. Run `skills/sketchy/scripts/lint.mjs` on every HTML file you add or change. Report the output.
- Keep the engine in `skills/sketchy/engine/` free of dependencies. No libraries, no CDN links, no build step.
- Never copy code, art, sounds or text from another project unless its license allows it and you name the source and license. Sound is generated, never sampled.
- Keep everything seeded. Do not use `Math.random()` or the clock for anything that is drawn or heard.
- Take colors from `Sketchy.tokens()`. Do not hard-code them in a module.
- Do not touch `SKILL.md` frontmatter without quoting any value that contains a colon followed by a space.
- Keep `SKILL.md` under 500 lines and put detail in `skills/sketchy/references/`.
- Prose is plain. No dashes used as pauses, no hype words, American spelling.
- Commit only when the user asks. Do not add `Co-Authored-By` trailers or "generated with" lines to commits or pull request text.
