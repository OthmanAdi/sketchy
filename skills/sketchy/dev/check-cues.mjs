#!/usr/bin/env node
// check-cues.mjs: render every UI cue of engine/sketchy-sound.js offline in headless
// Chromium (OfflineAudioContext, the engine's own graph) and hold it to its contract:
// no NaN, peak under 0.9, audible length inside the declared span, the last 50 ms of the
// render under -60 dBFS, a smooth end, the same samples on a second render, and no two
// cues (or a cue and an existing effect) near-identical.
//
//   node skills/sketchy/dev/check-cues.mjs [--seeds 6] [--wav <dir>]
//
// Peaks, lengths and tails are measured on the effect bus (level 1, before the master
// gain of 0.15), so a cue that passes here passes with room to spare when it plays. The
// "out" columns are what a listener hears: cue.render with master: true, through the live
// master chain, a cue without a pan on both channels. Loudness is the mean power of the
// two channels.
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE_DIR, requirePlaywright, launchChromium, parseArgs, say, c, die, isMain } from '../scripts/_lib.mjs';

const SPEC = {
  name: 'check-cues',
  file: 'skills/sketchy/dev/check-cues.mjs',
  summary: 'render the UI cues offline and check peak, length, tails, determinism and similarity',
  usage: '[--seeds <n>] [--wav <dir>]',
  options: [
    { name: 'seeds', type: 'number', default: 6, help: 'seeded variations rendered per cue (default 6)' },
    { name: 'wav', type: 'string', arg: 'dir', help: 'also write each nominal cue and a sequence of all cues as WAV files' },
  ],
};

const PEAK_LIMIT = 0.9;          // linear, on the effect bus
const TAIL_DB = -60;             // the last 50 ms of a render of (longest span + 50 ms)
const EDGE_DB = -48;             // the 2 ms before the sound drops under -60 dBFS: a decay, not a cut
const SIMILAR_LIMIT = 0.9;       // Pearson correlation of two onset-aligned spectrograms
// quietest first: contact, selection, motion and outcomes, the celebration
const LADDER = [['click', 'tap-soft'], ['select', 'toggle-on', 'toggle-off'],
  ['step-next', 'step-back', 'page-next', 'page-back', 'reveal', 'dismiss', 'sketch-done', 'error-soft'], ['celebrate']];
const EFFECTS = ['pencil', 'scribble', 'page', 'flip', 'stamp', 'tap', 'tick', 'pop', 'whoosh', 'bell', 'chime', 'success', 'fail', 'paper'];

/* Runs inside the page. Everything heavy stays there; only numbers come back. */
async function analyse({ seeds, wav, effects, limits }) {
  const S = window.SketchySound;
  if (!S || !S.cue || !S.cue.render) throw new Error('SketchySound.cue.render is missing: is this the current engine?');
  const T60 = Math.pow(10, -60 / 20);
  const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < len / 2; k++) {
          const wr = Math.cos(ang * k), wi = Math.sin(ang * k), x = i + k, y = x + len / 2;
          const tr = re[y] * wr - im[y] * wi, ti = re[y] * wi + im[y] * wr;
          re[y] = re[x] - tr; im[y] = im[x] - ti; re[x] += tr; im[x] += ti;
        }
      }
    }
  }

  function levels(buf) {
    const sr = buf.sampleRate, L = buf.getChannelData(0), R = buf.getChannelData(1), n = L.length;
    let peak = 0, nan = 0, first = -1, last = -1;
    for (let i = 0; i < n; i++) {
      const a = L[i], b = R[i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) { nan++; continue; }
      const m = Math.max(Math.abs(a), Math.abs(b));
      if (m > peak) peak = m;
      if (m > T60) { if (first < 0) first = i; last = i; }
    }
    let tail = 0;
    for (let i = n - Math.round(0.05 * sr); i < n; i++) tail = Math.max(tail, Math.abs(L[i]), Math.abs(R[i]));
    let edge = 0;
    for (let i = Math.max(0, last - Math.round(0.002 * sr)); i <= last && i >= 0; i++) edge = Math.max(edge, Math.abs(L[i]), Math.abs(R[i]));
    // short-term loudness proxy: the loudest 50 ms window of the mean power of both channels, 5 ms hop
    const w = Math.round(0.05 * sr), hop = Math.round(0.005 * sr);
    let loud = 0;
    for (let s = 0; s + w <= n; s += hop) {
      let e = 0;
      for (let i = s; i < s + w; i++) e += (L[i] * L[i] + R[i] * R[i]) * 0.5;
      loud = Math.max(loud, Math.sqrt(e / w));
    }
    return { peak, nan, first, last, tail, edge, loud, length: first < 0 ? 0 : (last - first) / sr, onset: first / sr };
  }

  // magnitude-weighted mean frequency over the audible part
  function centroid(buf, lv) {
    const N = 4096, L = buf.getChannelData(0), R = buf.getChannelData(1);
    let num = 0, den = 0;
    for (let s = Math.max(0, lv.first); s < lv.last; s += N / 2) {
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < N && s + i < L.length; i++) re[i] = (L[s + i] + R[s + i]) * 0.5 * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
      fft(re, im);
      for (let k = 1; k < N / 2; k++) { const m = Math.hypot(re[k], im[k]); num += m * k * buf.sampleRate / N; den += m; }
    }
    return den ? num / den : 0;
  }

  /* Spectrogram fingerprint, aligned at the onset: 1024-point frames every 5 ms, 24
     log bands from 120 Hz to 14 kHz plus the left and right level, each in dB relative
     to the sound's own loudest cell, floored at -60 dB and mapped to 0..1. */
  const BANDS = 24, F_LO = 120, F_HI = 14000;
  function fingerprint(buf, lv) {
    const sr = buf.sampleRate, N = 1024, H = Math.round(0.005 * sr), L = buf.getChannelData(0), R = buf.getChannelData(1);
    const edges = [];
    for (let b = 0; b <= BANDS; b++) edges.push(Math.round(F_LO * Math.pow(F_HI / F_LO, b / BANDS) * N / sr));
    const frames = [], start = Math.max(0, lv.first), stop = Math.max(start + 1, lv.last);
    let max = 1e-30;
    for (let s = start; s < stop; s += H) {
      const re = new Float64Array(N), im = new Float64Array(N);
      let eL = 0, eR = 0;
      for (let i = 0; i < N && s + i < L.length; i++) {
        const win = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
        re[i] = (L[s + i] + R[s + i]) * 0.5 * win;
        eL += (L[s + i] * win) ** 2; eR += (R[s + i] * win) ** 2;
      }
      fft(re, im);
      const row = [];
      for (let b = 0; b < BANDS; b++) {
        let e = 0;
        for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) e += re[k] * re[k] + im[k] * im[k];
        row.push(e);
      }
      row.push(eL, eR);
      for (const e of row) if (e > max) max = e;
      frames.push(row);
    }
    const ref = 10 * Math.log10(max);
    return frames.map((row) => row.map((e) => Math.min(1, Math.max(0, (10 * Math.log10(e + 1e-30) - ref + 60) / 60))));
  }
  function similarity(a, b) {
    const n = Math.max(a.length, b.length), x = [], y = [];
    for (let f = 0; f < n; f++) {
      const ra = a[f], rb = b[f], w = (ra || rb).length;
      for (let k = 0; k < w; k++) { x.push(ra ? ra[k] : 0); y.push(rb ? rb[k] : 0); }
    }
    let mx = 0, my = 0;
    for (let i = 0; i < x.length; i++) { mx += x[i]; my += y[i]; }
    mx /= x.length; my /= y.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < x.length; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    return sxy / Math.max(1e-12, Math.sqrt(sxx * syy));
  }

  const out = { cues: [], pairs: [], refs: [], checks: [], wavs: [] };
  const prints = {}, nominal = {};
  for (const name of S.cue.names) {
    const info = S.cue.info(name);
    const runs = [];
    const nom = await S.cue.render(name, { vary: false, level: 1, key: 'C' });
    nominal[name] = nom;
    const lvN = levels(nom);
    runs.push(lvN);
    for (let k = 0; k < seeds; k++) runs.push(levels(await S.cue.render(name, { seed: 'cue-check-' + k, level: 1 })));
    const again = await S.cue.render(name, { seed: 'cue-check-0', level: 1 });
    const first = await S.cue.render(name, { seed: 'cue-check-0', level: 1 });
    const same = S.hashBuffer(again) === S.hashBuffer(first);
    const self = await S.cue.render(name, { seed: 'cue-check-self', level: 1, key: 'C' });
    prints[name] = fingerprint(nom, lvN);
    const selfSim = similarity(prints[name], fingerprint(self, levels(self)));
    // the deck path: the public renderer with the full master chain, cue at 0.1 s
    const deck = await S.renderOffline({ mood: 'none', duration: 0.1 + info.max + 0.25, cues: [{ t: 0.1, name }] });
    const lvD = levels(deck);
    const lvO = levels(await S.cue.render(name, { master: true, vary: false, key: 'C' }));
    out.cues.push({
      name, min: info.min, max: info.max, gap: info.gap,
      lenMin: Math.min(...runs.map((r) => r.length)), lenMax: Math.max(...runs.map((r) => r.length)),
      peak: Math.max(...runs.map((r) => r.peak)), nan: runs.reduce((s, r) => s + r.nan, 0),
      tail: Math.max(...runs.map((r) => r.tail)), edge: Math.max(...runs.map((r) => r.edge)),
      outPeakDb: db(lvO.peak), outLoudDb: db(lvO.loud), centroid: centroid(nom, lvN),
      same, selfSim, deckPeak: lvD.peak, deckNan: lvD.nan, deckHeard: lvD.peak > T60,
    });
  }
  const names = S.cue.names;
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) out.pairs.push({ a: names[i], b: names[j], s: similarity(prints[names[i]], prints[names[j]]) });
  }
  out.effects = [];
  for (const e of effects) {
    const buf = await S.cue.render(e, { vary: false, level: 1, key: 'C', duration: 1.5 });
    const lv = levels(buf), fp = fingerprint(buf, lv);
    const live = levels(await S.cue.render(e, { master: true, vary: false, key: 'C', duration: 2 }));
    out.effects.push({ name: e, outLoudDb: db(live.loud) });
    for (const n of names) out.refs.push({ a: n, b: e, s: similarity(prints[n], fp) });
  }

  // behavior: the shared gap drops a second cue 15 ms after the first, force keeps it
  const solo = await S.renderOffline({ mood: 'none', duration: 0.6, cues: [{ t: 0.1, name: 'click' }] });
  const pair = await S.renderOffline({ mood: 'none', duration: 0.6, cues: [{ t: 0.1, name: 'click' }, { t: 0.115, name: 'select' }] });
  const forced = await S.renderOffline({ mood: 'none', duration: 0.6, cues: [{ t: 0.1, name: 'click' }, { t: 0.115, name: 'select', opts: { force: true } }] });
  out.checks.push({ what: 'a second cue 15 ms after the first is dropped', ok: S.hashBuffer(solo) === S.hashBuffer(pair) });
  // a cue without a pan is mono: it must reach both channels at the same level, as the speakers play it
  const mono = await S.cue.render('click', { vary: false, level: 1 });
  const chE = (ch) => { const d = mono.getChannelData(ch); let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; return s; };
  out.checks.push({ what: 'a cue without a pan reaches both channels at the same level', ok: chE(0) > 0 && Math.abs(chE(0) - chE(1)) <= 1e-9 * chE(0) });
  out.checks.push({ what: 'force: true plays it anyway', ok: S.hashBuffer(solo) !== S.hashBuffer(forced) });
  // cues in a render with music follow the music's key and stay clean
  const withMusic = await S.renderOffline({ mood: 'sketchbook', seed: 'cue-check', duration: 6,
    cues: names.map((n, i) => ({ t: 0.5 + i * 0.36, name: n })) });
  const lvM = levels(withMusic);
  out.checks.push({ what: `all cues over the music: peak ${db(lvM.peak).toFixed(1)} dBFS, no NaN`, ok: lvM.peak < limits.peak && lvM.nan === 0 });

  if (wav) {
    const toB64 = (ab) => { const u = new Uint8Array(ab); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
    for (const n of names) out.wavs.push({ file: n + '.wav', data: toB64(S.toWav(nominal[n])) });
    // all cues in a row, 0.5 s apart after each one ends
    const sr = 48000, gap = Math.round(0.5 * sr);
    const total = names.reduce((s, n) => s + nominal[n].length + gap, gap);
    const ctx = new OfflineAudioContext(2, 1, sr), seq = ctx.createBuffer(2, total, sr);
    let at = gap;
    for (const n of names) {
      for (let ch = 0; ch < 2; ch++) seq.getChannelData(ch).set(nominal[n].getChannelData(ch), at);
      at += nominal[n].length + gap;
    }
    out.wavs.push({ file: 'all-cues.wav', data: toB64(S.toWav(seq)) });
  }
  return out;
}

/* The live path in a real AudioContext: off until a click, every cue reachable through
   SketchySound.play(name), the shared gap, and the hotkey switch for host apps. */
async function liveChecks(browser, src) {
  const page = await browser.newPage();
  const out = [];
  try {
    await page.setContent('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>live</title></head><body><button data-sk-sound-toggle>muted</button></body></html>');
    await page.addScriptTag({ content: src });
    const before = await page.evaluate(() => ({ on: window.SketchySound.isOn, played: window.SketchySound.play('click') }));
    out.push({ what: 'live: sound is off until the viewer turns it on, play() returns false', ok: !before.on && before.played === false });
    await page.click('button');
    let running = true;
    try { await page.waitForFunction(() => window.SketchySound.play('tap-soft', { force: true, gain: 0.01 }), null, { timeout: 5000, polling: 100 }); }
    catch { running = false; }
    out.push({ what: 'live: a click turns sound on and the audio context runs', ok: running });
    if (!running) return out;
    const all = await page.evaluate(() => window.SketchySound.cue.names.filter((n) => !window.SketchySound.play(n, { force: true, gain: 0.01 })));
    out.push({ what: `live: SketchySound.play(name) plays every cue${all.length ? ` (failed: ${all.join(', ')})` : ''}`, ok: all.length === 0 });
    await page.waitForTimeout(150);
    const gap = await page.evaluate(() => [window.SketchySound.play('select', { gain: 0.01 }), window.SketchySound.play('click', { gain: 0.01 })]);
    out.push({ what: 'live: a second cue in the same moment is dropped', ok: gap[0] === true && gap[1] === false });
    await page.evaluate(() => { window.SketchySound.hotkey = false; });
    await page.keyboard.press('s');
    const kept = await page.evaluate(() => window.SketchySound.isOn);
    await page.evaluate(() => { window.SketchySound.hotkey = true; });
    await page.keyboard.press('s');
    const toggled = await page.evaluate(() => !window.SketchySound.isOn && window.SketchySound.play('click') === false);
    out.push({ what: 'live: hotkey = false keeps the s key away, true gives it back', ok: kept && toggled });
  } finally {
    await page.close();
  }
  return out;
}

async function main() {
  const { values } = parseArgs(process.argv.slice(2), SPEC);
  const seeds = Math.max(1, Math.min(32, Math.round(values.seeds)));
  const engine = path.join(ENGINE_DIR, 'sketchy-sound.js');
  if (!fs.existsSync(engine)) die(`engine not found: ${engine}`);
  const src = fs.readFileSync(engine, 'utf8');

  const pw = requirePlaywright();
  const browser = await launchChromium(pw);
  let res;
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => say.error(`page: ${e.message}`));
    await page.setContent('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>cue check</title></head><body></body></html>');
    await page.addScriptTag({ content: src });
    res = await page.evaluate(analyse, { seeds, wav: Boolean(values.wav), effects: EFFECTS, limits: { peak: PEAK_LIMIT } });
    res.checks.push(...await liveChecks(browser, src));
  } finally {
    await browser.close();
  }

  const dB = (x) => (20 * Math.log10(Math.max(x, 1e-12))).toFixed(1);
  const ms = (s) => (s * 1000).toFixed(0);
  let bad = 0;
  say.line(c.bold(`UI cues: ${res.cues.length}, each rendered nominal + ${seeds} seeded variations + twice for determinism`));
  say.line(c.dim('levels on the effect bus, except "out": what a listener hears (master chain, both channels);'));
  say.line(c.dim('"out loud" is the loudest 50 ms of the mean power of both channels'));
  say.line();
  const head = ['cue', 'span ms', 'length ms', 'peak', 'last 50ms', 'end 2ms', 'out peak', 'out loud', 'centroid', 'self', ''];
  const rows = res.cues.map((q) => {
    const fails = [];
    if (q.nan || q.deckNan) fails.push('NaN');
    if (!(q.peak < PEAK_LIMIT) || !(q.deckPeak < PEAK_LIMIT)) fails.push('peak');
    if (q.lenMin < q.min || q.lenMax > q.max) fails.push('length');
    if (!(20 * Math.log10(Math.max(q.tail, 1e-12)) < TAIL_DB)) fails.push('tail');
    if (!(20 * Math.log10(Math.max(q.edge, 1e-12)) < EDGE_DB)) fails.push('cut');
    if (!q.same) fails.push('not deterministic');
    if (!q.deckHeard) fails.push('silent in renderOffline');
    if (fails.length) bad++;
    return [q.name, `${ms(q.min)}-${ms(q.max)}`, `${ms(q.lenMin)}-${ms(q.lenMax)}`, dB(q.peak), dB(q.tail), dB(q.edge),
      dB(Math.pow(10, q.outPeakDb / 20)), dB(Math.pow(10, q.outLoudDb / 20)), `${Math.round(q.centroid)} Hz`, q.selfSim.toFixed(3),
      fails.length ? c.red(fails.join(', ')) : c.green('ok')];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).replace(/\x1b\[\d+m/g, '').length)));
  const fmt = (r) => r.map((x, i) => (i === 0 ? String(x).padEnd(widths[i]) : String(x).padStart(widths[i]))).join('  ');
  say.line(c.dim(fmt(head)));
  rows.forEach((r) => say.line(fmt(r)));
  say.line();
  say.line(`limits: peak < ${PEAK_LIMIT} (${dB(PEAK_LIMIT)} dBFS), last 50 ms < ${TAIL_DB} dBFS, 2 ms before the end < ${EDGE_DB} dBFS, length inside the span`);
  say.line(`deck path (renderOffline, full master chain): highest peak ${dB(Math.max(...res.cues.map((q) => q.deckPeak)))} dBFS`);

  say.line(`existing effects, out loud for reference: ${res.effects.map((e) => `${e.name} ${e.outLoudDb.toFixed(1)}`).join(', ')}`);
  // the loudness ladder as heard: each tier stays under the next one
  const loudOf = Object.fromEntries(res.cues.map((q) => [q.name, q.outLoudDb]));
  const tiers = LADDER.map((t) => ({ t, lo: Math.min(...t.map((n) => loudOf[n])), hi: Math.max(...t.map((n) => loudOf[n])) }));
  const ladderOk = tiers.every((x, i) => i === 0 || tiers[i - 1].hi < x.lo);
  res.checks.unshift({ what: `loudness ladder as heard: ${tiers.map((x) => `${x.t.join(' ')} ${x.lo.toFixed(1)}..${x.hi.toFixed(1)}`).join('  <  ')}`, ok: ladderOk });

  const pairs = res.pairs.slice().sort((a, b) => b.s - a.s);
  const refs = res.refs.slice().sort((a, b) => b.s - a.s);
  const simBad = pairs.filter((p) => p.s >= SIMILAR_LIMIT).concat(refs.filter((p) => p.s >= SIMILAR_LIMIT));
  // each cue must sound more like its own seeded variation than like any other cue
  const confusable = res.cues.filter((q) => {
    const near = Math.max(...res.pairs.filter((p) => p.a === q.name || p.b === q.name).map((p) => p.s));
    q.nearest = near;
    return !(q.selfSim > near);
  });
  say.line();
  say.line(c.bold(`similarity (Pearson r of onset-aligned spectrograms, limit ${SIMILAR_LIMIT})`));
  say.line(`  cue pairs: ${pairs.length - pairs.filter((p) => p.s >= SIMILAR_LIMIT).length}/${pairs.length} clear, closest:`);
  pairs.slice(0, 5).forEach((p) => say.line(`    ${p.a} / ${p.b}  ${p.s.toFixed(3)}`));
  say.line(`  cue vs existing effect: ${refs.length - refs.filter((p) => p.s >= SIMILAR_LIMIT).length}/${refs.length} clear, closest:`);
  refs.slice(0, 3).forEach((p) => say.line(`    ${p.a} / ${p.b}  ${p.s.toFixed(3)}`));
  const margin = Math.min(...res.cues.map((q) => q.selfSim - q.nearest));
  say.line(`  every cue closer to its own variation than to any other cue: ${res.cues.length - confusable.length}/${res.cues.length}, smallest margin ${margin.toFixed(3)}`);
  if (simBad.length) { bad += simBad.length; simBad.forEach((p) => say.error(`${p.a} and ${p.b} are near-identical (${p.s.toFixed(3)})`)); }
  if (confusable.length) { bad += confusable.length; confusable.forEach((q) => say.error(`${q.name} scores ${q.selfSim.toFixed(3)} against itself but ${q.nearest.toFixed(3)} against another cue`)); }

  say.line();
  say.line(c.bold('behavior'));
  for (const k of res.checks) { if (!k.ok) bad++; (k.ok ? say.ok : say.error)(k.what); }
  const randomUse = /Math\.random\s*\(/.test(src), clockUse = /\b(Date\.now|performance\.now|new Date)\s*\(/.test(src);
  (randomUse || clockUse ? say.error : say.ok)(`engine source: ${randomUse ? 'uses Math.random()' : 'no Math.random()'}, ${clockUse ? 'reads the clock' : 'no Date or performance clock'}`);
  if (randomUse || clockUse) bad++;

  if (values.wav) {
    const dir = path.resolve(values.wav);
    fs.mkdirSync(dir, { recursive: true });
    for (const w of res.wavs) fs.writeFileSync(path.join(dir, w.file), Buffer.from(w.data, 'base64'));
    say.info(`wrote ${res.wavs.length} WAV files (effect bus level, 48 kHz) to ${dir}`);
  }
  say.line();
  if (bad) { say.error(`${bad} problem${bad === 1 ? '' : 's'} found`); process.exit(1); }
  say.ok('every cue passed');
}

if (isMain(import.meta.url)) main().catch((e) => die(String(e && e.stack ? e.stack : e), null, 2));
