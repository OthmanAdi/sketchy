# Sound

`engine/sketchy-sound.js` makes every sound from code: no audio files, no network. It gives you 14 sound effects, 14 UI cues for buttons and flows, and a generative music bed. It works from `file://` and has no dependencies.

## When to turn sound on

Use it where a person watches or presents:

- Video (the render script uses it automatically).
- A kiosk or a looping display.
- A live talk with a deck on screen.

Leave it out of documents, reports people read alone, email attachments and anything printed or exported to PDF. The file is still safe to open without sound, because nothing plays until the viewer asks.

## The default-off rule

Sound is off in every page. The viewer turns it on with a button carrying `data-sk-sound-toggle`, with the `s` key, or through `SketchySound.enable()` called from a click. The choice is stored in `localStorage['sketchy:sound']` (`on` or `off`).

- Browsers block audio until a gesture, so the engine creates the audio context on the first gesture after sound is on.
- Music never starts by itself. It starts when the viewer turns sound on and the page declares `data-music="<mood>"` on the deck. A remembered "on" starts it on the first gesture of a later visit, except when the viewer's system asks for reduced motion: then the viewer has to press the toggle again.
- A hidden tab fades out in 0.15 s and suspends. It fades back in over 1.2 s.
- The `s` key is handled by the deck when `sketchy-deck.js` is loaded, and by the sound module otherwise.

```html
<button class="sk-btn" data-sk="button" data-sk-sound-toggle>muted</button>
<main class="sk-deck" data-seed="q3-board" data-music="sketchbook">
<script src="engine/sketchy-sound.js"></script>
```

The button text becomes `sound` when on and `muted` when off. Set `data-label-on` and `data-label-off` to change the words. The button also gets `aria-pressed` and the class `is-on`.

## Effects

`SketchySound.play(name, { gain, pan, pitch })`. `gain` multiplies the level, `pan` is -1 to 1, `pitch` is a frequency ratio (2 is an octave up). `play` returns `false` when sound is off, the context is not running, or the rate limit dropped the call. Add `force: true` to skip the rate limit.

| Name | What it is |
|---|---|
| `pencil` | Short graphite scratch, 0.15 to 0.2 s. Use it for each reveal step. |
| `scribble` | Longer scratch for drawing a whole slide on. `length` in seconds, default 1.2. |
| `page` | Page turn: a noise swish with paper flutter and a soft landing. |
| `flip` | Quick card flip. |
| `stamp` | Rubber stamp thunk. The loudest effect, so use it once. |
| `tap` | Soft UI tap, quiet. |
| `tick` | Small tick for a lock or a count. |
| `pop` | Bubble pop for something appearing. |
| `whoosh` | Air sweep that crosses the stereo field. |
| `bell` | One bell in the music's key. `degree` picks the scale step (0 is the tonic). |
| `chime` | Two bells, a fifth apart. |
| `success` | Rising bell arpeggio in key, for "delivered" or "done". |
| `fail` | Low soft sigh that glides down a semitone. Not a buzzer. |
| `paper` | A sheet sliding on a table. |

Each call varies a little in gain, pitch and timing, and each name has a minimum gap (for example 90 ms for `pencil`, 300 ms for `stamp`), so a loop that fires every frame still sounds like a person. Bells, chimes and arpeggios stay within a few cents of the key. Tails decay to silence.

## UI cues

`play()` also takes 14 short cues for buttons and flows, in a deck or in any other web page. They are dry (no reverb, no echo). Their pitch is a fixed number of semitones from a root that follows the key (the running music, else the page's `data-seed`), and they use only intervals that every mood shares (unison, second, fourth, fifth, octave), so they never clash with the music. Rising and moving right means on, next or open. Falling and moving left means off, back or close. They share one set of materials: graphite for contact, soft wood for weight, felt tines for meaning, paper air for motion.

| Name | Length | What it is | Use it for |
|---|---|---|---|
| `click` | 30 ms | a graphite tick on a small wooden body | a primary button press |
| `tap-soft` | 60 ms | a fingertip on felt, lower and rounder | secondary actions, list rows, touch |
| `select` | 130 ms | a tick and one bright tine | choosing a tab, an option or an item |
| `toggle-on` | 180 ms | a wooden detent, then two tines rising a fifth | a switch or a checkbox turning on |
| `toggle-off` | 165 ms | a duller detent, then two notes falling a fifth | a switch or a checkbox turning off |
| `step-next` | 145 ms | a pencil line drawn to the right that lands on a high tine | the next step of a wizard, a lesson or a build |
| `step-back` | 145 ms | the line drawn to the left, landing a fifth lower | the previous step |
| `page-next` | 210 to 240 ms | a page corner lifts, the sheet swishes right and lands | moving to the next page or view |
| `page-back` | 140 to 170 ms | one quick pull to the left that darkens | returning to the previous page or view |
| `reveal` | 245 ms | rising air that opens into a soft fifth | a panel, a card or a drawing appears |
| `dismiss` | 145 ms | falling air that settles on a low knock | closing a panel, a dialog or a toast |
| `sketch-done` | 325 ms | a pencil check mark, a tap, a fifth and an octave | a drawing or a draft is finished |
| `celebrate` | 770 ms | a wooden bloom, five tines rising left to right, paper confetti | a rare milestone, about once per session |
| `error-soft` | 225 ms | two muffled wooden knocks falling a fourth | something failed and needs another try |

The levels form a ladder: `click` and `tap-soft` are the quietest, selection, steps and page changes sit 1 to 3 dB above them, `sketch-done` and `error-soft` about 4 dB higher again, and `celebrate` the loudest. The frequent cues sit at the level of the `tap` effect, the outcomes near `page`, `celebrate` near `pencil`, and none comes near `stamp`. Options are the same as for effects (`gain`, `pan`, `pitch`, `force`). Each cue has its own minimum gap (40 ms for `click` up to 1.2 s for `celebrate`), and two cues that start within 30 ms of each other play only the first, so one action that fires two cues is heard once.

- `SketchySound.cue.names` lists the cues. `SketchySound.names` lists everything `play()` takes.
- `SketchySound.cue.info(name)` returns `{ name, min, max, gap }`: the shortest and longest audible length in seconds (onset to -60 dBFS on the effect bus) and the minimum gap.
- `SketchySound.cue.render(name, opts)` renders one cue offline and resolves with an `AudioBuffer`, for a WAV file (`toWav`) or to compare a port with the original. Options: `seed`, `key` (`'D'`, `'F#'` or a pitch class), `level` (default 0.15, the master gain; the live master compressor adds 3 to 6 dB on top; 1 is the effect bus itself), `sampleRate`, `duration`, and `vary: false` for the nominal recipe without the per-call variation. The render skips the master chain.

In a deck, `reveal` suits a card that turns over, `sketch-done` the moment a drawing finishes, and `celebrate` the last slide of a launch. The deck still plays `page` on a slide change and `pencil` on a step by itself.

## Using the cues in a host app

The cues work in any page that loads `engine/sketchy-sound.js`, without a deck and without music.

- Browsers start audio only after a click, a tap or a key press, so unlock on the first gesture: call `SketchySound.enable()` from the handler of the control that turns sound on. When the user's saved preference is on, the module waits for the first gesture of the visit and resumes there. Until the audio context runs, `play()` returns `false` and the cue is skipped, not queued.
- Sound stays off until the user turns it on. Mirror your own mute setting: call `enable()` when the user turns sound on and `disable()` when they mute. The module also remembers the choice in `localStorage['sketchy:sound']`. Set `SketchySound.hotkey = false` when the `s` key should not toggle sound in your app. Show a visible mute control, and never let a cue be the only sign that something happened.
- The per-cue gaps and the shared 30 ms gap are built in as a safety net. Call one cue per user action, and do not play cues on hover, on every keystroke, or on every scroll or drag frame.
- Every cue is under 400 ms except `celebrate` (about 0.8 s), which is for rare moments. A cue should be over before the next likely action.
- A page without `data-music` opens its audio context with the browser's interactive latency, so the sound follows the click closely. A page with music uses larger buffers.
- Cues follow the running music. Without music they take their key from the first `data-seed` on the page (the seed `sketchy` when there is none), so the cues of one page stay in one key on every visit.
- The live output is quiet on purpose, with cue peaks between about -28 and -18 dBFS, and the user's volume does the rest. `gain` raises one call: at `gain: 4` (12 dB) the loudest cue peaks near -6 dBFS, and the master limiter holds anything louder.

## Music

`SketchySound.music.start({ mood, seed })`, `.section(name)`, `.stop()`, `.info()`. The music is generated: chords come from a Markov chain over the mode's diatonic chords, the arpeggio and the lead are constrained random walks that land on chord tones on strong beats, phrases run 4 or 8 bars with rests and variations, and the density drifts on two slow curves. The same seed gives the same piece. The seed also picks the key and the tempo; `SketchySound.describe({ seed, mood })` tells you which without making a sound. Sound effects tune themselves to the running piece.

| Mood | Character |
|---|---|
| `sketchbook` | Day. A minor mode (aeolian), warm saw pad, soft drone, music-box arpeggio, light hat, about 88 to 98 bpm. |
| `ledger` | Night. Dorian, slower (about 64 to 72 bpm), bells and bass, more space. |
| `focus` | Sparse and dark, for speaking over. Aeolian, about 72 to 80 bpm, about 4 dB under the others. |
| `calm` | Major (ionian), celesta and pad, no percussion at all, about 60 to 66 bpm. |

Sections switch layers in and out with slow crossfades (no clicks):

| Section | Layers |
|---|---|
| `calm` | Pad, drone, a few arpeggio notes. The default. |
| `build` | Adds bass, a quieter hat and more notes. |
| `flight` | Everything, including a soft kick. The loudest section. |
| `resolve` | Thins out and cadences to the tonic. Use it for the last slide. |

## Cueing sound on slides

Put `data-music-section="build"` on a slide and the music moves to that section when the slide appears. The module listens on `document` for the deck's events, and only when sound is on:

- `sk:slide` plays `page` and applies the slide's `data-music-section`.
- `sk:step` plays `pencil`.

Anything else is a direct call, for example `SketchySound.play('stamp')` when a stamp lands, or `play('success')` on the last step of a flow.

## Video

The video script renders the sound offline from the deck's timeline and muxes it. Build the cue list from `SketchyDeck.timeline()`: a `page` cue at each slide start, a `pencil` cue per step, a `data-music-section` change at each slide that has one.

```js
const buf = await SketchySound.renderOffline({
  duration: 42, seed: 'q3-board', mood: 'sketchbook',
  cues: [{ t: 0.4, name: 'page' }, { t: 6.2, name: 'stamp' }, { t: 9, name: 'bell', opts: { degree: 4 } }],
  sections: [{ t: 0, name: 'calm' }, { t: 12, name: 'build' }, { t: 30, name: 'flight' }, { t: 38, name: 'resolve' }],
  check: true
});
const wav = SketchySound.toWav(buf);   // ArrayBuffer, 16-bit stereo PCM, 48 kHz
```

Options: `duration`, `seed`, `mood` (`'none'` renders effects only), `cues`, `sections`, `sampleRate` (default 48000), `fadeIn` (1.5 s), `fadeOut` (2 s, so the music ends cleanly), `key` and `bpm` to override the seed, `level` to scale the whole mix, `check`.

Rate limits apply to cues exactly as they do live. Cues closer together than the effect's minimum gap are dropped unless they carry `force: true`.

Loudness for video: the raw render is quiet on purpose (about -22 to -27 LUFS integrated, sample peaks near -8 to -9 dBFS, effects peaking between -22 and -11 dBFS). The video script normalizes the final mix to **-16 LUFS integrated with a true peak below -1.5 dBTP**:

```sh
ffmpeg -i mix.wav -af loudnorm=I=-16:TP=-1.5:LRA=11 -ar 48000 -c:a aac out.m4a
```

`renderOffline` also trims a render that would peak above -1.5 dBFS, and never raises one.

Determinism: the render does not use `Math.random()` or the clock. The same options give the same samples. Two things keep that true in a browser: every merge point in the graph is a tree of two-input gains, and the reverb is convolved in JavaScript instead of with `ConvolverNode`, which did not give identical samples twice in long renders. In testing, most renders were identical bit for bit, but roughly 1 in 20 thirty-second renders differed by about 1e-6 (far under 16-bit resolution), usually after the 21 second mark. The cause is inside the browser and was not found. `check: true` renders twice, and a third time if the two differ, so a video build gets one consistent result. `SketchySound.hashBuffer(buffer)` returns a hash of the samples if you want to compare renders yourself.

## Limits to know

- Each layer has a fixed number of voices. A note that finds the pool full is skipped, the same way every time.
- The live reverb is a `ConvolverNode`. The offline reverb has the same impulse response and level.
- Safari and Firefox were not tested. Use a recent Chromium for the video render.
- Checks run in headless Chromium: `dev/sound-test.html` has a button for every effect, every cue, every mood and section, and an offline render that offers the WAV.
- `node skills/sketchy/dev/check-cues.mjs` renders every cue offline with seeded variations and fails on NaN, a peak at or above 0.9 on the effect bus, a length outside the declared span, sound in the 50 ms after it, an end that is cut instead of decayed, two renders that differ, or two cues (or a cue and an effect) that are near-identical. It also plays every cue through the live path. `--wav <dir>` writes each cue as a WAV file. A machine check cannot say whether a cue is pleasant or tiring, so listen on a phone speaker, a laptop and headphones before changing one.
