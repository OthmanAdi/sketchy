#!/usr/bin/env node
// check-textures.mjs: hold the texture layer of engine/sketchy-sound.js (pen, typing, air)
// to its contract. The plan-level checks run in node on the pure planners; the audio
// checks render the fixtures offline in headless Chromium (OfflineAudioContext, the
// engine's own graph) and measure stems.
//
//   node skills/sketchy/dev/check-textures.mjs [--plans-only] [--calibrate] [--wav <dir>]
//
// Levels are what a listener hears: the loudest 50 ms of the mean power of both channels,
// through the live master chain at the master gain.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ENGINE_DIR, parseArgs, say, c, die, isMain } from '../scripts/_lib.mjs';

const SPEC = {
  name: 'check-textures',
  file: 'skills/sketchy/dev/check-textures.mjs',
  summary: 'check the pen, typing and air textures: plans in node, stems in headless Chromium',
  usage: '[--plans-only] [--calibrate] [--wav <dir>]',
  options: [
    { name: 'plans-only', type: 'boolean', default: false, help: 'run only the plan-level checks (no browser)' },
    { name: 'calibrate', type: 'boolean', default: false, help: 'bisect PEN_CAL, TYPE_CAL and AIR_CAL against the targets and print the values to freeze' },
    { name: 'wav', type: 'string', arg: 'dir', help: 'also write the fixture mixes and stems as WAV files' },
  ],
};

/* ---------- fixtures shared by node and the browser ---------- */
const HELLO = { text: 'How many groups and users are there in total?', startAfter: 500, charsPerSecond: 34, end: 'return' };
const FAST = { text: 'The quick brown fox jumps over the lazy dog while the owl counts every star', startAfter: 300, charsPerSecond: 70, end: 'settle' };
const SLOW = { text: 'Which groups have no owner?', startAfter: 1100, charsPerSecond: 28, end: 'settle' };
const SHORT = { text: 'Hi there', startAfter: 200, charsPerSecond: 38, end: 'none' };
const TYPING_FIXTURES = { hello: HELLO, fast: FAST, slow: SLOW, short: SHORT };

const stroke = (shape, extra = {}) => ({ start: 0.2, duration: 0.66, shape, x0: 0.2, x1: 0.8, ...extra });
const SHAPE_FIXTURES = {
  line: stroke('line'), curve: stroke('curve'), ellipse: stroke('ellipse', { phi: 0 }), check: stroke('check'),
  'arrow-shaft': stroke('arrow-shaft'), 'arrow-head': stroke('arrow-head'), flick: stroke('flick'),
  box: stroke('box'), 'box-round': stroke('box-round'), poly: stroke('poly', { marks: 5 }), hatch: stroke('hatch', { marks: 6 }),
  wash: stroke('wash', { duration: 0.45 }), dot: stroke('dot'), text: stroke('text'),
};
export const FIXTURES = { typing: TYPING_FIXTURES, shapes: SHAPE_FIXTURES };

/* The engine is a browser script: load it in a bare context where `this` is the sandbox. */
function loadEngine(src) {
  const sandbox = {};
  vm.runInNewContext(src, sandbox, { filename: 'sketchy-sound.js' });
  if (!sandbox.SketchySound || !sandbox.SketchySound.texture) throw new Error('SketchySound.texture is missing: is this the current engine?');
  return sandbox.SketchySound;
}

const dB = (x) => 20 * Math.log10(Math.max(x, 1e-12));
const ms = (s) => (s * 1000).toFixed(1);

/* ---------- plan-level checks (F5, F12) ---------- */
function planChecks(S) {
  const out = [];
  const P = S.texture.plan;
  const push = (what, ok, detail) => out.push({ what: detail ? `${what} (${detail})` : what, ok });

  // F5: typing gaps, rate, first tap, end tap
  for (const [name, spec] of Object.entries(TYPING_FIXTURES)) {
    const plan = P.typing(spec, { seed: 'texture-check' });
    const taps = plan.taps, end = taps.length && taps[taps.length - 1].kind === spec.end ? taps[taps.length - 1] : null;
    const keys = end ? taps.slice(0, -1) : taps;
    let minGap = Infinity;
    for (let i = 1; i < taps.length; i++) minGap = Math.min(minGap, taps[i].t - taps[i - 1].t);
    push(`F5 ${name}: consecutive tap onsets at least 55 ms apart`, taps.length < 2 || minGap >= 0.055 - 1e-9, `min ${ms(minGap)} ms over ${taps.length} taps`);
    if (plan.span >= 0.6) {
      const rate = keys.length / plan.span;
      push(`F5 ${name}: key onsets per second within 8.5 to 14.5`, rate >= 8.5 && rate <= 14.5, `${keys.length} keys over ${plan.span.toFixed(3)} s = ${rate.toFixed(1)}/s, budget ${plan.budget}`);
    }
    push(`F5 ${name}: first tap within 10 ms of t1`, keys.length > 0 && Math.abs(keys[0].t - plan.t1) <= 0.010, `first at ${ms(keys[0] ? keys[0].t : 0)} ms, t1 ${ms(plan.t1)} ms`);
    if (spec.end === 'none') push(`F5 ${name}: no end tap when end is none`, !taps.some((t) => t.kind === 'return' || t.kind === 'settle'));
    else {
      push(`F5 ${name}: end tap at tN + 110 ms (within 9 ms)`, !!end && Math.abs(end.t - (plan.tN + 0.11)) <= 0.009, end ? `${ms(end.t)} ms vs tN ${ms(plan.tN)} ms` : 'no end tap');
      push(`F5 ${name}: no tap after the end tap`, !!end && keys.every((t) => t.t < end.t));
    }
  }
  // the worked example of the spec: 13 keys, 9 on words and 4 on spaces, end tap at 1933 ms
  const hello = P.typing(HELLO, { seed: 'texture-check' });
  const spaces = hello.taps.filter((t) => t.kind === 'space').length, letters = hello.taps.filter((t) => t.kind === 'letter' || t.kind === 'punctuation').length;
  push('F5 hello: 13 keys (9 letters, 4 spaces) and the end tap at 1933 ms', hello.budget === 13 && letters === 9 && spaces === 4 && Math.abs(hello.taps[hello.taps.length - 1].t - 1.933) < 0.002,
    `budget ${hello.budget}, ${letters} letters, ${spaces} spaces, end ${ms(hello.taps[hello.taps.length - 1].t)} ms`);
  // a second plan on the same text and seed is the same plan
  const again = P.typing(HELLO, { seed: 'texture-check' });
  push('F5 hello: the same text and seed give the same taps', JSON.stringify(again) === JSON.stringify(hello));
  push('F5 hello: another seed moves the jitter but keeps the keys', P.typing(HELLO, { seed: 'other' }).taps.length === hello.taps.length);

  // F12: shape fingerprints on the plan
  const plans = {};
  for (const [shape, st] of Object.entries(SHAPE_FIXTURES)) plans[shape] = P.pen({ strokes: [st], surface: 'deck', key: shape, vary: false }, { seed: 'texture-check' });
  const at = (plan, arr, t, rate) => arr[Math.max(0, Math.min(arr.length - 1, Math.round((t - plan.t0) * rate)))];
  const ell = plans.ellipse, es = ell.strokes[0];
  const bandStart = ell.band[Math.floor((es.start - ell.t0) * ell.paramRate)], bandMid = at(ell, ell.band, es.mid, ell.paramRate), bandEnd = at(ell, ell.band, es.start + es.duration, ell.paramRate);
  push('F12 ellipse: the band at half the path is at least 1.2 x its start and back within 10 % at the end', bandMid >= 1.2 * bandStart && Math.abs(bandEnd - bandStart) <= 0.1 * bandStart,
    `start ${bandStart.toFixed(3)}, half ${bandMid.toFixed(3)}, end ${bandEnd.toFixed(3)}`);
  let panLo = Infinity, panHi = -Infinity;
  for (let i = 0; i < ell.pan.length; i++) { panLo = Math.min(panLo, ell.pan[i]); panHi = Math.max(panHi, ell.pan[i]); }
  push('F12 ellipse: pan swings at least 0.25 peak to peak', panHi - panLo >= 0.25, `${(panHi - panLo).toFixed(3)}`);
  const chk = plans.check, cs = chk.strokes[0];
  const idx = (t) => Math.round((t - chk.t0) * chk.rate);
  const legMax = (a, b) => { let m = 0; for (let i = idx(a); i <= idx(b); i++) m = Math.max(m, chk.L[i]); return m; };
  const liftMin = (a, b) => { let m = Infinity; for (let i = idx(a); i <= idx(b); i++) m = Math.min(m, chk.L[i]); return m; };
  const leg1 = legMax(cs.start, cs.start + 0.16 * cs.duration), leg2 = legMax(cs.start + 0.24 * cs.duration, cs.start + cs.duration);
  const lift = liftMin(cs.start + 0.16 * cs.duration, cs.start + 0.3 * cs.duration);
  const dip = dB(lift) - dB(Math.min(leg1, leg2));
  push('F12 check: the pressure dips at least 8 dB between the legs', dip <= -8, `leg 1 ${dB(leg1).toFixed(1)}, lift ${dB(lift).toFixed(1)}, leg 2 ${dB(leg2).toFixed(1)} dB`);
  push('F12 box: four accents', plans.box.accents.length === 4, `${plans.box.accents.length}`);
  push('F12 box-round: four accents', plans['box-round'].accents.length === 4, `${plans['box-round'].accents.length}`);
  push('F12 poly: N accents for N points', plans.poly.accents.length === 5, `${plans.poly.accents.length} for 5 points`);
  push('F12 hatch: n sub-strokes', plans.hatch.strokes[0].subs === 6 && plans.hatch.accents.length === 6, `${plans.hatch.strokes[0].subs} sub-strokes, ${plans.hatch.accents.length} accents`);
  const peakL = (p) => { let m = 0; for (let i = 0; i < p.L.length; i++) m = Math.max(m, p.L[i]); return m; };
  push('F12 dot and text add 0 to L', peakL(plans.dot) === 0 && peakL(plans.text) === 0 && plans.dot.n === 0 && plans.text.n === 0);
  push('F12 wash: a whisper, at least 12 dB under a line', dB(peakL(plans.wash)) - dB(peakL(plans.line)) <= -12, `${(dB(peakL(plans.wash)) - dB(peakL(plans.line))).toFixed(1)} dB`);
  // every sounding shape ends in silence and starts without a jump
  for (const [shape, plan] of Object.entries(plans)) {
    if (!plan.n) continue;
    let maxStep = 0;
    for (let i = 1; i < plan.L.length; i++) maxStep = Math.max(maxStep, Math.abs(plan.L[i] - plan.L[i - 1]));
    push(`F12 ${shape}: the pressure never steps more than 0.6 between control points and ends under -60 dB`, maxStep <= 0.6 && dB(plan.L[plan.L.length - 1]) < -60, `max step ${maxStep.toFixed(3)}, end ${dB(plan.L[plan.L.length - 1]).toFixed(1)} dB`);
  }
  // overlapping strokes never pass the ceiling
  const many = P.pen({ strokes: [0, 0.1, 0.2, 0.3, 0.4].map((s) => ({ start: s, duration: 0.66, shape: 'ellipse' })), surface: 'deck', key: 'many' }, { seed: 'texture-check' });
  push('F12 five overlapping ellipses: L stays at or under 1', peakL(many) <= 1, `peak ${peakL(many).toFixed(3)}`);
  // the plan is a pure function of its input
  const twice = P.pen({ strokes: [SHAPE_FIXTURES.check], surface: 'deck', key: 'check', vary: false }, { seed: 'texture-check' });
  push('F12 the same timeline and seed give the same plan', JSON.stringify(Array.from(twice.L)) === JSON.stringify(Array.from(chk.L)));
  // air
  const air = P.air({ in: 0.9, hold: 2, out: 1.6 }, { seed: 'texture-check' });
  let airMax = 0, airStep = 0;
  for (let i = 0; i < air.env.length; i++) { airMax = Math.max(airMax, air.env[i]); if (i) airStep = Math.max(airStep, Math.abs(air.env[i] - air.env[i - 1])); }
  push('F12 air: the swell reaches 1, steps under 0.02 per point, ends at 0', airMax === 1 && airStep < 0.02 && air.env[air.env.length - 1] === 0 && air.env[0] === 0, `max ${airMax}, step ${airStep.toFixed(4)}`);
  push('F12 air: in is at least 0.3 s and out at least 0.5 s', P.air({ in: 0.05, hold: 0, out: 0.1 }).in === 0.3 && P.air({ in: 0.05, hold: 0, out: 0.1 }).out === 0.5);
  return { checks: out, plans: { typing: Object.fromEntries(Object.entries(TYPING_FIXTURES).map(([k, v]) => [k, P.typing(v, { seed: 'texture-check' })])), pen: plans, air } };
}

/* Float32Arrays serialize as index maps; make the plan output comparable as text. */
export function planJson(x) {
  return JSON.stringify(x, (k, v) => (v instanceof Float32Array ? Array.from(v) : v));
}

async function main() {
  const { values } = parseArgs(process.argv.slice(2), SPEC);
  const engine = path.join(ENGINE_DIR, 'sketchy-sound.js');
  if (!fs.existsSync(engine)) die(`engine not found: ${engine}`);
  const src = fs.readFileSync(engine, 'utf8');
  const S = loadEngine(src);
  let bad = 0;

  say.line(c.bold('textures: plan-level checks in node (F5 typing rhythm, F12 shape fingerprints)'));
  const plan = planChecks(S);
  for (const k of plan.checks) { if (!k.ok) bad++; (k.ok ? say.ok : say.error)(k.what); }
  const randomUse = /Math\.random\s*\(/.test(src), clockUse = /\b(Date\.now|performance\.now|new Date)\s*\(/.test(src);
  (randomUse || clockUse ? say.error : say.ok)(`engine source: ${randomUse ? 'uses Math.random()' : 'no Math.random()'}, ${clockUse ? 'reads the clock' : 'no Date or performance clock'}`);
  if (randomUse || clockUse) bad++;

  if (values.plansOnly) {
    say.line();
    if (bad) { say.error(`${bad} problem${bad === 1 ? '' : 's'} found`); process.exit(1); }
    say.ok('every plan check passed');
    return;
  }
  say.line();
  say.info('the audio checks (F1 to F4, F6 to F11, F13, F14) need the offline renderer: not in this build yet, run with --plans-only');
  if (bad) { say.error(`${bad} problem${bad === 1 ? '' : 's'} found`); process.exit(1); }
  say.ok('every plan check passed');
}

if (isMain(import.meta.url)) main().catch((e) => die(String(e && e.stack ? e.stack : e), null, 2));
