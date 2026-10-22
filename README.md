# Piano Coach

Learn a song by memory without reading music. Load a MIDI file and the app turns it into falling notes over a labeled keyboard, cuts it into phrases, and listens to the digital piano over USB.

Built for Terrell's Casio Privia PX-760 and an Android tablet on the music stand.

## Run locally

```bash
node server.mjs 5237
```

Open http://localhost:5237. Web MIDI only works on `localhost` or HTTPS, so on the tablet the app must be served over HTTPS (for example, GitHub Pages).

## Connect the piano

- Use a **USB-C (tablet) to USB-B (piano)** cable. The PX-760's port is labeled "USB to Host", on the back panel.
- Open the app in Chrome, tap **Connect piano**, then tap **Allow**.
- The app hears every key and the sustain pedal. Tapping the pedal starts the phrase.
- Under Settings → "App sound comes from", choose **The piano** to hear the other hand through the piano's own speakers.

## How practice works

| Control | What it does |
|---|---|
| Hands | Right / Both / Left. The other hand plays along (or is silent, in Settings). |
| Mode | **Watch**: both hands play by themselves. **Wait**: the notes stop at the line until you press the right keys. **Play**: real tempo; notes count as hit within ±0.3 s. |
| Speed | 50 → 70 → 85 → 100%. Each step unlocks after 3 clean runs at the one below (only while the piano is connected; tap a locked speed twice to skip ahead). |
| Notes | **Show** → **Fade** (notes vanish before the line) → **Memory** (no notes; keys light up only if you stall 2.5 s, and that run doesn't count as clean). |
| Phrases | 4 bars each by default (2/4/8 in Settings). **Chain** starts from the phrase before, to practise the join. **Loop** restarts automatically. |
| Left hand | Settings → **Root notes** (one note), **Simple chords** (one held three-note shape per chord change, with the chord name shown), or **As written**. |

A clean run means no missed notes, at most 1 wrong note, and no hints. Phrase markers: ◐ in progress, ● both hands at full speed, ★ memorized (both hands, 100%, Memory mode).

## Files

- `midi.js`: Standard MIDI File parser, no dependencies.
- `song.js`: hand split (track names → average pitch → middle C), bars, chord names per bar or half-bar, easy left-hand arrangements, phrases.
- `app.js`: canvas rendering, Wait/Play/Watch engine, progress, UI.
- `audio.js`: Web Audio piano tone, plus routing to the piano over MIDI.
- `midiio.js`: Web MIDI input/output and the sustain pedal.
- `store.js`: songs in IndexedDB (they never leave the device); settings and progress in localStorage.
- `tools/make-demo.mjs`: writes the built-in demo (*Ode to Joy*, public domain).
- `tools/test.mjs`: run with `node tools/test.mjs`.

No song files ship with the app. A bought MIDI file stays on the device that loaded it.
