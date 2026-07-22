# Gesture HCI — webcam hand gestures for macOS window management

Control your Mac's windows with hand gestures seen through the webcam. Flick a
window to the left half, throw a shaka to almost-maximize, whatever you teach it —
the **focused** window responds. Gestures are **learned from your own repetitions**
(like training a wake word), not hard-coded, and everything is tuned live in a
built-in **Gesture Studio**.

Runs as a quiet background menu-bar app: the camera preview is hidden by default,
detection sips GPU when your hands are down and only spins up while you're
gesturing, and there is **no cloud** — all recognition is on-device.

> macOS only. Uses the webcam continuously while running (a small green camera
> light stays on); Pause from the menu bar turns it off.

---

## Requirements

- **macOS** (Apple Silicon or Intel)
- A **webcam**
- **Node 18+**
- **Xcode Command Line Tools** — needed to compile the tiny Swift window helper
  (`xcode-select --install`)

## Install & run

```bash
npm install

# Dev (Vite + Electron with hot reload)
npm run dev
```

To build a clickable, signed `.app` that keeps its Accessibility permission across
rebuilds:

```bash
npm run setup:signing   # once — creates a stable self-signed cert in your login keychain
npm run build:app       # builds + signs → release/mac*/Gesture HCI.app
```

Launch the `.app`. It lives in the **menu bar** (✋), not the Dock.

### Grant Accessibility

Window management uses the macOS Accessibility API, so the bundled helper needs
permission. On first run the app points you to **System Settings → Privacy &
Security → Accessibility** — enable the helper there. Thanks to the stable signing
cert, you only grant this **once** (it survives rebuilds).

---

## How to use it

Open the menu-bar **✋ → Open Gesture Studio**. There are two kinds of gesture:

### Motion gestures (a movement)
A flick, a wrist rotation, a push toward the camera — anything that's a *motion*.

1. Type a name, hit **Enroll motion**.
2. Perform the movement a handful of times **at your own pace**. It keeps going
   until the signal is *strong*, then stops itself. Return-to-start and stray moves
   are dropped automatically, so you don't have to control your timing.
3. On the new gesture's card, pick an **Action** (e.g. *Left Half*).

Recognition is amplitude- and hold-tolerant: a short casual flick and a big
deliberate one both match, and it fires when your hand *settles* after the motion —
so a "windup" in the opposite direction won't trigger the opposite gesture.

### Pose gestures (a held shape)
A shape you hold still (peace sign, shaka, fist). Fires on **dwell** (hold it
briefly).

1. Hit **Record pose**, hold the shape and slowly rotate through a few angles, Stop.
2. **Record a second "rest" pose** — your relaxed / open / typing hands — with
   **Action = None**. This is required: with only one pose the recognizer matches
   *any* hand. Rest gives the match something to lose to.
3. Set the real pose's **Action** and, if you like, a per-gesture **Dwell**.

### Validate before you trust it
The **Recognition test** panel:
- **Detection run** — say how many times you'll do it, perform them, Stop. It
  counts what fires (fewer = misses, more = something stray is also matching).
- **Quiet check** — move around *without* doing the gesture; anything that fires is
  a false positive.

### Tune (Tuning panel)
- **Sensitivity** (per gesture) — lower = stricter.
- **Settle hold** — how long the hand must slow before a motion fires (lower =
  snappier, higher = more windup-proof).
- **Active / Idle FPS** — detection rate while gesturing vs idle (idle is the
  battery saver).
- **Steadiness** — jitter smoothing.

---

## Window actions

Mirrors Raycast's window management (single-display geometry): **halves, quarters,
thirds, sixths**, maximize, **almost-maximize (90%, centered)**, reasonable size
(60%), center, maximize height/width, move-to-edge, toggle fullscreen, next/previous
display, and restore. Moves are animated; apps that cap their size (e.g. Claude) are
re-centered, and apps that snap their own position (e.g. Figma) are re-asserted.

## Menu-bar controls (✋)

- **Show / Hide camera preview** — the debug overlay is hidden by default
- **Pause tracking** — turns the camera off
- **Dry-run** — log what *would* fire without moving windows
- **Open Gesture Studio**
- **Quit**

---

## Architecture

```
┌─ Overlay renderer (headless by default) ─┐
│  webcam → MediaPipe HandLandmarker       │──┐  IPC   ┌─ Electron main (Node) ─┐  stdio  ┌─ Swift helper ─┐
│  → pose recognizer (k-NN)                │  ├───────▶│ settings store (JSON)  │────────▶│ Accessibility  │
│  → motion spotter (learned metric)       │  │        │ ipcMain: actions       │         │ window layouts │
│  → fires window actions                  │  │        └────────────────────────┘         └────────────────┘
└──────────────────────────────────────────┘  │
┌─ Studio renderer (editor) ───────────────┐  │      settings.json in ~/Library/Application Support/
│  preview · enroll/record · test · tune   │──┘
└──────────────────────────────────────────┘
```

- **CV runs in each renderer** — it *is* Chromium, so MediaPipe (GPU) performs like
  a browser. The detection loop is a self-paced timer, decoupled from the display,
  so it runs fast while a hand is present and idles otherwise.
- **The Swift helper is long-lived** — the main process pipes one command per line
  to a persistent process (no per-gesture spawn) and animates window frames.
- **Settings are the source of truth**, persisted to `userData` and live-applied to
  the overlay whenever the Studio saves.

| File | Role |
|---|---|
| `electron/main.js` | lifecycle, windows, camera permission, IPC, settings owner, tray |
| `electron/settingsStore.js` | load/merge/save settings in `userData` |
| `electron/windowHelper.js` | persistent stdio bridge to the Swift binary |
| `electron/preload.js` | the only OS surface exposed to renderers (`window.gestureAPI`) |
| `native/WindowHelper.swift` | Accessibility API — animated window layouts on the focused window |
| `shared/default-settings.json` | default tuning + seed gesture |
| `src/renderer.js` | overlay orchestrator: camera → detection → recognizers → action |
| `src/gestures.js` | the recognizers: k-NN poses, motion descriptor + learned per-dim metric + settle-gated spotter |
| `src/studio.js` + `studio.html` | Gesture Studio: preview, enroll/record, recognition test, tuning |
| `src/overlay.js` | p5 debug overlay (only drawn when the preview is shown) |

### How motion recognition works (short version)
A motion is a trajectory through the whole hand state — finger shape, palm
orientation, position, and depth — expressed as **speed** (not raw displacement), so
casual and deliberate versions match. Each rep is trimmed to its active burst and
resampled; the match **metric is learned per-dimension from your reps** (a diagonal
Fisher weighting), so the recognizer automatically trusts the parts of *your* gesture
that are consistent and ignores the noisy ones. Firing waits for the hand to settle,
which rejects preparatory "windup" motions.

## License

MIT
