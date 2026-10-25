---
description: "Set up sketchy. Checks Node 18+, Playwright 1.63.0 with Chromium and FFmpeg, then walks through the install steps for your OS"
disable-model-invocation: true
allowed-tools:
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/sketchy/scripts/doctor.mjs)"
  - "Bash(node \"${CLAUDE_PLUGIN_ROOT}/skills/sketchy/scripts/doctor.mjs\")"
  - "Bash(node --version)"
  - "Bash(ffmpeg -version)"
---

Check what sketchy needs on this machine and guide the user through installing what is missing. The command is idempotent: running it again on a finished setup changes nothing and ends with "nothing to do".

What is required for what:

- Writing a deck, chart or explainer as HTML and opening it in a browser needs nothing installed.
- Node.js 18 or newer runs every script in `skills/sketchy/scripts/`.
- Playwright 1.63.0 with its Chromium build runs screenshots, the linter, PDF export, PPTX export and video rendering.
- FFmpeg is needed for video rendering only.

Steps:

1. Run the doctor script:

   `node "${CLAUDE_PLUGIN_ROOT}/skills/sketchy/scripts/doctor.mjs"`

   If it cannot start, run `node --version`. A missing or too old Node is the first thing to fix, so go to step 3 with Node as the only item.

2. Read the report. If every check is ok, say "nothing to do", name the checks that passed, and stop. Do not install or change anything.

3. For each check that is not ok, tell the user what stops working without it, then show the install steps for their operating system only. Get the OS from the doctor output, or from `node -p process.platform` (`win32`, `darwin` or `linux`). Use the lines the doctor printed first. When it printed none, use these:

   | Item | Windows (PowerShell) | macOS | Linux |
   |---|---|---|---|
   | Node.js 18+ | `winget install OpenJS.NodeJS.LTS` | `brew install node` | `sudo apt install nodejs npm`, then check `node --version`; if it is below 18, use `nvm install --lts` |
   | Playwright 1.63.0 | `npm install playwright@1.63.0` | `npm install playwright@1.63.0` | `npm install playwright@1.63.0` |
   | Chromium | `npx playwright install chromium` | `npx playwright install chromium` | `npx playwright install --with-deps chromium` |
   | FFmpeg (video only) | `winget install Gyan.FFmpeg` | `brew install ffmpeg` | `sudo apt install ffmpeg` |

   Run the Playwright commands in the folder the doctor names. If it names none, ask the user where they want the install before running anything.

4. Ask before you run any install command. Never run `sudo`, `winget` or `brew` without the user saying yes to that exact command. If the user prefers to run it themselves, print the command and wait. On a new Windows install, tell the user that a terminal opened before Node was installed will not see it, and that they may need to restart the terminal.

5. After each install, run the doctor again. Repeat from step 3 until it reports no failures, or until the user decides to skip an optional item. FFmpeg is optional: a user who does not make videos can skip it, and the doctor's report for it is then expected.

6. Finish with a short summary: what was installed, what was skipped on purpose, and the first thing to try, for example "Ask for a six-slide sketchbook deck about your last project."

Rules for this command:

- Install nothing without an explicit yes. Do not edit shell profiles, PATH or system settings.
- Do not use a package manager the user does not already have. If `winget` or `brew` is missing, say so and point to https://nodejs.org or https://ffmpeg.org/download.html.
- The Chromium download is over 100 MB. Say that before running it.
