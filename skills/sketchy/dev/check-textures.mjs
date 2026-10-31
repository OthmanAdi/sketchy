#!/usr/bin/env node
// check-textures.mjs: hold the texture layer of engine/sketchy-sound.js (pen, typing, air)
// to its contract. The plan-level checks (F5, F12) run in node on the pure planners; the
// audio checks (F1 to F4, F6 to F11, F13 to F17) render fixtures offline in headless Chromium
// (OfflineAudioContext, the engine's own graph) and measure the stems.
//
//   node skills/sketchy/dev/check-textures.mjs [--plans-only] [--calibrate] [--wav <dir>]
//
// Levels are what a listener hears: the loudest 50 ms of the mean power of both channels,
// through the live master chain at the master gain. --calibrate bisects PEN_CAL, TYPE_CAL and
// AIR_CAL (and the tap kind trims) against the targets in the engine and prints the values to
// freeze in source; it changes nothing on disk. --wav writes the fixture mixes and stems.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ENGINE_DIR, requirePlaywright, launchChromium, parseArgs, say, c, die, isMain } from '../scripts/_lib.mjs';

const SPEC = {
  name: 'check-textures',
  file: 'skills/sketchy/dev/check-textures.mjs',
  summary: 'check the pen, typing and air textures: plans in node, stems in headless Chromium',
  usage: '[--plans-only] [--calibrate] [--wav <dir>]',
  options: [
    { name: 'plans-only', type: 'boolean', default: false, help: 'run only the plan-level checks (no browser)' },
    { name: 'calibrate', type: 'boolean', default: false, help: 'bisect PEN_CAL, TYPE_CAL, AIR_CAL and the tap trims against the targets, print the values to freeze' },
    { name: 'wav', type: 'string', arg: 'dir', help: 'also write the fixture mixes and stems as WAV files (master chain, 48 kHz)' },
  ],
};

/* ---------- fixtures shared by node and the browser (plain JSON) ---------- */
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
// the chat hello drawing: a card outline, then a seven-slot buddy (slot gap 0.129 s, draw time 0.386 s)
const BUDDY = [
  { start: 0, duration: 0.386, shape: 'line', x0: 0.35, x1: 0.45 }, { start: 0.129, duration: 0.386, shape: 'line', x0: 0.55, x1: 0.65 },
  { start: 0.257, duration: 0.386, shape: 'box-round', x0: 0.3, x1: 0.7 }, { start: 0.386, duration: 0.386, shape: 'curve', x0: 0.45, x1: 0.55 },
  { start: 0.514, duration: 0.386, shape: 'ellipse', x0: 0.42, x1: 0.46 }, { start: 0.643, duration: 0.386, shape: 'ellipse', x0: 0.54, x1: 0.58 },
  { start: 0.771, duration: 0.386, shape: 'curve', x0: 0.44, x1: 0.56 },
];
const SEED = 'texture-check';
const RENDERS = {
  FA: { name: 'F-A chat hello', duration: 7, seed: SEED,
    pen: [{ at: 0, surface: 'room', key: 'hello', strokes: [{ start: 0.2, duration: 0.66, shape: 'box-round', x0: 0.1, x1: 0.9 }, ...BUDDY] },
      { at: 2.4, surface: 'room', key: 'send', strokes: [{ start: 0, duration: 0.5, shape: 'line', x0: 0.6, x1: 0.8 }] }],
    typing: [{ at: 0, surface: 'room', ...HELLO }],
    air: [{ at: 0, surface: 'room', in: 0.9, hold: 1.2, out: 1.6 }],
    cues: [{ t: 0, name: 'reveal' }, { t: 6.0, name: 'step-next' }] },
  FB: { name: 'F-B ten ellipses, then a 70 cps line', duration: 6, seed: SEED,
    pen: [{ at: 0, surface: 'room', key: 'rings', strokes: Array.from({ length: 10 }, (_, i) => ({ start: 0.1 + i * 0.1, duration: 0.66, shape: 'ellipse', x0: 0.3, x1: 0.7 })) }],
    typing: [{ at: 2.5, surface: 'room', ...FAST }] },
  // F-C is completed in the browser with every cue name
  FC: { name: 'F-C stress with music', duration: 12, seed: SEED, mood: 'sketchbook', sections: [{ t: 0, name: 'flight' }],
    pen: [{ at: 0, surface: 'room', key: 'shapes', strokes: Object.keys(SHAPE_FIXTURES).map((shape, i) => ({ start: 0.3 + i * 0.5, duration: 0.66, shape, x0: 0.2, x1: 0.8, marks: 5 })) }],
    typing: [{ at: 7, surface: 'room', ...SLOW }],
    air: [{ at: 8.5, surface: 'room', in: 0.5, hold: 1, out: 1 }] },
  DUCK: { name: 'duck', duration: 5, seed: SEED, probe: 'envelope', air: [{ at: 0, surface: 'room', in: 0.3, hold: 4, out: 0.5 }],
    cues: [{ t: 1.0, name: 'click' }, { t: 2.5, name: 'celebrate' }] },
  STOP_A: { name: 'stop (step) under a pen line', duration: 5, seed: SEED,
    pen: [{ at: 0, surface: 'room', key: 'lines', strokes: [{ start: 0, duration: 0.66, shape: 'line' }, { start: 0.5, duration: 0.66, shape: 'line' }, { start: 1.0, duration: 0.66, shape: 'line' }, { start: 1.5, duration: 2.5, shape: 'curve' }] }],
    typing: [{ at: 0, surface: 'room', ...SLOW }],
    events: [{ t: 3.0, type: 'stop', fadeMs: 160, reason: 'step' }] },
  STOP_B: { name: 'stop (close) under the air', duration: 5, seed: SEED,
    air: [{ at: 0, surface: 'room', in: 0.5, hold: 3, out: 1 }],
    events: [{ t: 2.0, type: 'stop', fadeMs: 250, reason: 'close' }] },
  // two stops in a row, 50 ms apart, and a pen report on the same surface while the second still fades
  STOP_TWICE: { name: 'two stops in a row, then a pen report during the fade', duration: 3, seed: SEED,
    pen: [{ at: 0, surface: 'room', key: 'twice', strokes: [{ start: 0.8, duration: 0.66, shape: 'line', x0: 0.2, x1: 0.8 }, { start: 0.85, duration: 0.66, shape: 'curve', x0: 0.3, x1: 0.7 }] },
      { at: 0.97, surface: 'room', key: 'again', strokes: [{ start: 0, duration: 0.66, shape: 'line', x0: 0.2, x1: 0.8 }, { start: 0.43, duration: 0.66, shape: 'line', x0: 0.3, x1: 0.7 }] }],
    events: [{ t: 0.9, type: 'stop', fadeMs: 250, reason: 'close' }, { t: 0.95, type: 'stop', fadeMs: 250, reason: 'close' }] },
  // a typing line stopped before it taps, then a line reported 50 ms later and another while that one types
  TYPE_AGAIN: { name: 'a typing line stopped and reported again', duration: 6, seed: SEED,
    typing: [{ at: 0, surface: 'room', ...SLOW }, { at: 0.55, surface: 'room', ...HELLO }, { at: 1.5, surface: 'room', ...HELLO }],
    events: [{ t: 0.5, type: 'stop', fadeMs: 120, reason: 'replay' }] },
  // an air swell stopped, then a new swell reported 20 ms later on the same surface
  AIR_AFTER_STOP: { name: 'a new air swell right after a stop', duration: 4, seed: SEED,
    air: [{ at: 0, surface: 'room', in: 0.3, hold: 4, out: 1 }, { at: 1.02, surface: 'room', in: 0.5, hold: 1, out: 0.5 }],
    events: [{ t: 1.0, type: 'stop', fadeMs: 160, reason: 'step' }] },
  REDUCED: { name: 'reduced motion turns on', duration: 4, seed: SEED,
    pen: [{ at: 0, surface: 'room', key: 'r', strokes: [{ start: 0, duration: 2.5, shape: 'curve' }] }, { at: 2.5, surface: 'room', key: 'after', strokes: [{ start: 0, duration: 0.66, shape: 'line' }] }],
    typing: [{ at: 2.6, surface: 'room', ...SHORT }],
    air: [{ at: 0, surface: 'room', in: 0.3, hold: 3, out: 0.5 }, { at: 2.7, surface: 'room', in: 0.3, hold: 0.5, out: 0.5 }],
    events: [{ t: 2.0, type: 'reduced' }] },
  MUTE: { name: 'mute', duration: 4, seed: SEED,
    pen: [{ at: 0, surface: 'room', key: 'm', strokes: [{ start: 0, duration: 2.5, shape: 'curve' }] }, { at: 2.5, surface: 'room', key: 'after', strokes: [{ start: 0, duration: 0.66, shape: 'line' }] }],
    typing: [{ at: 2.6, surface: 'room', ...SHORT }],
    air: [{ at: 2.7, surface: 'room', in: 0.3, hold: 0.5, out: 0.5 }],
    events: [{ t: 2.0, type: 'mute' }] },
  REF_PEN: { name: 'reference pen line', duration: 2, seed: SEED, pen: [{ at: 0, surface: 'deck', key: 'ref', strokes: [{ start: 0.5, duration: 0.66, shape: 'line', x0: 0.2, x1: 0.8 }] }] },
  REF_WASH: { name: 'reference wash', duration: 2, seed: SEED, pen: [{ at: 0, surface: 'deck', key: 'ref', strokes: [{ start: 0.5, duration: 0.45, shape: 'wash', x0: 0.2, x1: 0.8 }] }] },
  REF_LETTER: { name: 'reference letter', duration: 1.5, seed: SEED, typing: [{ at: 0, surface: 'deck', text: 'a', startAfter: 200, charsPerSecond: 38, end: 'none', vary: false }] },
  REF_SPACE: { name: 'reference space', duration: 1.5, seed: SEED, typing: [{ at: 0, surface: 'deck', text: ' ', startAfter: 200, charsPerSecond: 38, end: 'none', vary: false }] },
  REF_PUNCT: { name: 'reference punctuation', duration: 1.5, seed: SEED, typing: [{ at: 0, surface: 'deck', text: '.', startAfter: 200, charsPerSecond: 38, end: 'none', vary: false }] },
  REF_RETURN: { name: 'reference return', duration: 1.5, seed: SEED, typing: [{ at: 0, surface: 'deck', text: 'a', startAfter: 200, charsPerSecond: 38, end: 'return', vary: false }] },
  REF_SETTLE: { name: 'reference settle', duration: 1.5, seed: SEED, typing: [{ at: 0, surface: 'deck', text: 'a', startAfter: 200, charsPerSecond: 38, end: 'settle', vary: false }] },
  REF_AIR: { name: 'reference air', duration: 5, seed: SEED, air: [{ at: 0, surface: 'deck', in: 0.9, hold: 2, out: 1.6 }] },
};
export const FIXTURES = { typing: TYPING_FIXTURES, shapes: SHAPE_FIXTURES, renders: RENDERS };
// per lane, the fade a stop reason gives it (the engine's policy)
const FADE_POLICY = { step: { pen: 0.16, typing: 0.12, air: 0.3 }, close: { pen: 0.25, typing: 0.12, air: 0.4 } };

/* The engine is a browser script: load it in a bare context where `this` is the sandbox. */
function loadEngine(src) {
  const sandbox = {};
  vm.runInNewContext(src, sandbox, { filename: 'sketchy-sound.js' });
  if (!sandbox.SketchySound || !sandbox.SketchySound.texture) throw new Error('SketchySound.texture is missing: is this the current engine?');
  return sandbox.SketchySound;
}

const dB = (x) => 20 * Math.log10(Math.max(x, 1e-12));
const ms = (s) => (s * 1000).toFixed(1);

/* Float32Arrays serialize as index maps; make the plan output comparable as text. The engine
   runs in its own vm realm, so the typed arrays are checked by view, not by constructor. */
export function planJson(x) {
  return JSON.stringify(x, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));
}
function nodePlans(S) {
  const P = S.texture.plan, out = {};
  for (const [k, v] of Object.entries(TYPING_FIXTURES)) out['typing:' + k] = planJson(P.typing(v, { seed: SEED }));
  for (const [k, v] of Object.entries(SHAPE_FIXTURES)) out['pen:' + k] = planJson(P.pen({ strokes: [v], surface: 'deck', key: k, vary: false }, { seed: SEED }));
  out.air = planJson(P.air({ in: 0.9, hold: 2, out: 1.6 }, { seed: SEED }));
  return out;
}

/* ---------- plan-level checks (F5, F12) ---------- */
function planChecks(S) {
  const out = [];
  const P = S.texture.plan;
  const push = (what, ok, detail) => out.push({ what: detail ? `${what} (${detail})` : what, ok });

  // F5: typing gaps, rate, first tap, end tap
  for (const [name, spec] of Object.entries(TYPING_FIXTURES)) {
    const plan = P.typing(spec, { seed: SEED });
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
  // the worked example of the spec: a budget of 13 keys (9 on words, 4 on spaces), all placed, end tap at 1933 ms
  const hello = P.typing(HELLO, { seed: SEED });
  const spaces = hello.taps.filter((t) => t.kind === 'space').length, letters = hello.taps.filter((t) => t.kind === 'letter' || t.kind === 'punctuation').length;
  push('F5 hello: a budget of 13 keys, all placed, and the end tap at 1933 ms', hello.budget === 13 && letters + spaces === 13 && spaces >= 3 && Math.abs(hello.taps[hello.taps.length - 1].t - 1.933) < 0.002,
    `budget ${hello.budget}, ${letters} letters, ${spaces} spaces, end ${ms(hello.taps[hello.taps.length - 1].t)} ms`);
  const again = P.typing(HELLO, { seed: SEED });
  push('F5 hello: the same text and seed give the same taps', JSON.stringify(again) === JSON.stringify(hello));
  push('F5 hello: another seed moves the jitter but keeps the keys', P.typing(HELLO, { seed: 'other' }).taps.length === hello.taps.length);

  // F12: shape fingerprints on the plan
  const plans = {};
  for (const [shape, st] of Object.entries(SHAPE_FIXTURES)) plans[shape] = P.pen({ strokes: [st], surface: 'deck', key: shape, vary: false }, { seed: SEED });
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
  for (const [shape, plan] of Object.entries(plans)) {
    if (!plan.n) continue;
    let maxStep = 0;
    for (let i = 1; i < plan.L.length; i++) maxStep = Math.max(maxStep, Math.abs(plan.L[i] - plan.L[i - 1]));
    push(`F12 ${shape}: the pressure never steps more than 0.6 between control points and ends under -60 dB`, maxStep <= 0.6 && dB(plan.L[plan.L.length - 1]) < -60, `max step ${maxStep.toFixed(3)}, end ${dB(plan.L[plan.L.length - 1]).toFixed(1)} dB`);
  }
  const many = P.pen({ strokes: [0, 0.1, 0.2, 0.3, 0.4].map((s) => ({ start: s, duration: 0.66, shape: 'ellipse' })), surface: 'deck', key: 'many' }, { seed: SEED });
  push('F12 five overlapping ellipses: L stays at or under 1', peakL(many) <= 1, `peak ${peakL(many).toFixed(3)}`);
  const twice = P.pen({ strokes: [SHAPE_FIXTURES.check], surface: 'deck', key: 'check', vary: false }, { seed: SEED });
  push('F12 the same timeline and seed give the same plan', JSON.stringify(Array.from(twice.L)) === JSON.stringify(Array.from(chk.L)));
  const air = P.air({ in: 0.9, hold: 2, out: 1.6 }, { seed: SEED });
  let airMax = 0, airStep = 0;
  for (let i = 0; i < air.env.length; i++) { airMax = Math.max(airMax, air.env[i]); if (i) airStep = Math.max(airStep, Math.abs(air.env[i] - air.env[i - 1])); }
  push('F12 air: the swell reaches 1, steps under 0.02 per point, ends at 0', airMax === 1 && airStep < 0.02 && air.env[air.env.length - 1] === 0 && air.env[0] === 0, `max ${airMax}, step ${airStep.toFixed(4)}`);
  push('F12 air: in is at least 0.3 s and out at least 0.5 s', P.air({ in: 0.05, hold: 0, out: 0.1 }).in === 0.3 && P.air({ in: 0.05, hold: 0, out: 0.1 }).out === 0.5);
  return out;
}

/* ---------- audio checks: run inside the page, only numbers come back ---------- */
async function analyse({ R, policy, nodePlans, wav, calibrate, typingFixtures, shapeFixtures, seed }) {
  const S = window.SketchySound;
  if (!S || !S.texture || !S.texture.render) throw new Error('SketchySound.texture.render is missing: is this the current engine?');
  const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));
  const W = 0.05, HOP = 0.01;
  const T = S.texture.targets || S.texture.info.targets;
  const checks = [], wavs = [], notes = [];
  const push = (what, ok, detail) => checks.push({ what: detail ? `${what} (${detail})` : what, ok });

  function windows(buf) {
    const sr = buf.sampleRate, L = buf.getChannelData(0), Rr = buf.getChannelData(1), n = L.length, w = Math.round(W * sr), h = Math.round(HOP * sr), out = [];
    for (let s = 0; s + w <= n; s += h) {
      let e = 0;
      for (let i = s; i < s + w; i++) e += (L[i] * L[i] + Rr[i] * Rr[i]) * 0.5;
      out.push({ t: s / sr, db: db(Math.sqrt(e / w)) });
    }
    return out;
  }
  const loudest = (buf, from = 0, to = Infinity) => windows(buf).filter((x) => x.t >= from && x.t + W <= to).reduce((m, x) => Math.max(m, x.db), -Infinity);
  function peak(buf) {
    let pk = 0, nan = 0;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < d.length; i++) { if (!Number.isFinite(d[i])) nan++; else pk = Math.max(pk, Math.abs(d[i])); } }
    return { pk, nan };
  }
  const env = (buf) => buf.getChannelData(0);   // a probe stem carries the gain automation on both channels
  const inTransition = (t0, t1, trans) => trans.some((x) => t0 < x.t + x.length && t1 > x.t);
  const fc = (fx) => ({ ...fx, cues: fx.cues || (fx.name && fx.name.startsWith('F-C') ? S.cue.names.map((n, i) => ({ t: 0.5 + i * 0.4, name: n })) : undefined) });
  const render = (fx, extra = {}) => S.texture.render({ ...fc(fx), ...extra });
  const toB64 = (ab) => { const u = new Uint8Array(ab); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };

  /* --- calibration first, so the checks see the values it found --- */
  const cal = { pen: S.texture.cal.pen, typing: S.texture.cal.typing, air: S.texture.cal.air, kind: { ...S.texture.cal.kind }, measured: {} };
  // a texture's loudness moves with the noise segment its seed picks, so a reference is the
  // loudest of several seeds: the level a listener can ever get, which is what the margin is about
  const SEEDS = 6;
  const measure = async (fx, from = 0) => {
    let top = -Infinity;
    for (let i = 0; i < SEEDS; i++) top = Math.max(top, loudest((await render({ ...fx, seed: `${seed}-${i}` }, { master: true, stems: false })).mix, from));
    return top;
  };
  if (calibrate) {
    const bisect = async (lane, fx, target, from) => {
      let lo = S.texture.cal[lane] / 16, hi = S.texture.cal[lane] * 16;
      for (let i = 0; i < 10; i++) {
        const mid = Math.sqrt(lo * hi);
        S.texture.cal[lane] = mid;
        if ((await measure(fx, from)) < target) lo = mid; else hi = mid;
      }
      S.texture.cal[lane] = Math.sqrt(lo * hi);
      return S.texture.cal[lane];
    };
    cal.pen = await bisect('pen', R.REF_PEN, T.pen, 0);
    cal.typing = await bisect('typing', R.REF_LETTER, T.letter, 0);
    cal.air = await bisect('air', R.REF_AIR, T.air, 0);
    // the other tap kinds: measured with the letter trim, then trimmed to their targets
    const kinds = [['space', R.REF_SPACE, T.space, 0], ['punctuation', R.REF_PUNCT, T.punctuation, 0], ['return', R.REF_RETURN, T['return'], 0.32], ['settle', R.REF_SETTLE, T.settle, 0.32]];
    for (const [k, fx, target, from] of kinds) {
      for (let i = 0; i < 3; i++) { const got = await measure(fx, from); S.texture.cal.kind[k] += target - got; }
      cal.kind[k] = Math.round(S.texture.cal.kind[k] * 10) / 10;
      S.texture.cal.kind[k] = cal.kind[k];
    }
  }
  cal.measured = {
    pen: await measure(R.REF_PEN), wash: await measure(R.REF_WASH), letter: await measure(R.REF_LETTER), space: await measure(R.REF_SPACE),
    punctuation: await measure(R.REF_PUNCT), 'return': await measure(R.REF_RETURN, 0.32), settle: await measure(R.REF_SETTLE, 0.32), air: await measure(R.REF_AIR),
  };

  /* --- the fixtures --- */
  const FA = await render(R.FA, { master: true }), FB = await render(R.FB, { master: true });
  const FCm = await render(R.FC, { master: true }), FCn = await render({ ...R.FC, mood: 'none', name: 'F-C stress without music' }, { master: true });
  const sets = [['F-A', FA], ['F-B', FB], ['F-C', FCn]];

  // F1 exclusivity: outside the declared transitions no two stems are above -60 dBFS in one window
  for (const [name, r] of sets) {
    const ws = { pen: windows(r.stems.pen), typing: windows(r.stems.typing), air: windows(r.stems.air) }, trans = r.plan.transitions;
    let bad = 0, worst = null;
    for (let i = 0; i < ws.pen.length; i++) {
      const up = ['pen', 'typing', 'air'].filter((l) => ws[l][i].db > -60);
      if (up.length >= 2 && !inTransition(ws.pen[i].t, ws.pen[i].t + W, trans)) { bad++; if (!worst) worst = `${up.join('+')} at ${ws.pen[i].t.toFixed(2)} s`; }
    }
    push(`F1 ${name}: one texture lane audible at a time outside transitions`, bad === 0, bad ? `${bad} windows, first ${worst}` : `${trans.length} transitions`);
    // an air swell declares its own fade in as air -> air; it hands nothing over, so it is not a lane transition
    const long = trans.filter((x) => x.to !== 'silence' && x.to !== 'lane' && x.from !== x.to && x.length > 0.26);
    push(`F1 ${name}: every lane transition is at most 260 ms`, long.length === 0, long.length ? `${long.length} longer` : '');
  }

  // F2 duck: envelope probe under a click (-9 dB) and a celebrate (-15 dB)
  {
    const r = await render(R.DUCK), e = env(r.stems.air), sr = r.stems.air.sampleRate, at = (t) => e[Math.min(e.length - 1, Math.round(t * sr))];
    for (const cue of r.plan.cues) {
      if (!cue.admitted) { push(`F2 ${cue.name}: the cue was admitted`, false); continue; }
      const deep = cue.name === 'celebrate' || cue.name === 'sketch-done' || cue.name === 'error-soft', depth = deep ? -15 : -9, span = S.cue.info(cue.name).max, back = deep ? 0.30 : 0.25;
      const pre = at(cue.t - 0.01), reach = db(at(cue.t + 0.02) / pre);
      let lo = Infinity, hi = -Infinity;
      for (let t = cue.t + 0.02; t <= cue.t + span; t += 0.001) { const v = db(at(t) / pre); lo = Math.min(lo, v); hi = Math.max(hi, v); }
      const ret = db(at(cue.t + span + back) / pre);
      push(`F2 ${cue.name}: reaches ${depth} dB within 0.5 dB by t + 20 ms`, Math.abs(reach - depth) <= 0.5, `${reach.toFixed(2)} dB`);
      push(`F2 ${cue.name}: holds within 0.5 dB to t + span`, Math.abs(lo - depth) <= 0.5 && Math.abs(hi - depth) <= 0.5, `${lo.toFixed(2)} to ${hi.toFixed(2)} dB`);
      push(`F2 ${cue.name}: back within 1 dB by t + span + ${back * 1000} ms`, Math.abs(ret) <= 1, `${ret.toFixed(2)} dB`);
    }
  }

  // F3 fades, F4 clicks, F10 silence: the stop fixtures on the envelope probe and in audio
  const stops = [['STOP_A', R.STOP_A, 'step'], ['STOP_B', R.STOP_B, 'close']];
  const probes = { FA: await render(R.FA, { probe: 'envelope' }) };
  for (const [key, fx, reason] of stops) {
    const pr = await render(fx, { probe: 'envelope' }), au = await render(fx, { master: true }), tStop = fx.events[0].t;
    probes[key] = pr;
    for (const lane of ['pen', 'typing', 'air']) {
      const e = env(pr.stems[lane]), sr = pr.stems[lane].sampleRate, i0 = Math.round(tStop * sr), v = e[i0], fade = policy[reason][lane];
      let pk = 0;
      for (let i = 0; i < e.length; i++) pk = Math.max(pk, e[i]);
      if (!(pk > 0) || db(v / pk) < -60) { notes.push(`F3 ${key} ${lane}: silent at the stop, nothing to fade`); continue; }
      let mono = true, t1 = -1, t60 = -1, t80 = -1;
      for (let i = i0 + 1; i < e.length; i++) {
        if (e[i] > e[i - 1] + 1e-9) { mono = false; break; }
        const rel = db(e[i] / v);
        if (t1 < 0 && rel <= -1) t1 = i / sr;
        if (t60 < 0 && rel <= -60) t60 = i / sr;
        if (t80 < 0 && rel <= -80) t80 = i / sr;
      }
      push(`F3 ${key} ${lane}: monotonic from the stop to silence`, mono);
      push(`F3 ${key} ${lane}: at least 70 ms from -1 dB to -60 dB`, t1 >= 0 && t60 >= 0 && t60 - t1 >= 0.07, `${((t60 - t1) * 1000).toFixed(0)} ms`);
      push(`F3 ${key} ${lane}: below -80 dB by fade + 30 ms`, t80 >= 0 && t80 <= tStop + fade + 0.03, `${t80 >= 0 ? ((t80 - tStop) * 1000).toFixed(0) : 'never'} ms after the stop, fade ${fade * 1000} ms`);
      // F10: the audio stem is silent from fade + 50 ms on
      const after = loudest(au.stems[lane], tStop + fade + 0.05);
      push(`F10 ${key} ${lane}: below -90 dBFS from the stop + fade + 50 ms`, after < -90, `${after.toFixed(1)} dBFS`);
    }
  }
  for (const [key, pr] of Object.entries(probes)) {
    const stopAt = R[key].events ? R[key].events[0].t : -1;
    for (const lane of ['pen', 'typing', 'air']) {
      const e = env(pr.stems[lane]), sr = pr.stems[lane].sampleRate;
      let pk = 0, worst = 0, worstFade = 0;
      for (let i = 0; i < e.length; i++) pk = Math.max(pk, Math.abs(e[i]));
      for (let i = 1; i < e.length; i++) {
        const d = Math.abs(e[i] - e[i - 1]);
        if (d > worst) worst = d;
        if (stopAt >= 0 && i / sr >= stopAt && i / sr <= stopAt + 0.08 && d > worstFade) worstFade = d;
      }
      if (!(pk > 0)) continue;
      push(`F4 ${key} ${lane}: no gain step over peak / 240 per sample`, worst <= pk / 240, `peak / ${(pk / Math.max(worst, 1e-12)).toFixed(0)}`);
      if (stopAt >= 0) push(`F4 ${key} ${lane}: no gain step over peak / 3840 inside the stop fade`, worstFade <= pk / 3840, `peak / ${(pk / Math.max(worstFade, 1e-12)).toFixed(0)}`);
    }
  }
  // F4 audio: no stem louder than its lane's ceiling by more than 1 dB; F6 margin and references
  const ceiling = { pen: T.penCeiling, typing: T['return'], air: T.air };
  for (const [name, r] of sets) {
    for (const lane of ['pen', 'typing', 'air']) {
      const l = loudest(r.stems[lane]);
      push(`F4 ${name} ${lane}: within 1 dB of the lane's ceiling (${ceiling[lane]} dBFS)`, l <= ceiling[lane] + 1, `${l.toFixed(1)} dBFS`);
      push(`F6 ${name} ${lane}: loudest 50 ms at or under the margin (${T.margin} dBFS)`, l <= T.margin + 0.05, `${l.toFixed(2)} dBFS`);
    }
  }
  push(`F6 pen reference line ${T.pen} dBFS within 1 dB`, Math.abs(cal.measured.pen - T.pen) <= 1, `${cal.measured.pen.toFixed(1)} dBFS, PEN_CAL ${cal.pen}`);
  push(`F6 letter tap ${T.letter} dBFS within 1 dB`, Math.abs(cal.measured.letter - T.letter) <= 1, `${cal.measured.letter.toFixed(1)} dBFS, TYPE_CAL ${cal.typing}`);
  push(`F6 air hold ${T.air} dBFS within 1 dB`, Math.abs(cal.measured.air - T.air) <= 1, `${cal.measured.air.toFixed(1)} dBFS, AIR_CAL ${cal.air}`);
  push('F6 wash whisper at or under -62 dBFS', cal.measured.wash <= -62, `${cal.measured.wash.toFixed(1)} dBFS`);
  for (const k of ['space', 'punctuation', 'return', 'settle']) push(`F6 ${k} tap ${T[k]} dBFS within 1.5 dB`, Math.abs(cal.measured[k] - T[k]) <= 1.5, `${cal.measured[k].toFixed(1)} dBFS, trim ${cal.kind[k]} dB`);

  // F7 peaks
  push('F7 F-C mix peak under -1 dBFS with music', peak(FCm.mix).pk < 0.891 && peak(FCm.mix).nan === 0, `${db(peak(FCm.mix).pk).toFixed(1)} dBFS`);
  push('F7 F-C mix peak under -1 dBFS without music', peak(FCn.mix).pk < 0.891 && peak(FCn.mix).nan === 0, `${db(peak(FCn.mix).pk).toFixed(1)} dBFS`);

  // F8 determinism
  const FA2 = await render(R.FA, { master: true }), FAo = await render({ ...R.FA, seed: 'another-seed' }, { master: true, stems: false });
  push('F8 two renders of F-A give the same samples', S.hashBuffer(FA.mix) === S.hashBuffer(FA2.mix) && S.hashBuffer(FA.stems.pen) === S.hashBuffer(FA2.stems.pen));
  push('F8 another seed gives different samples', S.hashBuffer(FA.mix) !== S.hashBuffer(FAo.mix));
  {
    const P = S.texture.plan, mine = {}, j = (x) => JSON.stringify(x, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));
    for (const [k, v] of Object.entries(typingFixtures)) mine['typing:' + k] = j(P.typing(v, { seed }));
    for (const [k, v] of Object.entries(shapeFixtures)) mine['pen:' + k] = j(P.pen({ strokes: [v], surface: 'deck', key: k, vary: false }, { seed }));
    mine.air = j(P.air({ in: 0.9, hold: 2, out: 1.6 }, { seed }));
    const differ = Object.keys(nodePlans).filter((k) => nodePlans[k] !== mine[k]);
    push('F8 plan.* give the same output in node and in the browser', differ.length === 0, differ.length ? `differ: ${differ.join(', ')}` : `${Object.keys(mine).length} plans equal`);
  }

  // F9 one voice, pool, no texture voice in the cue sink
  {
    let voices = 0, used = 0;
    for (const s of FB.plan.states) { voices = Math.max(voices, s.state.lanes.pen.voices); used = Math.max(used, s.state.pool.used); }
    push('F9 F-B: at most one pen voice per surface', voices <= 1, `${voices}`);
    push('F9 F-B: pool used at most 12', used <= 12 && FB.plan.state.pool.size === 12, `${used} of ${FB.plan.state.pool.size}`);
    const bare = await render({ ...R.FA, pen: [], typing: [], air: [] }, { master: true, stems: false });
    push('F9 F-A: textures take no cue slot', FA.plan.cueSlots === FA.plan.cueSlotsAlone && FA.plan.cueSlots === bare.plan.cueSlots, `${FA.plan.cueSlots} cue slots with textures, ${bare.plan.cueSlots} without`);
  }

  // F11 reduced and muted
  for (const [key, fx] of [['REDUCED', R.REDUCED], ['MUTE', R.MUTE]]) {
    const r = await render(fx, { master: true }), t = fx.events[0].t;
    for (const lane of ['pen', 'typing', 'air']) {
      const l = loudest(r.stems[lane], t + 0.25);
      push(`F11 ${key} ${lane}: below -90 dBFS from 250 ms after the event`, l < -90, `${l.toFixed(1)} dBFS`);
    }
    const after = r.plan.ids.filter((x) => x.t > t);
    push(`F11 ${key}: plans submitted after the event return 0`, after.length > 0 && after.every((x) => x.id === 0), `${after.map((x) => x.lane + ':' + x.id).join(', ')}`);
  }

  // F15 to F17: a stop, or a report right after one, continues from where the voice is. The envelope
  // probe makes the stem the gain automation itself, so these are exact statements about the gains.
  const STOP_LEAD = 0.01, LEAD = 0.03;   // the engine's: a stop fades from its event + 10 ms, a report acts at its event + 30 ms
  const ms2 = (s) => (s * 1000).toFixed(0);
  const gainAt = (e, sr, t) => e[Math.min(e.length - 1, Math.round(t * sr))];
  const gainMin = (e, sr, a, b) => { let m = Infinity; for (let i = Math.round(a * sr); i <= Math.min(e.length - 1, Math.round(b * sr)); i++) m = Math.min(m, e[i]); return m; };
  const gainMax = (e, sr, a, b) => { let m = 0; for (let i = Math.round(a * sr); i <= Math.min(e.length - 1, Math.round(b * sr)); i++) m = Math.max(m, e[i]); return m; };

  // F15: two stops in a row, then a pen report while the second fade runs
  {
    const fx = R.STOP_TWICE, r = await render(fx, { probe: 'envelope' }), e = env(r.stems.pen), sr = r.stems.pen.sampleRate, pk = peak(r.stems.pen).pk;
    const tc2 = fx.events[1].t + STOP_LEAD, fadeEnd = tc2 + policy.close.pen, report = fx.pen[1].at + LEAD;
    const before = gainAt(e, sr, tc2), after = gainAt(e, sr, tc2 + 0.03), ratio = after / before;
    push('F15 two stops: the pen still sounds when the second stop comes', before > 1e-5, `${before.toExponential(2)}`);
    push('F15 two stops: the second stop carries on from the first, still at least half the level 30 ms later', tc2 + 0.03 < report && ratio >= 0.5, `${ratio.toFixed(2)} of the level at the stop (a cut reads 0)`);
    const silent = gainMin(e, sr, fadeEnd - 0.01, fadeEnd + 0.01);
    push('F15 a pen report during the fade: the lane reaches silence at the end of the fade, it is not raised before', silent <= pk * 1e-3, `${db(silent / pk).toFixed(0)} dB re peak at ${fadeEnd.toFixed(2)} s`);
    const again = gainMax(e, sr, fadeEnd + 0.21, fadeEnd + 0.4);
    push('F15 a pen report during the fade: the new line sounds once the lane has risen again', again >= pk * 0.02, `${db(again / pk).toFixed(0)} dB re peak`);
  }

  // F16: a typing line stopped, then reported again, taps at once instead of waiting for the old line's time
  {
    const fx = R.TYPE_AGAIN, r = await render(fx), idAt = (at) => ((r.plan.ids.find((x) => x.lane === 'typing' && Math.abs(x.t - at) < 1e-9) || {}).id) | 0;
    const rowOf = (id) => r.plan.plans.find((p) => p.id === id);
    const idA = idAt(fx.typing[0].at), idB = idAt(fx.typing[1].at), rowB = rowOf(idB);
    push('F16 typing: the first line is planned and stopped before it taps', idA > 0 && !!rowOf(idA) && rowOf(idA).cancelled);
    push('F16 typing: a line reported 50 ms after the stop is planned (an id, not 0)', idB > 0, `id ${idB}`);
    // its own start is t1: the first character shows one interval after startAfter (spec 4.2)
    const hello = typingFixtures.hello, first = rowB && rowB.taps.length ? rowB.taps[0].t : Infinity;
    const wanted = fx.typing[1].at + hello.startAfter / 1000 + 1 / hello.charsPerSecond;
    push('F16 typing: it taps at once, from its own start (within 20 ms) and with the keys it has', !!rowB && rowB.taps.length >= 3 && Math.abs(first - wanted) <= 0.02, rowB ? `${rowB.taps.length} taps, first ${ms2(first)} ms, wanted ${ms2(wanted)} ms` : 'no plan');
    const live = r.plan.plans.filter((p) => p.lane === 'typing' && !p.cancelled).flatMap((p) => p.taps.map((x) => x.t)).sort((a, b) => a - b);
    let minGap = Infinity;
    for (let i = 1; i < live.length; i++) minGap = Math.min(minGap, live[i] - live[i - 1]);
    push('F16 typing: two lines alive at once still keep their taps 55 ms apart', live.length < 2 || minGap >= 0.055 - 1e-9, `${live.length} taps, min gap ${ms2(minGap)} ms`);
  }

  // F17: a new air swell right after a stop starts after the stop's fade, and the old one is not cut
  {
    const fx = R.AIR_AFTER_STOP, r = await render(fx, { probe: 'envelope' }), e = env(r.stems.air), sr = r.stems.air.sampleRate, pk = peak(r.stems.air).pk;
    const tc = fx.events[0].t + STOP_LEAD, fadeEnd = tc + policy.step.air;
    const ratio = gainAt(e, sr, fx.events[0].t + 0.12) / gainAt(e, sr, fx.events[0].t);
    push('F17 air: after a stop and a report, the old swell keeps fading 120 ms in (at least 20 % of its level, a cut reads 0)', ratio >= 0.2, `${ratio.toFixed(2)}`);
    const silent = gainMin(e, sr, fadeEnd - 0.01, fadeEnd + 0.01);
    push('F17 air: the fade reaches silence before the new swell begins', silent <= pk * 1e-3, `${db(silent / pk).toFixed(0)} dB re peak at ${fadeEnd.toFixed(2)} s`);
    const again = gainMax(e, sr, 1.8, 2.5);
    push('F17 air: the new swell sounds afterwards', again >= pk * 0.3, `${db(again / pk).toFixed(0)} dB re peak`);
  }

  // F13 cues untouched: the cue stem is bit-identical with and without textures
  for (const [name, fx] of [['F-A', R.FA], ['F-C', R.FC]]) {
    const withTex = await render(fx), without = await render({ ...fx, pen: [], typing: [], air: [] });
    push(`F13 ${name}: the cue stem is bit-identical with and without textures`, S.hashBuffer(withTex.stems.cues) === S.hashBuffer(without.stems.cues));
  }

  // F14 air yields
  {
    const trans = FA.plan.transitions, ws = windows(FA.stems.air);
    // a window can only be yielded to from the moment its report arrives (plus LEAD): a stroke that
    // starts as it is reported opens its window 50 ms in the past, and the air leaves on a declared
    // lane transition from the report on
    const reports = [...R.FA.pen, ...R.FA.typing].map((x) => x.at).sort((a, b) => a - b);
    const known = ([a, b]) => { let at = 0; for (const r of reports) if (r <= b) at = r; return [Math.max(a, at + 0.03), b]; };
    const act = (FA.plan.surfaces.room ? FA.plan.surfaces.room.activity : []).map(known);
    for (const p of FA.plan.plans) if (p.lane === 'typing' && !p.cancelled) act.push(known([p.t1 - 0.02, p.tEnd + 0.25]));
    let bad = 0, worst = -Infinity, first = null;
    for (const x of ws) {
      const inside = act.some(([a, b]) => x.t >= a && x.t + W <= b);
      if (inside && !inTransition(x.t, x.t + W, trans) && x.db > -70) { bad++; worst = Math.max(worst, x.db); if (first === null) first = x.t; }
    }
    const spans = act.map(([a, b]) => `${a.toFixed(2)}-${b.toFixed(2)}`).join(', ');
    push('F14 F-A: the air stays under -70 dBFS inside every pen or typing activity window', bad === 0, bad ? `${bad} windows, loudest ${worst.toFixed(1)} dBFS, first at ${first.toFixed(2)} s; activity ${spans}` : `${act.length} windows`);
    push('F14 F-C: the air is silent while music plays', loudest(FCm.stems.air) < -90, `${loudest(FCm.stems.air).toFixed(1)} dBFS`);
  }

  if (wav) {
    for (const [name, r] of [['F-A', FA], ['F-B', FB], ['F-C-music', FCm], ['F-C', FCn]]) {
      wavs.push({ file: `${name}-mix.wav`, data: toB64(S.toWav(r.mix)) });
      for (const lane of ['pen', 'typing', 'air', 'cues']) wavs.push({ file: `${name}-${lane}.wav`, data: toB64(S.toWav(r.stems[lane])) });
    }
  }
  return { checks, notes, wavs, cal };
}

/* The live path: reports return 0 until sound is on, an id afterwards, and stopAll fades. */
async function liveChecks(browser, src) {
  const page = await browser.newPage();
  const out = [];
  try {
    await page.setContent('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>live</title></head><body><button data-sk-sound-toggle>muted</button></body></html>');
    await page.addScriptTag({ content: src });
    const off = await page.evaluate(() => window.SketchySound.texture.pen({ strokes: [{ start: 0, duration: 0.66, shape: 'line' }] }));
    out.push({ what: 'live: texture.pen() returns 0 while sound is off', ok: off === 0 });
    await page.click('button');
    let running = true;
    try { await page.waitForFunction(() => window.SketchySound.play('tap-soft', { force: true, gain: 0.01 }), null, { timeout: 5000, polling: 100 }); }
    catch { running = false; }
    if (!running) { out.push({ what: 'live: the audio context runs after a click', ok: false }); return out; }
    const on = await page.evaluate(() => {
      const S = window.SketchySound;
      const id = S.texture.pen({ strokes: [{ start: 0.05, duration: 0.66, shape: 'ellipse' }], surface: 'deck', key: 'live' });
      const st = S.texture.state();
      const tid = S.texture.typing({ text: 'Hello there', startAfter: 100, charsPerSecond: 40, end: 'settle' });
      return { id, tid, lane: st.lanes.pen.state, size: st.pool.size, surface: st.surface };
    });
    out.push({ what: `live: texture.pen() and typing() return plan ids once sound is on (pen ${on.id}, typing ${on.tid})`, ok: on.id > 0 && on.tid > 0 });
    out.push({ what: `live: state() reports the surface, a scheduled or active pen lane and a pool of 12 (${on.surface}, ${on.lane})`, ok: on.surface === 'deck' && (on.lane === 'scheduled' || on.lane === 'active') && on.size === 12 });
    await page.waitForTimeout(300);
    const stopped = await page.evaluate(() => { const S = window.SketchySound; S.texture.stopAll(120, 'step'); const a = S.texture.state().lanes.pen.state; return a; });
    out.push({ what: `live: stopAll puts the lanes into fading (${stopped})`, ok: stopped === 'fading' || stopped === 'idle' });
    await page.waitForTimeout(400);
    const idle = await page.evaluate(() => window.SketchySound.texture.state().lanes.pen.state);
    out.push({ what: `live: the lane is idle after the fade (${idle})`, ok: idle === 'idle' });
    const muted = await page.evaluate(() => { window.SketchySound.disable(); return window.SketchySound.texture.pen({ strokes: [{ start: 0, duration: 0.66, shape: 'line' }] }); });
    out.push({ what: 'live: after disable() a report returns 0', ok: muted === 0 });
  } finally {
    await page.close();
  }
  return out;
}

async function main() {
  const { values } = parseArgs(process.argv.slice(2), SPEC);
  const engine = path.join(ENGINE_DIR, 'sketchy-sound.js');
  if (!fs.existsSync(engine)) die(`engine not found: ${engine}`);
  const src = fs.readFileSync(engine, 'utf8');
  const S = loadEngine(src);
  let bad = 0;

  say.line(c.bold('textures: plan-level checks in node (F5 typing rhythm, F12 shape fingerprints)'));
  for (const k of planChecks(S)) { if (!k.ok) bad++; (k.ok ? say.ok : say.error)(k.what); }
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
  say.line(c.bold(`textures: audio checks in headless Chromium${values.calibrate ? ' (calibrating first)' : ''}`));
  say.line(c.dim('levels: the loudest 50 ms of the mean power of both channels through the master chain'));
  const pw = requirePlaywright();
  const browser = await launchChromium(pw);
  let res;
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => say.error(`page: ${e.message}`));
    await page.setContent('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>texture check</title></head><body></body></html>');
    await page.addScriptTag({ content: src });
    res = await page.evaluate(analyse, { R: RENDERS, policy: FADE_POLICY, nodePlans: nodePlans(S), wav: Boolean(values.wav), calibrate: Boolean(values.calibrate),
      typingFixtures: TYPING_FIXTURES, shapeFixtures: SHAPE_FIXTURES, seed: SEED });
    res.checks.push(...await liveChecks(browser, src));
  } finally {
    await browser.close();
  }
  for (const k of res.checks) { if (!k.ok) bad++; (k.ok ? say.ok : say.error)(k.what); }
  for (const n of res.notes) say.info(n);
  say.line();
  const m = res.cal.measured;
  say.line(`measured: pen ${m.pen.toFixed(1)}, wash ${m.wash.toFixed(1)}, letter ${m.letter.toFixed(1)}, space ${m.space.toFixed(1)}, punctuation ${m.punctuation.toFixed(1)}, return ${m['return'].toFixed(1)}, settle ${m.settle.toFixed(1)}, air ${m.air.toFixed(1)} dBFS`);
  if (values.calibrate) {
    say.line(c.bold('calibration: freeze these in engine/sketchy-sound.js'));
    say.line(`  var PEN_CAL = ${+res.cal.pen.toPrecision(4)}, TYPE_CAL = ${+res.cal.typing.toPrecision(4)}, AIR_CAL = ${+res.cal.air.toPrecision(4)};`);
    say.line(`  var TAP_TRIM = { letter: 0, space: ${res.cal.kind.space}, punctuation: ${res.cal.kind.punctuation}, 'return': ${res.cal.kind['return']}, settle: ${res.cal.kind.settle} };`);
  }
  if (values.wav) {
    const dir = path.resolve(values.wav);
    fs.mkdirSync(dir, { recursive: true });
    for (const w of res.wavs) fs.writeFileSync(path.join(dir, w.file), Buffer.from(w.data, 'base64'));
    say.info(`wrote ${res.wavs.length} WAV files (master chain, 48 kHz) to ${dir}`);
  }
  say.line();
  if (bad) { say.error(`${bad} problem${bad === 1 ? '' : 's'} found`); process.exit(1); }
  say.ok('every texture check passed');
}

if (isMain(import.meta.url)) main().catch((e) => die(String(e && e.stack ? e.stack : e), null, 2));
