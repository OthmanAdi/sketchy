/*!
 * sketchy-sound.js: procedural sound effects and generative music
 * No audio files. Every sound is built from oscillators and seeded noise. The same
 * seed plays the same notes live and gives the same samples in an offline render.
 * MIT License. https://github.com/OthmanAdi/sketchy
 *
 * Load order: after sketchy.js (optional), before or after sketchy-deck.js.
 * Sound is off until the viewer turns it on. Music never starts by itself.
 *
 * Layout of this file:
 *   1. random numbers, music theory, mood and section tables
 *   2. master chain (one function that works on any BaseAudioContext)
 *   3. voice primitives and the sound effects
 *   4. the generative music (phrases are generated as data, then scheduled)
 *   5. offline rendering and WAV encoding
 *   6. live state: enable, unlock, persistence, events, toggles
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var STORE_KEY = 'sketchy:sound';

  /* Levels are linear gains. The master is quiet on purpose: the viewer sets the
     loudness with their own volume control, and the video script normalizes later. */
  var MASTER = 0.15;
  var SFX_LEVEL = 2.0;       // effects sit a little above the music bed
  var CEILING = 0.84;        // -1.5 dBFS: the offline safety trim never lets a render go above this
  var REVERB_SECONDS = 4.5;
  var REVERB_SEED = 4217;

  /* ------------------------------------------------------------------ *
   * 1. Randomness, theory, tables
   * ------------------------------------------------------------------ */
  function hash(str) {
    var h = 2166136261;
    str = String(str);
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) || 1;
  }
  // mulberry32: one small seeded stream. Every consumer gets its own, so adding a
  // sound effect never changes the music and the other way round.
  function mulberry(seed) {
    var a = (typeof seed === 'number' ? seed : hash(seed)) >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function pick(r, list) { return list[Math.floor(r() * list.length)]; }
  function weighted(r, w) {
    var s = 0, i;
    for (i = 0; i < w.length; i++) s += w[i];
    var x = r() * s;
    for (i = 0; i < w.length; i++) { x -= w[i]; if (x <= 0) return i; }
    return w.length - 1;
  }

  var MODES = {
    aeolian: [0, 2, 3, 5, 7, 8, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    ionian: [0, 2, 4, 5, 7, 9, 11]
  };
  var KEY_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  var NOTE_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  function degMidi(tonic, scale, deg) {
    var n = scale.length, oct = Math.floor(deg / n);
    return tonic + 12 * oct + scale[deg - oct * n];
  }
  function midiHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  // highest scale degree whose pitch is at or below the given MIDI note
  function midiDeg(tonic, scale, midi) {
    var d = Math.floor((midi - tonic) / 12 * scale.length);
    while (degMidi(tonic, scale, d + 1) <= midi) d++;
    while (degMidi(tonic, scale, d) > midi) d--;
    return d;
  }
  function foldInto(midi, lo, hi) {
    while (midi < lo) midi += 12;
    while (midi > hi) midi -= 12;
    return midi;
  }
  function keyToTonic(k) {
    var pc;
    if (typeof k === 'number') pc = k;
    else {
      var s = String(k).trim(), L = s.charAt(0).toUpperCase();
      pc = NOTE_PC[L];
      if (pc == null) return null;
      var acc = s.charAt(1);
      if (acc === '#') pc += 1; else if (acc === 'b' || acc === 'B') pc -= 1;
    }
    return 45 + ((((pc - 45) % 12) + 12) % 12);   // tonic lives between A2 and G#3
  }

  /* Chord transitions over scale degrees 0..6. Rows are "from", columns "to".
     The masks switch off the one diatonic triad that sounds wrong as a pad
     (the diminished one) for each mode. */
  var MARKOV_MINOR = [
    /* i   ii   III  iv   v    VI   VII */
    [0.04, 0.08, 0.16, 0.24, 0.12, 0.22, 0.14],
    [0.15, 0.00, 0.10, 0.20, 0.35, 0.00, 0.20],
    [0.18, 0.05, 0.00, 0.22, 0.08, 0.30, 0.17],
    [0.26, 0.08, 0.12, 0.00, 0.16, 0.12, 0.26],
    [0.40, 0.02, 0.08, 0.10, 0.00, 0.24, 0.16],
    [0.14, 0.04, 0.16, 0.20, 0.10, 0.00, 0.36],
    [0.38, 0.03, 0.30, 0.08, 0.05, 0.16, 0.00]
  ];
  var MARKOV_MAJOR = [
    /* I   ii   iii  IV   V    vi   vii */
    [0.02, 0.10, 0.08, 0.30, 0.20, 0.30, 0],
    [0.10, 0.00, 0.05, 0.15, 0.55, 0.15, 0],
    [0.05, 0.10, 0.00, 0.35, 0.10, 0.40, 0],
    [0.30, 0.15, 0.03, 0.00, 0.35, 0.17, 0],
    [0.50, 0.03, 0.07, 0.15, 0.00, 0.25, 0],
    [0.08, 0.25, 0.07, 0.35, 0.25, 0.00, 0],
    [0.50, 0.00, 0.00, 0.00, 0.50, 0.00, 0]
  ];
  var MASKS = {
    aeolian: [1, 0, 1, 1, 1, 1, 1],
    dorian: [1, 1, 1, 1, 1, 0, 1],
    ionian: [1, 1, 1, 1, 1, 1, 0]
  };
  // The last chord of a phrase leans towards a chord that wants to resolve to the tonic.
  var END_BIAS_MINOR = [1, 1, 1, 2, 3, 1, 3];
  var END_BIAS_MAJOR = [1, 1, 1, 2.5, 3.5, 1, 1];

  function markov(r, table, mask, from, bias) {
    var row = table[from], w = [], i;
    for (i = 0; i < 7; i++) w.push(row[i] * mask[i] * (bias ? bias[i] : 1));
    return weighted(r, w);
  }

  /* Moods. `level` is the base gain of each layer before the section table is
     applied. `dens` is the long-form density curve: two slow sines whose periods
     (in bars) do not divide each other, so the density never repeats exactly. */
  var MOODS = {
    sketchbook: {
      mode: 'aeolian', bpm: [88, 98], bpc: [2, 2, 4], phrase: [4, 8, 8], repeat: 0.4, rest: 0.18,
      arp: { inst: 'musicbox', range: [69, 93], sub: 2, ghost: 0.35, decay: 0.8, peak: 0.17 },
      lead: { inst: 'celesta', range: [60, 81], decay: 2.2, peak: 0.16, p: 0.6 },
      bass: { pats: [[0], [0, 10], [0, 6, 10], [0, 8]], wave: 'sawtooth', peak: 0.3, long: false },
      hatSteps: [2, 6, 10, 14], hatGhost: true, kickSteps: [0, 8],
      level: { pad: 0.55, drone: 0.14, wind: 0.5, arp: 0.8, lead: 0.55, bass: 0.34, hat: 0.5, kick: 0.4 },
      padCut: 1000, pump: 1, fb: 0.42, bassFloor: 0, trim: 1.44,
      dens: { base: 0.72, a1: 0.2, p1: 24, a2: 0.12, p2: 11 }
    },
    ledger: {
      mode: 'dorian', bpm: [64, 72], bpc: [2, 4], phrase: [4, 8, 8], repeat: 0.5, rest: 0.25,
      arp: { inst: 'pluck', range: [60, 84], sub: 4, ghost: 0.25, decay: 1.2, peak: 0.14 },
      lead: { inst: 'bell', ratio: 3.5, range: [62, 86], decay: 4.2, peak: 0.15, p: 0.75 },
      bass: { pats: [[0], [0, 8], [0, 10]], wave: 'triangle', peak: 0.36, long: true },
      hatSteps: [4, 12], hatGhost: false, kickSteps: [0, 8],
      level: { pad: 0.6, drone: 0.2, wind: 0.6, arp: 0.5, lead: 0.7, bass: 0.5, hat: 0.3, kick: 0.35 },
      padCut: 760, pump: 0.6, fb: 0.45, bassFloor: 0.45, trim: 1.03,
      dens: { base: 0.58, a1: 0.18, p1: 32, a2: 0.1, p2: 13 }
    },
    focus: {
      mode: 'aeolian', bpm: [72, 80], bpc: [4, 4, 2], phrase: [8, 8, 4], repeat: 0.55, rest: 0.3,
      arp: { inst: 'celesta', range: [62, 82], sub: 4, ghost: 0, decay: 1.0, peak: 0.1 },
      lead: { inst: 'bell', ratio: 2, range: [60, 79], decay: 3.0, peak: 0.1, p: 0.35 },
      bass: { pats: [[0], [0, 8]], wave: 'triangle', peak: 0.26, long: true },
      hatSteps: [2, 6, 10, 14], hatGhost: false, kickSteps: [],
      level: { pad: 0.5, drone: 0.14, wind: 0.5, arp: 0.55, lead: 0.45, bass: 0.3, hat: 0.25, kick: 0 },
      padCut: 640, pump: 0.3, fb: 0.4, bassFloor: 0.3, trim: 0.84,
      dens: { base: 0.42, a1: 0.12, p1: 28, a2: 0.08, p2: 15 }
    },
    calm: {
      mode: 'ionian', bpm: [60, 66], bpc: [4, 2, 4], phrase: [4, 8, 8], repeat: 0.5, rest: 0.25,
      arp: { inst: 'celesta', range: [64, 88], sub: 4, ghost: 0.3, decay: 1.6, peak: 0.13 },
      lead: { inst: 'bell', ratio: 2, range: [62, 84], decay: 4.5, peak: 0.12, p: 0.5 },
      bass: { pats: [[0], [0, 8]], wave: 'sine', peak: 0.3, long: true },
      hatSteps: [], hatGhost: false, kickSteps: [],
      level: { pad: 0.65, drone: 0.16, wind: 0.5, arp: 0.5, lead: 0.5, bass: 0.22, hat: 0, kick: 0 },
      padCut: 820, pump: 0, fb: 0.4, bassFloor: 0.5, trim: 0.99,
      dens: { base: 0.5, a1: 0.14, p1: 28, a2: 0.1, p2: 12 }
    }
  };

  /* Sections switch layers in and out. Each value multiplies the mood's base level;
     `cut` scales the pad's filter, `pump` is the pad ducking depth on the beat,
     `dens` scales how many of the generated notes are allowed to sound. */
  var SECTIONS = {
    calm:    { pad: 1.0, drone: 1.0, wind: 1.0, arp: 0.55, lead: 0.55, bass: 0.0,  hat: 0.0,  kick: 0, cut: 0.7,  pump: 0.0,  dens: 0.62 },
    build:   { pad: 1.0, drone: 1.0, wind: 0.8, arp: 0.85, lead: 0.8,  bass: 0.75, hat: 0.55, kick: 0, cut: 0.95, pump: 0.08, dens: 0.9 },
    flight:  { pad: 1.0, drone: 0.9, wind: 0.6, arp: 1.0,  lead: 1.0,  bass: 1.0,  hat: 1.0,  kick: 1, cut: 1.3,  pump: 0.18, dens: 1.15 },
    resolve: { pad: 0.9, drone: 1.0, wind: 1.0, arp: 0.5,  lead: 0.9,  bass: 0.45, hat: 0.0,  kick: 0, cut: 0.8,  pump: 0.0,  dens: 0.7 }
  };

  /* The key a piece plays in comes from its seed alone, so a script can ask for it
     before rendering and so sound effects can be tuned to it. */
  function header(seed, mood, o) {
    o = o || {};
    var M = MOODS[mood] || MOODS.sketchbook;
    var rk = mulberry(hash(seed + '|' + mood + '|key'));
    var tonic = o.key != null ? keyToTonic(o.key) : null;
    var drawn = 45 + Math.floor(rk() * 12);
    var bpmDraw = M.bpm[0] + rk() * (M.bpm[1] - M.bpm[0]);
    if (tonic == null) tonic = drawn;
    return {
      mood: MOODS[mood] ? mood : 'sketchbook', mode: M.mode, scale: MODES[M.mode],
      tonic: tonic, keyName: KEY_NAMES[tonic % 12],
      bpm: o.bpm ? +o.bpm : Math.round(bpmDraw)
    };
  }

  /* ------------------------------------------------------------------ *
   * 2. Buffers and the master chain
   * ------------------------------------------------------------------ */
  function makeNoise(ctx, seconds, seed) {
    var n = Math.floor(ctx.sampleRate * seconds), buf = ctx.createBuffer(1, n, ctx.sampleRate);
    var d = buf.getChannelData(0), r = mulberry(seed);
    for (var i = 0; i < n; i++) d[i] = r() * 2 - 1;
    return buf;
  }

  // Pink noise with the common seven-pole approximation; the last 50 ms are blended
  // into the first 50 ms so the loop seam cannot be heard.
  function makePink(ctx, seconds, seed) {
    var n = Math.floor(ctx.sampleRate * seconds), buf = ctx.createBuffer(1, n, ctx.sampleRate);
    var d = buf.getChannelData(0), r = mulberry(seed);
    var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, i;
    for (i = 0; i < n; i++) {
      var w = r() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    var xf = Math.floor(ctx.sampleRate * 0.05);
    for (i = 0; i < xf; i++) {
      var m = i / xf;
      d[n - xf + i] = d[n - xf + i] * (1 - m) + d[i] * m;
    }
    return buf;
  }

  /* A stereo impulse response from seeded noise. Two channels with different noise
     make the tail wide. The tail fades with a cubic curve, loses treble as it ages
     (a one-pole filter that closes with time), and starts with a 4 ms ramp so it
     never clicks. */
  function impulseData(sr, seconds, seed) {
    var n = Math.floor(sr * seconds), r = mulberry(seed), atk = Math.floor(sr * 0.004), out = [];
    for (var ch = 0; ch < 2; ch++) {
      var d = new Float32Array(n), lp = 0;
      for (var i = 0; i < n; i++) {
        var t = i / n, a = 1 - 0.78 * Math.sqrt(t);
        lp += a * ((r() * 2 - 1) - lp);
        var fade = Math.pow(1 - t, 3);
        d[i] = lp * fade * (i < atk ? i / atk : 1);
      }
      out.push(d);
    }
    return out;
  }
  function makeImpulse(ctx, seconds, seed) {
    var data = impulseData(ctx.sampleRate, seconds, seed), buf = ctx.createBuffer(2, data[0].length, ctx.sampleRate);
    buf.copyToChannel(data[0], 0); buf.copyToChannel(data[1], 1);
    return buf;
  }

  /* Why the graph is built from trees and slots.
     A browser sums the connections that reach one node in an order it does not
     promise, and floating-point addition is not associative, so three or more
     sounding inputs on one node make two renders of the same piece differ in the
     last bits. Two inputs are always exact. So every merge point in this file is a
     balanced tree of two-input gains (sumTree), and note voices play through a fixed
     pool of slots (Sink) where only one voice sounds at a time. Silent, finished
     voices that stay connected add exact zeros and change nothing. */
  function sumTree(ctx, nodes) {
    nodes = nodes.slice();
    if (!nodes.length) return null;
    while (nodes.length > 1) {
      var next = [];
      for (var i = 0; i < nodes.length; i += 2) {
        if (i + 1 < nodes.length) {
          var g = ctx.createGain();
          nodes[i].connect(g); nodes[i + 1].connect(g);
          next.push(g);
        } else next.push(nodes[i]);
      }
      nodes = next;
    }
    return nodes[0];
  }

  /* A pool of `size` slots. take(t, until) hands out the first slot that is free at t
     and keeps it until `until`; null means the pool is full and the voice is skipped
     (a polyphony limit, the same in every render). With sends, each slot also feeds a
     reverb tap and an echo tap whose amounts are set when the slot is taken. */
  function Sink(ctx, size, sends) {
    var i, dry = [], wet = [], echo = [];
    this.slots = []; this.free = []; this.sw = sends ? [] : null; this.se = sends ? [] : null;
    for (i = 0; i < size; i++) {
      var s = ctx.createGain();
      this.slots.push(s); this.free.push(0); dry.push(s);
      if (sends) {
        var w = ctx.createGain(), e = ctx.createGain();
        w.gain.value = 0; e.gain.value = 0;
        s.connect(w); s.connect(e);
        this.sw.push(w); this.se.push(e); wet.push(w); echo.push(e);
      }
    }
    this.dry = sumTree(ctx, dry);
    this.wet = sends ? sumTree(ctx, wet) : null;
    this.echo = sends ? sumTree(ctx, echo) : null;
  }
  Sink.prototype.take = function (t, until, wet, echo) {
    for (var i = 0; i < this.slots.length; i++) {
      if (this.free[i] <= t) {
        this.free[i] = until;
        if (this.sw) { this.sw[i].gain.setValueAtTime(wet || 0, t); this.se[i].gain.setValueAtTime(echo || 0, t); }
        return this.slots[i];
      }
    }
    return null;
  };

  /* The master chain. It takes any BaseAudioContext, so the same graph runs live
     and inside an OfflineAudioContext.
       music.dry/wet/echo and sfx.dry/wet/echo  ->  master  ->  compressor  ->  limiter
     `wet` feeds the reverb, `echo` the delay. The sends are tapped after each
     category's level, so turning a category down also silences its tails. */
  function masterChain(ctx) {
    var master = ctx.createGain();
    master.gain.value = 0;
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 5;
    comp.attack.value = 0.01; comp.release.value = 0.35;
    var limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.002; limiter.release.value = 0.12;
    // a gentle high-pass keeps sub-bass rumble out of the mix (small speakers cannot play it anyway)
    var hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 38; hpf.Q.value = 0.5;
    master.connect(hpf); hpf.connect(comp); comp.connect(limiter); limiter.connect(ctx.destination);
    return { master: master, comp: comp, limiter: limiter };
  }

  /* opts.split builds only the part in front of the reverb and the master chain and
     exposes R.premix (music, effects, echo) and R.revSend (the reverb send). The offline
     renderer uses it: see renderOnce for why. */
  function buildMaster(ctx, opts) {
    opts = opts || {};
    var split = !!opts.split;
    var R = {
      ctx: ctx, offline: !!opts.offline, last: {},
      rand: mulberry(hash(String(opts.seed != null ? opts.seed : 'sketchy') + '|sfx')),
      key: null, lastDeg: -1
    };
    var chain = split ? null : masterChain(ctx);

    var revIn = ctx.createGain(); revIn.gain.value = 0.5;
    var revLP = ctx.createBiquadFilter(); revLP.type = 'lowpass'; revLP.frequency.value = 4200; revLP.Q.value = 0.5;
    revIn.connect(revLP);
    var conv = null;
    if (!split) { conv = ctx.createConvolver(); conv.buffer = makeImpulse(ctx, REVERB_SECONDS, REVERB_SEED); revLP.connect(conv); }

    // The echo is a chain of five repeats, each a little quieter and darker. A feedback
    // loop would do the same job, but a loop in the graph makes the browser's processing
    // order matter, and a chain keeps renders identical.
    var dlyIn = ctx.createGain(); dlyIn.gain.value = 0.22;
    var echoTaps = [], prev = dlyIn;
    for (var h = 0; h < 5; h++) {
      var dl = ctx.createDelay(1); dl.delayTime.value = 0.45;
      var dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 2500;
      if (h > 0) { var hop = ctx.createGain(); hop.gain.value = 0.3; prev.connect(hop); prev = hop; }
      prev.connect(dl); dl.connect(dlp); echoTaps.push(dlp); prev = dlp;
    }
    var echoOut = sumTree(ctx, echoTaps);

    function category() {
      var dry = ctx.createGain(), wet = ctx.createGain(), echo = ctx.createGain();
      wet.connect(revIn); echo.connect(dlyIn);
      return { dry: dry, wet: wet, echo: echo };
    }
    R.music = category(); R.sfx = category();
    [R.sfx.dry, R.sfx.wet, R.sfx.echo].forEach(function (g) { g.gain.value = SFX_LEVEL; });
    // the things that reach the master: music, effects, reverb, echo
    var parts = [R.music.dry, R.sfx.dry];
    if (conv) parts.push(conv);
    parts.push(echoOut);
    var mix = sumTree(ctx, parts);
    if (split) { R.premix = mix; R.revSend = revLP; }
    else { mix.connect(chain.master); R.master = chain.master; R.comp = chain.comp; R.limiter = chain.limiter; }
    // every effect voice plays through this pool, with its own reverb and echo taps
    R.sfxSink = new Sink(ctx, 32, true);
    R.sfxSink.dry.connect(R.sfx.dry); R.sfxSink.wet.connect(R.sfx.wet); R.sfxSink.echo.connect(R.sfx.echo);
    R.noise = makeNoise(ctx, 2, 7);
    R.noiseHat = makeNoise(ctx, 1, 11);
    R.pink = null;
    R.pinkBuffer = function () { return R.pink || (R.pink = makePink(ctx, 6, 99)); };
    R.setLevel = function (which, v, tau) {
      var c = R[which], t = ctx.currentTime;
      [c.dry, c.wet, c.echo].forEach(function (g) { g.gain.setTargetAtTime(v, t, tau || 0.08); });
    };
    R.sfxEnv = { R: R, sink: R.sfxSink, rnd: R.rand };
    return R;
  }

  function masterTo(R, v, sec) {
    var g = R.master.gain, now = R.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(v, now + Math.max(0.01, sec));
  }

  /* ------------------------------------------------------------------ *
   * 3. Voice primitives
   *    E = { R: rig, sink: default Sink for effects, rnd: random stream }
   *    Every primitive takes a slot from a Sink first and returns quietly when the
   *    pool is full. o.t is the start time; o.until is when the slot is free again.
   * ------------------------------------------------------------------ */
  // 0 -> peak (linear, short) -> 0.0001 (exponential). Everything decays to silence.
  function envelope(p, t, peak, atk, dur) {
    peak = Math.max(peak, 0.0002);
    dur = Math.max(dur, atk + 0.01);
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + atk);
    p.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  function grab(E, o) {
    o.until = o.t + o.dur + 0.06;
    return (o.out || E.sink).take(o.t, o.until, o.wet, o.echo);
  }

  // Connect a finished voice to its slot, with an optional (static or moving) pan, and
  // tidy up when the source ends in a live context.
  function finish(E, node, o, slot, src, extra) {
    var c = E.R.ctx, made = [node], out = node;
    if (c.createStereoPanner && (o.pan || o.panFrom != null)) {
      var p = c.createStereoPanner();
      if (o.panFrom != null) { p.pan.setValueAtTime(o.panFrom, o.t); p.pan.linearRampToValueAtTime(o.panTo, o.t + o.dur); }
      else p.pan.value = clamp(o.pan, -1, 1);
      node.connect(p); out = p; made.push(p);
    }
    out.connect(slot);
    if (!E.R.offline && src) {
      var all = made.concat(extra || []);
      src.onended = function () {
        try { out.disconnect(slot); } catch (err) { /* already gone */ }
        for (var i = 0; i < all.length; i++) { try { all[i].disconnect(); } catch (err2) { /* already gone */ } }
      };
    }
  }

  function noiseSource(E, t, dur, buf) {
    var s = E.R.ctx.createBufferSource();
    s.buffer = buf || E.R.noise; s.loop = true;
    s.start(t, E.rnd() * (s.buffer.duration - 0.4));
    s.stop(t + dur + 0.05);
    return s;
  }

  // One oscillator with an exponential glide. o: t, f0, f1, dur, peak, type, lp, atk, glide, pan, wet, echo, out
  function tone(E, o) {
    var slot = grab(E, o);
    if (!slot) return;
    var c = E.R.ctx, t = o.t, dur = o.dur;
    var osc = c.createOscillator(); osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f0, t);
    if (o.f1 && o.f1 !== o.f0) osc.frequency.exponentialRampToValueAtTime(o.f1, t + (o.glide || dur * 0.6));
    var g = c.createGain(); envelope(g.gain, t, o.peak, o.atk || 0.008, dur);
    var extra = [];
    if (o.lp) {
      var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = o.lp; lp.Q.value = 1;
      osc.connect(lp); lp.connect(g); extra.push(lp);
    } else osc.connect(g);
    finish(E, g, o, slot, osc, extra);
    osc.start(t); osc.stop(t + dur + 0.03);
  }

  // A noise burst through one filter. o: t, type, freq, q, dur, peak, atk, buf, pan, wet, echo, out
  function hit(E, o) {
    var slot = grab(E, o);
    if (!slot) return;
    var c = E.R.ctx, t = o.t;
    var src = noiseSource(E, t, o.dur, o.buf);
    var f = c.createBiquadFilter(); f.type = o.type; f.frequency.value = o.freq; f.Q.value = o.q == null ? 0.8 : o.q;
    var g = c.createGain(); envelope(g.gain, t, o.peak, o.atk || 0.004, o.dur);
    src.connect(f); f.connect(g);
    finish(E, g, o, slot, src, [f]);
  }

  /* A bell: a sine carrier with an FM modulator whose depth collapses over the first
     40 % of the decay, so the attack is glassy and the tail is a pure sine.
     o: t, f, peak, decay, ratio (0 = pure), depth, pan, wet, echo, out */
  function bellVoice(E, o) {
    o.dur = o.decay;
    var slot = grab(E, o);
    if (!slot) return;
    var c = E.R.ctx, t = o.t, f = o.f, extra = [];
    var car = c.createOscillator(); car.type = 'sine'; car.frequency.value = f;
    var g = c.createGain(); envelope(g.gain, t, o.peak, o.atk || 0.01, o.decay);
    if (o.ratio > 0) {
      var mod = c.createOscillator(); mod.type = 'sine'; mod.frequency.value = f * o.ratio;
      var md = c.createGain();
      md.gain.setValueAtTime(f * (o.depth || 1.6), t);
      md.gain.exponentialRampToValueAtTime(f * 0.02, t + o.decay * 0.4);
      mod.connect(md); md.connect(car.frequency);
      mod.start(t); mod.stop(t + o.decay + 0.03);
      extra.push(mod, md);
    }
    car.connect(g);
    finish(E, g, o, slot, car, extra);
    car.start(t); car.stop(t + o.decay + 0.03);
  }

  /* Filtered noise with a path for the filter frequency and for the loudness.
     o: t, dur, type, freqs [[dt, Hz]...] (exponential), q0, q1, amp [[dt, level, 1 = exponential]...],
        am {rate, depth}, hp, lp, panFrom, panTo, pan, wet, echo */
  function sweep(E, o) {
    var slot = grab(E, o);
    if (!slot) return;
    var c = E.R.ctx, t = o.t, i;
    var src = noiseSource(E, t, o.dur);
    var bp = c.createBiquadFilter(); bp.type = o.type || 'bandpass';
    bp.frequency.setValueAtTime(o.freqs[0][1], t);
    for (i = 1; i < o.freqs.length; i++) bp.frequency.exponentialRampToValueAtTime(o.freqs[i][1], t + o.freqs[i][0]);
    bp.Q.setValueAtTime(o.q0 == null ? 0.8 : o.q0, t);
    if (o.q1 != null) bp.Q.linearRampToValueAtTime(o.q1, t + o.dur);
    var g = c.createGain();
    g.gain.setValueAtTime(0, t);
    for (i = 0; i < o.amp.length; i++) {
      var a = o.amp[i], v = Math.max(a[1], 0.0001);
      if (a[2]) g.gain.exponentialRampToValueAtTime(v, t + a[0]); else g.gain.linearRampToValueAtTime(a[1], t + a[0]);
    }
    src.connect(bp);
    var extra = [bp], last = bp;
    if (o.hp) { var hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = o.hp; last.connect(hp); last = hp; extra.push(hp); }
    if (o.lp) { var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = o.lp; lp.Q.value = 0.5; last.connect(lp); last = lp; extra.push(lp); }
    if (o.am) {
      var am = c.createGain(); am.gain.value = 1 - o.am.depth;
      var lfo = c.createOscillator(); lfo.type = 'sine'; lfo.frequency.setValueAtTime(o.am.rate, t);
      if (o.am.rate2) lfo.frequency.linearRampToValueAtTime(o.am.rate2, t + o.dur);
      var ld = c.createGain(); ld.gain.value = o.am.depth;
      lfo.connect(ld); ld.connect(am.gain);
      last.connect(am); last = am;
      lfo.start(t); lfo.stop(t + o.dur + 0.05);
      extra.push(am, lfo, ld);
    }
    last.connect(g);
    finish(E, g, o, slot, src, extra);
  }

  /* Graphite on paper: noise squeezed into a narrow band and chopped by a fast,
     irregular sawtooth tremolo. The band slides up on one stroke and down on the
     next. No pitch, so it never fights the music.
     o: t, dur, strokes | seg, f0, f1, q, rate, depth, peak, pan */
  function scratch(E, o) {
    var slot = grab(E, o);
    if (!slot) return;
    var c = E.R.ctx, r = E.rnd, t = o.t, dur = o.dur, end = t + dur;
    var src = noiseSource(E, t, dur);
    var hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 800;
    var bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = o.q;
    var am = c.createGain(); am.gain.value = 0.55;
    var lfo = c.createOscillator(); lfo.type = 'sawtooth';
    var ld = c.createGain(); ld.gain.value = o.depth;
    lfo.connect(ld); ld.connect(am.gain);
    var env = c.createGain();
    src.connect(hp); hp.connect(bp); bp.connect(am); am.connect(env);
    var up = r() < 0.5, a = t;
    env.gain.setValueAtTime(0, t);
    bp.frequency.setValueAtTime(up ? o.f0 : o.f1, t);
    lfo.frequency.setValueAtTime(o.rate, t);
    while (a < end - 0.005) {
      var len = o.seg ? o.seg * (0.7 + r() * 0.6) : dur / o.strokes;
      var b = Math.min(a + len, end), last = b >= end - 0.005;
      var pk = o.peak * (0.7 + r() * 0.6);
      var fa = (up ? o.f0 : o.f1) * (1 + (r() - 0.5) * 0.12), fb = (up ? o.f1 : o.f0) * (1 + (r() - 0.5) * 0.12);
      bp.frequency.setValueAtTime(fa, a);
      bp.frequency.linearRampToValueAtTime(fb, b);
      lfo.frequency.setValueAtTime(o.rate * (0.8 + r() * 0.5), a);
      env.gain.linearRampToValueAtTime(pk, a + Math.min(0.012, (b - a) * 0.3));
      env.gain.linearRampToValueAtTime(pk * 0.55, a + (b - a) * 0.6);
      env.gain.linearRampToValueAtTime(last || r() < 0.25 ? 0 : pk * 0.18, b);
      a = b; up = !up;
    }
    finish(E, env, o, slot, src, [hp, bp, am, lfo, ld]);
    lfo.start(t); lfo.stop(end + 0.05);
  }

  /* ------------------------------------------------------------------ *
   * 3b. Sound effects
   *     fn(E, t, v)  v = { g: gain, p: pitch ratio, pan, o: caller options }
   * ------------------------------------------------------------------ */
  var SFX = {};
  var NAMES = ['pencil', 'scribble', 'page', 'flip', 'stamp', 'tap', 'tick', 'pop', 'whoosh', 'bell', 'chime', 'success', 'fail', 'paper'];
  // Minimum seconds between two sounds of the same name, so a loop that fires every
  // frame still sounds like a person, not a machine gun.
  var LIMITS = { pencil: 0.09, scribble: 0.5, page: 0.3, flip: 0.12, stamp: 0.3, tap: 0.05, tick: 0.04, pop: 0.06,
    whoosh: 0.25, bell: 0.1, chime: 0.25, success: 0.8, fail: 0.6, paper: 0.25 };
  // Sounds that sit in the music's key keep their pitch variation to a few cents.
  var TONAL = { bell: 1, chime: 1, success: 1, fail: 1 };
  // Per-effect trim, measured with offline renders so the quietest recurring sounds sit
  // roughly 10 dB under the stamp, which is the loudest.
  var CAL = { pencil: 2.05, scribble: 1.18, page: 1.38, flip: 1.7, stamp: 0.83, tap: 1.33, tick: 1.6, pop: 1.1,
    whoosh: 1.8, bell: 2.2, chime: 1.9, success: 1.55, fail: 0.67, paper: 2.0 };

  function keyNote(R, deg, lift) {
    var k = R.key;
    return midiHz(degMidi(k.tonic + (lift == null ? 24 : lift), k.scale, deg));
  }
  var BELL_DEGREES = [0, 2, 4, 7, 9, 11, 4];
  function bellDegree(R, v) {
    if (v.o.degree != null) return v.o.degree;
    var d, n = 0;
    do { d = pick(R.rand, BELL_DEGREES); n++; } while (d === R.lastDeg && n < 6);   // never the same bell twice in a row
    R.lastDeg = d;
    return d;
  }

  SFX.pencil = function (E, t, v) {
    var r = E.rnd;
    scratch(E, { t: t, dur: 0.13 + r() * 0.09, strokes: r() < 0.45 ? 2 : 1,
      f0: (2200 + r() * 700) * v.p, f1: (3300 + r() * 900) * v.p, q: 1.2, rate: 22 + r() * 12, depth: 0.45,
      peak: 0.42 * v.g, pan: v.pan != null ? v.pan : (r() - 0.5) * 0.3 });
  };

  SFX.scribble = function (E, t, v) {
    var r = E.rnd, len = clamp(+v.o.length || 1.2, 0.25, 8);
    scratch(E, { t: t, dur: len, seg: 0.11, f0: 2000 * v.p, f1: 3600 * v.p, q: 1.0, rate: 20 + r() * 10, depth: 0.5,
      peak: 0.32 * v.g, pan: v.pan != null ? v.pan : (r() - 0.5) * 0.2 });
  };

  SFX.page = function (E, t, v) {
    var r = E.rnd, p = v.p, g = v.g;
    var j = function (x) { return x * (1 + (r() - 0.5) * 0.16); };
    var n = 0.2 + r() * 0.1, body = 0.02 + n, L = body + 0.2;
    var pan = v.pan != null ? v.pan : 0;
    sweep(E, { t: t, dur: L, freqs: [[0, j(1400) * p], [0.02 + 0.7 * n, j(4200) * p], [L, j(2100) * p]],
      q0: 0.7, amp: [[0.025, 0.2 * g], [body, 0.2 * g], [L, 0.0001, 1]], am: { rate: 9 + r() * 5, depth: 0.22 }, hp: 500, pan: pan });
    var k, ticks = [0.005, 0.04 + r() * 0.015, 0.075 + r() * 0.02];
    for (k = 0; k < ticks.length; k++) hit(E, { t: t + ticks[k], type: 'highpass', freq: 3600, q: 0.7, dur: 0.02, peak: 0.08 * g, pan: pan });
    for (k = 0; k < 4; k++) hit(E, { t: t + 0.1 + r() * (n + 0.12), type: 'highpass', freq: 4000 + r() * 2500, q: 0.7, dur: 0.015 + r() * 0.025, peak: (0.025 + r() * 0.03) * g, pan: pan });
    hit(E, { t: t + L - 0.09, type: 'lowpass', freq: 600, q: 0.7, dur: 0.1, peak: 0.2 * g, pan: pan });
    tone(E, { t: t + L - 0.09, f0: 84 * p, f1: 76 * p, dur: 0.07, peak: 0.12 * g, lp: 300, pan: pan });
  };

  SFX.flip = function (E, t, v) {
    var r = E.rnd, p = v.p, g = v.g, pan = v.pan != null ? v.pan : 0;
    var L = 0.15 + r() * 0.04;
    sweep(E, { t: t, dur: L, freqs: [[0, 2400 * p], [L * 0.5, 5800 * p], [L, 3000 * p]], q0: 1.4,
      amp: [[0.015, 0.16 * g], [L * 0.6, 0.16 * g], [L, 0.0001, 1]], am: { rate: 17 + r() * 6, depth: 0.2 }, hp: 900, pan: pan });
    hit(E, { t: t + L - 0.02, type: 'highpass', freq: 4500, q: 0.7, dur: 0.014, peak: 0.07 * g, pan: pan });
    tone(E, { t: t + L - 0.02, f0: 125 * p, f1: 95 * p, dur: 0.05, peak: 0.07 * g, lp: 300, pan: pan });
  };

  SFX.stamp = function (E, t, v) {
    var p = v.p, g = v.g, pan = v.pan != null ? v.pan : 0;
    tone(E, { t: t, f0: 175 * p, f1: 55 * p, dur: 0.26, peak: 0.6 * g, lp: 520, wet: 0.05, pan: pan });
    hit(E, { t: t, type: 'lowpass', freq: 1900, q: 0.7, dur: 0.055, peak: 0.34 * g, wet: 0.04, pan: pan });
    hit(E, { t: t, type: 'bandpass', freq: 1500 * p, q: 1.8, dur: 0.014, atk: 0.002, peak: 0.28 * g, pan: pan });
  };

  SFX.tap = function (E, t, v) {
    var p = v.p, g = v.g;
    tone(E, { t: t, f0: 560 * p, f1: 380 * p, dur: 0.07, atk: 0.003, peak: 0.16 * g, pan: v.pan });
    hit(E, { t: t, type: 'lowpass', freq: 2500, q: 0.7, dur: 0.012, atk: 0.001, peak: 0.06 * g, pan: v.pan });
  };

  SFX.tick = function (E, t, v) {
    var p = v.p, g = v.g;
    tone(E, { t: t, f0: 1760 * p, dur: 0.03, atk: 0.002, peak: 0.11 * g, pan: v.pan });
    hit(E, { t: t, type: 'bandpass', freq: 3400 * p, q: 3, dur: 0.01, atk: 0.001, peak: 0.13 * g, pan: v.pan });
  };

  SFX.pop = function (E, t, v) {
    var p = v.p, g = v.g;
    tone(E, { t: t, f0: 280 * p, f1: 820 * p, dur: 0.1, atk: 0.003, peak: 0.32 * g, pan: v.pan });
    hit(E, { t: t, type: 'highpass', freq: 2000, q: 0.7, dur: 0.012, atk: 0.001, peak: 0.08 * g, pan: v.pan });
  };

  SFX.whoosh = function (E, t, v) {
    var r = E.rnd, p = v.p, g = v.g, L = 0.75 + r() * 0.25, side = r() < 0.5 ? -1 : 1;
    sweep(E, { t: t, dur: L, freqs: [[0, 220 * p], [L * 0.45, 2600 * p], [L, 500 * p]], q0: 1.0, q1: 2.5,
      amp: [[L * 0.4, 0.26 * g], [L, 0.0001, 1]], wet: 0.25,
      panFrom: v.pan != null ? v.pan : -0.5 * side, panTo: v.pan != null ? v.pan : 0.5 * side });
  };

  SFX.bell = function (E, t, v) {
    var R = E.R, r = E.rnd, f = keyNote(R, bellDegree(R, v)) * v.p;
    bellVoice(E, { t: t, f: f, peak: 0.16 * v.g, decay: 2.8, ratio: 2, pan: v.pan != null ? v.pan : (r() - 0.5) * 0.5, wet: 0.75, echo: 0.3 });
  };

  SFX.chime = function (E, t, v) {
    var R = E.R, r = E.rnd, d = bellDegree(R, v), pan = v.pan != null ? v.pan : (r() - 0.5) * 0.4;
    bellVoice(E, { t: t, f: keyNote(R, d) * v.p, peak: 0.12 * v.g, decay: 2.4, ratio: 2, pan: pan, wet: 0.75, echo: 0.3 });
    bellVoice(E, { t: t + 0.13 + r() * 0.02, f: keyNote(R, d + 4) * v.p, peak: 0.1 * v.g, decay: 2.8, ratio: 2, pan: -pan, wet: 0.75, echo: 0.3 });
  };

  // delivered: a small rising arpeggio of pure bells in the music's key
  SFX.success = function (E, t, v) {
    var R = E.R, r = E.rnd, base = v.o.degree != null ? v.o.degree : 0, steps = [0, 2, 4, 7], i;
    for (i = 0; i < steps.length; i++) {
      var last = i === steps.length - 1;
      bellVoice(E, { t: t + i * 0.15 + r() * 0.01, f: keyNote(R, base + steps[i]) * v.p, peak: (last ? 0.14 : 0.11) * v.g,
        decay: last ? 3.4 : 2.6, ratio: last ? 2 : 0, pan: v.pan != null ? v.pan : (i - 1.5) * 0.15, wet: 0.7, echo: last ? 0.35 : 0 });
    }
  };

  // a soft low sigh that glides down a semitone, never a buzzer
  SFX.fail = function (E, t, v) {
    var R = E.R, f = keyNote(R, 2, 0) * v.p;
    tone(E, { t: t, f0: f, f1: f * 0.944, dur: 1.5, atk: 0.04, peak: 0.34 * v.g, type: 'triangle', lp: 420, wet: 0.3, pan: v.pan });
    tone(E, { t: t, f0: f * 0.5, f1: f * 0.472, dur: 1.2, atk: 0.05, peak: 0.16 * v.g, lp: 300, wet: 0.2, pan: v.pan });
    hit(E, { t: t, type: 'bandpass', freq: 500, q: 0.9, dur: 0.6, atk: 0.06, peak: 0.05 * v.g, pan: v.pan });
  };

  // a sheet sliding on the table: low, soft, with a fine rustle
  SFX.paper = function (E, t, v) {
    var r = E.rnd, p = v.p, g = v.g, L = 0.4 + r() * 0.15;
    sweep(E, { t: t, dur: L, freqs: [[0, 700 * p], [L * 0.5, 1500 * p], [L, 900 * p]], q0: 0.6,
      amp: [[0.08, 0.13 * g], [L * 0.6, 0.13 * g], [L, 0.0001, 1]], am: { rate: 34 + r() * 8, depth: 0.14 }, hp: 250,
      pan: v.pan != null ? v.pan : (r() - 0.5) * 0.4 });
  };

  /* ------------------------------------------------------------------ *
   * 3c. UI cues for a deck or a host app: clicks, toggles, steps, page
   *     changes, reveals and outcomes.
   *     They are dry (no reverb, no echo) and short. Every pitch is a fixed number
   *     of semitones from a root that follows the key (the running music, else the
   *     page seed), and only intervals that exist in all three modes are used (0, 2,
   *     5, 7 and their octaves), so a cue never clashes with the music.
   *     One family of materials: graphite (a short band of noise) for contact, soft
   *     wood (a sine that settles from slightly sharp, plus one inharmonic partial)
   *     for weight, felt tines (a sine whose FM brightness fades early) for meaning,
   *     and paper air (swept noise) for motion. Rising and moving right means on,
   *     next or open; falling and moving left means off, back or close.
   *     The approach was informed by studying UI SFX (https://github.com/romainsimon/uisfx,
   *     MIT code, CC0 audio): semantic names, short dry envelopes, frequent cues
   *     quieter than outcomes, per-cue rate limits. No code or audio was copied.
   * ------------------------------------------------------------------ */
  var CUE_NAMES = ['click', 'tap-soft', 'select', 'toggle-on', 'toggle-off', 'step-next', 'step-back',
    'page-next', 'page-back', 'reveal', 'dismiss', 'sketch-done', 'celebrate', 'error-soft'];
  /* [shortest, longest] audible length in seconds at the default gain: from the onset
     to the last sample above -60 dBFS on the effect bus. dev/check-cues.mjs holds every
     cue to it and checks that the 50 ms after the longest length are silent. */
  var CUE_SPAN = {
    click: [0.025, 0.045], 'tap-soft': [0.045, 0.075], select: [0.1, 0.15], 'toggle-on': [0.15, 0.21],
    'toggle-off': [0.14, 0.19], 'step-next': [0.12, 0.17], 'step-back': [0.12, 0.17], 'page-next': [0.18, 0.27],
    'page-back': [0.12, 0.2], reveal: [0.21, 0.29], dismiss: [0.12, 0.17], 'sketch-done': [0.28, 0.37],
    celebrate: [0.65, 0.9], 'error-soft': [0.19, 0.26]
  };
  var CUE_GAP = 0.03;   // two UI cues never start closer together than this; the first one wins

  // the root of every cue: the key's tonic moved into A4..G#5 (440 to 831 Hz)
  function cueRoot(R) { return foldInto(R.key.tonic + 24, 69, 80); }
  function cueHz(R, semis, v) { return midiHz(cueRoot(R) + semis) * v.p; }

  /* Soft wood. A sine that starts `from` times sharp and settles on f (or on f * to)
     within `glide` seconds, an inharmonic partial at 2.71 f that dies three times as
     fast, and a 6 ms puff of band-passed noise for the contact. `bright` (0..1) scales
     the partial and the contact; 0 leaves a plain, rounder body.
     o: t, f, dur, peak, from, to, glide, atk, type, lp, bright, pan */
  function wood(E, o) {
    var b = o.bright == null ? 1 : o.bright;
    tone(E, { t: o.t, f0: o.f * (o.from || 1.06), f1: o.f * (o.to || 1), glide: o.glide || 0.008, dur: o.dur,
      atk: o.atk || 0.0012, peak: o.peak, type: o.type, lp: o.lp, pan: o.pan });
    if (b <= 0) return;
    tone(E, { t: o.t, f0: o.f * 2.71, dur: Math.max(0.012, o.dur / 3), atk: 0.0008, peak: o.peak * 0.24 * b, pan: o.pan });
    hit(E, { t: o.t, type: 'bandpass', freq: Math.min(o.f * 4, 4200), q: 0.9, dur: 0.006, atk: 0.0006, peak: o.peak * 0.4 * b, pan: o.pan });
  }

  /* A felt tine: a sine with FM at the same frequency whose depth fades over the first
     40 % of the decay, so it starts soft-bright and ends pure. depth 0 is a pure sine.
     o: t, f, dur, peak, atk, depth, pan */
  function tine(E, o) {
    var d = o.depth == null ? 0.4 : o.depth;
    bellVoice(E, { t: o.t, f: o.f, peak: o.peak, decay: o.dur, atk: o.atk || 0.003, ratio: d > 0 ? 1 : 0, depth: d, pan: o.pan });
  }

  /* A short pencil line: a narrow band of noise that slides from f0 to f1, with a fast
     tremolo for the grain of the paper. o: t, dur, f0, f1, peak, rate, pan | panFrom, panTo */
  function stroke(E, o) {
    sweep(E, { t: o.t, dur: o.dur, freqs: [[0, o.f0], [o.dur, o.f1]], q0: 1.8,
      amp: [[0.01, o.peak], [o.dur * 0.65, o.peak * 0.75], [o.dur, 0.0001, 1]],
      am: { rate: o.rate || 30, depth: 0.35 }, hp: 1200, lp: 5200, pan: o.pan, panFrom: o.panFrom, panTo: o.panTo });
  }

  // a fixed pan for every voice when the caller passes one, else the cue's own
  function side(v, own) { return v.pan != null ? v.pan : own; }

  // contact: a graphite tick on a small wooden body
  SFX.click = function (E, t, v) {
    hit(E, { t: t, type: 'bandpass', freq: 3400 * v.p, q: 1.4, dur: 0.008, atk: 0.0006, peak: 0.09 * v.g, pan: v.pan });
    wood(E, { t: t, f: cueHz(E.R, 5, v), dur: 0.04, peak: 0.17 * v.g, bright: 0.8, pan: v.pan });
  };

  // contact, softer: a fingertip on felt and paper, lower and rounder, no tick
  SFX['tap-soft'] = function (E, t, v) {
    hit(E, { t: t, type: 'lowpass', freq: 1500 * v.p, q: 0.7, dur: 0.024, atk: 0.003, peak: 0.06 * v.g, pan: v.pan });
    wood(E, { t: t, f: cueHz(E.R, -5, v), from: 1.03, dur: 0.075, atk: 0.003, type: 'triangle', lp: 1500, peak: 0.2 * v.g, bright: 0, pan: v.pan });
  };

  // one item becomes the chosen one: a tick and a single bright tine an octave up
  SFX.select = function (E, t, v) {
    hit(E, { t: t, type: 'bandpass', freq: 4200 * v.p, q: 1.6, dur: 0.007, atk: 0.0005, peak: 0.06 * v.g, pan: v.pan });
    tine(E, { t: t + 0.003, f: cueHz(E.R, 12, v), dur: 0.16, atk: 0.002, depth: 0.5, peak: 0.12 * v.g, pan: v.pan });
    tone(E, { t: t + 0.003, f0: cueHz(E.R, 19, v), dur: 0.06, atk: 0.002, peak: 0.022 * v.g, pan: v.pan });
  };

  // a switch: the wooden detent, then two tines that rise a fifth (on) or fall one (off)
  SFX['toggle-on'] = function (E, t, v) {
    wood(E, { t: t, f: cueHz(E.R, -12, v), from: 1.08, dur: 0.05, peak: 0.12 * v.g, pan: v.pan });
    tine(E, { t: t + 0.004, f: cueHz(E.R, 0, v), dur: 0.07, depth: 0.35, peak: 0.07 * v.g, pan: v.pan });
    tine(E, { t: t + 0.05, f: cueHz(E.R, 7, v), dur: 0.17, depth: 0.45, peak: 0.11 * v.g, pan: v.pan });
  };
  SFX['toggle-off'] = function (E, t, v) {
    var f = cueHz(E.R, 0, v);
    wood(E, { t: t, f: cueHz(E.R, -12, v), from: 1.05, to: 0.97, glide: 0.03, dur: 0.05, peak: 0.12 * v.g, bright: 0.6, pan: v.pan });
    tine(E, { t: t + 0.004, f: cueHz(E.R, 7, v), dur: 0.06, depth: 0.35, peak: 0.07 * v.g, pan: v.pan });
    tone(E, { t: t + 0.05, f0: f, f1: f * 0.985, dur: 0.15, atk: 0.003, type: 'triangle', lp: 1800, peak: 0.12 * v.g, pan: v.pan });
  };

  // one step on in a flow: a pencil line drawn to the right that lands on a high tine;
  // one step back: the line drawn to the left, landing a fifth lower
  function stepCue(E, t, v, dir) {
    var r = E.rnd, up = dir > 0;
    stroke(E, { t: t, dur: 0.065, f0: (up ? 2300 : 3600) * v.p, f1: (up ? 3600 : 2300) * v.p, peak: 0.09 * v.g, rate: 26 + r() * 8,
      panFrom: side(v, -0.25 * dir), panTo: side(v, 0.2 * dir) });
    tine(E, { t: t + 0.055, f: cueHz(E.R, up ? 12 : 5, v), dur: 0.12, depth: 0.4, peak: 0.08 * v.g, pan: side(v, 0.25 * dir) });
  }
  SFX['step-next'] = function (E, t, v) { stepCue(E, t, v, 1); };
  SFX['step-back'] = function (E, t, v) { stepCue(E, t, v, -1); };

  /* A light page change, told apart by shape as well as by direction, so it still
     reads on a mono phone speaker. Forward: the corner lifts with a small flick, the
     sheet gathers speed and brightness, then lands. Back: one quick pull that starts
     bright, darkens, and tucks in. */
  function pageCue(E, t, v, dir) {
    var r = E.rnd, p = v.p, g = v.g, a = side(v, -0.35 * dir), b = side(v, 0.35 * dir), L;
    if (dir > 0) {
      L = 0.24 + r() * 0.03;
      hit(E, { t: t, type: 'bandpass', freq: 4500 * p, q: 1, dur: 0.01, atk: 0.001, peak: 0.04 * g, pan: a });
      sweep(E, { t: t + 0.006, dur: L, freqs: [[0, 900 * p], [L * 0.62, 3200 * p], [L, 2000 * p]], q0: 0.9,
        amp: [[L * 0.6, 0.11 * g], [L, 0.0001, 1]], am: { rate: 12 + r() * 4, depth: 0.25 }, hp: 400, lp: 3800, panFrom: a, panTo: b });
      hit(E, { t: t + L * 0.64, type: 'lowpass', freq: 650, q: 0.7, dur: 0.05, atk: 0.005, peak: 0.05 * g, pan: b });
    } else {
      L = 0.2 + r() * 0.03;
      sweep(E, { t: t, dur: L, freqs: [[0, 3000 * p], [L * 0.3, 2400 * p], [L, 800 * p]], q0: 0.9,
        amp: [[0.015, 0.11 * g], [L * 0.3, 0.09 * g], [L, 0.0001, 1]], am: { rate: 15 + r() * 4, depth: 0.25 }, hp: 400, lp: 3800, panFrom: a, panTo: b });
      hit(E, { t: t + L * 0.55, type: 'lowpass', freq: 500, q: 0.7, dur: 0.045, atk: 0.004, peak: 0.045 * g, pan: b });
    }
  }
  SFX['page-next'] = function (E, t, v) { pageCue(E, t, v, 1); };
  SFX['page-back'] = function (E, t, v) { pageCue(E, t, v, -1); };

  // something appears: rising air that opens into a soft open fifth
  SFX.reveal = function (E, t, v) {
    var g = v.g;
    sweep(E, { t: t, dur: 0.16, freqs: [[0, 500 * v.p], [0.16, 2600 * v.p]], q0: 1.1, amp: [[0.1, 0.06 * g], [0.16, 0.0001, 1]], hp: 300, lp: 3600, pan: v.pan });
    tine(E, { t: t + 0.09, f: cueHz(E.R, 0, v), dur: 0.2, atk: 0.012, depth: 0, peak: 0.07 * g, pan: side(v, -0.15) });
    tine(E, { t: t + 0.09, f: cueHz(E.R, 7, v), dur: 0.2, atk: 0.012, depth: 0, peak: 0.055 * g, pan: side(v, 0.15) });
  };

  // something leaves: falling air that settles on a small low knock
  SFX.dismiss = function (E, t, v) {
    sweep(E, { t: t, dur: 0.13, freqs: [[0, 2400 * v.p], [0.13, 600 * v.p]], q0: 1.1, amp: [[0.015, 0.07 * v.g], [0.13, 0.0001, 1]], hp: 300, lp: 3600, pan: v.pan });
    wood(E, { t: t + 0.09, f: cueHz(E.R, -5, v), from: 1.05, to: 0.98, glide: 0.04, dur: 0.07, peak: 0.1 * v.g, bright: 0.5, pan: v.pan });
  };

  // a drawing is finished: a check mark (short down stroke, longer up stroke), then the
  // pencil taps the paper and lifts off on a fifth and an octave
  SFX['sketch-done'] = function (E, t, v) {
    var p = v.p, g = v.g;
    stroke(E, { t: t, dur: 0.045, f0: 3000 * p, f1: 2400 * p, peak: 0.07 * g, pan: side(v, -0.1) });
    stroke(E, { t: t + 0.05, dur: 0.085, f0: 2400 * p, f1: 3800 * p, peak: 0.09 * g, panFrom: side(v, -0.1), panTo: side(v, 0.2) });
    wood(E, { t: t + 0.15, f: cueHz(E.R, 5, v), dur: 0.035, peak: 0.07 * g, bright: 0.7, pan: side(v, 0.2) });
    tine(E, { t: t + 0.15, f: cueHz(E.R, 7, v), dur: 0.2, depth: 0.4, peak: 0.08 * g, pan: side(v, 0.1) });
    tine(E, { t: t + 0.152, f: cueHz(E.R, 12, v), dur: 0.22, depth: 0, peak: 0.06 * g, pan: side(v, 0.25) });
  };

  /* the one long cue: a low wooden bloom, five tines rising through open intervals
     from left to right, and small flicks of paper scattered over the first half second.
     Rows: [start, semitones, decay] */
  var CELEBRATE = [[0, 0, 0.3], [0.07, 7, 0.32], [0.14, 12, 0.36], [0.21, 14, 0.4], [0.3, 19, 0.62]];
  SFX.celebrate = function (E, t, v) {
    var r = E.rnd, g = v.g, i;
    wood(E, { t: t, f: cueHz(E.R, -12, v), dur: 0.09, peak: 0.08 * g, bright: 0.4, pan: v.pan });
    for (i = 0; i < CELEBRATE.length; i++) {
      var n = CELEBRATE[i], last = i === CELEBRATE.length - 1;
      tine(E, { t: t + n[0] + r() * 0.006, f: cueHz(E.R, n[1], v), dur: n[2], depth: last ? 0 : 0.4,
        peak: (last ? 0.09 : 0.075) * g, pan: side(v, -0.3 + i * 0.15) });
    }
    for (i = 0; i < 7; i++) {
      hit(E, { t: t + 0.05 + r() * 0.5, type: 'bandpass', freq: 2500 + r() * 2500, q: 1.2, dur: 0.008 + r() * 0.012, atk: 0.001,
        peak: (0.012 + r() * 0.016) * g, pan: side(v, (r() - 0.5) * 1.2) });
    }
  };

  // a soft error: two muffled wooden knocks that fall a fourth, the second one sagging
  SFX['error-soft'] = function (E, t, v) {
    var g = v.g;
    wood(E, { t: t, f: cueHz(E.R, 0, v), from: 1.04, dur: 0.09, atk: 0.002, type: 'triangle', lp: 1500, peak: 0.15 * g, bright: 0, pan: v.pan });
    hit(E, { t: t, type: 'lowpass', freq: 1200, q: 0.7, dur: 0.016, atk: 0.0015, peak: 0.04 * g, pan: v.pan });
    wood(E, { t: t + 0.115, f: cueHz(E.R, -5, v), from: 1.03, to: 0.97, glide: 0.1, dur: 0.14, atk: 0.002, type: 'triangle', lp: 1200, peak: 0.16 * g, bright: 0, pan: v.pan });
    hit(E, { t: t + 0.115, type: 'lowpass', freq: 1000, q: 0.7, dur: 0.016, atk: 0.0015, peak: 0.04 * g, pan: v.pan });
  };

  NAMES = NAMES.concat(CUE_NAMES);
  for (var ci = 0; ci < CUE_NAMES.length; ci++) {
    var cn = CUE_NAMES[ci];
    if (cn !== 'page-next' && cn !== 'page-back') TONAL[cn] = 1;   // the page cues are noise only
  }
  var CUE_LIMITS = { click: 0.04, 'tap-soft': 0.05, select: 0.06, 'toggle-on': 0.08, 'toggle-off': 0.08, 'step-next': 0.09,
    'step-back': 0.09, 'page-next': 0.22, 'page-back': 0.22, reveal: 0.12, dismiss: 0.12, 'sketch-done': 0.35, celebrate: 1.2, 'error-soft': 0.35 };
  /* Trims measured as a listener hears the nominal cue: the loudest 50 ms of the mean
     power of both channels, through the live master chain (cue.render with master: true;
     a cue without a pan plays on both speakers). click and tap-soft near -42 dBFS,
     select and the toggles about -40.5, steps, page changes, reveal and dismiss -39.5 to
     -37.5, sketch-done and error-soft about -35.5, celebrate -31.5. */
  var CUE_CAL = { click: 0.56, 'tap-soft': 0.4, select: 0.46, 'toggle-on': 0.44, 'toggle-off': 0.49, 'step-next': 1.2, 'step-back': 1.15,
    'page-next': 1.88, 'page-back': 1.8, reveal: 0.87, dismiss: 0.91, 'sketch-done': 1.06, celebrate: 1.27, 'error-soft': 0.68 };
  for (cn in CUE_LIMITS) { LIMITS[cn] = CUE_LIMITS[cn]; CAL[cn] = CUE_CAL[cn]; }

  /* Trigger one effect at absolute time t on a rig. Used by live play() and by cues
     in offline renders, so both paths share the rate limit and the variation. */
  function trigger(R, name, t, o) {
    var fn = SFX[name];
    if (!fn) return false;
    o = o || {};
    var lim = LIMITS[name] || 0.05, isCue = !!CUE_SPAN[name];
    if (!o.force && R.last[name] != null && t - R.last[name] < lim) return false;
    if (isCue && !o.force && R.lastCue != null && t - R.lastCue < CUE_GAP) return false;
    R.last[name] = t;
    if (isCue) R.lastCue = t;
    var r = R.rand;
    var v = {
      o: o,
      g: (o.gain != null ? o.gain : 1) * (CAL[name] || 1) * (0.9 + r() * 0.2),
      p: (o.pitch || 1) * (TONAL[name] ? 1 + (r() - 0.5) * 0.006 : 1 + (r() - 0.5) * 0.07),
      pan: o.pan != null ? clamp(+o.pan, -1, 1) : null
    };
    fn(R.sfxEnv, t + r() * 0.008, v);
    if (R.tex) texDuck(R, name, t);   // every admitted cue ducks the textures, live and offline alike
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 3d. Textures: a pen that follows the line, key taps under typed text
   *     and a paper-air swell. Three lanes, one audible at a time, every
   *     cue ducks them. This part holds the pure planners: they turn a host
   *     timeline into control curves and tap lists and need no audio
   *     context, so node runs them too (dev/check-textures.mjs does).
   *     Nothing here reads the cue random stream or takes a cue slot.
   * ------------------------------------------------------------------ */
  var TEX_POOL = 12;          // slots of the texture sink (typing taps only)
  var PRESSURE_RATE = 200;    // control points per second for the pen pressure
  var PARAM_RATE = 100;       // control points per second for band, low-pass, pan and the grain
  var TICK_MS = 25;           // live scheduler interval
  var HORIZON = 0.12;         // how far ahead a tick schedules
  var LEAD = 0.03;            // earliest time a new or changed plan touches a param
  var STOP_LEAD = 0.01;       // a stop fade starts this soon after its event
  var IDLE_STOP = 1.5;        // a chain at gain 0 with no plan stops its source after this
  var CLOSE_STOP = 0.05;      // a chain closed with its surface stops this long after its fade, then its nodes are freed
  var MAX_STROKES = 64;       // strokes kept per surface; the oldest finished ones drop first
  var MIN_RAMP = 0.012;       // no gain change on a running texture is faster than this
  var TAP_GAP = 0.055;        // two taps never start closer than this
  var ACCENT_GAP = 0.07;      // two pen accents never start closer than this; the first wins
  var PEN_NOISE_SEED = 13, AIR_NOISE_SEED = 99;
  /* Level trims at the texture input, before SFX_LEVEL, frozen from the check script's
     --calibrate mode, which bisects them against TEX_TARGETS (the loudest of several seeds,
     since the noise segment a seed picks moves the level by a fraction of a dB). Run it again
     after any change to a texture recipe and paste the printed values here. */
  var PEN_CAL = 0.04648, TYPE_CAL = 0.1024, AIR_CAL = 0.03373;
  // typing tap kinds in dB, relative to a letter
  var TAP_TRIM = { letter: 0, space: -6.9, punctuation: -0.5, 'return': -8.4, settle: -10.2 };
  /* What a listener hears: dBFS over the loudest 50 ms of the mean power of both channels,
     through the master chain. The quietest cues sit near -42, so no texture window may pass
     the margin, 6 dB under them. */
  var TEX_TARGETS = { pen: -51, penCeiling: -48.5, letter: -49.5, space: -48.5, punctuation: -52.5,
    'return': -48, settle: -51.5, air: -57, wash: -65, margin: -48 };
  var SURFACE_TRIM = { room: 0, sidebar: -2, wizard: -4, deck: 0 };
  var LEVEL_TRIM = { full: 0, soft: -4 };
  function fromDb(x) { return Math.pow(10, x / 20); }
  // a cheap integer hash to 0..1 for values that must be the same at the same time on every replan
  function unit(n) {
    n = (n | 0) ^ 0x5bd1e995;
    n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d);
    n = Math.imul(n ^ (n >>> 12), 0x297a2d39);
    return ((n ^ (n >>> 15)) >>> 0) / 4294967296;
  }

  /* The speed of the pen comes from the stroke's own easing. Every ink stroke on the host
     draws with cubic-bezier(0.22, 1, 0.36, 1): for a time fraction x, solve bx(u) = x by
     Newton, then the drawn fraction is by(u) and the speed is the slope by'/bx'. The speed
     is divided by the steepest slope of the curve (4.545 for the default, at x = 0), so it
     starts at 1 and falls to 0 exactly as the line on screen slows. */
  var EASE_DEFAULT = [0.22, 1, 0.36, 1];
  var easeCache = {};
  function easing(e) {
    e = (e && e.length === 4) ? e : EASE_DEFAULT;
    var key = e.join(',');
    if (easeCache[key]) return easeCache[key];
    var x1 = +e[0], y1 = +e[1], x2 = +e[2], y2 = +e[3];
    function bx(u) { var v = 1 - u; return 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u; }
    function by(u) { var v = 1 - u; return 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u; }
    function dbx(u) { var v = 1 - u; return 3 * v * v * x1 + 6 * v * u * (x2 - x1) + 3 * u * u * (1 - x2); }
    function dby(u) { var v = 1 - u; return 3 * v * v * y1 + 6 * v * u * (y2 - y1) + 3 * u * u * (1 - y2); }
    function solve(x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      var u = x;
      for (var i = 0; i < 6; i++) { var d = dbx(u); if (Math.abs(d) < 1e-7) break; u -= (bx(u) - x) / d; }
      return clamp(u, 0, 1);
    }
    function slope(u) { var d = dbx(u); return d > 1e-7 ? dby(u) / d : 0; }
    var top = 0;
    for (var k = 0; k <= 64; k++) top = Math.max(top, slope(k / 64));
    if (top <= 0) top = 1;
    var fn = {
      p: function (x) { return by(solve(x)); },
      s: function (x) { return clamp(slope(solve(x)) / top, 0, 1); },
      // the first time fraction at which the drawn fraction reaches q
      at: function (q) { for (var i = 0; i <= 400; i++) { if (by(solve(i / 400)) >= q) return i / 400; } return 1; }
    };
    easeCache[key] = fn;
    return fn;
  }

  /* Shape profiles: modulations of the one pen voice, never a second synth.
     e: exponent on the speed, trim in dB, am: [rate factor, depth factor], start: the
     accent at the first contact; corner, dip, dipLen: the corners of boxes and polygons;
     sub: the accent of each hatch mark. dot and text are silent. */
  var SHAPES = {
    line:          { e: 0.35, trim: 0,   am: [1, 1],    start: 0.5 },
    curve:         { e: 0.6,  trim: 0,   am: [1, 1],    start: 0.5 },
    ellipse:       { e: 0.5,  trim: 1,   am: [1, 0.6],  start: 0.4, close: 0.6 },
    check:         { e: 0.5,  trim: 0.5, am: [1, 1],    start: 0.5, leg2: 0.7 },
    'arrow-shaft': { e: 0.5,  trim: 0,   am: [1, 1],    start: 0.5 },
    'arrow-head':  { e: 0.5,  trim: -2,  am: [1.3, 1],  start: 0.6 },
    flick:         { e: 0.5,  trim: -3,  am: [1.3, 1],  start: 0.4 },
    box:           { e: 0.45, trim: -1,  am: [1, 1],    start: 0.5, corner: 0.45, dip: 0.92, dipLen: 0.025 },
    'box-round':   { e: 0.45, trim: -2,  am: [1, 0.85], start: 0.4, corner: 0.25 },
    poly:          { e: 0.45, trim: -1,  am: [1, 1],    start: 0.5, corner: 0.35, dip: 0.94, dipLen: 0.02 },
    hatch:         { e: 0.5,  trim: -2,  am: [1.1, 1],  sub: 0.3 },
    wash:          { trim: -14, am: [1, 0.5] },
    dot: null,
    text: null
  };
  var PEN_SHAPES = Object.keys(SHAPES);
  var BOX_CORNERS = [0.18, 0.40, 0.62];

  function prepStroke(s, idx, seedBase, surface, key, vary) {
    var shape = SHAPES.hasOwnProperty(s.shape) ? s.shape : 'line', P = SHAPES[shape];
    var start = +s.start || 0, D = Math.max(0.05, +s.duration || 0.66);
    var sk = s.key != null ? String(s.key) : key;   // a stroke in a surface union keeps its own report's key
    var st = {
      shape: shape, P: P, start: start, D: D, end: start + D, silent: !P, order: idx,
      x0: s.x0 == null ? 0.5 : +s.x0, x1: s.x1 == null ? 0.5 : +s.x1,
      ease: easing(s.easing), trim: P ? fromDb(P.trim + (+s.levelDb || 0)) : 0,
      seed: hash(seedBase + '|pen|' + surface + '|' + sk + '|' + idx + '|' + start.toFixed(3)),
      accents: [], corners: [], subs: 0, phi: 0, mid: start + D / 2
    };
    if (!P) return st;
    var r = mulberry(st.seed), k, n;
    st.mid = start + st.ease.at(0.5) * D;
    if (shape === 'ellipse') st.phi = s.phi != null ? +s.phi : (vary === false ? 0 : r() * 2 * Math.PI);
    else st.phi = vary === false ? 0 : r() * 2 * Math.PI;
    if (P.start) st.accents.push({ t: start, a: P.start });
    if (shape === 'box' || shape === 'box-round') st.corners = BOX_CORNERS.slice();
    if (shape === 'poly') {
      n = Math.max(3, Math.round(+s.marks || 3));
      for (k = 1; k < n; k++) st.corners.push(0.8 * k / n);
    }
    for (k = 0; k < st.corners.length; k++) st.accents.push({ t: start + st.corners[k] * D, a: P.corner });
    if (shape === 'ellipse') st.accents.push({ t: start + st.ease.at(0.97) * D, a: P.close });
    if (shape === 'check') st.accents.push({ t: start + 0.24 * D, a: P.leg2 });
    if (shape === 'hatch') {
      st.subs = clamp(Math.round(+s.marks || 5), 3, 8);
      for (k = 0; k < st.subs; k++) st.accents.push({ t: start + 0.85 * k / st.subs * D, a: P.sub });
    }
    return st;
  }

  /* One stroke at time t: its contribution c (0..1), speed s, band factor m, pan, the
     low-pass factor b and the grain factors r, d. */
  function evalStroke(st, t, out) {
    var tau = t - st.start, P = st.P;
    out.c = 0; out.s = 0; out.m = 1; out.pan = 0; out.b = 1; out.r = 1; out.d = 1;
    if (!P || tau < 0 || tau > st.D) return out;
    var x = tau / st.D, win = Math.min(1, tau / 0.010), prof = 1, m = 1, s, p, k, shape = st.shape;
    out.r = P.am[0]; out.d = P.am[1];
    if (shape === 'wash') {
      // a whisper: no speed, an ease-in-out bell over the fade of the fill
      prof = 0.5 - 0.5 * Math.cos(2 * Math.PI * x);
      out.s = 0.1;
      out.c = Math.min(1, st.trim * win * prof);
      out.pan = (st.x0 + (st.x1 - st.x0) * x - 0.5) * 0.4;
      return out;
    }
    p = st.ease.p(x); s = st.ease.s(x);
    if (shape === 'check') {
      if (x < 0.16) m = 1.05 - 0.13 * (x / 0.16);
      else if (x < 0.24) {
        // the lift between the two legs: 12 ms ramps down to -14 dB and back up
        var into = (x - 0.16) * st.D, left = (0.24 - x) * st.D;
        prof = 0.2 + 0.8 * Math.max(0, 1 - Math.min(into, left) / 0.012);
        m = 0.92;
      } else {
        var u = (x - 0.24) / 0.76;
        s = st.ease.s(u); p = 0.4 + 0.6 * st.ease.p(u);
        m = 0.9 + 0.45 * u;
      }
    } else if (shape === 'ellipse') {
      m = 1 + 0.28 * Math.sin(Math.PI * p);
      // 0.24, not the spec's 0.18: the slowing tail of the stroke weighs little, so 0.18 turned only 0.22 peak to peak
      out.pan += 0.24 * Math.sin(2 * Math.PI * p + st.phi);
      out.b = 1 + 0.12 * Math.cos(2 * Math.PI * p + st.phi);
    } else if (shape === 'curve') m = 1 + 0.06 * Math.sin(2 * Math.PI * 3 * tau);
    else if (shape === 'arrow-shaft') m = 1 - 0.08 * x;
    else if (shape === 'arrow-head' || shape === 'flick') { prof = Math.exp(-Math.max(0, tau - 0.012) / 0.07); m = 1.15; }
    else if (shape === 'box' || shape === 'poly') {
      for (k = 0; k < st.corners.length; k++) {
        var tc = st.corners[k] * st.D;
        if (tau >= tc && tau < tc + P.dipLen) { m = P.dip; break; }
      }
    } else if (shape === 'hatch') {
      var span = 0.85 / st.subs;
      if (x >= 0.85) prof = 0;
      else {
        var sub = Math.floor(x / span), ts = (x - sub * span) * st.D, len = span * st.D;
        s = st.ease.s((x - sub * span) / span);   // every mark is its own quick line
        prof = ts < 0.006 ? ts / 0.006 : 1 - 0.7 * Math.min(1, (ts - 0.006) / Math.max(0.001, len - 0.006));
        m = sub % 2 ? 1.1 : 0.9;
      }
    }
    out.s = s; out.m = m;
    out.c = Math.min(1, st.trim * win * Math.pow(s, P.e) * prof);
    out.pan += (st.x0 + (st.x1 - st.x0) * p - 0.5) * 0.4;
    return out;
  }

  function mergeSpans(spans, bridge) {
    spans = spans.slice().sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    for (var i = 0; i < spans.length; i++) {
      var last = out[out.length - 1];
      if (last && spans[i][0] - last[1] < (bridge || 0)) last[1] = Math.max(last[1], spans[i][1]);
      else out.push([spans[i][0], spans[i][1]]);
    }
    return out;
  }

  /* plan.pen(timeline, { seed, from, init }): the union of the strokes as one voice.
     Returns control arrays from t0: L (pressure, PRESSURE_RATE) and fc, q, lp, amRate,
     amDepth, pan, band (PARAM_RATE), the accepted accents, the activity windows and a
     summary of every stroke. `from` is the first control point (default 50 ms before the
     first stroke); `init` carries the values a replan continues from. */
  function planPen(timeline, o) {
    o = o || {};
    timeline = timeline || {};
    var seedBase = String(o.seed != null ? o.seed : 'sketchy');
    var surface = timeline.surface || 'deck', key = timeline.key != null ? String(timeline.key) : '';
    var list = timeline.strokes || [], st = [], i, k;
    for (i = 0; i < list.length; i++) st.push(prepStroke(list[i], list[i].order != null ? list[i].order : i, seedBase, surface, key, timeline.vary));
    var first = Infinity, last = -Infinity, spans = [];
    for (i = 0; i < st.length; i++) {
      if (st[i].silent) continue;
      first = Math.min(first, st[i].start); last = Math.max(last, st[i].end);
      spans.push([st[i].start - 0.05, st[i].end + 0.15]);
    }
    var summary = st.map(function (s) {
      return { shape: s.shape, start: s.start, duration: s.D, mid: s.mid, silent: s.silent, accents: s.accents.length, corners: s.corners.length, subs: s.subs, order: s.order };
    });
    var t0 = o.from != null ? +o.from : (first === Infinity ? 0 : first - 0.05);
    if (first === Infinity || last + 0.35 <= t0) {
      return { rate: PRESSURE_RATE, paramRate: PARAM_RATE, t0: t0, n: 0, L: new Float32Array(0), fc: new Float32Array(0), q: new Float32Array(0),
        lp: new Float32Array(0), amRate: new Float32Array(0), amDepth: new Float32Array(0), pan: new Float32Array(0), band: new Float32Array(0),
        accents: [], activity: [], window: [t0, t0], strokes: summary, seed: seedBase, surface: surface };
    }
    var to = last + 0.35;
    var N = Math.ceil((to - t0) * PRESSURE_RATE) + 1, M = Math.ceil(N / 2);
    // accents: every stroke start and shape accent, 70 ms apart, the first one wins
    var acc = [];
    for (i = 0; i < st.length; i++) for (k = 0; k < st[i].accents.length; k++) acc.push(st[i].accents[k]);
    acc.sort(function (a, b) { return a.t - b.t; });
    var accents = [];
    for (i = 0; i < acc.length; i++) {
      if (accents.length && acc[i].t - accents[accents.length - 1].t < ACCENT_GAP) continue;
      accents.push({ t: acc[i].t, a: acc[i].a });
    }
    var L = new Float32Array(N), fc = new Float32Array(M), q = new Float32Array(M), lp = new Float32Array(M);
    var amRate = new Float32Array(M), amDepth = new Float32Array(M), pan = new Float32Array(M), band = new Float32Array(M);
    var init = o.init || {};
    var Ls = init.L || 0, panS = init.pan || 0;
    var hold = { sigma: init.sigma != null ? init.sigma : 1, m: init.m != null ? init.m : 1, b: 1, r: 1, d: 1, pan: init.pan || 0 };
    var atk = 1 - Math.exp(-1 / (PRESSURE_RATE * 0.003)), rel = 1 - Math.exp(-1 / (PRESSURE_RATE * 0.03));
    var panA = 1 - Math.exp(-1 / (PARAM_RATE * 0.03));
    var jseed = (hash(seedBase + '|pen|' + surface + '|' + key + '|grain') | 0);
    var ev = { c: 0, s: 0, m: 1, pan: 0, b: 1, r: 1, d: 1 }, firstAcc = 0;
    for (i = 0; i < N; i++) {
      var t = t0 + i / PRESSURE_RATE, prod = 1, sumC = 0, sig = 0, mm = 0, pp = 0, bb = 0, rr = 0, dd = 0;
      for (k = 0; k < st.length; k++) {
        evalStroke(st[k], t, ev);
        if (ev.c <= 0) continue;
        prod *= 1 - ev.c; sumC += ev.c;
        sig += ev.c * ev.s; mm += ev.c * ev.m; pp += ev.c * ev.pan; bb += ev.c * ev.b; rr += ev.c * ev.r; dd += ev.c * ev.d;
      }
      var B = 1 - prod, A = 0;
      while (firstAcc < accents.length && t - accents[firstAcc].t > 0.5) firstAcc++;
      for (k = firstAcc; k < accents.length && accents[k].t <= t; k++) {
        var ta = t - accents[k].t, kern = ta < 0.006 ? ta / 0.006 : Math.exp(-(ta - 0.006) / 0.045);
        A = Math.max(A, accents[k].a * kern);
      }
      var raw = Math.min(1, 0.84 * B + 0.16 * A);
      Ls += (raw > Ls ? atk : rel) * (raw - Ls);
      L[i] = Ls;
      if (i % 2) continue;
      var j = i >> 1;
      if (sumC >= 0.001) {
        hold.sigma = sig / sumC; hold.m = mm / sumC; hold.pan = pp / sumC; hold.b = bb / sumC; hold.r = rr / sumC; hold.d = dd / sumC;
      }
      // the grain jitters: a new value in 0.88..1.12 every 40 ms, linear in between, fixed by the time
      var jt = t / 0.04, j0 = Math.floor(jt), jf = jt - j0;
      var jit = (0.88 + 0.24 * unit(j0 ^ jseed)) * (1 - jf) + (0.88 + 0.24 * unit((j0 + 1) ^ jseed)) * jf;
      fc[j] = clamp((1900 + 1500 * hold.sigma) * hold.m, 1200, 5200);
      q[j] = clamp(1.5 - 0.4 * hold.sigma, 1.1, 1.5);
      lp[j] = clamp((3000 + 2600 * hold.sigma + 900 * A) * hold.b, 2400, 6800);
      amRate[j] = clamp((14 + 20 * hold.sigma) * jit * hold.r, 12, 46);
      amDepth[j] = clamp((0.22 + 0.2 * hold.sigma) * hold.d, 0.1, 0.42);
      panS += panA * (clamp(hold.pan, -0.25, 0.25) - panS);
      pan[j] = panS;
      band[j] = hold.m;
    }
    return { rate: PRESSURE_RATE, paramRate: PARAM_RATE, t0: t0, n: N, L: L, fc: fc, q: q, lp: lp, amRate: amRate, amDepth: amDepth,
      pan: pan, band: band, accents: accents, activity: mergeSpans(spans, 0), window: [t0, to], strokes: summary, seed: seedBase, surface: surface };
  }

  /* plan.typing(spec, { seed }): the rhythm of a typed line. The visual shows character n
     at startAfter + n * 1000 / cps ms. Keys fall on word starts first, then on some spaces,
     then on letters, never closer than TAP_GAP, and an end tap lands 110 ms after the last
     character. Times are seconds from the typewriter's t = 0. */
  var PUNCT = /[.,;:!?]/;
  function tapKind(ch) { return /\s/.test(ch) ? 'space' : (PUNCT.test(ch) ? 'punctuation' : 'letter'); }
  var TAP_PRIORITY = { space: 3, initial: 2, letter: 1, punctuation: 0 };
  function pickEvenly(items, count, prefer) {
    // `count` of `items` spread evenly, each slot taking the nearest unused item, preferred ones first
    var out = [], used = {};
    for (var j = 0; j < count; j++) {
      var target = (j + 0.5) * items.length / count, best = -1, score = Infinity;
      for (var i = 0; i < items.length; i++) {
        if (used[i]) continue;
        var sc = Math.abs(i - target) - (prefer(items[i]) ? 0.6 : 0);
        if (sc < score) { score = sc; best = i; }
      }
      if (best < 0) break;
      used[best] = 1; out.push(items[best]);
    }
    return out;
  }
  function planTyping(spec, o) {
    o = o || {};
    spec = spec || {};
    var seedBase = String(o.seed != null ? o.seed : 'sketchy');
    var text = String(spec.text == null ? '' : spec.text), N = text.length;
    var cps = +spec.charsPerSecond > 0 ? +spec.charsPerSecond : 38, startAfter = +spec.startAfter || 0;
    var end = spec.end == null ? 'settle' : spec.end, vary = spec.vary !== false;
    var dt = 1000 / cps, t1 = (startAfter + dt) / 1000, tN = (startAfter + N * dt) / 1000, S = tN - t1;
    var tapBase = seedBase + '|type|' + text + '|' + startAfter + '|' + cps + '|';
    var out = { taps: [], t1: t1, tN: tN, span: S, end: end === 'return' || end === 'settle' ? end : 'none', budget: 0, rate: 0 };
    if (!N) return out;
    var words = [], spaces = [], i, w = null;
    for (i = 0; i < N; i++) {
      if (/\s/.test(text.charAt(i))) { spaces.push(i); w = null; }
      else if (w) w.l++;
      else { w = { f: i, l: 1 }; words.push(w); }
    }
    var rate = clamp(9 + (cps - 28) * 5 / 42, 9, 14);
    var K = clamp(Math.round(S * rate), Math.min(N, 3), N);
    out.budget = K; out.rate = rate;
    var chosen;
    if (words.length <= K) chosen = words.slice();
    else if (K <= 2) chosen = K === 2 ? [words[0], words[words.length - 1]] : [words[0]];
    else chosen = [words[0]].concat(pickEvenly(words.slice(1, -1), K - 2, function (x) { return x.l >= 3; })).concat([words[words.length - 1]]);
    chosen.sort(function (a, b) { return a.f - b.f; });
    var nW = chosen.length;
    // a text of spaces only has no word to take the budget, so its spaces get all of it
    var nS = Math.max(0, Math.min(spaces.length, nW ? Math.floor(0.4 * K) : K, K - nW));
    var wordAt = {};
    for (i = 0; i < words.length; i++) wordAt[words[i].f] = words[i];
    var spaceTaps = nS ? pickEvenly(spaces, nS, function (idx) { var nw = wordAt[idx + 1]; return !!(nw && nw.l >= 4); }) : [];
    // the remaining taps go to words by largest remainder, in proportion to their length
    var rest = Math.max(0, K - nW - nS), extra = [], weight = 0, given = 0, rem = [];
    for (i = 0; i < nW; i++) { extra.push(0); weight += Math.max(0, chosen[i].l - 1); }
    if (rest && weight) {
      for (i = 0; i < nW; i++) {
        var share = rest * Math.max(0, chosen[i].l - 1) / weight, fl = Math.floor(share);
        extra[i] = Math.min(fl, chosen[i].l - 1); given += extra[i]; rem.push({ i: i, r: share - fl });
      }
      rem.sort(function (a, b) { return b.r - a.r || a.i - b.i; });
      for (i = 0; i < rem.length && given < rest; i++) {
        var wi = rem[i].i;
        if (extra[wi] < chosen[wi].l - 1) { extra[wi]++; given++; }
      }
    }
    // every draw of a tap comes from its own seed, so the same text types the same way every time
    var draws = {};
    function draw(idx) {
      if (draws[idx]) return draws[idx];
      // the level varies downward only (0 to -1.5 dB), so the nominal tap is the loudest one and the margin holds
      var r = mulberry(hash(tapBase + idx)), d = { lvl: -r() * 1.5, f1: (r() - 0.5) * 2, f2: (r() - 0.5) * 2, jit: r() * 0.008, off: r() };
      if (!vary) d = { lvl: 0, f1: 0, f2: 0, jit: 0, off: 0.5 };
      draws[idx] = d;
      return d;
    }
    function tOf(idx) { return (startAfter + (idx + 1) * dt) / 1000 + draw(idx).jit; }
    var priorityOf = function (idx, initial) {
      var kind = tapKind(text.charAt(idx));
      if (initial && words.length && idx === words[0].f) return TAP_PRIORITY.space + 1;   // the line always starts with its first key
      return kind === 'space' ? TAP_PRIORITY.space : (kind === 'punctuation' ? TAP_PRIORITY.punctuation : (initial ? TAP_PRIORITY.initial : TAP_PRIORITY.letter));
    };
    var cands = [], spaceSet = {};
    for (i = 0; i < spaceTaps.length; i++) { spaceSet[spaceTaps[i]] = 1; cands.push({ idx: spaceTaps[i], initial: false }); }
    for (i = 0; i < nW; i++) {
      var wd = chosen[i], kj = 1 + extra[i];
      for (var m = 0; m < kj; m++) {
        var idx = wd.f + (kj === 1 ? 0 : Math.round(m * (wd.l - 1) / (kj - 1)));
        if (m === 0 && spaceSet[wd.f - 1]) {
          // the space bar sounds right before this word, so its first key moves along the word
          // to the first character far enough after it; a word too short for that keeps quiet
          var far = -1;
          for (var ci = wd.f; ci < wd.f + wd.l; ci++) { if (tOf(ci) - tOf(wd.f - 1) >= TAP_GAP) { far = ci; break; } }
          if (far < 0) continue;
          idx = far;
        }
        cands.push({ idx: idx, initial: m === 0 });
      }
    }
    for (i = 0; i < cands.length; i++) { cands[i].t = tOf(cands[i].idx); cands[i].priority = priorityOf(cands[i].idx, cands[i].initial); }
    cands.sort(function (a, b) { return a.t - b.t || a.idx - b.idx; });
    // the minimum gap: the lower priority of two close taps goes
    var kept = [], taken = {};
    for (i = 0; i < cands.length; i++) {
      var cand = cands[i];
      if (taken[cand.idx]) continue;
      while (kept.length && cand.t - kept[kept.length - 1].t < TAP_GAP && cand.priority > kept[kept.length - 1].priority) delete taken[kept.pop().idx];
      if (kept.length && cand.t - kept[kept.length - 1].t < TAP_GAP) continue;
      kept.push(cand); taken[cand.idx] = 1;
    }
    // a tap the gap pass lost comes back on the character nearest the middle of the widest gap
    for (;;) {
      if (kept.length >= K) break;
      var best = null, width = 0;
      for (i = 0; i <= kept.length; i++) {
        var lo = i === 0 ? t1 - TAP_GAP : kept[i - 1].t, hi = i === kept.length ? tN + TAP_GAP : kept[i].t;
        if (hi - lo <= width) continue;
        var mid = (lo + hi) / 2, pickIdx = -1, dist = Infinity;
        for (var ci2 = 0; ci2 < N; ci2++) {
          if (taken[ci2]) continue;
          var tc = tOf(ci2);
          if (tc - lo < TAP_GAP || hi - tc < TAP_GAP) continue;
          if (Math.abs(tc - mid) < dist) { dist = Math.abs(tc - mid); pickIdx = ci2; }
        }
        if (pickIdx >= 0) { width = hi - lo; best = { idx: pickIdx, at: i }; }
      }
      if (!best) break;
      var add = { idx: best.idx, t: tOf(best.idx), initial: !!wordAt[best.idx], priority: priorityOf(best.idx, !!wordAt[best.idx]) };
      kept.splice(best.at, 0, add); taken[best.idx] = 1;
    }
    // later letters of a word get a little quieter; the first one a little louder
    var rank = {}, taps = [];
    for (i = 0; i < kept.length; i++) {
      var kp = kept[i], ch = text.charAt(kp.idx), kind = tapKind(ch), d = draw(kp.idx), wj = null;
      for (var wi2 = 0; wi2 < words.length; wi2++) { if (kp.idx >= words[wi2].f && kp.idx < words[wi2].f + words[wi2].l) { wj = wi2; break; } }
      var mRank = 0;
      if (wj != null && kind !== 'space') { mRank = rank[wj] || 0; rank[wj] = mRank + 1; }
      var db = TAP_TRIM[kind] + d.lvl + (kp.initial ? 0.5 : 0) - 0.3 * mRank;
      taps.push({ t: kp.t, index: kp.idx, kind: kind, char: ch, initial: kp.initial, gain: fromDb(db),
        pan: kind === 'space' ? 0 : -0.08 + 0.16 * kp.idx / N, f1: d.f1, f2: d.f2, offset: d.off });
    }
    if (out.end !== 'none') {
      var re = mulberry(hash(tapBase + 'end')), elvl = vary ? -re() * 1.5 : 0, ef1 = vary ? (re() - 0.5) * 2 : 0, ef2 = vary ? (re() - 0.5) * 2 : 0, eoff = vary ? re() : 0.5;
      taps.push({ t: tN + 0.11, index: N, kind: out.end, char: '', initial: false, gain: fromDb(TAP_TRIM[out.end] + elvl), pan: 0, f1: ef1, f2: ef2, offset: eoff });
    }
    out.taps = taps;
    return out;
  }

  /* plan.air(spec, { seed }): the swell of paper air. sin^2 in, hold, cos^2 out, with the
     band of the noise rising from 800 to 1250 Hz and settling to 850. `in` is at least
     0.3 s and `out` at least 0.5 s, so the air never clicks. Arrays at PARAM_RATE from `from`. */
  function planAir(spec, o) {
    o = o || {};
    spec = spec || {};
    var tin = Math.max(0.3, +spec['in'] || 0), hold = Math.max(0, +spec.hold || 0), tout = Math.max(0.5, +spec.out || 0);
    var from = +spec.startAt || 0, to = from + tin + hold + tout;
    var N = Math.ceil((to - from) * PARAM_RATE) + 1;
    var env = new Float32Array(N), band = new Float32Array(N);
    for (var i = 0; i < N; i++) {
      var u = i / PARAM_RATE, e, f;
      if (u < tin) { var a = Math.sin(Math.PI / 2 * u / tin); e = a * a; f = 800 * Math.pow(1250 / 800, u / tin); }
      else if (u < tin + hold) { e = 1; f = 1250; }
      else { var b = Math.cos(Math.PI / 2 * Math.min(1, (u - tin - hold) / tout)); e = b * b; f = 1250 * Math.pow(850 / 1250, Math.min(1, (u - tin - hold) / tout)); }
      env[i] = e; band[i] = f;
    }
    env[N - 1] = 0;
    return { rate: PARAM_RATE, from: from, to: to, env: env, band: band, 'in': tin, hold: hold, out: tout,
      seed: hash(String(o.seed != null ? o.seed : 'sketchy') + '|air|' + (spec.surface || 'deck') + '|' + (spec.key == null ? '' : spec.key)) };
  }

  var texturePlan = { pen: planPen, typing: planTyping, air: planAir };

  /* ------------------------------------------------------------------ *
   * 3e. The texture rig: a second input into the effect bus.
   *     pen chain -------------------------------> lane PEN --\
   *     taps -> texture sink -> typing filter ---> lane TYP --+-> sum -> DUCK -> sfx.dry
   *     air chain -------------------------------> lane AIR --/
   *     Built on first use only, so a render without textures keeps its graph, and a
   *     silent texture adds exact zeros to the bus. No reverb or echo send: textures are
   *     dry like the cues. With probe 'envelope' every source is a constant 1 and the
   *     filters are left out, so the output is exactly the gain automation.
   * ------------------------------------------------------------------ */
  function buildTexture(R, o) {
    if (R.tex) return R.tex;
    o = o || {};
    var ctx = R.ctx;
    var T = {
      R: R, ctx: ctx, probe: o.probe === 'envelope',
      cal: { pen: o.cal && o.cal.pen != null ? +o.cal.pen : PEN_CAL, typing: o.cal && o.cal.typing != null ? +o.cal.typing : TYPE_CAL,
        air: o.cal && o.cal.air != null ? +o.cal.air : AIR_CAL },
      lanes: {}, chains: {}, sink: new Sink(ctx, TEX_POOL, false), noise: null, duckState: null, planGains: []
    };
    T.lanes.pen = ctx.createGain(); T.lanes.typing = ctx.createGain(); T.lanes.air = ctx.createGain();
    T.lanes.pen.gain.value = 0; T.lanes.typing.gain.value = 0; T.lanes.air.gain.value = 0;
    // typing taps: sink -> highpass 80 Hz -> lowpass 5.2 kHz -> lane
    if (T.probe) {
      T.typingProbe = ctx.createConstantSource(); T.typingProbe.offset.value = 1;
      T.typingProbe.connect(T.lanes.typing); T.typingProbe.start(0);
    } else {
      var hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 80; hp.Q.value = 0.5;
      var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200; lp.Q.value = 0.5;
      T.sink.dry.connect(hp); hp.connect(lp); lp.connect(T.lanes.typing);
      T.typingFilter = [hp, lp];
    }
    T.duck = ctx.createGain(); T.duck.gain.value = 1;
    sumTree(ctx, [T.lanes.pen, T.lanes.typing, T.lanes.air]).connect(T.duck);
    T.duck.connect(R.sfx.dry);
    T.noiseBuffer = function () { return T.noise || (T.noise = makeNoise(ctx, 4, PEN_NOISE_SEED)); };
    T.pinkBuffer = R.pinkBuffer;   // the music's pink noise, 6 s, seed AIR_NOISE_SEED
    R.tex = T;
    return T;
  }

  /* The pen voice, one chain per surface, kept while the surface is open:
     noise -> highpass 900 -> bandpass fc(t), q(t) -> grain AM (0.6 + sawtooth x depth)
     -> pressure L(t) * cal * trim -> lowpass lp(t) -> pan(t) -> lane. The source and the
     LFO start when a plan arrives and stop after IDLE_STOP of silence. */
  function penChain(T, surface) {
    var ch = T.chains[surface] || (T.chains[surface] = { pen: null, air: null });
    if (ch.pen) return ch.pen;
    var ctx = T.ctx;
    var P = { surface: surface, src: null, lfo: null, running: false, scheduledUntil: -1, plan: null, idleAt: -1, trim: 1, held: 0,
      release: [], closing: false };
    P.hp = ctx.createBiquadFilter(); P.hp.type = 'highpass'; P.hp.frequency.value = 900; P.hp.Q.value = 0.5;
    P.bp = ctx.createBiquadFilter(); P.bp.type = 'bandpass'; P.bp.frequency.value = 2600; P.bp.Q.value = 1.3;
    P.am = ctx.createGain(); P.am.gain.value = 0.6;
    P.ld = ctx.createGain(); P.ld.gain.value = 0.3;
    P.ld.connect(P.am.gain);
    P.pressure = ctx.createGain(); P.pressure.gain.value = 0;
    P.lp = ctx.createBiquadFilter(); P.lp.type = 'lowpass'; P.lp.frequency.value = 4000; P.lp.Q.value = 0.5;
    P.pan = !T.probe && ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (T.probe) P.pressure.connect(T.lanes.pen);
    else {
      P.hp.connect(P.bp); P.bp.connect(P.am); P.am.connect(P.pressure); P.pressure.connect(P.lp);
      if (P.pan) { P.lp.connect(P.pan); P.pan.connect(T.lanes.pen); } else P.lp.connect(T.lanes.pen);
    }
    ch.pen = P;
    return P;
  }
  function penStart(T, P, t, rnd) {
    if (P.running) return;
    var ctx = T.ctx;
    if (T.probe) {
      var k = ctx.createConstantSource(); k.offset.value = 1; k.connect(P.pressure); k.start(t); P.src = k;
    } else {
      var s = ctx.createBufferSource(); s.buffer = T.noiseBuffer(); s.loop = true;
      s.connect(P.hp); s.start(t, rnd() * 3.6); P.src = s;
      var lfo = ctx.createOscillator(); lfo.type = 'sawtooth'; lfo.frequency.value = 24;
      lfo.connect(P.ld); lfo.start(t); P.lfo = lfo;
    }
    P.running = true; P.idleAt = -1;
  }
  function penStop(P, t) {
    if (!P.running) return;
    try { P.src.stop(t); } catch (e) { /* stopped */ }
    if (P.lfo) { try { P.lfo.stop(t); } catch (e2) { /* stopped */ } }
    P.src = null; P.lfo = null; P.running = false; P.scheduledUntil = -1;
  }
  function disconnectAll(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      try { if (nodes[i]) nodes[i].disconnect(); } catch (e) { /* already gone */ }
    }
  }
  // takes a stopped pen chain apart; the next report builds a new one
  function penFree(P) { disconnectAll([P.hp, P.bp, P.am, P.ld, P.pressure, P.lp, P.pan]); }

  /* The air voice, one chain per surface:
     pink noise -> highpass 160 -> bandpass f(t) Q 0.6 -> lowpass 2600 -> breath AM
     (0.88 + sine 0.23 Hz x 0.12) -> swell env(t) * cal -> pan 0.1 sin(2 pi 0.07 t) -> lane */
  function airChain(T, surface) {
    var ch = T.chains[surface] || (T.chains[surface] = { pen: null, air: null });
    if (ch.air) return ch.air;
    var ctx = T.ctx;
    var A = { surface: surface, src: null, lfos: [], running: false, scheduledUntil: -1, plan: null, idleAt: -1, held: 0,
      fadeUntil: -1, closing: false };
    A.hp = ctx.createBiquadFilter(); A.hp.type = 'highpass'; A.hp.frequency.value = 160; A.hp.Q.value = 0.5;
    A.bp = ctx.createBiquadFilter(); A.bp.type = 'bandpass'; A.bp.frequency.value = 800; A.bp.Q.value = 0.6;
    A.lp = ctx.createBiquadFilter(); A.lp.type = 'lowpass'; A.lp.frequency.value = 2600; A.lp.Q.value = 0.5;
    A.am = ctx.createGain(); A.am.gain.value = 0.88;
    A.breath = ctx.createGain(); A.breath.gain.value = 0.12; A.breath.connect(A.am.gain);
    A.swell = ctx.createGain(); A.swell.gain.value = 0;
    A.pan = !T.probe && ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (T.probe) A.swell.connect(T.lanes.air);
    else {
      A.hp.connect(A.bp); A.bp.connect(A.lp); A.lp.connect(A.am); A.am.connect(A.swell);
      if (A.pan) {
        A.panDepth = ctx.createGain(); A.panDepth.gain.value = 0.1; A.panDepth.connect(A.pan.pan);
        A.swell.connect(A.pan); A.pan.connect(T.lanes.air);
      } else A.swell.connect(T.lanes.air);
    }
    ch.air = A;
    return A;
  }
  function airStart(T, A, t, rnd) {
    if (A.running) return;
    var ctx = T.ctx;
    if (T.probe) {
      var k = ctx.createConstantSource(); k.offset.value = 1; k.connect(A.swell); k.start(t); A.src = k;
    } else {
      var s = ctx.createBufferSource(); s.buffer = T.pinkBuffer(); s.loop = true;
      s.connect(A.hp); s.start(t, rnd() * 5); A.src = s;
      var b = ctx.createOscillator(); b.type = 'sine'; b.frequency.value = 0.23; b.connect(A.breath); b.start(t);
      A.lfos = [b];
      if (A.panDepth) { var p = ctx.createOscillator(); p.type = 'sine'; p.frequency.value = 0.07; p.connect(A.panDepth); p.start(t); A.lfos.push(p); }
    }
    A.running = true; A.idleAt = -1;
  }
  function airStop(A, t) {
    if (!A.running) return;
    try { A.src.stop(t); } catch (e) { /* stopped */ }
    for (var i = 0; i < A.lfos.length; i++) { try { A.lfos[i].stop(t); } catch (e2) { /* stopped */ } }
    A.src = null; A.lfos = []; A.running = false; A.scheduledUntil = -1;
  }
  // takes a stopped air chain apart; the next report builds a new one
  function airFree(A) { disconnectAll([A.hp, A.bp, A.lp, A.am, A.breath, A.swell, A.pan, A.panDepth]); }

  /* Key taps: one-shots through the texture sink. Every layer is an envelope like the
     cues': transient [band Hz, Q, decay, peak], bottom [lowpass Hz, offset, decay, peak],
     body [sine Hz, glide ratio, glide s, decay, peak] and for the space bar a rattle
     [band Hz, Q, offset, decay, peak]. Peaks are relative to the letter transient. */
  var TAP_RECIPES = {
    letter:      { tr: [2600, 1.6, 0.009, 1], bot: [1100, 0.003, 0.014, 0.5], body: [185, 0.82, 0.018, 0.03, 0.35] },
    space:       { tr: [1700, 1.0, 0.013, 1], bot: [800, 0.003, 0.022, 0.6], body: [118, 0.85, 0.03, 0.058, 0.45], rattle: [950, 2.2, 0.009, 0.026, 0.18] },
    punctuation: { tr: [3000, 1.8, 0.007, 1], bot: [1300, 0.003, 0.010, 0.4], body: [210, 1, 0.018, 0.02, 0.3] },
    'return':    { tr: [1500, 1.0, 0.015, 1], bot: [700, 0.003, 0.026, 0.65], body: [100, 0.8, 0.04, 0.075, 0.5] },
    settle:      { tr: [1700, 1.0, 0.013, 1], bot: [800, 0.003, 0.022, 0.6], body: [118, 0.85, 0.03, 0.058, 0.45] }
  };
  var TAP_SPAN = 0.14;   // the longest tap (return) is silent after this
  /* Renders one tap at t. Every layer gets its own gain into a sink slot, so a plan can
     be faded without a shared node of many inputs; those gains are collected in `gains`. */
  function tapVoice(T, tap, t, gains, k) {
    var c = T.ctx, rec = TAP_RECIPES[tap.kind] || TAP_RECIPES.letter, n = 0;
    var rnd = function () { n++; return (tap.offset + n * 0.37) % 1; };
    var E = { R: T.R, sink: T.sink, rnd: rnd };
    var out = {
      take: function (tt, until) {
        var slot = T.sink.take(tt, until);
        if (!slot) return null;
        var pg = c.createGain(); pg.gain.value = 1; pg.connect(slot);
        gains.push({ g: pg, until: until });
        return pg;
      }
    };
    var ftr = rec.tr[0] * (1 + 0.08 * tap.f1), fbody = rec.body[0] * (1 + 0.12 * tap.f2), buf = T.noiseBuffer();
    hit(E, { t: t, type: 'bandpass', freq: ftr, q: rec.tr[1], dur: rec.tr[2], atk: 0.0006, peak: k * rec.tr[3], buf: buf, pan: tap.pan, out: out });
    hit(E, { t: t + rec.bot[1], type: 'lowpass', freq: rec.bot[0], q: 0.7, dur: rec.bot[2], atk: 0.001, peak: k * rec.bot[3], buf: buf, pan: tap.pan, out: out });
    tone(E, { t: t, f0: fbody, f1: fbody * rec.body[1], glide: rec.body[2], dur: rec.body[3], atk: 0.0012, peak: k * rec.body[4], lp: 900, pan: tap.pan, out: out });
    if (rec.rattle) hit(E, { t: t + rec.rattle[2], type: 'bandpass', freq: rec.rattle[0], q: rec.rattle[1], dur: rec.rattle[3], atk: 0.001, peak: k * rec.rattle[4], buf: buf, pan: tap.pan, out: out });
  }

  /* Ducking: one gain for all textures. A cue the limiter admitted pulls it down 9 dB
     (15 dB for the outcomes) with a 15 ms ramp that starts 5 ms before the cue, holds it to
     the cue's longest span and lets it back with a 65 ms (80 ms) time constant. Overlapping
     cues take the deeper depth and the later end. duckAt follows the same automation. */
  var DUCK_DEEP = { 'sketch-done': 1, 'error-soft': 1, celebrate: 1 };
  function duckAt(T, t) {
    var D = T.duckState;
    if (!D || t < D.at) return 1;
    if (t < D.attackEnd) return D.v0 + (D.depth - D.v0) * (t - D.at) / (D.attackEnd - D.at);
    if (t < D.until) return D.depth;
    return 1 + (D.depth - 1) * Math.exp(-(t - D.until) / D.tau);
  }
  function texDuck(R, name, t) {
    var T = R.tex, span = CUE_SPAN[name];
    if (!T || !span) return;
    var deep = !!DUCK_DEEP[name], depth = fromDb(deep ? -15 : -9), tau = deep ? 0.08 : 0.065, until = t + span[1];
    var t0 = t - 0.005, v0 = duckAt(T, t0), D = T.duckState;
    if (D && t0 < D.until) { depth = Math.min(depth, D.depth); until = Math.max(until, D.until); tau = Math.max(tau, D.tau); }
    var g = T.duck.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(v0, t0);
    g.linearRampToValueAtTime(depth, t + 0.010);
    g.setValueAtTime(depth, until);
    g.setTargetAtTime(1, until, tau);
    T.duckState = { at: t0, v0: v0, attackEnd: t + 0.010, depth: depth, until: until, tau: tau };
  }

  /* ------------------------------------------------------------------ *
   * 3f. The conductor: which lane sounds, when it hands over, how it stops.
   *     Surfaces: room, sidebar, wizard (a host app) and deck; only the surface that
   *     reported last plays. Lanes: pen, typing, air, each idle -> scheduled -> active
   *     -> fading -> idle. Priority typing > pen > air: the lane gains are curves of
   *     time computed from every plan, and every ramp between lanes is a declared
   *     transition. Live, a 25 ms tick emits the next 120 ms of automation; offline,
   *     the same emit runs once over the whole render. No gain ever jumps: a replan
   *     continues from the old plan's value at tc, a stop holds and ramps.
   * ------------------------------------------------------------------ */
  var FADE_POLICY = {
    step:    { pen: 0.16, typing: 0.12, air: 0.3 },
    replay:  { pen: 0.16, typing: 0.12, air: 0.3 },
    close:   { pen: 0.25, typing: 0.12, air: 0.4 },
    mute:    { pen: 0.12, typing: 0.12, air: 0.12 },
    hidden:  { pen: 0.12, typing: 0.12, air: 0.12 },
    reduced: { pen: 0.2,  typing: 0.2,  air: 0.2 },
    surface: { pen: 0.16, typing: 0.12, air: 0.3 }
  };
  var LANE_FADE = { pen: 0.2, typing: 0.12, air: 0.25 };   // a lane ramp that is not in a plan's own curve
  var LANE_NAMES = ['pen', 'typing', 'air'];

  // cancel the automation of a param from t on and hold the value the model has there
  function holdAt(param, t, v) {
    if (param.cancelAndHoldAtTime) { try { param.cancelAndHoldAtTime(t); } catch (e) { param.cancelScheduledValues(t); } }
    else param.cancelScheduledValues(t);
    param.setValueAtTime(v, t);
  }
  function curveAt(pts, t) {
    if (!pts.length) return 0;
    if (t <= pts[0][0]) return pts[0][1];
    for (var i = 1; i < pts.length; i++) {
      if (t <= pts[i][0]) {
        var a = pts[i - 1], b = pts[i];
        return b[0] === a[0] ? b[1] : a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
      }
    }
    return pts[pts.length - 1][1];
  }
  function raisedCos(u) { var s = Math.sin(Math.PI / 2 * clamp(u, 0, 1)); return s * s; }
  // an equal-power ramp from `from` to `to` over [a, b], one point every 10 ms
  function rampPoints(a, b, from, to, into) {
    var n = Math.max(2, Math.round((b - a) / 0.01));
    for (var i = 0; i <= n; i++) { var u = i / n; into.push([a + (b - a) * u, from + (to - from) * raisedCos(u)]); }
    return into;
  }
  function arrAt(arr, t0, rate, t) {
    if (!arr.length) return 0;
    var x = (t - t0) * rate, i = Math.floor(x);
    if (i < 0) return arr[0];
    if (i >= arr.length - 1) return arr[arr.length - 1];
    return arr[i] + (arr[i + 1] - arr[i]) * (x - i);
  }

  function Conductor(R, o) {
    o = o || {};
    this.R = R; this.ctx = R.ctx; this.offline = !!R.offline;
    this.seed = String(o.seed != null ? o.seed : 'sketchy');
    this.rnd = mulberry(hash(this.seed + '|texture'));
    this.cal = o.cal || null; this.probe = o.probe || null;
    this.solo = o.solo || null;           // a stem pass: only this lane's gain follows its curve
    this.musicOn = o.music || function () { return false; };
    this.clock = o.clock || null;         // offline: the time of the event being processed
    this.T = null;
    this.surface = null; this.surfaces = {};
    this.plans = []; this.nextId = 1; this.ids = [];
    this.lanes = {};
    for (var i = 0; i < LANE_NAMES.length; i++) this.lanes[LANE_NAMES[i]] = { name: LANE_NAMES[i], curve: [], fadeUntil: -1, until: -1 };
    this.transitions = [];
    this.lastTap = -Infinity;
    this.refused = false; this.muted = false; this.hidden = false;
    this.timer = 0;
  }
  Conductor.prototype.now = function () { return this.clock ? this.clock() : this.ctx.currentTime; };
  Conductor.prototype.rig = function () {
    if (!this.T) {
      this.T = buildTexture(this.R, { probe: this.probe, cal: this.cal });
      for (var i = 0; i < LANE_NAMES.length; i++) this.lanes[LANE_NAMES[i]].gain = this.T.lanes[LANE_NAMES[i]];
    }
    return this.T;
  };
  /* Host timelines carry `since`, the page's performance clock at their t = 0, in ms. The output
     timestamp maps it onto the context clock; without one the report counts as now. A timestamp
     of zeros (Chromium hands one out before the first output block) counts as none, because it
     would put `since` minutes away.
     Offline, `since` is in render seconds and defaults to the time of the report. */
  Conductor.prototype.hostTime = function (since) {
    if (since == null) return this.now();
    if (this.offline) return +since;
    var ts = null;
    try { ts = this.ctx.getOutputTimestamp ? this.ctx.getOutputTimestamp() : null; } catch (e) { ts = null; }
    if (ts && ts.performanceTime != null && ts.contextTime != null && ts.performanceTime > 0 && ts.contextTime > 0) {
      return ts.contextTime + (+since - ts.performanceTime) / 1000;
    }
    return this.now();
  };
  Conductor.prototype.surf = function (name) {
    return this.surfaces[name] || (this.surfaces[name] = { name: name, strokes: [], order: 0, penPlan: null, airPlan: null, key: '' });
  };
  Conductor.prototype.laneAt = function (name, t) { return curveAt(this.lanes[name].curve, t); };

  /* ---- lane gains from the plans (6.2) ---- */
  Conductor.prototype.laneCurves = function (tc) {
    var i, typ = [], act = [], trans = [], plans = this.plans;
    var S = this.surface ? this.surf(this.surface) : null;
    for (i = 0; i < plans.length; i++) {
      var p = plans[i];
      if (p.cancelled || p.surface !== this.surface) continue;
      if (p.lane === 'typing') { typ.push([p.t1, p.tEnd]); act.push([p.t1 - 0.02, p.tEnd + 0.25]); }
    }
    if (S && S.penPlan) for (i = 0; i < S.penPlan.activity.length; i++) act.push(S.penPlan.activity[i]);
    typ.sort(function (a, b) { return a[0] - b[0]; });
    var win = [];
    for (i = 0; i < typ.length; i++) {
      var last = win[win.length - 1];
      if (last && typ[i][0] - 0.2 <= last[1] + 0.4) last[1] = Math.max(last[1], typ[i][1]);
      else win.push([typ[i][0], typ[i][1]]);
    }
    var pen = [], typing = [], air = [];
    for (i = 0; i < win.length; i++) {
      var t1 = win[i][0], tEnd = win[i][1];
      rampPoints(t1 - 0.2, t1, 1, 0, pen); pen.push([tEnd + 0.15, 0]); rampPoints(tEnd + 0.15, tEnd + 0.4, 0, 1, pen);
      typing.push([t1 - 0.04, 0], [t1 - 0.02, 1], [tEnd + 0.25, 1], [tEnd + 0.37, 0]);
      trans.push({ t: t1 - 0.2, from: 'pen', to: 'typing', length: 0.2 }, { t: tEnd + 0.15, from: 'typing', to: 'pen', length: 0.25 });
    }
    if (!pen.length) pen.push([tc, 1]);
    if (!typing.length) typing.push([tc, 0]);
    if (this.musicOn()) air.push([tc, 0]);
    else {
      var spans = mergeSpans(act, 0.8);
      for (i = 0; i < spans.length; i++) {
        var a = spans[i][0], b = spans[i][1];
        rampPoints(a - 0.25, a, 1, 0, air); air.push([b, 0]); rampPoints(b, b + 0.25, 0, 1, air);
        trans.push({ t: a - 0.25, from: 'air', to: 'pen', length: 0.25 }, { t: b, from: 'pen', to: 'air', length: 0.25 });
      }
      if (!air.length) air.push([tc, 1]);
    }
    return { pen: pen, typing: typing, air: air, transitions: trans };
  };
  /* emit a lane's new curve from tc: hold the value there, ramp to the curve if it sits elsewhere, then
     follow it. A stop still under way finishes first: a lane never rises again before its fade has
     reached silence. */
  Conductor.prototype.setLane = function (name, tc, curve, fade) {
    var lane = this.lanes[name], v0 = this.laneAt(name, tc), pts = [[tc, v0]], i;
    var at = tc, v = v0;
    if (lane.fadeUntil > tc) { at = lane.fadeUntil; v = 0; pts.push([at, 0]); }
    var target = curveAt(curve, at), start = at;
    if (Math.abs(target - v) > 1e-4) {
      var f = Math.max(fade || LANE_FADE[name], MIN_RAMP);
      start = at + f;
      pts.push([start, curveAt(curve, start)]);
      this.transitions.push({ t: at, from: name, to: 'lane', length: f });
    }
    for (i = 0; i < curve.length; i++) if (curve[i][0] > start) pts.push(curve[i]);
    lane.curve = pts; lane.fadeUntil = at > tc ? at : -1;
    lane.until = pts[pts.length - 1][0];
    if (!lane.gain || (this.solo && this.solo !== name)) return;
    var g = lane.gain.gain;
    holdAt(g, tc, v0);
    for (i = 1; i < pts.length; i++) g.linearRampToValueAtTime(pts[i][1], pts[i][0]);
  };
  Conductor.prototype.replanLanes = function (tc) {
    var c = this.laneCurves(tc);
    this.transitions = this.transitions.filter(function (x) { return (x.to === 'silence' || x.to === 'lane') && x.t + x.length > tc - 2; });
    for (var i = 0; i < c.transitions.length; i++) this.transitions.push(c.transitions[i]);
    this.setLane('pen', tc, c.pen); this.setLane('typing', tc, c.typing); this.setLane('air', tc, c.air);
  };
  // a stop: hold the lane where it is and ramp to silence. A lane already silent has no fade to wait for.
  Conductor.prototype.fadeLane = function (name, tc, len) {
    var lane = this.lanes[name], v0 = this.laneAt(name, tc);
    lane.curve = [[tc, v0], [tc + len, 0]]; lane.fadeUntil = v0 > 0 ? tc + len : -1; lane.until = tc + len;
    if (v0 > 0) this.transitions.push({ t: tc, from: name, to: 'silence', length: len });
    if (!lane.gain || (this.solo && this.solo !== name)) return;
    holdAt(lane.gain.gain, tc, v0);
    lane.gain.gain.linearRampToValueAtTime(0, tc + len);
  };

  /* ---- pen ---- */
  Conductor.prototype.penScale = function (surface) { return this.rig().cal.pen * fromDb(SURFACE_TRIM[surface] || 0); };
  // the pressure gain the model has at t: the plan's L, or the let-go of a voice that was stopped
  Conductor.prototype.penPressureAt = function (P, t) {
    if (P.plan) return arrAt(P.plan.L, P.plan.t0, P.plan.rate, t) * this.penScale(P.surface);
    return curveAt(P.release, t);
  };
  Conductor.prototype.replanPen = function (surface, tc, blend) {
    var S = this.surf(surface), T = this.rig(), P = penChain(T, surface), old = S.penPlan, g = this.penScale(surface), i;
    S.strokes = S.strokes.filter(function (s) { return s.start + s.duration + 0.5 > tc; });
    if (S.strokes.length > MAX_STROKES) { S.strokes.sort(function (a, b) { return a.start - b.start; }); S.strokes = S.strokes.slice(S.strokes.length - MAX_STROKES); }
    var init = old ? { L: arrAt(old.L, old.t0, old.rate, tc), pan: arrAt(old.pan, old.t0, old.paramRate, tc),
      sigma: (arrAt(old.fc, old.t0, old.paramRate, tc) / Math.max(1e-6, arrAt(old.band, old.t0, old.paramRate, tc)) - 1900) / 1500,
      m: arrAt(old.band, old.t0, old.paramRate, tc) } : null;
    // without a plan the voice may still be letting go after a stop: the new plan continues from there
    var held = old ? 0 : curveAt(P.release, tc);
    var plan = planPen({ strokes: S.strokes, surface: surface, key: S.key }, { seed: this.seed, from: tc, init: init });
    if (plan.n && blend > 0 && (old || held > 0)) {
      var nb = Math.max(1, Math.round((old ? blend : Math.max(blend, 0.08)) * plan.rate));
      for (i = 0; i <= nb && i < plan.n; i++) {
        var u = i / nb, t = tc + i / plan.rate;
        plan.L[i] = (old ? arrAt(old.L, old.t0, old.rate, t) : curveAt(P.release, t) / g) * (1 - u) + plan.L[i] * u;
        if (old && i % 2 === 0) {
          var j = i >> 1;
          plan.fc[j] = arrAt(old.fc, old.t0, old.paramRate, t) * (1 - u) + plan.fc[j] * u;
          plan.q[j] = arrAt(old.q, old.t0, old.paramRate, t) * (1 - u) + plan.q[j] * u;
          plan.lp[j] = arrAt(old.lp, old.t0, old.paramRate, t) * (1 - u) + plan.lp[j] * u;
          plan.amRate[j] = arrAt(old.amRate, old.t0, old.paramRate, t) * (1 - u) + plan.amRate[j] * u;
          plan.amDepth[j] = arrAt(old.amDepth, old.t0, old.paramRate, t) * (1 - u) + plan.amDepth[j] * u;
          plan.pan[j] = arrAt(old.pan, old.t0, old.paramRate, t) * (1 - u) + plan.pan[j] * u;
        }
      }
    }
    S.penPlan = plan; P.plan = plan; P.scheduledUntil = 0; P.idleAt = -1; P.release = []; P.closing = false;
    if (!plan.n) {
      // nothing left to draw: hold where the voice is and let it go
      var cur = init ? init.L * g : held, f = Math.max(blend || 0, 0.08);
      P.plan = null; S.penPlan = null; P.scheduledUntil = -1;
      holdAt(P.pressure.gain, tc, cur);
      P.release = [[tc, cur], [tc + f, 0]];
      if (cur > 0) { P.pressure.gain.linearRampToValueAtTime(0, tc + f); this.transitions.push({ t: tc, from: 'pen', to: 'silence', length: f }); }
      P.idleAt = tc + f;
      return;
    }
    penStart(T, P, Math.max(this.now() + 0.005, tc - 0.05), this.rnd);
    this.penHold(P, tc, plan.L[0] * g, plan);
  };
  // hold every pen param at tc (the start of a replan or of a stop)
  Conductor.prototype.penHold = function (P, tc, pressure, plan) {
    holdAt(P.pressure.gain, tc, pressure);
    if (!plan) return;
    holdAt(P.bp.frequency, tc, plan.fc[0]); holdAt(P.bp.Q, tc, plan.q[0]); holdAt(P.lp.frequency, tc, plan.lp[0]);
    holdAt(P.ld.gain, tc, plan.amDepth[0]);
    if (P.lfo) holdAt(P.lfo.frequency, tc, plan.amRate[0]);
    if (P.pan) holdAt(P.pan.pan, tc, plan.pan[0]);
  };
  Conductor.prototype.emitPen = function (P, until) {
    var plan = P.plan;
    if (!plan || !plan.n || P.scheduledUntil >= plan.n - 1) return;
    var g = this.penScale(P.surface), iEnd = Math.min(plan.n - 1, Math.floor((until - plan.t0) * plan.rate));
    for (var i = P.scheduledUntil + 1; i <= iEnd; i++) {
      var t = plan.t0 + i / plan.rate;
      P.pressure.gain.linearRampToValueAtTime(plan.L[i] * g, t);
      if (i % 2) continue;
      var j = i >> 1;
      P.bp.frequency.linearRampToValueAtTime(plan.fc[j], t); P.bp.Q.linearRampToValueAtTime(plan.q[j], t);
      P.lp.frequency.linearRampToValueAtTime(plan.lp[j], t); P.ld.gain.linearRampToValueAtTime(plan.amDepth[j], t);
      if (P.lfo) P.lfo.frequency.linearRampToValueAtTime(plan.amRate[j], t);
      if (P.pan) P.pan.pan.linearRampToValueAtTime(plan.pan[j], t);
    }
    if (iEnd > P.scheduledUntil) P.scheduledUntil = iEnd;
    if (P.scheduledUntil >= plan.n - 1) P.idleAt = plan.window[1];
  };
  Conductor.prototype.pen = function (timeline) {
    timeline = timeline || {};
    if (this.refused || this.muted || this.hidden) return 0;
    var surface = timeline.surface || 'deck', now = this.now(), tc = now + LEAD;
    if (this.surface && this.surface !== surface) this.stopAll(FADE_POLICY.surface.pen * 1000, 'surface');
    this.surface = surface;
    var S = this.surf(surface), since = this.hostTime(timeline.since), list = timeline.strokes || [], added = [], i;
    var levelDb = LEVEL_TRIM[timeline.level] || 0, key = timeline.key != null ? String(timeline.key) : '';
    for (i = 0; i < list.length; i++) {
      var s = list[i], start = since + (+s.start || 0), D = Math.max(0.05, +s.duration || 0.66);
      var shape = SHAPES.hasOwnProperty(s.shape) ? s.shape : 'line';
      if (!SHAPES[shape]) continue;                                    // dot, text: silent
      if (start < tc && start + D - tc < 0.12) continue;               // too little of it is left
      added.push({ start: start, duration: D, shape: shape, easing: s.easing, marks: s.marks, x0: s.x0, x1: s.x1, phi: s.phi,
        key: key, levelDb: levelDb, order: S.order++ });
    }
    if (!added.length) return 0;
    S.key = key;
    for (i = 0; i < added.length; i++) S.strokes.push(added[i]);
    var from = Infinity, to = -Infinity;
    for (i = 0; i < added.length; i++) { from = Math.min(from, added[i].start); to = Math.max(to, added[i].start + added[i].duration + 0.35); }
    var plan = { id: this.nextId++, lane: 'pen', surface: surface, from: from, to: to, orders: added.map(function (a) { return a.order; }) };
    this.plans.push(plan); this.ids.push(plan.id);
    this.replanPen(surface, tc, MIN_RAMP);
    this.replanLanes(tc);
    this.arm();
    return plan.id;
  };

  /* ---- typing ---- */
  Conductor.prototype.typing = function (spec) {
    spec = spec || {};
    if (this.refused || this.muted || this.hidden) return 0;
    var surface = spec.surface || 'deck', now = this.now(), tc = now + LEAD;
    if (this.surface && this.surface !== surface) this.stopAll(FADE_POLICY.surface.pen * 1000, 'surface');
    this.surface = surface;
    var since = this.hostTime(spec.since), p = planTyping(spec, { seed: this.seed }), taps = [], i;
    for (i = 0; i < p.taps.length; i++) {
      var t = since + p.taps[i].t;
      if (t < now + 0.005) continue;                                  // a tap in the past is dropped
      if (t - this.lastTap < TAP_GAP) continue;                       // never on top of another plan's tap
      var tap = {}; for (var k in p.taps[i]) tap[k] = p.taps[i][k];
      tap.t = t; taps.push(tap); this.lastTap = t;
    }
    if (!taps.length) return 0;
    // at most two plans alive: a restarted line fades the old one while the new one starts
    var alive = this.plans.filter(function (x) { return x.lane === 'typing' && !x.cancelled; });
    while (alive.length >= 2) this.cancelTyping(alive.shift(), tc, 0.12);
    var tEnd = taps[taps.length - 1].t;
    var plan = { id: this.nextId++, lane: 'typing', surface: surface, from: since + p.t1 - 0.04, to: tEnd + 0.37, t1: since + p.t1, tEnd: tEnd,
      taps: taps, next: 0, gains: [], end: p.end };
    this.plans.push(plan); this.ids.push(plan.id);
    // the plan a restart dropped took its future taps off the record; this one's are on it now
    this.lastTap = this.lastTapPlanned();
    this.rig();
    this.replanLanes(tc);
    this.arm();
    return plan.id;
  };
  Conductor.prototype.emitTyping = function (plan, until) {
    var T = this.rig(), now = this.now();
    while (plan.next < plan.taps.length && plan.taps[plan.next].t <= until) {
      var tap = plan.taps[plan.next++];
      if (tap.t < now - 0.001) continue;
      if (!T.probe) tapVoice(T, tap, tap.t, plan.gains, T.cal.typing * tap.gain);
    }
  };
  Conductor.prototype.cancelTyping = function (plan, tc, fade) {
    if (plan.cancelled) return;
    plan.cancelled = true; plan.to = tc + fade;
    // the taps still ahead are dropped; the ones already rendered that the fade has not silenced stay on record for the gap rule
    var f = Math.max(fade, MIN_RAMP);
    plan.taps = plan.taps.slice(0, plan.next).filter(function (tap) { return tap.t <= tc + f; });
    for (var i = 0; i < plan.gains.length; i++) {
      var g = plan.gains[i].g.gain;
      holdAt(g, tc, g.value); g.linearRampToValueAtTime(0, tc + f);
    }
    this.lastTap = this.lastTapPlanned();
  };
  // the latest tap of every plan still on record, so a line restarted before the old one ends taps at once
  Conductor.prototype.lastTapPlanned = function () {
    var last = -Infinity;
    for (var i = 0; i < this.plans.length; i++) {
      var p = this.plans[i];
      if (p.lane === 'typing' && p.taps.length) last = Math.max(last, p.taps[p.taps.length - 1].t);
    }
    return last;
  };

  /* ---- air ---- */
  Conductor.prototype.air = function (spec) {
    spec = spec || {};
    if (this.refused || this.muted || this.hidden) return 0;
    var surface = spec.surface || 'deck', now = this.now(), tc = now + LEAD;
    if (this.surface && this.surface !== surface) this.stopAll(FADE_POLICY.surface.pen * 1000, 'surface');
    this.surface = surface;
    var T = this.rig(), A = airChain(T, surface), S = this.surf(surface), since = this.hostTime(spec.since);
    var p = planAir({ 'in': spec['in'], hold: spec.hold, out: spec.out, startAt: since + (+spec.startAt || 0), surface: surface, key: spec.key }, { seed: this.seed });
    if (p.to <= tc) return 0;
    var start = Math.max(p.from, tc);
    // a new swell on a surface that still breathes: the old one fades over 300 ms
    if (S.airPlan && !S.airPlan.cancelled && S.airPlan.to > tc) this.cancelAir(S.airPlan, tc, 0.3);
    // a swell still letting go, that one or an earlier stop's, reaches silence before the new one begins
    start = Math.max(start, A.fadeUntil);
    var plan = { id: this.nextId++, lane: 'air', surface: surface, from: p.from, to: p.to, plan: p, start: start, next: -1 };
    this.plans.push(plan); this.ids.push(plan.id); S.airPlan = plan; A.plan = plan;
    airStart(T, A, Math.max(now + 0.005, start - 0.05), this.rnd);
    A.scheduledUntil = -1; A.idleAt = -1; A.closing = false;
    this.replanLanes(tc);
    this.arm();
    return plan.id;
  };
  Conductor.prototype.emitAir = function (A, until) {
    var plan = A.plan;
    if (!plan || plan.cancelled) return;
    var p = plan.plan, g = this.rig().cal.air, i0, iEnd = Math.min(p.env.length - 1, Math.floor((until - p.from) * p.rate));
    if (A.scheduledUntil < 0) {
      // the first point: hold at the start, which is the plan's own start or, entered late, a 300 ms ramp into it
      i0 = Math.max(0, Math.ceil((plan.start - p.from) * p.rate));
      if (i0 > iEnd) return;
      var t0 = p.from + i0 / p.rate;
      holdAt(A.swell.gain, plan.start, A.held);
      holdAt(A.bp.frequency, plan.start, p.band[i0]);
      if (i0 > 0 && p.env[i0] > 0) {
        var tIn = Math.min(t0 + 0.3, p.from + (p.env.length - 1) / p.rate);
        A.swell.gain.linearRampToValueAtTime(arrAt(p.env, p.from, p.rate, tIn) * g, tIn);
        i0 = Math.ceil((tIn - p.from) * p.rate);
        this.transitions.push({ t: plan.start, from: 'air', to: 'air', length: tIn - plan.start });
      }
      A.scheduledUntil = i0 - 1;
    }
    for (i0 = A.scheduledUntil + 1; i0 <= iEnd; i0++) {
      var t = p.from + i0 / p.rate;
      A.swell.gain.linearRampToValueAtTime(p.env[i0] * g, t);
      A.bp.frequency.linearRampToValueAtTime(p.band[i0], t);
    }
    if (iEnd > A.scheduledUntil) A.scheduledUntil = iEnd;
    if (A.scheduledUntil >= p.env.length - 1) { A.idleAt = p.to; A.held = 0; }
    else A.held = arrAt(p.env, p.from, p.rate, until) * g;
  };
  Conductor.prototype.cancelAir = function (plan, tc, fade) {
    if (plan.cancelled) return;
    var T = this.rig(), A = airChain(T, plan.surface), p = plan.plan, g = T.cal.air;
    var v0 = tc < plan.start ? 0 : arrAt(p.env, p.from, p.rate, tc) * g, f = Math.max(fade, 0.3);
    plan.cancelled = true; plan.to = tc + f;
    holdAt(A.swell.gain, tc, v0); A.swell.gain.linearRampToValueAtTime(0, tc + f);
    if (v0 > 0) this.transitions.push({ t: tc, from: 'air', to: 'silence', length: f });
    A.plan = null; A.held = 0;
    // a swell that had not begun leaves nothing to wait for
    A.fadeUntil = v0 > 0 ? tc + f : -1;
    A.idleAt = tc + f;
  };

  /* ---- stops ---- */
  // fades one plan; default 120 ms, at most 1 s, the air 2 s (a closing step lets its air go that slowly)
  Conductor.prototype.cancel = function (id, fadeMs) {
    var plan = null, i;
    for (i = 0; i < this.plans.length; i++) if (this.plans[i].id === id) plan = this.plans[i];
    if (!plan || plan.cancelled) return false;
    var tc = this.now() + STOP_LEAD, fade = clamp(fadeMs == null ? 120 : +fadeMs, 12, plan.lane === 'air' ? 2000 : 1000) / 1000;
    if (plan.lane === 'pen') {
      var S = this.surf(plan.surface), drop = {};
      for (i = 0; i < plan.orders.length; i++) drop[plan.orders[i]] = 1;
      S.strokes = S.strokes.filter(function (s) { return !drop[s.order]; });
      plan.cancelled = true; plan.to = tc + fade;
      this.replanPen(plan.surface, tc, fade);
    } else if (plan.lane === 'typing') this.cancelTyping(plan, tc, fade);
    else this.cancelAir(plan, tc, fade);
    this.replanLanes(tc);
    return true;
  };
  /* Every lane to silence by the policy of the reason; without one, `fadeMs` for the pen, at most 120 ms
     for typing, at least 300 ms for the air. With a `surface`, only when that surface is the one
     playing: a surface leaving the screen never fades another's textures. A second stop finds every
     voice on its way down and lets it go on from there, never from zero. */
  Conductor.prototype.stopAll = function (fadeMs, reason, surface) {
    if (surface && this.surface !== surface) return;
    var pol = FADE_POLICY[reason], ms = clamp(fadeMs == null ? 120 : +fadeMs, 80, 1000) / 1000;
    var len = pol || { pen: ms, typing: Math.min(ms, 0.12), air: Math.max(ms, 0.3) };
    var tc = this.now() + STOP_LEAD, name, i;
    for (name in this.surfaces) {
      var S = this.surfaces[name], ch = this.T && this.T.chains[name];
      S.strokes = []; S.penPlan = null;
      if (ch && ch.pen) {
        // the pressure lets go under the lane fade, from wherever the voice is at tc (a voice an earlier stop is
        // still letting go is found on its release curve, so a second stop never cuts it)
        var P = ch.pen, v = this.penPressureAt(P, tc);
        P.plan = null; P.scheduledUntil = -1;
        holdAt(P.pressure.gain, tc, v);
        P.pressure.gain.linearRampToValueAtTime(0, tc + len.pen);
        P.release = [[tc, v], [tc + len.pen, 0]];
        P.idleAt = tc + len.pen;
        if (reason === 'close') P.closing = true;
      }
      if (S.airPlan && !S.airPlan.cancelled) this.cancelAir(S.airPlan, tc, len.air);
      S.airPlan = null;
      if (ch && ch.air && reason === 'close') ch.air.closing = true;
    }
    for (i = 0; i < this.plans.length; i++) {
      var p = this.plans[i];
      if (p.cancelled) continue;
      if (p.lane === 'typing') this.cancelTyping(p, tc, len.typing);
      else { p.cancelled = true; p.to = Math.min(p.to, tc + (p.lane === 'pen' ? len.pen : len.air)); }
    }
    this.fadeLane('pen', tc, len.pen); this.fadeLane('typing', tc, len.typing); this.fadeLane('air', tc, len.air);
    this.transitions = this.transitions.filter(function (x) { return x.to === 'silence' || x.t + x.length > tc; });
    if (reason === 'reduced') this.refused = true;
    if (reason === 'mute') this.muted = true;
    if (reason === 'hidden') this.hidden = true;
    this.arm();
  };
  Conductor.prototype.musicChanged = function () {
    if (this.T) this.replanLanes(this.now() + LEAD);
  };
  /* After an unmute or a return to the tab nothing resumes; the next report plays. Each gate lifts on
     its own: coming back to the tab ('hidden') leaves a mute in place. */
  Conductor.prototype.resume = function (reason) {
    if (reason === 'hidden') this.hidden = false;
    else this.muted = false;
  };
  Conductor.prototype.reduced = function (on) { if (on) this.stopAll(200, 'reduced'); else this.refused = false; };

  /* ---- scheduling ---- */
  // emit everything that falls before `until`: the tick does this every 25 ms live, the offline render once
  Conductor.prototype.emit = function (until) {
    if (!this.T) return;
    var name, i;
    for (name in this.T.chains) {
      var ch = this.T.chains[name];
      if (ch.pen && ch.pen.plan) this.emitPen(ch.pen, until);
      if (ch.air && ch.air.plan) this.emitAir(ch.air, until);
    }
    for (i = 0; i < this.plans.length; i++) if (this.plans[i].lane === 'typing' && !this.plans[i].cancelled) this.emitTyping(this.plans[i], until);
  };
  Conductor.prototype.busy = function (now) {
    var i, name;
    for (i = 0; i < this.plans.length; i++) if (this.plans[i].to + 0.5 > now) return true;
    for (name in LANE_NAMES) if (this.lanes[LANE_NAMES[name]].until > now) return true;
    // a closed chain keeps the timer until it has been freed
    if (this.T) for (name in this.T.chains) { var ch = this.T.chains[name]; if ((ch.pen && (ch.pen.running || ch.pen.closing)) || (ch.air && (ch.air.running || ch.air.closing))) return true; }
    return false;
  };
  Conductor.prototype.tick = function () {
    var now = this.now(), T = this.T, name, i;
    this.emit(now + HORIZON);
    if (T) {
      for (name in T.chains) {
        var ch = T.chains[name];
        // a closed chain is freed one tick after it stopped, so its last block plays out at gain 0
        if (ch.pen && ch.pen.closing && !ch.pen.running) { penFree(ch.pen); ch.pen = null; }
        if (ch.air && ch.air.closing && !ch.air.running) { airFree(ch.air); ch.air = null; }
        if (ch.pen && ch.pen.running && ch.pen.idleAt >= 0 && now > ch.pen.idleAt + (ch.pen.closing ? CLOSE_STOP : IDLE_STOP)) penStop(ch.pen, now + 0.01);
        if (ch.air && ch.air.running && ch.air.idleAt >= 0 && now > ch.air.idleAt + (ch.air.closing ? CLOSE_STOP : IDLE_STOP)) airStop(ch.air, now + 0.01);
      }
      // free the per-tap gains of taps that have ended
      for (i = 0; i < this.plans.length; i++) {
        var p = this.plans[i];
        if (p.lane !== 'typing' || !p.gains.length) continue;
        p.gains = p.gains.filter(function (x) { if (x.until + 0.2 < now) { try { x.g.disconnect(); } catch (e) { /* gone */ } return false; } return true; });
      }
    }
    this.plans = this.plans.filter(function (p) { return p.to + 1 > now; });
    if (!this.busy(now)) { clearInterval(this.timer); this.timer = 0; }
  };
  Conductor.prototype.arm = function () {
    if (this.offline) { this.emit(Infinity); return; }
    if (this.timer) return;
    var self = this;
    this.tick();
    if (this.busy(this.now())) this.timer = setInterval(function () { if (self.ctx.state === 'running') self.tick(); }, TICK_MS);
  };

  /* ---- a query for tests and dev pages ---- */
  Conductor.prototype.state = function () {
    var now = this.now(), out = { surface: this.surface, lanes: {}, duck: { depth: this.T ? duckAt(this.T, now) : 1, until: this.T && this.T.duckState ? this.T.duckState.until : -1 },
      plans: [], transitions: this.transitions.slice(), pool: { used: 0, size: TEX_POOL } }, i;
    for (i = 0; i < LANE_NAMES.length; i++) {
      var name = LANE_NAMES[i], lane = this.lanes[name], g = this.laneAt(name, now), st = 'idle', from = Infinity, to = -Infinity, taps = 0, voices = 0;
      for (var k = 0; k < this.plans.length; k++) {
        var p = this.plans[k];
        if (p.lane !== name || p.cancelled) continue;
        from = Math.min(from, p.from); to = Math.max(to, p.to);
        if (name === 'typing') taps += p.taps.length;
      }
      if (lane.fadeUntil > now) st = 'fading';
      else if (from <= now && to > now) st = 'active';
      else if (from > now && from <= now + HORIZON) st = 'scheduled';
      if (this.T && this.surface && this.T.chains[this.surface]) {
        var ch = this.T.chains[this.surface];
        if (name === 'pen' && ch.pen && ch.pen.running) voices = 1;
        if (name === 'air' && ch.air && ch.air.running) voices = 1;
      }
      out.lanes[name] = { gain: g, state: st, until: lane.until, voices: voices };
      if (name === 'typing') out.lanes[name].taps = taps;
    }
    for (i = 0; i < this.plans.length; i++) out.plans.push({ id: this.plans[i].id, lane: this.plans[i].lane, from: this.plans[i].from, to: this.plans[i].to, cancelled: !!this.plans[i].cancelled });
    if (this.T) for (i = 0; i < this.T.sink.free.length; i++) if (this.T.sink.free[i] > now) out.pool.used++;
    return out;
  };

  /* ------------------------------------------------------------------ *
   * 4. Musical voices
   *    All take (E, sink, t, f, vel, dur, pan, peak) and play through a slot of
   *    the layer's sink. A voice that finds the pool full is skipped.
   * ------------------------------------------------------------------ */
  function voiceEnd(E, src, slot, made) {
    if (E.R.offline) return;
    src.onended = function () {
      try { made[0].disconnect(slot); } catch (err) { /* gone */ }
      for (var k = 0; k < made.length; k++) { try { made[k].disconnect(); } catch (err2) { /* gone */ } }
    };
  }
  // Join a voice's last node to its slot, through a panner when it has a pan.
  function toSlot(c, node, pan, slot, made) {
    var out = node;
    if (pan && c.createStereoPanner) {
      var p = c.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); node.connect(p); out = p; made.push(p);
    }
    out.connect(slot);
    made.unshift(out);
    return out;
  }
  function partials(E, sink, t, f, vel, dur, pan, peak, parts, atk) {
    var slot = sink.take(t, t + dur + 0.06);
    if (!slot) return;
    var c = E.R.ctx, cents = (E.rnd() - 0.5) * 10, first = null, gs = [], oscs = [], i;
    for (i = 0; i < parts.length; i++) {
      var fr = f * parts[i][0];
      if (fr > 11000) continue;
      var d = dur * parts[i][2];
      var o = c.createOscillator(); o.frequency.value = fr; o.detune.value = cents;
      var g = c.createGain(); envelope(g.gain, t, peak * vel * parts[i][1], atk, d);
      o.connect(g);
      o.start(t); o.stop(t + d + 0.03);
      gs.push(g); oscs.push(o);
      if (!first) first = o;
    }
    var mix = sumTree(c, gs), made = gs.slice();
    if (mix !== gs[0]) made.push(mix);
    toSlot(c, mix, pan, slot, made);
    voiceEnd(E, first, slot, made);
  }

  var INST = {};
  // tine-like: a clear fundamental with two fast-dying upper partials
  INST.musicbox = function (E, sink, t, f, vel, dur, pan, peak) {
    partials(E, sink, t, f, vel, dur, pan, peak, [[1, 1, 1], [3, 0.14, 0.32], [6.27, 0.06, 0.14]], 0.003);
  };
  INST.celesta = function (E, sink, t, f, vel, dur, pan, peak) {
    partials(E, sink, t, f, vel, dur, pan, peak, [[1, 1, 1], [2, 0.18, 0.5], [4, 0.1, 0.25], [5.4, 0.035, 0.12]], 0.004);
  };
  INST.pluck = function (E, sink, t, f, vel, dur, pan, peak) {
    var slot = sink.take(t, t + dur + 0.06);
    if (!slot) return;
    var c = E.R.ctx;
    var o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
    var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(f * 4.5, t); lp.frequency.exponentialRampToValueAtTime(f * 1.3, t + 0.25);
    var g = c.createGain(); envelope(g.gain, t, peak * vel, 0.004, dur);
    o.connect(lp); lp.connect(g);
    var made = [lp, g];
    toSlot(c, g, pan, slot, made);
    o.start(t); o.stop(t + dur + 0.03);
    voiceEnd(E, o, slot, made);
  };
  INST.bell = function (E, sink, t, f, vel, dur, pan, peak, ratio) {
    bellVoice(E, { t: t, f: f, peak: peak * vel, decay: dur, ratio: ratio || 2, depth: ratio > 3 ? 1.1 : 1.6, pan: pan, out: sink });
  };

  function bassNote(E, sink, t, f, vel, dur, wave, peak) {
    var end = t + dur, slot = sink.take(t, end + 0.6);
    if (!slot) return;
    var c = E.R.ctx;
    var o1 = c.createOscillator(); o1.type = 'sine'; o1.frequency.value = f;
    var o2 = c.createOscillator(); o2.type = wave; o2.frequency.value = f;
    var g2 = c.createGain(); g2.gain.value = wave === 'sine' ? 0 : 0.4;
    var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1;
    lp.frequency.setValueAtTime(Math.min(f * 7, 900), t); lp.frequency.exponentialRampToValueAtTime(Math.max(f * 2.4, 140), t + 0.12);
    var g = c.createGain(), pk = peak * vel;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(pk, t + 0.012);
    g.gain.setValueAtTime(pk, end); g.gain.setTargetAtTime(0, end, 0.06);
    o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(g); g.connect(slot);
    o1.start(t); o2.start(t); o1.stop(end + 0.5); o2.stop(end + 0.5);
    voiceEnd(E, o1, slot, [g, lp, g2]);
  }

  /* ------------------------------------------------------------------ *
   * 4b. The piece
   * ------------------------------------------------------------------ */
  var LAYERS = ['pad', 'drone', 'wind', 'arp', 'lead', 'bass', 'hat', 'kick'];
  // voices that can sound at once on each layer; a note beyond that is skipped
  var SINK_SIZE = { pad: 8, arp: 10, lead: 8, bass: 3, hat: 4, kick: 3 };
  // fixed [reverb send, echo send] per layer
  var SENDS = { pad: [0.55, 0], drone: [0.25, 0], wind: [0.2, 0], arp: [0.3, 0], lead: [0.6, 0.25], bass: [0, 0], hat: [0.12, 0], kick: [0.02, 0] };
  var LEAD_TEMPLATES = [[[0, 8]], [[0, 6], [8, 4], [12, 4]], [[4, 4], [8, 8]], [[0, 4], [4, 4], [8, 8]], [[0, 12], [12, 4]], [[6, 2], [8, 8]], []];
  var LEAD_WEIGHTS = [3, 2, 2, 2, 2, 1, 2];

  function isChordTone(deg, c) {
    var k = (((deg - c) % 7) + 7) % 7;
    return k === 0 || k === 2 || k === 4;
  }
  // the nearest chord tone to deg inside [lo, hi], never the pitch `avoid`
  function snap(r, deg, c, lo, hi, avoid) {
    for (var off = 0; off <= 4; off++) {
      var a = deg - off, b = deg + off;
      var okA = a >= lo && a <= hi && a !== avoid && isChordTone(a, c);
      var okB = b >= lo && b <= hi && b !== avoid && isChordTone(b, c);
      if (okA && okB && off > 0) return r() < 0.5 ? a : b;
      if (okA) return a;
      if (okB) return b;
    }
    return clamp(deg, lo, hi);
  }
  // a constrained random walk: steps preferred, leaps rare, drift pulled back to the middle
  function walk(r, cur, prev, lo, hi) {
    var D = [-3, -2, -1, 0, 1, 2, 3], W = [0.04, 0.15, 0.30, 0.03, 0.30, 0.15, 0.04];
    var mid = (lo + hi) / 2, span = Math.max(1, hi - lo), tot = 0, ws = [], i;
    for (i = 0; i < 7; i++) {
      var d = D[i], n = cur + d, w = W[i];
      if (n < lo || n > hi) w = 0;
      else {
        if (d !== 0 && prev !== 0 && (d > 0) === (prev > 0)) w *= 1.3;
        if (Math.abs(prev) >= 3 && d !== 0 && (d > 0) !== (prev > 0)) w *= 2.2;
        w *= Math.max(0.3, 1 + 2 * (Math.abs(cur - mid) - Math.abs(n - mid)) / span);
      }
      ws.push(w); tot += w;
    }
    if (tot <= 0) return clamp(cur, lo, hi);
    var x = r() * tot;
    for (i = 0; i < 7; i++) { x -= ws[i]; if (x <= 0) return cur + D[i]; }
    return cur;
  }

  function Music(R, o) {
    var c = R.ctx, M, i, k;
    this.R = R; this.c = c;
    var H = header(o.seed, o.mood, o);
    this.mood = H.mood; M = this.M = MOODS[H.mood];
    this.seed = String(o.seed);
    this.tonic = H.tonic; this.scale = H.scale; this.bpm = H.bpm; this.keyName = H.keyName; this.mode = H.mode;
    this.stepDur = 60 / this.bpm / 4; this.barDur = this.stepDur * 16;
    var base = this.seed + '|' + this.mood;
    this.rp = mulberry(hash(base + '|piece'));   // phrases: chords, notes
    this.rv = mulberry(hash(base + '|voice'));   // voices: detune, pan, noise offsets
    var rm = mulberry(hash(base + '|mod'));      // slow modulation periods and phases
    this.ph1 = rm(); this.ph2 = rm();
    this.E = { R: R, sink: null, rnd: this.rv };

    var t0 = this.t0 = o.t0;
    this.stepNo = 0; this.phrase = null; this.phraseIdx = 0; this.lastPhrase = null; this.lastDeg = 0;
    this.arpCur = null; this.leadCur = null;
    this.sections = []; this.sectionName = null;
    this.on = {}; this.secDens = 1; this.dens = 0.7; this.thr = 0.7; this.pump = 0;
    this.nextWind = t0;
    this.persist = []; this.pads = [];
    this.stopped = false;

    // everything the piece makes passes through three fade gains, so start, stop and
    // the final fade of a render are one ramp
    this.fade = [c.createGain(), c.createGain(), c.createGain()];
    this.fade[0].connect(R.music.dry); this.fade[1].connect(R.music.wet); this.fade[2].connect(R.music.echo);
    var fadeIn = o.fadeIn == null ? 4 : o.fadeIn;
    for (i = 0; i < 3; i++) {
      this.fade[i].gain.setValueAtTime(0, t0);
      this.fade[i].gain.linearRampToValueAtTime(1, t0 + Math.max(0.05, fadeIn));
    }

    // One bus per layer. Note layers play through a Sink (a pool of slots) into their
    // bus; the buses meet in sumTrees on the way to the fade gains.
    this.bus = {}; this.sink = {};
    var dryIns = [], wetIns = [];
    for (i = 0; i < LAYERS.length; i++) {
      k = LAYERS[i];
      var g = c.createGain(); g.gain.setValueAtTime(0, t0);
      dryIns.push(g);
      if (SENDS[k][0] > 0) { var w = c.createGain(); w.gain.value = SENDS[k][0]; g.connect(w); wetIns.push(w); }
      if (SENDS[k][1] > 0) { var e = c.createGain(); e.gain.value = SENDS[k][1]; g.connect(e); e.connect(this.fade[2]); }
      this.bus[k] = g;
      if (SINK_SIZE[k]) {
        this.sink[k] = new Sink(c, SINK_SIZE[k], false);
        if (k !== 'pad') this.sink[k].dry.connect(g);
      }
    }
    this.pump = 0;

    // pad chain: voices -> lowpass (drifting) -> ducking gain -> bus
    this.padLP = c.createBiquadFilter(); this.padLP.type = 'lowpass'; this.padLP.Q.value = 0.6;
    this.padLP.frequency.setValueAtTime(M.padCut * 0.7, t0);
    this.padPump = c.createGain(); this.padPump.gain.setValueAtTime(1, t0);
    this.sink.pad.dry.connect(this.padLP);
    this.padLP.connect(this.padPump); this.padPump.connect(this.bus.pad);
    var drift = c.createOscillator(); drift.type = 'sine'; drift.frequency.value = 1 / (24 + rm() * 21);
    var driftDepth = c.createGain(); driftDepth.gain.value = M.padCut * 0.22;
    drift.connect(driftDepth); driftDepth.connect(this.padLP.frequency);
    drift.start(t0); this.persist.push(drift);

    // drone: a sine an octave under the tonic plus a quiet triangle on it, breathing slowly
    var droneG = c.createGain(); droneG.gain.value = 0.8;
    var dparts = [[this.tonic, 'sine', 1], [this.tonic - 12, 'sine', 0.3], [this.tonic + 12, 'triangle', 0.25]], dgs = [];
    for (i = 0; i < dparts.length; i++) {
      var dosc = c.createOscillator(); dosc.type = dparts[i][1]; dosc.frequency.value = midiHz(dparts[i][0]);
      var dg = c.createGain(); dg.gain.value = dparts[i][2];
      dosc.connect(dg); dosc.start(t0); dgs.push(dg); this.persist.push(dosc);
    }
    sumTree(c, dgs).connect(droneG); droneG.connect(this.bus.drone);
    var breathe = c.createOscillator(); breathe.type = 'sine'; breathe.frequency.value = 1 / (10 + rm() * 6);
    var breatheDepth = c.createGain(); breatheDepth.gain.value = 0.2;
    breathe.connect(breatheDepth); breatheDepth.connect(droneG.gain);
    breathe.start(t0); this.persist.push(breathe);

    // wind: slow pink noise whose band wanders
    var ws = c.createBufferSource(); ws.buffer = R.pinkBuffer(); ws.loop = true;
    this.windBP = c.createBiquadFilter(); this.windBP.type = 'bandpass'; this.windBP.Q.value = 0.9;
    this.windBP.frequency.setValueAtTime(450, t0);
    ws.connect(this.windBP); this.windBP.connect(this.bus.wind);
    ws.start(t0, 0); this.persist.push(ws);

    // ping-pong echo for the arpeggio: one dotted eighth (three steps) per hop, six hops,
    // each quieter, alternating left and right. Written as a chain, not a feedback loop.
    var ppIn = c.createGain(); ppIn.gain.value = 0.55;
    var ppLP = c.createBiquadFilter(); ppLP.type = 'lowpass'; ppLP.frequency.value = 2400; ppLP.Q.value = 0.5;
    ppIn.connect(ppLP);
    var tapsL = [], tapsR = [], prev = ppLP;
    for (i = 0; i < 6; i++) {
      var dl = c.createDelay(2); dl.delayTime.value = this.stepDur * 3;
      if (i > 0) { var hop = c.createGain(); hop.gain.value = M.fb; prev.connect(hop); prev = hop; }
      prev.connect(dl); prev = dl;
      (i % 2 ? tapsR : tapsL).push(dl);
    }
    var oL = sumTree(c, tapsL), oR = sumTree(c, tapsR);
    if (c.createStereoPanner) {
      var pL = c.createStereoPanner(); pL.pan.value = -0.65; oL.connect(pL); oL = pL;
      var pR = c.createStereoPanner(); pR.pan.value = 0.65; oR.connect(pR); oR = pR;
    }
    this.bus.arp.connect(ppIn);

    sumTree(c, dryIns.concat([oL, oR])).connect(this.fade[0]);
    sumTree(c, wetIns).connect(this.fade[1]);

    // sections, then the first one
    this.queue = [];
    this.queueSection(o.section || 'calm', t0);
  }

  Music.prototype.queueSection = function (name, t) {
    if (!SECTIONS[name]) return;
    this.queue.push({ t: t, name: name });
  };

  // Retarget layer gains with a slow exponential approach: no clicks, no jumps.
  Music.prototype.applySection = function (name, t) {
    var S = SECTIONS[name], M = this.M, L = M.level, k, i;
    this.sectionName = name;
    for (i = 0; i < LAYERS.length; i++) {
      k = LAYERS[i];
      var mult = S[k] == null ? 1 : S[k], target;
      if (k === 'bass') mult = Math.max(mult, M.bassFloor);
      target = (L[k] || 0) * mult * M.trim;
      this.bus[k].gain.setTargetAtTime(target, t, 0.8);
      this.on[k] = target > 0.01;
    }
    this.padLP.frequency.setTargetAtTime(M.padCut * S.cut, t, 2.5);
    this.pump = M.pump > 0 ? S.pump * M.pump : 0;
    this.secDens = S.dens;
  };

  Music.prototype.genPhrase = function (idx) {
    var rp = this.rp, M = this.M, S = this.scale, T = this.tonic, last = this.lastPhrase;
    var bars = pick(rp, M.phrase), bpc = Math.min(pick(rp, M.bpc), bars);
    var cadence = this.sectionName === 'resolve';
    var major = M.mode === 'ionian';
    var table = major ? MARKOV_MAJOR : MARKOV_MINOR, mask = MASKS[M.mode], endBias = major ? END_BIAS_MAJOR : END_BIAS_MINOR;
    var n = Math.max(1, Math.floor(bars / bpc)), degs = [], i, b, s;

    // chords: repeat the last progression sometimes, otherwise walk the Markov chain
    if (last && !cadence && last.bars === bars && last.bpc === bpc && rp() < M.repeat) {
      degs = last.degs.slice();
    } else {
      var prev = this.lastDeg;
      for (i = 0; i < n; i++) {
        var d;
        if (i === 0) d = (idx === 0 || rp() < 0.65) ? 0 : markov(rp, table, mask, prev, null);
        else d = markov(rp, table, mask, prev, i === n - 1 ? endBias : null);
        if (cadence && i === n - 1) d = 0;
        degs.push(d); prev = d;
      }
    }
    var barChord = function (bar) { return degs[Math.min(Math.floor(bar / bpc), n - 1)]; };
    var ph = { bars: bars, bpc: bpc, degs: degs, steps: new Array(bars * 16), chordAt: {}, motif: null };
    for (i = 0; i < n; i++) ph.chordAt[i * bpc] = { deg: degs[i], bars: i === n - 1 ? bars - i * bpc : bpc };
    var put = function (bar, step, layer, ev) {
      var at = bar * 16 + step, slot = ph.steps[at] || (ph.steps[at] = {});
      (slot[layer] || (slot[layer] = [])).push(ev);
    };

    // arpeggio line
    var A = M.arp, aLo = midiDeg(T, S, A.range[0]), aHi = midiDeg(T, S, A.range[1]);
    var cur = this.arpCur != null ? this.arpCur : Math.round((aLo + aHi) / 2 - 2), prevD = 0, prevPrev = null;
    var restBar = (bars >= 4 && rp() < M.rest) ? 1 + Math.floor(rp() * (bars - 1)) : -1;
    var carry = (last && last.motif && rp() < 0.55) ? last.motif : null;
    for (b = 0; b < bars; b++) {
      var c = barChord(b);
      var useMotif = b === 0 ? carry : (b >= 2 && ph.motif && rp() < 0.4 ? ph.motif : null);
      var list = [];
      for (s = 0; s < 16; s++) {
        if (s % A.sub === 0) list.push([s, 0]);
        else if (A.ghost > 0 && s % Math.max(1, A.sub / 2) === 0 && rp() < A.ghost) list.push([s, 1]);
      }
      var deltas = [], kk = 0, pd = null;
      for (var li = 0; li < list.length; li++) {
        s = list[li][0];
        var ghost = list[li][1], strong = (s & 7) === 0, beat = (s & 3) === 0, deg;
        // never a third identical note in a row, and a repeat of the last note only now and then
        var avoid = kk === 0 ? null : (kk >= 2 && pd === prevPrev ? pd : (rp() < 0.65 ? pd : null));
        if (kk === 0) deg = snap(rp, cur, c, aLo, aHi, null);
        else if (useMotif && useMotif[kk] != null) deg = clamp(pd + useMotif[kk], aLo, aHi);
        else deg = walk(rp, pd, prevD, aLo, aHi);
        if (strong) deg = snap(rp, deg, c, aLo, aHi, avoid);
        else if (beat && rp() < 0.55) deg = snap(rp, deg, c, aLo, aHi, avoid);
        if (avoid != null && deg === avoid && !strong) deg = clamp(deg + (rp() < 0.5 ? 1 : -1), aLo, aHi);
        deltas.push(kk === 0 ? 0 : deg - pd);
        var rank = strong ? rp() * 0.15 : beat ? 0.12 + rp() * 0.25 : ghost ? 0.72 + rp() * 0.27 : 0.28 + rp() * 0.45;
        if (b === restBar) rank += 2;
        if (b === bars - 1 && s >= 10) rank += 0.35;   // the phrase breathes out
        var vel = (strong ? 1 : beat ? 0.85 : ghost ? 0.5 : 0.68) * (0.92 + rp() * 0.16);
        put(b, s, 'arp', { deg: deg, vel: vel, rank: rank, jit: (rp() - 0.5) * 0.016, pan: (rp() - 0.5) * 0.5, strong: strong });
        prevD = deg - (pd == null ? deg : pd); prevPrev = pd; pd = deg; kk++;
      }
      cur = pd == null ? cur : pd;
      if (b === 0) ph.motif = deltas;
    }
    this.arpCur = cur;

    // lead: slower notes that land on chord tones, a long note to close the phrase
    var Ld = M.lead, lLo = midiDeg(T, S, Ld.range[0]), lHi = midiDeg(T, S, Ld.range[1]);
    var lc = this.leadCur != null ? this.leadCur : Math.round((lLo + lHi) / 2), lprev = 0;
    for (b = 0; b < bars; b++) {
      var cl = barChord(b), tpl = LEAD_TEMPLATES[weighted(rp, LEAD_WEIGHTS)];
      if (b === 0 && !tpl.length) tpl = LEAD_TEMPLATES[0];
      if (b === bars - 1) tpl = [[0, 12]];
      for (var ti = 0; ti < tpl.length; ti++) {
        var ls = tpl[ti][0], ld = walk(rp, lc, lprev, lLo, lHi);
        if (ti === 0 || b === bars - 1 || rp() < 0.6) ld = snap(rp, ld, cl, lLo, lHi);
        lprev = ld - lc; lc = ld;
        var lr = (ti === 0 ? rp() * 0.3 : 0.2 + rp() * 0.5) + (1 - Ld.p) * 0.4;
        put(b, ls, 'lead', { deg: ld, vel: 0.85 + rp() * 0.25, rank: lr, jit: (rp() - 0.5) * 0.02, pan: (rp() - 0.5) * 0.6 });
      }
    }
    this.leadCur = lc;

    // bass: one pattern per phrase, root on the downbeat, a fifth now and then
    var pat = pick(rp, M.bass.pats);
    for (b = 0; b < bars; b++) {
      var rootDeg = barChord(b);
      for (var bi = 0; bi < pat.length; bi++) {
        var bs = pat[bi], bd = (bs !== 0 && rp() < 0.4) ? rootDeg + 4 : rootDeg;
        var len = (bi + 1 < pat.length ? pat[bi + 1] : 16) - bs;
        put(b, bs, 'bass', { deg: bd, vel: 0.85 + rp() * 0.15, rank: bs === 0 ? rp() * 0.1 : 0.25 + rp() * 0.5, len: len });
      }
    }

    // percussion
    for (b = 0; b < bars; b++) {
      for (i = 0; i < M.hatSteps.length; i++) {
        s = M.hatSteps[i];
        put(b, s, 'hat', { vel: 0.6 + rp() * 0.4, rank: rp() * 0.3, open: s === 14 && rp() < 0.3, jit: (rp() - 0.5) * 0.012 });
      }
      if (M.hatGhost) for (s = 3; s < 16; s += 4) put(b, s, 'hat', { vel: 0.35, rank: 0.7 + rp() * 0.3, open: false, jit: (rp() - 0.5) * 0.012 });
      for (i = 0; i < M.kickSteps.length; i++) put(b, M.kickSteps[i], 'kick', { vel: 1, rank: M.kickSteps[i] === 0 ? 0 : 0.1 });
      if (M.kickSteps.length) {
        put(b, 4, 'kick', { vel: 0.7, rank: 0.55 + rp() * 0.4 });
        put(b, 12, 'kick', { vel: 0.7, rank: 0.55 + rp() * 0.4 });
        if (rp() < 0.3) put(b, 14, 'kick', { vel: 0.6, rank: 0.85 });
      }
    }
    return ph;
  };

  Music.prototype.padChord = function (t, chord) {
    var c = this.c, rv = this.rv, S = this.scale, base = this.tonic + 12, M = this.M;
    var dur = chord.bars * this.barDur, fade = Math.min(1.6, dur * 0.4), tEnd = t + dur;
    var root = chord.deg >= 4 ? chord.deg - 7 : chord.deg;
    var degs = [root, root + 4, root + 9], x = rv();
    if (x < 0.35) degs.push(root + 6); else if (x < 0.6) degs.push(root + 8);
    var pk = 0.2 / Math.sqrt(degs.length);
    for (var i = 0; i < degs.length; i++) {
      var f = midiHz(degMidi(base, S, degs[i])), u = 4 + rv() * 4;
      var slot = this.sink.pad.take(t, tEnd + fade + 0.06);
      if (!slot) continue;
      var g = c.createGain();
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(pk, t + fade);
      g.gain.setValueAtTime(pk, tEnd); g.gain.linearRampToValueAtTime(0, tEnd + fade);
      g.connect(slot);
      for (var j = 0; j < 2; j++) {
        var o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = j ? -u : u;
        o.connect(g); o.start(t); o.stop(tEnd + fade + 0.05);
        this.pads.push({ o: o, end: tEnd + fade + 0.05 });
        if (j === 1 && !this.R.offline) o.onended = (function (gg, ss) { return function () { try { gg.disconnect(ss); } catch (err) { /* gone */ } }; })(g, slot);
      }
    }
    // forget voices that have ended so the list stays short in a long session
    if (this.pads.length > 80) { var now = this.R.offline ? -1 : c.currentTime; this.pads = this.pads.filter(function (p) { return p.end > now; }); }
  };

  Music.prototype.barStart = function (t, bar, absBar) {
    var D = this.M.dens;
    var d = D.base + D.a1 * Math.sin(2 * Math.PI * (absBar / D.p1 + this.ph1)) + D.a2 * Math.sin(2 * Math.PI * (absBar / D.p2 + this.ph2));
    this.dens = clamp(d, 0.15, 1);
    var ch = this.phrase.chordAt[bar];
    if (ch) { this.padChord(Math.max(t, this.R.offline ? t : this.c.currentTime), ch); this.lastDeg = ch.deg; }
    if (t >= this.nextWind) {
      var len = 10 + this.rv() * 10;
      this.windBP.frequency.linearRampToValueAtTime(250 + this.rv() * 550, t + len);
      this.nextWind = t + len;
    }
  };

  Music.prototype.runStep = function (t) {
    var q = this.queue;
    while (q.length && q[0].t <= t) { var s0 = q.shift(); this.applySection(s0.name, Math.max(s0.t, this.t0)); }
    var sNo = this.stepNo;
    if (!this.phrase || sNo - this.phrase.step0 >= this.phrase.bars * 16) {
      this.phrase = this.genPhrase(this.phraseIdx++);
      this.phrase.step0 = sNo;
      this.lastPhrase = this.phrase;
    }
    var ph = this.phrase, local = sNo - ph.step0, bar = local >> 4, step = local & 15;
    var late = !this.R.offline && t < this.c.currentTime - 0.02;
    if (step === 0) this.barStart(t, bar, sNo >> 4);
    if (late) return;
    if ((step & 3) === 0 && this.pump > 0.01) {
      this.padPump.gain.setTargetAtTime(1 - this.pump, t, 0.006);
      this.padPump.gain.setTargetAtTime(1, t + 0.04, 0.11);
    }
    var ev = ph.steps[local];
    if (!ev) return;
    var thr = clamp(this.dens * this.secDens, 0, 1.2), M = this.M, E = this.E, S = this.scale, T = this.tonic, i, n, tt;
    if (ev.arp && this.on.arp) {
      for (i = 0; i < ev.arp.length; i++) {
        n = ev.arp[i];
        if (n.rank >= thr) continue;
        INST[M.arp.inst](E, this.sink.arp, Math.max(this.t0, t + n.jit), midiHz(degMidi(T, S, n.deg)), n.vel, M.arp.decay * (0.8 + 0.4 * n.vel), n.pan, M.arp.peak, M.arp.ratio);
      }
    }
    if (ev.lead && this.on.lead) {
      for (i = 0; i < ev.lead.length; i++) {
        n = ev.lead[i];
        if (n.rank >= thr) continue;
        INST[M.lead.inst](E, this.sink.lead, Math.max(this.t0, t + n.jit), midiHz(degMidi(T, S, n.deg)), n.vel, M.lead.decay, n.pan, M.lead.peak, M.lead.ratio);
      }
    }
    if (ev.bass && this.on.bass) {
      for (i = 0; i < ev.bass.length; i++) {
        n = ev.bass[i];
        if (n.rank >= thr) continue;
        var bm = foldInto(degMidi(T - 12, S, n.deg), 43, 57);
        var bd = M.bass.long ? n.len * this.stepDur * 0.92 : Math.min(n.len, 6) * this.stepDur * 0.9;
        bassNote(E, this.sink.bass, t, midiHz(bm), n.vel, bd, M.bass.wave, M.bass.peak);
      }
    }
    if (ev.hat && this.on.hat) {
      for (i = 0; i < ev.hat.length; i++) {
        n = ev.hat[i];
        if (n.rank >= thr) continue;
        hit(E, { t: Math.max(this.t0, t + n.jit), type: 'highpass', freq: 7200, q: 0.7, dur: n.open ? 0.16 : 0.035 + n.vel * 0.03, atk: 0.002,
          peak: 0.07 * n.vel, buf: this.R.noiseHat, out: this.sink.hat });
      }
    }
    if (ev.kick && this.on.kick) {
      for (i = 0; i < ev.kick.length; i++) {
        n = ev.kick[i];
        if (n.rank >= thr) continue;
        tone(E, { t: t, f0: 120, f1: 58, dur: 0.28, glide: 0.08, atk: 0.004, peak: 0.55 * n.vel, lp: 240, out: this.sink.kick });
      }
    }
  };

  // Schedule every step that starts before `until`. The time of step n is t0 + n * stepDur
  // (a product, not a running sum), so the schedule is the same however the calls are chunked.
  Music.prototype.schedule = function (until) {
    for (;;) {
      var t = this.t0 + this.stepNo * this.stepDur;
      if (t >= until) break;
      this.runStep(t);
      this.stepNo++;
    }
  };

  // ramp the whole piece to silence between t and t + len (used for the end of a render)
  Music.prototype.fadeOutAt = function (t, len) {
    for (var i = 0; i < 3; i++) {
      this.fade[i].gain.setValueAtTime(1, t);
      this.fade[i].gain.linearRampToValueAtTime(0, t + len);
    }
  };

  Music.prototype.info = function () {
    return { mood: this.mood, seed: this.seed, key: this.keyName, mode: this.mode, bpm: this.bpm, section: this.sectionName, tonic: this.tonic };
  };

  /* ------------------------------------------------------------------ *
   * 5. Offline rendering and WAV
   * ------------------------------------------------------------------ */
  function peakOf(buf) {
    var pk = 0;
    for (var ch = 0; ch < buf.numberOfChannels; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < d.length; i++) { var a = d[i] < 0 ? -d[i] : d[i]; if (a > pk) pk = a; }
    }
    return pk;
  }

  /* Offline reverb. A browser's ConvolverNode did not give the same samples twice for
     long renders (its late partitions are not deterministic), so an offline render
     convolves the reverb send itself, with an FFT in plain JavaScript, which does. It
     uses the same impulse response and the same normalization the ConvolverNode applies
     (unit RMS of the response, a fixed -58 dB calibration, scaled by sample rate), so
     the live and offline reverbs have the same level. Two real signals are transformed
     as one complex signal (left in the real part, right in the imaginary part). */
  function nextPow2(n) { var p = 1; while (p < n) p <<= 1; return p; }
  function makeTwiddles(n) {
    var h = n >> 1, c = new Float64Array(h), s = new Float64Array(h);
    for (var i = 0; i < h; i++) { var a = 2 * Math.PI * i / n; c[i] = Math.cos(a); s[i] = Math.sin(a); }
    return { cos: c, sin: s };
  }
  function fftInPlace(re, im, tw, inverse) {
    var n = re.length, i, j, k, m, t;
    for (i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var half = len >> 1, step = n / len;
      for (i = 0; i < n; i += len) {
        for (k = 0, m = 0; k < half; k++, m += step) {
          var wr = tw.cos[m], wi = inverse ? tw.sin[m] : -tw.sin[m];
          var x = i + k, y = x + half;
          var tr = re[y] * wr - im[y] * wi, ti = re[y] * wi + im[y] * wr;
          re[y] = re[x] - tr; im[y] = im[x] - ti; re[x] += tr; im[x] += ti;
        }
      }
    }
    if (inverse) for (i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
  function convolveReverb(xl, xr, sr) {
    var ir = impulseData(sr, REVERB_SECONDS, REVERB_SEED), irLen = ir[0].length, len = xl.length, i, k;
    var pw = 0;
    for (i = 0; i < irLen; i++) pw += ir[0][i] * ir[0][i] + ir[1][i] * ir[1][i];
    pw = Math.sqrt(pw / (2 * irLen));
    if (!isFinite(pw) || pw < 0.000125) pw = 0.000125;
    var scale = (1 / pw) * Math.pow(10, -58 / 20) * (44100 / sr);
    var N = nextPow2(irLen + 32768), B = N - irLen + 1, tw = makeTwiddles(N);
    var hlr = new Float64Array(N), hli = new Float64Array(N), hrr = new Float64Array(N), hri = new Float64Array(N);
    for (i = 0; i < irLen; i++) { hlr[i] = ir[0][i] * scale; hrr[i] = ir[1][i] * scale; }
    fftInPlace(hlr, hli, tw, false); fftInPlace(hrr, hri, tw, false);
    var accL = new Float64Array(len), accR = new Float64Array(len);
    var zr = new Float64Array(N), zi = new Float64Array(N), yr = new Float64Array(N), yi = new Float64Array(N);
    for (var s0 = 0; s0 < len; s0 += B) {
      var n = Math.min(B, len - s0), any = false;
      zr.fill(0); zi.fill(0);
      for (i = 0; i < n; i++) { zr[i] = xl[s0 + i]; zi[i] = xr[s0 + i]; if (zr[i] !== 0 || zi[i] !== 0) any = true; }
      if (!any) continue;
      fftInPlace(zr, zi, tw, false);
      for (k = 0; k < N; k++) {
        var kk = (N - k) & (N - 1);
        var ar = zr[k], ai = zi[k], br = zr[kk], bi = -zi[kk];
        var xlr = (ar + br) * 0.5, xli = (ai + bi) * 0.5, xrr = (ai - bi) * 0.5, xri = -(ar - br) * 0.5;
        var ylr = xlr * hlr[k] - xli * hli[k], yli = xlr * hli[k] + xli * hlr[k];
        var yrr = xrr * hrr[k] - xri * hri[k], yri = xrr * hri[k] + xri * hrr[k];
        yr[k] = ylr - yri; yi[k] = yli + yrr;
      }
      fftInPlace(yr, yi, tw, true);
      var lim = Math.min(N, len - s0);
      for (i = 0; i < lim; i++) { accL[s0 + i] += yr[i]; accR[s0 + i] += yi[i]; }
    }
    return [accL, accR];
  }

  function runOffline(ctx) {
    return new Promise(function (resolve, reject) {
      var p = ctx.startRendering();
      if (p && p.then) p.then(resolve, reject);
      else ctx.oncomplete = function (e) { resolve(e.renderedBuffer); };
    });
  }

  /* renderOnce({ duration, seed, mood, cues, sections, sampleRate, fadeIn, fadeOut, key, bpm, level })
     builds the graph on offline contexts, schedules the whole piece and the cues up
     front, and resolves with the rendered AudioBuffer. Three passes, all deterministic:
       1. the music, effects and echo go to channels 0 and 1, the reverb send to 2 and 3;
       2. the send is convolved with the impulse response in JavaScript and added;
       3. the sum runs through the master gain, high-pass, compressor and limiter. */
  function renderOnce(o) {
    var OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (!OAC) return Promise.reject(new Error('OfflineAudioContext is not available in this browser'));
    var sr = o.sampleRate || 48000, dur = Math.max(0.2, +o.duration || 10), len = Math.ceil(dur * sr);
    var seed = o.seed != null ? String(o.seed) : 'sketchy';
    var ctx = new OAC(4, len, sr);
    var R = buildMaster(ctx, { offline: true, seed: seed, split: true });

    var moodName = o.mood === undefined ? 'sketchbook' : o.mood;
    var m = null;
    if (moodName && moodName !== 'none' && MOODS[moodName]) {
      var fadeIn = o.fadeIn == null ? 1.5 : o.fadeIn, fadeOut = o.fadeOut == null ? 2 : o.fadeOut;
      var secs = (o.sections || []).slice().sort(function (a, b) { return a.t - b.t; });
      var first = secs.length && secs[0].t <= 0 ? secs.shift().name : 'calm';
      m = new Music(R, { seed: seed, mood: moodName, key: o.key, bpm: o.bpm, t0: 0, fadeIn: fadeIn, section: first });
      for (var i = 0; i < secs.length; i++) m.queueSection(secs[i].name, Math.max(0, +secs[i].t || 0));
      m.fadeOutAt(Math.max(fadeIn, dur - fadeOut), Math.min(fadeOut, dur));
      R.key = { tonic: m.tonic, scale: m.scale };
      m.schedule(dur);
    } else {
      var H = header(seed, 'sketchbook', o);
      R.key = { tonic: H.tonic, scale: H.scale };
    }
    var cues = (o.cues || []).slice().sort(function (a, b) { return a.t - b.t; });
    for (var k = 0; k < cues.length; k++) {
      if (cues[k].t >= 0 && cues[k].t < dur) trigger(R, cues[k].name, +cues[k].t, cues[k].opts);
    }
    var sp1 = ctx.createChannelSplitter(2), sp2 = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(4);
    R.premix.connect(sp1); R.revSend.connect(sp2);
    sp1.connect(mg, 0, 0); sp1.connect(mg, 1, 1); sp2.connect(mg, 0, 2); sp2.connect(mg, 1, 3);
    mg.connect(ctx.destination);

    return runOffline(ctx).then(function (stems) {
      var wet = convolveReverb(stems.getChannelData(2), stems.getChannelData(3), sr);
      var ctx3 = new OAC(2, len, sr);
      var mix = ctx3.createBuffer(2, len, sr), a = mix.getChannelData(0), b = mix.getChannelData(1);
      var d0 = stems.getChannelData(0), d1 = stems.getChannelData(1);
      for (var j = 0; j < len; j++) { a[j] = d0[j] + wet[0][j]; b[j] = d1[j] + wet[1][j]; }
      var src = ctx3.createBufferSource(); src.buffer = mix;
      var chain = masterChain(ctx3), level = MASTER * (o.level == null ? 1 : o.level);
      chain.master.gain.setValueAtTime(0, 0);
      chain.master.gain.linearRampToValueAtTime(level, 0.03);
      chain.master.gain.setValueAtTime(level, Math.max(0.04, dur - 0.1));
      chain.master.gain.linearRampToValueAtTime(0, dur);
      src.connect(chain.master); src.start(0);
      return runOffline(ctx3);
    }).then(function (buf) {
      // safety trim: only ever turns a loud render down, never up
      var pk = peakOf(buf);
      if (pk > CEILING) {
        var sc = CEILING / pk;
        for (var ch = 0; ch < buf.numberOfChannels; ch++) { var d = buf.getChannelData(ch); for (var j = 0; j < d.length; j++) d[j] *= sc; }
      }
      return buf;
    });
  }

  // A hash of the sample bits, for comparing two renders.
  function hashBuffer(buf) {
    var h = 2166136261 >>> 0;
    for (var c = 0; c < buf.numberOfChannels; c++) {
      var d = buf.getChannelData(c), u = new Uint32Array(d.buffer, d.byteOffset, d.length);
      for (var i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
    }
    return h.toString(16);
  }

  /* renderOffline(options) is renderOnce plus an optional self-check. With check: true
     the render runs twice and, if the two differ (a thread-timing difference in the
     browser, rare in testing), a third time, and the majority wins. */
  function renderOffline(o) {
    o = o || {};
    if (!o.check) return renderOnce(o);
    return renderOnce(o).then(function (a) {
      return renderOnce(o).then(function (b) {
        if (hashBuffer(a) === hashBuffer(b)) return a;
        return renderOnce(o).then(function (c) { return hashBuffer(c) === hashBuffer(a) ? a : c; });
      });
    });
  }

  /* renderCue(name, { seed, key, mood, sampleRate, duration, level, master, vary, gain, pan, pitch })
     renders one effect or cue on its own, without music: the effect bus scaled by
     `level` (default MASTER, the master gain; 1 is the bus itself). master: true also
     runs it through the live master chain (high-pass, compressor, limiter), which is
     what a listener hears. The key comes from `key`, else from the seed and mood. The
     length defaults to a cue's longest span plus 50 ms, or 3 s for other effects.
     vary: false plays the nominal recipe, with every random draw at the middle of its range.
     A sound without a pan is mono, and the speakers play it on both sides, so the bus
     is lifted to stereo the same way before it is split into channels. */
  function renderCue(name, o) {
    o = o || {};
    var OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (!OAC) return Promise.reject(new Error('OfflineAudioContext is not available in this browser'));
    if (!SFX[name]) return Promise.reject(new Error('unknown sound "' + name + '"'));
    var sr = o.sampleRate || 48000, span = CUE_SPAN[name];
    var len = Math.ceil(Math.max(0.05, +o.duration || (span ? span[1] + 0.05 : 3)) * sr);
    var seed = o.seed != null ? String(o.seed) : 'sketchy';
    var ctx = new OAC(4, len, sr);
    var R = buildMaster(ctx, { offline: true, seed: seed, split: true });
    if (o.vary === false) R.rand = R.sfxEnv.rnd = function () { return 0.5; };
    var H = header(seed, o.mood || 'sketchbook', o);
    R.key = { tonic: H.tonic, scale: H.scale };
    trigger(R, name, 0, o);
    var sp1 = ctx.createChannelSplitter(2), sp2 = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(4);
    var stereo = function (node) {
      var g = ctx.createGain();
      g.channelCount = 2; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers';
      node.connect(g);
      return g;
    };
    stereo(R.premix).connect(sp1); stereo(R.revSend).connect(sp2);
    sp1.connect(mg, 0, 0); sp1.connect(mg, 1, 1); sp2.connect(mg, 0, 2); sp2.connect(mg, 1, 3);
    mg.connect(ctx.destination);
    var level = o.level == null ? MASTER : +o.level, pad = Math.round(0.1 * sr);
    return runOffline(ctx).then(function (stems) {
      var d0 = stems.getChannelData(0), d1 = stems.getChannelData(1), w0 = stems.getChannelData(2), w1 = stems.getChannelData(3), j;
      var wet = null;
      for (j = 0; j < len; j++) { if (w0[j] !== 0 || w1[j] !== 0) { wet = convolveReverb(w0, w1, sr); break; } }
      var out = ctx.createBuffer(2, len, sr), a = out.getChannelData(0), b = out.getChannelData(1);
      for (j = 0; j < len; j++) {
        a[j] = (d0[j] + (wet ? wet[0][j] : 0)) * level;
        b[j] = (d1[j] + (wet ? wet[1][j] : 0)) * level;
      }
      if (!o.master) return out;
      // the master chain, started 100 ms early so its compressor has settled when the sound begins
      var ctx3 = new OAC(2, len + pad, sr), src = ctx3.createBufferSource(), chain = masterChain(ctx3);
      chain.master.gain.value = 1;
      src.buffer = out; src.connect(chain.master); src.start(pad / sr);
      return runOffline(ctx3).then(function (full) {
        var res = ctx.createBuffer(2, len, sr);
        res.copyToChannel(full.getChannelData(0).subarray(pad), 0);
        res.copyToChannel(full.getChannelData(1).subarray(pad), 1);
        return res;
      });
    });
  }

  /* texture.render(o): a deterministic offline render of textures with cues and, with a
     mood, the music. Like renderCue it builds the split master, lifts the bus to stereo as
     the speakers do, convolves the reverb send in JavaScript and, with master: true, runs the
     result through the live master chain. Reports and events are applied at their render
     times in order, through the same conductor and the same emit as the live path.
       o: { duration, seed, sampleRate, mood ('none' default), sections, key, bpm, level (MASTER),
            cues: [{ t, name, opts }], pen: [{ at, ...timeline }], typing: [{ at, ...spec }],
            air: [{ at, ...spec }], events: [{ t, type: 'stop'|'cancel'|'mute'|'hidden'|'reduced'|'surface',
            fadeMs, reason, id, surface }], master, probe: 'audio'|'envelope', cal }
     Resolves { mix, stems: { pen, typing, air, cues }, plan }: the stems are the same plans
     rendered with the other lanes' gains at 0 and the cues and music muted. */
  function renderTexturePass(o, solo) {
    var OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (!OAC) return Promise.reject(new Error('OfflineAudioContext is not available in this browser'));
    var sr = o.sampleRate || 48000, dur = Math.max(0.2, +o.duration || 5), len = Math.ceil(dur * sr);
    var seed = o.seed != null ? String(o.seed) : 'sketchy';
    var ctx = new OAC(4, len, sr);
    var R = buildMaster(ctx, { offline: true, seed: seed, split: true });
    var moodName = o.mood == null ? 'none' : o.mood, m = null, i;
    if (moodName && moodName !== 'none' && MOODS[moodName]) {
      var fadeIn = o.fadeIn == null ? 1.5 : o.fadeIn, fadeOut = o.fadeOut == null ? 2 : o.fadeOut;
      var secs = (o.sections || []).slice().sort(function (a, b) { return a.t - b.t; });
      var first = secs.length && secs[0].t <= 0 ? secs.shift().name : 'calm';
      m = new Music(R, { seed: seed, mood: moodName, key: o.key, bpm: o.bpm, t0: 0, fadeIn: fadeIn, section: first });
      for (i = 0; i < secs.length; i++) m.queueSection(secs[i].name, Math.max(0, +secs[i].t || 0));
      m.fadeOutAt(Math.max(fadeIn, dur - fadeOut), Math.min(fadeOut, dur));
      R.key = { tonic: m.tonic, scale: m.scale };
      m.schedule(dur);
    } else {
      var H = header(seed, 'sketchbook', o);
      R.key = { tonic: H.tonic, scale: H.scale };
    }
    // a stem: the lanes other than `solo` stay at 0, the cues and the music are muted
    var texSolo = null;
    if (solo) {
      texSolo = solo === 'cues' ? 'none' : solo;
      R.music.dry.gain.value = 0; R.music.wet.gain.value = 0; R.music.echo.gain.value = 0;
      if (solo !== 'cues') R.sfxSink.dry.gain.value = 0;
    }
    var cueTakes = 0, take = R.sfxSink.take;
    R.sfxSink.take = function () { cueTakes++; return take.apply(this, arguments); };
    var clock = { t: 0 };
    var C = new Conductor(R, { seed: seed, cal: o.cal || SketchySound.texture.cal, probe: o.probe, solo: texSolo,
      music: function () { return !!m; }, clock: function () { return clock.t; } });
    var ev = [], k;
    for (i = 0; i < (o.cues || []).length; i++) ev.push({ t: +o.cues[i].t, k: 0, cue: o.cues[i] });
    for (i = 0; i < (o.pen || []).length; i++) ev.push({ t: +o.pen[i].at || 0, k: 1, report: o.pen[i] });
    for (i = 0; i < (o.typing || []).length; i++) ev.push({ t: +o.typing[i].at || 0, k: 2, report: o.typing[i] });
    for (i = 0; i < (o.air || []).length; i++) ev.push({ t: +o.air[i].at || 0, k: 3, report: o.air[i] });
    for (i = 0; i < (o.events || []).length; i++) ev.push({ t: +o.events[i].t, k: 4, event: o.events[i] });
    ev.sort(function (a, b) { return a.t - b.t || a.k - b.k; });
    var plan = { ids: [], states: [], cues: [] };
    for (i = 0; i < ev.length; i++) {
      var e = ev[i];
      if (!(e.t >= 0 && e.t < dur)) continue;
      clock.t = e.t;
      if (e.cue) { plan.cues.push({ t: e.t, name: e.cue.name, admitted: trigger(R, e.cue.name, e.t, e.cue.opts) }); continue; }
      if (e.report) {
        var rep = {};
        for (k in e.report) if (k !== 'at') rep[k] = e.report[k];
        if (rep.since == null) rep.since = e.t;
        var id = e.k === 1 ? C.pen(rep) : (e.k === 2 ? C.typing(rep) : C.air(rep));
        plan.ids.push({ t: e.t, lane: e.k === 1 ? 'pen' : (e.k === 2 ? 'typing' : 'air'), id: id });
      } else {
        var x = e.event, type = x.type;
        if (type === 'stop') C.stopAll(x.fadeMs, x.reason || 'step');
        else if (type === 'cancel') C.cancel(x.id, x.fadeMs);
        else if (type === 'mute' || type === 'hidden') C.stopAll(x.fadeMs == null ? 120 : x.fadeMs, type);
        else if (type === 'reduced') C.reduced(true);
        else if (type === 'surface') { C.stopAll(160, 'surface'); C.surface = x.surface || null; }
      }
      plan.states.push({ t: e.t, state: C.state() });
    }
    clock.t = dur;
    plan.transitions = C.transitions.slice();
    plan.plans = C.plans.map(function (p) {
      var row = { id: p.id, lane: p.lane, surface: p.surface, from: p.from, to: p.to, cancelled: !!p.cancelled };
      if (p.lane === 'typing') { row.t1 = p.t1; row.tEnd = p.tEnd; row.taps = p.taps.map(function (tp) { return { t: tp.t, kind: tp.kind }; }); }
      return row;
    });
    plan.surfaces = {};
    for (k in C.surfaces) {
      var sf = C.surfaces[k], pp = sf.penPlan;
      plan.surfaces[k] = { strokes: sf.strokes.length, activity: pp ? pp.activity : [], window: pp ? pp.window : null, penStrokes: pp ? pp.strokes : [] };
    }
    plan.cueSlots = cueTakes;
    plan.state = C.state();

    var sp1 = ctx.createChannelSplitter(2), sp2 = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(4);
    var stereo = function (node) {
      var g = ctx.createGain();
      g.channelCount = 2; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers';
      node.connect(g);
      return g;
    };
    stereo(R.premix).connect(sp1); stereo(R.revSend).connect(sp2);
    sp1.connect(mg, 0, 0); sp1.connect(mg, 1, 1); sp2.connect(mg, 0, 2); sp2.connect(mg, 1, 3);
    mg.connect(ctx.destination);
    var level = o.level == null ? MASTER : +o.level, pad = Math.round(0.1 * sr);
    return runOffline(ctx).then(function (stems) {
      var d0 = stems.getChannelData(0), d1 = stems.getChannelData(1), w0 = stems.getChannelData(2), w1 = stems.getChannelData(3), j;
      var wet = null;
      for (j = 0; j < len; j++) { if (w0[j] !== 0 || w1[j] !== 0) { wet = convolveReverb(w0, w1, sr); break; } }
      var out = ctx.createBuffer(2, len, sr), a = out.getChannelData(0), b = out.getChannelData(1);
      for (j = 0; j < len; j++) {
        a[j] = (d0[j] + (wet ? wet[0][j] : 0)) * level;
        b[j] = (d1[j] + (wet ? wet[1][j] : 0)) * level;
      }
      if (!o.master) return { buffer: out, plan: plan };
      var ctx3 = new OAC(2, len + pad, sr), src = ctx3.createBufferSource(), chain = masterChain(ctx3);
      chain.master.gain.value = 1;
      src.buffer = out; src.connect(chain.master); src.start(pad / sr);
      return runOffline(ctx3).then(function (full) {
        var res = ctx.createBuffer(2, len, sr);
        res.copyToChannel(full.getChannelData(0).subarray(pad), 0);
        res.copyToChannel(full.getChannelData(1).subarray(pad), 1);
        return { buffer: res, plan: plan };
      });
    });
  }
  function renderTextures(o) {
    o = o || {};
    var out = { mix: null, stems: {}, plan: null };
    return renderTexturePass(o, null).then(function (r) {
      out.mix = r.buffer; out.plan = r.plan;
      if (o.stems === false) return out;
      return renderTexturePass(o, 'pen').then(function (p) {
        out.stems.pen = p.buffer;
        return renderTexturePass(o, 'typing');
      }).then(function (t) {
        out.stems.typing = t.buffer;
        return renderTexturePass(o, 'air');
      }).then(function (a) {
        out.stems.air = a.buffer;
        return renderTexturePass(o, 'cues');
      }).then(function (c) {
        out.stems.cues = c.buffer; out.plan.cueSlotsAlone = c.plan.cueSlots;
        return out;
      });
    });
  }

  // 16-bit stereo PCM WAV. A mono buffer is written to both channels.
  function toWav(buf) {
    var n = buf.length, sr = buf.sampleRate;
    var L = buf.getChannelData(0), Rr = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    var bytes = n * 4, ab = new ArrayBuffer(44 + bytes), v = new DataView(ab), i, p = 0;
    function str(s) { for (var k = 0; k < s.length; k++) v.setUint8(p++, s.charCodeAt(k)); }
    str('RIFF'); v.setUint32(p, 36 + bytes, true); p += 4; str('WAVE'); str('fmt '); v.setUint32(p, 16, true); p += 4;
    v.setUint16(p, 1, true); p += 2; v.setUint16(p, 2, true); p += 2; v.setUint32(p, sr, true); p += 4;
    v.setUint32(p, sr * 4, true); p += 4; v.setUint16(p, 4, true); p += 2; v.setUint16(p, 16, true); p += 2;
    str('data'); v.setUint32(p, bytes, true); p += 4;
    for (i = 0; i < n; i++) {
      var a = clamp(L[i], -1, 1), b = clamp(Rr[i], -1, 1);
      v.setInt16(p, a < 0 ? Math.round(a * 32768) : Math.round(a * 32767), true); p += 2;
      v.setInt16(p, b < 0 ? Math.round(b * 32768) : Math.round(b * 32767), true); p += 2;
    }
    return ab;
  }

  /* ------------------------------------------------------------------ *
   * 6. Live state
   * ------------------------------------------------------------------ */
  var state = {
    on: false, ctx: null, R: null, music: null, want: null, section: null,
    userEnabled: false, sleeping: false, armed: false, timer: 0, hideTimer: 0, ready: false, conductor: null
  };
  var UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'];

  function readPref() { try { return global.localStorage.getItem(STORE_KEY); } catch (e) { return null; } }
  function writePref(on) { try { global.localStorage.setItem(STORE_KEY, on ? 'on' : 'off'); } catch (e) { /* private mode */ } }
  function reducedMotion() { try { return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } }
  function AudioCtor() { return global.AudioContext || global.webkitAudioContext; }

  function deckSeed() {
    var n = doc && doc.querySelector('[data-music][data-seed], [data-seed]');
    return (n && n.getAttribute('data-seed')) || 'sketchy';
  }

  function ensureContext() {
    if (state.ctx) return state.ctx;
    var Ctor = AudioCtor(), ctx;
    if (!Ctor) return null;
    // a page with music gets larger buffers; a page with only effects and cues gets the
    // shortest delay between a click and its sound
    try { ctx = new Ctor({ latencyHint: state.want ? 'playback' : 'interactive' }); }
    catch (e) { try { ctx = new Ctor(); } catch (e2) { return null; } }
    state.ctx = ctx;
    // Live effects vary from the deck's seed, never from the clock: the same deck makes
    // the same sequence of small variations on every load.
    state.R = buildMaster(ctx, { seed: deckSeed() });
    var H = header(deckSeed(), 'sketchbook');
    state.R.key = { tonic: H.tonic, scale: H.scale };
    if (ctx.addEventListener) ctx.addEventListener('statechange', onStateChange);
    return ctx;
  }

  function onStateChange() {
    var ctx = state.ctx;
    if (!ctx) return;
    if (ctx.state === 'running') onRunning();
    else if (!state.sleeping && state.on) armUnlock();
  }

  function onRunning() {
    var R = state.R;
    disarmUnlock();
    if (!R || !state.on || state.sleeping) return;
    masterTo(R, MASTER, state.ready ? 0.3 : 1.5);
    state.ready = true;
    syncMusic();
  }

  // Unlock: the first gesture after enable resumes the context and plays one silent
  // sample, which is what iOS needs. The listeners remove themselves once it runs.
  function onGesture() {
    if (!state.on) return;
    var ctx = ensureContext();
    if (!ctx) return;
    if (ctx.state !== 'running' && !state.sleeping) {
      try {
        var b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource();
        s.buffer = b; s.connect(ctx.destination); s.start(0);
      } catch (e) { /* ignore */ }
      resumeContext();
    } else if (ctx.state === 'running') disarmUnlock();
  }
  function armUnlock() {
    if (state.armed || !doc) return;
    state.armed = true;
    for (var i = 0; i < UNLOCK_EVENTS.length; i++) global.addEventListener(UNLOCK_EVENTS[i], onGesture, true);
  }
  function disarmUnlock() {
    if (!state.armed) return;
    state.armed = false;
    for (var i = 0; i < UNLOCK_EVENTS.length; i++) global.removeEventListener(UNLOCK_EVENTS[i], onGesture, true);
  }
  function resumeContext() {
    var ctx = state.ctx;
    if (!ctx) return Promise.resolve();
    var p;
    try { p = ctx.resume(); } catch (e) { p = null; }
    return Promise.resolve(p).then(function () { if (ctx.state === 'running') onRunning(); }, function () { /* blocked until a gesture */ });
  }

  function enable() {
    var was = state.on;
    state.on = true; state.userEnabled = true; state.sleeping = false;
    if (!was) writePref(true);
    var ctx = ensureContext();
    if (state.conductor) state.conductor.resume();
    refreshToggles(); announce();
    if (!ctx) return Promise.resolve(false);
    if (ctx.state !== 'running') armUnlock();
    return resumeContext().then(function () { return ctx.state === 'running'; });
  }

  function disable() {
    if (state.on) writePref(false);
    state.on = false;
    stopMusicNow(0.3);
    var R = state.R, ctx = state.ctx;
    if (R) {
      if (state.conductor) state.conductor.stopAll(120, 'mute');
      masterTo(R, 0, 0.25);
      setTimeout(function () { if (!state.on && ctx.state === 'running') { try { ctx.suspend(); } catch (e) { /* ignore */ } } }, 350);
    }
    disarmUnlock();
    refreshToggles(); announce();
    return false;
  }

  function toggle() {
    if (state.on) return disable();
    enable();
    return true;
  }

  function announce() {
    if (!doc || !global.CustomEvent) return;
    doc.dispatchEvent(new global.CustomEvent('sk:sound', { detail: { on: state.on } }));
  }

  /* Effects */
  function play(name, opts) {
    var R = state.R;
    if (!state.on || !R || state.ctx.state !== 'running' || state.sleeping) return false;
    return trigger(R, name, R.ctx.currentTime + 0.005, opts);
  }

  /* Textures. The same gates as play(), plus reduced motion and a hidden tab: a report
     that fails one returns 0 and is not queued. The conductor lives on the live rig and
     varies from the deck's seed, never from the clock. */
  function texGate() {
    return !!(state.on && state.R && state.ctx && state.ctx.state === 'running' && !state.sleeping && !reducedMotion() && !(doc && doc.hidden));
  }
  function texLive() {
    if (!state.conductor) {
      state.conductor = new Conductor(state.R, { seed: deckSeed(), cal: SketchySound.texture.cal, music: function () { return !!state.music; } });
    }
    return state.conductor;
  }
  var textureLive = {
    pen: function (timeline) { return texGate() ? texLive().pen(timeline) : 0; },
    typing: function (spec) { return texGate() ? texLive().typing(spec) : 0; },
    air: function (spec) { return texGate() ? texLive().air(spec) : 0; },
    cancel: function (id, fadeMs) { return state.conductor ? state.conductor.cancel(id, fadeMs) : false; },
    stopAll: function (fadeMs, reason, surface) { if (state.conductor) state.conductor.stopAll(fadeMs, reason, surface); },
    state: function () {
      if (state.conductor) return state.conductor.state();
      var idle = { gain: 0, state: 'idle', until: -1, voices: 0 };
      return { surface: null, lanes: { pen: idle, typing: { gain: 0, state: 'idle', until: -1, voices: 0, taps: 0 }, air: idle },
        duck: { depth: 1, until: -1 }, plans: [], transitions: [], pool: { used: 0, size: TEX_POOL } };
    }
  };
  function onReducedMotion(e) {
    if (state.conductor) state.conductor.reduced(!!(e && e.matches));
  }

  /* Music */
  function startMusicNow(want) {
    var R = state.R, ctx = state.ctx;
    stopMusicNow(1.5);
    var m = new Music(R, { seed: want.seed, mood: want.mood, key: want.key, bpm: want.bpm,
      t0: ctx.currentTime + 0.15, fadeIn: want.fadeIn == null ? 4 : want.fadeIn, section: state.section || 'calm' });
    state.music = m;
    R.key = { tonic: m.tonic, scale: m.scale };
    state.timer = setInterval(function () {
      if (ctx.state !== 'running' || state.music !== m) return;
      m.schedule(ctx.currentTime + 0.12);
    }, 25);
    m.timer = state.timer;
    if (state.conductor) state.conductor.musicChanged();   // the pad is the bed now: air yields
  }

  function stopMusicNow(fadeOut) {
    var m = state.music;
    if (!m) return;
    state.music = null;
    if (state.conductor) state.conductor.musicChanged();
    if (m.timer) clearInterval(m.timer);
    var ctx = state.ctx, now = ctx.currentTime, len = Math.max(0.05, fadeOut);
    for (var i = 0; i < 3; i++) {
      var g = m.fade[i].gain;
      g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + len);
    }
    setTimeout(function () {
      var k;
      for (k = 0; k < m.persist.length; k++) { try { m.persist[k].stop(); } catch (e) { /* stopped */ } }
      for (k = 0; k < m.pads.length; k++) { try { m.pads[k].o.stop(); } catch (e2) { /* stopped */ } }
      for (k = 0; k < 3; k++) { try { m.fade[k].disconnect(); } catch (e3) { /* gone */ } }
    }, len * 1000 + 250);
  }

  function syncMusic() {
    var ctx = state.ctx;
    if (!state.on || !ctx || ctx.state !== 'running' || state.sleeping) return;
    if (state.want && !state.music) {
      // a remembered "on" plus a deck that declares data-music is not an invitation to
      // start music for someone who asked the browser to reduce motion
      if (state.want.auto && reducedMotion() && !state.userEnabled) return;
      startMusicNow(state.want);
    }
  }

  var music = {
    start: function (o) {
      o = o || {};
      state.want = { mood: MOODS[o.mood] ? o.mood : 'sketchbook', seed: o.seed != null ? String(o.seed) : deckSeed(),
        key: o.key, bpm: o.bpm, fadeIn: o.fadeIn, auto: !!o.auto };
      if (state.music) { stopMusicNow(1.5); }
      syncMusic();
      return state.on;
    },
    stop: function () { state.want = null; stopMusicNow(2); },
    section: function (name) {
      if (!SECTIONS[name]) return false;
      state.section = name;
      if (state.music) state.music.queueSection(name, state.ctx.currentTime);
      return true;
    },
    info: function () { return state.music ? state.music.info() : null; },
    get playing() { return !!state.music; },
    get mood() { return state.music ? state.music.mood : (state.want ? state.want.mood : null); }
  };

  /* Tab visibility: fade out fast and suspend, resume with a slower fade. */
  function onVisibility() {
    var R = state.R, ctx = state.ctx;
    if (!R || !state.on) return;
    if (doc.hidden) {
      if (state.conductor) state.conductor.stopAll(120, 'hidden');
      masterTo(R, 0, 0.15);
      clearTimeout(state.hideTimer);
      state.hideTimer = setTimeout(function () {
        if (doc.hidden && ctx.state === 'running') { state.sleeping = true; try { ctx.suspend(); } catch (e) { /* ignore */ } }
      }, 200);
    } else {
      clearTimeout(state.hideTimer);
      if (state.sleeping) {
        state.sleeping = false;
        resumeContext();
      }
      if (state.conductor) state.conductor.resume('hidden');
      if (ctx.state === 'running') masterTo(R, MASTER, 1.2);
    }
  }

  /* Toggle buttons. Clicks are delegated, so toggles added later work too; call
     SketchySound.bind() after adding one to refresh its label. */
  function setLabel(btn, text) {
    var span = btn.querySelector('[data-sk-sound-label]');
    if (span) { if (span.textContent !== text) span.textContent = text; return; }
    // keep the pencil overlay the engine inserts as the first child: touch text nodes only
    for (var i = 0; i < btn.childNodes.length; i++) {
      var n = btn.childNodes[i];
      if (n.nodeType === 3 && n.nodeValue.trim()) { if (n.nodeValue !== text) n.nodeValue = text; return; }
    }
    btn.appendChild(doc.createTextNode(text));
  }
  function refreshToggles() {
    if (!doc) return;
    var list = doc.querySelectorAll('[data-sk-sound-toggle]');
    for (var i = 0; i < list.length; i++) {
      var b = list[i], on = state.on;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (b.classList) b.classList.toggle('is-on', on);
      if (b.tagName !== 'BUTTON' && b.tagName !== 'A' && !b.getAttribute('role')) { b.setAttribute('role', 'button'); if (!b.hasAttribute('tabindex')) b.setAttribute('tabindex', '0'); }
      setLabel(b, on ? (b.getAttribute('data-label-on') || 'sound') : (b.getAttribute('data-label-off') || 'muted'));
    }
  }

  function declaredMusic() {
    var n = doc && doc.querySelector('[data-music]');
    if (!n) return;
    var mood = (n.getAttribute('data-music') || '').trim();
    if (!MOODS[mood]) return;
    state.want = { mood: mood, seed: n.getAttribute('data-seed') || 'sketchy', auto: true };
  }

  /* A deck opts in to the textures with data-sound-texture on .sk-deck. A step then plays the
     pen instead of `pencil`: one stroke per sketch the step reveals, from the deck's own
     draw-in timing (220 ms plus 120 ms per sketch, 520 ms per path, 10 ms between paths). A
     step without a sketch is one short line. data-sound-shape on a sketch names its shape. */
  function deckTextures() {
    var n = doc && doc.querySelector('.sk-deck');
    return !!(n && n.hasAttribute('data-sound-texture'));
  }
  function deckStep(d) {
    var el = d && d.el, svgs = [], strokes = [], k;
    if (el && el.querySelectorAll) {
      svgs = el.matches && el.matches('svg[data-sketch], .sk-chart svg, svg[data-draw]') ? [el]
        : Array.prototype.slice.call(el.querySelectorAll('svg[data-sketch], .sk-chart svg, svg[data-draw]'));
    }
    for (k = 0; k < svgs.length; k++) {
      // only the first boil variant is traced, so count its paths
      var paths = Array.prototype.filter.call(svgs[k].querySelectorAll('.sk-path, .sk-hatch, .sk-wash'), function (p) {
        var v = p.closest ? p.closest('.sk-v') : null;
        return !v || v.classList.contains('sk-v0') || v.classList.contains('sk-v-only');
      }).length;
      strokes.push({ start: 0.22 + k * 0.12, duration: 0.52 + 0.01 * Math.max(0, paths - 1),
        shape: svgs[k].getAttribute('data-sound-shape') || 'line', easing: [0.35, 0.1, 0.25, 1] });
    }
    if (!strokes.length) strokes.push({ start: 0, duration: 0.35, shape: 'line' });
    textureLive.pen({ strokes: strokes, surface: 'deck', key: 'step:' + (d ? d.index + ':' + d.step : '0') });
  }

  function init() {
    if (!doc) return;
    // events from the deck
    doc.addEventListener('sk:slide', function (e) {
      if (!state.on) return;
      var d = e.detail || {}, slide = d.slide, sec = slide && slide.getAttribute && slide.getAttribute('data-music-section');
      if (sec) music.section(sec);
      if (deckTextures()) textureLive.stopAll(160, 'step');
      play('page');
    });
    doc.addEventListener('sk:step', function (e) {
      if (!state.on) return;
      if (deckTextures()) deckStep(e.detail); else play('pencil');
    });
    doc.addEventListener('click', function (e) {
      var n = e.target && e.target.closest ? e.target.closest('[data-sk-sound-toggle]') : null;
      if (n) { e.preventDefault(); toggle(); }
    });
    doc.addEventListener('keydown', function (e) {
      var tg = e.target;
      if (tg && tg.hasAttribute && tg.hasAttribute('data-sk-sound-toggle') && tg.tagName !== 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(); return; }
      if ((e.key !== 's' && e.key !== 'S') || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (tg && (tg.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName))) return;
      if (global.SketchyDeck) return;   // the deck owns its keyboard map and calls toggle() itself
      if (SketchySound.hotkey === false) return;   // a host app with its own mute control
      toggle();
    });
    doc.addEventListener('visibilitychange', onVisibility);
    // reduced motion turning on fades every texture out; reports are refused while it stays on
    try {
      var mq = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)');
      if (mq && mq.addEventListener) mq.addEventListener('change', onReducedMotion);
      else if (mq && mq.addListener) mq.addListener(onReducedMotion);
    } catch (e) { /* no matchMedia */ }
    declaredMusic();
    var pref = readPref();
    if (pref === 'on') { state.on = true; armUnlock(); }
    refreshToggles();
  }

  var SketchySound = {
    version: '0.1.0',
    enable: enable, disable: disable, toggle: toggle,
    get isOn() { return state.on; },
    /* false stops the s key from toggling sound on a page without a deck */
    hotkey: true,
    play: play,
    music: music,
    renderOffline: renderOffline,
    toWav: toWav,
    hashBuffer: hashBuffer,
    bind: refreshToggles,
    /* the key, mode and tempo a seed and mood will play in, without making any sound */
    describe: function (o) {
      o = o || {};
      var H = header(o.seed != null ? String(o.seed) : 'sketchy', o.mood || 'sketchbook', o);
      return { mood: H.mood, key: H.keyName, mode: H.mode, bpm: H.bpm, tonic: H.tonic };
    },
    names: NAMES.slice(),
    /* UI cues: SketchySound.play('click') plays one live; cue.render() renders one offline */
    cue: {
      names: CUE_NAMES.slice(),
      info: function (name) {
        var s = CUE_SPAN[name];
        return s ? { name: name, min: s[0], max: s[1], gap: LIMITS[name] } : null;
      },
      render: renderCue
    },
    /* Textures: a pen that follows the line, key taps under typed text, paper air.
       texture.plan.* are pure planners that node can run; see references/sound.md */
    texture: {
      /* pen(timeline), typing(spec), air(spec) return a plan id, or 0 when sound is off, the
         context is not running, motion is reduced, the tab is hidden or the plan is all past */
      pen: textureLive.pen, typing: textureLive.typing, air: textureLive.air,
      cancel: textureLive.cancel,     // one plan, default fade 120 ms
      stopAll: textureLive.stopAll,   // every lane; reason: 'step'|'replay'|'close'|'mute'|'hidden'|'reduced'; surface: only if it is the one playing
      state: textureLive.state,       // the conductor's lanes, duck, plans, transitions and pool
      plan: texturePlan,
      render: renderTextures,         // deterministic offline render: { mix, stems: { pen, typing, air, cues }, plan }
      /* the level trims the rig reads (dev/check-textures.mjs --calibrate adjusts them, then they are frozen in source) */
      cal: { pen: PEN_CAL, typing: TYPE_CAL, air: AIR_CAL, kind: TAP_TRIM },
      shapes: PEN_SHAPES.slice(),
      info: { pool: TEX_POOL, lanes: ['pen', 'typing', 'air'], minGap: TAP_GAP, levels: { pen: TEX_TARGETS.pen, typing: TEX_TARGETS.letter, air: TEX_TARGETS.air },
        targets: TEX_TARGETS, surfaces: Object.keys(SURFACE_TRIM) }
    },
    moods: Object.keys(MOODS),
    sections: Object.keys(SECTIONS),
    /* for tools that want the graph on their own context */
    buildMaster: buildMaster
  };
  global.SketchySound = SketchySound;

  if (doc) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();
  }
})(typeof window !== 'undefined' ? window : this);
