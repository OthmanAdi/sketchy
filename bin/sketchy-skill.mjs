#!/usr/bin/env node
// sketchy-skill: copies the sketchy agent skill into your agents' skill folders.
// No dependencies and no install scripts: nothing runs until you call it.
//
//   npx sketchy-skill install            every agent found on this machine (user level)
//   npx sketchy-skill install --agent claude-code --project
//   npx sketchy-skill uninstall
//   npx sketchy-skill doctor             checks Node, Playwright, Chromium, FFmpeg, fonts
//   npx sketchy-skill path               where the bundled skill folder is
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(here, '..', 'skills', 'sketchy');
const HOME = os.homedir();
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

// user folder, project folder, and the folder whose presence means "this agent is installed"
const AGENTS = {
  'claude-code': [path.join(HOME, '.claude', 'skills'), path.join('.claude', 'skills'), path.join(HOME, '.claude')],
  codex: [path.join(HOME, '.agents', 'skills'), path.join('.agents', 'skills'), path.join(HOME, '.codex')],
  cursor: [path.join(HOME, '.cursor', 'skills'), path.join('.agents', 'skills'), path.join(HOME, '.cursor')],
  'gemini-cli': [path.join(HOME, '.gemini', 'skills'), path.join('.agents', 'skills'), path.join(HOME, '.gemini')],
  windsurf: [path.join(HOME, '.codeium', 'windsurf', 'skills'), path.join('.windsurf', 'skills'), path.join(HOME, '.codeium', 'windsurf')],
  opencode: [path.join(HOME, '.config', 'opencode', 'skills'), path.join('.agents', 'skills'), path.join(HOME, '.config', 'opencode')],
  amp: [path.join(HOME, '.config', 'agents', 'skills'), path.join('.agents', 'skills'), path.join(HOME, '.config', 'amp')],
  goose: [path.join(HOME, '.config', 'goose', 'skills'), path.join('.goose', 'skills'), path.join(HOME, '.config', 'goose')],
  'github-copilot': [path.join(HOME, '.copilot', 'skills'), path.join('.agents', 'skills'), path.join(HOME, '.copilot')]
};

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'help';
const flag = (name) => args.includes('--' + name);
const value = (name) => { const i = args.indexOf('--' + name); return i > -1 ? args[i + 1] : null; };

function help() {
  console.log(`sketchy-skill ${pkg.version}: hand-drawn slides, charts and explainers for AI agents

usage:
  npx sketchy-skill install [--agent <name>|all] [--project] [--force]
  npx sketchy-skill uninstall [--agent <name>|all] [--project]
  npx sketchy-skill doctor
  npx sketchy-skill path

install copies the skill into the user skill folder of every agent found on this
machine (or only --agent, or all of them with --agent all). --project installs into
the current folder instead. Agents: ${Object.keys(AGENTS).join(', ')}.

Then ask your agent for a deck, a lesson, a report or a chart.
Docs: https://github.com/OthmanAdi/sketchy`);
}

function targets() {
  const pick = value('agent');
  const names = pick && pick !== 'all' ? pick.split(',') : Object.keys(AGENTS);
  for (const n of names) if (!AGENTS[n]) { console.error(`unknown agent "${n}". Known: ${Object.keys(AGENTS).join(', ')}`); process.exit(2); }
  const project = flag('project');
  const found = names.filter((n) => pick || project || fs.existsSync(AGENTS[n][2]));
  const dirs = [...new Set(found.map((n) => path.resolve(project ? AGENTS[n][1] : AGENTS[n][0])))];
  return { found, dirs };
}

if (cmd === 'install') {
  const { found, dirs } = targets();
  if (!dirs.length) {
    console.log('No agent folders found in your home folder. Name one: npx sketchy-skill install --agent claude-code');
    process.exit(1);
  }
  for (const d of dirs) {
    const dest = path.join(d, 'sketchy');
    if (fs.existsSync(dest) && !flag('force')) { console.log(`skip  ${dest}  (exists; add --force to replace it)`); continue; }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
    fs.cpSync(SKILL, dest, { recursive: true, filter: (src) => !/[\\/](evals|fixtures)([\\/]|$)/.test(src) });
    console.log(`ok    ${dest}`);
  }
  console.log(`\nInstalled for: ${found.join(', ')}. Check the scripts' tools with: npx sketchy-skill doctor`);
} else if (cmd === 'uninstall') {
  const { dirs } = targets();
  for (const d of dirs) {
    const dest = path.join(d, 'sketchy');
    if (fs.existsSync(path.join(dest, 'SKILL.md'))) { fs.rmSync(dest, { recursive: true, force: true }); console.log(`removed  ${dest}`); }
  }
} else if (cmd === 'doctor') {
  const r = spawnSync(process.execPath, [path.join(SKILL, 'scripts', 'doctor.mjs'), ...args.slice(1)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
} else if (cmd === 'path') {
  console.log(SKILL);
} else if (cmd === 'version' || flag('version')) {
  console.log(pkg.version);
} else {
  help();
}
