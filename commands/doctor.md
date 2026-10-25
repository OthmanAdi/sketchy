---
description: Check Node, Playwright, Chromium, FFmpeg, fonts and write access for sketchy, and explain each failure
disable-model-invocation: true
allowed-tools:
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/sketchy/scripts/doctor.mjs)"
  - "Bash(node \"${CLAUDE_PLUGIN_ROOT}/skills/sketchy/scripts/doctor.mjs\")"
---

Run the sketchy setup check and explain the result. This command only reads: do not install, change or delete anything.

1. Run the doctor script and capture all of its output:

   `node "${CLAUDE_PLUGIN_ROOT}/skills/sketchy/scripts/doctor.mjs"`

   If the file does not exist, say that the plugin install is incomplete and suggest `claude plugin update sketchy@sketchy`, then stop.

2. Report the result as a short list, one line per check, with the status the script printed (ok, warning or failed).

3. For every check that is not ok, explain it in plain words:
   - what the check tests,
   - which parts of sketchy stop working because of it,
   - the exact fix line the script printed, copied as printed.

   Use this table to say what each check gates:

   | Check | Gates |
   |---|---|
   | Node 18 or newer | Every script in `skills/sketchy/scripts/`, including the build step that makes a deck a single self-contained file |
   | Playwright 1.63.0 | Screenshots, the linter, PDF export, PPTX export, video rendering |
   | Chromium for Playwright | The same scripts as Playwright. Playwright without Chromium cannot open a page |
   | FFmpeg | Video rendering only. Everything else works without it |
   | Fonts (Caveat, Courier Prime) | Handwriting in every output. Missing fonts mean a fallback face, and the linter reports it |
   | Write access | Output folders and the draw history in `~/.sketchy/draws.json`. Without it the build and deal steps fail |

4. Say what still works. Writing a deck as HTML and opening it in a browser needs none of the optional pieces, so a failed Playwright or FFmpeg check never blocks that.

5. If anything failed, end with one line: run `/sketchy:setup` to be walked through the fixes. If everything is ok, say so in one line and stop.

Do not guess at a failure the script did not report. If the script crashed instead of printing a report, show the error, run `node --version`, and say that the likeliest cause is a Node version below 18.
