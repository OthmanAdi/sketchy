# Install sketchy

sketchy is one skill folder (`skills/sketchy/`) that every channel below points at. Pick the row for your agent, run the command, and ask for a deck, a chart or an explainer in plain words.

The skill writes self-contained HTML, so a browser is all you need to view the result. Node, Playwright and FFmpeg are optional and only unlock the scripts that build, check and export (see [Optional dependencies](#optional-dependencies)).

## Agent matrix

| Agent | Command | How to ask for it |
|---|---|---|
| Claude Code (plugin, one step) | `/plugin install sketchy --marketplace OthmanAdi/sketchy` (Claude Code 2.1.275 or later) | Describe the artifact, or run `/sketchy:sketchy`. |
| Claude Code (plugin) | `claude plugin marketplace add OthmanAdi/sketchy && claude plugin install sketchy@sketchy` | Describe the artifact, or run `/sketchy:sketchy`. Also adds `/sketchy:setup` and `/sketchy:doctor`. |
| Claude Code (skill only) | `npx skills add OthmanAdi/sketchy -a claude-code -g` | Describe the artifact, or run `/sketchy`. |
| Codex (plugin) | `codex plugin marketplace add OthmanAdi/sketchy && codex plugin add sketchy@sketchy` | Describe the artifact, or write `$sketchy`. |
| Codex (skill only) | `npx skills add OthmanAdi/sketchy -a codex -g` | `$sketchy` |
| Cursor | `npx skills add OthmanAdi/sketchy -a cursor -g` | Describe the artifact in Agent chat. |
| Gemini CLI | `gemini extensions install https://github.com/OthmanAdi/sketchy` | Describe the artifact. The extension loads `GEMINI.md`, which imports the skill. |
| Windsurf | `npx skills add OthmanAdi/sketchy -a windsurf -g` | Describe the artifact. |
| Cline | `npx skills add OthmanAdi/sketchy -a cline -g` | Describe the artifact. |
| OpenCode | `npx skills add OthmanAdi/sketchy -a opencode -g` | Describe the artifact. |
| Amp | `npx skills add OthmanAdi/sketchy -a amp -g` | Describe the artifact. |
| Goose | `npx skills add OthmanAdi/sketchy -a goose -g` | Describe the artifact. |
| GitHub Copilot | `npx skills add OthmanAdi/sketchy -a github-copilot -g` | Describe the artifact. |
| Kilo Code | `npx skills add OthmanAdi/sketchy -a kilo -g` | Describe the artifact. |
| Roo Code | `npx skills add OthmanAdi/sketchy -a roo -g` | Describe the artifact. |
| Kiro CLI | `npx skills add OthmanAdi/sketchy -a kiro-cli -g` | Describe the artifact. |
| Continue | `npx skills add OthmanAdi/sketchy -a continue -g` | Describe the artifact. |
| Droid | `npx skills add OthmanAdi/sketchy -a droid -g` | Describe the artifact. |
| Any other agent | `npx skills add OthmanAdi/sketchy -a <slug> -g` | Describe the artifact. |
| claude.ai | Download `sketchy.skill` from the [latest release](https://github.com/OthmanAdi/sketchy/releases/latest) and upload it in the Skills section of your claude.ai settings. | Describe the artifact. |

Notes on the matrix:

- `-g` installs for your user. Leave it out to install into the current project only.
- Run `npx skills add OthmanAdi/sketchy` with no `-a` to pick agents from a list. The slug for every supported agent is in the [skills CLI agent table](https://github.com/vercel-labs/skills/blob/main/docs/agents.md).
- The plugin routes for Claude Code and Codex install the same skill folder as the skill-only routes and add the setup commands (Claude Code) or the marketplace entry (Codex).
- If `OthmanAdi/sketchy` makes Claude Code try SSH and fail, add the marketplace with the full URL: `claude plugin marketplace add https://github.com/OthmanAdi/sketchy.git`.
- Inside a Claude Code session the plugin route is `/plugin marketplace add OthmanAdi/sketchy`, then `/plugin install sketchy@sketchy`.
- The repository also carries `.cursor-plugin/plugin.json` for Cursor's plugin format. The skills CLI route above is the one this file documents.
- In claude.ai the skill can write the HTML. Whether the export scripts run there depends on what the hosted environment provides.

## Check the install

After installing, run the setup check once. It reports Node, Playwright, Chromium, FFmpeg, fonts and write access, and prints the exact fix for anything missing.

| How you installed | Command |
|---|---|
| Claude Code plugin | `/sketchy:doctor`, or `/sketchy:setup` to be walked through the fixes |
| Any skill-only install | `node ~/.claude/skills/sketchy/scripts/doctor.mjs` (use the folder your agent installed to, see the table below) |
| A clone of this repository | `node skills/sketchy/scripts/doctor.mjs` |

On Windows, `~` is your user folder, for example `%USERPROFILE%\.claude\skills\sketchy\scripts\doctor.mjs`.

## Manual copy

Copy the folder `skills/sketchy` (the folder itself, with `SKILL.md` at its top) into the skills folder of your agent. Folder names below come from the skills CLI agent table.

| Agent | User folder | Project folder |
|---|---|---|
| Claude Code | `~/.claude/skills/sketchy/` | `.claude/skills/sketchy/` |
| Codex, Cline, Warp, Zed | `~/.agents/skills/sketchy/` | `.agents/skills/sketchy/` |
| Cursor | `~/.cursor/skills/sketchy/` | `.agents/skills/sketchy/` |
| Gemini CLI | `~/.gemini/skills/sketchy/` | `.agents/skills/sketchy/` |
| Windsurf | `~/.codeium/windsurf/skills/sketchy/` | `.windsurf/skills/sketchy/` |
| OpenCode | `~/.config/opencode/skills/sketchy/` | `.agents/skills/sketchy/` |
| Amp | `~/.config/agents/skills/sketchy/` | `.agents/skills/sketchy/` |
| Goose | `~/.config/goose/skills/sketchy/` | `.goose/skills/sketchy/` |
| GitHub Copilot | `~/.copilot/skills/sketchy/` | `.agents/skills/sketchy/` |

macOS and Linux, from a clone of this repository (Claude Code as the example):

```sh
mkdir -p ~/.claude/skills
cp -R skills/sketchy ~/.claude/skills/sketchy
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude\skills" | Out-Null
Copy-Item -Recurse skills\sketchy "$HOME\.claude\skills\sketchy"
```

To build the claude.ai upload yourself, zip the folder so `sketchy/SKILL.md` sits at the top of the archive and name the file `sketchy.skill`:

```sh
# macOS and Linux
cd skills && zip -r ../sketchy.skill sketchy
```

```powershell
# Windows (bsdtar ships with Windows 10 and later)
tar -a -cf sketchy.zip -C skills sketchy
Rename-Item sketchy.zip sketchy.skill
```

## Update

| Installed with | Update |
|---|---|
| Claude Code plugin | `claude plugin marketplace update sketchy`, then `claude plugin update sketchy@sketchy`, then restart Claude Code |
| Skills CLI | `npx skills check`, then `npx skills update` |
| Codex plugin | `codex plugin marketplace upgrade sketchy`, then `codex plugin add sketchy@sketchy` |
| Gemini CLI | `gemini extensions update sketchy` |
| Manual copy | Delete the old `sketchy` folder and copy the new one in |
| claude.ai | Upload the newer `sketchy.skill` |

Your own themes and templates in `./.sketchy/` and `~/.sketchy/` live outside the skill folder and survive updates.

## Uninstall

| Installed with | Uninstall |
|---|---|
| Claude Code plugin | `claude plugin uninstall sketchy@sketchy`, then `claude plugin marketplace remove sketchy` |
| Skills CLI | `npx skills remove sketchy` |
| Codex plugin | `codex plugin remove sketchy@sketchy`, then `codex plugin marketplace remove sketchy` |
| Gemini CLI | `gemini extensions uninstall sketchy` |
| Manual copy | Delete the `sketchy` folder you copied |
| claude.ai | Remove the skill in the Skills section of your settings |

Delete `~/.sketchy/` as well if you want to remove your draw history and personal themes.

## Optional dependencies

Writing a deck and opening it in a browser needs none of these.

| Dependency | Needed for | Windows | macOS | Linux |
|---|---|---|---|---|
| Node.js 18 or newer | every script in `skills/sketchy/scripts/`, including `build.mjs` and `doctor.mjs` | `winget install OpenJS.NodeJS.LTS` | `brew install node` | `sudo apt install nodejs npm` (check `node --version`; if it is below 18, use `nvm install --lts`) |
| Playwright 1.63.0 and Chromium | screenshots, the linter, PDF and PPTX export, video rendering | `npm install playwright@1.63.0` then `npx playwright install chromium` | same as Windows | `npm install playwright@1.63.0` then `npx playwright install --with-deps chromium` |
| FFmpeg | video rendering only | `winget install Gyan.FFmpeg` | `brew install ffmpeg` | `sudo apt install ffmpeg` |

`doctor.mjs` prints the exact install line for your layout, including the folder to run the Playwright commands in. Use its line when it differs from the table.

Playwright is pinned to 1.63.0 so that every export draws the same pixels. In a clone of this repository, `npm ci --ignore-scripts` installs it from the lockfile, and `npx playwright install chromium` downloads the browser.

If an install breaks, open your agent in a clone of this repository and say: "Read INSTALL.md and install sketchy for me."

## Notice

The bundled font files keep their own license (SIL Open Font License 1.1, texts next to the files in `skills/sketchy/engine/fonts/`), which allows embedding them in the HTML files you produce. Everything else in the repository is MIT, see [LICENSE](LICENSE).
