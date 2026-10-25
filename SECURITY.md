# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| Anything older | No |

Fixes go into the latest release only. While the project is below 1.0, a fix may ship as a patch release without a backport.

## What is in scope

sketchy is a skill folder, a browser engine and a set of Node scripts. The engine produces HTML files that run in the viewer's browser. The scripts run on the machine of whoever installs the skill, so most of the attack surface sits there.

In scope:

- The scripts in `skills/sketchy/scripts/` that start Playwright (Chromium) or FFmpeg on local files: shell or argument injection through file names or options, unsafe browser flags such as a disabled sandbox or disabled web security, and files read or written outside the paths the user passed.
- The build inliner (`build.mjs`): reading files outside the project folder, following links or symlinks to unexpected locations, and writing output anywhere other than the requested path.
- User themes and templates loaded from `./.sketchy/` and `~/.sketchy/`, and the draw history in `~/.sketchy/draws.json`: anything that lets a crafted file run code or escape its folder.
- The engine and the HTML files it produces: any network request at load or run time (output is meant to be fully self-contained), script injection through chart data, notes or other `data-*` attributes, and unsafe use of `localStorage`.
- The release artifacts: the `sketchy.skill` archive and the plugin manifests.

Out of scope:

- Vulnerabilities in Node.js, Playwright, Chromium or FFmpeg themselves. Report those to their own projects.
- Behavior of the AI agent that runs the skill, including prompt injection through content the user gives the agent. The skill cannot control what an agent does with untrusted input.
- Problems that need an attacker who already controls the user's machine or the user's agent configuration.

## How to report

Use GitHub private vulnerability reporting: open the repository's Security tab and choose "Report a vulnerability", or go to https://github.com/OthmanAdi/sketchy/security/advisories/new.

Please do not open a public issue for a vulnerability. If private reporting is unavailable, write to github_me@outlook.de and say that the message is a security report.

A useful report has:

- The sketchy version (from `.claude-plugin/plugin.json` or the release tag), your operating system and your Node version.
- The command you ran, with the smallest input file that reproduces the problem.
- What you expected and what happened instead.

## What to expect

The maintainer aims to acknowledge a report within seven days and to say whether it is accepted as a vulnerability within fourteen days. Accepted reports get a fix in the next release, with credit in the changelog unless you ask to stay anonymous. This is a one-person project, so those times are goals and not guarantees.
