#!/usr/bin/env node
// Repository checker for sketchy. No dependencies, Node 18 or newer.
//
//   node scripts/check-skill.mjs [--root <dir>]
//
// Checks:
//   1. Required files exist.
//   2. Every skills/*/SKILL.md has strictly parsed frontmatter: `name` and `description`
//      required, name is lowercase kebab-case and equals its folder, description is 1 to 1024
//      characters, no unquoted ": " inside a plain scalar (the taste-skill 2.1.2 bug: the
//      skill was silently dropped), SKILL.md is under 500 lines.
//   3. Every manifest parses as JSON and agrees on name and version.
//   4. Every relative link in README.md, INSTALL.md, SKILL.md and skills/sketchy/references
//      resolves to an existing file (case-sensitive, like GitHub).
//   5. Every `@./path` import in AGENTS.md, GEMINI.md and .claude/CLAUDE.md resolves.
//   6. All text files are valid UTF-8.
//
// Each failure is printed with its fix. Exit code 1 when anything fails.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, basename, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------------------------
// Setup

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: node scripts/check-skill.mjs [--root <dir>]');
  process.exit(0);
}
const rootArg = args.indexOf('--root');
const ROOT = resolve(
  rootArg >= 0 && args[rootArg + 1]
    ? args[rootArg + 1]
    : join(dirname(fileURLToPath(import.meta.url)), '..'),
);

const SKILL_NAME = 'sketchy';
const SKILL_DIR = `skills/${SKILL_NAME}`;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.dev', 'out', 'dist', 'coverage']);
const BINARY_EXT = new Set([
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico',
  'mp3', 'wav', 'ogg', 'flac', 'mp4', 'webm', 'mov', 'zip', 'skill', 'gz', 'tgz', 'pdf',
  'pptx', 'docx', 'xlsx', 'wasm',
]);

const failures = [];
let currentCheck = '';
const fail = (file, problem, fix) => failures.push({ check: currentCheck, file, problem, fix });
const posix = (p) => p.split(sep).join('/');
const rel = (abs) => posix(relative(ROOT, abs));
const abs = (r) => join(ROOT, ...r.split('/'));
const read = (r) => readFileSync(abs(r), 'utf8');

const dirCache = new Map();
function existsExact(target) {
  const r = relative(ROOT, target);
  if (r === '') return true;
  if (r.startsWith('..') || isAbsolute(r)) return existsSync(target);
  let cur = ROOT;
  for (const seg of r.split(sep).filter(Boolean)) {
    if (!dirCache.has(cur)) {
      try { dirCache.set(cur, readdirSync(cur)); } catch { return false; }
    }
    if (!dirCache.get(cur).includes(seg)) return false;
    cur = join(cur, seg);
  }
  return true;
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// ---------------------------------------------------------------------------------------------
// Strict frontmatter parser (a small YAML subset)
//
// Supported: top-level `key: value` pairs; plain, 'single' and "double" quoted scalars
// (single or multi-line); block scalars (| and >, with - and + chomping); flow collections
// ([a, b] and {a: b}) kept as raw text; one level of nested mappings; lists of scalars.
// Anything else is reported instead of guessed at.

const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:[ \t]+(.*))?$/;
const STRICT_KEYS = new Set(['name', 'description', 'compatibility']);
const trunc = (s, n = 60) => (s.length > n ? `${s.slice(0, n)}...` : s);

function dedent(items) {
  const widths = items
    .filter((l) => l.t.trim() !== '')
    .map((l) => l.t.match(/^[ \t]*/)[0].length);
  const min = widths.length ? Math.min(...widths) : 0;
  return items.map((l) => ({ n: l.n, t: l.t.trim() === '' ? '' : l.t.slice(min) }));
}

function decodeDouble(s) {
  // s starts with ". Returns { value, end } where end is the index after the closing quote.
  const simple = { n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' };
  let value = '';
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === '"') return { value, end: i + 1 };
    if (c !== '\\') { value += c; continue; }
    const d = s[++i];
    if (d === undefined) break;
    if (d in simple) { value += simple[d]; continue; }
    const len = d === 'x' ? 2 : d === 'u' ? 4 : d === 'U' ? 8 : 0;
    if (len) {
      const hex = s.slice(i + 1, i + 1 + len);
      if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) return { error: `bad \\${d} escape` };
      value += String.fromCodePoint(parseInt(hex, 16));
      i += len;
      continue;
    }
    return { error: `unknown escape "\\${d}"` };
  }
  return { error: 'the string is never closed' };
}

function decodeSingle(s) {
  let value = '';
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "'") {
      if (s[i + 1] === "'") { value += "'"; i++; continue; }
      return { value, end: i + 1 };
    }
    value += s[i];
  }
  return { error: 'the string is never closed' };
}

function parseValue(key, rest, block, keyLine, errs) {
  const q = `"${key}"`;
  const blockNonBlank = block.filter((b) => b.t.trim() !== '');

  if (rest === '' || rest.startsWith('#')) {
    if (blockNonBlank.length === 0) return null;
    const first = blockNonBlank[0].t.trim();
    const d = dedent(block);
    if (first === '-' || first.startsWith('- ')) return parseList(d, errs);
    if (KEY_RE.test(first)) return parseMap(d, errs);
    return plainScalar(key, '', block, keyLine, errs);
  }

  if (/^[>|][+-]?[0-9]?\s*(#.*)?$/.test(rest)) {
    const style = rest[0];
    const keep = rest.includes('+');
    const d = dedent(block).map((l) => l.t);
    let text = '';
    if (style === '|') text = d.join('\n');
    else {
      for (const line of d) {
        if (line === '') text += '\n';
        else text += (text && !text.endsWith('\n') ? ' ' : '') + line.trim();
      }
    }
    text = text.replace(/\n+$/, '');
    return keep ? `${text}\n` : text;
  }

  if (rest[0] === '"' || rest[0] === "'") {
    // Join continuation lines, YAML folds the line breaks into single spaces.
    const joined = [rest, ...blockNonBlank.map((b) => b.t.trim())].join(' ');
    const r = rest[0] === '"' ? decodeDouble(joined) : decodeSingle(joined);
    if (r.error) {
      errs.push({
        line: keyLine,
        problem: `${q}: quoted value is invalid: ${r.error}`,
        fix: rest[0] === '"'
          ? 'Escape inner double quotes as \\" and write other backslashes as \\\\, or switch to a folded block (">-" then indented text).'
          : "Write a literal single quote as two single quotes, or switch to a folded block (\">-\" then indented text).",
      });
      return rest;
    }
    const after = joined.slice(r.end).trim();
    if (after !== '' && !after.startsWith('#')) {
      errs.push({
        line: keyLine,
        problem: `${q}: text continues after the closing quote: ${trunc(after, 40)}`,
        fix: 'An inner quote ended the string early. Escape it with a backslash (double-quoted) or doubled quote (single-quoted), or use a folded block (">-" then indented text).',
      });
    }
    return r.value;
  }

  if (rest[0] === '[' || rest[0] === '{') {
    const joined = [rest, ...blockNonBlank.map((b) => b.t.trim())].join(' ');
    const stack = [];
    let quote = '';
    for (let i = 0; i < joined.length; i++) {
      const c = joined[i];
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '[' || c === '{') stack.push(c === '[' ? ']' : '}');
      else if (c === ']' || c === '}') { if (stack.pop() !== c) { stack.push('!'); break; } }
      else if (c === '#' && joined[i - 1] === ' ') break;
    }
    if (stack.length || quote) {
      errs.push({
        line: keyLine,
        problem: `${q}: flow collection "${trunc(rest, 30)}" is not closed`,
        fix: 'Close the bracket, or quote the whole value if it should be text.',
      });
    }
    return joined;
  }

  if ('@`*&!%'.includes(rest[0]) || rest.startsWith('- ') || rest.startsWith('? ')) {
    errs.push({
      line: keyLine,
      problem: `${q}: a plain value cannot start with "${rest[0]}"`,
      fix: 'Wrap the whole value in double quotes.',
    });
    return rest;
  }

  return plainScalar(key, rest, block, keyLine, errs);
}

function plainScalar(key, rest, block, keyLine, errs) {
  const strict = STRICT_KEYS.has(key);
  const parts = [];
  if (rest !== '') parts.push({ n: keyLine, t: rest });
  for (const b of block) if (b.t.trim() !== '') parts.push({ n: b.n, t: b.t.trim() });
  const cleaned = [];
  for (const p of parts) {
    let text = p.t;
    const hash = text.search(/\s#/);
    if (hash >= 0) {
      if (strict) {
        errs.push({
          line: p.n,
          problem: `"${key}": " #" starts a YAML comment, so everything after it is dropped: ${trunc(text.slice(hash), 40)}`,
          fix: 'Wrap the whole value in double quotes, or use a folded block (">-" then indented text).',
        });
      }
      text = text.slice(0, hash);
    }
    if (/:(\s|$)/.test(text)) {
      errs.push({
        line: p.n,
        problem: `"${key}": unquoted ": " inside a plain value (YAML reads it as a nested mapping and rejects the file, so agents silently drop the skill): ${trunc(text, 50)}`,
        fix: 'Wrap the whole value in double quotes (escape inner double quotes as \\"), or write it as a folded block: `' + key + ': >-` followed by indented text.',
      });
    }
    cleaned.push(text.trim());
  }
  return cleaned.join(' ');
}

function parseList(items, errs) {
  const out = [];
  let cur = null;
  for (const l of items) {
    if (l.t === '' && cur === null) continue;
    const m = l.t.match(/^-(?:[ \t]+(.*))?$/);
    if (m) {
      if (cur) out.push(finishItem(cur, errs));
      cur = { n: l.n, text: (m[1] ?? '').trim(), more: [] };
    } else if (cur && l.t.trim() !== '') cur.more.push(l.t.trim());
    else if (!cur && l.t.trim() !== '') errs.push({ line: l.n, problem: `unexpected line in list: ${trunc(l.t)}`, fix: 'Start list items with "- ".' });
  }
  if (cur) out.push(finishItem(cur, errs));
  return out;
}

function finishItem(item, errs) {
  const text = [item.text, ...item.more].join(' ').trim();
  if (KEY_RE.test(text)) return text; // a mapping inside a list, kept as raw text
  const v = parseValue('list item', text, [], item.n, errs);
  return typeof v === 'string' ? v : text;
}

function parseMap(items, errs) {
  const out = {};
  let i = 0;
  while (i < items.length) {
    const line = items[i];
    if (line.t.trim() === '' || /^\s*#/.test(line.t)) { i++; continue; }
    if (/^[ \t]/.test(line.t)) {
      errs.push({ line: line.n, problem: `unexpected indentation: ${trunc(line.t.trim())}`, fix: 'Indent only the continuation of a value, or start a new "key: value" at column 0.' });
      i++;
      continue;
    }
    const m = line.t.match(KEY_RE);
    if (!m) {
      errs.push({ line: line.n, problem: `not a "key: value" line: ${trunc(line.t)}`, fix: 'Put each frontmatter entry on its own line as "key: value" (a space after the colon).' });
      i++;
      continue;
    }
    const key = m[1];
    const rest = (m[2] ?? '').trim();
    const keyLine = line.n;
    i++;
    const block = [];
    while (i < items.length && (items[i].t.trim() === '' || /^[ \t]/.test(items[i].t))) block.push(items[i++]);
    while (block.length && block[block.length - 1].t.trim() === '') block.pop();
    if (Object.hasOwn(out, key)) errs.push({ line: keyLine, problem: `duplicate key "${key}"`, fix: 'Keep one entry per key.' });
    out[key] = parseValue(key, rest, block, keyLine, errs);
  }
  return out;
}

function parseFrontmatter(text) {
  const errs = [];
  if (text.charCodeAt(0) === 0xfeff) {
    errs.push({ line: 1, problem: 'file starts with a byte order mark', fix: 'Save the file as UTF-8 without BOM.' });
    text = text.slice(1);
  }
  const lines = text.split(/\r?\n/);
  if (lines[0].trimEnd() !== '---') {
    errs.push({ line: 1, problem: 'the file does not start with a "---" frontmatter line', fix: 'Start SKILL.md with "---", the frontmatter, and a closing "---".' });
    return { data: null, errs, bodyStart: 0 };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === '---') { end = i; break; }
  }
  if (end < 0) {
    errs.push({ line: 1, problem: 'the frontmatter is never closed', fix: 'Add a closing "---" line after the frontmatter.' });
    return { data: null, errs, bodyStart: 0 };
  }
  const items = [];
  for (let i = 1; i < end; i++) {
    if (/^[ \t]*\t/.test(lines[i])) errs.push({ line: i + 1, problem: 'a tab is used for indentation', fix: 'YAML forbids tabs for indentation. Use spaces.' });
    items.push({ n: i + 1, t: lines[i].replace(/\t/g, '  ') });
  }
  const data = parseMap(items, errs);
  return { data, errs, bodyStart: end + 1 };
}

// ---------------------------------------------------------------------------------------------
// Markdown links

function maskCode(text) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  return text
    .replace(/(^|\n)([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?(\n[ \t]*\3[^\n]*(?=\n|$)|$)/g, (m) => blank(m))
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/`[^`\n]*`/g, blank);
}

function extractLinks(text) {
  const masked = maskCode(text);
  const found = [];
  const add = (target, index) => found.push({ target: target.trim(), line: masked.slice(0, index).split('\n').length });
  for (const m of masked.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) add(m[1], m.index);
  for (const m of masked.matchAll(/^[ ]{0,3}\[[^\]\n]+\]:[ \t]*<?(\S+?)>?(?:[ \t]+["'(].*)?$/gm)) add(m[1], m.index);
  for (const m of masked.matchAll(/\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi)) add(m[1], m.index);
  for (const m of masked.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const part of m[1].split(',')) add(part.trim().split(/\s+/)[0], m.index);
  }
  return found;
}

function extractImports(text) {
  const out = [];
  text.split(/\r?\n/).forEach((l, i) => {
    const m = l.match(/^@(\.{0,2}\/?[^\s]+)$/);
    if (m) out.push({ target: m[1], line: i + 1 });
  });
  return out;
}

function resolveTarget(fromFile, target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('#')) return null;
  let t = target.split('#')[0].split('?')[0];
  if (t === '') return null;
  try { t = decodeURI(t); } catch { /* keep as written */ }
  return { clean: t, abs: t.startsWith('/') ? join(ROOT, t) : resolve(dirname(abs(fromFile)), t) };
}

// ---------------------------------------------------------------------------------------------
// UTF-8

function firstInvalidUtf8(buf) {
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    let need = 0;
    if (b < 0x80) { i++; continue; }
    else if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) need = 2;
    else if (b >= 0xf0 && b <= 0xf4) need = 3;
    else return i;
    for (let k = 1; k <= need; k++) if (i + k >= buf.length || (buf[i + k] & 0xc0) !== 0x80) return i;
    i += need + 1;
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------
// Checks

const REQUIRED = [
  [`${SKILL_DIR}/SKILL.md`, 'Write the skill entry file with name and description frontmatter.'],
  ['README.md', 'Write the repository README.'],
  ['LICENSE', 'Add the MIT license text.'],
  ['INSTALL.md', 'Add the install matrix.'],
  ['CHANGELOG.md', 'Add the changelog.'],
  ['CONTRIBUTING.md', 'Add the contributing guide.'],
  ['CODE_OF_CONDUCT.md', 'Add the code of conduct.'],
  ['SECURITY.md', 'Add the security policy.'],
  ['CONTRIBUTORS.md', 'Add the contributors list.'],
  ['AGENTS.md', 'Add the agents file.'],
  ['.claude/CLAUDE.md', 'Add the repository rules for Claude Code (in .claude/, so the plugin root has no CLAUDE.md).'],
  ['GEMINI.md', 'Add the Gemini context file.'],
  ['.claude-plugin/plugin.json', 'Add the Claude Code plugin manifest.'],
  ['.claude-plugin/marketplace.json', 'Add the Claude Code marketplace manifest.'],
  ['.codex-plugin/plugin.json', 'Add the Codex plugin manifest.'],
  ['.agents/plugins/marketplace.json', 'Add the Codex marketplace manifest.'],
  ['.cursor-plugin/plugin.json', 'Add the Cursor plugin manifest.'],
  ['gemini-extension.json', 'Add the Gemini extension manifest.'],
];
const missingRequired = new Set();

check('required files exist', () => {
  for (const [file, fix] of REQUIRED) {
    if (!existsExact(abs(file))) {
      missingRequired.add(file);
      fail(file, 'file is missing', fix);
    }
  }
});

let skillName = SKILL_NAME;
const skillFiles = [];

check('SKILL.md frontmatter and size', () => {
  const skillsRoot = abs('skills');
  if (!existsSync(skillsRoot)) {
    fail('skills/', 'folder is missing', `Create skills/${SKILL_NAME}/SKILL.md.`);
    return;
  }
  for (const e of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const file = `skills/${e.name}/SKILL.md`;
    if (!existsExact(abs(file))) {
      if (e.name === SKILL_NAME) continue; // reported by "required files exist"
      fail(`skills/${e.name}/`, 'skill folder has no SKILL.md', 'Add SKILL.md, or move the folder out of skills/.');
      continue;
    }
    skillFiles.push(file);
    const text = read(file);
    const { data, errs } = parseFrontmatter(text);
    for (const er of errs) fail(`${file}:${er.line}`, er.problem, er.fix);
    if (data) {
      const name = data.name;
      if (typeof name !== 'string' || name === '') {
        fail(file, '`name` is missing or empty', 'Add `name: ' + e.name + '` to the frontmatter.');
      } else {
        if (e.name === SKILL_NAME) skillName = name;
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) {
          fail(file, `\`name\` "${name}" must be lowercase kebab-case (a to z, 0 to 9, single hyphens), 1 to 64 characters`, `Rename it to something like "${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)}".`);
        }
        if (name !== e.name) {
          fail(file, `\`name\` "${name}" does not match its folder "${e.name}"`, `Set \`name: ${e.name}\` or rename the folder.`);
        }
      }
      const desc = data.description;
      if (typeof desc !== 'string' || desc.trim() === '') {
        fail(file, '`description` is missing or empty', 'Add a `description` that says what the skill does and when to use it.');
      } else {
        const len = [...desc.trim()].length;
        if (len > 1024) fail(file, `\`description\` is ${len} characters, the limit is 1024`, `Cut ${len - 1024} characters, or move detail into the SKILL.md body.`);
      }
      if (typeof data.compatibility === 'string' && [...data.compatibility].length > 500) {
        fail(file, '`compatibility` is longer than 500 characters', 'Shorten it.');
      }
      if (data.metadata !== null && data.metadata !== undefined && (typeof data.metadata !== 'object' || Array.isArray(data.metadata))) {
        fail(file, '`metadata` must be a mapping of keys to values', 'Write `metadata:` followed by indented `key: value` lines.');
      }
    }
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    if (lines.length >= 500) {
      fail(file, `SKILL.md has ${lines.length} lines, it must stay under 500`, 'Move detail into skills/' + e.name + '/references/*.md and link to it from SKILL.md.');
    }
  }
});

check('commands/*.md frontmatter parses', () => {
  const dir = abs('commands');
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const file = `commands/${e.name}`;
    const text = read(file);
    if (!text.startsWith('---')) {
      fail(file, 'no frontmatter', 'Start the command with a "---" block that has a `description`.');
      continue;
    }
    const { data, errs } = parseFrontmatter(text);
    for (const er of errs) fail(`${file}:${er.line}`, er.problem, er.fix);
    if (data && (typeof data.description !== 'string' || data.description.trim() === '')) {
      fail(file, '`description` is missing or empty', 'Add a one-line `description` (quote it if it contains ": ").');
    }
  }
});

let manifestVersion = null;
const versions = [];

check('manifests parse and agree on name and version', () => {
  const load = (file) => {
    if (!existsExact(abs(file))) return null; // reported by "required files exist"
    try {
      return JSON.parse(read(file));
    } catch (err) {
      fail(file, `invalid JSON: ${err.message}`, 'Fix the syntax. Common causes: a trailing comma, a missing quote, a comment, or a byte order mark.');
      return null;
    }
  };
  const nameIs = (file, value, what = 'name') => {
    if (value !== skillName) fail(file, `${what} is ${JSON.stringify(value)}, expected "${skillName}" (the SKILL.md name)`, `Set it to "${skillName}".`);
  };
  const addVersion = (file, v) => {
    if (typeof v !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v)) {
      fail(file, `version ${JSON.stringify(v)} is missing or not semver (for example 0.1.0)`, 'Set a three-part version.');
      return;
    }
    versions.push({ file, v });
  };
  const needPath = (file, p, what) => {
    if (typeof p !== 'string') return;
    const target = join(ROOT, p);
    if (!existsExact(target)) fail(file, `${what} points at "${p}", which does not exist`, 'Fix the path or add the folder. If it is SKILL.md that is missing, write that first.');
  };

  for (const file of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.cursor-plugin/plugin.json', 'gemini-extension.json']) {
    const j = load(file);
    if (!j) continue;
    nameIs(file, j.name);
    addVersion(file, j.version);
    if (typeof j.description !== 'string' || j.description.trim() === '') fail(file, 'description is missing', 'Add a one-sentence description.');
    if (file.startsWith('.codex-plugin') || file.startsWith('.cursor-plugin')) {
      if (j.skills !== undefined) needPath(file, j.skills, '"skills"');
    }
    if (file === 'gemini-extension.json') needPath(file, j.contextFileName, '"contextFileName"');
    if (file === '.claude-plugin/plugin.json' && !(j.author && typeof j.author.name === 'string')) {
      fail(file, 'author.name is missing', 'Add "author": { "name": "OthmanAdi", "url": "https://github.com/OthmanAdi" }.');
    }
    if (typeof j.homepage === 'string' && !/^https?:\/\//.test(j.homepage)) fail(file, 'homepage is not a URL', 'Use a full https:// URL.');
  }

  const cm = load('.claude-plugin/marketplace.json');
  if (cm) {
    nameIs('.claude-plugin/marketplace.json', cm.name, 'marketplace name');
    if (!cm.owner || typeof cm.owner.name !== 'string') fail('.claude-plugin/marketplace.json', 'owner.name is missing', 'Add "owner": { "name": "OthmanAdi" }.');
    const entries = Array.isArray(cm.plugins) ? cm.plugins : [];
    const entry = entries.find((p) => p.name === skillName);
    if (!entry) {
      fail('.claude-plugin/marketplace.json', `no plugin entry named "${skillName}"`, `Add { "name": "${skillName}", "source": "./", "skills": ["./skills/${skillName}"] } to "plugins".`);
    } else {
      if (entry.source !== './') fail('.claude-plugin/marketplace.json', `plugin source is ${JSON.stringify(entry.source)}, expected "./"`, 'Use "source": "./" so the plugin is the repository root.');
      if (entry.version !== undefined) addVersion('.claude-plugin/marketplace.json', entry.version);
      for (const s of entry.skills ?? []) {
        needPath('.claude-plugin/marketplace.json', s, '"skills" entry');
        const skillFile = typeof s === 'string' ? `${s.replace(/^\.\//, '').replace(/\/$/, '')}/SKILL.md` : '';
        if (skillFile && !missingRequired.has(skillFile) && !existsExact(join(ROOT, skillFile)) && existsExact(join(ROOT, s))) {
          fail('.claude-plugin/marketplace.json', `"skills" entry "${s}" has no SKILL.md`, 'Point at the folder that holds SKILL.md.');
        }
      }
      if (!entry.skills || entry.skills.length === 0) fail('.claude-plugin/marketplace.json', 'plugin entry has no "skills" list', `Add "skills": ["./skills/${skillName}"].`);
    }
  }

  const xm = load('.agents/plugins/marketplace.json');
  if (xm) {
    nameIs('.agents/plugins/marketplace.json', xm.name, 'marketplace name');
    const entries = Array.isArray(xm.plugins) ? xm.plugins : [];
    if (!entries.some((p) => p.name === skillName)) {
      fail('.agents/plugins/marketplace.json', `no plugin entry named "${skillName}"`, 'Add a plugin entry for sketchy.');
    }
  }

  const pkg = load('package.json');
  if (pkg) addVersion('package.json', pkg.version);

  const distinct = [...new Set(versions.map((x) => x.v))];
  if (distinct.length > 1) {
    const detail = versions.map((x) => `${x.file}=${x.v}`).join(', ');
    fail('manifests', `versions disagree: ${detail}`, 'Set the same version in every manifest and in package.json.');
  }
  manifestVersion = versions.find((x) => x.file === '.claude-plugin/plugin.json')?.v ?? distinct[0] ?? null;

  for (const file of skillFiles) {
    const { data } = parseFrontmatter(read(file));
    const sv = data?.version ?? data?.metadata?.version;
    if (typeof sv === 'string' && manifestVersion && sv !== manifestVersion) {
      fail(file, `frontmatter version ${sv} differs from the manifests (${manifestVersion})`, 'Make them match, or drop the version from SKILL.md.');
    }
  }

  if (manifestVersion && existsExact(abs('CHANGELOG.md'))) {
    const changelog = read('CHANGELOG.md');
    const esc = manifestVersion.replace(/[.+]/g, '\\$&');
    if (!new RegExp(`^## \\[${esc}\\]`, 'm').test(changelog)) {
      fail('CHANGELOG.md', `no "## [${manifestVersion}]" section`, `Add a "## [${manifestVersion}] - <date or unreleased>" heading.`);
    }
  }
});

check('relative links resolve', () => {
  const files = ['README.md', 'INSTALL.md', `${SKILL_DIR}/SKILL.md`];
  const refDir = abs(`${SKILL_DIR}/references`);
  if (existsSync(refDir)) {
    for (const p of walk(refDir)) if (p.endsWith('.md')) files.push(rel(p));
  }
  for (const file of files) {
    if (!existsExact(abs(file))) continue; // reported by "required files exist"
    for (const { target, line } of extractLinks(read(file))) {
      if (target.includes('\\')) {
        fail(`${file}:${line}`, `link "${target}" uses a backslash`, 'Use forward slashes in links.');
        continue;
      }
      const r = resolveTarget(file, target);
      if (!r) continue;
      const inside = relative(ROOT, r.abs);
      if (inside.startsWith('..') || isAbsolute(inside)) {
        fail(`${file}:${line}`, `link "${target}" leaves the repository`, 'Link to a file inside the repository, or use a full URL.');
        continue;
      }
      if (existsExact(r.abs)) continue;
      if (missingRequired.has(posix(inside))) continue; // already reported as a missing file
      const hint = existsSync(r.abs) ? ' (a file with that name exists but the letter case differs, and GitHub is case-sensitive)' : '';
      fail(`${file}:${line}`, `link "${target}" does not resolve${hint}`, 'Create the file, fix the path, or remove the link.');
    }
  }
});

check('@ imports in AGENTS.md, GEMINI.md, .claude/CLAUDE.md resolve', () => {
  for (const file of ['AGENTS.md', 'GEMINI.md', '.claude/CLAUDE.md']) {
    if (!existsExact(abs(file))) continue;
    for (const { target, line } of extractImports(read(file))) {
      const r = resolveTarget(file, target);
      if (!r) continue;
      const inside = posix(relative(ROOT, r.abs));
      if (existsExact(r.abs) || missingRequired.has(inside)) continue;
      fail(`${file}:${line}`, `import "@${target}" does not resolve`, 'Point the import at an existing file.');
    }
  }
});

check('text files are UTF-8', () => {
  for (const p of walk(ROOT)) {
    const ext = basename(p).includes('.') ? basename(p).split('.').pop().toLowerCase() : '';
    if (BINARY_EXT.has(ext)) continue;
    let size;
    try { size = statSync(p).size; } catch { continue; }
    if (size > 8 * 1024 * 1024) continue;
    const buf = readFileSync(p);
    const file = rel(p);
    if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
      fail(file, 'file is UTF-16 encoded', 'Re-save it as UTF-8 without BOM.');
      continue;
    }
    if (buf.includes(0)) continue; // binary
    const bad = firstInvalidUtf8(buf);
    if (bad >= 0) {
      const line = buf.subarray(0, bad).toString('latin1').split('\n').length;
      fail(`${file}:${line}`, `invalid UTF-8 byte sequence at byte ${bad}`, 'Re-save the file as UTF-8 (a stray Windows-1252 character is the usual cause).');
      continue;
    }
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      fail(file, 'file starts with a UTF-8 byte order mark', 'Save it as UTF-8 without BOM. A BOM breaks JSON parsers and frontmatter detection.');
    }
    const text = buf.toString('utf8');
    const at = text.indexOf(String.fromCharCode(0xfffd));
    if (at >= 0) {
      fail(`${file}:${text.slice(0, at).split('\n').length}`, 'contains the replacement character U+FFFD, which means text was corrupted by an earlier bad conversion', 'Restore the original character and re-save as UTF-8.');
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Run and report

console.log(`sketchy check: ${ROOT}\n`);
let failedChecks = 0;
for (const c of checks) {
  currentCheck = c.name;
  const before = failures.length;
  try {
    c.fn();
  } catch (err) {
    fail('check-skill.mjs', `the check "${c.name}" crashed: ${err.stack ?? err}`, 'Report this as a bug in scripts/check-skill.mjs.');
  }
  const mine = failures.slice(before);
  if (mine.length === 0) {
    console.log(`ok    ${c.name}`);
  } else {
    failedChecks++;
    console.log(`FAIL  ${c.name} (${mine.length})`);
    for (const f of mine) {
      console.log(`      ${f.file}: ${f.problem}`);
      console.log(`        fix: ${f.fix}`);
    }
  }
}
console.log(
  failures.length === 0
    ? `\nAll ${checks.length} checks passed.`
    : `\n${failures.length} problem${failures.length === 1 ? '' : 's'} in ${failedChecks} of ${checks.length} checks.`,
);
process.exit(failures.length === 0 ? 0 : 1);
